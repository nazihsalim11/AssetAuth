import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const permissionModel = require('./permissionModel.js');
const createAuth = require('./src/middleware/auth.js');

const JWT_SECRET = 'test-secret';

// A minimal db stub that answers only the queries the auth helpers issue. Each test
// passes the role rows it wants; everything else returns an empty result.
function makeDb({ userRole = 'Super Admin', permissions = [] } = {}) {
  return {
    query: async (text) => {
      if (text.includes('FROM role_permissions')) return { rows: permissions };
      if (text.includes('SELECT role FROM users')) return { rows: userRole ? [{ role: userRole }] : [] };
      if (text.includes('SELECT department, name FROM users')) return { rows: [{ department: 'IT', name: 'Test User' }] };
      return { rows: [] };
    },
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function build(opts = {}) {
  return createAuth({
    db: makeDb(opts),
    jwt,
    permissionModel,
    JWT_SECRET,
    ALLOW_HEADER_AUTH: opts.ALLOW_HEADER_AUTH || false,
  });
}

test('authenticateRequest rejects a request with no credentials', () => {
  const auth = build();
  const result = auth.authenticateRequest({ headers: {}, query: {} });
  assert.equal(result.user, undefined);
  assert.equal(result.code, 'AUTH_REQUIRED');
});

test('authenticateRequest accepts a valid Bearer token', () => {
  const auth = build();
  const token = jwt.sign({ id: 7, username: 'alice', role: 'IT Admin' }, JWT_SECRET);
  const result = auth.authenticateRequest({ headers: { authorization: `Bearer ${token}` }, query: {} });
  assert.equal(result.error, undefined);
  assert.equal(result.user.id, 7);
  assert.equal(result.user.role, 'IT Admin');
});

test('authenticateRequest reports an expired token distinctly', () => {
  const auth = build();
  const token = jwt.sign({ id: 7, role: 'IT Admin' }, JWT_SECRET, { expiresIn: -10 });
  const result = auth.authenticateRequest({ headers: { authorization: `Bearer ${token}` }, query: {} });
  assert.equal(result.code, 'TOKEN_EXPIRED');
});

test('header auth stays off unless explicitly enabled', () => {
  const off = build();
  assert.equal(off.authenticateRequest({ headers: { 'x-user-role': 'Super Admin' }, query: {} }).code, 'AUTH_REQUIRED');
  const on = build({ ALLOW_HEADER_AUTH: true });
  assert.equal(on.authenticateRequest({ headers: { 'x-user-role': 'Super Admin' }, query: {} }).user.role, 'Super Admin');
});

test('requireUser writes a 401 and returns null when unauthenticated', () => {
  const auth = build();
  const res = makeRes();
  const user = auth.requireUser({ headers: {}, query: {} }, res);
  assert.equal(user, null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'AUTH_REQUIRED');
});

test('isEmployee flags only the Employee role', () => {
  const auth = build();
  assert.equal(auth.isEmployee({ role: 'Employee' }), true);
  assert.equal(auth.isEmployee({ role: 'IT Admin' }), false);
});

test('EMPLOYEE_ASSET_IDS is the assigned-asset subquery', () => {
  const auth = build();
  assert.match(auth.EMPLOYEE_ASSET_IDS, /FROM asset_assignments/);
  assert.match(auth.EMPLOYEE_ASSET_IDS, /status = 'Assigned'/);
});

test('requirePermission lets a Super Admin through unconditionally', async () => {
  const auth = build({ userRole: 'Super Admin' });
  const res = makeRes();
  const token = jwt.sign({ id: 1, role: 'Super Admin' }, JWT_SECRET);
  const user = await auth.requirePermission({ headers: { authorization: `Bearer ${token}` }, query: {} }, res, 'assets', 'delete');
  assert.ok(user);
  assert.equal(user.role, 'Super Admin');
  assert.equal(res.statusCode, null);
});

test('requirePermission resolves the current role from the DB, not the stale token', async () => {
  // Token still claims Super Admin, but the DB now says Employee -> must be denied.
  const auth = build({ userRole: 'Employee' });
  const res = makeRes();
  const token = jwt.sign({ id: 2, role: 'Super Admin' }, JWT_SECRET);
  const user = await auth.requirePermission({ headers: { authorization: `Bearer ${token}` }, query: {} }, res, 'assets', 'delete');
  assert.equal(user, null);
  assert.equal(res.statusCode, 403);
});

test('invalidateRolePermissions and invalidateUserRole are callable no-ops without throwing', () => {
  const auth = build();
  assert.doesNotThrow(() => auth.invalidateRolePermissions());
  assert.doesNotThrow(() => auth.invalidateUserRole(1));
  assert.doesNotThrow(() => auth.invalidateUserRole(null));
});
