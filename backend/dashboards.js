/**
 * Live dashboard aggregates. Every figure is computed from Convex on request — nothing is
 * cached or precomputed — so the dashboards always reflect current state. The aggregation
 * itself runs natively in Convex (backend/convex/dashboards.js); this module only resolves
 * the caller's department scope and forwards to the right Convex query.
 *
 * Four endpoints, one per dashboard in the spec:
 *   /api/dashboards/tickets      queue health, breakdowns, 30-day trend, averages
 *   /api/dashboards/sla          compliance %, breaches, escalations, averages
 *   /api/dashboards/technicians  per-agent load, throughput, SLA compliance, ranking
 *   /api/dashboards/assets       inventory summary, breakdowns, expiries
 *
 * Non-Super-Admins are scoped to their own department, matching the ticket queue.
 */

const { cq } = require('./convexApi');

// Resolve the effective ticket scope for a request: the requested department, else the
// user's own department (unless they are a Super Admin, who sees everything), plus an
// optional created_at range. Undefined keys are omitted so Convex treats them as "no filter".
function ticketScope(user, query) {
  const department = query.department || (user.role !== 'Super Admin' ? user.department : undefined);
  const scope = {};
  if (department) scope.department = department;
  if (query.from) scope.from = query.from;
  if (query.to) scope.to = query.to;
  return scope;
}

const ticketDashboard = (user, query) => cq('dashboards:tickets', ticketScope(user, query));
const slaDashboard = (user, query) => cq('dashboards:sla', ticketScope(user, query));
const technicianDashboard = (user, query) => cq('dashboards:technicians', ticketScope(user, query));
const assetDashboard = () => cq('dashboards:assets', {});

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
