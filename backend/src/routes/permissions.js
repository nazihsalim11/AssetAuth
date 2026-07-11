const db = require('../../db');
const notifications = require('../../notifications');
const permissionModel = require('../../permissionModel');

// Role-permissions API — the authoritative module->verb matrix. Was frontend-only;
// now every client fetches it from here and Super Admins persist edits to the DB.
// Extracted verbatim from server.js. `loadRolePermissions`/`invalidateRolePermissions`
// are the same cache-bound helpers from src/middleware/auth.js, injected here.
function register(app, { requireUser, roleCan, loadRolePermissions, invalidateRolePermissions }) {
  app.get('/api/role-permissions', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      // Ship the vocabulary alongside the data so the client renders the matrix
      // generically and can never disagree with the server about modules/verbs/roles.
      res.json({
        modules: permissionModel.MODULES,
        roles: permissionModel.ROLES,
        verbLabels: permissionModel.VERB_LABELS,
        matrix: await loadRolePermissions({ fresh: true })
      });
    } catch (err) {
      console.error('GET /api/role-permissions failed:', err);
      res.status(500).json({ error: 'Could not load role permissions: ' + err.message });
    }
  });

  app.patch('/api/role-permissions', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await roleCan(user, 'userManagement', 'manage'))) {
      return res.status(403).json({ error: 'Your role is not permitted to change role permissions.' });
    }
    // The editor sends the complete { role: { module: { verb: bool } } } matrix, so
    // each role is replaced wholesale after sanitising. A shallow JSONB `||` merge would
    // clobber sibling verbs (sending { tickets: { view:false } } would drop create/edit);
    // sanitizeMatrix also strips any unknown role/module/verb a client might inject.
    const matrixInput = req.body && (req.body.matrix || req.body);
    const clean = permissionModel.sanitizeMatrix(matrixInput);
    if (Object.keys(clean).length === 0) {
      return res.status(400).json({ error: 'Payload must be a { role: { module: { verb: bool } } } matrix' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [role, perms] of Object.entries(clean)) {
        // Super Admin is unrestricted in code; storing its row would be misleading.
        if (role === 'Super Admin') continue;
        await client.query(
          `INSERT INTO role_permissions (role, permissions, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (role) DO UPDATE
             SET permissions = EXCLUDED.permissions, updated_at = NOW()`,
          [role, JSON.stringify(perms)]
        );
      }
      await client.query('COMMIT');
      invalidateRolePermissions(); // force a fresh read on the next enforcement check

      // Timestamped: every permissions edit is its own event, never deduplicated away.
      notifications.notify('security.permissions_changed', `permissions-changed:${Date.now()}`, {
        actor: user.name || user.username,
        summary: Object.keys(clean).join(', ')
      });

      await db.query(
        `INSERT INTO system_logs (actor, action, detail) VALUES ($1,'Role Permissions',$2)`,
        [user.name || user.username, `Updated: ${Object.keys(clean).join(', ')}`]
      );
      res.json(await loadRolePermissions({ fresh: true }));
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('PATCH /api/role-permissions failed:', err);
      res.status(500).json({ error: 'Could not update role permissions: ' + err.message });
    } finally {
      client.release();
    }
  });
}

module.exports = { register };
