const notifications = require('../../notifications');
const emailChannel = require('../../notifications/channels/email');
const validateAndFormatPhone = require('../utils/phone');
const { WorkOS } = require('@workos-inc/node');
const { cq, cm } = require('../../convexApi');
const idGenerator = require('../services/idGenerator');

const workos = process.env.WORKOS_API_KEY ? new WorkOS(process.env.WORKOS_API_KEY) : null;

// Convex surfaces a ConvexError's payload as err.data; plain errors are wrapped. Pull a
// clean, user-facing message out of either shape.
function cleanConvexError(err) {
  if (err && err.data) return typeof err.data === 'string' ? err.data : (err.data.message || 'Operation failed.');
  const msg = (err && err.message) || 'Operation failed.';
  const m = msg.match(/Uncaught (?:Convex)?Error:\s*(.+?)(?:\n|\s+at\s|$)/);
  return m ? m[1].trim() : msg;
}

// Map a raw Convex user document to the shape the API/frontend expects: `id` is the
// workos_user_id (the old SQL aliased it that way), and api.js camelCases the rest.
function toApiUser(u) {
  if (!u) return u;
  return {
    id: u.workos_user_id,
    name: u.name,
    role: u.role,
    email: u.email,
    employee_id: u.employee_id ?? null,
    phone_number: u.phone_number ?? '',
    department: u.department ?? '',
    designation: u.designation ?? '',
    location: u.location ?? '',
    managerId: u.manager_id ?? null,
    status: u.status,
    notification_preferences: u.notification_preferences,
    created_at: u.created_at,
  };
}

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

// Create the WorkOS login for a new user (or fall back to a mock id when WorkOS is
// unconfigured), returning the id used as workos_user_id.
async function ensureWorkosUserId(email, name) {
  if (workos) {
    try {
      const workosUser = await workos.userManagement.createUser({
        email,
        emailVerified: true,
        firstName: name.split(' ')[0] || '',
        lastName: name.split(' ').slice(1).join(' ') || '',
      });
      return workosUser.id;
    } catch (workosErr) {
      console.warn('[WorkOS User Creation Warning] Failed to create user in WorkOS:', workosErr.message);
    }
  }
  return 'mock-' + email.split('@')[0] + '-' + Math.random().toString(36).substring(2, 7);
}

const isMock = (id) => String(id || '').startsWith('mock-');

// --- USER MANAGEMENT API (Convex-backed) ---
function register(app, { requireUser, invalidateUserRole, actorOf, roleCan }) {

  app.get('/api/users', async (req, res) => {
    try {
      const rows = await cq('users:list');
      res.json(rows.map(toApiUser));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load users.' });
    }
  });

  app.post('/api/users', async (req, res) => {
    const { name, role, email, employeeId, phoneNumber, department, designation, location, managerId, status } = req.body;
    if (!name || !role || !email) {
      return res.status(400).json({ error: 'Name, role, and email are required.' });
    }

    let formattedPhone = '';
    if (phoneNumber) {
      const phoneValidation = validateAndFormatPhone(phoneNumber);
      if (!phoneValidation.isValid) {
        return res.status(400).json({ error: phoneValidation.error });
      }
      formattedPhone = phoneValidation.value;
    }

    try {
      // Auto-assign the next Employee ID when the caller left it blank. A supplied id
      // (prefilled or overridden) is respected; uniqueness is enforced atomically by
      // users:create either way, so a concurrent collision is rejected rather than duplicated.
      let resolvedEmployeeId = employeeId && String(employeeId).trim() ? String(employeeId).trim() : null;
      if (!resolvedEmployeeId) {
        try {
          resolvedEmployeeId = (await idGenerator.reserve('employee')).nextId;
        } catch (genErr) {
          console.warn('[User Create] Could not auto-generate Employee ID:', genErr.message);
        }
      }

      const workosUserId = await ensureWorkosUserId(email, name);
      const doc = {
        workos_user_id: workosUserId,
        name,
        role,
        email,
        employee_id: resolvedEmployeeId || null,
        phone_number: formattedPhone || '',
        department: department || '',
        designation: designation || '',
        location: location || '',
        manager_id: managerId || null,
        status: status || 'Active',
      };
      const created = toApiUser(await cm('users:create', { doc }));

      if (created.id && !isMock(created.id)) {
        await sendResetLink(created.email);
      }

      res.status(201).json(created);

      notifications.notify('user.created', `user-created:${created.id}`, {
        name: created.name,
        email: created.email,
        role: created.role,
        department: created.department,
        actor: actorOf(req),
      });
    } catch (err) {
      console.error('Error during manual user creation:', err);
      res.status(400).json({ error: cleanConvexError(err) });
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

    try {
      const user = await cq('users:getByWorkosId', { workosUserId: id });
      if (!user) return res.status(404).json({ error: 'User not found' });

      // Guard role changes: only a User Management editor may change someone's role, and
      // no one may change their own (prevents self-elevation). Other fields unaffected.
      if (role !== undefined && role !== null && role !== user.role) {
        const caller = requireUser(req, res);
        if (!caller) return;
        if (String(caller.id) === String(id)) {
          return res.status(403).json({ error: 'You cannot change your own role.' });
        }
        if (!(await roleCan(caller, 'userManagement', 'edit'))) {
          return res.status(403).json({ error: 'Your role is not permitted to change user roles.' });
        }
      }

      // Sync WorkOS account status when it changes.
      if (workos && id && !isMock(id) && status && status !== user.status) {
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

      // Only patch fields actually present in the request (mirrors the old COALESCE).
      const patch = {};
      if (role !== undefined) patch.role = role;
      if (employeeId !== undefined) patch.employee_id = employeeId;
      if (phoneNumber !== undefined) patch.phone_number = formattedPhone || phoneNumber || '';
      if (department !== undefined) patch.department = department;
      if (designation !== undefined) patch.designation = designation;
      if (location !== undefined) patch.location = location;
      if (managerId !== undefined) patch.manager_id = managerId;
      if (status !== undefined) patch.status = status;
      if (notificationPreferences !== undefined) patch.notification_preferences = notificationPreferences;

      const updated = toApiUser(await cm('users:update', { workosUserId: id, patch }));
      res.json(updated);

      if (role && role !== user.role) {
        invalidateUserRole(updated.id);
        notifications.notify('user.role_changed', `user-role:${updated.id}:${role}`, {
          name: updated.name,
          email: updated.email,
          previousRole: user.role,
          newRole: role,
          actor: actorOf(req),
        });
      }
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: cleanConvexError(err) });
    }
  });

  // DELETE /api/users/:id - Delete User (cascades assignments + recomputes assets in Convex)
  app.delete('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const deleted = await cm('users:remove', { workosUserId: id });
      if (!deleted) return res.status(404).json({ error: 'User not found' });

      if (workos && !isMock(id)) {
        try {
          await workos.userManagement.deleteUser({ userId: id });
        } catch (workosErr) {
          console.warn('[WorkOS User Deletion Warning] Failed to delete user in WorkOS:', workosErr.message);
        }
      }

      res.json({ message: `User "${deleted.name || deleted.email}" deleted successfully` });

      notifications.notify('user.deleted', `user-deleted:${id}`, {
        name: deleted.name,
        email: deleted.email,
        role: deleted.role,
        actor: actorOf(req),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'User deletion failed: ' + cleanConvexError(err) });
    }
  });

  // POST /api/users/bulk/delete - Bulk Delete Users
  app.post('/api/users/bulk/delete', async (req, res) => {
    const { userIds } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'Payload must contain a userIds array' });
    }
    try {
      const result = await cm('users:bulkRemove', { workosUserIds: userIds });
      if (workos) {
        for (const wId of userIds) {
          if (!isMock(wId)) {
            try {
              await workos.userManagement.deleteUser({ userId: wId });
            } catch (workosErr) {
              console.warn('[WorkOS User Deletion Warning] Failed to delete user in WorkOS:', workosErr.message);
            }
          }
        }
      }
      res.json({ message: `${result.deleted} users deleted successfully` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Bulk deletion failed' });
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
          if (!isMock(wId)) {
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
      await cm('users:bulkSetStatus', { workosUserIds: userIds, value: status });
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
        const all = await cq('users:list');
        const wanted = new Set(userIds.map(String));
        for (const u of all) {
          if (wanted.has(String(u.workos_user_id)) && u.email) {
            await sendResetLink(u.email);
          }
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
      await cm('users:bulkSetDepartment', { workosUserIds: userIds, value: department });
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
      await cm('users:bulkSetRole', { workosUserIds: userIds, value: role });
      res.json({ message: `Role updated to "${role}" for ${userIds.length} users` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Bulk role update failed' });
    }
  });
}

module.exports = { register };
