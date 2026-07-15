import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const permissionModel = require('./permissionModel.js');

// Role resolution moved from SQL to Convex during the migration: the gate now reads the
// caller's *live* role via cq('users:getRole') and the matrix via cq('permissions:list'),
// not a SQL `db`. So the deterministic seam is the Convex client, which auth.js requires at
// module load — stub it in the module cache BEFORE requiring auth.js, otherwise the lookup
// hits the real deployment and the test cannot control the "current" role.
let mockLiveRole = 'Super Admin'; // what users:getRole returns for the token's user id
const convexApiPath = require.resolve('./convexApi.js');
require.cache[convexApiPath] = {
  id: convexApiPath,
  filename: convexApiPath,
  loaded: true,
  exports: {
    cq: async (name) => {
      if (name === 'users:getRole') return mockLiveRole;
      if (name === 'permissions:list') return []; // no stored edits -> the default matrix governs
      return null;
    },
    cm: async () => null,
    client: null,
  },
};

const createAuth = require('./src/middleware/auth.js');

const JWT_SECRET = 'test-secret';

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// `userRole` is the role the Convex users:getRole lookup will report for the request — i.e.
// the live/current role, which requirePermission must honour over whatever the token claims.
function build({ userRole = 'Super Admin', ALLOW_HEADER_AUTH = false } = {}) {
  mockLiveRole = userRole;
  return createAuth({ jwt, permissionModel, JWT_SECRET, ALLOW_HEADER_AUTH });
}

test('authenticateRequest rejects a request with no credentials', () => {
  const auth = build();
  const result = auth.authenticateRequest({ headers: {}, query: {} });
  assert.equal(result.user, undefined);
  assert.equal(result.code, 'AUTH_REQUIRED');
});

test('authenticateRequest accepts a valid Bearer token', () => {
  const auth = build();
  const token = jwt.sign({ id: 7, email: 'alice@company.com', role: 'IT Admin' }, JWT_SECRET);
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
