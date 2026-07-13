const bcrypt = require('bcryptjs');
const db = require('../../db');
const notifications = require('../../notifications');
const emailChannel = require('../../notifications/channels/email');
const validateAndFormatPhone = require('../utils/phone');
const { WorkOS } = require('@workos-inc/node');

const workos = process.env.WORKOS_API_KEY ? new WorkOS(process.env.WORKOS_API_KEY) : null;

// Starts a WorkOS-managed password reset and emails the hosted reset link. Used to let
// newly provisioned users set their first password (WorkOS owns credentials; we never
// set or store passwords). Best-effort: failures are logged, never thrown.
async function sendResetLink(email) {
  if (!workos || !email) return;
  try {
    const reset = await workos.userManagement.createPasswordReset({ email });
    const resetUrl = reset && reset.passwordResetUrl;
    if (resetUrl && emailChannel.isConfigured()) {
      await emailChannel.send({
        to: email,
        subject: 'Set your AssetFlow password',
        body: `An AssetFlow account has been created for you.\n\n`
          + `Use the link below to set your password and sign in (it expires shortly):\n${resetUrl}\n`,
      }).catch((e) => console.warn('[User Invite] Email send failed:', e.message));
    } else if (resetUrl && !emailChannel.isConfigured()) {
      console.warn('[User Invite] SMTP not configured; password setup link not delivered for', email);
    }
  } catch (workosErr) {
    console.warn('[User Invite] Failed to create WorkOS password reset:', workosErr.message);
  }
}

// Reliable user creation helper used by both manual registration and bulk import
async function createSingleUser(client, { workosUserId, name, role, email, employeeId, phoneNumber, department, designation, location, managerId, status }) {
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

  let finalWorkosUserId = workosUserId;
  if (!finalWorkosUserId) {
    if (workos) {
      try {
        const workosUser = await workos.userManagement.createUser({
          email,
          emailVerified: true,
          firstName: name.split(' ')[0] || '',
          lastName: name.split(' ').slice(1).join(' ') || '',
        });
        finalWorkosUserId = workosUser.id;
      } catch (workosErr) {
        console.warn('[WorkOS User Creation Warning] Failed to create user in WorkOS:', workosErr.message);
      }
    }
    if (!finalWorkosUserId) {
      finalWorkosUserId = 'mock-' + email.split('@')[0] + '-' + Math.random().toString(36).substring(2, 7);
    }
  }

  // Insert into public.users
  const query = `
    INSERT INTO users (workos_user_id, name, role, email, employee_id, phone_number, department, designation, location, manager_id, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING workos_user_id AS id, name, role, email, employee_id, phone_number, department, designation, location, manager_id AS "managerId", status, created_at;
  `;
  const values = [
    finalWorkosUserId,
    name,
    role,
    email,
    employeeId || null,
    phoneNumber || '',
    department || '',
    designation || '',
    location || '',
    managerId || null,
    status || 'Active'
  ];
  const result = await client.query(query, values);
  return result.rows[0];
}

// --- USER MANAGEMENT API ---
function register(app, { requireUser, invalidateUserRole, actorOf, roleCan }) {

  app.get('/api/users', async (req, res) => {
    try {
      const result = await db.query(
        'SELECT workos_user_id AS id, name, role, email, employee_id, phone_number, department, designation, location, manager_id AS "managerId", status, created_at FROM users ORDER BY created_at DESC'
      );
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database query failed' });
    }
  });

  app.post('/api/users', async (req, res) => {
    const { name, role, email, employeeId, phoneNumber, department, designation, location, managerId, status } = req.body;
    if (!name || !role || !email) {
      return res.status(400).json({ error: 'Name, role, and email are required.' });
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
        name,
        role,
        email,
        employeeId,
        phoneNumber: formattedPhone,
        department,
        designation,
        location,
        managerId,
        status,
      });
      await client.query('COMMIT');

      // Email a WorkOS password-setup link so the new user can choose their password.
      if (createdUser.id && !createdUser.id.startsWith('mock-')) {
        await sendResetLink(createdUser.email);
      }

      res.status(201).json(createdUser);

      notifications.notify('user.created', `user-created:${createdUser.id}`, {
        name: createdUser.name,
        email: createdUser.email,
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
    const { role, employeeId, phoneNumber, department, designation, location, managerId, status, notificationPreferences } = req.body;

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
      const userResult = await client.query('SELECT * FROM users WHERE workos_user_id = $1', [id]);
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      const user = userResult.rows[0];

      // Guard role changes: only a User Management editor may change someone's role,
      // and no one may change their own role (prevents self-elevation). Other profile
      // fields (phone, notification preferences, etc.) are unaffected.
      if (role !== undefined && role !== null && role !== user.role) {
        const caller = requireUser(req, res);
        if (!caller) { await client.query('ROLLBACK'); return; }
        if (String(caller.id) === String(id)) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'You cannot change your own role.' });
        }
        if (!(await roleCan(caller, 'userManagement', 'edit'))) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Your role is not permitted to change user roles.' });
        }
      }

      // Check duplicate employee ID
      if (employeeId && (user.employee_id === null || employeeId.toLowerCase() !== user.employee_id.toLowerCase())) {
        const empIdExists = await client.query('SELECT 1 FROM users WHERE LOWER(employee_id) = LOWER($1) AND workos_user_id <> $2', [employeeId, id]);
        if (empIdExists.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Employee ID '${employeeId}' already exists. Please use a unique Employee ID.` });
        }
      }

      // Update WorkOS user status if changed and configured
      if (workos && id && !id.startsWith('mock-')) {
        if (status && status !== user.status) {
          try {
            if (status === 'Deactivated' || status === 'Inactive') {
              await workos.userManagement.deactivateUser({ userId: id });
            } else if (status === 'Active') {
              await workos.userManagement.reactivateUser({ userId: id });
            }
          } catch (workosErr) {
            console.warn('[WorkOS User Update Warning] Failed to update user status in WorkOS:', workosErr.message);
          }
        }
      }

      const query = `
        UPDATE users 
        SET role = COALESCE($1, role),
            employee_id = COALESCE($2, employee_id),
            phone_number = COALESCE($3, phone_number),
            department = COALESCE($4, department),
            designation = COALESCE($5, designation),
            location = COALESCE($6, location),
            manager_id = COALESCE($7, manager_id),
            status = COALESCE($8, status),
            notification_preferences = COALESCE($9, notification_preferences),
            updated_at = NOW()
        WHERE workos_user_id = $10
        RETURNING workos_user_id AS id, name, role, email, employee_id, phone_number, department, designation, location, manager_id AS "managerId", status, notification_preferences, created_at;
      `;
      const values = [
        role,
        employeeId,
        formattedPhone || phoneNumber || '',
        department,
        designation,
        location,
        managerId,
        status,
        notificationPreferences ? JSON.stringify(notificationPreferences) : null,
        id
      ];
      const result = await client.query(query, values);
      
      await client.query('COMMIT');
      const updated = result.rows[0];
      res.json(updated);

      if (role && role !== user.role) {
        invalidateUserRole(updated.id);
        notifications.notify('user.role_changed', `user-role:${updated.id}:${role}`, {
          name: updated.name,
          email: updated.email,
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
      const check = await client.query('SELECT name, email, role FROM users WHERE workos_user_id = $1', [id]);
      if (check.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      const deletedUser = check.rows[0];
      
      // Find affected assets before deleting assignments
      const affectedAssets = await client.query('SELECT DISTINCT asset_id FROM asset_assignments WHERE user_id = $1', [id]);
      const affectedAssetIds = affectedAssets.rows.map(r => r.asset_id);

      await client.query('DELETE FROM asset_assignments WHERE user_id = $1', [id]);
      if (workos && id && !id.startsWith('mock-')) {
        try {
          await workos.userManagement.deleteUser({ userId: id });
        } catch (workosErr) {
          console.warn('[WorkOS User Deletion Warning] Failed to delete user in WorkOS:', workosErr.message);
        }
      }

      await client.query('DELETE FROM users WHERE workos_user_id = $1', [id]);

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
      res.json({ message: `User "${deletedUser.name || deletedUser.email}" deleted successfully` });

      notifications.notify('user.deleted', `user-deleted:${id}`, {
        name: deletedUser.name,
        email: deletedUser.email,
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
      const check = await client.query('SELECT workos_user_id FROM users WHERE workos_user_id = ANY($1::varchar[])', [userIds]);
      const foundIds = check.rows.map(r => r.workos_user_id);
      
      // Find affected assets before deleting assignments
      const affectedAssets = await client.query('SELECT DISTINCT asset_id FROM asset_assignments WHERE user_id = ANY($1::varchar[])', [foundIds]);
      const affectedAssetIds = affectedAssets.rows.map(r => r.asset_id);

      await client.query('DELETE FROM asset_assignments WHERE user_id = ANY($1::varchar[])', [foundIds]);
      if (workos) {
        for (const wId of foundIds) {
          if (!wId.startsWith('mock-')) {
            try {
              await workos.userManagement.deleteUser({ userId: wId });
            } catch (workosErr) {
              console.warn('[WorkOS User Deletion Warning] Failed to delete user in WorkOS:', workosErr.message);
            }
          }
        }
      }

      await client.query('DELETE FROM users WHERE workos_user_id = ANY($1::varchar[])', [foundIds]);
      
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
      if (workos) {
        for (const wId of userIds) {
          if (!wId.startsWith('mock-')) {
            try {
              if (status === 'Deactivated' || status === 'Inactive') {
                await workos.userManagement.deactivateUser({ userId: wId });
              } else if (status === 'Active') {
                await workos.userManagement.reactivateUser({ userId: wId });
              }
            } catch (workosErr) {
              console.warn(`Failed to update status in WorkOS for user ${wId}:`, workosErr.message);
            }
          }
        }
      }
      await db.query('UPDATE users SET status = $1 WHERE workos_user_id = ANY($2::varchar[])', [status, userIds]);
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
      if (workos) {
        const { rows } = await db.query('SELECT email FROM users WHERE workos_user_id = ANY($1::varchar[])', [userIds]);
        for (const userRow of rows) {
          await sendResetLink(userRow.email);
        }
      }
      res.json({ message: `Password reset instructions sent for ${userIds.length} users` });
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
      await db.query('UPDATE users SET department = $1 WHERE workos_user_id = ANY($2::varchar[])', [department, userIds]);
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
    // Same guards as the single-user role change: authorized editor only, never self.
    const caller = requireUser(req, res);
    if (!caller) return;
    if (!(await roleCan(caller, 'userManagement', 'edit'))) {
      return res.status(403).json({ error: 'Your role is not permitted to change user roles.' });
    }
    if (userIds.some((u) => String(u) === String(caller.id))) {
      return res.status(403).json({ error: 'You cannot change your own role.' });
    }
    try {
      await db.query('UPDATE users SET role = $1 WHERE workos_user_id = ANY($2::varchar[])', [role, userIds]);
      res.json({ message: `Role updated to "${role}" for ${userIds.length} users` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Bulk role update failed' });
    }
  });
}

module.exports = { register, createSingleUser };
