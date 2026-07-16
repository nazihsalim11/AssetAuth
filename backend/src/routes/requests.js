/**
 * Requests API — the HTTP surface of the generic approval engine.
 *
 * The routes are type-agnostic: every one of them takes a request id or a request_type and
 * lets backend/src/requests/{engine,registry}.js decide what that means. A new workflow needs
 * a registry entry, not a route.
 *
 * Two permission checks apply to every request, not one:
 *   - `requests.<verb>` — may this role take part in approval workflows at all?
 *   - view on the *target* module — may this role see the record being changed?
 * The second matters: without it, "raise a request to edit vendor X" would leak vendor X's
 * current values, via the diff, to a role with no vendor access at all. A request must never
 * be a side door into a record.
 *
 * Visibility: a role with `requests.view` but no `requests.approve`/`manage` sees only its
 * own requests and the ones assigned to it. Reviewers and auditors see everything.
 */

const engine = require('../requests/engine');
const registry = require('../requests/registry');
const { cq } = require('../../convexApi');

const send = (res, err, fallback) => {
  const status = err.statusCode || 500;
  if (status === 500) console.error(`[requests] ${fallback}:`, err);
  res.status(status).json({ error: status === 500 ? `${fallback}: ${err.message}` : err.message });
};

const idsOf = (request) => [
  String(request.requestedBy),
  ...(request.approvers || []).map((a) => String(a.userId)),
];

// Every route here gates on a `requests.<verb>` permission, so requireUser is never needed
// on its own — requirePermission authenticates as its first step.
function register(app, { requirePermission, roleCan }) {
  /**
   * Default approvers when the requester does not name any: every active user whose current
   * role can approve requests, one per level up to the type's configured depth.
   *
   * Deliberately excludes the requester — self-approval would make the whole module theatre.
   */
  async function defaultApprovers(descriptor, requester) {
    const users = await cq('notifications:usersActive', {});
    const eligible = [];
    for (const u of users) {
      if (String(u.id) === String(requester.id)) continue;
      if (await roleCan(u, 'requests', 'approve')) eligible.push(u);
    }
    if (!eligible.length) return [];

    // One approver per level. With fewer eligible people than levels the ladder simply gets
    // shorter — better a real 1-level approval than a 2-level one that can never clear.
    const levels = Math.min(descriptor.levels || 1, eligible.length);
    return eligible
      .slice(0, levels)
      .map((u, i) => ({ level: i + 1, userId: String(u.id), userName: u.name }));
  }

  engine.configure({ defaultApprovers });

  /** Can this caller see this request? */
  async function maySee(user, request) {
    if (await roleCan(user, 'requests', 'approve')) return true;
    if (await roleCan(user, 'requests', 'manage')) return true;
    return idsOf(request).includes(String(user.id));
  }

  /* ---------------------------------------------------------------- options */

  // The vocabulary the frontend builds its type picker, forms and filters from — request
  // types, their fields, the statuses and the priorities all come from the server, so the
  // UI cannot drift from the registry.
  app.get('/api/requests/options', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'view');
    if (!user) return;
    // Only offer types whose target module this role can actually see.
    const types = [];
    for (const t of registry.catalog()) {
      if (await roleCan(user, t.module, 'view')) types.push(t);
    }
    res.json({
      types,
      statuses: engine.STATUSES,
      openStatuses: engine.OPEN_STATUSES,
      terminalStatuses: engine.TERMINAL_STATUSES,
      priorities: engine.PRIORITIES,
      transitions: engine.TRANSITIONS,
    });
  });

  /** Who can be picked as an approver. Used by the create form and the reassign dialog. */
  app.get('/api/requests/approvers', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'view');
    if (!user) return;
    try {
      const users = await cq('notifications:usersActive', {});
      const out = [];
      for (const u of users) {
        if (await roleCan(u, 'requests', 'approve')) {
          out.push({ id: String(u.id), name: u.name, role: u.role, department: u.department });
        }
      }
      out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      res.json(out);
    } catch (err) {
      send(res, err, 'Could not load approvers');
    }
  });

  /* ------------------------------------------------------------------- list */

  app.get('/api/requests', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'view');
    if (!user) return;

    const { scope, status, requestType, module, q, overdue, recordId } = req.query;
    const filters = {
      status: status ? String(status).split(',').filter(Boolean) : undefined,
      requestType: requestType || undefined,
      module: module || undefined,
      recordId: recordId || undefined,
      q: q || undefined,
      overdue: overdue === 'true',
    };

    // The dashboard's named lists are scopes, not client-side filters — "awaiting my
    // approval" has to mean the level the request is actually sitting on, which only the
    // data layer knows.
    if (scope === 'mine') filters.requestedBy = String(user.id);
    if (scope === 'awaiting_me') filters.approverId = String(user.id);

    const isReviewer =
      (await roleCan(user, 'requests', 'approve')) || (await roleCan(user, 'requests', 'manage'));

    try {
      let rows = await engine.list(filters);
      // A plain `requests.view` role sees its own and its assigned requests, nothing else.
      if (!isReviewer && scope !== 'mine' && scope !== 'awaiting_me') {
        rows = rows.filter((r) => idsOf(r).includes(String(user.id)));
      }
      res.json(rows);
    } catch (err) {
      send(res, err, 'Could not load requests');
    }
  });

  /** Counts behind the dashboard tiles, computed server-side from one pass over the rows. */
  app.get('/api/requests/summary', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'view');
    if (!user) return;
    try {
      const isReviewer =
        (await roleCan(user, 'requests', 'approve')) || (await roleCan(user, 'requests', 'manage'));
      const all = await engine.list({});
      const visible = isReviewer ? all : all.filter((r) => idsOf(r).includes(String(user.id)));
      const me = String(user.id);
      const recentlyCompleted = visible.filter(
        (r) => r.status === 'Completed' && r.completedAt &&
          Date.now() - new Date(r.completedAt).getTime() < 7 * 24 * 60 * 60 * 1000
      );
      res.json({
        pending: visible.filter((r) => r.status === 'Pending Approval').length,
        underReview: visible.filter((r) => r.status === 'Under Review').length,
        approved: visible.filter((r) => r.status === 'Approved' || r.status === 'Completed').length,
        rejected: visible.filter((r) => r.status === 'Rejected').length,
        cancelled: visible.filter((r) => r.status === 'Cancelled').length,
        draft: visible.filter((r) => r.status === 'Draft').length,
        mine: visible.filter((r) => String(r.requestedBy) === me).length,
        awaitingMyApproval: visible.filter((r) =>
          (r.approvers || []).some(
            (a) => String(a.userId) === me && a.status === 'Pending' && Number(a.level) === Number(r.currentLevel)
          ) && ['Pending Approval', 'Under Review'].includes(r.status)
        ).length,
        recentlyCompleted: recentlyCompleted.length,
        overdue: visible.filter((r) => r.overdue).length,
        total: visible.length,
      });
    } catch (err) {
      send(res, err, 'Could not summarise requests');
    }
  });

  /* -------------------------------------------------- the record being changed */

  // The current values of a target record, so the create form can prefill "before" and the
  // requester edits from reality rather than retyping it. Gated on the *target* module.
  app.get('/api/requests/record/:type/:recordId', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'create');
    if (!user) return;
    try {
      const descriptor = registry.descriptorFor(req.params.type);
      if (!(await roleCan(user, descriptor.module, 'view'))) {
        return res.status(403).json({ error: 'Your role is not permitted to view this record.' });
      }
      const record = await registry.loadRecord(req.params.type, req.params.recordId);
      if (!record) return res.status(404).json({ error: 'Record not found' });

      const { __raw, __label, __id, ...values } = record;
      res.json({
        recordId: req.params.recordId,
        label: __label,
        values,
        fields: Object.entries(descriptor.fields).map(([key, spec]) => ({
          key, label: spec.label, type: spec.type,
        })),
      });
    } catch (err) {
      send(res, err, 'Could not load the record');
    }
  });

  /* ----------------------------------------------------------------- create */

  app.post('/api/requests', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'create');
    if (!user) return;
    try {
      const descriptor = registry.descriptorFor(req.body.requestType);
      if (!(await roleCan(user, descriptor.module, 'view'))) {
        return res.status(403).json({
          error: `Your role is not permitted to raise requests against ${descriptor.label.replace(' Request', '')} records.`,
        });
      }
      const request = await engine.create(req.body, user);
      res.status(201).json(request);
    } catch (err) {
      send(res, err, 'Could not create the request');
    }
  });

  /* -------------------------------------------------------------- read one */

  app.get('/api/requests/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'view');
    if (!user) return;
    try {
      const request = await engine.get(req.params.id);
      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (!(await maySee(user, request))) {
        return res.status(403).json({ error: 'Your role is not permitted to view this request.' });
      }
      res.json(request);
    } catch (err) {
      send(res, err, 'Could not load the request');
    }
  });

  /** Old vs new, recomputed against the record as it stands now. */
  app.get('/api/requests/:id/comparison', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'view');
    if (!user) return;
    try {
      const request = await engine.get(req.params.id);
      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (!(await maySee(user, request))) {
        return res.status(403).json({ error: 'Your role is not permitted to view this request.' });
      }
      res.json(await engine.comparison(req.params.id));
    } catch (err) {
      send(res, err, 'Could not compare the request');
    }
  });

  /** Immutable by construction: there is no write route onto request_history. */
  app.get('/api/requests/:id/history', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'view');
    if (!user) return;
    try {
      const request = await engine.get(req.params.id);
      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (!(await maySee(user, request))) {
        return res.status(403).json({ error: 'Your role is not permitted to view this request.' });
      }
      res.json(request.history);
    } catch (err) {
      send(res, err, 'Could not load the audit history');
    }
  });

  /* -------------------------------------------------------- decision actions */

  // approve / reject / request-info all need `requests.approve`; the engine then checks the
  // caller is actually an assigned approver at the current level. Permission says "this role
  // reviews requests"; the ladder says "this request, this level, you".
  const decision = (path, verb, run) =>
    app.post(`/api/requests/:id/${path}`, async (req, res) => {
      const user = await requirePermission(req, res, 'requests', verb);
      if (!user) return;
      try {
        res.json(await run(req.params.id, user, req.body || {}));
      } catch (err) {
        send(res, err, `Could not ${path.replace(/-/g, ' ')} the request`);
      }
    });

  decision('approve', 'approve', (id, user, body) => engine.approve(id, user, body));
  decision('reject', 'approve', (id, user, body) => engine.reject(id, user, body));
  decision('request-info', 'approve', (id, user, body) => engine.requestInfo(id, user, body));
  decision('reassign', 'manage', (id, user, body) => engine.reassign(id, user, body));

  // Retry an approved-but-unapplied request (the apply threw: the target was locked, a
  // validation rule bit, the record moved). Re-running the ladder would be wrong; this
  // replays only the apply.
  decision('apply', 'approve', (id, user) => engine.complete(id, user));

  // The requester drives these, so they gate on `create`/`edit` rather than `approve`; the
  // engine enforces that the caller really is the requester.
  app.post('/api/requests/:id/submit', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'create');
    if (!user) return;
    try {
      res.json(await engine.submit(req.params.id, user));
    } catch (err) {
      send(res, err, 'Could not submit the request');
    }
  });

  app.post('/api/requests/:id/respond', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'edit');
    if (!user) return;
    try {
      res.json(await engine.respond(req.params.id, user, req.body || {}));
    } catch (err) {
      send(res, err, 'Could not respond to the request');
    }
  });

  // Cancelling is the requester's own withdrawal, or a manager pulling it. Anyone else with
  // only `requests.edit` must not be able to cancel someone else's request.
  app.post('/api/requests/:id/cancel', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'edit');
    if (!user) return;
    try {
      const request = await engine.get(req.params.id);
      if (!request) return res.status(404).json({ error: 'Request not found' });
      const isOwner = String(request.requestedBy) === String(user.id);
      if (!isOwner && !(await roleCan(user, 'requests', 'manage'))) {
        return res.status(403).json({ error: 'Only the requester or a manager can cancel this request.' });
      }
      res.json(await engine.cancel(req.params.id, user, req.body || {}));
    } catch (err) {
      send(res, err, 'Could not cancel the request');
    }
  });

  /* ----------------------------------------------------------- bulk actions */

  // Bulk approve/reject over a selection. Each is run through the same single-item path —
  // one failing (someone else already decided it, a stale row) must not roll back the rest,
  // so results are reported per id rather than as one all-or-nothing outcome.
  app.post('/api/requests/bulk/:action', async (req, res) => {
    const action = req.params.action;
    const runner = { approve: engine.approve, reject: engine.reject, cancel: engine.cancel }[action];
    if (!runner) return res.status(400).json({ error: `Unsupported bulk action "${action}"` });

    const verb = action === 'cancel' ? 'edit' : 'approve';
    const user = await requirePermission(req, res, 'requests', verb);
    if (!user) return;

    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one request' });

    const results = [];
    for (const id of ids) {
      try {
        await runner(id, user, req.body || {});
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: err.message });
      }
    }
    res.json({
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  });

  /* --------------------------------------------------------------- comments */

  app.post('/api/requests/:id/comments', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'view');
    if (!user) return;
    try {
      const request = await engine.get(req.params.id);
      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (!(await maySee(user, request))) {
        return res.status(403).json({ error: 'Your role is not permitted to comment on this request.' });
      }
      res.status(201).json(await engine.comment(req.params.id, user, req.body?.body));
    } catch (err) {
      send(res, err, 'Could not add the comment');
    }
  });

  /* ------------------------------------------------------------ attachments */

  // The browser uploads via POST /api/upload (private bucket) and records the returned path
  // here — the same two-step every other attachment in the system uses. Reads go through
  // POST /api/files/signed-url, so preview and download need no route of their own.
  const attachmentGate = async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'edit');
    if (!user) return null;
    const request = await engine.get(req.params.id);
    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return null;
    }
    const isOwner = String(request.requestedBy) === String(user.id);
    if (!isOwner && !(await roleCan(user, 'requests', 'approve'))) {
      res.status(403).json({ error: 'Only the requester or an approver can change these documents.' });
      return null;
    }
    // A decided request's evidence is part of the record of that decision. Letting someone
    // swap the quote out after approval would make the audit trail describe files that are
    // no longer there.
    if (!engine.OPEN_STATUSES.includes(request.status)) {
      res.status(409).json({ error: `A ${request.status} request's documents can no longer be changed.` });
      return null;
    }
    return user;
  };

  app.post('/api/requests/:id/attachments', async (req, res) => {
    const user = await attachmentGate(req, res);
    if (!user) return;
    try {
      res.status(201).json(await engine.addAttachment(req.params.id, user, req.body || {}));
    } catch (err) {
      send(res, err, 'Could not attach the document');
    }
  });

  app.put('/api/requests/:id/attachments/:attachmentId', async (req, res) => {
    const user = await attachmentGate(req, res);
    if (!user) return;
    try {
      res.json(await engine.replaceAttachment(req.params.id, user, req.params.attachmentId, req.body || {}));
    } catch (err) {
      send(res, err, 'Could not replace the document');
    }
  });

  app.delete('/api/requests/:id/attachments/:attachmentId', async (req, res) => {
    const user = await attachmentGate(req, res);
    if (!user) return;
    try {
      res.json(await engine.removeAttachment(req.params.id, user, req.params.attachmentId));
    } catch (err) {
      send(res, err, 'Could not delete the document');
    }
  });

  /* ----------------------------------------------------------------- delete */

  app.delete('/api/requests/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'requests', 'delete');
    if (!user) return;
    try {
      const removed = await engine.remove(req.params.id, user);
      if (!removed) return res.status(404).json({ error: 'Request not found' });
      res.json({ message: `Request ${req.params.id} deleted` });
    } catch (err) {
      send(res, err, 'Could not delete the request');
    }
  });
}

module.exports = { register };
