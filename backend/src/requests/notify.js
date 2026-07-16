/**
 * Request notifications — an adapter, not a second notification system.
 *
 * Every function here funnels into the existing dispatcher (backend/notifications), so
 * requests inherit the whole framework for free: per-event channel preferences, the
 * configurable recipient matrix, in-app + email + SMS rendering from one template, delivery
 * records, dedup and retry.
 *
 * Event keys are deterministic (`req:<id>:<event>[:<discriminator>]`) because the dispatcher
 * dedups on them: a retried HTTP call, or a second approval on the same level, cannot notify
 * the same person twice about the same thing. Where an event legitimately recurs — a comment,
 * a reassignment — the key carries a discriminator so the second one still gets through.
 *
 * `explicitRecipients` names the people a request event is actually about (its approvers,
 * its requester) rather than leaving the dispatcher to fall back on "tell the admins", which
 * is the wrong audience for an approval queue.
 */

const notifications = require('../../notifications');

const ctxOf = (request) => ({
  requestId: request.id,
  requestType: request.requestType,
  requestTypeLabel: request.requestTypeLabel,
  module: request.module,
  recordLabel: request.recordLabel,
  recordId: request.recordId,
  status: request.status,
  priority: request.priority,
  reason: request.reason,
  description: request.description,
  requestedBy: request.requestedBy,
  requestedByName: request.requestedByName,
  currentLevel: request.currentLevel,
  totalLevels: request.totalLevels,
  dueDate: request.dueDate,
  changes: request.changes || [],
  changeCount: (request.changes || []).length,
});

const send = (eventType, key, ctx) => notifications.notify(eventType, key, ctx);

const idsOf = (approvers = []) => approvers.map((a) => String(a.user_id ?? a.userId)).filter(Boolean);

/** Raised and sent for approval. Goes to the requester (confirmation) + the module's admins. */
const submitted = (request) =>
  send('request.submitted', `req:${request.id}:submitted`, {
    ...ctxOf(request),
    explicitRecipients: [request.requestedBy].filter(Boolean),
  });

/** A level became active: the approvers on it now owe someone a decision. */
const approvalRequested = (request, approvers) =>
  send('request.approval_requested', `req:${request.id}:approval:L${request.currentLevel}`, {
    ...ctxOf(request),
    approverNames: (approvers || []).map((a) => a.user_name ?? a.userName).filter(Boolean).join(', '),
    explicitRecipients: idsOf(approvers),
  });

/** A specific person was handed the slot (reassignment). Keyed per assignee, per level. */
const assigned = (request, approvers) =>
  send(
    'request.assigned',
    `req:${request.id}:assigned:L${request.currentLevel}:${idsOf(approvers).join(',')}`,
    {
      ...ctxOf(request),
      approverNames: (approvers || []).map((a) => a.user_name ?? a.userName).filter(Boolean).join(', '),
      explicitRecipients: idsOf(approvers),
    }
  );

const approved = (request) =>
  send('request.approved', `req:${request.id}:approved`, {
    ...ctxOf(request),
    appliedChanges: request.appliedChanges || [],
    explicitRecipients: [request.requestedBy, ...idsOf(request.approvers)].filter(Boolean),
  });

const rejected = (request, comment) =>
  send('request.rejected', `req:${request.id}:rejected`, {
    ...ctxOf(request),
    comment,
    explicitRecipients: [request.requestedBy].filter(Boolean),
  });

const cancelled = (request) =>
  send('request.cancelled', `req:${request.id}:cancelled`, {
    ...ctxOf(request),
    explicitRecipients: [request.requestedBy, ...idsOf(request.approvers)].filter(Boolean),
  });

const infoRequested = (request, comment) =>
  send('request.info_requested', `req:${request.id}:info:${Date.now()}`, {
    ...ctxOf(request),
    comment,
    explicitRecipients: [request.requestedBy].filter(Boolean),
  });

// Comments recur by nature, so the key carries the timestamp — deduping them would mean
// only the first comment on a request ever reached anyone.
const commentAdded = (request, authorName, body) =>
  send('request.comment_added', `req:${request.id}:comment:${Date.now()}`, {
    ...ctxOf(request),
    authorName,
    comment: body,
    explicitRecipients: [request.requestedBy, ...idsOf(request.approvers)].filter(Boolean),
  });

module.exports = {
  submitted, approvalRequested, assigned, approved, rejected, cancelled, infoRequested,
  commentAdded,
};
