/**
 * Live dashboard aggregates. Every figure here is computed from the database on request
 * — nothing is cached or precomputed — so the dashboards always reflect current state.
 *
 * Four endpoints, one per dashboard in the spec:
 *   /api/dashboards/tickets      queue health, breakdowns, 30-day trend, averages
 *   /api/dashboards/sla          compliance %, breaches, escalations, averages
 *   /api/dashboards/technicians  per-agent load, throughput, SLA compliance, ranking
 *   /api/dashboards/assets       inventory summary, breakdowns, expiries
 *
 * Non-Super-Admins are scoped to their own department, matching the ticket queue.
 */

const db = require('./db');

// Build a "WHERE department = $n" scope for non-Super-Admins, plus optional date range
// on created_at. `prefix` qualifies the columns (e.g. 't.') for queries that join another
// table carrying a department column, avoiding an ambiguous-reference error.
// Returns { clause, params } ready to splice into a query.
function ticketScope(user, query, prefix = '', startIndex = 1) {
  const filters = [];
  const params = [];
  let i = startIndex;

  const dept = query.department || (user.role !== 'Super Admin' ? user.department : null);
  if (dept) { filters.push(`${prefix}department = $${i++}`); params.push(dept); }
  if (query.from) { filters.push(`${prefix}created_at >= $${i++}`); params.push(query.from); }
  if (query.to) { filters.push(`${prefix}created_at <= $${i++}`); params.push(query.to); }

  return { clause: filters.length ? 'WHERE ' + filters.join(' AND ') : '', params };
}

const num = (v) => (v == null ? 0 : Number(v));
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const round1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

/* ------------------------------------------------------------ ticket dashboard */

async function ticketDashboard(user, query) {
  const { clause, params } = ticketScope(user, query);

  const counts = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'Open')::int AS open,
       COUNT(*) FILTER (WHERE status = 'In Progress')::int AS in_progress,
       COUNT(*) FILTER (WHERE status IN ('Pending','On Hold','Waiting for Employee'))::int AS pending,
       COUNT(*) FILTER (WHERE status = 'Resolved')::int AS resolved,
       COUNT(*) FILTER (WHERE status = 'Closed')::int AS closed,
       COUNT(*) FILTER (WHERE status = 'Reopened')::int AS reopened,
       COUNT(*) FILTER (WHERE assigned_to IS NULL AND status NOT IN ('Resolved','Closed'))::int AS unassigned,
       COUNT(*) FILTER (WHERE assigned_to IS NOT NULL)::int AS assigned,
       AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL) AS avg_resolution_hours,
       AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))/3600) FILTER (WHERE first_response_at IS NOT NULL) AS avg_first_response_hours
     FROM tickets ${clause}`,
    params
  );

  const groupBy = async (col) => {
    const { rows } = await db.query(
      `SELECT COALESCE(${col}, 'Unspecified') AS k, COUNT(*)::int AS c FROM tickets ${clause} GROUP BY 1 ORDER BY c DESC`,
      params
    );
    return rows.reduce((a, r) => { a[r.k] = r.c; return a; }, {});
  };

  const [byPriority, byCategory, byDepartment, byBranch] = await Promise.all([
    groupBy('priority'), groupBy('category'), groupBy('department'), groupBy('branch')
  ]);

  // 30-day trend: created vs resolved per day, gap-filled from a date series.
  const trendParams = [...params];
  const createdByDay = await db.query(
    `SELECT created_at::date AS d, COUNT(*)::int AS c FROM tickets ${clause}
     ${clause ? 'AND' : 'WHERE'} created_at >= CURRENT_DATE - INTERVAL '29 days' GROUP BY 1`,
    trendParams
  );
  const resolvedByDay = await db.query(
    `SELECT resolved_at::date AS d, COUNT(*)::int AS c FROM tickets ${clause}
     ${clause ? 'AND' : 'WHERE'} resolved_at >= CURRENT_DATE - INTERVAL '29 days' GROUP BY 1`,
    trendParams
  );
  const createdMap = {}, resolvedMap = {};
  for (const r of createdByDay.rows) createdMap[r.d.toISOString().slice(0, 10)] = r.c;
  for (const r of resolvedByDay.rows) resolvedMap[r.d.toISOString().slice(0, 10)] = r.c;
  const trend = [];
  for (let n = 29; n >= 0; n--) {
    const day = new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    trend.push({ date: day, created: createdMap[day] || 0, resolved: resolvedMap[day] || 0 });
  }

  const c = counts.rows[0];
  return {
    counts: {
      total: c.total, open: c.open, inProgress: c.in_progress, pending: c.pending,
      resolved: c.resolved, closed: c.closed, reopened: c.reopened,
      unassigned: c.unassigned, assigned: c.assigned
    },
    avgResolutionHours: round1(c.avg_resolution_hours),
    avgFirstResponseHours: round1(c.avg_first_response_hours),
    byPriority, byCategory, byDepartment, byBranch, trend
  };
}

/* --------------------------------------------------------------- sla dashboard */

async function slaDashboard(user, query) {
  const { clause, params } = ticketScope(user, query);

  const settings = await db.query('SELECT sla_warning_hours FROM notification_settings WHERE id = 1');
  const warnHours = settings.rows[0]?.sla_warning_hours ?? 8;

  const agg = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE resolution_due IS NOT NULL)::int AS with_sla,
       COUNT(*) FILTER (WHERE status IN ('Resolved','Closed'))::int AS closed_total,
       COUNT(*) FILTER (WHERE status IN ('Resolved','Closed') AND NOT resolution_breached)::int AS resolved_on_time,
       COUNT(*) FILTER (WHERE first_response_at IS NOT NULL)::int AS responded,
       COUNT(*) FILTER (WHERE first_response_at IS NOT NULL AND NOT response_breached)::int AS responded_on_time,
       COUNT(*) FILTER (WHERE resolution_breached)::int AS resolution_breached,
       COUNT(*) FILTER (WHERE response_breached)::int AS response_breached,
       COUNT(*) FILTER (WHERE escalation_level > 0)::int AS escalated,
       COUNT(*) FILTER (WHERE status NOT IN ('Resolved','Closed') AND resolution_due < NOW())::int AS breached_open,
       AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))/3600) FILTER (WHERE first_response_at IS NOT NULL) AS avg_response_hours,
       AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) FILTER (WHERE resolved_at IS NOT NULL) AS avg_resolution_hours
     FROM tickets ${clause}`,
    params
  );

  // Approaching breach: open, not yet breached, resolution due within the warning window.
  const approaching = await db.query(
    `SELECT COUNT(*)::int AS c FROM tickets ${clause}
     ${clause ? 'AND' : 'WHERE'} status NOT IN ('Resolved','Closed')
       AND resolution_due > NOW()
       AND resolution_due <= NOW() + ($${params.length + 1} || ' hours')::interval`,
    [...params, warnHours]
  );

  const byLevel = await db.query(
    `SELECT escalation_level AS level, COUNT(*)::int AS c FROM tickets ${clause}
     ${clause ? 'AND' : 'WHERE'} escalation_level > 0 GROUP BY 1 ORDER BY 1`,
    params
  );

  const a = agg.rows[0];
  return {
    compliance: {
      resolution: pct(a.resolved_on_time, a.closed_total),
      response: pct(a.responded_on_time, a.responded)
    },
    counts: {
      withSla: a.with_sla, closedTotal: a.closed_total, breachedOpen: a.breached_open,
      resolutionBreached: a.resolution_breached, responseBreached: a.response_breached,
      approaching: approaching.rows[0].c, escalated: a.escalated
    },
    avgResponseHours: round1(a.avg_response_hours),
    avgResolutionHours: round1(a.avg_resolution_hours),
    escalationsByLevel: byLevel.rows.reduce((acc, r) => { acc[`L${r.level}`] = r.c; return acc; }, {}),
    warningHours: warnHours
  };
}

/* -------------------------------------------------------- technician dashboard */

async function technicianDashboard(user, query) {
  // Qualify with t. — the join to users also has a department column.
  const { clause, params } = ticketScope(user, query, 't.');

  const { rows } = await db.query(
    `SELECT t.assigned_to AS id, u.name, u.department, u.role::text AS role,
       COUNT(*)::int AS assigned,
       COUNT(*) FILTER (WHERE t.status IN ('Resolved','Closed'))::int AS resolved,
       COUNT(*) FILTER (WHERE t.status NOT IN ('Resolved','Closed'))::int AS open_workload,
       COUNT(*) FILTER (WHERE t.status IN ('Resolved','Closed') AND NOT t.resolution_breached)::int AS resolved_on_time,
       COUNT(*) FILTER (WHERE t.escalation_level > 0)::int AS escalated,
       AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/3600) FILTER (WHERE t.resolved_at IS NOT NULL) AS avg_resolution_hours
     FROM tickets t JOIN users u ON u.workos_user_id = t.assigned_to
     ${clause ? clause + ' AND' : 'WHERE'} t.assigned_to IS NOT NULL
     GROUP BY t.assigned_to, u.name, u.department, u.role`,
    params
  );

  const technicians = rows.map((r) => ({
    id: r.id,
    name: r.name,
    department: r.department,
    role: r.role,
    assigned: num(r.assigned),
    resolved: num(r.resolved),
    openWorkload: num(r.open_workload),
    escalated: num(r.escalated),
    avgResolutionHours: round1(r.avg_resolution_hours),
    slaCompliance: pct(num(r.resolved_on_time), num(r.resolved))
  }));

  // Performance ranking: most resolved first, then best SLA compliance, then lightest
  // current load.
  technicians.sort((a, b) =>
    b.resolved - a.resolved ||
    (b.slaCompliance ?? -1) - (a.slaCompliance ?? -1) ||
    a.openWorkload - b.openWorkload
  );
  technicians.forEach((t, i) => { t.rank = i + 1; });

  return { technicians };
}

/* -------------------------------------------------------------- asset dashboard */

async function assetDashboard() {
  // `total` is a straight COUNT of asset *rows* — the actual number of assets on the
  // ledger. (The old dashboard summed per-asset quantities, which is why a 54-row ledger
  // reported thousands.) Quantity sums are reported separately as *_units.
  const counts = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE assigned_employee IS NOT NULL AND TRIM(assigned_employee) <> '' AND assigned_employee <> 'Inventory')::int AS assigned,
       COUNT(*) FILTER (WHERE assigned_employee IS NULL OR TRIM(assigned_employee) = '' OR assigned_employee = 'Inventory')::int AS unassigned,
       COALESCE(SUM(total_quantity), 0)::int AS total_units,
       COALESCE(SUM(assigned_quantity), 0)::int AS assigned_units,
       COALESCE(SUM(available_quantity), 0)::int AS available_units,
       COUNT(*) FILTER (WHERE warranty_expiry IS NOT NULL AND warranty_expiry > CURRENT_DATE AND warranty_expiry <= CURRENT_DATE + INTERVAL '90 days')::int AS warranty_expiring,
       COUNT(*) FILTER (WHERE warranty_expiry IS NOT NULL AND warranty_expiry < CURRENT_DATE)::int AS warranty_expired,
       COUNT(*) FILTER (WHERE reorder_level > 0 AND available_quantity <= reorder_level)::int AS low_inventory
     FROM assets WHERE status <> 'Disposed'`
  );

  // Cast to text before COALESCE: category and status are enums (asset_category /
  // asset_status), and coalescing them with the text literal 'Unspecified' otherwise
  // fails with "invalid input value for enum ... Unspecified". ::text is a no-op for the
  // plain text columns (department, location).
  const groupBy = async (col) => {
    const { rows } = await db.query(
      `SELECT COALESCE(${col}::text, 'Unspecified') AS k, COUNT(*)::int AS c FROM assets WHERE status <> 'Disposed' GROUP BY 1 ORDER BY c DESC`
    );
    return rows.reduce((a, r) => { a[r.k] = r.c; return a; }, {});
  };
  const [byCategory, byDepartment, byLocation, byStatus] = await Promise.all([
    groupBy('category'), groupBy('department'), groupBy('location'), groupBy('status')
  ]);

  const amcExpiring = await db.query(
    `SELECT COUNT(*)::int AS c FROM amcs WHERE end_date > CURRENT_DATE AND end_date <= CURRENT_DATE + INTERVAL '90 days'`
  );

  // Most recently registered assets, for the "Recently Added" widget.
  const recent = await db.query(
    `SELECT id, name, category::text AS category, department, status::text AS status, created_at
     FROM assets ORDER BY created_at DESC NULLS LAST LIMIT 6`
  );

  // The specific items sitting at or below their reorder level, for the Low Inventory widget.
  const lowStock = await db.query(
    `SELECT id, name, category::text AS category, location, available_quantity, reorder_level
     FROM assets
     WHERE status <> 'Disposed' AND reorder_level > 0 AND available_quantity <= reorder_level
     ORDER BY available_quantity ASC LIMIT 8`
  );

  const c = counts.rows[0];
  return {
    counts: {
      total: c.total, assigned: c.assigned, unassigned: c.unassigned,
      totalUnits: c.total_units, assignedUnits: c.assigned_units, availableUnits: c.available_units,
      warrantyExpiring: c.warranty_expiring, warrantyExpired: c.warranty_expired,
      amcExpiring: amcExpiring.rows[0].c, lowInventory: c.low_inventory
    },
    byCategory, byDepartment, byLocation, byStatus,
    recentlyAdded: recent.rows.map((r) => ({
      id: r.id, name: r.name, category: r.category, department: r.department,
      status: r.status, createdAt: r.created_at
    })),
    lowStock: lowStock.rows.map((r) => ({
      id: r.id, name: r.name, category: r.category, location: r.location,
      availableQuantity: r.available_quantity, reorderLevel: r.reorder_level
    }))
  };
}

/* ------------------------------------------------------------------ routes */

function register(app, { requirePermission }) {
  const handler = (fn, usesQuery = true) => async (req, res) => {
    const user = await requirePermission(req, res, 'dashboard', 'view');
    if (!user) return;
    try {
      res.json(usesQuery ? await fn(user, req.query) : await fn());
    } catch (err) {
      console.error(`[dashboards] ${req.path} failed:`, err);
      res.status(500).json({ error: 'Could not build dashboard: ' + err.message });
    }
  };

  app.get('/api/dashboards/tickets', handler(ticketDashboard));
  app.get('/api/dashboards/sla', handler(slaDashboard));
  app.get('/api/dashboards/technicians', handler(technicianDashboard));
  app.get('/api/dashboards/assets', handler(() => assetDashboard(), false));
}

module.exports = { register, ticketDashboard, slaDashboard, technicianDashboard, assetDashboard };
