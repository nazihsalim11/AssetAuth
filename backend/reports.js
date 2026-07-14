/**
 * Reporting engine. Fourteen reports, each defined declaratively as a set of columns,
 * the filters it accepts, and a builder that produces its rows. A single /api/reports/run
 * endpoint serves them all, so the frontend renders and exports any report generically.
 *
 * Backed by native Convex: builders fetch whole tables via generic:list and fold them in
 * JS (the old SQL WHERE / JOIN / GROUP BY / COUNT-FILTER live here now). Filters are applied
 * through filterRows, which maps a report's supported filter keys to real fields.
 *
 * Reports can also be scheduled: a row in scheduled_reports names a report, saved filters,
 * a cadence and recipients; runDueScheduledReports (driven by cron) generates each due
 * report as CSV and emails it.
 */

const { cq, cm } = require('./convexApi');
const emailChannel = require('./notifications/channels/email');

const col = (key, label, type = 'text') => ({ key, label, type });

/* ------------------------------------------------------------ data access */

const strip = (d) => { if (!d) return d; const { _id, _creationTime, ...rest } = d; return rest; };
// Fetch a whole table from Convex as plain rows (mirrored snake_case fields).
const fetchAll = async (table) => (await cq('generic:list', { table })).map(strip);

/* ------------------------------------------------------------ JS aggregation helpers */

const money = (n) => `Rs ${Number(n || 0).toLocaleString('en-IN')}`;
const lc = (s) => String(s == null ? '' : s).toLowerCase();
const sum = (rows, f) => rows.reduce((s, r) => s + Number(r[f] || 0), 0);
const day = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : null);
const todayUTC = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
const daysUntil = (dateStr) => (dateStr == null ? null : Math.round((new Date(dateStr) - todayUTC()) / 86400000));
const CLOSED = new Set(['Resolved', 'Closed']);
const isAssigned = (e) => e != null && String(e).trim() !== '' && e !== 'Inventory';
const byMoneyDesc = (a, b, f) => Number(b[f] || 0) - Number(a[f] || 0);

// JS analogue of the old buildWhere. `map` maps a filter key to the (flat) field it
// constrains on each row; only mapped, non-empty filters are applied. `employee` matches
// as a case-insensitive substring (the old ILIKE '%..%'); dates bound map.date.
function filterRows(rows, filters, map) {
  const eq = (key) => filters[key] && map[key];
  return rows.filter((r) => {
    if (eq('department') && r[map.department] !== filters.department) return false;
    if (eq('category') && r[map.category] !== filters.category) return false;
    if (eq('branch') && r[map.branch] !== filters.branch) return false;
    if (eq('status') && r[map.status] !== filters.status) return false;
    if (eq('priority') && r[map.priority] !== filters.priority) return false;
    if (eq('vendor') && r[map.vendor] !== filters.vendor) return false;
    if (eq('employee') && !lc(r[map.employee]).includes(lc(filters.employee))) return false;
    if (filters.dateFrom && map.date && !(new Date(r[map.date]) >= new Date(filters.dateFrom))) return false;
    if (filters.dateTo && map.date && !(new Date(r[map.date]) <= new Date(filters.dateTo))) return false;
    return true;
  });
}

// COALESCE(col,'Unspecified') group aggregation, returning an array of grouped rows built
// by `make`, ordered by `order`. Only null becomes 'Unspecified' (empty strings stay).
function groupRows(rows, key) {
  const groups = new Map();
  for (const r of rows) {
    const k = r[key] == null ? 'Unspecified' : String(r[key]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return groups;
}

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
      const assets = await fetchAll('assets');
      const rows = filterRows(assets, f, { department: 'department', category: 'category', branch: 'location', status: 'status', date: 'purchase_date' })
        .sort((a, b) => Number(a.id) - Number(b.id));
      return { rows, summary: { 'Total assets': rows.length, 'Total value': money(sum(rows, 'cost')) } };
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
      const assets = await fetchAll('assets');
      const rows = filterRows(assets.filter((a) => a.warranty_expiry != null), f,
        { department: 'department', category: 'category', branch: 'location', date: 'warranty_expiry' })
        .map((a) => ({ ...a, days_left: daysUntil(a.warranty_expiry) }))
        .sort((a, b) => String(a.warranty_expiry).localeCompare(String(b.warranty_expiry)));
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
      const [amcs, assets] = await Promise.all([fetchAll('amcs'), fetchAll('assets')]);
      const rows = filterRows(amcs, f, { vendor: 'vendor', date: 'end_date' })
        .map((m) => ({
          id: m.id, vendor: m.vendor, start_date: m.start_date, end_date: m.end_date,
          days_left: daysUntil(m.end_date), cost: m.cost,
          asset_count: assets.filter((a) => a.amc_id === m.id).length
        }))
        .sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)));
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
      const assets = await fetchAll('assets');
      const live = filterRows(assets.filter((a) => a.status !== 'Disposed'), f, { department: 'department', category: 'category' });
      const rows = [...groupRows(live, 'department').entries()].map(([department, items]) => ({
        department,
        total: items.length,
        assigned: items.filter((r) => isAssigned(r.assigned_employee)).length,
        total_value: sum(items, 'cost')
      })).sort((a, b) => b.total - a.total);
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
      const assets = await fetchAll('assets');
      const live = filterRows(assets.filter((a) => a.status !== 'Disposed'), f, { branch: 'location', category: 'category' });
      const rows = [...groupRows(live, 'location').entries()].map(([location, items]) => ({
        location,
        total: items.length,
        assigned: items.filter((r) => isAssigned(r.assigned_employee)).length,
        total_value: sum(items, 'cost')
      })).sort((a, b) => b.total - a.total);
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
      const [assignments, assets] = await Promise.all([fetchAll('asset_assignments'), fetchAll('assets')]);
      const amap = new Map(assets.map((a) => [a.id, a]));
      const joined = assignments.map((aa) => ({
        asset_id: aa.asset_id, name: amap.get(aa.asset_id)?.name, employee_name: aa.employee_name,
        department: aa.department, quantity: aa.quantity, date: aa.date, status: aa.status,
        category: amap.get(aa.asset_id)?.category
      }));
      const rows = filterRows(joined, f, { department: 'department', employee: 'employee_name', category: 'category', date: 'date' })
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
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
      const [movements, assets] = await Promise.all([fetchAll('movements'), fetchAll('assets')]);
      const amap = new Map(assets.map((a) => [a.id, a]));
      const joined = movements.map((mv) => ({
        asset_id: mv.asset_id, name: amap.get(mv.asset_id)?.name, date: mv.date, type: mv.type,
        from_loc: mv.from_loc, to_loc: mv.to_loc, actor: mv.actor, notes: mv.notes,
        category: amap.get(mv.asset_id)?.category, _mid: Number(mv.id) || 0
      }));
      const rows = filterRows(joined, f, { category: 'category', date: 'date' })
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b._mid - a._mid);
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
      const tickets = await fetchAll('tickets');
      const rows = filterRows(tickets, f, { department: 'department', status: 'status', priority: 'priority', date: 'created_at' })
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return { rows, summary: { 'Tickets': rows.length } };
    }
  },

  ticket_trend: {
    label: 'Ticket Trend Analysis', group: 'Helpdesk',
    filters: ['department', 'dateFrom', 'dateTo'],
    columns: [col('date', 'Date', 'date'), col('created', 'Created', 'number'), col('resolved', 'Resolved', 'number')],
    build: async (f) => {
      const tickets = await fetchAll('tickets');
      const scoped = f.department ? tickets.filter((t) => t.department === f.department) : tickets;
      const start = f.dateFrom || day(Date.now() - 29 * 86400000);
      const end = f.dateTo || day(Date.now());
      const cMap = {}, rMap = {};
      for (const t of scoped) {
        const c = day(t.created_at);
        if (c && c >= start && c <= end) cMap[c] = (cMap[c] || 0) + 1;
        const r = day(t.resolved_at);
        if (r && r >= start && r <= end) rMap[r] = (rMap[r] || 0) + 1;
      }
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
      const tickets = await fetchAll('tickets');
      const rows = filterRows(tickets.filter((t) => t.resolution_due != null), f,
        { department: 'department', priority: 'priority', status: 'status', date: 'created_at' })
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const closed = rows.filter((r) => CLOSED.has(r.status));
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
      const [tickets, users] = await Promise.all([fetchAll('tickets'), fetchAll('users')]);
      const umap = new Map(users.map((u) => [u.workos_user_id, u]));
      const scoped = tickets.filter((t) => t.assigned_to != null && umap.has(t.assigned_to)
        && (!f.department || t.department === f.department));
      const agg = new Map();
      for (const t of scoped) {
        let a = agg.get(t.assigned_to);
        if (!a) {
          const u = umap.get(t.assigned_to);
          a = { name: u.name, department: u.department, assigned: 0, resolved: 0, open_workload: 0, resolved_on_time: 0, resSum: 0, resN: 0 };
          agg.set(t.assigned_to, a);
        }
        a.assigned++;
        if (CLOSED.has(t.status)) { a.resolved++; if (!t.resolution_breached) a.resolved_on_time++; }
        else a.open_workload++;
        if (t.resolved_at) { a.resSum += (new Date(t.resolved_at) - new Date(t.created_at)) / 3600000; a.resN++; }
      }
      const rows = [...agg.values()].map((a) => ({
        name: a.name, department: a.department, assigned: a.assigned, resolved: a.resolved,
        open_workload: a.open_workload,
        avg_resolution_hours: a.resN ? Math.round((a.resSum / a.resN) * 10) / 10 : null,
        sla_compliance: a.resolved ? `${Math.round((a.resolved_on_time / a.resolved) * 100)}%` : 'n/a'
      })).sort((a, b) => b.resolved - a.resolved);
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
      const invoices = await fetchAll('invoices');
      const rows = filterRows(invoices, f, { vendor: 'vendor', status: 'payment_status', date: 'date' })
        .sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const total = sum(rows, 'amount');
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
      const pos = await fetchAll('purchase_orders');
      // ORDER BY issue_date DESC NULLS LAST
      const rows = filterRows(pos, f, { vendor: 'vendor', status: 'status', date: 'issue_date' })
        .sort((a, b) => {
          if (!a.issue_date && !b.issue_date) return 0;
          if (!a.issue_date) return 1;
          if (!b.issue_date) return -1;
          return String(b.issue_date).localeCompare(String(a.issue_date));
        });
      return { rows, summary: { 'Orders': rows.length, 'Total value': money(sum(rows, 'amount')) } };
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
      const [vendors, pos, invoices, amcs] = await Promise.all([
        fetchAll('vendors'), fetchAll('purchase_orders'), fetchAll('invoices'), fetchAll('amcs')
      ]);
      // Per-metric folds keep POs/invoices/AMCs from inflating one another (the old
      // correlated subqueries).
      let rows = vendors.map((v) => {
        const vp = pos.filter((p) => p.vendor_id === v.id);
        const vi = invoices.filter((i) => lc(i.vendor) === lc(v.name));
        const vm = amcs.filter((m) => lc(m.vendor) === lc(v.name));
        return {
          vendor: v.name,
          po_count: vp.length, po_spend: sum(vp, 'amount'),
          invoice_count: vi.length, invoice_spend: sum(vi, 'amount'),
          amc_count: vm.length
        };
      });
      if (f.vendor) rows = rows.filter((r) => r.vendor === f.vendor);
      rows.sort((a, b) => byMoneyDesc(a, b, 'po_spend'));
      return { rows, summary: { 'Vendors': rows.length } };
    }
  }
};

/* -------------------------------------------------------------- filter options */

async function filterOptions() {
  const [departments, assets, tickets, locations, vendorsT, amcs, invoices, users] = await Promise.all([
    fetchAll('departments'), fetchAll('assets'), fetchAll('tickets'), fetchAll('locations'),
    fetchAll('vendors'), fetchAll('amcs'), fetchAll('invoices'), fetchAll('users')
  ]);
  const clean = (arr) => [...new Set(arr.filter((v) => v != null && String(v).trim() !== ''))].sort((a, b) => String(a).localeCompare(String(b)));
  return {
    // Prefer the masters (single source of truth), unioned with any values already present
    // on records so historical/legacy entries remain filterable.
    departments: clean([...departments.filter((d) => d.is_active).map((d) => d.name), ...assets.map((a) => a.department), ...tickets.map((t) => t.department)]),
    categories: clean(assets.map((a) => a.category)),
    branches: clean([...locations.filter((l) => l.is_active).map((l) => l.name), ...assets.map((a) => a.location)]),
    vendors: clean([...vendorsT.map((v) => v.name), ...amcs.map((m) => m.vendor), ...invoices.map((i) => i.vendor)]),
    employees: clean(users.filter((u) => String(u.role) !== 'Employee').map((u) => u.name)),
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

// Mirror a sent report into the Email Alerts Inbox (ON CONFLICT DO NOTHING on id).
async function mirrorEmail(id, subject, body) {
  await cm('reports:emailInsert', { email: { id, sender: 'AssetFlow Reports', date: new Date().toLocaleString(), subject, body } });
}

/** Generate and email every schedule whose next_run has passed. Driven by cron. */
async function runDueScheduledReports() {
  const now = new Date();
  const all = await cq('generic:list', { table: 'scheduled_reports' });
  const due = all.map(strip).filter((s) => s.active && (s.next_run == null || new Date(s.next_run) <= now));
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
          await mirrorEmail(`RPT-${s.id}-${Date.now()}`, `[Scheduled Report] ${report.title}`, body);
        } catch (err) {
          console.error(`[reports] failed emailing schedule ${s.id} to ${to}:`, err.message);
        }
      }
      await cm('generic:update', {
        table: 'scheduled_reports', idField: 'id', idVal: Number(s.id),
        patch: { last_run: now.toISOString(), next_run: nextRunFor(s.frequency).toISOString(), updated_at: now.toISOString() }
      });
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
        await mirrorEmail(`RPT-manual-${Date.now()}-${to.slice(0, 8)}`, `[Report] ${report.title}`, body);
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
      const rows = await cq('generic:list', { table: 'scheduled_reports', orderBy: 'created_at', orderDir: 'desc' });
      res.json(rows.map(strip).map(mapSchedule));
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
      const saved = await cm('reports:scheduledCreate', {
        doc: {
          report_key: b.reportKey, name: b.name || REPORTS[b.reportKey].label, filters: b.filters || {},
          frequency, recipients, format: b.format || 'csv', next_run: nextRunFor(frequency).toISOString(), created_by: user.name
        }
      });
      res.status(201).json(mapSchedule(saved));
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
      const saved = await cm('generic:update', {
        table: 'scheduled_reports', idField: 'id', idVal: Number(req.params.id),
        patch: { name: b.name, filters: b.filters || {}, frequency, recipients, format: b.format || 'csv', active: b.active !== false, updated_at: new Date().toISOString() }
      });
      res.json(mapSchedule(strip(saved)));
    } catch (err) {
      if (/not found/i.test(err.message)) return res.status(404).json({ error: 'Scheduled report not found' });
      console.error('PUT /api/reports/scheduled failed:', err);
      res.status(500).json({ error: 'Could not update scheduled report: ' + err.message });
    }
  });

  app.delete('/api/reports/scheduled/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'reports', 'export');
    if (!user) return;
    try {
      const removed = await cm('generic:remove', { table: 'scheduled_reports', idField: 'id', idVal: Number(req.params.id) });
      if (!removed) return res.status(404).json({ error: 'Scheduled report not found' });
      res.json({ success: true });
    } catch (err) {
      console.error('DELETE /api/reports/scheduled failed:', err);
      res.status(500).json({ error: 'Could not delete scheduled report: ' + err.message });
    }
  });
}

module.exports = { register, runReport, runDueScheduledReports, reportList, filterOptions, toCsv, REPORTS };
