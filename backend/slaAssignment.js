/**
 * Technician auto-assignment. A policy can nominate a strategy; this module turns that
 * into a concrete agent:
 *
 *   least_loaded  — the eligible agent with the fewest open tickets (ties broken by id).
 *   round_robin   — the eligible agent who was least-recently handed a ticket, which
 *                   spreads new work evenly without needing a stored pointer.
 *
 * "Eligible" means an active, non-Employee user, preferring those in the ticket's
 * department and falling back to the whole pool if the department has no agent.
 *
 * Reads users + tickets from Convex. Agents are keyed by workos_user_id — the same handle
 * manual assignment and the dashboards use — so an auto-assigned ticket's assigned_to is
 * consistent with everything else (the old code keyed on the numeric users.id).
 */

const { cq } = require('./convexApi');

const ACTIVE_TICKET_STATUSES = ['Open', 'In Progress', 'Pending', 'On Hold', 'Reopened'];

async function eligibleAgents(department) {
  const users = await cq('users:list', {});
  const agents = users
    .filter((u) => u.status === 'Active' && String(u.role) !== 'Employee')
    .map((u) => ({ id: u.workos_user_id, name: u.name, department: u.department, role: u.role }));
  const inDept = agents.filter((a) => a.department === department);
  return inDept.length ? inDept : agents;
}

function workloadOf(agentIds, tickets) {
  const set = new Set(agentIds);
  const map = {};
  for (const id of agentIds) map[id] = 0;
  for (const t of tickets) {
    if (set.has(t.assigned_to) && ACTIVE_TICKET_STATUSES.includes(t.status)) map[t.assigned_to]++;
  }
  return map;
}

/**
 * Choose an agent for a ticket, or null if none are eligible. Returns the agent row
 * augmented with `workload` (open-ticket count) for logging.
 */
async function pickAgent(ticket, strategy = 'least_loaded') {
  const agents = await eligibleAgents(ticket.department);
  if (!agents.length) return null;
  const ids = agents.map((a) => a.id);
  const tickets = await cq('generic:list', { table: 'tickets' });
  const load = workloadOf(ids, tickets);

  if (strategy === 'round_robin') {
    const lastAssigned = {};
    for (const t of tickets) {
      if (ids.includes(t.assigned_to) && t.created_at) {
        const ts = new Date(t.created_at).getTime();
        if (!(t.assigned_to in lastAssigned) || ts > lastAssigned[t.assigned_to]) lastAssigned[t.assigned_to] = ts;
      }
    }
    // Never-assigned agents (undefined -> 0) sort first, then oldest assignment.
    agents.sort((a, b) => (lastAssigned[a.id] || 0) - (lastAssigned[b.id] || 0) || String(a.id).localeCompare(String(b.id)));
  } else {
    agents.sort((a, b) => load[a.id] - load[b.id] || String(a.id).localeCompare(String(b.id)));
  }

  const chosen = agents[0];
  return { ...chosen, workload: load[chosen.id] || 0 };
}

module.exports = { pickAgent, eligibleAgents, workloadOf, ACTIVE_TICKET_STATUSES };
