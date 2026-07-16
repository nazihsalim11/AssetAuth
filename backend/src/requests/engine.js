/**
 * The Request Engine — one approval workflow for every module.
 *
 * Nothing here knows what a purchase order is. A request names a `request_type`, the registry
 * turns that into "which record, which fields, how to apply", and this file runs the same
 * lifecycle over it regardless. That is the whole point: a future module reuses this by
 * adding a registry entry, not by writing another approval path.
 *
 * Composed of the pieces the brief asks for, kept as separate concerns rather than one blob:
 *   - Status Engine     TRANSITIONS + canTransition  (pure, tested)
 *   - Approval Engine   the approver ladder: levelsFor / advance / decide  (pure, tested)
 *   - Diff Engine       ./diff.js  (pure, tested)
 *   - Workflow Engine   create/submit/approve/reject/... below, orchestrating the above
 *   - Audit Service     every mutation writes an append-only request_history line, in the
 *                       same Convex transaction as the change it describes
 *   - Notification Svc  ./notify.js, over the existing dispatcher
 *   - Attachment Svc    addAttachment/replaceAttachment/removeAttachment below
 *
 * Concurrency: every state change goes through Convex `requests:act`, which compare-and-sets
 * on updated_at. Two approvers clicking Approve at the same instant cannot both advance the
 * ladder — the loser gets a 409 and reloads. This matters most on the final level, where a
 * lost update would mean applying an approved change twice.
 */

const { cq, cm } = require('../../convexApi');
const registry = require('./registry');
const diff = require('./diff');
const idGenerator = require('../services/idGenerator');
const notify = require('./notify');

/* ============================================================ status engine */

const STATUSES = [
  'Draft', 'Pending Approval', 'Under Review', 'Approved', 'Rejected', 'Cancelled', 'Completed',
];

// Open = still consuming someone's attention; used for the dashboards, the overdue sweep, and
// the "one open request per record" guard.
const OPEN_STATUSES = ['Draft', 'Pending Approval', 'Under Review'];
const TERMINAL_STATUSES = ['Rejected', 'Cancelled', 'Completed'];

// from -> allowed to. Approved is transient: an approved request applies its changes and
// lands on Completed in the same call. It is a distinct status because an apply that fails
// must leave the request visibly Approved-but-not-applied rather than silently Rejected.
const TRANSITIONS = {
  'Draft': ['Pending Approval', 'Cancelled'],
  'Pending Approval': ['Under Review', 'Approved', 'Rejected', 'Cancelled'],
  'Under Review': ['Pending Approval', 'Approved', 'Rejected', 'Cancelled'],
  'Approved': ['Completed'],
  'Rejected': [],
  'Cancelled': [],
  'Completed': [],
};

const canTransition = (from, to) => Boolean(TRANSITIONS[from]?.includes(to));

const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];

const nowIso = () => new Date().toISOString();
const err = (message, statusCode) => Object.assign(new Error(message), { statusCode });

/* ========================================================== approval engine */

/**
 * Normalise a submitted approver list into the stored ladder. Levels are renumbered 1..n in
 * the order given, so a caller cannot create a ladder with a gap (level 1 then level 3) that
 * would strand the request on a level nobody is assigned to.
 */
function buildLadder(approvers = []) {
  const byLevel = new Map();
  for (const a of approvers) {
    const level = Number(a.level) || 1;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(a);
  }
  const ordered = [...byLevel.keys()].sort((x, y) => x - y);
  const out = [];
  ordered.forEach((original, index) => {
    for (const a of byLevel.get(original)) {
      out.push({
        level: index + 1,
        user_id: String(a.userId ?? a.user_id),
        user_name: a.userName ?? a.user_name ?? null,
        status: 'Pending',
        acted_at: null,
        comment: null,
      });
    }
  });
  return out;
}

const levelsIn = (ladder) => (ladder.length ? Math.max(...ladder.map((a) => Number(a.level))) : 0);

const approversAt = (ladder, level) => ladder.filter((a) => Number(a.level) === Number(level));

/** Is this user an approver on the level the request is currently sitting on? */
const isCurrentApprover = (request, userId) =>
  approversAt(request.approvers || [], request.current_level).some(
    (a) => String(a.user_id) === String(userId) && a.status === 'Pending'
  );

/**
 * Record one approver's decision and work out what it means for the request.
 *
 * A level clears only when every approver on it has approved — a two-person level is a
 * two-signature level, not a race. One rejection anywhere ends the request immediately;
 * that is deliberate, a rejection is a veto, not a vote.
 *
 * Pure: takes the ladder, returns the new ladder plus the resulting level/outcome.
 */
function decide(ladder, level, userId, decision, comment) {
  const at = nowIso();
  const next = ladder.map((a) =>
    Number(a.level) === Number(level) && String(a.user_id) === String(userId) && a.status === 'Pending'
      ? { ...a, status: decision, acted_at: at, comment: comment ?? null }
      : a
  );

  if (decision === 'Rejected') return { ladder: next, level, outcome: 'rejected' };

  const levelCleared = approversAt(next, level).every((a) => a.status === 'Approved');
  if (!levelCleared) return { ladder: next, level, outcome: 'pending' };

  const total = levelsIn(next);
  if (Number(level) >= total) return { ladder: next, level, outcome: 'approved' };
  return { ladder: next, level: Number(level) + 1, outcome: 'advanced' };
}

/* ================================================================= mapping */

const mapAttachment = (r) => ({
  id: r.id,
  fileName: r.file_name,
  filePath: r.file_path,
  fileType: r.file_type,
  fileSize: r.file_size,
  docType: r.doc_type,
  uploadedBy: r.uploaded_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at ?? null,
});

const mapComment = (r) => ({
  id: r.id,
  body: r.body,
  author: r.author,
  authorName: r.author_name,
  createdAt: r.created_at,
});

const mapHistory = (r) => ({
  id: r.id,
  action: r.action,
  detail: r.detail,
  actor: r.actor,
  actorName: r.actor_name,
  changes: r.changes,
  fromStatus: r.from_status,
  toStatus: r.to_status,
  createdAt: r.created_at,
});

const isOverdue = (r) =>
  Boolean(r.due_date) && OPEN_STATUSES.includes(r.status) && new Date(r.due_date) < new Date();

const mapRequest = (r) => ({
  id: r.id,
  requestType: r.request_type,
  requestTypeLabel: registry.TYPES[r.request_type]?.label || r.request_type,
  module: r.module,
  recordId: r.record_id,
  recordLabel: r.record_label,
  requestedBy: r.requested_by,
  requestedByName: r.requested_by_name,
  requestedOn: r.requested_on,
  approvers: (r.approvers || []).map((a) => ({
    level: a.level,
    userId: a.user_id,
    userName: a.user_name,
    status: a.status,
    actedAt: a.acted_at,
    comment: a.comment,
  })),
  currentLevel: r.current_level,
  totalLevels: r.total_levels,
  status: r.status,
  priority: r.priority,
  reason: r.reason,
  description: r.description,
  proposedChanges: r.proposed_changes,
  changes: r.changes_preview || [],
  appliedChanges: r.applied_changes || null,
  applyError: r.apply_error || null,
  dueDate: r.due_date,
  overdue: isOverdue(r),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

/* ================================================================ workflow */

/**
 * `resolveDefaultApprovers` is injected by the route layer (it needs the role/permission
 * lookups that live in the auth middleware). Keeping it out of here means the engine has no
 * dependency on Express or on how permissions are stored, and stays unit-testable.
 */
let resolveDefaultApprovers = async () => [];
function configure({ defaultApprovers }) {
  if (defaultApprovers) resolveDefaultApprovers = defaultApprovers;
}

async function get(id) {
  const detail = await cq('requests:detail', { id });
  if (!detail) return null;
  return {
    ...mapRequest(detail.request),
    comments: detail.comments.map(mapComment),
    attachments: detail.attachments.map(mapAttachment),
    history: detail.history.map(mapHistory),
  };
}

/** Raw row, for the guards that need current status/updated_at without the child rows. */
async function rawOrThrow(id) {
  const detail = await cq('requests:detail', { id });
  if (!detail) throw err(`Request ${id} not found`, 404);
  return detail.request;
}

async function list(filters = {}) {
  const rows = await cq('requests:list', {
    status: filters.status?.length ? filters.status : undefined,
    requestType: filters.requestType || undefined,
    module: filters.module || undefined,
    requestedBy: filters.requestedBy || undefined,
    approverId: filters.approverId || undefined,
    recordId: filters.recordId != null ? String(filters.recordId) : undefined,
  });
  let out = rows.map(mapRequest);
  if (filters.overdue) out = out.filter((r) => r.overdue);
  if (filters.q) {
    const q = String(filters.q).toLowerCase();
    out = out.filter((r) =>
      [r.id, r.recordLabel, r.requestedByName, r.reason, r.requestTypeLabel]
        .some((v) => String(v ?? '').toLowerCase().includes(q))
    );
  }
  return out;
}

/**
 * Create a request. `submit: false` leaves it in Draft (nobody is notified, nothing is
 * assigned); the default submits it straight into the approval ladder.
 */
async function create(input, user) {
  const descriptor = registry.descriptorFor(input.requestType);

  if (input.priority && !PRIORITIES.includes(input.priority)) {
    throw err(`Priority must be one of: ${PRIORITIES.join(', ')}`, 400);
  }
  if (!input.recordId && input.recordId !== 0) throw err('A target record is required', 400);
  if (!input.reason || !String(input.reason).trim()) throw err('A reason is required', 400);

  const record = await registry.loadRecord(input.requestType, input.recordId);
  if (!record) throw err(`The ${descriptor.label} target record no longer exists`, 404);

  // A second open request against the same record would mean two reviewers approving
  // conflicting edits to the same fields, each diffed against a `before` the other is about
  // to invalidate. One at a time.
  const open = await cq('requests:openForRecord', {
    module: descriptor.module,
    recordId: String(input.recordId),
    requestType: input.requestType,
  });
  if (open.length) {
    throw err(
      `${open[0].id} is already open against ${record.__label}. Resolve it before raising another.`,
      409
    );
  }

  // Whitelist the proposal against the type's declared fields, then fold in whatever the
  // type always does (a disposal request sets status=Disposed; the requester never says so).
  const proposed = {
    ...diff.pickAllowed(input.proposedChanges || {}, descriptor.fields),
    ...(descriptor.fixedChanges || {}),
  };
  const changes = diff.diffFields(record, proposed, registry.allFields(descriptor));
  if (!changes.length) {
    throw err('This request would not change anything on the record', 400);
  }

  const ladder = buildLadder(
    input.approvers?.length ? input.approvers : await resolveDefaultApprovers(descriptor, user)
  );
  if (!ladder.length) {
    throw err(
      'No approver could be assigned. Pick one explicitly, or grant a role approval rights on Requests.',
      400
    );
  }

  const { nextId } = await idGenerator.reserve('request');
  const status = input.submit === false ? 'Draft' : 'Pending Approval';

  const created = await cm('requests:create', {
    request: {
      id: nextId,
      request_type: input.requestType,
      module: descriptor.module,
      record_id: String(input.recordId),
      record_label: record.__label,
      requested_by: user.id != null ? String(user.id) : null,
      requested_by_name: user.name,
      requested_on: nowIso(),
      approvers: ladder,
      current_level: 1,
      total_levels: levelsIn(ladder),
      status,
      priority: input.priority || 'Medium',
      reason: String(input.reason).trim(),
      description: input.description || null,
      proposed_changes: proposed,
      changes_preview: changes,
      applied_changes: null,
      due_date: input.dueDate || null,
      completed_at: null,
    },
    attachments: input.attachments || [],
  });

  const mapped = mapRequest(created);
  if (status === 'Pending Approval') {
    await notify.submitted(mapped);
    await notify.approvalRequested(mapped, approversAt(ladder, 1));
  }
  return get(nextId);
}

/** Draft -> Pending Approval. */
async function submit(id, user) {
  const row = await rawOrThrow(id);
  if (String(row.requested_by) !== String(user.id)) {
    throw err('Only the requester can submit this request', 403);
  }
  if (!canTransition(row.status, 'Pending Approval')) {
    throw err(`A ${row.status} request cannot be submitted`, 400);
  }

  await cm('requests:act', {
    id,
    expectedUpdatedAt: row.updated_at,
    patch: { status: 'Pending Approval' },
    history: {
      action: 'Request Submitted',
      detail: `Sent for approval at level 1`,
      actor: user.id != null ? String(user.id) : null,
      actorName: user.name,
    },
  });

  const request = await get(id);
  await notify.submitted(request);
  await notify.approvalRequested(request, approversAt(row.approvers || [], 1));
  return request;
}

/**
 * Approve at the caller's level. On the final level this also applies the change — the
 * request is only Completed once the target record actually took the edit.
 */
async function approve(id, user, { comment } = {}) {
  const row = await rawOrThrow(id);
  if (!canTransition(row.status, 'Approved')) {
    throw err(`A ${row.status} request cannot be approved`, 400);
  }
  if (!isCurrentApprover(row, user.id)) {
    throw err('You are not an assigned approver at this request’s current level', 403);
  }

  const result = decide(row.approvers || [], row.current_level, user.id, 'Approved', comment);

  if (result.outcome === 'advanced') {
    await cm('requests:act', {
      id,
      expectedUpdatedAt: row.updated_at,
      patch: { approvers: result.ladder, current_level: result.level, status: 'Pending Approval' },
      history: {
        action: 'Approved at level ' + row.current_level,
        detail: comment || `Advanced to approval level ${result.level}`,
        actor: String(user.id),
        actorName: user.name,
      },
    });
    const request = await get(id);
    await notify.approvalRequested(request, approversAt(result.ladder, result.level));
    return request;
  }

  if (result.outcome === 'pending') {
    await cm('requests:act', {
      id,
      expectedUpdatedAt: row.updated_at,
      patch: { approvers: result.ladder },
      history: {
        action: 'Approved at level ' + row.current_level,
        detail: comment || 'Awaiting the other approvers on this level',
        actor: String(user.id),
        actorName: user.name,
      },
    });
    return get(id);
  }

  // Final level cleared. Mark Approved first, so an apply that throws leaves an auditable
  // Approved-but-unapplied request rather than a silent no-op or a bogus Rejected.
  await cm('requests:act', {
    id,
    expectedUpdatedAt: row.updated_at,
    patch: { approvers: result.ladder, status: 'Approved' },
    history: {
      action: 'Request Approved',
      detail: comment || 'Final approval granted',
      actor: String(user.id),
      actorName: user.name,
      changes: row.changes_preview,
    },
  });

  return complete(id, user);
}

/**
 * Apply an approved request's changes and close it. Split out of approve() so a failed apply
 * can be retried without re-running the approval ladder.
 *
 * The diff is recomputed against the record as it is *now*, not as it was at submission: a
 * proposal captured last week must not silently clobber a field someone legitimately changed
 * since. Fields that already hold the proposed value simply drop out of the diff.
 */
async function complete(id, user) {
  const row = await rawOrThrow(id);
  if (row.status !== 'Approved') throw err(`A ${row.status} request cannot be applied`, 400);

  const descriptor = registry.descriptorFor(row.request_type);
  const record = await registry.loadRecord(row.request_type, row.record_id);
  if (!record) throw err('The target record no longer exists — nothing to apply', 409);

  const changes = diff.diffFields(record, row.proposed_changes || {}, registry.allFields(descriptor));

  try {
    if (changes.length) {
      await registry.applyChanges(row.request_type, record, changes, { actor: user.name, user });
    }
  } catch (e) {
    // Leave it Approved and say why. The alternative — swallowing this — is a request that
    // claims Completed while the record never changed.
    await cm('requests:act', {
      id,
      expectedUpdatedAt: row.updated_at,
      patch: { apply_error: e.message },
      history: {
        action: 'Apply Failed',
        detail: e.message,
        actor: user.id != null ? String(user.id) : null,
        actorName: user.name,
      },
    });
    throw err(`Approved, but the changes could not be applied: ${e.message}`, 502);
  }

  const fresh = await rawOrThrow(id);
  await cm('requests:act', {
    id,
    expectedUpdatedAt: fresh.updated_at,
    patch: {
      status: 'Completed',
      completed_at: nowIso(),
      applied_changes: changes,
      apply_error: null,
    },
    history: {
      action: 'Changes Applied',
      detail: changes.length ? diff.summarize(changes) : 'Record already matched the proposal',
      actor: user.id != null ? String(user.id) : null,
      actorName: user.name,
      changes,
    },
  });

  await logAction(user.name, `${descriptor.label} Applied`, `${id}: ${diff.summarize(changes)}`);

  const request = await get(id);
  await notify.approved(request);
  return request;
}

async function reject(id, user, { comment } = {}) {
  const row = await rawOrThrow(id);
  if (!canTransition(row.status, 'Rejected')) {
    throw err(`A ${row.status} request cannot be rejected`, 400);
  }
  if (!isCurrentApprover(row, user.id)) {
    throw err('You are not an assigned approver at this request’s current level', 403);
  }
  if (!comment || !String(comment).trim()) {
    throw err('A reason is required when rejecting a request', 400);
  }

  const result = decide(row.approvers || [], row.current_level, user.id, 'Rejected', comment);
  await cm('requests:act', {
    id,
    expectedUpdatedAt: row.updated_at,
    patch: { approvers: result.ladder, status: 'Rejected', completed_at: nowIso() },
    history: {
      action: 'Request Rejected',
      detail: comment,
      actor: String(user.id),
      actorName: user.name,
    },
  });

  const request = await get(id);
  await notify.rejected(request, comment);
  return request;
}

/** Approver asks the requester for more information. Pauses the ladder, does not reset it. */
async function requestInfo(id, user, { comment } = {}) {
  const row = await rawOrThrow(id);
  if (!canTransition(row.status, 'Under Review')) {
    throw err(`More information cannot be requested on a ${row.status} request`, 400);
  }
  if (!isCurrentApprover(row, user.id)) {
    throw err('You are not an assigned approver at this request’s current level', 403);
  }
  if (!comment || !String(comment).trim()) {
    throw err('Say what information is needed', 400);
  }

  await cm('requests:act', {
    id,
    expectedUpdatedAt: row.updated_at,
    patch: { status: 'Under Review' },
    history: {
      action: 'Information Requested',
      detail: comment,
      actor: String(user.id),
      actorName: user.name,
    },
  });

  const request = await get(id);
  await notify.infoRequested(request, comment);
  return request;
}

/** Requester answers an information request and puts it back in the queue. */
async function respond(id, user, { comment } = {}) {
  const row = await rawOrThrow(id);
  if (String(row.requested_by) !== String(user.id)) {
    throw err('Only the requester can respond to an information request', 403);
  }
  if (!canTransition(row.status, 'Pending Approval')) {
    throw err(`A ${row.status} request is not awaiting information`, 400);
  }

  await cm('requests:act', {
    id,
    expectedUpdatedAt: row.updated_at,
    patch: { status: 'Pending Approval' },
    history: {
      action: 'Information Provided',
      detail: comment || 'Requester responded',
      actor: String(user.id),
      actorName: user.name,
    },
  });

  const request = await get(id);
  await notify.approvalRequested(request, approversAt(row.approvers || [], row.current_level));
  return request;
}

/** Move a pending approval slot to someone else. The level and the ladder shape are kept. */
async function reassign(id, user, { toUserId, toUserName, level, comment } = {}) {
  const row = await rawOrThrow(id);
  if (!OPEN_STATUSES.includes(row.status)) {
    throw err(`A ${row.status} request cannot be reassigned`, 400);
  }
  if (!toUserId) throw err('A new approver is required', 400);

  const target = Number(level) || row.current_level;
  const ladder = row.approvers || [];
  const slot = ladder.find((a) => Number(a.level) === target && a.status === 'Pending');
  if (!slot) throw err(`There is no pending approval at level ${target} to reassign`, 400);

  let replaced = false;
  const next = ladder.map((a) => {
    if (replaced || a !== slot) return a;
    replaced = true;
    return { ...a, user_id: String(toUserId), user_name: toUserName || String(toUserId) };
  });

  await cm('requests:act', {
    id,
    expectedUpdatedAt: row.updated_at,
    patch: { approvers: next },
    history: {
      action: 'Approver Reassigned',
      detail: `Level ${target}: ${slot.user_name || slot.user_id} → ${toUserName || toUserId}${comment ? ` (${comment})` : ''}`,
      actor: user.id != null ? String(user.id) : null,
      actorName: user.name,
    },
  });

  const request = await get(id);
  await notify.assigned(request, [{ user_id: String(toUserId), user_name: toUserName }]);
  return request;
}

async function cancel(id, user, { comment } = {}) {
  const row = await rawOrThrow(id);
  if (!canTransition(row.status, 'Cancelled')) {
    throw err(`A ${row.status} request cannot be cancelled`, 400);
  }

  await cm('requests:act', {
    id,
    expectedUpdatedAt: row.updated_at,
    patch: { status: 'Cancelled', completed_at: nowIso() },
    history: {
      action: 'Request Cancelled',
      detail: comment || 'Cancelled',
      actor: user.id != null ? String(user.id) : null,
      actorName: user.name,
    },
  });

  const request = await get(id);
  await notify.cancelled(request);
  return request;
}

/* ---------------------------------------------------- comments & documents */

async function comment(id, user, body) {
  if (!body || !String(body).trim()) throw err('A comment cannot be empty', 400);
  await rawOrThrow(id);
  await cm('requests:addComment', {
    id,
    body: String(body).trim(),
    actor: user.id != null ? String(user.id) : null,
    actorName: user.name,
  });
  const request = await get(id);
  await notify.commentAdded(request, user.name, String(body).trim());
  return request;
}

async function addAttachment(id, user, attachment) {
  if (!attachment?.filePath && !attachment?.fileUrl) throw err('A stored file path is required', 400);
  await rawOrThrow(id);
  await cm('requests:addAttachment', {
    id, attachment, actor: user.id != null ? String(user.id) : null, actorName: user.name,
  });
  return get(id);
}

async function replaceAttachment(id, user, attachmentId, attachment) {
  if (!attachment?.filePath && !attachment?.fileUrl) throw err('A stored file path is required', 400);
  await rawOrThrow(id);
  await cm('requests:replaceAttachment', {
    id,
    attachmentId: Number(attachmentId),
    attachment,
    actor: user.id != null ? String(user.id) : null,
    actorName: user.name,
  });
  return get(id);
}

async function removeAttachment(id, user, attachmentId) {
  await rawOrThrow(id);
  await cm('requests:removeAttachment', {
    id,
    attachmentId: Number(attachmentId),
    actor: user.id != null ? String(user.id) : null,
    actorName: user.name,
  });
  return get(id);
}

async function remove(id, user) {
  const row = await rawOrThrow(id);
  const removed = await cm('requests:remove', { id });
  await logAction(user.name, 'Request Deleted', `${id} (${row.request_type}, ${row.status})`);
  return removed;
}

/* ----------------------------------------------------------------- helpers */

const logAction = (actor, action, detail) =>
  cm('logs:add', { actor, action, detail }).catch((e) =>
    console.warn('[requests] log failed:', e.message)
  );

/** The before/after view a reviewer sees, recomputed live against the current record. */
async function comparison(id) {
  const row = await rawOrThrow(id);
  const descriptor = registry.descriptorFor(row.request_type);
  const record = await registry.loadRecord(row.request_type, row.record_id);
  if (!record) return { changes: row.changes_preview || [], stale: true, recordMissing: true };

  const live = diff.diffFields(record, row.proposed_changes || {}, registry.allFields(descriptor));
  // The record moved under the request if what it would change now differs from what it said
  // it would change at submission. Reviewers should see that before they approve.
  const stale = JSON.stringify(live) !== JSON.stringify(row.changes_preview || []);
  return { changes: live, submitted: row.changes_preview || [], stale, recordMissing: false };
}

module.exports = {
  configure, create, submit, approve, reject, requestInfo, respond, reassign, cancel,
  complete, comment, addAttachment, replaceAttachment, removeAttachment, remove,
  get, list, comparison,
  // Pure pieces, exported for tests and for reuse by future modules.
  STATUSES, OPEN_STATUSES, TERMINAL_STATUSES, TRANSITIONS, canTransition, PRIORITIES,
  buildLadder, decide, levelsIn, approversAt, isCurrentApprover, mapRequest,
};
