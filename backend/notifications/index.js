/**
 * Notification dispatcher.
 *
 * dispatch() resolves an event to its stakeholders, renders each channel's message,
 * and records one `notification_deliveries` row per (event, channel, recipient).
 * A unique index on that triple is what prevents duplicates: re-running the daily
 * job, or retrying a request, cannot notify the same person twice about the same
 * thing. Rows that lose the ON CONFLICT race were already handled, so they are
 * simply not queued.
 *
 * In-app notifications are written immediately; they are cheap and transactional.
 * Email and SMS are queued as 'Pending' and flushed afterwards, so a slow SMTP
 * server never holds an HTTP request (or a database transaction) open.
 *
 * Statuses: Pending -> Sent | Failed | Skipped.
 *   Skipped = channel disabled or unconfigured, or recipient has no address.
 *             Terminal, and never retried.
 *   Failed  = the send threw. Retried by retryFailed() up to MAX_ATTEMPTS.
 */

const db = require('../db');
const templates = require('./templates');
const emailChannel = require('./channels/email');
const smsChannel = require('./channels/sms');

const MAX_ATTEMPTS = 3;
const CHANNELS = { email: emailChannel, sms: smsChannel };

/* ------------------------------------------------------------------ settings */

let settingsCache = null;
let settingsCachedAt = 0;
const SETTINGS_TTL_MS = 30_000;

async function getSettings({ fresh = false } = {}) {
  if (!fresh && settingsCache && Date.now() - settingsCachedAt < SETTINGS_TTL_MS) {
    return settingsCache;
  }
  const { rows } = await db.query('SELECT * FROM notification_settings WHERE id = 1');
  settingsCache = rows[0] || {
    in_app_enabled: true, email_enabled: true, sms_enabled: false,
    warranty_reminder_days: 60, amc_reminder_days: 60, sla_warning_hours: 4
  };
  settingsCachedAt = Date.now();
  return settingsCache;
}

function invalidateSettingsCache() {
  settingsCache = null;
}

/** Channels the admin has switched on *and* that have a working provider. */
async function activeChannels() {
  const s = await getSettings();
  return {
    inApp: s.in_app_enabled,
    email: s.email_enabled,
    sms: s.sms_enabled && smsChannel.isConfigured
  };
}

/* ---------------------------------------------------------------- recipients */

const ADMIN_ROLES = ['Super Admin', 'IT Admin', 'Facility Admin'];

const activeUsers = async (where, params) => {
  const { rows } = await db.query(
    `SELECT id, name, username, email, phone_number, role, department
     FROM users
     WHERE status = 'Active' AND (${where})`,
    params
  );
  return rows;
};

const byIds = (ids) => {
  const clean = ids.filter((id) => id != null);
  return clean.length ? activeUsers('id = ANY($1::int[])', [clean]) : Promise.resolve([]);
};

// users.role is the `user_role` enum, so it must be cast before comparing to a
// text[] parameter — otherwise Postgres reports "operator does not exist".
const admins = () => activeUsers('role::text = ANY($1::text[])', [ADMIN_ROLES]);

const departmentAdmins = (department) =>
  activeUsers('role::text = ANY($1::text[]) AND department = $2', [ADMIN_ROLES, department]);

/** De-duplicates a recipient list by user id. */
const uniqueById = (users) => {
  const seen = new Map();
  for (const u of users) if (u && !seen.has(u.id)) seen.set(u.id, u);
  return [...seen.values()];
};

/**
 * Who cares about this event. Department admins are folded in with global admins so
 * a department with no admin of its own still reaches someone.
 */
async function resolveRecipients(eventType, ctx) {
  switch (eventType) {
    case 'ticket.created': {
      const [requester, deptAdmins, globalAdmins] = await Promise.all([
        byIds([ctx.createdBy]),
        ctx.department ? departmentAdmins(ctx.department) : [],
        admins()
      ]);
      return uniqueById([...requester, ...deptAdmins, ...globalAdmins]);
    }
    case 'ticket.assigned':
      return uniqueById(await byIds([ctx.assignedTo, ctx.createdBy]));

    case 'ticket.status_changed':
    case 'ticket.resolved':
    case 'ticket.closed':
      return uniqueById(await byIds([ctx.createdBy, ctx.assignedTo]));

    case 'ticket.sla_approaching':
      // Only the person who can act on it, plus their department leads.
      return uniqueById([
        ...(await byIds([ctx.assignedTo])),
        ...(ctx.department ? await departmentAdmins(ctx.department) : [])
      ]);

    // Breach and escalation happen in the same instant. Giving them disjoint
    // audiences means nobody receives two messages about one deadline: the people
    // working the ticket hear "breached", the people who must intervene hear
    // "escalated".
    case 'ticket.sla_breached':
      return uniqueById(await byIds([ctx.assignedTo, ctx.createdBy]));

    case 'ticket.escalated': {
      const [deptAdmins, globalAdmins] = await Promise.all([
        ctx.department ? departmentAdmins(ctx.department) : [],
        admins()
      ]);
      const escalationAudience = uniqueById([...deptAdmins, ...globalAdmins]);
      const alreadyTold = new Set([ctx.assignedTo, ctx.createdBy].filter(Boolean));
      return escalationAudience.filter((u) => !alreadyTold.has(u.id));
    }

    case 'asset.warranty_expiring': {
      const stakeholders = await admins();
      // The custodian, if the asset is currently assigned to a real user.
      const custodian = ctx.assignedEmployee
        ? await activeUsers('LOWER(TRIM(name)) = LOWER(TRIM($1))', [ctx.assignedEmployee])
        : [];
      return uniqueById([...stakeholders, ...custodian]);
    }

    case 'amc.expiring': {
      // Finance owns contract renewals, so they join the admins here.
      const stakeholders = await activeUsers(
        'role::text = ANY($1::text[])',
        [[...ADMIN_ROLES, 'Finance Team']]
      );
      return uniqueById(stakeholders);
    }

    default:
      return admins();
  }
}

/* ------------------------------------------------------------------ dispatch */

/**
 * Queues a notification for every stakeholder on every enabled channel.
 *
 * @param eventType one of templates.eventTypes
 * @param eventKey  stable identity for this occurrence, e.g. `warranty:AST-001:60`.
 *                  Reusing a key is how repeat notifications are suppressed.
 * @param ctx       template payload
 * @returns {{queued: number, deliveryIds: number[]}}
 */
async function dispatch(eventType, eventKey, ctx) {
  const message = templates.render(eventType, ctx);
  const recipients = await resolveRecipients(eventType, ctx);
  const enabled = await activeChannels();

  if (recipients.length === 0) {
    console.warn(`[notifications] ${eventType} (${eventKey}) has no active recipients`);
    return { queued: 0, deliveryIds: [] };
  }

  // Build every row first, then write them in one statement. Doing this per row cost
  // recipients x 3 sequential round trips — around 40 seconds for a 15-person
  // broadcast against a remote pooler, all while holding a connection.
  const rows = [];
  for (const user of recipients) {
    if (enabled.inApp) {
      rows.push({ channel: 'in_app', user, address: null, body: message.inApp, status: 'Sent', error: null, subject: null });
    }

    for (const [key, channel] of Object.entries(CHANNELS)) {
      const channelOn = key === 'email' ? enabled.email : enabled.sms;
      const address = channel.addressFor(user);
      const body = key === 'email' ? message.email : message.sms;

      // Record the skip rather than silently dropping it: the audit log should say
      // why someone was not contacted.
      if (!channelOn || !address) {
        rows.push({
          channel: key, user, address, body, status: 'Skipped', subject: message.subject,
          error: !channelOn ? 'Channel disabled or not configured' : `No ${key} address on file`
        });
      } else {
        rows.push({ channel: key, user, address, body, status: 'Pending', error: null, subject: message.subject });
      }
    }
  }

  const claimed = await claimMany(eventKey, eventType, rows);

  // Only rows that survived the unique index are new; the rest were already handled.
  const inAppClaims = claimed.filter((r) => r.channel === 'in_app');
  if (inAppClaims.length) {
    await insertInAppNotifications(eventKey, message, inAppClaims);
  }

  const deliveryIds = claimed.filter((r) => r.status === 'Pending').map((r) => r.id);
  return { queued: deliveryIds.length, deliveryIds };
}

/**
 * Inserts every delivery row in one multi-row statement. Rows rejected by the unique
 * index are simply not returned — that rejection *is* the duplicate guard.
 *
 * Placeholders take their type from the target column, so no casts are needed. Note
 * sent_at is computed in JS: reusing the status placeholder in a `CASE WHEN $n =
 * 'Sent'` makes Postgres deduce two types for one parameter and reject the statement.
 */
async function claimMany(eventKey, eventType, rows) {
  if (rows.length === 0) return [];

  const params = [];
  const tuples = rows.map((r) => {
    const values = [
      eventKey, eventType, r.channel, r.user?.id ?? null, r.user?.name ?? null,
      r.address ?? null, r.subject ?? null, r.body, r.status, r.error ?? null,
      r.status === 'Sent' ? new Date() : null
    ];
    const placeholders = values.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return `(${placeholders.join(',')})`;
  });

  const { rows: claimed } = await db.query(
    `INSERT INTO notification_deliveries
       (event_key, event_type, channel, recipient_user_id, recipient_name,
        recipient_address, subject, body, status, last_error, sent_at)
     VALUES ${tuples.join(',')}
     ON CONFLICT (event_key, channel, COALESCE(recipient_user_id, 0)) DO NOTHING
     RETURNING id, channel, status, recipient_user_id`,
    params
  );
  return claimed;
}

/** Mirrors newly-claimed in-app deliveries into the bell feed, again in one statement. */
async function insertInAppNotifications(eventKey, message, inAppClaims) {
  const params = [];
  const tuples = inAppClaims.map((c) => {
    const values = [`NTF-${c.id}`, message.inApp, message.type, c.recipient_user_id, eventKey];
    const placeholders = values.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return `(${placeholders[0]},${placeholders[1]},${placeholders[2]},'Just now',FALSE,${placeholders[3]},${placeholders[4]})`;
  });

  await db.query(
    `INSERT INTO notifications (id, text, type, time, read, user_id, event_key)
     VALUES ${tuples.join(',')}
     ON CONFLICT (id) DO NOTHING`,
    params
  );
}

/* --------------------------------------------------------------------- flush */

/**
 * Sends everything currently Pending. Safe to call without awaiting — failures are
 * captured on the delivery row, never thrown at the caller.
 */
async function flush(deliveryIds = null) {
  const { rows } = deliveryIds
    ? await db.query(
        `SELECT * FROM notification_deliveries WHERE id = ANY($1::int[]) AND status = 'Pending'`,
        [deliveryIds]
      )
    : await db.query(`SELECT * FROM notification_deliveries WHERE status = 'Pending' LIMIT 200`);

  for (const row of rows) await attempt(row);
  return rows.length;
}

async function attempt(row) {
  const channel = CHANNELS[row.channel];
  if (!channel) return;

  try {
    await channel.send({ to: row.recipient_address, subject: row.subject, body: row.body });

    // The Email Alerts Inbox reads this table, so mirror outgoing mail into it.
    // Even with a real SMTP server, this keeps the in-app inbox meaningful.
    if (row.channel === 'email') {
      await db.query(
        `INSERT INTO emails (id, sender, date, subject, body)
         VALUES ($1, 'AssetFlow Notifications', $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [`EML-${row.id}`, new Date().toLocaleString(), row.subject || '(no subject)', row.body]
      );
    }

    await db.query(
      `UPDATE notification_deliveries
       SET status = 'Sent', attempts = attempts + 1, sent_at = NOW(), last_error = NULL, updated_at = NOW()
       WHERE id = $1`,
      [row.id]
    );
  } catch (err) {
    const attempts = row.attempts + 1;
    console.error(`[notifications] ${row.channel} delivery ${row.id} failed (attempt ${attempts}): ${err.message}`);
    await db.query(
      `UPDATE notification_deliveries
       SET status = 'Failed', attempts = $2, last_error = $3, updated_at = NOW()
       WHERE id = $1`,
      [row.id, attempts, err.message]
    );
  }
}

/** Re-sends failed deliveries that have attempts left. Driven by cron. */
async function retryFailed() {
  const { rows } = await db.query(
    `SELECT * FROM notification_deliveries
     WHERE status = 'Failed' AND attempts < $1
     ORDER BY updated_at ASC
     LIMIT 100`,
    [MAX_ATTEMPTS]
  );
  for (const row of rows) await attempt(row);
  if (rows.length) console.log(`[notifications] retried ${rows.length} failed delivery(ies)`);
  return rows.length;
}

/**
 * Dispatch, then send in the background. The returned promise resolves once the
 * rows are queued — callers should not wait on delivery.
 */
async function notify(eventType, eventKey, ctx) {
  try {
    const { deliveryIds } = await dispatch(eventType, eventKey, ctx);
    if (deliveryIds.length) {
      flush(deliveryIds).catch((err) => console.error('[notifications] flush failed:', err));
    }
  } catch (err) {
    // A notification must never break the operation that triggered it.
    console.error(`[notifications] dispatch of ${eventType} (${eventKey}) failed:`, err);
  }
}

function channelStatus() {
  return {
    inApp: { configured: true, description: 'Always available' },
    email: { configured: emailChannel.isConfigured, description: emailChannel.describe() },
    sms: { configured: smsChannel.isConfigured, description: smsChannel.describe() }
  };
}

module.exports = {
  notify, dispatch, flush, retryFailed,
  getSettings, invalidateSettingsCache, channelStatus,
  MAX_ATTEMPTS
};
