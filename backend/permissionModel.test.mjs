import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = require('./permissionModel.js');

test('all six requested roles exist, plus the three kept legacy roles', () => {
  const keys = model.ROLES.map((r) => r.key);
  for (const k of ['Super Admin', 'Admin Team', 'IT Admin', 'HR Team', 'Manager', 'Employee']) {
    assert.ok(keys.includes(k), `missing role ${k}`);
  }
  assert.equal(model.ROLES.length, 9);
});

test('display labels use the long requested names, keys stay short', () => {
  const byKey = Object.fromEntries(model.ROLES.map((r) => [r.key, r.label]));
  assert.equal(byKey['Super Admin'], 'Super Administrator');
  assert.equal(byKey['IT Admin'], 'IT Administrator');
  assert.equal(byKey['Manager'], 'Manager / Approver');
});

test('all requested modules are present', () => {
  const keys = model.MODULES.map((m) => m.key);
  const required = ['dashboard', 'assets', 'allocations', 'amc', 'finance', 'documents',
    'qr', 'reports', 'emails', 'tickets', 'sla', 'knowledge', 'userDirectory', 'userManagement',
    'departments', 'branches', 'categories', 'vendors', 'notificationSettings',
    'systemSettings', 'auditLogs', 'requests', 'purchaseRequests'];
  for (const k of required) assert.ok(keys.includes(k), `missing module ${k}`);
  assert.equal(model.MODULES.length, 23);
});

test('requests is grantable and denies by default to roles with no grant', () => {
  // The Requests module gates the shared approval engine, so a role that was never granted
  // it must not inherit approval rights from anywhere.
  assert.ok(model.MODULES.find((m) => m.key === 'requests').verbs.includes('approve'));
  const m = model.buildDefaultMatrix();
  assert.equal(model.can(m, 'Manager', 'requests', 'approve'), true);
  assert.equal(model.can(m, 'Employee', 'requests', 'approve'), false);
  assert.equal(model.can(m, 'Employee', 'requests', 'create'), true);
  assert.equal(model.can(m, 'Auditor', 'requests', 'approve'), false);
});

test('every module lists only verbs from the canonical set', () => {
  for (const m of model.MODULES) {
    assert.ok(m.verbs.length > 0, `${m.key} has no verbs`);
    for (const v of m.verbs) assert.ok(model.VERBS.includes(v), `${m.key} has unknown verb ${v}`);
  }
});

const matrix = model.buildDefaultMatrix();

test('Super Admin can do everything, in the matrix and via can()', () => {
  for (const m of model.MODULES) {
    for (const v of m.verbs) {
      assert.equal(matrix['Super Admin'][m.key][v], true);
      assert.equal(model.can(matrix, 'Super Admin', m.key, v), true);
    }
  }
});

test('Super Admin is unrestricted even against an empty matrix', () => {
  assert.equal(model.can({}, 'Super Admin', 'systemSettings', 'manage'), true);
});

test('Employee default: own tickets and knowledge, nothing administrative', () => {
  assert.equal(model.can(matrix, 'Employee', 'tickets', 'create'), true);
  assert.equal(model.can(matrix, 'Employee', 'knowledge', 'view'), true);
  assert.equal(model.can(matrix, 'Employee', 'assets', 'view'), false);
  assert.equal(model.can(matrix, 'Employee', 'finance', 'view'), false);
  assert.equal(model.can(matrix, 'Employee', 'userManagement', 'view'), false);
});

test('Manager can approve but the approve verb is off for roles that should not', () => {
  assert.equal(model.can(matrix, 'Manager', 'allocations', 'approve'), true);
  assert.equal(model.can(matrix, 'Manager', 'finance', 'approve'), true);
  assert.equal(model.can(matrix, 'Employee', 'finance', 'approve'), false);
  assert.equal(model.can(matrix, 'HR Team', 'finance', 'approve'), false);
});

test('HR Team manages users and departments, not assets or finance', () => {
  assert.equal(model.can(matrix, 'HR Team', 'userManagement', 'create'), true);
  assert.equal(model.can(matrix, 'HR Team', 'departments', 'edit'), true);
  assert.equal(model.can(matrix, 'HR Team', 'assets', 'view'), false);
  assert.equal(model.can(matrix, 'HR Team', 'finance', 'view'), false);
});

test('IT Admin owns the asset lifecycle but not finance or system settings', () => {
  assert.equal(model.can(matrix, 'IT Admin', 'assets', 'delete'), true);
  assert.equal(model.can(matrix, 'IT Admin', 'qr', 'manage'), true);
  assert.equal(model.can(matrix, 'IT Admin', 'vendors', 'create'), true);
  assert.equal(model.can(matrix, 'IT Admin', 'finance', 'view'), false);
  assert.equal(model.can(matrix, 'IT Admin', 'systemSettings', 'manage'), false);
});

test('Admin Team is broad but excludes Super-Admin-only system settings', () => {
  assert.equal(model.can(matrix, 'Admin Team', 'finance', 'approve'), true);
  assert.equal(model.can(matrix, 'Admin Team', 'userManagement', 'edit'), true);
  assert.equal(model.can(matrix, 'Admin Team', 'userManagement', 'manage'), false, 'permission editing stays with Super Admin');
  assert.equal(model.can(matrix, 'Admin Team', 'systemSettings', 'manage'), false);
});

test('Auditor is read-only: view/export yes, mutation no', () => {
  assert.equal(model.can(matrix, 'Auditor', 'assets', 'view'), true);
  assert.equal(model.can(matrix, 'Auditor', 'assets', 'export'), true);
  assert.equal(model.can(matrix, 'Auditor', 'assets', 'edit'), false);
  assert.equal(model.can(matrix, 'Auditor', 'assets', 'delete'), false);
  assert.equal(model.can(matrix, 'Auditor', 'finance', 'approve'), false);
});

test('sanitizeMatrix drops unknown roles, modules, and verbs', () => {
  const dirty = {
    'Employee': { tickets: { view: true, fly: true }, ghostModule: { view: true } },
    'Ghost Role': { tickets: { view: true } }
  };
  const clean = model.sanitizeMatrix(dirty);
  assert.equal(clean['Employee'].tickets.view, true);
  assert.equal('fly' in clean['Employee'].tickets, false, 'unknown verb dropped');
  assert.equal('ghostModule' in clean['Employee'], false, 'unknown module dropped');
  assert.equal('Ghost Role' in clean, false, 'unknown role dropped');
});

test('sanitizeMatrix coerces truthy/falsy to real booleans', () => {
  const clean = model.sanitizeMatrix({ 'Employee': { tickets: { view: 1, create: 0 } } });
  assert.strictEqual(clean['Employee'].tickets.view, true);
  assert.strictEqual(clean['Employee'].tickets.create, false);
});

test('can() denies a role with no matrix row rather than throwing', () => {
  assert.equal(model.can({}, 'Employee', 'assets', 'view'), false);
  assert.equal(model.can(null, 'Employee', 'assets', 'view'), false);
});
