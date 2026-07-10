import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, canLegacy, roleLabel, LEGACY_MAP, visibleModules } from './permissions.js';

const matrix = {
  Employee: { tickets: { view: true, create: true }, assets: { view: false }, documents: { view: true } },
  'IT Admin': { assets: { view: true, edit: true, delete: true }, finance: { view: false } }
};

test('Super Admin is always allowed, even with no matrix row', () => {
  assert.equal(can({}, 'Super Admin', 'systemSettings', 'manage'), true);
  assert.equal(canLegacy({}, 'Super Admin', 'delete'), true);
});

test('can() reads the nested matrix and denies missing cells', () => {
  assert.equal(can(matrix, 'Employee', 'tickets', 'create'), true);
  assert.equal(can(matrix, 'Employee', 'assets', 'view'), false);
  assert.equal(can(matrix, 'Employee', 'finance', 'view'), false); // module absent
});

test('legacy flat keys resolve through the matrix', () => {
  // 'write' -> assets.edit
  assert.equal(canLegacy(matrix, 'IT Admin', 'write'), true);
  // 'delete' -> assets.delete
  assert.equal(canLegacy(matrix, 'IT Admin', 'delete'), true);
  // 'viewDocuments' -> documents.view
  assert.equal(canLegacy(matrix, 'Employee', 'viewDocuments'), true);
  // 'finance' -> finance.edit, which IT Admin lacks
  assert.equal(canLegacy(matrix, 'IT Admin', 'finance'), false);
});

test('every legacy key maps to a real (module, verb) pair', () => {
  for (const [key, [mod, verb]] of Object.entries(LEGACY_MAP)) {
    assert.ok(typeof mod === 'string' && typeof verb === 'string', `${key} maps badly`);
  }
});

test('an unknown legacy key denies rather than throwing', () => {
  assert.equal(canLegacy(matrix, 'Employee', 'teleport'), false);
});

test('roleLabel uses the long display names, falls back to the key', () => {
  assert.equal(roleLabel('Super Admin'), 'Super Administrator');
  assert.equal(roleLabel('Manager'), 'Manager / Approver');
  assert.equal(roleLabel('Unknown Role'), 'Unknown Role');
});

test('visibleModules keeps only view-granted modules', () => {
  const modules = [{ key: 'tickets' }, { key: 'assets' }, { key: 'finance' }];
  const vis = visibleModules(matrix, 'Employee', modules).map((m) => m.key);
  assert.deepEqual(vis, ['tickets']); // assets.view false, finance absent
});

test('visibleModules gives Super Admin everything', () => {
  const modules = [{ key: 'a' }, { key: 'b' }];
  assert.equal(visibleModules({}, 'Super Admin', modules).length, 2);
});
