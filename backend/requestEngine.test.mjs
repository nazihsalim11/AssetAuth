import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const diff = require('./src/requests/diff.js');
const registry = require('./src/requests/registry.js');
const templates = require('./notifications/templates.js');

// The engine pulls in convexApi at require time, which is fine — nothing here calls out to
// it. Only the pure exports (status machine, approval ladder) are exercised.
const engine = require('./src/requests/engine.js');

/* ============================================================== diff engine */

const FIELDS = {
  status: { label: 'Status', column: 'status', type: 'string' },
  cost: { label: 'Cost', column: 'cost', type: 'number' },
  issueDate: { label: 'PO Date', column: 'issue_date', type: 'date' },
  isActive: { label: 'Active', column: 'is_active', type: 'boolean' },
  notes: { label: 'Notes', column: 'notes', type: 'string' },
};

test('diff reports only fields that were actually proposed and actually differ', () => {
  const before = { status: 'Draft', cost: 100, notes: 'old' };
  const after = { status: 'Issued', cost: 100 }; // cost unchanged, notes not proposed
  const changes = diff.diffFields(before, after, FIELDS);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { field: 'status', label: 'Status', before: 'Draft', after: 'Issued' });
});

test('a field absent from the proposal is untouched, not cleared', () => {
  // The bug this guards: treating "not mentioned" as "set to null" would let an edit request
  // wipe every field the requester did not fill in.
  const changes = diff.diffFields({ notes: 'keep me', status: 'Draft' }, { status: 'Issued' }, FIELDS);
  assert.deepEqual(changes.map((c) => c.field), ['status']);
});

test('numbers compare by value, so "100" does not read as a change from 100', () => {
  assert.equal(diff.diffFields({ cost: 100 }, { cost: '100' }, FIELDS).length, 0);
  assert.equal(diff.diffFields({ cost: 100 }, { cost: '100.50' }, FIELDS).length, 1);
});

test('dates compare by day, so an ISO timestamp does not read as a change from a date', () => {
  const changes = diff.diffFields(
    { issueDate: '2026-07-16T00:00:00.000Z' }, { issueDate: '2026-07-16' }, FIELDS
  );
  assert.equal(changes.length, 0);
});

test('empty string, null and undefined are all "empty" and do not differ from each other', () => {
  assert.equal(diff.diffFields({ notes: null }, { notes: '' }, FIELDS).length, 0);
  assert.equal(diff.diffFields({ notes: undefined }, { notes: null }, FIELDS).length, 0);
  // But empty -> a real value is a change.
  assert.equal(diff.diffFields({ notes: null }, { notes: 'x' }, FIELDS).length, 1);
});

test('booleans compare truthily', () => {
  assert.equal(diff.diffFields({ isActive: true }, { isActive: true }, FIELDS).length, 0);
  assert.equal(diff.diffFields({ isActive: true }, { isActive: false }, FIELDS).length, 1);
});

test('pickAllowed drops fields the type never declared', () => {
  // This is the whitelist that stops a request smuggling an edit to an undeclared column.
  const picked = diff.pickAllowed({ status: 'Issued', secretAdminFlag: true }, FIELDS);
  assert.deepEqual(picked, { status: 'Issued' });
});

test('toColumnPatch maps camel fields to their snake columns and empties to null', () => {
  const changes = [
    { field: 'status', after: 'Issued' },
    { field: 'issueDate', after: '2026-01-01' },
    { field: 'notes', after: '' },
  ];
  assert.deepEqual(diff.toColumnPatch(changes, FIELDS), {
    status: 'Issued', issue_date: '2026-01-01', notes: null,
  });
});

/* ============================================================ status engine */

test('status machine allows only the documented transitions', () => {
  assert.ok(engine.canTransition('Draft', 'Pending Approval'));
  assert.ok(engine.canTransition('Pending Approval', 'Approved'));
  assert.ok(engine.canTransition('Under Review', 'Pending Approval'));
  assert.ok(engine.canTransition('Approved', 'Completed'));

  // A decided request is decided. These are the transitions that would let an approved
  // change be re-applied or a rejection be quietly reversed.
  assert.equal(engine.canTransition('Completed', 'Pending Approval'), false);
  assert.equal(engine.canTransition('Rejected', 'Approved'), false);
  assert.equal(engine.canTransition('Cancelled', 'Pending Approval'), false);
  assert.equal(engine.canTransition('Draft', 'Approved'), false);
  assert.equal(engine.canTransition('Approved', 'Rejected'), false);
});

test('every status is reachable in the transition table', () => {
  for (const s of engine.STATUSES) {
    assert.ok(Array.isArray(engine.TRANSITIONS[s]), `${s} missing from TRANSITIONS`);
  }
});

/* ========================================================== approval engine */

const ladderOf = (...specs) =>
  engine.buildLadder(specs.map(([level, userId]) => ({ level, userId, userName: `U${userId}` })));

test('buildLadder renumbers levels 1..n so a gap cannot strand a request', () => {
  const ladder = engine.buildLadder([
    { level: 5, userId: 'a', userName: 'A' },
    { level: 9, userId: 'b', userName: 'B' },
  ]);
  assert.deepEqual(ladder.map((a) => a.level), [1, 2]);
  assert.equal(engine.levelsIn(ladder), 2);
});

test('single-level approval completes on the only approver', () => {
  const ladder = ladderOf([1, 'a']);
  const r = engine.decide(ladder, 1, 'a', 'Approved', 'ok');
  assert.equal(r.outcome, 'approved');
});

test('multi-level approval advances rather than completing early', () => {
  const ladder = ladderOf([1, 'a'], [2, 'b']);
  const first = engine.decide(ladder, 1, 'a', 'Approved');
  assert.equal(first.outcome, 'advanced');
  assert.equal(first.level, 2);

  const second = engine.decide(first.ladder, 2, 'b', 'Approved');
  assert.equal(second.outcome, 'approved');
});

test('a level with two approvers needs both signatures, not a race', () => {
  const ladder = ladderOf([1, 'a'], [1, 'b']);
  const first = engine.decide(ladder, 1, 'a', 'Approved');
  assert.equal(first.outcome, 'pending', 'one of two approvers must not clear the level');

  const second = engine.decide(first.ladder, 1, 'b', 'Approved');
  assert.equal(second.outcome, 'approved');
});

test('one rejection vetoes the request regardless of the other approvers', () => {
  const ladder = ladderOf([1, 'a'], [1, 'b'], [2, 'c']);
  const r = engine.decide(ladder, 1, 'a', 'Rejected', 'no');
  assert.equal(r.outcome, 'rejected');
});

test('decide is pure: it does not mutate the ladder it was given', () => {
  const ladder = ladderOf([1, 'a']);
  engine.decide(ladder, 1, 'a', 'Approved');
  assert.equal(ladder[0].status, 'Pending');
});

test('an approver who already acted cannot swing the level again', () => {
  const ladder = ladderOf([1, 'a'], [1, 'b']);
  const first = engine.decide(ladder, 1, 'a', 'Approved');
  // 'a' approves a second time (a double-clicked button, a replayed request).
  const replay = engine.decide(first.ladder, 1, 'a', 'Approved');
  assert.equal(replay.outcome, 'pending', 'a replay must not clear a level b has not signed');
});

test('isCurrentApprover gates on the active level, not mere membership', () => {
  const approvers = ladderOf([1, 'a'], [2, 'b']);
  const request = { approvers, current_level: 1 };
  assert.equal(engine.isCurrentApprover(request, 'a'), true);
  // b is an approver, but level 2 is not open yet — approving now would skip level 1.
  assert.equal(engine.isCurrentApprover(request, 'b'), false);
  assert.equal(engine.isCurrentApprover(request, 'zzz'), false);
});

/* ================================================================ registry */

test('every registered type declares what the engine needs to run it generically', () => {
  for (const [key, d] of Object.entries(registry.TYPES)) {
    assert.equal(d.key, key, `${key}: key mismatch`);
    assert.ok(d.label, `${key}: no label`);
    assert.ok(d.module, `${key}: no permission module`);
    assert.ok(d.table, `${key}: no table`);
    assert.ok(d.idField, `${key}: no idField`);
    assert.ok(['number', 'string'].includes(d.idType), `${key}: bad idType`);
    assert.ok(d.labelField, `${key}: no labelField`);
    assert.ok(['edit', 'action'].includes(d.kind), `${key}: bad kind`);
    assert.ok(Object.keys(d.fields).length > 0, `${key}: no proposable fields`);
    for (const [fk, spec] of Object.entries(d.fields)) {
      assert.ok(spec.label, `${key}.${fk}: no label`);
      assert.ok(spec.column, `${key}.${fk}: no column`);
    }
  }
});

test('the brief\'s twelve request types are all registered', () => {
  for (const k of [
    'po.edit', 'invoice.edit', 'amc.edit', 'asset.edit', 'asset.disposal', 'asset.transfer',
    'asset.return', 'employee.update', 'vendor.update', 'department.update', 'location.update',
    'category.update',
  ]) {
    assert.ok(registry.TYPES[k], `missing request type ${k}`);
  }
});

test('an unknown request type is a 400, not a crash', () => {
  assert.throws(() => registry.descriptorFor('nope.nope'), (e) => e.statusCode === 400);
});

/* ============================================================ notifications */

test('every request event renders on all three channels', () => {
  // templates.render throws on an unknown event, and the dispatcher renders before it
  // resolves recipients — so a missing template is a runtime failure of the action that
  // triggered it, not just a lost notification.
  const ctx = {
    requestId: 'REQ-00001', requestTypeLabel: 'Vendor Update Request', recordLabel: 'Dell',
    priority: 'High', reason: 'renamed', requestedByName: 'Rita', currentLevel: 1, totalLevels: 2,
    changes: [{ label: 'Name', before: 'Dell', after: 'Dell India' }], appliedChanges: [],
    comment: 'please attach the cheque', authorName: 'Alan', dueDate: '2026-08-01',
  };
  const events = templates.eventTypes.filter((e) => e.startsWith('request.'));
  assert.equal(events.length, 8, 'all eight lifecycle events must have templates');
  for (const event of events) {
    const r = templates.render(event, ctx);
    for (const channel of ['subject', 'inApp', 'email', 'sms']) {
      assert.ok(r[channel], `${event} has no ${channel}`);
    }
    assert.ok(r.email.includes('REQ-00001'), `${event} email does not identify the request`);
  }
});

test('a request template renders the diff rather than dropping it', () => {
  const r = templates.render('request.approval_requested', {
    requestId: 'REQ-1', requestTypeLabel: 'T', recordLabel: 'R', priority: 'Low', reason: 'x',
    requestedByName: 'Rita', currentLevel: 1, totalLevels: 1,
    changes: [{ label: 'Payment Terms', before: 'Net 30', after: 'Net 45' }],
  });
  assert.match(r.email, /Payment Terms: Net 30 → Net 45/);
});

test('an empty diff renders without crashing on undefined', () => {
  const r = templates.render('request.approved', {
    requestId: 'REQ-1', requestTypeLabel: 'T', recordLabel: 'R', requestedByName: 'Rita',
  });
  assert.ok(r.email.includes('no field changes'));
});

/* ================================================================ registry */

test('action types fold their fixed changes into the diffable field set', () => {
  // A disposal request must diff `status` even though the requester never proposes it,
  // otherwise the approval would apply a change the reviewer was never shown.
  const all = registry.allFields(registry.TYPES['asset.disposal']);
  assert.ok(all.status, 'asset.disposal must be able to diff status');
  assert.equal(registry.TYPES['asset.disposal'].fixedChanges.status, 'Disposed');
  assert.equal(registry.TYPES['asset.disposal'].fields.status, undefined,
    'status must not be requester-proposable on a disposal');
});
