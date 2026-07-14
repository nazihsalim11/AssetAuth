const { cq, cm } = require('../../convexApi');
const notifications = require('../../notifications');

// Notifications, the email-alerts inbox, and notification administration (global settings,
// per-event preferences, delivery history, retry). Backed by native Convex
// (backend/convex/notifications.js); the dispatcher lives in backend/notifications/.
function register(app, { requireUser, requirePermission, authenticateRequest }) {
  const logAction = (actor, action, detail) => cm('logs:add', { actor, action, detail }).catch((e) => console.warn('[notifications] log failed:', e.message));

  // A notification with user_id = NULL is a broadcast (visible to everyone); a signed-in
  // caller additionally sees the ones addressed to them. Auth is optional — an
  // unauthenticated caller simply gets the broadcasts.
  app.get('/api/notifications', async (req, res) => {
    const user = authenticateRequest(req).user;
    try {
      res.json(await cq('notifications:listForUser', { userId: user ? user.id : undefined }));
    } catch (err) {
      console.error('GET /api/notifications failed:', err);
      res.status(500).json({ error: 'Database query failed: ' + err.message });
    }
  });

  // --- EMAILS API ---
  app.get('/api/emails', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      res.json(await cq('notifications:emailsList', {}));
    } catch (err) {
      console.error('GET /api/emails failed:', err);
      res.status(500).json({ error: 'Database query failed: ' + err.message });
    }
  });

  // The email alerts inbox is a shared, system-generated log, so any signed-in user may
  // prune it. (Unlike notifications, emails carry no per-user ownership.)
  app.delete('/api/emails/:id', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const { deleted } = await cm('notifications:emailRemove', { id: req.params.id });
      if (deleted === 0) return res.status(404).json({ error: 'Email not found' });
      res.json({ message: 'Email deleted', deleted });
    } catch (err) {
      console.error('DELETE /api/emails/:id failed:', err);
      res.status(500).json({ error: 'Could not delete email: ' + err.message });
    }
  });

  app.post('/api/emails/bulk/delete', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { emailIds } = req.body;
    if (!Array.isArray(emailIds) || emailIds.length === 0) {
      return res.status(400).json({ error: 'Payload must contain a non-empty emailIds array' });
    }
    try {
      const { deleted } = await cm('notifications:emailsBulkRemove', { ids: emailIds.map(String) });
      res.json({ message: `Deleted ${deleted} email(s)`, deleted });
    } catch (err) {
      console.error('POST /api/emails/bulk/delete failed:', err);
      res.status(500).json({ error: 'Bulk delete failed: ' + err.message });
    }
  });

  app.post('/api/notifications', async (req, res) => {
    const { id, text, type, read } = req.body;
    try {
      const created = await cm('notifications:create', { id, text, type: type || 'info', read: read || false });
      res.status(201).json(created);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database insertion failed: ' + err.message });
    }
  });

  app.patch('/api/notifications/:id', async (req, res) => {
    try {
      const updated = await cm('notifications:setRead', { id: req.params.id, read: req.body.read });
      if (!updated) return res.status(404).json({ error: 'Notification not found' });
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database update failed: ' + err.message });
    }
  });

  app.patch('/api/notifications', async (req, res) => {
    const user = authenticateRequest(req).user;
    try {
      await cm('notifications:markAllRead', { userId: user ? user.id : undefined });
      res.json({ message: 'All notifications marked as read' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database update failed' });
    }
  });

  // Deleting is scoped like reading: your own notifications plus broadcasts.
  app.delete('/api/notifications/:id', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const { deleted } = await cm('notifications:remove', { id: req.params.id, userId: user.id });
      if (deleted === 0) return res.status(404).json({ error: 'Notification not found' });
      res.json({ message: 'Notification deleted', deleted });
    } catch (err) {
      console.error('DELETE /api/notifications/:id failed:', err);
      res.status(500).json({ error: 'Could not delete notification: ' + err.message });
    }
  });

  app.post('/api/notifications/bulk/delete', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { notificationIds } = req.body;
    if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
      return res.status(400).json({ error: 'Payload must contain a non-empty notificationIds array' });
    }
    try {
      const { deleted } = await cm('notifications:bulkRemove', { ids: notificationIds.map(String), userId: user.id });
      res.json({ message: `Deleted ${deleted} notification(s)`, deleted });
    } catch (err) {
      console.error('POST /api/notifications/bulk/delete failed:', err);
      res.status(500).json({ error: 'Bulk delete failed: ' + err.message });
    }
  });

  app.post('/api/notifications/bulk/read', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { notificationIds, read } = req.body;
    if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
      return res.status(400).json({ error: 'Payload must contain a non-empty notificationIds array' });
    }
    try {
      const { updated } = await cm('notifications:bulkRead', { ids: notificationIds.map(String), read: read !== false, userId: user.id });
      res.json({ message: `Updated ${updated} notification(s)`, updated });
    } catch (err) {
      console.error('POST /api/notifications/bulk/read failed:', err);
      res.status(500).json({ error: 'Bulk update failed: ' + err.message });
    }
  });

  // --- NOTIFICATION ADMINISTRATION ---

  app.get('/api/notification-settings', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const settings = await notifications.getSettings({ fresh: true });
      res.json({ settings, channels: notifications.channelStatus() });
    } catch (err) {
      console.error('GET /api/notification-settings failed:', err);
      res.status(500).json({ error: 'Could not load notification settings: ' + err.message });
    }
  });

  app.patch('/api/notification-settings', async (req, res) => {
    const user = await requirePermission(req, res, 'notificationSettings', 'manage');
    if (!user) return;

    const allowed = {
      inAppEnabled: 'in_app_enabled',
      emailEnabled: 'email_enabled',
      smsEnabled: 'sms_enabled',
      warrantyReminderDays: 'warranty_reminder_days',
      amcReminderDays: 'amc_reminder_days',
      slaWarningHours: 'sla_warning_hours',
      serviceDueReminderDays: 'service_due_reminder_days',
      paymentDueReminderDays: 'payment_due_reminder_days',
      returnDueReminderDays: 'return_due_reminder_days',
      invoicePendingGraceDays: 'invoice_pending_grace_days'
    };

    const patch = {};
    for (const [key, column] of Object.entries(allowed)) {
      if (req.body[key] !== undefined) patch[column] = req.body[key];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No notification settings to update' });
    }

    try {
      const settings = await cm('notifications:settingsUpdate', { patch });
      notifications.invalidateSettingsCache();
      await logAction(user.name, 'Notification Settings', `Updated: ${Object.keys(patch).join(', ')}`);
      res.json({ settings, channels: notifications.channelStatus() });
    } catch (err) {
      console.error('PATCH /api/notification-settings failed:', err);
      res.status(500).json({ error: 'Could not update notification settings: ' + err.message });
    }
  });

  // Per-event notification preferences: which channels fire for which event, the severity
  // floor, and who hears about it. An event type absent from `preferences` behaves as it
  // always did: every globally enabled channel, to the built-in audience.
  app.get('/api/notification-preferences', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const [{ preferences, recipients }, users] = await Promise.all([
        cq('notifications:policyData', {}),
        cq('notifications:usersActive', {})
      ]);
      users.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')) || String(a.email || '').localeCompare(String(b.email || '')));
      res.json({
        eventTypes: notifications.eventTypes,
        preferences: preferences.map((p) => ({ event_type: p.event_type, channel: p.channel, enabled: p.enabled, min_priority: p.min_priority })),
        recipients: recipients.map((r) => ({ event_type: r.event_type, role: r.role, user_id: r.user_id })),
        users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }))
      });
    } catch (err) {
      console.error('GET /api/notification-preferences failed:', err);
      res.status(500).json({ error: 'Could not load notification preferences: ' + err.message });
    }
  });

  // Replace the whole configuration in one transaction — a partial write would leave some
  // events routed to nobody, which is silent and therefore worse than a failed request.
  app.put('/api/notification-preferences', async (req, res) => {
    const user = await requirePermission(req, res, 'notificationSettings', 'manage');
    if (!user) return;

    const { preferences = [], recipients = [] } = req.body || {};
    if (!Array.isArray(preferences) || !Array.isArray(recipients)) {
      return res.status(400).json({ error: 'preferences and recipients must be arrays' });
    }

    const validEvents = new Set(notifications.eventTypes);
    const validChannels = new Set(['in_app', 'email', 'sms']);
    const validPriorities = new Set(['Low', 'Medium', 'Critical']);

    for (const p of preferences) {
      if (!validEvents.has(p.eventType)) return res.status(400).json({ error: `Unknown event type: ${p.eventType}` });
      if (!validChannels.has(p.channel)) return res.status(400).json({ error: `Unknown channel: ${p.channel}` });
      if (p.minPriority != null && !validPriorities.has(p.minPriority)) {
        return res.status(400).json({ error: `Unknown priority: ${p.minPriority}` });
      }
    }
    for (const r of recipients) {
      if (!validEvents.has(r.eventType)) return res.status(400).json({ error: `Unknown event type: ${r.eventType}` });
      if (!r.role && r.userId == null) return res.status(400).json({ error: 'A recipient needs a role or a userId' });
    }

    try {
      const result = await cm('notifications:preferencesReplace', { preferences, recipients });
      await logAction(user.name, 'Notification Preferences', `Updated ${result.preferences} preference(s), ${result.recipients} recipient rule(s)`);
      notifications.invalidatePolicyCache();
      res.json({ ok: true, preferences: result.preferences, recipients: result.recipients });
    } catch (err) {
      console.error('PUT /api/notification-preferences failed:', err);
      res.status(500).json({ error: 'Could not save notification preferences: ' + err.message });
    }
  });

  // Delivery audit log. Every attempt on every channel, with its status.
  app.get('/api/notification-history', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { status, channel, limit } = req.query;
    try {
      const result = await cq('notifications:history', {
        status: status || undefined,
        channel: channel || undefined,
        // Non-admins only see what was sent to them.
        recipientUserId: user.role !== 'Super Admin' ? user.id : undefined,
        limit: Math.min(parseInt(limit, 10) || 100, 500)
      });
      res.json(result);
    } catch (err) {
      console.error('GET /api/notification-history failed:', err);
      res.status(500).json({ error: 'Could not load notification history: ' + err.message });
    }
  });

  // Manually drain the retry queue instead of waiting for the 15-minute cron.
  app.post('/api/notifications/retry-failed', async (req, res) => {
    const user = await requirePermission(req, res, 'notificationSettings', 'manage');
    if (!user) return;
    try {
      const retried = await notifications.retryFailed();
      res.json({ message: `Retried ${retried} failed delivery(ies)`, retried });
    } catch (err) {
      console.error('POST /api/notifications/retry-failed failed:', err);
      res.status(500).json({ error: 'Retry failed: ' + err.message });
    }
  });
}

module.exports = { register };
