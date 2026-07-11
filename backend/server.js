const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cron = require('node-cron');
const { randomUUID } = require('crypto');
const db = require('./db');
const { runMigrations } = require('./migrations');
const storage = require('./storage');
const notifications = require('./notifications');
const scheduler = require('./notifications/scheduler');
const { registerCronRoutes } = require('./cronRoutes');
const permissionModel = require('./permissionModel');
const knowledgeBase = require('./knowledgeBase');
const purchaseOrders = require('./purchaseOrders');
const slaModel = require('./slaModel');
const slaEngine = require('./slaEngine');
const slaRoutes = require('./slaRoutes');
const slaAssignment = require('./slaAssignment');
const dashboards = require('./dashboards');
const reports = require('./reports');
const createAuth = require('./src/middleware/auth');
const assetsRoutes = require('./src/routes/assets');
const amcRoutes = require('./src/routes/amc');
const invoicesRoutes = require('./src/routes/invoices');
const movementsRoutes = require('./src/routes/movements');
const documentsRoutes = require('./src/routes/documents');
const logsRoutes = require('./src/routes/logs');
const notificationsRoutes = require('./src/routes/notifications');
const permissionsRoutes = require('./src/routes/permissions');
const importsRoutes = require('./src/routes/imports');
const assignmentsRoutes = require('./src/routes/assignments');
const ticketsRoutes = require('./src/routes/tickets');
const validateAndFormatPhone = require('./src/utils/phone');
const createActorOf = require('./src/utils/actor');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const app = express();

// Wide-open CORS is fine for local development, but in production only the
// deployed frontend should be able to call this API. Set ALLOWED_ORIGINS to a
// comma-separated list, e.g. "https://assetflow.vercel.app".
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (allowedOrigins.length > 0) {
  app.use(cors({
    origin: (origin, callback) => {
      // Same-origin and server-to-server requests carry no Origin header.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      // Reply without the CORS header rather than throwing: the browser blocks the
      // read, and we avoid turning every stray cross-origin probe into a 500.
      callback(null, false);
    }
  }));
} else {
  if (IS_PRODUCTION) {
    console.warn('WARNING: ALLOWED_ORIGINS is not set — this API accepts requests from any origin.');
  }
  app.use(cors());
}

app.use(express.json());

// Liveness probe. Unauthenticated and touches no database, so it can serve as a
// health check for the host, a warm-up ping to wake a sleeping free-tier instance,
// and the frontend's connectivity test — none of which should need a token or log a
// 401. Kept before the auth middleware for exactly that reason.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'assetflow-api', time: new Date().toISOString() });
});

// Middleware to recursively map snake_case request body keys to camelCase
function normalizeSnakeToCamel(obj) {
  if (Array.isArray(obj)) {
    return obj.map(v => normalizeSnakeToCamel(v));
  } else if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    const keys = Object.keys(obj);
    for (const key of keys) {
      const val = normalizeSnakeToCamel(obj[key]);
      obj[key] = val;
      if (key.includes('_')) {
        const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        if (obj[camelKey] === undefined) {
          obj[camelKey] = val;
        }
      }
    }
  }
  return obj;
}

app.use((req, res, next) => {
  if (req.body) {
    normalizeSnakeToCamel(req.body);
  }
  next();
});

// The development fallback below is committed to this repository, so anyone who
// reads it could forge a token for any user. Refuse to boot without a real secret
// once we are running for real.
if (IS_PRODUCTION && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production. Refusing to start with the public default.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_assetflow_token';

// --- CUSTOM AUTH / JWT USER EXTRACTOR HELPER ---
// Trusting `x-user-role`/`x-user-id` headers let any unauthenticated caller act as
// any user (e.g. create tickets as Super Admin id=1). The frontend never sends them,
// so the fallback is opt-in via env for local integration testing only.
const ALLOW_HEADER_AUTH = process.env.ALLOW_HEADER_AUTH === 'true';

// Authentication + the permission gate live in src/middleware/auth.js. Bound here once
// and destructured into locals so every route below (inline or in a route module) uses
// the same JWT wiring and short-lived role caches.
const auth = createAuth({ db, jwt, permissionModel, JWT_SECRET, ALLOW_HEADER_AUTH });
const {
  loadRolePermissions,
  roleAllows,
  authenticateRequest,
  requireUser,
  invalidateUserRole,
  requirePermission,
  roleCan,
  isEmployee,
  EMPLOYEE_ASSET_IDS,
  requireUserWithDepartment,
} = auth;

// Who performed the request, for notification payloads. Shared by the invoices and
// tickets routes; defined in src/utils/actor.js.
const actorOf = createActorOf(authenticateRequest);

// Files are buffered in memory, then handed to storage.js, which puts them in a
// private Supabase bucket (or on local disk when Supabase is not configured).
// Writing to the container's disk would not survive a redeploy.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Serves files written by the local-disk fallback. In production nothing is
// written here — objects live in the private bucket and are reached via signed URLs.
if (!storage.isRemote) {
  app.use('/uploads', express.static(storage.uploadDir));
}

// --- ASSETS API ---
// Extracted verbatim to src/routes/assets.js. Registered here — not at the bottom with
// the other modules — to preserve the original route-registration order exactly.
assetsRoutes.register(app, { requireUser, requirePermission, isEmployee, EMPLOYEE_ASSET_IDS });

// --- AMCS API ---
// Extracted verbatim to src/routes/amc.js; registered in place to keep route order.
amcRoutes.register(app, { requirePermission });


// --- INVOICES API ---
// Extracted verbatim to src/routes/invoices.js (routes + the invoice⇆asset mapping
// helpers); registered in place to preserve route-registration order.
invoicesRoutes.register(app, { requirePermission, actorOf });

// --- MOVEMENTS / DOCUMENTS / LOGS APIs ---
// Extracted verbatim to src/routes/{movements,documents,logs}.js; registered in
// place to preserve route-registration order.
movementsRoutes.register(app, { requireUser, requirePermission, isEmployee, EMPLOYEE_ASSET_IDS });
documentsRoutes.register(app, { requireUser, roleAllows });
logsRoutes.register(app);


// --- NOTIFICATIONS + ROLE-PERMISSIONS APIs ---
// Extracted verbatim to src/routes/{notifications,permissions}.js; registered in
// place. notifications.js covers notifications, the email inbox, and notification
// administration (settings/preferences/history/retry).
notificationsRoutes.register(app, { requireUser, requirePermission, authenticateRequest });
permissionsRoutes.register(app, {
  requireUser,
  roleCan,
  loadRolePermissions,
  invalidateRolePermissions: auth.invalidateRolePermissions,
});

// Auth extractor, the role caches, the permission gate (requirePermission/roleCan),
// isEmployee/EMPLOYEE_ASSET_IDS and requireUserWithDepartment are defined in
// src/middleware/auth.js and bound into locals near the top via createAuth().

// validateAndFormatPhone now lives in src/utils/phone.js (required above).

// Reliable user creation helper used by both manual registration and bulk import
async function createSingleUser(client, { username, password, name, role, email, employeeId, phoneNumber, department, designation, status, resetRequired = false }) {
  // Validate duplicate username (case-insensitive)
  const usernameExists = await client.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  if (usernameExists.rows.length > 0) {
    throw new Error(`Username '${username}' already exists. Please use a unique Username.`);
  }

  const emailExists = await client.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  if (emailExists.rows.length > 0) {
    throw new Error(`Email '${email}' is already registered.`);
  }

  if (employeeId) {
    const empIdExists = await client.query('SELECT 1 FROM users WHERE LOWER(employee_id) = LOWER($1)', [employeeId]);
    if (empIdExists.rows.length > 0) {
      throw new Error(`Employee ID '${employeeId}' already exists. Please use a unique Employee ID.`);
    }
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  // 1. Generate authId
  const { randomUUID } = require('crypto');
  const authId = randomUUID();

  // 2. Insert into auth.users
  const rawUserMetadata = JSON.stringify({ name, role, username });
  const authQuery = `
    INSERT INTO auth.users (
      id, instance_id, email, encrypted_password, aud, role, 
      is_sso_user, is_anonymous, email_confirmed_at, 
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES ($1, '00000000-0000-0000-0000-000000000000', $2, $3, 'authenticated', 'authenticated', 
              false, false, NOW(), 
              '{"provider":"email","providers":["email"]}'::jsonb, $4::jsonb, NOW(), NOW())
  `;
  await client.query(authQuery, [authId, email, passwordHash, rawUserMetadata]);

  // 3. Insert into public.users
  const query = `
    INSERT INTO users (username, password_hash, name, role, email, employee_id, phone_number, department, designation, status, password_reset_required, auth_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING id, username, name, role, email, employee_id, phone_number, department, designation, status, password_reset_required, created_at, auth_id;
  `;
  const values = [
    username,
    passwordHash,
    name,
    role,
    email,
    employeeId || null,
    phoneNumber || '',
    department || '',
    designation || '',
    status || 'Active',
    resetRequired,
    authId
  ];
  const result = await client.query(query, values);
  return result.rows[0];
}

// --- BULK IMPORT APIS ---
// Extracted verbatim to src/routes/imports.js (employee + asset import, the
// background-job runner, and multi-row insert batching). No auth gate, as before.
importsRoutes.register(app);

// --- QUANTITY BASED ASSIGNMENT APIS ---
// Extracted verbatim to src/routes/assignments.js; registered in place.
assignmentsRoutes.register(app, { requireUser, requirePermission, isEmployee });

// --- DEPARTMENTAL TICKETING SYSTEM APIS ---
// Extracted verbatim to src/routes/tickets.js (queue, bulk ops, detail, comments,
// assignment/auto-assign, status/priority/category/department, analytics + SLA).
ticketsRoutes.register(app, { requireUser, requireUserWithDepartment, roleCan });

// --- AUTHENTICATION API ---
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Please enter both username and password.' });
  }

  try {
    const result = await db.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // `department` and `name` are signed in because the ticket queue routes on them.
    // Without department, non-admin agents matched `WHERE department = ''` and saw an
    // empty queue.
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name, department: user.department },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      session: {
        id: user.id,
        username: user.username,
        role: user.role,
        name: user.name,
        email: user.email,
        employeeId: user.employee_id,
        phoneNumber: user.phone_number,
        department: user.department,
        designation: user.designation,
        status: user.status,
        passwordResetRequired: user.password_reset_required
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/change-password', async (req, res) => {
  const { username, currentPassword, newPassword } = req.body;
  if (!username || !newPassword) {
    return res.status(400).json({ error: 'Username and new password are required.' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    if (currentPassword) {
      const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await db.query(
      'UPDATE users SET password_hash = $1, password_reset_required = FALSE WHERE id = $2',
      [passwordHash, user.id]
    );

    res.json({ message: 'Password updated successfully.' });

    // Timestamped key: a second password change is a second event, not a duplicate.
    notifications.notify('security.password_changed', `password-changed:${user.id}:${Date.now()}`, {
      username: user.username,
      at: new Date().toISOString()
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

// --- USER MANAGEMENT API ---
// Department options, derived from the directory rather than a hardcoded list, so the
// dropdowns reflect the departments that actually exist. Unioned with a small seed set
// so a brand-new database still offers sensible defaults.
app.get('/api/departments', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT TRIM(department) AS department FROM users
       WHERE department IS NOT NULL AND TRIM(department) <> ''
       ORDER BY 1`
    );
    const seeds = ['IT', 'HR', 'Finance', 'Operations', 'Administration'];
    const merged = [...new Set([...rows.map((r) => r.department), ...seeds])].sort();
    res.json(merged);
  } catch (err) {
    console.error('GET /api/departments failed:', err);
    res.status(500).json({ error: 'Could not load departments: ' + err.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, username, name, role, email, employee_id, phone_number, department, designation, status, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

app.post('/api/users', async (req, res) => {
  const { username, password, name, role, email, employeeId, phoneNumber, department, designation, status } = req.body;
  if (!username || !password || !name || !role || !email) {
    return res.status(400).json({ error: 'All fields are required (username, password, name, role, email).' });
  }

  // Validate phone number format
  let formattedPhone = '';
  if (phoneNumber) {
    const phoneValidation = validateAndFormatPhone(phoneNumber);
    if (!phoneValidation.isValid) {
      return res.status(400).json({ error: phoneValidation.error });
    }
    formattedPhone = phoneValidation.value;
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const createdUser = await createSingleUser(client, {
      username,
      password,
      name,
      role,
      email,
      employeeId,
      phoneNumber: formattedPhone,
      department,
      designation,
      status,
      resetRequired: false
    });
    await client.query('COMMIT');
    res.status(201).json(createdUser);

    notifications.notify('user.created', `user-created:${createdUser.id}`, {
      name: createdUser.name || createdUser.username,
      username: createdUser.username,
      role: createdUser.role,
      department: createdUser.department,
      actor: actorOf(req)
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during manual user creation:', err);
    res.status(400).json({ error: err.message || 'Database insertion failed.' });
  } finally {
    client.release();
  }
});

// PATCH /api/users/:id - Edit User Details
app.patch('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { name, role, email, employeeId, phoneNumber, department, designation, status, password } = req.body;

  let formattedPhone = '';
  if (phoneNumber) {
    const phoneValidation = validateAndFormatPhone(phoneNumber);
    if (!phoneValidation.isValid) {
      return res.status(400).json({ error: phoneValidation.error });
    }
    formattedPhone = phoneValidation.value;
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Check if user exists
    const userResult = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    // Check duplicate email
    let finalUsername = user.username;
    if (email && email.toLowerCase() !== user.email?.toLowerCase()) {
      const emailExists = await client.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2', [email, id]);
      if (emailExists.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Email address is already registered by another user.' });
      }

      const emailParts = email.split('@');
      finalUsername = emailParts[0];

      // Check duplicate username
      const usernameExists = await client.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2', [finalUsername, id]);
      if (usernameExists.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Username '${finalUsername}' already exists. Please use a unique Email address.` });
      }
    }

    // Check duplicate employee ID
    if (employeeId && (user.employee_id === null || employeeId.toLowerCase() !== user.employee_id.toLowerCase())) {
      const empIdExists = await client.query('SELECT 1 FROM users WHERE LOWER(employee_id) = LOWER($1) AND id <> $2', [employeeId, id]);
      if (empIdExists.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Employee ID '${employeeId}' already exists. Please use a unique Employee ID.` });
      }
    }

    let passwordHash = user.password_hash;
    if (password) {
      const salt = await bcrypt.genSalt(10);
      passwordHash = await bcrypt.hash(password, salt);
    }

    // Update auth.users if auth_id exists
    if (user.auth_id) {
      const authUpdateQuery = `
        UPDATE auth.users
        SET email = COALESCE($1, email),
            encrypted_password = COALESCE($2, encrypted_password),
            raw_user_meta_data = raw_user_meta_data || $3::jsonb,
            updated_at = NOW()
        WHERE id = $4
      `;
      const metadata = JSON.stringify({
        name: name || user.name,
        role: role || user.role,
        username: finalUsername || user.username
      });
      await client.query(authUpdateQuery, [email || null, password ? passwordHash : null, metadata, user.auth_id]);
    }

    const query = `
      UPDATE users 
      SET name = COALESCE($1, name),
          role = COALESCE($2, role),
          email = COALESCE($3, email),
          employee_id = COALESCE($4, employee_id),
          phone_number = COALESCE($5, phone_number),
          department = COALESCE($6, department),
          designation = COALESCE($7, designation),
          status = COALESCE($8, status),
          password_hash = $9,
          username = COALESCE($11, username)
      WHERE id = $10
      RETURNING id, username, name, role, email, employee_id, phone_number, department, designation, status, password_reset_required, created_at;
    `;
    const values = [
      name,
      role,
      email,
      employeeId,
      formattedPhone || phoneNumber || '',
      department,
      designation,
      status,
      passwordHash,
      id,
      finalUsername
    ];
    const result = await client.query(query, values);
    
    await client.query('COMMIT');
    const updated = result.rows[0];
    res.json(updated);

    // Roles grant permissions, so a change is worth telling the admins about. Keyed
    // on the destination role: setting the same role twice is not a second event.
    if (role && role !== user.role) {
      // Immediacy: the next request from this user resolves the new role rather than
      // the one baked into their JWT, so the change takes effect without a re-login.
      invalidateUserRole(updated.id);
      notifications.notify('user.role_changed', `user-role:${updated.id}:${role}`, {
        name: updated.name || updated.username,
        username: updated.username,
        previousRole: user.role,
        newRole: role,
        actor: actorOf(req)
      });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database update failed: ' + (err.detail || err.message) });
  } finally {
    client.release();
  }
});

// DELETE /api/users/:id - Delete User
app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const check = await client.query('SELECT username, name, role, auth_id FROM users WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    const { username, auth_id } = check.rows[0];
    const deletedUser = check.rows[0];
    
    // Find affected assets before deleting assignments
    const affectedAssets = await client.query('SELECT DISTINCT asset_id FROM asset_assignments WHERE user_id = $1', [id]);
    const affectedAssetIds = affectedAssets.rows.map(r => r.asset_id);

    await client.query('DELETE FROM asset_assignments WHERE user_id = $1', [id]);
    if (auth_id) {
      await client.query('DELETE FROM auth.users WHERE id = $1', [auth_id]);
    } else {
      await client.query('DELETE FROM users WHERE id = $1', [id]);
    }

    // Recalculate quantities for each affected asset
    for (const assetId of affectedAssetIds) {
      const activeAssignmentsRes = await client.query(`
        SELECT employee_name, SUM(quantity) as qty
        FROM asset_assignments
        WHERE asset_id = $1 AND status = 'Assigned'
        GROUP BY employee_name
      `, [assetId]);
      
      const newAssignedQty = activeAssignmentsRes.rows.reduce((sum, row) => sum + parseInt(row.qty), 0);
      const summaryStr = activeAssignmentsRes.rows.map(row => `${row.employee_name} (${row.qty})`).join(', ') || '';
      
      const assetInfo = await client.query('SELECT total_quantity FROM assets WHERE id = $1', [assetId]);
      if (assetInfo.rows.length > 0) {
        const newAvailableQty = Math.max(0, assetInfo.rows[0].total_quantity - newAssignedQty);
        const newStatus = newAvailableQty > 0 ? 'Available' : 'Assigned';
        
        await client.query(`
          UPDATE assets
          SET 
            assigned_quantity = $1, 
            available_quantity = $2,
            status = $3,
            assigned_employee = $4,
            updated_at = NOW()
          WHERE id = $5
        `, [newAssignedQty, newAvailableQty, newStatus, summaryStr || null, assetId]);
      }
    }

    await client.query('COMMIT');
    res.json({ message: `User "${username}" deleted successfully` });

    notifications.notify('user.deleted', `user-deleted:${id}`, {
      name: deletedUser.name || deletedUser.username,
      username: deletedUser.username,
      role: deletedUser.role,
      actor: actorOf(req)
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database deletion failed' });
  } finally {
    client.release();
  }
});

// POST /api/users/bulk/delete - Bulk Delete Users
app.post('/api/users/bulk/delete', async (req, res) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: 'Payload must contain a userIds array' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const check = await client.query('SELECT auth_id, id FROM users WHERE id = ANY($1::int[])', [userIds]);
    const authIds = check.rows.map(r => r.auth_id).filter(Boolean);
    const foundIds = check.rows.map(r => r.id);
    
    // Find affected assets before deleting assignments
    const affectedAssets = await client.query('SELECT DISTINCT asset_id FROM asset_assignments WHERE user_id = ANY($1::int[])', [foundIds]);
    const affectedAssetIds = affectedAssets.rows.map(r => r.asset_id);

    await client.query('DELETE FROM asset_assignments WHERE user_id = ANY($1::int[])', [foundIds]);
    if (authIds.length > 0) {
      await client.query('DELETE FROM auth.users WHERE id = ANY($1::uuid[])', [authIds]);
    }
    await client.query('DELETE FROM users WHERE id = ANY($1::int[])', [foundIds]);
    
    // Recalculate quantities for each affected asset
    for (const assetId of affectedAssetIds) {
      const activeAssignmentsRes = await client.query(`
        SELECT employee_name, SUM(quantity) as qty
        FROM asset_assignments
        WHERE asset_id = $1 AND status = 'Assigned'
        GROUP BY employee_name
      `, [assetId]);
      
      const newAssignedQty = activeAssignmentsRes.rows.reduce((sum, row) => sum + parseInt(row.qty), 0);
      const summaryStr = activeAssignmentsRes.rows.map(row => `${row.employee_name} (${row.qty})`).join(', ') || '';
      
      const assetInfo = await client.query('SELECT total_quantity FROM assets WHERE id = $1', [assetId]);
      if (assetInfo.rows.length > 0) {
        const newAvailableQty = Math.max(0, assetInfo.rows[0].total_quantity - newAssignedQty);
        const newStatus = newAvailableQty > 0 ? 'Available' : 'Assigned';
        
        await client.query(`
          UPDATE assets
          SET 
            assigned_quantity = $1, 
            available_quantity = $2,
            status = $3,
            assigned_employee = $4,
            updated_at = NOW()
          WHERE id = $5
        `, [newAssignedQty, newAvailableQty, newStatus, summaryStr || null, assetId]);
      }
    }

    await client.query('COMMIT');
    res.json({ message: `${userIds.length} users deleted successfully` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Bulk deletion failed' });
  } finally {
    client.release();
  }
});

// POST /api/users/bulk/status - Bulk Change Status (Activate/Deactivate)
app.post('/api/users/bulk/status', async (req, res) => {
  const { userIds, status } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0 || !status) {
    return res.status(400).json({ error: 'Payload must contain userIds array and status' });
  }
  try {
    await db.query('UPDATE users SET status = $1 WHERE id = ANY($2::int[])', [status, userIds]);
    res.json({ message: `Status updated to "${status}" for ${userIds.length} users` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk status update failed' });
  }
});

// POST /api/users/bulk/reset-password - Bulk Reset Password
app.post('/api/users/bulk/reset-password', async (req, res) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: 'Payload must contain a userIds array' });
  }
  try {
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash('Welcome@123', salt);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = ANY($2::int[])', [passwordHash, userIds]);
    res.json({ message: `Password reset to "Welcome@123" for ${userIds.length} users` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk password reset failed' });
  }
});

// POST /api/users/bulk/department - Bulk Change Department
app.post('/api/users/bulk/department', async (req, res) => {
  const { userIds, department } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0 || !department) {
    return res.status(400).json({ error: 'Payload must contain userIds array and department' });
  }
  try {
    await db.query('UPDATE users SET department = $1 WHERE id = ANY($2::int[])', [department, userIds]);
    res.json({ message: `Department updated to "${department}" for ${userIds.length} users` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk department update failed' });
  }
});

// POST /api/users/bulk/role - Bulk Change Role
app.post('/api/users/bulk/role', async (req, res) => {
  const { userIds, role } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0 || !role) {
    return res.status(400).json({ error: 'Payload must contain userIds array and role' });
  }
  try {
    await db.query('UPDATE users SET role = $1 WHERE id = ANY($2::int[])', [role, userIds]);
    res.json({ message: `Role updated to "${role}" for ${userIds.length} users` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk role update failed' });
  }
});

// --- FILE UPLOAD API ---
// Uploads write into your storage bucket, so they require a signed-in user.
// `fileUrl` is kept as the response key for compatibility, but it now carries a
// durable storage *path* rather than a URL. Resolve it via /api/files/signed-url.
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const filePath = await storage.saveFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    res.json({
      name: req.file.originalname,
      fileName: filePath.split('/').pop(),
      fileSize: `${(req.file.size / 1024).toFixed(1)} KB`,
      fileUrl: filePath
    });
  } catch (err) {
    console.error('File upload failed:', err);
    res.status(500).json({ error: err.message || 'File upload failed' });
  }
});

// Mints a short-lived link to a stored file. Because the bucket is private, this
// is the only way to read one — and it requires authentication.
app.post('/api/files/signed-url', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const filePath = req.body?.path;
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'A file path is required' });
  }

  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = await storage.getSignedUrl(filePath, baseUrl);
    res.json({ url, expiresIn: storage.SIGNED_URL_TTL_SECONDS });
  } catch (err) {
    console.error('Could not sign file URL:', err);
    res.status(404).json({ error: err.message || 'File is not available' });
  }
});

// --- SCHEDULED NOTIFICATION JOBS ---
//
// Expiry reminders change once a day, so a daily sweep is enough. SLA deadlines are
// measured in hours, so a daily job would report most breaches long after the fact —
// that check runs hourly. Failed email/SMS deliveries are retried on their own timer.
//
// node-cron only fires while this process is alive. On a host that sleeps an idle
// web service (Render's free tier, for one) the schedules simply stop, silently —
// no notifications, no SLA escalations, and nothing in the logs to say so. There
// the jobs are driven over HTTP instead, by Supabase pg_cron or GitHub Actions:
// set DISABLE_INTERNAL_CRON=true and CRON_SECRET, and see backend/sql/supabase_cron.sql.
const INTERNAL_CRON_ENABLED = process.env.DISABLE_INTERNAL_CRON !== 'true';
const CRON_SECRET = process.env.CRON_SECRET || '';

registerCronRoutes(app, { scheduler, notifications, reports, secret: CRON_SECRET });

if (INTERNAL_CRON_ENABLED) {
  const runStartupChecks = async () => {
    await scheduler.runDailyChecks();
    await scheduler.runSlaChecks();
  };

  runStartupChecks().catch((err) => console.error('Startup notification checks failed:', err));

  cron.schedule('0 0 * * *', () => scheduler.runDailyChecks());   // 00:00 daily
  cron.schedule('0 * * * *', () => scheduler.runSlaChecks());     // hourly, on the hour
  cron.schedule('*/15 * * * *', () => {                            // retry failed sends
    notifications.retryFailed().catch((err) => console.error('Notification retry failed:', err));
  });
  cron.schedule('0 6 * * *', () => {                               // 06:00 daily: email due reports
    reports.runDueScheduledReports().catch((err) => console.error('Scheduled reports failed:', err));
  });
} else if (!CRON_SECRET) {
  // Loud, because the alternative is a deployment where nothing is scheduled at all
  // and the first anyone hears of it is a missed SLA.
  console.error('[cron] DISABLE_INTERNAL_CRON=true but CRON_SECRET is unset: no job can run, in-process or over HTTP.');
} else {
  console.log('[cron] in-process scheduler disabled; expecting external triggers on /api/internal/cron/*');
}

// --- KNOWLEDGE BASE + HELPDESK OPTIONS ---
// Registered before the catch-all so its routes are reachable.
knowledgeBase.register(app, { requireUser });
purchaseOrders.register(app, { requirePermission, requireUser, roleCan });
slaRoutes.register(app, { requireUser, requirePermission });
dashboards.register(app, { requirePermission });
reports.register(app, { requireUser, requirePermission });

// --- 404 handler for unmatched API routes (JSON, not Express's default HTML page) ---
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
});

// --- Global error handler (safety net; JSON, not HTML) ---
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
runMigrations().then(() => {
  app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));
}).catch(err => {
  console.error('Server startup failed due to migration failure:', err);
});
