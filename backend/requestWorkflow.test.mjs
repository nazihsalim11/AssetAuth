import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * End-to-end workflow tests for the Request Engine, driven against an in-memory stand-in for
 * Convex and the notification dispatcher.
 *
 * The unit tests next door cover the pure pieces (diff, status machine, approval ladder).
 * These cover the part that actually breaks in production: the orchestration. That an
 * approved request writes to the target record, that a rejected one does not, that the audit
 * trail is complete, that a stale row is refused, that a multi-level ladder does not apply
 * early — none of which a pure test can see.
 *
 * The stub implements the same contract as backend/convex/requests.js, including its
 * compare-and-set on updated_at, so an engine change that breaks the concurrency guard fails
 * here rather than in front of two approvers clicking at once.
 */

/* ------------------------------------------------------- in-memory Convex */

let tables;
let notified;

const nowIso = () => new Date().toISOString();
const clone = (v) => JSON.parse(JSON.stringify(v));

// Convex's `updated_at` is wall-clock; two writes inside the same millisecond would produce
// identical stamps and make the compare-and-set vacuous. A counter keeps them distinct so the
// guard is actually exercised.
let tick = 0;
const stamp = () => `2026-07-16T00:00:${String(tick++).padStart(2, '0')}.000Z`;

const findIn = (table, field, value) =>
  (tables[table] || []).find((r) => String(r[field]) === String(value));

const nextNum = (table) => (tables[table] || []).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;

function appendHistory(requestId, entry, fromStatus, toStatus) {
  tables.request_history.push({
    id: nextNum('request_history'),
    request_id: requestId,
    action: entry.action,
    detail: entry.detail ?? null,
    actor: entry.actor ?? null,
    actor_name: entry.actorName ?? null,
    changes: entry.changes ?? null,
    from_status: fromStatus ?? entry.fromStatus ?? null,
    to_status: toStatus ?? entry.toStatus ?? null,
    created_at: nowIso(),
  });
}

const QUERIES = {
  'generic:get': ({ table, idField, idVal }) => clone(findIn(table, idField, idVal) || null),

  'requests:detail': ({ id }) => {
    const request = findIn('requests', 'id', id);
    if (!request) return null;
    const kids = (t) => tables[t].filter((r) => r.request_id === id);
    return clone({
      request,
      comments: kids('request_comments'),
      attachments: kids('request_attachments'),
      history: kids('request_history'),
    });
  },

  'requests:list': (args) => {
    let rows = clone(tables.requests);
    if (args.status?.length) rows = rows.filter((r) => args.status.includes(r.status));
    if (args.requestType) rows = rows.filter((r) => r.request_type === args.requestType);
    if (args.requestedBy) rows = rows.filter((r) => String(r.requested_by) === String(args.requestedBy));
    if (args.approverId) {
      rows = rows.filter((r) => (r.approvers || []).some(
        (a) => String(a.user_id) === String(args.approverId) && a.status === 'Pending' &&
          Number(a.level) === Number(r.current_level)
      ));
    }
    return rows;
  },

  'requests:openForRecord': ({ module, recordId, requestType }) =>
    clone(tables.requests.filter((r) =>
      r.module === module && String(r.record_id) === String(recordId) &&
      ['Draft', 'Pending Approval', 'Under Review'].includes(r.status) &&
      (!requestType || r.request_type === requestType)
    )),

  'purchaseOrders:poGet': ({ id }) => {
    const po = findIn('purchase_orders', 'id', id);
    if (!po) return null;
    return clone({
      po,
      items: tables.purchase_order_items.filter((i) => i.purchase_order_id === po.id),
      documents: [], attachments: [],
    });
  },
  'purchaseOrders:vendorGet': ({ id }) => clone(findIn('vendors', 'id', id) || null),
  'purchaseOrders:vendorList': () => clone(tables.vendors),
  'masters:list': ({ table }) => clone(tables[table] || []),
  'generic:list': ({ table }) => clone(tables[table] || []),
};

const MUTATIONS = {
  'requests:create': ({ request, attachments }) => {
    if (findIn('requests', 'id', request.id)) throw new Error(`Request '${request.id}' already exists.`);
    const doc = { ...clone(request), created_at: stamp(), updated_at: stamp() };
    tables.requests.push(doc);
    for (const a of attachments || []) {
      tables.request_attachments.push({
        id: nextNum('request_attachments'), request_id: request.id,
        file_name: a.fileName ?? 'attachment', file_path: a.filePath ?? null, created_at: nowIso(),
      });
    }
    appendHistory(request.id, {
      action: 'Request Created', actor: request.requested_by, actorName: request.requested_by_name,
      changes: request.changes_preview,
    }, null, request.status);
    return clone(doc);
  },

  'requests:act': ({ id, expectedUpdatedAt, patch, history }) => {
    const row = findIn('requests', 'id', id);
    if (!row) throw new Error(`Request '${id}' not found.`);
    // The guard under test.
    if (String(row.updated_at) !== String(expectedUpdatedAt)) {
      throw new Error('This request was updated by someone else while you were reviewing it.');
    }
    const from = row.status;
    Object.assign(row, clone(patch), { updated_at: stamp() });
    appendHistory(id, history, from, patch.status ?? from);
    return clone(row);
  },

  'requests:addComment': ({ id, body, actor, actorName }) => {
    const row = findIn('requests', 'id', id);
    if (!row) throw new Error(`Request '${id}' not found.`);
    const doc = {
      id: nextNum('request_comments'), request_id: id, body,
      author: actor ?? null, author_name: actorName, created_at: nowIso(),
    };
    tables.request_comments.push(doc);
    row.updated_at = stamp();
    appendHistory(id, { action: 'Comment Added', detail: body, actor, actorName });
    return clone(doc);
  },

  'requests:addAttachment': ({ id, attachment, actorName }) => {
    const doc = {
      id: nextNum('request_attachments'), request_id: id,
      file_name: attachment.fileName, file_path: attachment.filePath,
      uploaded_by: actorName, created_at: nowIso(),
    };
    tables.request_attachments.push(doc);
    appendHistory(id, { action: 'Attachment Added', detail: attachment.fileName, actorName });
    return clone(doc);
  },

  'requests:remove': ({ id }) => {
    const row = findIn('requests', 'id', id);
    if (!row) return null;
    tables.requests = tables.requests.filter((r) => r.id !== id);
    for (const t of ['request_comments', 'request_attachments', 'request_history']) {
      tables[t] = tables[t].filter((r) => r.request_id !== id);
    }
    return clone(row);
  },

  'generic:update': ({ table, idField, idVal, patch }) => {
    const row = findIn(table, idField, idVal);
    if (!row) throw new Error(`Not found in ${table}`);
    Object.assign(row, clone(patch));
    return clone(row);
  },

  'purchaseOrders:poUpdate': ({ id, patch }) => {
    const po = findIn('purchase_orders', 'id', id);
    if (!po) throw new Error('Purchase order not found');
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) po[k] = v;
    return clone({ po, items: [], documents: [], attachments: [] });
  },

  'purchaseOrders:poCreate': ({ po, items }) => {
    const id = nextNum('purchase_orders');
    const doc = { ...clone(po), id, po_number: `PO-2026-${String(id).padStart(4, '0')}`, created_at: nowIso() };
    tables.purchase_orders.push(doc);
    const rows = (items || []).map((i, index) => ({
      ...clone(i), id: nextNum('purchase_order_items') + index, purchase_order_id: id,
    }));
    tables.purchase_order_items.push(...rows);
    return clone({ po: doc, items: rows, attachments: [] });
  },

  'generic:insert': ({ table, document }) => {
    tables[table] = tables[table] || [];
    tables[table].push(clone(document));
    return clone(document);
  },

  'idSequences:reserve': () => {
    const n = tables.requests.length + tables.__reserved++ + 1;
    return { nextId: `REQ-${String(n).padStart(5, '0')}`, number: n, prefix: 'REQ', padding: 5 };
  },

  'logs:add': ({ actor, action, detail }) => {
    tables.system_logs.push({ id: nextNum('system_logs'), actor, action, detail, created_at: nowIso() });
    return {};
  },
};

// Swap the real modules out of the require cache before the engine pulls them in.
const stubModule = (relPath, exports) => {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

stubModule('./convexApi.js', {
  cq: async (name, args = {}) => {
    if (!QUERIES[name]) throw new Error(`test stub: unhandled query ${name}`);
    return QUERIES[name](args);
  },
  cm: async (name, args = {}) => {
    if (!MUTATIONS[name]) throw new Error(`test stub: unhandled mutation ${name}`);
    return MUTATIONS[name](args);
  },
  client: null,
});

stubModule('./notifications/index.js', {
  notify: async (eventType, eventKey, ctx) => { notified.push({ eventType, eventKey, ctx }); },
  eventTypes: [],
});

const engine = require('./src/requests/engine.js');

/* ------------------------------------------------------------------ fixtures */

const REQUESTER = { id: 'u-req', name: 'Rita Requester' };
const APPROVER_1 = { id: 'u-a1', name: 'Alan Approver' };
const APPROVER_2 = { id: 'u-a2', name: 'Bea Boss' };
const OUTSIDER = { id: 'u-out', name: 'Otto Outsider' };

beforeEach(() => {
  tick = 0;
  notified = [];
  tables = {
    __reserved: 0,
    requests: [], request_comments: [], request_attachments: [], request_history: [],
    system_logs: [],
    vendors: [
      { id: 1, name: 'Dell', address: '2 Dell Way', gst_vat: 'GST1', is_active: true,
        default_currency: 'INR', default_payment_terms: 'Net 30', bank_name: 'HDFC' },
      { id: 2, name: 'Lenovo', address: '9 Lenovo Rd', is_active: true, default_currency: 'INR' },
    ],
    purchase_orders: [
      { id: 7, po_number: 'PO-2026-0007', vendor: 'Dell', vendor_id: 1, status: 'Issued',
        currency: 'INR', issue_date: '2026-01-01', payment_terms: 'Net 30', notes: 'original',
        discount_type: 'amount', discount_value: 0, amount: 1000 },
    ],
    purchase_order_items: [
      { id: 1, purchase_order_id: 7, line_no: 1, description: 'Laptop', quantity: 1,
        unit: 'pcs', unit_price: 1000, tax_percent: 0, line_total: 1000 },
    ],
    departments: [
      { id: 1, name: 'IT', is_active: true },
      { id: 2, name: 'HR', is_active: true },
      { id: 3, name: 'Retired Ops', is_active: false },
    ],
    asset_subtypes: [{ id: 1, name: 'Laptops', category: 'IT Equipment', is_active: true }],
    approval_rules: [],
  };
  engine.configure({
    defaultApprovers: async (descriptor) =>
      [{ level: 1, userId: APPROVER_1.id, userName: APPROVER_1.name }].slice(0, descriptor.levels || 1),
  });
});

const newVendorRequest = (overrides = {}) => engine.create({
  requestType: 'vendor.update',
  recordId: 1,
  proposedChanges: { name: 'Dell India', bankAccountNumber: '5010012345' },
  reason: 'Vendor renamed and gave us their bank details',
  ...overrides,
}, REQUESTER);

/* =============================================================== the flow */

test('an approved request applies its changes to the target record', async () => {
  const created = await newVendorRequest();
  assert.equal(created.status, 'Pending Approval');
  assert.equal(created.id, 'REQ-00001');

  // The record must be untouched while the request is open — the whole point of the module.
  assert.equal(tables.vendors[0].name, 'Dell');
  assert.equal(tables.vendors[0].bank_account_number, undefined);

  const done = await engine.approve(created.id, APPROVER_1);

  assert.equal(done.status, 'Completed');
  assert.equal(tables.vendors[0].name, 'Dell India', 'the approved change must reach the record');
  assert.equal(tables.vendors[0].bank_account_number, '5010012345');
  assert.ok(done.completedAt);
});

test('a rejected request changes nothing', async () => {
  const created = await newVendorRequest();
  const rejected = await engine.reject(created.id, APPROVER_1, { comment: 'Send the cancelled cheque first' });

  assert.equal(rejected.status, 'Rejected');
  assert.equal(tables.vendors[0].name, 'Dell', 'a rejected request must not touch the record');
  assert.equal(tables.vendors[0].bank_account_number, undefined);
});

test('rejecting without a reason is refused', async () => {
  const created = await newVendorRequest();
  await assert.rejects(() => engine.reject(created.id, APPROVER_1, {}), /reason is required/i);
  assert.equal(tables.vendors[0].name, 'Dell');
});

test('a two-level request does not apply until the final level approves', async () => {
  engine.configure({
    defaultApprovers: async () => [
      { level: 1, userId: APPROVER_1.id, userName: APPROVER_1.name },
      { level: 2, userId: APPROVER_2.id, userName: APPROVER_2.name },
    ],
  });
  const created = await newVendorRequest();
  assert.equal(created.totalLevels, 2);

  const afterFirst = await engine.approve(created.id, APPROVER_1);
  assert.equal(afterFirst.status, 'Pending Approval');
  assert.equal(afterFirst.currentLevel, 2);
  assert.equal(tables.vendors[0].name, 'Dell', 'level 1 alone must not apply the change');

  const afterSecond = await engine.approve(created.id, APPROVER_2);
  assert.equal(afterSecond.status, 'Completed');
  assert.equal(tables.vendors[0].name, 'Dell India');
});

test('a level-2 approver cannot approve while level 1 is undecided', async () => {
  engine.configure({
    defaultApprovers: async () => [
      { level: 1, userId: APPROVER_1.id, userName: APPROVER_1.name },
      { level: 2, userId: APPROVER_2.id, userName: APPROVER_2.name },
    ],
  });
  const created = await newVendorRequest();
  await assert.rejects(() => engine.approve(created.id, APPROVER_2), /not an assigned approver/i);
  assert.equal(tables.vendors[0].name, 'Dell');
});

test('someone who is not an approver at all cannot approve', async () => {
  const created = await newVendorRequest();
  await assert.rejects(() => engine.approve(created.id, OUTSIDER), /not an assigned approver/i);
  assert.equal(tables.vendors[0].name, 'Dell');
});

test('an already-decided request cannot be approved a second time', async () => {
  const created = await newVendorRequest();
  await engine.approve(created.id, APPROVER_1);
  // The double-click / replayed-request case: the change must not be applied twice.
  await assert.rejects(() => engine.approve(created.id, APPROVER_1), /Completed request cannot be approved/i);
});

test('a second open request against the same record is refused', async () => {
  await newVendorRequest();
  await assert.rejects(
    () => newVendorRequest({ proposedChanges: { name: 'Dell Global' } }),
    /already open/i
  );
});

test('a request that would change nothing is refused', async () => {
  await assert.rejects(
    () => newVendorRequest({ proposedChanges: { name: 'Dell' } }), // already its name
    /would not change anything/i
  );
});

test('proposed fields the type does not declare are dropped, not applied', async () => {
  const created = await newVendorRequest({
    proposedChanges: { name: 'Dell India', is_active: false, someInjectedColumn: 'boom' },
  });
  // Only the declared camel field survives the whitelist.
  assert.deepEqual(Object.keys(created.proposedChanges), ['name']);
  await engine.approve(created.id, APPROVER_1);
  assert.equal(tables.vendors[0].someInjectedColumn, undefined);
  assert.equal(tables.vendors[0].name, 'Dell India');
});

test('the diff is recomputed at approval, so it cannot clobber a field changed since', async () => {
  const created = await newVendorRequest({
    proposedChanges: { name: 'Dell India', bankAccountNumber: '5010012345' },
  });
  // Someone legitimately renames the vendor to the same target while the request is open.
  tables.vendors[0].name = 'Dell India';

  const comparison = await engine.comparison(created.id);
  assert.equal(comparison.stale, true, 'the reviewer must be told the record moved');
  assert.deepEqual(comparison.changes.map((c) => c.field), ['bankAccountNumber']);

  const done = await engine.approve(created.id, APPROVER_1);
  assert.deepEqual(done.appliedChanges.map((c) => c.field), ['bankAccountNumber']);
});

test('a stale write is refused rather than silently overwriting', async () => {
  const created = await newVendorRequest();
  const row = tables.requests[0];
  const stale = row.updated_at;
  // Simulate another approver acting first.
  row.updated_at = stamp();

  await assert.rejects(
    () => require('./convexApi.js').cm('requests:act', {
      id: created.id, expectedUpdatedAt: stale, patch: { status: 'Approved' }, history: { action: 'x' },
    }),
    /updated by someone else/i
  );
});

/* =============================================================== PO edits */

test('an approved PO edit request writes through the shared PO writer', async () => {
  const created = await engine.create({
    requestType: 'po.edit',
    recordId: 7,
    proposedChanges: { paymentTerms: 'Net 45', notes: 'renegotiated' },
    reason: 'Vendor agreed longer terms',
  }, REQUESTER);

  // An Issued PO is locked to direct edits; the request is the only way in.
  assert.equal(tables.purchase_orders[0].payment_terms, 'Net 30');

  await engine.approve(created.id, APPROVER_1);

  assert.equal(tables.purchase_orders[0].payment_terms, 'Net 45');
  assert.equal(tables.purchase_orders[0].notes, 'renegotiated');
  // The writer recomputes derived figures rather than trusting the stored proposal.
  assert.equal(tables.purchase_orders[0].amount, 1000);
  assert.ok(tables.purchase_orders[0].amount_in_words.includes('Thousand'));
});

test('the PO lock refuses a direct edit and names the way through', async () => {
  const poUpdate = require('./src/services/poUpdate.js');
  await assert.rejects(
    () => poUpdate.updatePurchaseOrder(7, { paymentTerms: 'Net 45' }, 'Someone'),
    (e) => e.statusCode === 409 && /Edit Request/i.test(e.message)
  );
  assert.equal(tables.purchase_orders[0].payment_terms, 'Net 30');
});

test('a Draft PO is still directly editable — the lock is only for issued orders', async () => {
  tables.purchase_orders[0].status = 'Draft';
  const poUpdate = require('./src/services/poUpdate.js');
  const result = await poUpdate.updatePurchaseOrder(7, { paymentTerms: 'Net 15' }, 'Someone');
  assert.equal(result.po.payment_terms, 'Net 15');
});

/* =============================================================== lifecycle */

test('a draft is not assigned or notified until it is submitted', async () => {
  const created = await newVendorRequest({ submit: false });
  assert.equal(created.status, 'Draft');
  assert.equal(notified.length, 0, 'a draft must not notify anyone');

  const submitted = await engine.submit(created.id, REQUESTER);
  assert.equal(submitted.status, 'Pending Approval');
  assert.ok(notified.some((n) => n.eventType === 'request.approval_requested'));
});

test('only the requester can submit their draft', async () => {
  const created = await newVendorRequest({ submit: false });
  await assert.rejects(() => engine.submit(created.id, OUTSIDER), /Only the requester/i);
});

test('request-info pauses the ladder and the response resumes it at the same level', async () => {
  const created = await newVendorRequest();
  const paused = await engine.requestInfo(created.id, APPROVER_1, { comment: 'Which branch?' });
  assert.equal(paused.status, 'Under Review');
  assert.equal(paused.currentLevel, 1, 'asking a question must not reset the ladder');

  const resumed = await engine.respond(created.id, REQUESTER, { comment: 'The Bangalore branch' });
  assert.equal(resumed.status, 'Pending Approval');
  assert.equal(resumed.currentLevel, 1);

  const done = await engine.approve(created.id, APPROVER_1);
  assert.equal(done.status, 'Completed');
});

test('reassignment moves the pending slot and keeps the level', async () => {
  const created = await newVendorRequest();
  const moved = await engine.reassign(created.id, APPROVER_1, {
    toUserId: APPROVER_2.id, toUserName: APPROVER_2.name, comment: 'On leave',
  });
  assert.equal(moved.approvers[0].userId, APPROVER_2.id);
  assert.equal(moved.approvers[0].level, 1);

  await assert.rejects(() => engine.approve(created.id, APPROVER_1), /not an assigned approver/i);
  const done = await engine.approve(created.id, APPROVER_2);
  assert.equal(done.status, 'Completed');
});

test('a cancelled request applies nothing and cannot then be approved', async () => {
  const created = await newVendorRequest();
  const cancelled = await engine.cancel(created.id, REQUESTER, { comment: 'Not needed' });
  assert.equal(cancelled.status, 'Cancelled');
  assert.equal(tables.vendors[0].name, 'Dell');
  await assert.rejects(() => engine.approve(created.id, APPROVER_1), /Cancelled request cannot be approved/i);
});

test('an apply failure leaves the request Approved with the error, not Completed', async () => {
  const created = await newVendorRequest();
  // The target write blows up — a validation rule, a lock, a dead backend.
  const realUpdate = MUTATIONS['generic:update'];
  MUTATIONS['generic:update'] = () => { throw new Error('vendor name is taken'); };

  try {
    await assert.rejects(() => engine.approve(created.id, APPROVER_1), /could not be applied/i);

    const after = await engine.get(created.id);
    assert.equal(after.status, 'Approved', 'must not claim Completed when nothing was written');
    assert.match(after.applyError, /vendor name is taken/);
    assert.ok(after.history.some((h) => h.action === 'Apply Failed'));
  } finally {
    MUTATIONS['generic:update'] = realUpdate;
  }
});

test('an approved-but-unapplied request can be retried once the cause is fixed', async () => {
  const created = await newVendorRequest();
  const realUpdate = MUTATIONS['generic:update'];
  MUTATIONS['generic:update'] = () => { throw new Error('transient outage'); };
  await assert.rejects(() => engine.approve(created.id, APPROVER_1), /could not be applied/i);
  MUTATIONS['generic:update'] = realUpdate;

  // Retrying replays only the apply — the ladder is not re-run.
  const done = await engine.complete(created.id, APPROVER_1);
  assert.equal(done.status, 'Completed');
  assert.equal(done.applyError, null);
  assert.equal(tables.vendors[0].name, 'Dell India');
});

/* ============================================================== audit trail */

test('the audit trail records the whole life of a request, in order', async () => {
  const created = await newVendorRequest({ submit: false });
  await engine.submit(created.id, REQUESTER);
  await engine.comment(created.id, APPROVER_1, 'Checking with finance');
  await engine.requestInfo(created.id, APPROVER_1, { comment: 'Need the cheque' });
  await engine.respond(created.id, REQUESTER, { comment: 'Attached' });
  await engine.approve(created.id, APPROVER_1, { comment: 'Fine' });

  const final = await engine.get(created.id);
  const actions = final.history.map((h) => h.action);
  assert.deepEqual(actions, [
    'Request Created', 'Request Submitted', 'Comment Added', 'Information Requested',
    'Information Provided', 'Request Approved', 'Changes Applied',
  ]);

  // Every line is attributed and stamped — an audit line without an actor is useless.
  for (const h of final.history) {
    assert.ok(h.createdAt, `${h.action} has no timestamp`);
    assert.ok(h.actorName, `${h.action} has no actor`);
  }

  // The applied diff is recorded on the trail, not just the request.
  const applied = final.history.find((h) => h.action === 'Changes Applied');
  assert.ok(applied.changes.some((c) => c.field === 'name'));
  // And it reached the system-wide log too.
  assert.ok(tables.system_logs.some((l) => /Applied/.test(l.action)));
});

test('history is append-only: acting on a request never rewrites an existing line', async () => {
  const created = await newVendorRequest();
  const before = clone(tables.request_history);
  await engine.approve(created.id, APPROVER_1);

  const after = tables.request_history;
  assert.ok(after.length > before.length, 'new lines are appended');
  // Every original line survives byte-identical.
  for (const original of before) {
    assert.deepEqual(after.find((h) => h.id === original.id), original);
  }
});

test('notifications fire for the whole lifecycle, addressed to the right people', async () => {
  const created = await newVendorRequest();
  const submitted = notified.find((n) => n.eventType === 'request.submitted');
  assert.ok(submitted);
  assert.deepEqual(submitted.ctx.explicitRecipients, [REQUESTER.id]);

  const asked = notified.find((n) => n.eventType === 'request.approval_requested');
  assert.deepEqual(asked.ctx.explicitRecipients, [APPROVER_1.id]);
  // The event key must be deterministic per level, so a retry cannot double-notify.
  assert.equal(asked.eventKey, `req:${created.id}:approval:L1`);

  await engine.approve(created.id, APPROVER_1);
  const approved = notified.find((n) => n.eventType === 'request.approved');
  assert.ok(approved.ctx.explicitRecipients.includes(REQUESTER.id));
  assert.ok(approved.ctx.explicitRecipients.includes(APPROVER_1.id));
});

/* ================================================================ scoping */

test('list scopes: mine and awaiting-me resolve off the ladder, not the row', async () => {
  const created = await newVendorRequest();

  assert.equal((await engine.list({ requestedBy: REQUESTER.id })).length, 1);
  assert.equal((await engine.list({ requestedBy: OUTSIDER.id })).length, 0);
  assert.equal((await engine.list({ approverId: APPROVER_1.id })).length, 1);
  assert.equal((await engine.list({ approverId: APPROVER_2.id })).length, 0);

  // Once decided, it leaves the approver's queue.
  await engine.approve(created.id, APPROVER_1);
  assert.equal((await engine.list({ approverId: APPROVER_1.id })).length, 0);
});

test('overdue is derived from the due date and only applies while open', async () => {
  const created = await newVendorRequest({ dueDate: '2020-01-01' });
  assert.equal((await engine.list({ overdue: true })).length, 1);

  await engine.approve(created.id, APPROVER_1);
  const after = await engine.get(created.id);
  assert.equal(after.overdue, false, 'a completed request is not overdue, however old its due date');
});

/* ==================================================== purchase requests */

/**
 * A purchase request is the first request type with no target record: the request *is* the
 * document. These cover what that changes — that it needs no record to exist, that the
 * server owns the totals the approval rules band on, that approval alone creates nothing,
 * and that conversion into a purchase order is guarded on the approval actually having
 * happened. Everything else about it (the ladder, the audit trail, the notifications) is
 * the same engine the tests above already cover, which is the point.
 */

const purchaseRequest = require('./src/requests/purchaseRequest.js');
const poUpdate = require('./src/services/poUpdate.js');

const ITEMS = [
  { description: 'Dell Latitude 5450', category: 'Laptops', quantity: 3, unit: 'pcs',
    estimatedUnitCost: 65000, justification: 'Three new joiners in August' },
  { description: 'Docking station', category: 'Laptops', quantity: 3, unit: 'pcs',
    estimatedUnitCost: 8000, justification: 'One per laptop' },
];

const newPurchaseRequest = ({ proposedChanges, ...overrides } = {}, user = { ...REQUESTER, department: 'IT' }) =>
  engine.create({
    requestType: 'purchase.request',
    proposedChanges: {
      department: 'IT',
      requiredByDate: '2026-08-15',
      items: ITEMS,
      quotations: [
        { vendorId: 1, quotationNumber: 'Q-1001', quotationDate: '2026-07-10', amount: 219000 },
        { vendorId: 2, quotationNumber: 'Q-2002', quotationDate: '2026-07-11', amount: 224000 },
      ],
      preferredVendorId: 1,
      ...(proposedChanges || {}),
    },
    reason: 'Laptops for the August intake',
    ...overrides,
  }, user);

test('a purchase request needs no target record and totals itself', async () => {
  const created = await newPurchaseRequest();

  assert.equal(created.status, 'Pending Approval');
  assert.equal(created.recordId, null, 'a new-document request targets no record');
  assert.equal(created.recordLabel, 'IT — Dell Latitude 5450 +1 more');

  // 3 x 65000 + 3 x 8000. The server computes this; the client is never asked.
  assert.equal(created.proposedChanges.estimatedTotal, 219000);
  assert.equal(created.proposedChanges.items[0].estimatedTotalCost, 195000);
  assert.equal(created.proposedChanges.preferredVendorName, 'Dell', 'the vendor name is snapshotted');
});

test('a client-supplied total cannot override the computed one', async () => {
  // Otherwise a requester could post a token amount and slip under a cost-banded approval rule.
  const created = await newPurchaseRequest({ proposedChanges: { estimatedTotal: 1 } });
  assert.equal(created.proposedChanges.estimatedTotal, 219000);
});

test('a purchase request is validated before anyone is asked to approve it', async () => {
  const bad = (proposedChanges) => newPurchaseRequest({ proposedChanges });

  await assert.rejects(() => bad({ items: [] }), /at least one line item/i);
  await assert.rejects(() => bad({ department: 'Marketing' }), /Department Master/i);
  await assert.rejects(() => bad({ department: 'Retired Ops' }), /archived/i);
  await assert.rejects(
    () => bad({ items: [{ ...ITEMS[0], quantity: 0 }] }),
    /quantity must be greater than zero/i
  );
  await assert.rejects(
    () => bad({ items: [{ ...ITEMS[0], justification: '' }] }),
    /justification is required/i
  );
  await assert.rejects(
    () => bad({ preferredVendorId: 2, quotations: [{ vendorId: 1, amount: 10 }] }),
    /must be one of the vendors that quoted/i
  );

  assert.equal(tables.requests.length, 0, 'nothing invalid reached the approval queue');
});

test('a requester cannot raise a purchase request for another department', async () => {
  await assert.rejects(
    () => newPurchaseRequest({}, { ...REQUESTER, department: 'HR' }),
    /only raise purchase requests for HR/i
  );
});

test('approval alone creates nothing — conversion is a separate act', async () => {
  const created = await newPurchaseRequest();
  const done = await engine.approve(created.id, APPROVER_1);

  assert.equal(done.status, 'Completed');
  assert.equal(tables.purchase_orders.length, 1, 'only the pre-existing PO; approval raised none');
  assert.equal(done.convertedTo, null);
  assert.equal(done.displayStatus, 'Approved');
});

test('an unapproved purchase request cannot be converted', async () => {
  const created = await newPurchaseRequest();
  await assert.rejects(
    () => engine.linkOutcome(created.id, APPROVER_1, { patch: {}, action: 'Converted' }),
    /has not been approved/i
  );
});

test('an approved purchase request converts into a purchase order, once', async () => {
  const created = await newPurchaseRequest();
  await engine.approve(created.id, APPROVER_1);

  const payload = (await engine.get(created.id)).proposedChanges;
  const body = purchaseRequest.toPurchaseOrderBody(payload, {});
  const { po } = await poUpdate.createPurchaseOrder({ ...body, sourceRequestId: created.id }, APPROVER_1);

  // The order carries what was approved: the items, the quantities, the estimated costs and
  // the preferred vendor — not a re-entered copy of them.
  assert.equal(po.vendor_id, 1);
  assert.equal(po.amount, 219000);
  assert.equal(po.source_request_id, created.id);
  assert.equal(tables.purchase_order_items.filter((i) => i.purchase_order_id === po.id).length, 2);

  const linked = await engine.linkOutcome(created.id, APPROVER_1, {
    patch: { converted_po_id: po.id, converted_po_number: po.po_number },
    action: 'Converted to Purchase Order',
    outcomeLabel: 'Purchase Order ' + po.po_number,
    detail: po.po_number + ' raised on ' + po.vendor,
    guard: (row) => (row.converted_po_id ? 'already converted into ' + row.converted_po_number : null),
  });

  assert.equal(linked.convertedTo.id, po.id);
  assert.equal(linked.displayStatus, 'Converted to Purchase Order');
  assert.ok(notified.some((n) => n.eventType === 'request.converted'));
  assert.ok(linked.history.some((h) => h.action === 'Converted to Purchase Order'),
    'the conversion is in the audit trail');

  // A second conversion of the same request would be a second order for one approval.
  await assert.rejects(
    () => engine.linkOutcome(created.id, APPROVER_1, {
      patch: {},
      action: 'Converted to Purchase Order',
      guard: (row) => (row.converted_po_id ? 'already converted into ' + row.converted_po_number : null),
    }),
    /already converted/i
  );
});

test('a draft purchase request can be revised, and a submitted one cannot', async () => {
  const draft = await newPurchaseRequest({ submit: false });
  assert.equal(draft.status, 'Draft');

  const revised = await engine.updateProposal(draft.id, REQUESTER, {
    proposedChanges: { items: [{ ...ITEMS[0], quantity: 5 }] },
  });
  assert.equal(revised.proposedChanges.estimatedTotal, 325000, 'the revision is re-totalled too');
  assert.ok(revised.history.some((h) => h.action === 'Request Revised'));

  await engine.submit(draft.id, REQUESTER);
  await assert.rejects(
    () => engine.updateProposal(draft.id, REQUESTER, { proposedChanges: { items: ITEMS } }),
    /can no longer be revised/i
  );
});

test('only the requester may revise, and only a terminal request may be closed', async () => {
  const draft = await newPurchaseRequest({ submit: false });
  await assert.rejects(
    () => engine.updateProposal(draft.id, OUTSIDER, { proposedChanges: {} }),
    /only the requester/i
  );
  await assert.rejects(() => engine.close(draft.id, REQUESTER), /still in flight/i);

  await engine.submit(draft.id, REQUESTER);
  await engine.approve(draft.id, APPROVER_1);
  const closed = await engine.close(draft.id, REQUESTER, { comment: 'Deferred to next quarter' });
  assert.equal(closed.displayStatus, 'Closed');
});
