/**
 * Database bridge for the SLA engine. slaEngine.js is pure; this module loads policies,
 * calendars and holidays from Convex and feeds them in, and exposes the couple of
 * operations the server needs: pick a ticket's policy + deadlines, and resolve which
 * business calendar applies.
 *
 * Reads go through Convex (generic:list / generic:get) over the mirrored snake_case tables,
 * so the SLA engine no longer depends on PGlite.
 */

const { cq } = require('./convexApi');
const engine = require('./slaEngine');

// holiday_date is mirrored as an ISO timestamp or a YYYY-MM-DD string; normalise to YMD.
const toYMD = (d) => (d == null ? null : new Date(d).toISOString().slice(0, 10));

/* ------------------------------------------------------------------ calendars */

/** A calendar row plus its holiday date strings, shaped for the engine. */
async function getCalendarWithHolidays(calendarId) {
  if (!calendarId) return await getDefaultCalendar();
  const cal = await cq('generic:get', { table: 'business_calendars', idField: 'id', idVal: calendarId });
  if (!cal) return await getDefaultCalendar();
  return attachHolidays(cal);
}

async function getDefaultCalendar() {
  const cals = (await cq('generic:list', { table: 'business_calendars' }))
    .filter((c) => c.active === true)
    .sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) || Number(a.id) - Number(b.id));
  // No calendar configured at all: the engine's normalizeCalendar defaults (Mon–Fri,
  // 09:00–18:00, +05:30) still produce sane deadlines.
  if (!cals.length) return { is_24x7: false, working_days: [1, 2, 3, 4, 5], holidays: [] };
  return attachHolidays(cals[0]);
}

async function attachHolidays(calendar) {
  const holidays = (await cq('generic:list', { table: 'calendar_holidays' }))
    .filter((h) => h.calendar_id === calendar.id)
    .map((h) => toYMD(h.holiday_date))
    .filter(Boolean);
  return { ...calendar, holidays };
}

/* ------------------------------------------------------------------ policies */

async function loadActivePolicies() {
  return (await cq('generic:list', { table: 'sla_policies' })).filter((p) => p.active === true && p.archived === false);
}

async function loadEscalationLevels(policyId) {
  return (await cq('generic:list', { table: 'sla_escalation_levels' }))
    .filter((l) => l.policy_id === policyId)
    .sort((a, b) => Number(a.level) - Number(b.level));
}

/* ------------------------------------------------ deadline computation */

/**
 * Match a ticket to a policy and compute its first-response and resolution deadlines
 * against that policy's business calendar. Returns nulls-safe defaults when no policy
 * applies, so ticket creation never fails for want of an SLA.
 *
 * @param ticket   { priority, category, department, assetType, branch }
 * @param createdAt Date the clock starts from (defaults to now)
 */
async function computeDeadlines(ticket, createdAt = new Date()) {
  const policies = await loadActivePolicies();
  const policy = engine.matchPolicy(policies, ticket);

  if (!policy) {
    // Nothing matched — fall back to a plain 24h wall-clock resolution so the ticket
    // still carries a deadline, and flag that no policy governs it.
    const resolutionDue = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
    return { policy: null, policyId: null, calendarId: null, firstResponseDue: null, resolutionDue };
  }

  const calendar = await getCalendarWithHolidays(policy.calendar_id);
  const firstResponseDue = engine.addBusinessMinutes(createdAt, policy.first_response_minutes, calendar);
  const resolutionDue = engine.addBusinessMinutes(createdAt, policy.resolution_minutes, calendar);

  return { policy, policyId: policy.id, calendarId: policy.calendar_id, firstResponseDue, resolutionDue, calendar };
}

module.exports = {
  getCalendarWithHolidays,
  getDefaultCalendar,
  attachHolidays,
  loadActivePolicies,
  loadEscalationLevels,
  computeDeadlines
};
