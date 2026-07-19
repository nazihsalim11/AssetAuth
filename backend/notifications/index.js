/**
 * Notification dispatcher.
 *
 * dispatch() resolves an event to its stakeholders, renders each channel's message, and
 * records one `notification_deliveries` row per (event, channel, recipient). The claim
 * mutation dedups on (event_key, channel, recipient_user_id): re-running the daily job, or
 * retrying a request, cannot notify the same person twice about the same thing.
 *
 * In-app notifications are written immediately; email/SMS are queued 'Pending' and flushed
 * afterwards, so a slow SMTP server never holds an HTTP request open.
 *
 * Statuses: Pending -> Sent | Failed | Skipped.
 *   Skipped = channel disabled/unconfigured, or recipient has no address. Terminal.
 *   Failed  = the send threw. Retried by retryFailed() up to MAX_ATTEMPTS.
 *
 * Backed by native Convex (backend/convex/notifications.js). Recipients are keyed by
 * workos_user_id throughout.
 */

const { cq, cm } = require('../convexApi');
const templates = require('./templates');
const emailChannel = require('./channels/email');
const smsChannel = require('./channels/sms');
const policy = require('../notificationPolicy');

const MAX_ATTEMPTS = 3;
const CHANNELS = { email: emailChannel, sms: smsChannel };
const ADMIN_ROLES = ['Super Admin', 'IT Admin', 'Facility Admin'];

/* ------------------------------------------------------------------ settings */

let settingsCache = null;
let settingsCachedAt = 0;
const SETTINGS_TTL_MS = 30_000;

async function getSettings({ fresh = false } = {}) {
  if (!fresh && settingsCache && Date.now() - settingsCachedAt < SETTINGS_TTL_MS) {
    return settingsCache;
  }
  const row = await cq('notifications:settingsGet', {});
  settingsCache = row || {
    in_app_enabled: true, email_enabled: true, sms_enabled: false,
    warranty_reminder_days: 60, amc_reminder_days: 60, sla_warning_hours: 4
  };
  settingsCachedAt = Date.now();
  return settingsCache;
}

function invalidateSettingsCache() {
  settingsCache = null;
  prefsCache = null;
  recipientsCache = null;
}

/* -------------------------------------------------- per-event preferences */

let prefsCache = null;
let recipientsCache = null;
let prefsCachedAt = 0;

async function getPolicy({ fresh = false } = {}) {
  if (!fresh && prefsCache && Date.now() - prefsCachedAt < SETTINGS_TTL_MS) {
    return { prefsByEvent: prefsCache, recipientRows: recipientsCache };
  }
  const { preferences, recipients } = await cq('notifications:policyData', {});
  prefsCache = policy.indexPreferences(preferences);
  recipientsCache = recipients;
  prefsCachedAt = Date.now();
  return { prefsByEvent: prefsCache, recipientRows: recipientsCache };
}

function invalidatePolicyCache() {
  prefsCache = null;
  recipientsCache = null;
}

/** Every active user (id = workos_user_id), for resolving roles/ids to people. */
const allActiveUsers = () => cq('notifications:usersActive', {});

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

// JS filters over the active-user list (fetched once per dispatch).
const byIds = (users, ids) => {
  const set = new Set(ids.filter((x) => x != null).map(String));
  return users.filter((u) => set.has(String(u.id)));
};
const byRole = (users, role) => users.filter((u) => String(u.role) === role);
const byRoles = (users, roles) => users.filter((u) => roles.includes(String(u.role)));
const admins = (users) => byRoles(users, ADMIN_ROLES);
const departmentAdmins = (users, department) => users.filter((u) => ADMIN_ROLES.includes(String(u.role)) && u.department === department);
const byName = (users, name) => {
  const n = String(name || '').trim().toLowerCase();
  return users.filter((u) => String(u.name || '').trim().toLowerCase() === n);
};

/** De-duplicates a recipient list by id. */
const uniqueById = (users) => {
  const seen = new Map();
  for (const u of users) if (u && !seen.has(u.id)) seen.set(u.id, u);
  return [...seen.values()];
};

/**
 * Who cares about this event. Department admins are folded in with global admins so a
 * department with no admin of its own still reaches someone.
 */
function resolveRecipients(eventType, ctx, users) {
  switch (eventType) {
    case 'ticket.created':
      return uniqueById([
        ...byIds(users, [ctx.createdBy]),
        ...(ctx.department ? departmentAdmins(users, ctx.department) : []),
        ...admins(users)
      ]);
    case 'ticket.assigned':
      return uniqueById(byIds(users, [ctx.assignedTo, ctx.createdBy]));
    case 'ticket.reassigned':
      return uniqueById(byIds(users, [ctx.assignedTo, ctx.previousAssignee, ctx.createdBy]));

    case 'ticket.escalation_level': {
      switch (ctx.target) {
        case 'assignee':
          return uniqueById(byIds(users, [ctx.assignedTo]));
        case 'team_lead':
        case 'department_manager': {
          const managers = ctx.department
            ? users.filter((u) => String(u.role) === 'Manager' && u.department === ctx.department)
            : byRole(users, 'Manager');
          if (managers.length) return uniqueById(managers);
          const deptAdmins = ctx.department ? departmentAdmins(users, ctx.department) : [];
          return uniqueById(deptAdmins.length ? deptAdmins : admins(users));
        }
        case 'it_admin':
          return uniqueById(byRole(users, 'IT Admin'));
        case 'super_admin':
          return uniqueById(byRole(users, 'Super Admin'));
        default:
          return uniqueById(admins(users));
      }
    }

    case 'ticket.status_changed':
    case 'ticket.priority_changed':
    case 'ticket.reopened':
    case 'ticket.resolved':
    case 'ticket.closed':
      return uniqueById(byIds(users, [ctx.createdBy, ctx.assignedTo]));

    case 'ticket.sla_approaching':
      return uniqueById([
        ...byIds(users, [ctx.assignedTo]),
        ...(ctx.department ? departmentAdmins(users, ctx.department) : [])
      ]);

    case 'ticket.sla_breached':
      return uniqueById(byIds(users, [ctx.assignedTo, ctx.createdBy]));

    case 'ticket.escalated': {
      const escalationAudience = uniqueById([
        ...(ctx.department ? departmentAdmins(users, ctx.department) : []),
        ...admins(users)
      ]);
      const alreadyTold = new Set([ctx.assignedTo, ctx.createdBy].filter(Boolean).map(String));
      return escalationAudience.filter((u) => !alreadyTold.has(String(u.id)));
    }

    case 'asset.warranty_expiring':
      return uniqueById([...admins(users), ...(ctx.assignedEmployee ? byName(users, ctx.assignedEmployee) : [])]);

    case 'amc.expiring':
    case 'asset.service_due':
      return uniqueById(byRoles(users, [...ADMIN_ROLES, 'Finance Team']));

    case 'asset.return_due':
      return uniqueById([...admins(users), ...(ctx.employeeName ? byName(users, ctx.employeeName) : [])]);

    case 'asset.low_inventory':
      return uniqueById(admins(users));

    case 'finance.payment_pending':
    case 'finance.invoice_created':
    case 'finance.invoice_overdue':
      return uniqueById(byRoles(users, [...ADMIN_ROLES, 'Finance Team']));

    case 'user.created':
    case 'user.role_changed':
    case 'user.deleted':
      return uniqueById(admins(users));

    case 'security.password_changed':
    case 'security.permissions_changed':
      return uniqueById(byRole(users, 'Super Admin'));

    case 'system.bulk_import_completed':
      return uniqueById(admins(users));

    /* ---------------------------------------------------------- requests */
    // An approval queue has a named audience: the people the request is actually about.
    // The engine passes them as ctx.explicitRecipients (requester + the approvers on the
    // active level); falling through to admins() here would page every administrator about
    // every request in the system, which is how a notification framework gets muted.
    case 'request.submitted':
    case 'request.approval_requested':
    case 'request.assigned':
    case 'request.approved':
    case 'request.rejected':
    case 'request.cancelled':
    case 'request.info_requested':
    case 'request.comment_added':
    case 'request.converted':
      return uniqueById(byIds(users, ctx.explicitRecipients || []));

    default:
      return uniqueById(admins(users));
  }
}

/* ------------------------------------------------------------------ dispatch */

async function dispatch(eventType, eventKey, ctx) {
  const globals = await activeChannels();
  const { prefsByEvent, recipientRows } = await getPolicy();

  // Cheapest gate first: an event below its severity floor, or with every channel off,
  // never renders a template or touches the users table.
  if (policy.isEventSuppressed(prefsByEvent, eventType, ctx, globals)) {
    console.log(`[notifications] ${eventType} (${eventKey}) suppressed by preferences`);
    return { queued: 0, deliveryIds: [] };
  }

  const message = templates.render(eventType, ctx);
  const enabled = policy.enabledChannelsFor(prefsByEvent, eventType, globals);

  const hasConfiguredAudience = recipientRows.some((r) => r.event_type === eventType);
  const users = await allActiveUsers();
  const recipients = policy.resolveAudience({
    eventType,
    defaults: hasConfiguredAudience ? [] : resolveRecipients(eventType, ctx, users),
    configuredRows: recipientRows,
    allUsers: hasConfiguredAudience ? users : []
  });

  if (recipients.length === 0) {
    console.warn(`[notifications] ${eventType} (${eventKey}) has no active recipients`);
    return { queued: 0, deliveryIds: [] };
  }

  const rows = [];
  for (const user of recipients) {
    if (enabled.inApp) {
      rows.push({ channel: 'in_app', userId: user.id, userName: user.name, address: null, body: message.inApp, status: 'Sent', error: null, subject: null });
    }
    for (const [key, channel] of Object.entries(CHANNELS)) {
      const channelOn = key === 'email' ? enabled.email : enabled.sms;
      const address = channel.addressFor(user);
      const body = key === 'email' ? message.email : message.sms;
      if (!channelOn || !address) {
        rows.push({
          channel: key, userId: user.id, userName: user.name, address, body, status: 'Skipped', subject: message.subject,
          error: !channelOn ? 'Channel disabled or not configured' : `No ${key} address on file`
        });
      } else {
        rows.push({ channel: key, userId: user.id, userName: user.name, address, body, status: 'Pending', error: null, subject: message.subject });
      }
    }
  }

  const claimed = await cm('notifications:claim', { eventKey, eventType, rows });

  // Only rows that survived the dedup are new; mirror the in-app ones into the bell feed.
  const inAppClaims = claimed.filter((r) => r.channel === 'in_app');
  if (inAppClaims.length) {
    await cm('notifications:insertInApp', {
      items: inAppClaims.map((c) => ({ id: `NTF-${c.id}`, text: message.inApp, type: message.type, userId: c.recipient_user_id, eventKey }))
    });
  }

  const deliveryIds = claimed.filter((r) => r.status === 'Pending').map((r) => r.id);
  return { queued: deliveryIds.length, deliveryIds };
}

/* --------------------------------------------------------------------- flush */

async function flush(deliveryIds = null) {
  const rows = await cq('notifications:pendingDeliveries', deliveryIds ? { ids: deliveryIds } : {});
  for (const row of rows) await attempt(row);
  return rows.length;
}

async function attempt(row) {
  const channel = CHANNELS[row.channel];
  if (!channel) return;
  try {
    await channel.send({ to: row.recipient_address, subject: row.subject, body: row.body });
    // markSent also mirrors outgoing mail into the Email Alerts Inbox (deduped on event_key).
    await cm('notifications:markSent', { id: row.id });
  } catch (err) {
    console.error(`[notifications] ${row.channel} delivery ${row.id} failed (attempt ${Number(row.attempts || 0) + 1}): ${err.message}`);
    await cm('notifications:markFailed', { id: row.id, error: err.message });
  }
}

/** Re-sends failed deliveries that have attempts left. Driven by cron. */
async function retryFailed() {
  const rows = await cq('notifications:failedDeliveries', { maxAttempts: MAX_ATTEMPTS });
  for (const row of rows) await attempt(row);
  if (rows.length) console.log(`[notifications] retried ${rows.length} failed delivery(ies)`);
  return rows.length;
}

/**
 * Dispatch, then send in the background. The returned promise resolves once the rows are
 * queued — callers should not wait on delivery.
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
  getPolicy, invalidatePolicyCache,
  eventTypes: templates.eventTypes,
  MAX_ATTEMPTS
};
