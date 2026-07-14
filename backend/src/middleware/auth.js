// Authentication + permission enforcement, extracted verbatim from server.js.
//
// Built as a factory so the same bound helpers are shared by server.js and the
// per-domain route modules without re-wiring the JWT/role caches in each. The
// behavior — token parsing, the two short-lived caches, and the module->verb gate —
// is unchanged from when this lived inline in server.js.
const { cq } = require('../../convexApi');

module.exports = function createAuth({ jwt, permissionModel, JWT_SECRET, ALLOW_HEADER_AUTH }) {
  // --- ROLE PERMISSIONS ---
  // The authoritative permission matrix. Was frontend-only; now every client fetches
  // it from here and Super Admins persist edits to the database.

  // Cached briefly so per-request enforcement checks do not each hit the database.
  let rolePermissionsCache = null;
  let rolePermissionsCachedAt = 0;
  const ROLE_PERMS_TTL_MS = 30_000;

  const loadRolePermissions = async ({ fresh = false } = {}) => {
    if (!fresh && rolePermissionsCache && Date.now() - rolePermissionsCachedAt < ROLE_PERMS_TTL_MS) {
      return rolePermissionsCache;
    }
    const rows = await cq('permissions:list');
    const stored = Object.fromEntries(rows.map((r) => [r.role, r.permissions]));
    // Layer stored edits on top of the code defaults so modules added after a role
    // was last saved (e.g. sla/dashboard/reports) fall back to their default grants
    // instead of being absent — an absent module reads as fully denied. Explicit
    // stored verbs always win over the default; only never-saved modules use it.
    const base = permissionModel.buildDefaultMatrix();
    const merged = {};
    for (const role of Object.keys(base)) {
      merged[role] = {};
      for (const mod of Object.keys(base[role])) {
        merged[role][mod] = { ...base[role][mod], ...(stored[role]?.[mod] || {}) };
      }
    }
    rolePermissionsCache = merged;
    rolePermissionsCachedAt = Date.now();
    return rolePermissionsCache;
  };

  // Clears the matrix cache so the next enforcement check reads fresh from the DB.
  // Called after a Super Admin persists a role-permission edit.
  const invalidateRolePermissions = () => {
    rolePermissionsCache = null;
  };

  // Granular check against the module -> verb matrix. Super Admin is unconditional.
  // This is the single backend gate; Pass 2 threads it through every mutating endpoint.
  const roleAllows = async (role, moduleKey, verb) => {
    const matrix = await loadRolePermissions();
    return permissionModel.can(matrix, role, moduleKey, verb);
  };

  const authenticateRequest = (req) => {
    let token = null;
    const authHeader = req.headers['authorization'];

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }

    if (!token && req.headers.cookie) {
      const cookies = Object.fromEntries(
        req.headers.cookie.split(';').map(c => {
          const parts = c.trim().split('=');
          return [parts[0], parts.slice(1).join('=')];
        })
      );
      token = cookies['auth_token'];
    }

    if (token) {
      try {
        return { user: jwt.verify(token, JWT_SECRET) };
      } catch (e) {
        if (e.name === 'TokenExpiredError') {
          return { error: 'Your session has expired. Please sign in again.', code: 'TOKEN_EXPIRED' };
        }
        console.warn('JWT verify failed:', e.message);
        return { error: 'Your session is no longer valid. Please sign in again.', code: 'TOKEN_INVALID' };
      }
    }

    if (ALLOW_HEADER_AUTH) {
      const role = req.headers['x-user-role'] || req.query.role;
      const email = req.headers['x-user-email'] || req.query.email;
      const name = req.headers['x-user-name'] || req.query.name || email;
      const department = req.headers['x-user-department'] || req.query.department;
      const id = req.headers['x-user-id'] || req.query.userId;
      if (role) {
        return { user: { id: id ? parseInt(id, 10) : null, email, name, role, department } };
      }
    }

    return { error: 'You must be signed in to perform this action.', code: 'AUTH_REQUIRED' };
  };

  // Writes the failure straight to the response. Returns the user, or null if it replied.
  const requireUser = (req, res) => {
    const { user, error, code } = authenticateRequest(req);
    if (!user) {
      res.status(401).json({ error, code });
      return null;
    }
    return user;
  };

  // The JWT carries the role from login time. If an admin changes a user's role, the
  // token still says the old one until the user re-logs in — which the brief forbids.
  // So resolve the *current* role from the database at the permission boundary, cached
  // briefly to keep it off the hot path. invalidateUserRole() clears it on a role edit.
  const userRoleCache = new Map(); // id -> { role, at }
  const USER_ROLE_TTL_MS = 15_000;

  async function currentRoleOf(user) {
    if (!user || user.id == null) return user && user.role;
    const cached = userRoleCache.get(user.id);
    if (cached && Date.now() - cached.at < USER_ROLE_TTL_MS) return cached.role;
    try {
      // The session token's `id` is the workos_user_id. Reading the live role here is
      // what lets a Super Admin's role change take effect without the affected user
      // re-logging in. Resolved from Convex (the users source of truth).
      const liveRole = await cq('users:getRole', { workosUserId: user.id });
      const role = liveRole || user.role;
      userRoleCache.set(user.id, { role, at: Date.now() });
      return role;
    } catch {
      return user.role; // never fail a request because the role lookup hiccuped
    }
  }

  function invalidateUserRole(id) {
    if (id != null) userRoleCache.delete(id);
  }

  /**
   * The single backend permission gate. Authenticates, resolves the caller's current
   * role, and checks it against the module -> verb matrix. Returns the user (with the
   * fresh role attached) or null after sending 403. Replaces the hardcoded role-string
   * checks scattered across the endpoints.
   */
  async function requirePermission(req, res, moduleKey, verb) {
    const user = requireUser(req, res);
    if (!user) return null;
    const role = await currentRoleOf(user);
    if (await roleAllows(role, moduleKey, verb)) {
      return { ...user, role };
    }
    res.status(403).json({ error: `Your role is not permitted to ${verb} this resource.` });
    return null;
  }

  // Boolean form, for routes that have already authenticated and only need to gate one
  // action inline. Resolves the caller's current role, then checks the matrix.
  async function roleCan(user, moduleKey, verb) {
    if (!user) return false;
    return roleAllows(await currentRoleOf(user), moduleKey, verb);
  }

  /* ---------------- Asset visibility ----------------
   * An Employee is a custodian, not a manager: they may see only the assets currently
   * assigned to them, and may not create, modify or delete any asset.
   *
   * Scoping keys on asset_assignments.user_id — the foreign-keyed truth — not on
   * assets.assigned_employee, which holds a display summary like "Alice Johnson (1)".
   */
  const isEmployee = (user) => user.role === 'Employee';

  // Subquery of the asset ids a given employee currently holds. Used everywhere an
  // asset, movement or assignment is exposed, so one definition governs all of them.
  const EMPLOYEE_ASSET_IDS = `
  SELECT aa.asset_id FROM asset_assignments aa
  WHERE aa.user_id = $1 AND aa.status = 'Assigned'
`;

  /**
   * Like requireUser, but guarantees `department` is populated. Tokens issued before
   * department was added to the JWT payload do not carry it, and the ticket queue
   * filters on department — those users would otherwise see nothing until their token
   * expired. Falls back to a lookup, so old sessions keep working.
   */
  const requireUserWithDepartment = async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return null;
    if (user.department !== undefined && user.department !== null) return user;

    try {
      const u = await cq('users:getByWorkosId', { workosUserId: user.id });
      if (u) {
        user.department = u.department;
        user.name = user.name || u.name;
      }
    } catch (err) {
      console.warn('Could not resolve department for user', user.id, err.message);
    }
    return user;
  };

  return {
    loadRolePermissions,
    invalidateRolePermissions,
    roleAllows,
    authenticateRequest,
    requireUser,
    currentRoleOf,
    invalidateUserRole,
    requirePermission,
    roleCan,
    isEmployee,
    EMPLOYEE_ASSET_IDS,
    requireUserWithDepartment,
  };
};
