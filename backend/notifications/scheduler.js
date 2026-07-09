/**
 * Scheduled lifecycle and SLA checks.
 *
 * Every event carries a stable event_key, so a job that runs twice in a day — or a
 * server that restarts mid-run — cannot notify anyone twice. The key embeds the
 * reminder threshold, so changing warranty_reminder_days from 60 to 30 legitimately
 * produces a fresh reminder rather than being suppressed by the old one.
 *
 * The reminder fires on the first run where the asset is *within* the window, not
 * on the exact day. A run missed because the server was down would otherwise skip
 * the reminder permanently.
 */

const db = require('./../db');
const { notify, getSettings } = require('./index');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

const daysUntil = (date) => Math.ceil((new Date(date) - Date.now()) / MS_PER_DAY);
const hoursUntil = (date) => Math.ceil((new Date(date) - Date.now()) / MS_PER_HOUR);

/* ------------------------------------------------------- warranty expiry */

async function checkWarrantyExpiries() {
  const { warranty_reminder_days: window } = await getSettings();

  const { rows } = await db.query(
    `SELECT id, name, serial_number, warranty_expiry, assigned_employee, department
     FROM assets
     WHERE warranty_expiry IS NOT NULL
       AND status <> 'Disposed'
       AND warranty_expiry > CURRENT_DATE
       AND warranty_expiry <= CURRENT_DATE + ($1 || ' days')::interval`,
    [window]
  );

  for (const asset of rows) {
    await notify('asset.warranty_expiring', `warranty:${asset.id}:${window}`, {
      assetId: asset.id,
      assetName: asset.name,
      serialNumber: asset.serial_number,
      expiryDate: asset.warranty_expiry,
      daysRemaining: daysUntil(asset.warranty_expiry),
      assignedEmployee: asset.assigned_employee,
      department: asset.department
    });
  }
  return rows.length;
}

/* ------------------------------------------------------------ AMC expiry */

async function checkAmcExpiries() {
  const { amc_reminder_days: window } = await getSettings();

  const { rows } = await db.query(
    `SELECT m.id, m.vendor, m.end_date,
            COUNT(a.id)::int AS asset_count,
            COALESCE(STRING_AGG(a.id, ', ' ORDER BY a.id), '') AS asset_summary
     FROM amcs m
     LEFT JOIN assets a ON a.amc_id = m.id
     WHERE m.end_date > CURRENT_DATE
       AND m.end_date <= CURRENT_DATE + ($1 || ' days')::interval
     GROUP BY m.id, m.vendor, m.end_date`,
    [window]
  );

  for (const amc of rows) {
    await notify('amc.expiring', `amc:${amc.id}:${window}`, {
      amcId: amc.id,
      vendor: amc.vendor,
      expiryDate: amc.end_date,
      daysRemaining: daysUntil(amc.end_date),
      assetCount: amc.asset_count,
      assetSummary: amc.asset_summary
    });
  }
  return rows.length;
}

/* ------------------------------------------------------------------ SLA */

const OPEN_STATUSES = ['Resolved', 'Closed'];

async function checkSlaApproaching() {
  const { sla_warning_hours: warnHours } = await getSettings();

  const { rows } = await db.query(
    `SELECT id, ticket_id, subject, department, priority, assigned_to, assigned_to_name,
            created_by, sla_deadline
     FROM tickets
     WHERE status <> ALL($1::text[])
       AND sla_deadline > NOW()
       AND sla_deadline <= NOW() + ($2 || ' hours')::interval`,
    [OPEN_STATUSES, warnHours]
  );

  for (const t of rows) {
    await notify('ticket.sla_approaching', `sla-approaching:${t.id}:${warnHours}`, {
      ticketId: t.ticket_id,
      subject: t.subject,
      department: t.department,
      priority: t.priority,
      assignedTo: t.assigned_to,
      assignedToName: t.assigned_to_name,
      createdBy: t.created_by,
      slaDeadline: t.sla_deadline,
      hoursRemaining: Math.max(0, hoursUntil(t.sla_deadline))
    });
  }
  return rows.length;
}

/**
 * Breach + auto-escalation. Both derive from the same row, and the escalation flag
 * is flipped in the same transaction as the timeline entry so a crash between them
 * cannot leave a ticket marked escalated with no audit record.
 */
async function checkSlaBreaches() {
  const { rows } = await db.query(
    `SELECT id, ticket_id, subject, department, priority, assigned_to, assigned_to_name,
            created_by, sla_deadline, escalated
     FROM tickets
     WHERE status <> ALL($1::text[])
       AND sla_deadline < NOW()`,
    [OPEN_STATUSES]
  );

  let escalatedCount = 0;

  for (const t of rows) {
    const hoursOverdue = Math.max(1, Math.abs(hoursUntil(t.sla_deadline)));
    const ctx = {
      ticketId: t.ticket_id,
      subject: t.subject,
      department: t.department,
      priority: t.priority,
      assignedTo: t.assigned_to,
      assignedToName: t.assigned_to_name,
      createdBy: t.created_by,
      slaDeadline: t.sla_deadline,
      hoursOverdue
    };

    // The people working the ticket.
    await notify('ticket.sla_breached', `sla-breached:${t.id}`, ctx);

    if (t.escalated) continue;

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      // Guard on escalated = FALSE so two overlapping runs cannot both escalate.
      const claimed = await client.query(
        `UPDATE tickets SET escalated = TRUE, escalated_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND escalated = FALSE
         RETURNING id`,
        [t.id]
      );
      if (claimed.rowCount === 0) {
        await client.query('ROLLBACK');
        continue;
      }
      await client.query(
        `INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
         VALUES ($1, 'System', 'Escalated', $2)`,
        [t.id, `SLA breached ${hoursOverdue} hour(s) ago. Escalated to administrators.`]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[notifications] could not escalate ticket ${t.ticket_id}:`, err.message);
      client.release();
      continue;
    }
    client.release();

    escalatedCount++;
    // The people who must intervene.
    await notify('ticket.escalated', `escalated:${t.id}`, ctx);
  }

  return { breached: rows.length, escalated: escalatedCount };
}

/* ------------------------------------------------------------- entry points */

async function runDailyChecks() {
  console.log('[notifications] running daily lifecycle checks...');
  try {
    const warranties = await checkWarrantyExpiries();
    const amcs = await checkAmcExpiries();
    console.log(`[notifications] daily checks: ${warranties} warranty, ${amcs} AMC reminder(s) evaluated`);
  } catch (err) {
    console.error('[notifications] daily checks failed:', err);
  }
}

async function runSlaChecks() {
  try {
    const approaching = await checkSlaApproaching();
    const { breached, escalated } = await checkSlaBreaches();
    if (approaching || breached || escalated) {
      console.log(`[notifications] SLA: ${approaching} approaching, ${breached} breached, ${escalated} newly escalated`);
    }
  } catch (err) {
    console.error('[notifications] SLA checks failed:', err);
  }
}

module.exports = {
  runDailyChecks,
  runSlaChecks,
  checkWarrantyExpiries,
  checkAmcExpiries,
  checkSlaApproaching,
  checkSlaBreaches
};
