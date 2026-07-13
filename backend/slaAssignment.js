/**
 * Technician auto-assignment. A policy can nominate a strategy; this module turns that
 * into a concrete agent:
 *
 *   least_loaded  — the eligible agent with the fewest open tickets (ties broken by id).
 *   round_robin   — the eligible agent who was least-recently handed a ticket, which
 *                   spreads new work evenly without needing a stored pointer.
 *
 * "Eligible" means an active, non-Employee user, preferring those in the ticket's
 * department and falling back to the whole pool if the department has no agent — the
 * same rule the assignee picker uses in the UI.
 */

const db = require('./db');

const ACTIVE_TICKET_STATUSES = ['Open', 'In Progress', 'Pending', 'On Hold', 'Reopened'];

async function eligibleAgents(department, client = db) {
  const { rows } = await client.query(
    `SELECT id, name, department, role::text AS role
     FROM users
     WHERE status = 'Active' AND role::text <> 'Employee'`
  );
  const inDept = rows.filter((a) => a.department === department);
  return inDept.length ? inDept : rows;
}

async function workloadOf(agentIds, client = db) {
  const map = {};
  for (const id of agentIds) map[id] = 0;
  if (!agentIds.length) return map;
  const { rows } = await client.query(
    `SELECT assigned_to, COUNT(*)::int AS c
     FROM tickets
     WHERE assigned_to = ANY($1::int[]) AND status = ANY($2::text[])
     GROUP BY assigned_to`,
    [agentIds, ACTIVE_TICKET_STATUSES]
  );
  for (const r of rows) map[r.assigned_to] = r.c;
  return map;
}

/**
 * Choose an agent for a ticket, or null if none are eligible. Returns the agent row
 * augmented with `workload` (open-ticket count) for logging.
 */
async function pickAgent(ticket, strategy = 'least_loaded', client = db) {
  const agents = await eligibleAgents(ticket.department, client);
  if (!agents.length) return null;
  const ids = agents.map((a) => a.id);
  const load = await workloadOf(ids, client);

  if (strategy === 'round_robin') {
    const { rows } = await client.query(
      `SELECT assigned_to, MAX(created_at) AS last
       FROM tickets WHERE assigned_to = ANY($1::int[]) GROUP BY assigned_to`,
      [ids]
    );
    const lastAssigned = {};
    for (const r of rows) lastAssigned[r.assigned_to] = new Date(r.last).getTime();
    // Never-assigned agents (undefined -> 0) sort first, then oldest assignment.
    agents.sort((a, b) => (lastAssigned[a.id] || 0) - (lastAssigned[b.id] || 0) || a.id - b.id);
  } else {
    agents.sort((a, b) => load[a.id] - load[b.id] || a.id - b.id);
  }

  const chosen = agents[0];
  return { ...chosen, workload: load[chosen.id] || 0 };
}

module.exports = { pickAgent, eligibleAgents, workloadOf, ACTIVE_TICKET_STATUSES };
