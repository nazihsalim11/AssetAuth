const db = require('../../db');
const notifications = require('../../notifications');

// Notifications, the email-alerts inbox, and notification administration (global
// settings, per-event preferences, delivery history, retry) — extracted verbatim
// from server.js.
function register(app, { requireUser, requirePermission, authenticateRequest }) {
  // A notification with user_id = NULL is a broadcast and is visible to everyone;
  // that is how every notification behaved before targeting existed, so older rows
  // keep showing up. A signed-in caller additionally sees the ones addressed to them.
  // Auth is optional here: the frontend loads notifications during bootstrap, and an
  // unauthenticated caller simply gets the broadcasts.
  app.get('/api/notifications', async (req, res) => {
    const user = authenticateRequest(req).user;
    try {
      const result = user
        ? await db.query(
            'SELECT * FROM notifications WHERE user_id = $1 OR user_id IS NULL ORDER BY created_at DESC LIMIT 200',
            [user.id]
          )
        : await db.query(
            'SELECT * FROM notifications WHERE user_id IS NULL ORDER BY created_at DESC LIMIT 200'
          );
      res.json(result.rows);
    } catch (err) {
      console.error('GET /api/notifications failed:', err);
      res.status(500).json({ error: 'Database query failed: ' + err.message });
    }
  });

  // --- EMAILS API ---
  // This previously returned a hardcoded [], leaving the Email Alerts Inbox permanently
  // empty. Outgoing notification emails are mirrored into this table, so it now shows
  // what the system actually sent.
  app.get('/api/emails', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const result = await db.query('SELECT * FROM emails ORDER BY created_at DESC LIMIT 200');
      res.json(result.rows);
    } catch (err) {
      console.error('GET /api/emails failed:', err);
      res.status(500).json({ error: 'Database query failed: ' + err.message });
    }
  });

  // The email alerts inbox is a shared, system-generated log, so any signed-in user
  // may prune it. (Unlike notifications, emails carry no per-user ownership.)
  app.delete('/api/emails/:id', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const { rowCount } = await db.query('DELETE FROM emails WHERE id = $1', [req.params.id]);
      if (rowCount === 0) return res.status(404).json({ error: 'Email not found' });
      res.json({ message: 'Email deleted', deleted: rowCount });
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
      const { rowCount } = await db.query('DELETE FROM emails WHERE id = ANY($1::text[])', [emailIds.map(String)]);
      res.json({ message: `Deleted ${rowCount} email(s)`, deleted: rowCount });
    } catch (err) {
      console.error('POST /api/emails/bulk/delete failed:', err);
      res.status(500).json({ error: 'Bulk delete failed: ' + err.message });
    }
  });

  app.post('/api/notifications', async (req, res) => {
    // No `time` column. created_at is the record's real instant and the UI derives
    // the relative label from it; storing 'Just now' froze every notification at
    // that literal string forever.
    const { id, text, type, read } = req.body;
    const query = `
      INSERT INTO notifications (id, text, type, read)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const values = [id, text, type || 'info', read || false];

    try {
      const result = await db.query(query, values);
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database insertion failed: ' + err.message });
    }
  });

  app.patch('/api/notifications/:id', async (req, res) => {
    const { id } = req.params;
    const { read } = req.body;
    try {
      const result = await db.query(
        'UPDATE notifications SET read = $1 WHERE id = $2 RETURNING *',
        [read, id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database update failed: ' + err.message });
    }
  });

  app.patch('/api/notifications', async (req, res) => {
    const user = authenticateRequest(req).user;
    try {
      // Scoped so one user clearing their bell does not mark another user's
      // notifications as read. Broadcasts are shared, and clear for everyone.
      if (user) {
        await db.query('UPDATE notifications SET read = TRUE WHERE user_id = $1 OR user_id IS NULL', [user.id]);
      } else {
        await db.query('UPDATE notifications SET read = TRUE WHERE user_id IS NULL');
      }
      res.json({ message: 'All notifications marked as read' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database update failed' });
    }
  });

  // Deleting is scoped the same way reading is: you may remove notifications addressed
  // to you, plus broadcasts. A broadcast removed by one user disappears for everyone,
  // which matches how "mark all read" already behaves for broadcasts.
  app.delete('/api/notifications/:id', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const { rowCount } = await db.query(
        'DELETE FROM notifications WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)',
        [req.params.id, user.id]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'Notification not found' });
      res.json({ message: 'Notification deleted', deleted: rowCount });
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
      const { rowCount } = await db.query(
        `DELETE FROM notifications
         WHERE id = ANY($1::text[]) AND (user_id = $2 OR user_id IS NULL)`,
        [notificationIds.map(String), user.id]
      );
      res.json({ message: `Deleted ${rowCount} notification(s)`, deleted: rowCount });
    } catch (err) {
      console.error('POST /api/notifications/bulk/delete failed:', err);
      res.status(500).json({ error: 'Bulk delete failed: ' + err.message });
    }
  });

  // Bulk mark read/unread, scoped to the caller's own notifications plus broadcasts —
  // the same visibility rule used everywhere else notifications are touched.
  app.post('/api/notifications/bulk/read', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const { notificationIds, read } = req.body;
    if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
      return res.status(400).json({ error: 'Payload must contain a non-empty notificationIds array' });
    }
    try {
      const { rowCount } = await db.query(
        `UPDATE notifications SET read = $1
         WHERE id = ANY($2::text[]) AND (user_id = $3 OR user_id IS NULL)`,
        [read !== false, notificationIds.map(String), user.id]
      );
      res.json({ message: `Updated ${rowCount} notification(s)`, updated: rowCount });
    } catch (err) {
      console.error('POST /api/notifications/bulk/read failed:', err);
      res.status(500).json({ error: 'Bulk update failed: ' + err.message });
    }
  });

  // --- NOTIFICATION ADMINISTRATION ---

  // Global channel switches, plus whether each channel actually has a working provider.
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
      slaWarningHours: 'sla_warning_hours'
    };

    const setClauses = [];
    const values = [];
    for (const [key, column] of Object.entries(allowed)) {
      if (req.body[key] !== undefined) {
        values.push(req.body[key]);
        setClauses.push(`${column} = $${values.length}`);
      }
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No notification settings to update' });
    }

    try {
      const result = await db.query(
        `UPDATE notification_settings SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = 1 RETURNING *`,
        values
      );
      notifications.invalidateSettingsCache();
      await db.query(
        `INSERT INTO system_logs (actor, action, detail) VALUES ($1, 'Notification Settings', $2)`,
        [user.name || user.username, `Updated: ${setClauses.join(', ')}`]
      );
      res.json({ settings: result.rows[0], channels: notifications.channelStatus() });
    } catch (err) {
      console.error('PATCH /api/notification-settings failed:', err);
      res.status(500).json({ error: 'Could not update notification settings: ' + err.message });
    }
  });

  // Per-event notification preferences: which channels fire for which event, the
  // severity floor, and who hears about it.
  //
  // An event type absent from `preferences` behaves as it always did: every globally
  // enabled channel, to the built-in audience. Absence is never "off".
  app.get('/api/notification-preferences', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const [prefs, recipients, roles] = await Promise.all([
        db.query('SELECT event_type, channel, enabled, min_priority FROM notification_preferences ORDER BY event_type, channel'),
        db.query('SELECT event_type, role, user_id FROM notification_recipients ORDER BY event_type'),
        db.query(`SELECT id, name, username, role FROM users WHERE status = 'Active' ORDER BY name NULLS LAST, username`)
      ]);
      res.json({
        eventTypes: notifications.eventTypes,
        preferences: prefs.rows,
        recipients: recipients.rows,
        users: roles.rows
      });
    } catch (err) {
      console.error('GET /api/notification-preferences failed:', err);
      res.status(500).json({ error: 'Could not load notification preferences: ' + err.message });
    }
  });

  // Replace the whole configuration in one transaction. A partial write here would
  // leave some events routed to nobody, which is silent and therefore worse than a
  // failed request.
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

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM notification_preferences');
      await client.query('DELETE FROM notification_recipients');

      for (const p of preferences) {
        await client.query(
          `INSERT INTO notification_preferences (event_type, channel, enabled, min_priority)
           VALUES ($1, $2, $3, $4)`,
          [p.eventType, p.channel, p.enabled !== false, p.minPriority || null]
        );
      }
      for (const r of recipients) {
        await client.query(
          `INSERT INTO notification_recipients (event_type, role, user_id) VALUES ($1, $2, $3)`,
          [r.eventType, r.role || null, r.userId ?? null]
        );
      }

      await client.query(
        `INSERT INTO system_logs (actor, action, detail) VALUES ($1, 'Notification Preferences', $2)`,
        [user.name || user.username, `Updated ${preferences.length} preference(s), ${recipients.length} recipient rule(s)`]
      );

      await client.query('COMMIT');
      notifications.invalidatePolicyCache();
      res.json({ ok: true, preferences: preferences.length, recipients: recipients.length });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('PUT /api/notification-preferences failed:', err);
      res.status(500).json({ error: 'Could not save notification preferences: ' + err.message });
    } finally {
      client.release();
    }
  });

  // Delivery audit log. Every attempt on every channel, with its status.
  app.get('/api/notification-history', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const { status, channel, limit } = req.query;
    const filters = [];
    const values = [];
    if (status) { values.push(status); filters.push(`status = $${values.length}`); }
    if (channel) { values.push(channel); filters.push(`channel = $${values.length}`); }

    // Non-admins only see what was sent to them.
    if (user.role !== 'Super Admin') {
      values.push(user.id);
      filters.push(`recipient_user_id = $${values.length}`);
    }

    values.push(Math.min(parseInt(limit, 10) || 100, 500));

    try {
      const result = await db.query(
        `SELECT * FROM notification_deliveries
         ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
         ORDER BY created_at DESC
         LIMIT $${values.length}`,
        values
      );
      const summary = await db.query(
        `SELECT status, COUNT(*)::int AS count FROM notification_deliveries GROUP BY status`
      );
      res.json({
        deliveries: result.rows,
        summary: Object.fromEntries(summary.rows.map((r) => [r.status, r.count]))
      });
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
