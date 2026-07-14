/**
 * Scheduled lifecycle and SLA checks.
 *
 * Every event carries a stable event_key, so a job that runs twice in a day — or a server
 * that restarts mid-run — cannot notify anyone twice. The key embeds the reminder
 * threshold, so changing a reminder window legitimately produces a fresh reminder rather
 * than being suppressed by the old one.
 *
 * Backed by native Convex: reads pull whole tables via generic:list and filter in JS
 * (mirroring the old SQL predicates); the ticket-escalation writes are atomic mutations
 * (tickets:escalateOnBreach / escalateLadder).
 */

const { cq, cm } = require('../convexApi');
const { notify, getSettings } = require('./index');
const slaEngine = require('../slaEngine');
const slaModel = require('../slaModel');

const TARGET_LABELS = {
  assignee: 'Assigned Technician', team_lead: 'Team Lead',
  department_manager: 'Department Manager', it_admin: 'IT Administrator', super_admin: 'Super Admin'
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

const daysUntil = (date) => Math.ceil((new Date(date) - Date.now()) / MS_PER_DAY);
const hoursUntil = (date) => Math.ceil((new Date(date) - Date.now()) / MS_PER_HOUR);

const todayUTC = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
const plusDays = (d, n) => new Date(d.getTime() + n * MS_PER_DAY);
const fetchAll = (table) => cq('generic:list', { table });

/* ------------------------------------------------------- warranty expiry */

async function checkWarrantyExpiries() {
  const { warranty_reminder_days: window } = await getSettings();
  const today = todayUTC(), end = plusDays(today, Number(window));
  const rows = (await fetchAll('assets')).filter((a) =>
    a.warranty_expiry && a.status !== 'Disposed' &&
    new Date(a.warranty_expiry) > today && new Date(a.warranty_expiry) <= end
  );
  for (const asset of rows) {
    await notify('asset.warranty_expiring', `warranty:${asset.id}:${window}`, {
      assetId: asset.id, assetName: asset.name, serialNumber: asset.serial_number,
      expiryDate: asset.warranty_expiry, daysRemaining: daysUntil(asset.warranty_expiry),
      assignedEmployee: asset.assigned_employee, department: asset.department
    });
  }
  return rows.length;
}

/* ------------------------------------------------------------ AMC expiry */

async function checkAmcExpiries() {
  const { amc_reminder_days: window } = await getSettings();
  const today = todayUTC(), end = plusDays(today, Number(window));
  const [amcs, assets] = await Promise.all([fetchAll('amcs'), fetchAll('assets')]);
  const rows = amcs.filter((m) => m.end_date && new Date(m.end_date) > today && new Date(m.end_date) <= end);
  for (const amc of rows) {
    const its = assets.filter((a) => a.amc_id === amc.id).map((a) => a.id).sort((x, y) => String(x).localeCompare(String(y)));
    await notify('amc.expiring', `amc:${amc.id}:${window}`, {
      amcId: amc.id, vendor: amc.vendor, expiryDate: amc.end_date, daysRemaining: daysUntil(amc.end_date),
      assetCount: its.length, assetSummary: its.join(', ')
    });
  }
  return rows.length;
}

/* --------------------------------------------------- AMC service due */

const SCHEDULE_DAYS = {
  weekly: 7, 'bi-weekly': 14, fortnightly: 14, monthly: 30, 'bi-monthly': 60,
  quarterly: 90, 'half-yearly': 180, 'semi-annual': 180, 'semi-annually': 180,
  yearly: 365, annual: 365, annually: 365
};
const scheduleDays = (label) => SCHEDULE_DAYS[String(label || '').trim().toLowerCase()] || null;

async function checkServiceDue() {
  const { service_due_reminder_days: window } = await getSettings();
  const today = todayUTC();
  const [amcs, assets] = await Promise.all([fetchAll('amcs'), fetchAll('assets')]);
  const active = amcs.filter((m) => m.end_date && new Date(m.end_date) >= today);

  let evaluated = 0;
  for (const amc of active) {
    const cadence = scheduleDays(amc.service_schedule);
    if (!cadence) continue;

    const history = Array.isArray(amc.service_history) ? amc.service_history : [];
    const lastServiceMs = history
      .map((h) => new Date(h && h.date).getTime())
      .filter((t) => !Number.isNaN(t))
      .reduce((max, t) => Math.max(max, t), 0);
    const baseMs = lastServiceMs || new Date(amc.start_date).getTime();
    if (Number.isNaN(baseMs)) continue;

    const dueMs = baseMs + cadence * MS_PER_DAY;
    const daysRemaining = Math.ceil((dueMs - Date.now()) / MS_PER_DAY);
    if (daysRemaining > Number(window)) continue;

    const dueDate = new Date(dueMs).toISOString().split('T')[0];
    const assetCount = assets.filter((a) => a.amc_id === amc.id).length;
    evaluated++;
    await notify('asset.service_due', `service-due:${amc.id}:${dueDate}`, {
      amcId: amc.id, vendor: amc.vendor, schedule: amc.service_schedule, dueDate, daysRemaining, assetCount
    });
  }
  return evaluated;
}

/* ----------------------------------------------------- pending payments */

async function checkPendingPayments() {
  const { invoice_pending_grace_days: grace } = await getSettings();
  const today = todayUTC(), cutoff = plusDays(today, -Number(grace));
  const rows = (await fetchAll('invoices')).filter((inv) =>
    ['Pending', 'Partially Paid', 'Overdue'].includes(inv.payment_status) &&
    inv.date && new Date(inv.date) <= cutoff
  );
  for (const inv of rows) {
    const ageDays = Math.floor((today - new Date(inv.date)) / MS_PER_DAY);
    await notify('finance.payment_pending', `payment-pending:${inv.id}`, {
      invoiceId: inv.id, vendor: inv.vendor, amount: inv.amount, status: inv.payment_status, date: inv.date, ageDays
    });
  }
  return rows.length;
}

/* -------------------------------------------------------- returns due */

async function checkReturnsDue() {
  const { return_due_reminder_days: window } = await getSettings();
  const end = plusDays(todayUTC(), Number(window));
  const [assignments, assets] = await Promise.all([fetchAll('asset_assignments'), fetchAll('assets')]);
  const amap = new Map(assets.map((a) => [a.id, a]));
  const rows = assignments.filter((ag) =>
    ag.status === 'Assigned' && ag.expected_return_date && new Date(ag.expected_return_date) <= end
  );
  for (const r of rows) {
    await notify('asset.return_due', `return-due:${r.id}:${window}`, {
      assignmentId: r.id, assetId: r.asset_id, assetName: amap.get(r.asset_id)?.name || r.asset_id,
      employeeName: r.employee_name, department: r.department,
      dueDate: r.expected_return_date, daysRemaining: daysUntil(r.expected_return_date)
    });
  }
  return rows.length;
}

/* ------------------------------------------------------- low inventory */

async function checkLowInventory() {
  const rows = (await fetchAll('assets')).filter((a) =>
    a.status !== 'Disposed' && Number(a.reorder_level) > 0 && Number(a.available_quantity) <= Number(a.reorder_level)
  );
  for (const a of rows) {
    await notify('asset.low_inventory', `low-inventory:${a.id}:${a.available_quantity}`, {
      assetId: a.id, assetName: a.name, category: a.category, location: a.location,
      availableQuantity: a.available_quantity, reorderLevel: a.reorder_level
    });
  }
  return rows.length;
}

/* ------------------------------------------------------------------ SLA */

const CLOSED = ['Resolved', 'Closed'];

async function checkSlaApproaching() {
  const { sla_warning_hours: warnHours } = await getSettings();
  const now = Date.now(), end = now + Number(warnHours) * MS_PER_HOUR;
  const rows = (await fetchAll('tickets')).filter((t) =>
    !CLOSED.includes(t.status) && t.sla_deadline &&
    new Date(t.sla_deadline).getTime() > now && new Date(t.sla_deadline).getTime() <= end
  );
  for (const t of rows) {
    await notify('ticket.sla_approaching', `sla-approaching:${t.id}:${warnHours}`, {
      ticketId: t.ticket_id, subject: t.subject, department: t.department, priority: t.priority,
      assignedTo: t.assigned_to, assignedToName: t.assigned_to_name, createdBy: t.created_by,
      slaDeadline: t.sla_deadline, hoursRemaining: Math.max(0, hoursUntil(t.sla_deadline))
    });
  }
  return rows.length;
}

async function checkSlaBreaches() {
  const now = Date.now();
  const rows = (await fetchAll('tickets')).filter((t) =>
    !CLOSED.includes(t.status) && t.sla_deadline && new Date(t.sla_deadline).getTime() < now
  );
  let escalatedCount = 0;

  for (const t of rows) {
    const hoursOverdue = Math.max(1, Math.abs(hoursUntil(t.sla_deadline)));
    const ctx = {
      ticketId: t.ticket_id, subject: t.subject, department: t.department, priority: t.priority,
      assignedTo: t.assigned_to, assignedToName: t.assigned_to_name, createdBy: t.created_by,
      slaDeadline: t.sla_deadline, hoursOverdue
    };
    await notify('ticket.sla_breached', `sla-breached:${t.id}`, ctx);

    // Policy-governed tickets escalate through their ladder (checkSlaEscalations); only
    // unpoliced tickets fall back to this single-level escalate-to-admins behaviour.
    if (t.sla_policy_id) continue;
    if (t.escalated) continue;

    const { claimed } = await cm('tickets:escalateOnBreach', {
      ticketId: t.id, detail: `SLA breached ${hoursOverdue} hour(s) ago. Escalated to administrators.`
    });
    if (!claimed) continue;

    escalatedCount++;
    await notify('ticket.escalated', `escalated:${t.id}`, ctx);
  }
  return { breached: rows.length, escalated: escalatedCount };
}

async function checkSlaEscalations() {
  const tickets = (await fetchAll('tickets')).filter((t) => !CLOSED.includes(t.status) && t.sla_policy_id != null);
  if (!tickets.length) return { escalated: 0 };

  const policyIds = [...new Set(tickets.map((t) => t.sla_policy_id))];
  const [allLevels, allPolicies] = await Promise.all([fetchAll('sla_escalation_levels'), fetchAll('sla_policies')]);
  const levelsByPolicy = {};
  for (const l of allLevels.filter((l) => policyIds.includes(l.policy_id)).sort((a, b) => Number(a.level) - Number(b.level))) {
    (levelsByPolicy[l.policy_id] ||= []).push(l);
  }
  const calByPolicy = {};
  for (const p of allPolicies.filter((p) => policyIds.includes(p.id))) {
    calByPolicy[p.id] = await slaModel.getCalendarWithHolidays(p.calendar_id);
  }

  let escalatedCount = 0;
  for (const t of tickets) {
    const levels = levelsByPolicy[t.sla_policy_id];
    if (!levels || !levels.length) continue;

    const due = slaEngine.dueEscalations(levels, {
      now: new Date(), createdAt: t.created_at, firstResponseDue: t.first_response_due,
      resolutionDue: t.resolution_due, firstResponseAt: t.first_response_at, calendar: calByPolicy[t.sla_policy_id]
    });
    if (!due.length) continue;

    const maxDueLevel = due[due.length - 1].level;
    const currentLevel = Number(t.escalation_level || 0);
    if (maxDueLevel <= currentLevel) continue;

    // Only newly crossed levels get a timeline entry + notification.
    const crossed = due.filter((lvl) => lvl.level > currentLevel);
    const entries = crossed.map((lvl) => ({
      detail: `Escalation level ${lvl.level}: notified ${TARGET_LABELS[lvl.notify_target] || lvl.notify_target}`
    }));

    const { claimed } = await cm('tickets:escalateLadder', { ticketId: t.id, maxLevel: maxDueLevel, entries });
    if (!claimed) continue;

    for (const lvl of crossed) {
      await notify('ticket.escalation_level', `escalation:${t.id}:${lvl.level}`, {
        ticketId: t.ticket_id, subject: t.subject, department: t.department, priority: t.priority,
        assignedTo: t.assigned_to, assignedToName: t.assigned_to_name, createdBy: t.created_by,
        resolutionDue: t.resolution_due, level: lvl.level, target: lvl.notify_target,
        targetLabel: TARGET_LABELS[lvl.notify_target] || lvl.notify_target
      });
    }
    escalatedCount++;
  }
  return { escalated: escalatedCount };
}

/* ------------------------------------------------------------- entry points */

async function runDailyChecks() {
  console.log('[notifications] running daily lifecycle checks...');
  try {
    const results = await Promise.allSettled([
      checkWarrantyExpiries(), checkAmcExpiries(), checkServiceDue(),
      checkPendingPayments(), checkReturnsDue(), checkLowInventory()
    ]);
    const labels = ['warranty', 'AMC expiry', 'service due', 'pending payment', 'returns due', 'low inventory'];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') console.log(`[notifications] ${labels[i]}: ${r.value} reminder(s) evaluated`);
      else console.error(`[notifications] ${labels[i]} check failed:`, r.reason);
    });
  } catch (err) {
    console.error('[notifications] daily checks failed:', err);
  }
}

async function runSlaChecks() {
  try {
    const approaching = await checkSlaApproaching();
    const { breached, escalated } = await checkSlaBreaches();
    const { escalated: laddered } = await checkSlaEscalations();
    if (approaching || breached || escalated || laddered) {
      console.log(`[notifications] SLA: ${approaching} approaching, ${breached} breached, ${escalated + laddered} newly escalated`);
    }
  } catch (err) {
    console.error('[notifications] SLA checks failed:', err);
  }
}

module.exports = {
  runDailyChecks, runSlaChecks,
  checkWarrantyExpiries, checkAmcExpiries, checkServiceDue, checkPendingPayments,
  checkReturnsDue, checkLowInventory, checkSlaApproaching, checkSlaBreaches, checkSlaEscalations
};
