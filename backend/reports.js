/**
 * Reporting engine. Fourteen reports, each defined declaratively as a set of columns,
 * the filters it accepts, and a builder that runs one query. A single /api/reports/run
 * endpoint serves them all, so the frontend renders and exports any report generically.
 *
 * Filters are applied through buildWhere, which maps a report's supported filter keys to
 * real columns and produces a parameterised WHERE clause — no string interpolation of
 * user input.
 *
 * Reports can also be scheduled: a row in scheduled_reports names a report, saved
 * filters, a cadence and recipients; runDueScheduledReports (driven by cron) generates
 * each due report as CSV and emails it.
 */

const db = require('./db');
const emailChannel = require('./notifications/channels/email');

const col = (key, label, type = 'text') => ({ key, label, type });

// Turn a report's supported filters into a WHERE clause. `map` maps a filter key to the
// column (or expression) it constrains; only mapped, non-empty filters are applied.
function buildWhere(filters, map, startIndex = 1) {
  const conds = [];
  const params = [];
  let i = startIndex;
  const eq = (c, v) => { conds.push(`${c} = $${i++}`); params.push(v); };
  const like = (c, v) => { conds.push(`${c} ILIKE $${i++}`); params.push(`%${v}%`); };

  if (filters.department && map.department) eq(map.department, filters.department);
  if (filters.category && map.category) eq(map.category, filters.category);
  if (filters.branch && map.branch) eq(map.branch, filters.branch);
  if (filters.status && map.status) eq(map.status, filters.status);
  if (filters.priority && map.priority) eq(map.priority, filters.priority);
  if (filters.vendor && map.vendor) eq(map.vendor, filters.vendor);
  if (filters.employee && map.employee) like(map.employee, filters.employee);
  if (filters.dateFrom && map.date) { conds.push(`${map.date} >= $${i++}`); params.push(filters.dateFrom); }
  if (filters.dateTo && map.date) { conds.push(`${map.date} <= $${i++}`); params.push(filters.dateTo); }

  return { clause: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params, nextIndex: i };
}

const q = async (text, params) => (await db.query(text, params)).rows;

/* --------------------------------------------------------------- the reports */

const REPORTS = {
  asset_inventory: {
    label: 'Asset Inventory Summary', group: 'Assets',
    filters: ['department', 'category', 'branch', 'status', 'dateFrom', 'dateTo'],
    columns: [
      col('id', 'Asset ID'), col('name', 'Name'), col('serial_number', 'Serial #'),
      col('category', 'Category'), col('type', 'Type'), col('status', 'Status'),
      col('cost', 'Cost', 'money'), col('purchase_date', 'Purchased', 'date'),
      col('warranty_expiry', 'Warranty End', 'date'), col('department', 'Department'), col('location', 'Location')
    ],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { department: 'department', category: 'category', branch: 'location', status: 'status', date: 'purchase_date' });
      const rows = await q(`SELECT id, name, serial_number, category, type, status, cost, purchase_date, warranty_expiry, department, location FROM assets ${clause} ORDER BY id`, params);
      const totalCost = rows.reduce((s, r) => s + Number(r.cost || 0), 0);
      return { rows, summary: { 'Total assets': rows.length, 'Total value': money(totalCost) } };
    }
  },

  warranty_expiry: {
    label: 'Warranty Expiry Report', group: 'Assets',
    filters: ['department', 'category', 'branch', 'dateFrom', 'dateTo'],
    columns: [
      col('id', 'Asset ID'), col('name', 'Name'), col('serial_number', 'Serial #'),
      col('warranty_expiry', 'Warranty End', 'date'), col('days_left', 'Days Left', 'number'),
      col('status', 'Status'), col('department', 'Department'), col('location', 'Location')
    ],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { department: 'department', category: 'category', branch: 'location', date: 'warranty_expiry' });
      const where = clause ? `${clause} AND warranty_expiry IS NOT NULL` : 'WHERE warranty_expiry IS NOT NULL';
      const rows = await q(`SELECT id, name, serial_number, warranty_expiry, (warranty_expiry - CURRENT_DATE) AS days_left, status, department, location FROM assets ${where} ORDER BY warranty_expiry`, params);
      const expired = rows.filter((r) => Number(r.days_left) < 0).length;
      return { rows, summary: { 'Assets with warranty': rows.length, 'Already expired': expired } };
    }
  },

  amc_expiry: {
    label: 'AMC Expiry Report', group: 'Assets',
    filters: ['vendor', 'dateFrom', 'dateTo'],
    columns: [
      col('id', 'Contract ID'), col('vendor', 'Vendor'), col('start_date', 'Start', 'date'),
      col('end_date', 'End', 'date'), col('days_left', 'Days Left', 'number'),
      col('cost', 'Annual Cost', 'money'), col('asset_count', 'Assets', 'number')
    ],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { vendor: 'm.vendor', date: 'm.end_date' });
      const rows = await q(`SELECT m.id, m.vendor, m.start_date, m.end_date, (m.end_date - CURRENT_DATE) AS days_left, m.cost, COUNT(a.id)::int AS asset_count FROM amcs m LEFT JOIN assets a ON a.amc_id = m.id ${clause} GROUP BY m.id, m.vendor, m.start_date, m.end_date, m.cost ORDER BY m.end_date`, params);
      return { rows, summary: { 'Contracts': rows.length } };
    }
  },

  department_asset: {
    label: 'Department-wise Asset Report', group: 'Assets',
    filters: ['department', 'category'],
    columns: [
      col('department', 'Department'), col('total', 'Total Assets', 'number'),
      col('assigned', 'Assigned', 'number'), col('total_value', 'Total Value', 'money')
    ],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { department: 'department', category: 'category' });
      const where = clause ? `${clause} AND status <> 'Disposed'` : `WHERE status <> 'Disposed'`;
      const rows = await q(`SELECT COALESCE(department, 'Unspecified') AS department, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE assigned_employee IS NOT NULL AND TRIM(assigned_employee) <> '' AND assigned_employee <> 'Inventory')::int AS assigned,
        COALESCE(SUM(cost), 0) AS total_value FROM assets ${where} GROUP BY 1 ORDER BY total DESC`, params);
      return { rows, summary: { 'Departments': rows.length } };
    }
  },

  branch_asset: {
    label: 'Branch-wise Asset Report', group: 'Assets',
    filters: ['branch', 'category'],
    columns: [
      col('location', 'Branch / Location'), col('total', 'Total Assets', 'number'),
      col('assigned', 'Assigned', 'number'), col('total_value', 'Total Value', 'money')
    ],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { branch: 'location', category: 'category' });
      const where = clause ? `${clause} AND status <> 'Disposed'` : `WHERE status <> 'Disposed'`;
      const rows = await q(`SELECT COALESCE(location, 'Unspecified') AS location, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE assigned_employee IS NOT NULL AND TRIM(assigned_employee) <> '' AND assigned_employee <> 'Inventory')::int AS assigned,
        COALESCE(SUM(cost), 0) AS total_value FROM assets ${where} GROUP BY 1 ORDER BY total DESC`, params);
      return { rows, summary: { 'Branches': rows.length } };
    }
  },

  asset_allocation: {
    label: 'Asset Allocation Report', group: 'Assets',
    filters: ['department', 'employee', 'category'],
    columns: [
      col('asset_id', 'Asset ID'), col('name', 'Asset'), col('employee_name', 'Employee'),
      col('department', 'Department'), col('quantity', 'Qty', 'number'), col('date', 'Assigned On', 'date'), col('status', 'Status')
    ],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { department: 'aa.department', employee: 'aa.employee_name', category: 'a.category', date: 'aa.date' });
      const rows = await q(`SELECT aa.asset_id, a.name, aa.employee_name, aa.department, aa.quantity, aa.date, aa.status FROM asset_assignments aa LEFT JOIN assets a ON a.id = aa.asset_id ${clause} ORDER BY aa.date DESC`, params);
      return { rows, summary: { 'Allocations': rows.length } };
    }
  },

  asset_movement: {
    label: 'Asset Movement History', group: 'Assets',
    filters: ['category', 'dateFrom', 'dateTo'],
    columns: [
      col('asset_id', 'Asset ID'), col('name', 'Asset'), col('date', 'Date', 'date'),
      col('type', 'Movement'), col('from_loc', 'From'), col('to_loc', 'To'), col('actor', 'By'), col('notes', 'Notes')
    ],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { category: 'a.category', date: 'mv.date' });
      const rows = await q(`SELECT mv.asset_id, a.name, mv.date, mv.type, mv.from_loc, mv.to_loc, mv.actor, mv.notes FROM movements mv LEFT JOIN assets a ON a.id = mv.asset_id ${clause} ORDER BY mv.date DESC, mv.id DESC`, params);
      return { rows, summary: { 'Movements': rows.length } };
    }
  },

  ticket_status: {
    label: 'Ticket Status Report', group: 'Helpdesk',
    filters: ['department', 'status', 'priority', 'dateFrom', 'dateTo'],
    columns: [
      col('ticket_id', 'Ticket'), col('subject', 'Subject'), col('department', 'Department'),
      col('priority', 'Priority'), col('status', 'Status'), col('assigned_to_name', 'Agent'),
      col('created_at', 'Created', 'date'), col('resolution_due', 'Resolution Due', 'datetime')
    ],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { department: 'department', status: 'status', priority: 'priority', date: 'created_at' });
      const rows = await q(`SELECT ticket_id, subject, department, priority, status, assigned_to_name, created_at, resolution_due FROM tickets ${clause} ORDER BY created_at DESC`, params);
      return { rows, summary: { 'Tickets': rows.length } };
    }
  },

  ticket_trend: {
    label: 'Ticket Trend Analysis', group: 'Helpdesk',
    filters: ['department', 'dateFrom', 'dateTo'],
    columns: [col('date', 'Date', 'date'), col('created', 'Created', 'number'), col('resolved', 'Resolved', 'number')],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { department: 'department' });
      const start = f.dateFrom || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
      const end = f.dateTo || new Date().toISOString().slice(0, 10);
      const createdWhere = clause ? `${clause} AND created_at::date BETWEEN $${params.length + 1} AND $${params.length + 2}` : `WHERE created_at::date BETWEEN $1 AND $2`;
      const resolvedWhere = clause ? `${clause} AND resolved_at::date BETWEEN $${params.length + 1} AND $${params.length + 2}` : `WHERE resolved_at::date BETWEEN $1 AND $2`;
      const created = await q(`SELECT created_at::date AS d, COUNT(*)::int AS c FROM tickets ${createdWhere} GROUP BY 1`, [...params, start, end]);
      const resolved = await q(`SELECT resolved_at::date AS d, COUNT(*)::int AS c FROM tickets ${resolvedWhere} GROUP BY 1`, [...params, start, end]);
      const cMap = {}, rMap = {};
      for (const r of created) cMap[r.d.toISOString().slice(0, 10)] = r.c;
      for (const r of resolved) rMap[r.d.toISOString().slice(0, 10)] = r.c;
      const rows = [];
      for (let d = new Date(start); d <= new Date(end); d.setDate(d.getDate() + 1)) {
        const key = d.toISOString().slice(0, 10);
        rows.push({ date: key, created: cMap[key] || 0, resolved: rMap[key] || 0 });
      }
      return { rows, summary: { 'Days': rows.length, 'Total created': rows.reduce((s, r) => s + r.created, 0), 'Total resolved': rows.reduce((s, r) => s + r.resolved, 0) } };
    }
  },

  sla_compliance: {
    label: 'SLA Compliance Report', group: 'Helpdesk',
    filters: ['department', 'priority', 'status', 'dateFrom', 'dateTo'],
    columns: [
      col('ticket_id', 'Ticket'), col('priority', 'Priority'), col('department', 'Department'), col('status', 'Status'),
      col('resolution_due', 'Resolution Due', 'datetime'), col('resolved_at', 'Resolved At', 'datetime'),
      col('resolution_breached', 'Breached', 'bool'), col('escalation_level', 'Esc. Level', 'number')
    ],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { department: 'department', priority: 'priority', status: 'status', date: 'created_at' });
      const where = clause ? `${clause} AND resolution_due IS NOT NULL` : 'WHERE resolution_due IS NOT NULL';
      const rows = await q(`SELECT ticket_id, priority, department, status, resolution_due, resolved_at, resolution_breached, escalation_level FROM tickets ${where} ORDER BY created_at DESC`, params);
      const closed = rows.filter((r) => r.status === 'Resolved' || r.status === 'Closed');
      const met = closed.filter((r) => !r.resolution_breached).length;
      return { rows, summary: { 'Tickets under SLA': rows.length, 'Closed measured': closed.length, 'Compliance': closed.length ? `${Math.round((met / closed.length) * 100)}%` : 'n/a' } };
    }
  },

  technician_performance: {
    label: 'Technician Performance Report', group: 'Helpdesk',
    filters: ['department'],
    columns: [
      col('name', 'Technician'), col('department', 'Department'), col('assigned', 'Assigned', 'number'),
      col('resolved', 'Resolved', 'number'), col('open_workload', 'Open', 'number'),
      col('avg_resolution_hours', 'Avg Res. (h)', 'number'), col('sla_compliance', 'SLA %', 'text')
    ],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { department: 't.department' });
      const where = clause ? `${clause} AND t.assigned_to IS NOT NULL` : 'WHERE t.assigned_to IS NOT NULL';
      const raw = await q(`SELECT u.name, u.department,
          COUNT(*)::int AS assigned,
          COUNT(*) FILTER (WHERE t.status IN ('Resolved','Closed'))::int AS resolved,
          COUNT(*) FILTER (WHERE t.status NOT IN ('Resolved','Closed'))::int AS open_workload,
          COUNT(*) FILTER (WHERE t.status IN ('Resolved','Closed') AND NOT t.resolution_breached)::int AS resolved_on_time,
          AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/3600) FILTER (WHERE t.resolved_at IS NOT NULL) AS avg_resolution_hours
        FROM tickets t JOIN users u ON u.workos_user_id = t.assigned_to ${where}
        GROUP BY u.workos_user_id, u.name, u.department ORDER BY resolved DESC`, params);
      const rows = raw.map((r) => ({
        name: r.name, department: r.department, assigned: r.assigned, resolved: r.resolved,
        open_workload: r.open_workload,
        avg_resolution_hours: r.avg_resolution_hours == null ? null : Math.round(r.avg_resolution_hours * 10) / 10,
        sla_compliance: r.resolved ? `${Math.round((r.resolved_on_time / r.resolved) * 100)}%` : 'n/a'
      }));
      return { rows, summary: { 'Technicians': rows.length } };
    }
  },

  finance_summary: {
    label: 'Finance Summary', group: 'Finance',
    filters: ['vendor', 'status', 'dateFrom', 'dateTo'],
    columns: [
      col('id', 'Invoice'), col('po_reference', 'PO Ref'), col('vendor', 'Vendor'),
      col('amount', 'Amount', 'money'), col('gst', 'GST %', 'number'), col('date', 'Date', 'date'), col('payment_status', 'Status')
    ],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { vendor: 'vendor', status: 'payment_status', date: 'date' });
      const rows = await q(`SELECT id, po_reference, vendor, amount, gst, date, payment_status FROM invoices ${clause} ORDER BY date DESC`, params);
      const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
      const pending = rows.filter((r) => r.payment_status !== 'Paid').reduce((s, r) => s + Number(r.amount || 0), 0);
      return { rows, summary: { 'Invoices': rows.length, 'Total billed': money(total), 'Outstanding': money(pending) } };
    }
  },

  purchase_orders: {
    label: 'Purchase Orders', group: 'Finance',
    filters: ['vendor', 'status', 'dateFrom', 'dateTo'],
    columns: [
      col('po_number', 'PO #'), col('vendor', 'Vendor'), col('issue_date', 'Issued', 'date'),
      col('expected_delivery_date', 'Expected', 'date'), col('status', 'Status'), col('amount', 'Amount', 'money'), col('currency', 'Currency')
    ],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { vendor: 'vendor', status: 'status', date: 'issue_date' });
      const rows = await q(`SELECT po_number, vendor, issue_date, expected_delivery_date, status, amount, currency FROM purchase_orders ${clause} ORDER BY issue_date DESC NULLS LAST`, params);
      const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
      return { rows, summary: { 'Orders': rows.length, 'Total value': money(total) } };
    }
  },

  vendor_performance: {
    label: 'Vendor Performance', group: 'Finance',
    filters: ['vendor'],
    columns: [
      col('vendor', 'Vendor'), col('po_count', 'Purchase Orders', 'number'), col('po_spend', 'PO Spend', 'money'),
      col('invoice_count', 'Invoices', 'number'), col('invoice_spend', 'Invoiced', 'money'), col('amc_count', 'AMC Contracts', 'number')
    ],
    build: async (f) => {
      const { clause, params } = buildWhere(f, { vendor: 'v.name' });
      // Correlated subqueries per metric so joins across POs/invoices/AMCs can't inflate
      // one another's sums.
      const rows = await q(`SELECT v.name AS vendor,
          (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.vendor_id = v.id) AS po_count,
          (SELECT COALESCE(SUM(amount),0) FROM purchase_orders po WHERE po.vendor_id = v.id) AS po_spend,
          (SELECT COUNT(*)::int FROM invoices i WHERE LOWER(i.vendor) = LOWER(v.name)) AS invoice_count,
          (SELECT COALESCE(SUM(amount),0) FROM invoices i WHERE LOWER(i.vendor) = LOWER(v.name)) AS invoice_spend,
          (SELECT COUNT(*)::int FROM amcs m WHERE LOWER(m.vendor) = LOWER(v.name)) AS amc_count
        FROM vendors v ${clause} ORDER BY po_spend DESC`, params);
      return { rows, summary: { 'Vendors': rows.length } };
    }
  }
};

const money = (n) => `Rs ${Number(n || 0).toLocaleString('en-IN')}`;

/* -------------------------------------------------------------- filter options */

async function filterOptions() {
  const distinct = async (sql) => (await q(sql)).map((r) => r.v).filter((v) => v != null && String(v).trim() !== '');
  const [departments, categories, branches, vendors, employees] = await Promise.all([
    // Prefer the masters (single source of truth), unioned with any values already present
    // on records so historical/legacy entries remain filterable.
    distinct(`SELECT v FROM (
                SELECT name AS v FROM departments WHERE is_active
                UNION SELECT department FROM assets
                UNION SELECT department FROM tickets
              ) d ORDER BY 1`),
    distinct(`SELECT DISTINCT category::text AS v FROM assets ORDER BY 1`),
    distinct(`SELECT v FROM (
                SELECT name AS v FROM locations WHERE is_active
                UNION SELECT location FROM assets
              ) l ORDER BY 1`),
    distinct(`SELECT DISTINCT name AS v FROM vendors UNION SELECT DISTINCT vendor FROM amcs UNION SELECT DISTINCT vendor FROM invoices ORDER BY 1`),
    distinct(`SELECT DISTINCT name AS v FROM users WHERE role::text <> 'Employee' ORDER BY 1`)
  ]);
  return {
    departments, categories, branches, vendors, employees,
    ticketStatuses: ['Open', 'In Progress', 'Pending', 'On Hold', 'Waiting for Employee', 'Resolved', 'Closed', 'Reopened'],
    priorities: ['Critical', 'High', 'Medium', 'Low'],
    paymentStatuses: ['Pending', 'Partially Paid', 'Paid', 'Overdue'],
    poStatuses: ['Draft', 'Issued', 'Partially Received', 'Received', 'Cancelled']
  };
}

/* --------------------------------------------------------------- run + format */

async function runReport(key, filters = {}) {
  const def = REPORTS[key];
  if (!def) { const e = new Error(`Unknown report "${key}"`); e.statusCode = 400; throw e; }
  const { rows, summary } = await def.build(filters);
  return { key, title: def.label, columns: def.columns, rows, summary, generatedAt: new Date().toISOString() };
}

// A report rendered as CSV, for email delivery and download.
function toCsv(report) {
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = report.columns.map((c) => esc(c.label)).join(',');
  const lines = report.rows.map((r) => report.columns.map((c) => esc(r[c.key])).join(','));
  return [header, ...lines].join('\n');
}

const reportList = () =>
  Object.entries(REPORTS).map(([key, r]) => ({ key, label: r.label, group: r.group, filters: r.filters }));

/* ------------------------------------------------------- scheduled reports */

// next_run for a cadence, from a base instant (defaults to now).
function nextRunFor(frequency, from = new Date()) {
  const d = new Date(from);
  if (frequency === 'daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + 7); // weekly default
  return d;
}

const mapSchedule = (r) => ({
  id: r.id, reportKey: r.report_key, name: r.name, filters: r.filters, frequency: r.frequency,
  recipients: r.recipients, format: r.format, active: r.active, lastRun: r.last_run, nextRun: r.next_run,
  reportLabel: REPORTS[r.report_key]?.label || r.report_key
});

/** Generate and email every schedule whose next_run has passed. Driven by cron. */
async function runDueScheduledReports() {
  const due = await q(`SELECT * FROM scheduled_reports WHERE active = TRUE AND (next_run IS NULL OR next_run <= NOW())`);
  let sent = 0;
  for (const s of due) {
    try {
      const report = await runReport(s.report_key, s.filters || {});
      const csv = toCsv(report);
      const summaryLine = Object.entries(report.summary || {}).map(([k, v]) => `${k}: ${v}`).join('  |  ');
      const body =
        `${report.title}\nGenerated: ${new Date(report.generatedAt).toLocaleString()}\n` +
        `Rows: ${report.rows.length}\n${summaryLine ? summaryLine + '\n' : ''}\n` +
        `${csv}\n\n— AssetFlow Scheduled Reports`;
      for (const to of s.recipients || []) {
        try {
          await emailChannel.send({ to, subject: `[Scheduled Report] ${report.title}`, body });
          // Mirror into the Email Alerts Inbox so it is visible even on the log transport.
          await db.query(
            `INSERT INTO emails (id, sender, date, subject, body) VALUES ($1, 'AssetFlow Reports', $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
            [`RPT-${s.id}-${Date.now()}`, new Date().toLocaleString(), `[Scheduled Report] ${report.title}`, body]
          );
        } catch (err) {
          console.error(`[reports] failed emailing schedule ${s.id} to ${to}:`, err.message);
        }
      }
      await db.query(`UPDATE scheduled_reports SET last_run = NOW(), next_run = $1, updated_at = NOW() WHERE id = $2`, [nextRunFor(s.frequency), s.id]);
      sent++;
    } catch (err) {
      console.error(`[reports] scheduled report ${s.id} failed:`, err.message);
    }
  }
  if (sent) console.log(`[reports] ran ${sent} scheduled report(s)`);
  return { ran: sent };
}

/* ------------------------------------------------------------------ routes */

function register(app, { requirePermission }) {
  app.get('/api/reports/options', async (req, res) => {
    const user = await requirePermission(req, res, 'reports', 'view');
    if (!user) return;
    try {
      res.json({ reports: reportList(), filterOptions: await filterOptions() });
    } catch (err) {
      console.error('GET /api/reports/options failed:', err);
      res.status(500).json({ error: 'Could not load report options: ' + err.message });
    }
  });

  app.post('/api/reports/run', async (req, res) => {
    const user = await requirePermission(req, res, 'reports', 'view');
    if (!user) return;
    try {
      res.json(await runReport(req.body.key, req.body.filters || {}));
    } catch (err) {
      console.error('POST /api/reports/run failed:', err);
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  app.post('/api/reports/email', async (req, res) => {
    const user = await requirePermission(req, res, 'reports', 'export');
    if (!user) return;
    const recipients = Array.isArray(req.body.recipients) ? req.body.recipients.filter(Boolean) : [];
    if (!recipients.length) return res.status(400).json({ error: 'At least one recipient email is required.' });
    try {
      const report = await runReport(req.body.key, req.body.filters || {});
      const body = `${report.title}\nGenerated: ${new Date(report.generatedAt).toLocaleString()}\nRows: ${report.rows.length}\n\n${toCsv(report)}\n\n— AssetFlow Reports`;
      for (const to of recipients) {
        await emailChannel.send({ to, subject: `[Report] ${report.title}`, body });
        await db.query(
          `INSERT INTO emails (id, sender, date, subject, body) VALUES ($1, 'AssetFlow Reports', $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
          [`RPT-manual-${Date.now()}-${to.slice(0, 8)}`, new Date().toLocaleString(), `[Report] ${report.title}`, body]
        );
      }
      res.json({ ok: true, recipients: recipients.length, delivered: emailChannel.isConfigured });
    } catch (err) {
      console.error('POST /api/reports/email failed:', err);
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  /* -------- scheduled reports CRUD -------- */

  app.get('/api/reports/scheduled', async (req, res) => {
    const user = await requirePermission(req, res, 'reports', 'view');
    if (!user) return;
    try {
      const rows = await q('SELECT * FROM scheduled_reports ORDER BY created_at DESC');
      res.json(rows.map(mapSchedule));
    } catch (err) {
      console.error('GET /api/reports/scheduled failed:', err);
      res.status(500).json({ error: 'Could not load scheduled reports: ' + err.message });
    }
  });

  app.post('/api/reports/scheduled', async (req, res) => {
    const user = await requirePermission(req, res, 'reports', 'export');
    if (!user) return;
    const b = req.body;
    if (!REPORTS[b.reportKey]) return res.status(400).json({ error: 'Unknown report key.' });
    const recipients = Array.isArray(b.recipients) ? b.recipients.filter(Boolean) : [];
    if (!recipients.length) return res.status(400).json({ error: 'At least one recipient email is required.' });
    const frequency = ['daily', 'weekly', 'monthly'].includes(b.frequency) ? b.frequency : 'weekly';
    try {
      const rows = await q(
        `INSERT INTO scheduled_reports (report_key, name, filters, frequency, recipients, format, next_run, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [b.reportKey, b.name || REPORTS[b.reportKey].label, b.filters || {}, frequency, recipients, b.format || 'csv', nextRunFor(frequency), user.name]
      );
      res.status(201).json(mapSchedule(rows[0]));
    } catch (err) {
      console.error('POST /api/reports/scheduled failed:', err);
      res.status(500).json({ error: 'Could not create scheduled report: ' + err.message });
    }
  });

  app.put('/api/reports/scheduled/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'reports', 'export');
    if (!user) return;
    const b = req.body;
    const frequency = ['daily', 'weekly', 'monthly'].includes(b.frequency) ? b.frequency : 'weekly';
    const recipients = Array.isArray(b.recipients) ? b.recipients.filter(Boolean) : [];
    try {
      const rows = await q(
        `UPDATE scheduled_reports SET name=$1, filters=$2, frequency=$3, recipients=$4, format=$5, active=$6, updated_at=NOW()
         WHERE id=$7 RETURNING *`,
        [b.name, b.filters || {}, frequency, recipients, b.format || 'csv', b.active !== false, req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Scheduled report not found' });
      res.json(mapSchedule(rows[0]));
    } catch (err) {
      console.error('PUT /api/reports/scheduled failed:', err);
      res.status(500).json({ error: 'Could not update scheduled report: ' + err.message });
    }
  });

  app.delete('/api/reports/scheduled/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'reports', 'export');
    if (!user) return;
    try {
      const rows = await q('DELETE FROM scheduled_reports WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'Scheduled report not found' });
      res.json({ success: true });
    } catch (err) {
      console.error('DELETE /api/reports/scheduled failed:', err);
      res.status(500).json({ error: 'Could not delete scheduled report: ' + err.message });
    }
  });
}

module.exports = { register, runReport, runDueScheduledReports, reportList, filterOptions, toCsv, REPORTS };
