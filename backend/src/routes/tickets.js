const db = require('../../db');
const notifications = require('../../notifications');
const scheduler = require('../../notifications/scheduler');
const slaModel = require('../../slaModel');
const slaEngine = require('../../slaEngine');
const slaAssignment = require('../../slaAssignment');

// Departmental ticketing system — the ticket queue, bulk operations, ticket detail,
// comments, assignment/auto-assign, status/priority/category/department changes, and
// analytics. Includes SLA deadline computation and agent auto-assignment. Extracted
// verbatim from server.js.
function register(app, { requireUser, requireUserWithDepartment, roleCan }) {
  // Map snake_case DB rows to camelCase for the frontend
  const mapTicket = (row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    subject: row.subject,
    description: row.description,
    department: row.department,
    priority: row.priority,
    status: row.status,
    category: row.category || 'Software',
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    ticketType: row.ticket_type || 'Incident',
    slaDeadline: row.sla_deadline,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    escalated: row.escalated || false,
    escalatedAt: row.escalated_at,
    // Wall-clock hours from creation to resolution, for the tracking panel.
    resolutionHours: row.resolved_at
      ? Math.max(0, Math.round((new Date(row.resolved_at) - new Date(row.created_at)) / 36e5 * 10) / 10)
      : null,
    // Database-driven SLA tracking.
    slaPolicyId: row.sla_policy_id || null,
    branch: row.branch || null,
    assetType: row.asset_type || null,
    firstResponseDue: row.first_response_due || null,
    resolutionDue: row.resolution_due || row.sla_deadline || null,
    firstResponseAt: row.first_response_at || null,
    responseBreached: row.response_breached || false,
    resolutionBreached: row.resolution_breached || false,
    escalationLevel: row.escalation_level || 0,
    slaStatus: slaEngine.slaStatus({
      status: row.status,
      resolutionDue: row.resolution_due || row.sla_deadline,
      firstResponseDue: row.first_response_due,
      firstResponseAt: row.first_response_at,
      resolvedAt: row.resolved_at
    }).state
  });

  const mapComment = (row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    authorName: row.author_name,
    authorId: row.author_id,
    commentText: row.comment_text,
    text: row.comment_text,
    isInternal: row.is_internal,
    createdAt: row.created_at
  });

  const mapTimeline = (row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    actorName: row.actor_name,
    action: row.action,
    detail: row.detail,
    createdAt: row.created_at
  });

  const mapAttachment = (row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    name: row.file_name,
    fileName: row.file_name,
    fileUrl: row.file_url,
    fileType: row.file_type,
    fileSize: row.file_size,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at
  });

  app.get('/api/tickets', async (req, res) => {
    const user = await requireUserWithDepartment(req, res);
    if (!user) return;

    let query = 'SELECT * FROM tickets';
    const params = [];

    if (user.role === 'Super Admin') {
      query += ' ORDER BY created_at DESC';
    } else if (user.role === 'Employee') {
      query += ' WHERE created_by = $1 ORDER BY created_at DESC';
      params.push(user.id);
    } else {
      query += ' WHERE department = $1 ORDER BY created_at DESC';
      params.push(user.department || '');
    }

    try {
      const result = await db.query(query, params);
      res.json(result.rows.map(mapTicket));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database query failed' });
    }
  });

  // --- BULK TICKET OPERATIONS (must be defined before /:id routes) ---
  app.post('/api/tickets/bulk/status', async (req, res) => {
    const { ticketIds, status } = req.body;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'edit'))) return res.status(403).json({ error: 'Your role is not permitted to bulk-edit tickets.' });

    const validStatuses = ['Open', 'In Progress', 'Pending', 'On Hold', 'Resolved', 'Closed', 'Reopened', 'Waiting for Employee'];
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status.' });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const tid of ticketIds) {
        const ticketRes = await client.query('SELECT * FROM tickets WHERE id = $1', [tid]);
        if (ticketRes.rows.length > 0) {
          const ticket = ticketRes.rows[0];
          const prev = ticket.status;
          const now = new Date();
          let resolvedAt = ticket.resolved_at;
          let closedAt = ticket.closed_at;
          if (status === 'Resolved') resolvedAt = now;
          else if (status === 'Closed') closedAt = now;

          await client.query('UPDATE tickets SET status = $1, resolved_at = $2, closed_at = $3, updated_at = NOW() WHERE id = $4', [status, resolvedAt, closedAt, tid]);
          await client.query(`
            INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
            VALUES ($1, $2, 'Status Changed', $3)
          `, [tid, user.name || user.username, `Bulk status changed from ${prev} to ${status}`]);
        }
      }
      await client.query('COMMIT');
      res.json({ message: 'Bulk status updated successfully' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Failed bulk status update' });
    } finally {
      client.release();
    }
  });

  app.post('/api/tickets/bulk/priority', async (req, res) => {
    const { ticketIds, priority } = req.body;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'edit'))) return res.status(403).json({ error: 'Your role is not permitted to bulk-edit tickets.' });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const tid of ticketIds) {
        const ticketRes = await client.query('SELECT * FROM tickets WHERE id = $1', [tid]);
        if (ticketRes.rows.length > 0) {
          const ticket = ticketRes.rows[0];
          const prev = ticket.priority;
          await client.query('UPDATE tickets SET priority = $1, updated_at = NOW() WHERE id = $2', [priority, tid]);
          await client.query(`
            INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
            VALUES ($1, $2, 'Priority Changed', $3)
          `, [tid, user.name || user.username, `Bulk priority changed from ${prev} to ${priority}`]);
        }
      }
      await client.query('COMMIT');
      res.json({ message: 'Bulk priority updated successfully' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Failed bulk priority update' });
    } finally {
      client.release();
    }
  });

  app.post('/api/tickets/bulk/category', async (req, res) => {
    const { ticketIds, category } = req.body;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'edit'))) return res.status(403).json({ error: 'Your role is not permitted to bulk-edit tickets.' });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const tid of ticketIds) {
        const ticketRes = await client.query('SELECT * FROM tickets WHERE id = $1', [tid]);
        if (ticketRes.rows.length > 0) {
          const ticket = ticketRes.rows[0];
          const prev = ticket.category || 'Software';
          await client.query('UPDATE tickets SET category = $1, updated_at = NOW() WHERE id = $2', [category, tid]);
          await client.query(`
            INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
            VALUES ($1, $2, 'Category Changed', $3)
          `, [tid, user.name || user.username, `Bulk category changed from ${prev} to ${category}`]);
        }
      }
      await client.query('COMMIT');
      res.json({ message: 'Bulk category updated successfully' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Failed bulk category update' });
    } finally {
      client.release();
    }
  });

  app.post('/api/tickets/bulk/department', async (req, res) => {
    const { ticketIds, department } = req.body;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'manage'))) return res.status(403).json({ error: 'Your role is not permitted to reassign ticket departments.' });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const tid of ticketIds) {
        const ticketRes = await client.query('SELECT * FROM tickets WHERE id = $1', [tid]);
        if (ticketRes.rows.length > 0) {
          const ticket = ticketRes.rows[0];
          const prev = ticket.department;
          await client.query('UPDATE tickets SET department = $1, updated_at = NOW() WHERE id = $2', [department, tid]);
          await client.query(`
            INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
            VALUES ($1, $2, 'Department Changed', $3)
          `, [tid, user.name || user.username, `Bulk department reassigned from ${prev} to ${department}`]);
        }
      }
      await client.query('COMMIT');
      res.json({ message: 'Bulk department reassigned successfully' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Failed bulk department reassignment' });
    } finally {
      client.release();
    }
  });

  app.post('/api/tickets/bulk/assign', async (req, res) => {
    const ticketIds = req.body.ticketIds || req.body.ticket_ids;
    const assignToUserId = req.body.assignToUserId || req.body.assign_to_user_id;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'edit'))) return res.status(403).json({ error: 'Your role is not permitted to assign tickets.' });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      let targetName = null;
      let targetId = null;

      if (assignToUserId) {
        const targetUserRes = await client.query('SELECT id, name, username FROM users WHERE id = $1', [assignToUserId]);
        if (targetUserRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Target user not found.' });
        }
        targetName = targetUserRes.rows[0].name || targetUserRes.rows[0].username;
        targetId = targetUserRes.rows[0].id;
      } else {
        targetName = user.name || user.username;
        targetId = user.id;
      }

      for (const tid of ticketIds) {
        await client.query('UPDATE tickets SET assigned_to = $1, assigned_to_name = $2, status = \'In Progress\', updated_at = NOW() WHERE id = $3', [targetId, targetName, tid]);
        await client.query(`
          INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
          VALUES ($1, $2, 'Assigned', $3)
        `, [tid, user.name || user.username, `Bulk assigned ticket to ${targetName}`]);
      }
      await client.query('COMMIT');
      res.json({ message: 'Bulk assignment updated successfully' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Failed bulk assignment' });
    } finally {
      client.release();
    }
  });

  app.post('/api/tickets/bulk/delete', async (req, res) => {
    const { ticketIds } = req.body;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'delete'))) return res.status(403).json({ error: 'Your role is not permitted to delete tickets.' });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const tid of ticketIds) {
        await client.query('DELETE FROM tickets WHERE id = $1', [tid]);
      }
      await client.query('COMMIT');
      res.json({ message: 'Bulk deletion successfully executed' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Failed bulk deletion' });
    } finally {
      client.release();
    }
  });
  // --- END BULK TICKET OPERATIONS ---

  app.get('/api/tickets/:id', async (req, res) => {
    const { id } = req.params;
    const user = await requireUserWithDepartment(req, res);
    if (!user) return;

    try {
      let ticketRes;
      const isInteger = /^\d+$/.test(id);
      if (isInteger) {
        ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1 OR ticket_id = $2::text', [parseInt(id), String(id)]);
      } else {
        ticketRes = await db.query('SELECT * FROM tickets WHERE ticket_id = $1', [id]);
      }
      if (ticketRes.rows.length === 0) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      const ticket = ticketRes.rows[0];

      if (user.role !== 'Super Admin' && user.role !== 'Employee' && ticket.department !== user.department) {
        return res.status(403).json({ error: 'Access denied to this ticket queue.' });
      }
      if (user.role === 'Employee' && ticket.created_by !== user.id) {
        return res.status(403).json({ error: 'Access denied: You can only view your own tickets.' });
      }

      let commentsQuery = 'SELECT * FROM ticket_comments WHERE ticket_id = $1';
      const commentsParams = [ticket.id];
      if (user.role === 'Employee') {
        commentsQuery += ' AND is_internal = FALSE';
      }
      commentsQuery += ' ORDER BY created_at ASC';
      const commentsRes = await db.query(commentsQuery, commentsParams);

      const timelineRes = await db.query('SELECT * FROM ticket_timeline WHERE ticket_id = $1 ORDER BY created_at ASC', [ticket.id]);
      const attachmentsRes = await db.query('SELECT * FROM ticket_attachments WHERE ticket_id = $1 ORDER BY created_at ASC', [ticket.id]);

      // SLA policy detail for the tracking panel — the governing policy's name and its
      // escalation ladder, so the ticket workspace can show what SLA is in force.
      let slaPolicy = null;
      if (ticket.sla_policy_id) {
        const polRes = await db.query(
          `SELECT p.id, p.name, p.first_response_minutes, p.resolution_minutes, c.name AS calendar_name,
                  COALESCE((SELECT json_agg(e ORDER BY e.level) FROM sla_escalation_levels e WHERE e.policy_id = p.id), '[]') AS escalation_levels
           FROM sla_policies p LEFT JOIN business_calendars c ON c.id = p.calendar_id
           WHERE p.id = $1`,
          [ticket.sla_policy_id]
        );
        if (polRes.rows.length) {
          const p = polRes.rows[0];
          slaPolicy = {
            id: p.id, name: p.name, calendarName: p.calendar_name,
            firstResponseMinutes: p.first_response_minutes, resolutionMinutes: p.resolution_minutes,
            escalationLevels: (p.escalation_levels || []).map((e) => ({
              level: e.level, triggerType: e.trigger_type, threshold: Number(e.threshold), notifyTarget: e.notify_target
            }))
          };
        }
      }

      res.json({
        ...mapTicket(ticket),
        slaPolicy,
        comments: commentsRes.rows.map(mapComment),
        timeline: timelineRes.rows.map(mapTimeline),
        attachments: attachmentsRes.rows.map(mapAttachment)
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database query failed' });
    }
  });

  app.post('/api/tickets', async (req, res) => {
    const { subject, description, department, priority, attachments, category } = req.body;
    const user = requireUser(req, res);
    if (!user) return;

    if (!subject || !description || !department || !priority) {
      return res.status(400).json({ error: 'Subject, description, department, and priority are required.' });
    }

    // Defaults keep older clients — which send neither field — working unchanged.
    const ticketType = req.body.ticketType || 'Incident';
    if (!knowledgeBase.TICKET_TYPES.includes(ticketType)) {
      return res.status(400).json({ error: `Ticket type must be one of: ${knowledgeBase.TICKET_TYPES.join(', ')}` });
    }
    // Existing tickets carry departments outside the helpdesk queues (e.g. Finance),
    // so this only constrains new ones.
    if (!knowledgeBase.HELPDESK_DEPARTMENTS.includes(department)) {
      return res.status(400).json({ error: `Department must be one of: ${knowledgeBase.HELPDESK_DEPARTMENTS.join(', ')}` });
    }

    // SLA deadlines are now database-driven: match the ticket to the most specific
    // active policy and walk that policy's business calendar. computeDeadlines never
    // throws — an unmatched ticket falls back to a 24h wall-clock resolution — so ticket
    // creation cannot be blocked by SLA configuration.
    // createTicket() snake-cases its body, so assetType arrives as asset_type; accept both.
    const branch = req.body.branch || null;
    const assetType = req.body.assetType || req.body.asset_type || null;
    const createdAt = new Date();
    let sla;
    try {
      sla = await slaModel.computeDeadlines(
        { priority, category: category || 'Software', department, assetType, branch },
        createdAt
      );
    } catch (slaErr) {
      console.error('[sla] deadline computation failed, defaulting to 24h:', slaErr.message);
      sla = { policyId: null, firstResponseDue: null, resolutionDue: new Date(createdAt.getTime() + 24 * 3600 * 1000) };
    }
    // sla_deadline is kept in sync with resolution_due so the existing analytics and
    // breach scheduler (which read sla_deadline) keep working unchanged.
    const slaDeadline = sla.resolutionDue;

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // `category` was previously accepted from the client and then silently dropped
      // from the INSERT, so every ticket fell back to the column default.
      const insertQuery = `
        INSERT INTO tickets (subject, description, department, priority, status, created_by, created_by_name, sla_deadline, ticket_id, category, ticket_type,
                             sla_policy_id, first_response_due, resolution_due, branch, asset_type)
        VALUES ($1, $2, $3, $4, 'Open', $5, $6, $7, '', $8, $9, $10, $11, $12, $13, $14)
        RETURNING *;
      `;
      const result = await client.query(insertQuery, [
        subject, description, department, priority, user.id, user.name || user.username, slaDeadline,
        category || 'Software', ticketType,
        sla.policyId, sla.firstResponseDue, sla.resolutionDue, branch, assetType
      ]);
      const ticket = result.rows[0];

      const deptCode = department === 'IT' ? 'IT'
        : department === 'HR' ? 'HR'
        : department === 'Administration' ? 'ADM'
        : department === 'Finance' ? 'FIN'
        : department.substring(0, 3).toUpperCase();
      const ticketId = `${deptCode}-${String(ticket.id).padStart(6, '0')}`;
      await client.query('UPDATE tickets SET ticket_id = $1 WHERE id = $2', [ticketId, ticket.id]);
      ticket.ticket_id = ticketId;

      await client.query(`
        INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
        VALUES ($1, $2, 'Created', 'Ticket created by employee')
      `, [ticket.id, user.name || user.username]);

      // Automatic technician assignment, if the governing policy asks for it. Done inside
      // the same transaction so a created ticket is never briefly unassigned; the
      // notification is fired after COMMIT. Failure here must not fail ticket creation.
      let autoAssigned = null;
      if (sla.policy && sla.policy.auto_assign_enabled) {
        try {
          const agent = await slaAssignment.pickAgent(
            { department }, sla.policy.auto_assign_strategy, client
          );
          if (agent) {
            const agentName = agent.name || agent.username;
            await client.query(
              `UPDATE tickets SET assigned_to = $1, assigned_to_name = $2, status = 'In Progress', updated_at = NOW() WHERE id = $3`,
              [agent.id, agentName, ticket.id]
            );
            ticket.assigned_to = agent.id;
            ticket.assigned_to_name = agentName;
            ticket.status = 'In Progress';
            await client.query(
              `INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail) VALUES ($1, 'System', 'Assigned', $2)`,
              [ticket.id, `Auto-assigned to ${agentName} (${sla.policy.auto_assign_strategy.replace('_', ' ')}, ${agent.workload} open ticket(s))`]
            );
            autoAssigned = { id: agent.id, name: agentName };
          }
        } catch (assignErr) {
          console.error('[sla] auto-assignment failed:', assignErr.message);
        }
      }

      if (Array.isArray(attachments)) {
        for (const att of attachments) {
          await client.query(`
            INSERT INTO ticket_attachments (ticket_id, file_name, file_url, file_type, file_size, uploaded_by)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [ticket.id, att.name, att.fileUrl, att.fileType, att.fileSize, user.name || user.username]);
        }
      }

      await client.query(`
        INSERT INTO system_logs (actor, action, detail)
        VALUES ($1, 'Ticket Creation', $2)
      `, [user.name || user.username, `Created Ticket ${ticketId} in ${department} department`]);

      await client.query('COMMIT');

      // Dispatched after COMMIT: the dispatcher reads through the pool, and email/SMS
      // must not hold a transaction open. Deliberately not awaited — a slow SMTP server
      // should not delay the response, and a notification failure must not fail the request.
      notifications.notify('ticket.created', `ticket-created:${ticket.id}`, {
        ticketId, subject, description, department, priority,
        createdBy: user.id,
        createdByName: user.name || user.username,
        slaDeadline
      });

      // Tell the auto-assigned technician (and the requester) about the assignment.
      if (autoAssigned) {
        notifications.notify('ticket.assigned', `ticket-assigned:${ticket.id}:${autoAssigned.id}`, {
          ticketId, subject, department, priority, slaDeadline,
          assignedTo: autoAssigned.id, assignedToName: autoAssigned.name, createdBy: user.id
        });
      }

      res.status(201).json(mapTicket(ticket));
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Ticket creation failed: ' + err.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/tickets/:id/comments', async (req, res) => {
    const { id } = req.params;
    const commentText = req.body.commentText || req.body.comment_text;
    const isInternal = req.body.isInternal !== undefined ? req.body.isInternal : req.body.is_internal;
    const user = requireUser(req, res);
    if (!user) return;

    if (!commentText) {
      return res.status(400).json({ error: 'Comment text is required.' });
    }

    const isInt = !!isInternal;
    if (isInt && !(await roleCan(user, 'tickets', 'edit'))) {
      return res.status(403).json({ error: 'Your role is not permitted to post internal comments.' });
    }

    try {
      const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
      if (ticketRes.rows.length === 0) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      const ticket = ticketRes.rows[0];

      const commentRes = await db.query(`
        INSERT INTO ticket_comments (ticket_id, author_name, author_id, comment_text, is_internal)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *;
      `, [ticket.id, user.name || user.username, user.id, commentText, isInt]);

      await db.query(`
        INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
        VALUES ($1, $2, 'Comment Added', $3)
      `, [ticket.id, user.name || user.username, isInt ? 'Added internal comment' : 'Added public comment']);

      // First response: the earliest public reply from someone other than the requester
      // stops the response-SLA clock. Internal notes and the requester's own comments do
      // not count. Recorded once.
      if (!ticket.first_response_at && !isInt && user.id !== ticket.created_by) {
        await db.query(
          `UPDATE tickets
           SET first_response_at = NOW(),
               response_breached = (first_response_due IS NOT NULL AND NOW() > first_response_due)
           WHERE id = $1 AND first_response_at IS NULL`,
          [ticket.id]
        );
      }

      const notifId = `NTF-CMT-${ticket.ticket_id}-${Date.now()}`;
      const notifText = `${user.name || user.username} commented on ticket ${ticket.ticket_id}`;
      await db.query(`
        INSERT INTO notifications (id, text, type, read)
        VALUES ($1, $2, 'info', FALSE)
      `, [notifId, notifText]);

      res.status(201).json(commentRes.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to add comment' });
    }
  });

  app.post('/api/tickets/:id/assign', async (req, res) => {
    const { id } = req.params;
    const assignToUserId = req.body.assignToUserId || req.body.assign_to_user_id;
    const user = requireUser(req, res);
    if (!user) return;

    if (!(await roleCan(user, 'tickets', 'edit'))) {
      return res.status(403).json({ error: 'Your role is not permitted to assign tickets.' });
    }

    try {
      const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
      if (ticketRes.rows.length === 0) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      const ticket = ticketRes.rows[0];

      let targetName = null;
      let targetId = null;

      if (assignToUserId) {
        const targetUserRes = await db.query('SELECT id, name, username FROM users WHERE id = $1', [assignToUserId]);
        if (targetUserRes.rows.length === 0) {
          return res.status(400).json({ error: 'Target user not found.' });
        }
        targetName = targetUserRes.rows[0].name || targetUserRes.rows[0].username;
        targetId = targetUserRes.rows[0].id;
      } else {
        targetName = user.name || user.username;
        targetId = user.id;
      }

      // A reassignment is moving an already-assigned ticket to a different agent, as
      // opposed to a first assignment. The previous assignee should hear that it left them.
      const previousAssignee = ticket.assigned_to;
      const isReassignment = previousAssignee && previousAssignee !== targetId;

      await db.query(`
        UPDATE tickets
        SET assigned_to = $1, assigned_to_name = $2, status = 'In Progress', updated_at = NOW()
        WHERE id = $3
      `, [targetId, targetName, ticket.id]);

      await db.query(`
        INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
        VALUES ($1, $2, 'Assigned', $3)
      `, [ticket.id, user.name || user.username, isReassignment ? `Reassigned ticket from ${ticket.assigned_to_name || 'previous agent'} to ${targetName}` : `Assigned ticket to ${targetName}`]);

      await db.query(`
        INSERT INTO system_logs (actor, action, detail)
        VALUES ($1, 'Ticket Assignment', $2)
      `, [user.name || user.username, `Assigned Ticket ${ticket.ticket_id} to ${targetName}`]);

      // Keyed on the assignee so a reassignment notifies afresh, but assigning the
      // same person twice does not.
      notifications.notify('ticket.assigned', `ticket-assigned:${ticket.id}:${targetId}`, {
        ticketId: ticket.ticket_id,
        subject: ticket.subject,
        department: ticket.department,
        priority: ticket.priority,
        slaDeadline: ticket.sla_deadline,
        assignedTo: targetId,
        assignedToName: targetName,
        createdBy: ticket.created_by
      });

      if (isReassignment) {
        // Keyed on the pair so each distinct hand-off notifies once.
        notifications.notify('ticket.reassigned', `ticket-reassigned:${ticket.id}:${previousAssignee}:${targetId}`, {
          ticketId: ticket.ticket_id,
          subject: ticket.subject,
          department: ticket.department,
          priority: ticket.priority,
          previousAssignee,
          previousAssigneeName: ticket.assigned_to_name,
          assignedTo: targetId,
          assignedToName: targetName,
          actorName: user.name || user.username
        });
      }

      res.json({ message: 'Ticket assigned successfully', assignedToName: targetName });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Assignment failed' });
    }
  });

  app.patch('/api/tickets/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const user = requireUser(req, res);
    if (!user) return;

    const validStatuses = ['Open', 'In Progress', 'Waiting for Employee', 'Resolved', 'Closed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value.' });
    }

    try {
      const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
      if (ticketRes.rows.length === 0) {
        return res.status(404).json({ error: 'Ticket not found' });
      }
      const ticket = ticketRes.rows[0];

      if (user.role === 'Employee' && ticket.created_by !== user.id) {
        return res.status(403).json({ error: 'Employees can only close their own tickets.' });
      }

      const prevStatus = ticket.status;
      const now = new Date();
      let resolvedAt = ticket.resolved_at;
      let closedAt = ticket.closed_at;

      if (status === 'Resolved') {
        resolvedAt = now;
      } else if (status === 'Closed') {
        closedAt = now;
      }

      const updated = await db.query(`
        UPDATE tickets
        SET status = $1, resolved_at = $2, closed_at = $3, updated_at = NOW()
        WHERE id = $4
        RETURNING updated_at
      `, [status, resolvedAt, closedAt, ticket.id]);

      await db.query(`
        INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
        VALUES ($1, $2, 'Status Changed', $3)
      `, [ticket.id, user.name || user.username, `Status changed from ${prevStatus} to ${status}`]);

      await db.query(`
        INSERT INTO system_logs (actor, action, detail)
        VALUES ($1, 'Ticket Status Update', $2)
      `, [user.name || user.username, `Updated Ticket ${ticket.ticket_id} status from ${prevStatus} to ${status}`]);

      // Resolved and Closed are distinct events with their own wording; moving *out* of
      // either back into an active state is a reopen. Everything else is a plain status
      // change. The event key includes the new status so each transition announces once,
      // and a genuine reopen after a previous reopen is keyed by its own timestamp.
      const isReopen = ['Resolved', 'Closed'].includes(prevStatus) && !['Resolved', 'Closed'].includes(status);
      const eventType =
        isReopen ? 'ticket.reopened' :
        status === 'Resolved' ? 'ticket.resolved' :
        status === 'Closed' ? 'ticket.closed' :
        'ticket.status_changed';

      // Keyed on the transition's own timestamp. Keying on the status alone would
      // suppress a legitimate re-resolve after a reopen, while a retried request lands
      // on the same updated_at and is still deduplicated.
      const eventKey = `ticket-status:${ticket.id}:${status}:${updated.rows[0].updated_at.toISOString()}`;

      notifications.notify(eventType, eventKey, {
        ticketId: ticket.ticket_id,
        subject: ticket.subject,
        department: ticket.department,
        priority: ticket.priority,
        status,
        previousStatus: prevStatus,
        actorName: user.name || user.username,
        createdBy: ticket.created_by,
        assignedTo: ticket.assigned_to,
        assignedToName: ticket.assigned_to_name
      });

      res.json({ message: 'Ticket status updated successfully', status });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to update ticket status' });
    }
  });

  app.patch('/api/tickets/:id/priority', async (req, res) => {
    const { id } = req.params;
    const { priority } = req.body;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'edit'))) return res.status(403).json({ error: 'Your role is not permitted to change ticket priority.' });

    const validPriorities = ['Critical', 'Medium', 'Low'];
    if (!validPriorities.includes(priority)) return res.status(400).json({ error: 'Invalid priority.' });

    try {
      const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
      if (ticketRes.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
      const ticket = ticketRes.rows[0];

      const prevPriority = ticket.priority;
      await db.query('UPDATE tickets SET priority = $1, updated_at = NOW() WHERE id = $2', [priority, ticket.id]);

      await db.query(`
        INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
        VALUES ($1, $2, 'Priority Changed', $3)
      `, [ticket.id, user.name || user.username, `Priority changed from ${prevPriority} to ${priority}`]);

      notifications.notify('ticket.priority_changed', `ticket-priority:${ticket.id}:${priority}:${Date.now()}`, {
        ticketId: ticket.ticket_id,
        subject: ticket.subject,
        department: ticket.department,
        priority,
        previousPriority: prevPriority,
        actorName: user.name || user.username,
        createdBy: ticket.created_by,
        assignedTo: ticket.assigned_to,
        assignedToName: ticket.assigned_to_name
      });

      res.json({ message: 'Priority updated successfully', priority });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to update priority' });
    }
  });

  app.patch('/api/tickets/:id/category', async (req, res) => {
    const { id } = req.params;
    const { category } = req.body;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'edit'))) return res.status(403).json({ error: 'Your role is not permitted to change ticket category.' });

    try {
      const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
      if (ticketRes.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
      const ticket = ticketRes.rows[0];

      const prevCategory = ticket.category || 'Software';
      await db.query('UPDATE tickets SET category = $1, updated_at = NOW() WHERE id = $2', [category, ticket.id]);

      await db.query(`
        INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
        VALUES ($1, $2, 'Category Changed', $3)
      `, [ticket.id, user.name || user.username, `Category changed from ${prevCategory} to ${category}`]);

      res.json({ message: 'Category updated successfully', category });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to update category' });
    }
  });

  app.patch('/api/tickets/:id/department', async (req, res) => {
    const { id } = req.params;
    const { department } = req.body;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'manage'))) return res.status(403).json({ error: 'Your role is not permitted to reassign ticket departments.' });

    try {
      const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
      if (ticketRes.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
      const ticket = ticketRes.rows[0];

      const prevDept = ticket.department;
      await db.query('UPDATE tickets SET department = $1, updated_at = NOW() WHERE id = $2', [department, ticket.id]);

      await db.query(`
        INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
        VALUES ($1, $2, 'Department Changed', $3)
      `, [ticket.id, user.name || user.username, `Department reassigned from ${prevDept} to ${department}`]);

      res.json({ message: 'Department updated successfully', department });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to update department' });
    }
  });


  app.post('/api/tickets/:id/auto-assign', async (req, res) => {
    const { id } = req.params;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'edit'))) return res.status(403).json({ error: 'Your role is not permitted to auto-assign tickets.' });

    try {
      const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
      if (ticketRes.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
      const ticket = ticketRes.rows[0];

      // Honour the governing policy's strategy if it has one (e.g. round robin); default
      // to least-loaded, which is what the "Auto-Assign (Workload)" button implies.
      let strategy = 'least_loaded';
      if (ticket.sla_policy_id) {
        const polRes = await db.query('SELECT auto_assign_strategy FROM sla_policies WHERE id = $1', [ticket.sla_policy_id]);
        if (polRes.rows.length && polRes.rows[0].auto_assign_strategy) strategy = polRes.rows[0].auto_assign_strategy;
      }

      const chosenAgent = await slaAssignment.pickAgent({ department: ticket.department }, strategy);
      if (!chosenAgent) {
        return res.status(400).json({ error: 'No eligible agents found for auto-assignment.' });
      }

      const targetName = chosenAgent.name || chosenAgent.username;
      const targetId = chosenAgent.id;

      await db.query(`
        UPDATE tickets
        SET assigned_to = $1, assigned_to_name = $2, status = 'In Progress', updated_at = NOW()
        WHERE id = $3
      `, [targetId, targetName, ticket.id]);

      await db.query(`
        INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
        VALUES ($1, $2, 'Assigned', $3)
      `, [ticket.id, user.name || user.username, `Auto-assigned ticket to ${targetName} (${strategy.replace('_', ' ')}, ${chosenAgent.workload} active ticket(s))`]);

      notifications.notify('ticket.assigned', `ticket-assigned:${ticket.id}:${targetId}`, {
        ticketId: ticket.ticket_id,
        subject: ticket.subject,
        department: ticket.department,
        priority: ticket.priority,
        slaDeadline: ticket.sla_deadline,
        assignedTo: targetId,
        assignedToName: targetName,
        createdBy: ticket.created_by
      });

      res.json({ message: 'Ticket auto-assigned successfully', assignedToName: targetName });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Auto-assignment failed' });
    }
  });

  app.get('/api/tickets-analytics', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    let scopeQuery = '';
    const params = [];

    if (user.role !== 'Super Admin') {
      scopeQuery = ' WHERE department = $1';
      params.push(user.department);
    }

    try {
      const statusCounts = await db.query(
        `SELECT status, COUNT(*) as count FROM tickets${scopeQuery} GROUP BY status`,
        params
      );

      const overdueRes = await db.query(
        `SELECT COUNT(*) as count FROM tickets
         WHERE sla_deadline < CURRENT_TIMESTAMP 
           AND status NOT IN ('Resolved', 'Closed')
           ${scopeQuery ? 'AND department = $1' : ''}`,
        params
      );

      const priorityCounts = await db.query(
        `SELECT priority, COUNT(*) as count FROM tickets${scopeQuery} GROUP BY priority`,
        params
      );

      const deptCounts = await db.query(
        `SELECT department, COUNT(*) as count FROM tickets${scopeQuery} GROUP BY department`,
        params
      );

      const avgResTimeRes = await db.query(
        `SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) as avg_hours 
         FROM tickets 
         WHERE resolved_at IS NOT NULL 
           ${scopeQuery ? 'AND department = $1' : ''}`,
        params
      );

      const counts = {
        total: 0,
        open: 0,
        inProgress: 0,
        waiting: 0,
        resolved: 0,
        closed: 0,
        overdue: parseInt(overdueRes.rows[0].count) || 0,
        avgResolutionTimeHours: avgResTimeRes.rows[0].avg_hours ? parseFloat(parseFloat(avgResTimeRes.rows[0].avg_hours).toFixed(1)) : 0
      };

      statusCounts.rows.forEach(row => {
        const cnt = parseInt(row.count);
        counts.total += cnt;
        if (row.status === 'Open') counts.open = cnt;
        else if (row.status === 'In Progress') counts.inProgress = cnt;
        else if (row.status === 'Waiting for Employee') counts.waiting = cnt;
        else if (row.status === 'Resolved') counts.resolved = cnt;
        else if (row.status === 'Closed') counts.closed = cnt;
      });

      res.json({
        counts,
        byPriority: priorityCounts.rows.reduce((acc, row) => {
          acc[row.priority] = parseInt(row.count);
          return acc;
        }, {}),
        byDepartment: deptCounts.rows.reduce((acc, row) => {
          acc[row.department] = parseInt(row.count);
          return acc;
        }, {})
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch analytics' });
    }
  });
}

module.exports = { register };
