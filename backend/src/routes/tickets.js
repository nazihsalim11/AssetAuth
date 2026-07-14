const { cq, cm } = require('../../convexApi');
const notifications = require('../../notifications');
const slaEngine = require('../../slaEngine');
const slaModel = require('../../slaModel');
const slaAssignment = require('../../slaAssignment');
const knowledgeBase = require('../../knowledgeBase');

// Departmental ticketing system — the ticket queue, bulk operations, ticket detail,
// comments, assignment/auto-assign, status/priority/category/department changes, and
// analytics. Includes SLA deadline computation and agent auto-assignment. Backed by native
// Convex (backend/convex/tickets.js); notifications.notify() dispatch stays hybrid.
function register(app, { requireUser, requireUserWithDepartment, roleCan }) {
  // Map snake_case Convex rows to camelCase for the frontend.
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

  const logAction = (actor, action, detail) => cm('logs:add', { actor, action, detail }).catch((e) => console.warn('[tickets] log failed:', e.message));

  app.get('/api/tickets', async (req, res) => {
    const user = await requireUserWithDepartment(req, res);
    if (!user) return;
    try {
      const args =
        user.role === 'Super Admin' ? {} :
        user.role === 'Employee' ? { createdBy: user.id } :
        { department: user.department || '' };
      const rows = await cq('tickets:list', args);
      res.json(rows.map(mapTicket));
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
    try {
      await cm('tickets:bulkStatus', { ticketIds, value: status, actorName: user.name });
      res.json({ message: 'Bulk status updated successfully' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed bulk status update' });
    }
  });

  app.post('/api/tickets/bulk/priority', async (req, res) => {
    const { ticketIds, priority } = req.body;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'edit'))) return res.status(403).json({ error: 'Your role is not permitted to bulk-edit tickets.' });
    try {
      await cm('tickets:bulkPriority', { ticketIds, value: priority, actorName: user.name });
      res.json({ message: 'Bulk priority updated successfully' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed bulk priority update' });
    }
  });

  app.post('/api/tickets/bulk/category', async (req, res) => {
    const { ticketIds, category } = req.body;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'edit'))) return res.status(403).json({ error: 'Your role is not permitted to bulk-edit tickets.' });
    try {
      await cm('tickets:bulkCategory', { ticketIds, value: category, actorName: user.name });
      res.json({ message: 'Bulk category updated successfully' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed bulk category update' });
    }
  });

  app.post('/api/tickets/bulk/department', async (req, res) => {
    const { ticketIds, department } = req.body;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'manage'))) return res.status(403).json({ error: 'Your role is not permitted to reassign ticket departments.' });
    try {
      await cm('tickets:bulkDepartment', { ticketIds, value: department, actorName: user.name });
      res.json({ message: 'Bulk department reassigned successfully' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed bulk department reassignment' });
    }
  });

  app.post('/api/tickets/bulk/assign', async (req, res) => {
    const ticketIds = req.body.ticketIds || req.body.ticket_ids;
    const assignToUserId = req.body.assignToUserId || req.body.assign_to_user_id;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'edit'))) return res.status(403).json({ error: 'Your role is not permitted to assign tickets.' });
    try {
      let targetName = user.name;
      let targetId = user.id;
      if (assignToUserId) {
        const target = await cq('users:getByWorkosId', { workosUserId: assignToUserId });
        if (!target) return res.status(400).json({ error: 'Target user not found.' });
        targetName = target.name;
        targetId = target.workos_user_id;
      }
      await cm('tickets:bulkAssign', { ticketIds, targetId, targetName, actorName: user.name });
      res.json({ message: 'Bulk assignment updated successfully' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed bulk assignment' });
    }
  });

  app.post('/api/tickets/bulk/delete', async (req, res) => {
    const { ticketIds } = req.body;
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'tickets', 'delete'))) return res.status(403).json({ error: 'Your role is not permitted to delete tickets.' });
    try {
      await cm('tickets:bulkDelete', { ticketIds });
      res.json({ message: 'Bulk deletion successfully executed' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed bulk deletion' });
    }
  });
  // --- END BULK TICKET OPERATIONS ---

  app.get('/api/tickets/:id', async (req, res) => {
    const { id } = req.params;
    const user = await requireUserWithDepartment(req, res);
    if (!user) return;
    try {
      const result = await cq('tickets:getDetail', { id: String(id), includeInternal: user.role !== 'Employee' });
      if (!result) return res.status(404).json({ error: 'Ticket not found' });
      const ticket = result.ticket;

      if (user.role !== 'Super Admin' && user.role !== 'Employee' && ticket.department !== user.department) {
        return res.status(403).json({ error: 'Access denied to this ticket queue.' });
      }
      if (user.role === 'Employee' && ticket.created_by !== user.id) {
        return res.status(403).json({ error: 'Access denied: You can only view your own tickets.' });
      }

      res.json({
        ...mapTicket(ticket),
        slaPolicy: result.slaPolicy,
        comments: result.comments.map(mapComment),
        timeline: result.timeline.map(mapTimeline),
        attachments: result.attachments.map(mapAttachment)
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
    // Existing tickets carry departments outside the helpdesk queues (e.g. Finance), so
    // this only constrains new ones.
    if (!knowledgeBase.HELPDESK_DEPARTMENTS.includes(department)) {
      return res.status(400).json({ error: `Department must be one of: ${knowledgeBase.HELPDESK_DEPARTMENTS.join(', ')}` });
    }

    // SLA deadlines are database-driven: match the most specific active policy and walk its
    // business calendar. computeDeadlines never throws — an unmatched ticket falls back to a
    // 24h wall-clock resolution — so ticket creation cannot be blocked by SLA config.
    const branch = req.body.branch || null;
    const assetType = req.body.assetType || req.body.asset_type || null;
    const createdAt = new Date();
    let sla;
    try {
      sla = await slaModel.computeDeadlines({ priority, category: category || 'Software', department, assetType, branch }, createdAt);
    } catch (slaErr) {
      console.error('[sla] deadline computation failed, defaulting to 24h:', slaErr.message);
      sla = { policy: null, policyId: null, firstResponseDue: null, resolutionDue: new Date(createdAt.getTime() + 24 * 3600 * 1000) };
    }
    // sla_deadline is kept in sync with resolution_due so the existing analytics and breach
    // scheduler (which read sla_deadline) keep working unchanged.
    const slaDeadline = sla.resolutionDue;

    // Auto-assignment, if the governing policy asks for it. Picked here (from a snapshot) and
    // applied inside the create mutation so a created ticket is never briefly unassigned.
    let autoAssign;
    if (sla.policy && sla.policy.auto_assign_enabled) {
      try {
        const agent = await slaAssignment.pickAgent({ department }, sla.policy.auto_assign_strategy);
        if (agent) {
          autoAssign = { agent: { id: agent.id, name: agent.name, workload: agent.workload }, strategyLabel: String(sla.policy.auto_assign_strategy).replace('_', ' ') };
        }
      } catch (assignErr) {
        console.error('[sla] auto-assignment failed:', assignErr.message);
      }
    }

    try {
      // The Convex client does not accept Date objects — the SLA engine returns Dates, so
      // serialise the deadlines to ISO strings (the stored/mirrored shape) here.
      const iso = (d) => (d == null ? null : new Date(d).toISOString());
      const { ticket, autoAssigned } = await cm('tickets:create', {
        ticket: {
          subject, description, department, priority, category: category || 'Software', ticket_type: ticketType,
          created_by: user.id, created_by_name: user.name, sla_deadline: iso(slaDeadline),
          sla_policy_id: sla.policyId, first_response_due: iso(sla.firstResponseDue), resolution_due: iso(sla.resolutionDue),
          branch, asset_type: assetType
        },
        attachments: Array.isArray(attachments) ? attachments : [],
        autoAssign: autoAssign || null,
        actorName: user.name
      });

      await logAction(user.name, 'Ticket Creation', `Created Ticket ${ticket.ticket_id} in ${department} department`);

      // Dispatched after commit; not awaited — a slow SMTP server should not delay the
      // response, and a notification failure must not fail the request.
      notifications.notify('ticket.created', `ticket-created:${ticket.id}`, {
        ticketId: ticket.ticket_id, subject, description, department, priority,
        createdBy: user.id, createdByName: user.name, slaDeadline
      });
      if (autoAssigned) {
        notifications.notify('ticket.assigned', `ticket-assigned:${ticket.id}:${autoAssigned.id}`, {
          ticketId: ticket.ticket_id, subject, department, priority, slaDeadline,
          assignedTo: autoAssigned.id, assignedToName: autoAssigned.name, createdBy: user.id
        });
      }

      res.status(201).json(mapTicket(ticket));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Ticket creation failed: ' + err.message });
    }
  });

  app.post('/api/tickets/:id/comments', async (req, res) => {
    const { id } = req.params;
    const commentText = req.body.commentText || req.body.comment_text;
    const isInternal = req.body.isInternal !== undefined ? req.body.isInternal : req.body.is_internal;
    const user = requireUser(req, res);
    if (!user) return;

    if (!commentText) return res.status(400).json({ error: 'Comment text is required.' });

    const isInt = !!isInternal;
    if (isInt && !(await roleCan(user, 'tickets', 'edit'))) {
      return res.status(403).json({ error: 'Your role is not permitted to post internal comments.' });
    }

    try {
      const comment = await cm('tickets:addComment', {
        id: String(id), authorName: user.name, authorId: user.id != null ? String(user.id) : undefined,
        commentText, isInternal: isInt
      });
      if (!comment) return res.status(404).json({ error: 'Ticket not found' });
      res.status(201).json(comment);
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
    if (!(await roleCan(user, 'tickets', 'edit'))) return res.status(403).json({ error: 'Your role is not permitted to assign tickets.' });

    try {
      let targetName = user.name;
      let targetId = user.id;
      if (assignToUserId) {
        const target = await cq('users:getByWorkosId', { workosUserId: assignToUserId });
        if (!target) return res.status(400).json({ error: 'Target user not found.' });
        targetName = target.name;
        targetId = target.workos_user_id;
      }

      const result = await cm('tickets:assign', { id: String(id), targetId: String(targetId), targetName, actorName: user.name });
      if (!result) return res.status(404).json({ error: 'Ticket not found' });
      const { ticket, isReassignment, previousAssignee, previousAssigneeName } = result;

      await logAction(user.name, 'Ticket Assignment', `Assigned Ticket ${ticket.ticket_id} to ${targetName}`);

      notifications.notify('ticket.assigned', `ticket-assigned:${ticket.id}:${targetId}`, {
        ticketId: ticket.ticket_id, subject: ticket.subject, department: ticket.department,
        priority: ticket.priority, slaDeadline: ticket.sla_deadline,
        assignedTo: targetId, assignedToName: targetName, createdBy: ticket.created_by
      });
      if (isReassignment) {
        notifications.notify('ticket.reassigned', `ticket-reassigned:${ticket.id}:${previousAssignee}:${targetId}`, {
          ticketId: ticket.ticket_id, subject: ticket.subject, department: ticket.department, priority: ticket.priority,
          previousAssignee, previousAssigneeName, assignedTo: targetId, assignedToName: targetName, actorName: user.name
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
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status value.' });

    try {
      if (user.role === 'Employee') {
        const existing = await cq('tickets:find', { id: String(id) });
        if (!existing) return res.status(404).json({ error: 'Ticket not found' });
        if (existing.created_by !== user.id) return res.status(403).json({ error: 'Employees can only close their own tickets.' });
      }

      const result = await cm('tickets:setStatus', { id: String(id), status, actorName: user.name });
      if (!result) return res.status(404).json({ error: 'Ticket not found' });
      const { ticket, prevStatus } = result;

      await logAction(user.name, 'Ticket Status Update', `Updated Ticket ${ticket.ticket_id} status from ${prevStatus} to ${status}`);

      // Resolved/Closed are distinct events; moving out of either back to an active state is a
      // reopen; everything else is a plain status change. The event key includes the new
      // status + updated_at so each transition announces once and retries dedupe.
      const isReopen = ['Resolved', 'Closed'].includes(prevStatus) && !['Resolved', 'Closed'].includes(status);
      const eventType =
        isReopen ? 'ticket.reopened' :
        status === 'Resolved' ? 'ticket.resolved' :
        status === 'Closed' ? 'ticket.closed' :
        'ticket.status_changed';
      const eventKey = `ticket-status:${ticket.id}:${status}:${new Date(ticket.updated_at).toISOString()}`;

      notifications.notify(eventType, eventKey, {
        ticketId: ticket.ticket_id, subject: ticket.subject, department: ticket.department,
        priority: ticket.priority, status, previousStatus: prevStatus, actorName: user.name,
        createdBy: ticket.created_by, assignedTo: ticket.assigned_to, assignedToName: ticket.assigned_to_name
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
      const result = await cm('tickets:setPriority', { id: String(id), priority, actorName: user.name });
      if (!result) return res.status(404).json({ error: 'Ticket not found' });
      const { ticket, prevPriority } = result;

      notifications.notify('ticket.priority_changed', `ticket-priority:${ticket.id}:${priority}:${Date.now()}`, {
        ticketId: ticket.ticket_id, subject: ticket.subject, department: ticket.department,
        priority, previousPriority: prevPriority, actorName: user.name,
        createdBy: ticket.created_by, assignedTo: ticket.assigned_to, assignedToName: ticket.assigned_to_name
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
      const result = await cm('tickets:setCategory', { id: String(id), category, actorName: user.name });
      if (!result) return res.status(404).json({ error: 'Ticket not found' });
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
      const result = await cm('tickets:setDepartment', { id: String(id), department, actorName: user.name });
      if (!result) return res.status(404).json({ error: 'Ticket not found' });
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
      const ticket = await cq('tickets:find', { id: String(id) });
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

      // Honour the governing policy's strategy if it has one; default to least-loaded.
      let strategy = 'least_loaded';
      if (ticket.sla_policy_id) {
        const pol = await cq('generic:get', { table: 'sla_policies', idField: 'id', idVal: ticket.sla_policy_id });
        if (pol && pol.auto_assign_strategy) strategy = pol.auto_assign_strategy;
      }

      const agent = await slaAssignment.pickAgent({ department: ticket.department }, strategy);
      if (!agent) return res.status(400).json({ error: 'No eligible agents found for auto-assignment.' });

      const detail = `Auto-assigned ticket to ${agent.name} (${String(strategy).replace('_', ' ')}, ${agent.workload} active ticket(s))`;
      const result = await cm('tickets:assign', { id: String(id), targetId: String(agent.id), targetName: agent.name, actorName: user.name, detail });
      if (!result) return res.status(404).json({ error: 'Ticket not found' });

      notifications.notify('ticket.assigned', `ticket-assigned:${result.ticket.id}:${agent.id}`, {
        ticketId: result.ticket.ticket_id, subject: result.ticket.subject, department: result.ticket.department,
        priority: result.ticket.priority, slaDeadline: result.ticket.sla_deadline,
        assignedTo: agent.id, assignedToName: agent.name, createdBy: result.ticket.created_by
      });

      res.json({ message: 'Ticket auto-assigned successfully', assignedToName: agent.name });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Auto-assignment failed' });
    }
  });

  app.get('/api/tickets-analytics', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const args = user.role !== 'Super Admin' ? { department: user.department } : {};
      res.json(await cq('tickets:analytics', args));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch analytics' });
    }
  });
}

module.exports = { register };
