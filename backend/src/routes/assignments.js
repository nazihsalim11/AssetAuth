const db = require('../../db');

// Quantity-based assignment APIs — assignments, employee search/asset lookup, the
// assign/transfer/return flows, and assignment edits. Extracted verbatim from
// server.js. Employees are custodians: they may see only their own assigned assets.
function register(app, { requireUser, requirePermission, isEmployee }) {
  app.get('/api/assignments', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      // Inner-joining users as well as assets means a row whose employee or asset
      // has gone away can never surface in the registry, even if one were somehow
      // created outside the ON DELETE CASCADE guarantees.
      // Employees see only their own custody records.
      const scoped = isEmployee(user);
      const result = await db.query(`
        SELECT aa.*, a.name as asset_name, a.category as asset_category
        FROM asset_assignments aa
        JOIN assets a ON aa.asset_id = a.id
        JOIN users u ON aa.user_id = u.workos_user_id
        ${scoped ? 'WHERE aa.user_id = $1' : ''}
        ORDER BY aa.created_at DESC
      `, scoped ? [user.id] : []);
      res.json(result.rows);
    } catch (err) {
      console.error('GET /api/assignments failed:', err);
      res.status(500).json({ error: 'Database query failed: ' + err.message });
    }
  });

  /* ---------------- Employee asset lookup ----------------
   * Find an employee by name, employee ID or email, then show what they
   * currently hold and everything they have ever held.
   */

  // Search the directory. Employees may only look themselves up.
  app.get('/api/employees/search', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);

    try {
      if (user.role === 'Employee') {
        const { rows } = await db.query(
          `SELECT workos_user_id AS id, name, email, employee_id, department, designation, status
           FROM users WHERE workos_user_id = $1`,
          [user.id]
        );
        return res.json(rows);
      }
      const like = `%${q.toLowerCase()}%`;
      const { rows } = await db.query(
        `SELECT workos_user_id AS id, name, email, employee_id, department, designation, status
         FROM users
         WHERE status = 'Active'
           AND (LOWER(name) LIKE $1
                OR LOWER(email) LIKE $1 OR LOWER(COALESCE(employee_id, '')) LIKE $1)
         ORDER BY name
         LIMIT 25`,
        [like]
      );
      res.json(rows);
    } catch (err) {
      console.error('GET /api/employees/search failed:', err);
      res.status(500).json({ error: 'Employee search failed: ' + err.message });
    }
  });

  // Current holdings plus full assignment history for one employee.
  app.get('/api/employees/:id/assets', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const targetId = req.params.id;
    if (user.role === 'Employee' && user.id !== targetId) {
      return res.status(403).json({ error: 'You can only view your own assigned assets.' });
    }

    try {
      const employee = await db.query(
        `SELECT workos_user_id AS id, name, email, employee_id, department, designation, status
         FROM users WHERE workos_user_id = $1`,
        [targetId]
      );
      if (employee.rows.length === 0) return res.status(404).json({ error: 'Employee not found' });

      // Every custody record, current and returned. The registry's inner joins mean a
      // row here always points at an asset and an employee that still exist.
      const history = await db.query(
        `SELECT aa.id, aa.asset_id, aa.quantity, aa.department, aa.date, aa.notes, aa.status,
                aa.created_at, a.name AS asset_name, a.category AS asset_category,
                a.serial_number, a.location, a.status AS asset_status
         FROM asset_assignments aa
         JOIN assets a ON aa.asset_id = a.id
         WHERE aa.user_id = $1
         ORDER BY aa.created_at DESC`,
        [targetId]
      );

      const current = history.rows.filter((r) => r.status === 'Assigned');
      res.json({
        employee: employee.rows[0],
        currentAssets: current,
        history: history.rows,
        totalQuantityHeld: current.reduce((sum, r) => sum + (r.quantity || 0), 0)
      });
    } catch (err) {
      console.error('GET /api/employees/:id/assets failed:', err);
      res.status(500).json({ error: 'Could not load employee assets: ' + err.message });
    }
  });

  app.post('/api/assignments', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'allocations', 'create');
    if (!actingUser) return;

    const { assetId, employeeName, quantity, department, notes, date, expectedReturnDate } = req.body;
    const qty = parseInt(quantity) || 1;
    const actor = req.headers['x-user-email'] || 'Admin';

    if (!assetId || !employeeName || qty <= 0) {
      return res.status(400).json({ error: 'Asset ID, Employee Name, and positive quantity are required.' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const assetRes = await client.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [assetId]);
      if (assetRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Asset not found' });
      }

      const asset = assetRes.rows[0];
      if (asset.available_quantity < qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Insufficient stock. Available: ${asset.available_quantity}, Requested: ${qty}` });
      }

      const userRes = await client.query('SELECT workos_user_id AS id, name FROM users WHERE LOWER(name) = LOWER($1) OR LOWER(email) = LOWER($1)', [employeeName]);
      if (userRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Employee "${employeeName}" does not exist in the user directory.` });
      }
      const userId = userRes.rows[0].id;
      const employeeNameDb = userRes.rows[0].name;

      const insertQuery = `
        INSERT INTO asset_assignments (asset_id, employee_name, user_id, quantity, department, date, notes, status, expected_return_date)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'Assigned', $8)
        RETURNING *;
      `;
      const assignmentRes = await client.query(insertQuery, [
        assetId, employeeNameDb, userId, qty, department || asset.department, date || new Date(), notes || '', expectedReturnDate || null
      ]);
      const assignment = assignmentRes.rows[0];

      const newAssignedQty = asset.assigned_quantity + qty;
      const newAvailableQty = asset.total_quantity - newAssignedQty;
      const newStatus = newAvailableQty === 0 ? 'Assigned' : 'Available';

      const activeAssignmentsRes = await client.query(`
        SELECT employee_name, SUM(quantity) as qty
        FROM asset_assignments
        WHERE asset_id = $1 AND status = 'Assigned'
        GROUP BY employee_name
      `, [assetId]);
      const summaryStr = activeAssignmentsRes.rows.map(row => `${row.employee_name} (${row.qty})`).join(', ');

      await client.query(`
        UPDATE assets
        SET assigned_quantity = $1, available_quantity = $2, status = $3, assigned_employee = $4, updated_at = NOW()
        WHERE id = $5
      `, [newAssignedQty, newAvailableQty, newStatus, summaryStr, assetId]);

      await client.query(`
        INSERT INTO movements (asset_id, date, type, from_loc, to_loc, actor, notes)
        VALUES ($1, $2, 'Allocation', 'Inventory', $3, $4, $5)
      `, [assetId, date || new Date(), `${employeeName} (${department || asset.department})`, actor, `Assigned Qty: ${qty}. ${notes || ''}`]);

      await client.query(`
        INSERT INTO system_logs (actor, action, detail)
        VALUES ($1, 'Asset Allocation', $2)
      `, [
        actor,
        `Allocated ${qty} of asset ${assetId} to ${employeeName}. Prev Available: ${asset.available_quantity}, New Available: ${newAvailableQty}`
      ]);

      await client.query('COMMIT');
      res.status(201).json(assignment);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Allocation failed: ' + err.message });
    } finally {
      client.release();
    }
  });

  // Custodian transfer / handover.
  //
  // PATCH /assets only rewrites the denormalised assigned_employee string, which left
  // the Active Custodian Registry, employee lookups and assignment history — all read
  // from asset_assignments — pointing at the *previous* holder after a transfer. This
  // endpoint moves the underlying custody rows in the same transaction as the asset
  // update, so every one of those views follows the asset to its new holder the moment
  // the client refetches. The write lands in the database first; the frontend then
  // re-reads assets + assignments + movements to synchronise.
  app.post('/api/assets/:id/transfer', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'allocations', 'edit');
    if (!actingUser) return;

    const { id } = req.params;
    const { targetType, employeeName, department, location, date, notes } = req.body;
    const actor = req.headers['x-user-email'] || actingUser.email || 'Admin';
    const when = date || new Date();

    if (targetType !== 'employee' && targetType !== 'department') {
      return res.status(400).json({ error: 'targetType must be "employee" or "department".' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const assetRes = await client.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [id]);
      if (assetRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Asset not found' });
      }
      const asset = assetRes.rows[0];
      const prevEmployee = asset.assigned_employee;
      const prevDept = asset.department;
      const prevLoc = asset.location;
      const targetDept = department || asset.department;
      const targetLoc = location || asset.location;

      // Active custody rows for this asset, locked for the duration.
      const activeRes = await client.query(
        `SELECT * FROM asset_assignments WHERE asset_id = $1 AND status = 'Assigned' FOR UPDATE`,
        [id]
      );
      const activeRows = activeRes.rows;
      const movedQty = activeRows.reduce((sum, r) => sum + (r.quantity || 0), 0);

      let newAssigned = asset.assigned_quantity || 0;
      let newAvailable = asset.available_quantity || 0;
      const total = asset.total_quantity || 0;

      if (targetType === 'employee') {
        if (!employeeName) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'employeeName is required for a custodian transfer.' });
        }
        const userRes = await client.query(
          `SELECT workos_user_id AS id, name FROM users
            WHERE status = 'Active' AND (LOWER(TRIM(name)) = LOWER(TRIM($1)) OR LOWER(email) = LOWER($1))`,
          [String(employeeName)]
        );
        if (userRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Employee "${employeeName}" does not exist in the user directory.` });
        }
        const newUserId = userRes.rows[0].id;
        const newName = userRes.rows[0].name;

        if (activeRows.length > 0) {
          // Reassign every active row to the new custodian in place: quantities and
          // allocation dates are preserved, only the holder and department change.
          await client.query(
            `UPDATE asset_assignments
               SET employee_name = $1, user_id = $2, department = $3
             WHERE asset_id = $4 AND status = 'Assigned'`,
            [newName, newUserId, targetDept, id]
          );
        } else {
          // The asset held no custody row (it was in inventory), so custody is being
          // established here: create one for the whole available quantity.
          const qty = Math.max(1, asset.available_quantity || asset.total_quantity || 1);
          await client.query(
            `INSERT INTO asset_assignments (asset_id, employee_name, user_id, quantity, department, date, notes, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'Assigned')`,
            [id, newName, newUserId, qty, targetDept, when, notes || '']
          );
          newAssigned = Math.min(total || qty, newAssigned + qty);
          newAvailable = Math.max(0, (total || qty) - newAssigned);
        }

        // Recompute the denormalised summary from the live rows.
        const summaryRes = await client.query(
          `SELECT employee_name, SUM(quantity) AS qty FROM asset_assignments
           WHERE asset_id = $1 AND status = 'Assigned' GROUP BY employee_name`,
          [id]
        );
        const summary = summaryRes.rows.map((r) => `${r.employee_name} (${r.qty})`).join(', ');
        const status = newAvailable === 0 ? 'Assigned' : 'Available';

        await client.query(
          `UPDATE assets
             SET assigned_employee = $1, department = $2, location = $3,
                 assigned_quantity = $4, available_quantity = $5, status = $6, updated_at = NOW()
           WHERE id = $7`,
          [summary, targetDept, targetLoc, newAssigned, newAvailable, status, id]
        );
      } else {
        // Return to department inventory: close every active custody row and restore
        // the moved quantity to the available pool.
        if (activeRows.length > 0) {
          await client.query(
            `UPDATE asset_assignments SET status = 'Returned', quantity = 0 WHERE asset_id = $1 AND status = 'Assigned'`,
            [id]
          );
        }
        newAssigned = Math.max(0, newAssigned - movedQty);
        newAvailable = total > 0 ? Math.min(total, newAvailable + movedQty) : newAvailable + movedQty;
        const status = newAvailable > 0 || newAssigned === 0 ? 'Available' : 'Assigned';

        await client.query(
          `UPDATE assets
             SET assigned_employee = '', department = $1, location = $2,
                 assigned_quantity = $3, available_quantity = $4, status = $5, updated_at = NOW()
           WHERE id = $6`,
          [targetDept, targetLoc, newAssigned, newAvailable, status, id]
        );
      }

      const source = prevEmployee ? `${prevEmployee} (${prevDept})` : `Dept: ${prevDept} (${prevLoc})`;
      const destination = targetType === 'employee'
        ? `${employeeName} (${targetDept})`
        : `Dept: ${targetDept} (${targetLoc})`;

      await client.query(
        `INSERT INTO movements (asset_id, date, type, from_loc, to_loc, actor, notes)
         VALUES ($1, $2, 'Transfer', $3, $4, $5, $6)`,
        [id, when, source, destination, actor, notes || '']
      );
      await client.query(
        `INSERT INTO system_logs (actor, action, detail) VALUES ($1, 'Asset Transfer', $2)`,
        [actor, `Transferred ${id} from ${source} to ${destination}`]
      );

      await client.query('COMMIT');

      const updated = await db.query('SELECT * FROM assets WHERE id = $1', [id]);
      res.json({ ok: true, asset: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /api/assets/:id/transfer failed:', err);
      res.status(500).json({ error: 'Transfer failed: ' + err.message });
    } finally {
      client.release();
    }
  });

  app.post('/api/assignments/:id/return', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'allocations', 'edit');
    if (!actingUser) return;

    const { id } = req.params;
    const { quantity, notes } = req.body;
    const returnQty = parseInt(quantity) || null;
    const actor = req.headers['x-user-email'] || 'Admin';

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const assignmentRes = await client.query('SELECT * FROM asset_assignments WHERE id = $1 FOR UPDATE', [id]);
      if (assignmentRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Assignment not found' });
      }

      const assignment = assignmentRes.rows[0];
      if (assignment.status !== 'Assigned') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Assignment is already returned or inactive.' });
      }

      const finalReturnQty = returnQty !== null ? Math.min(returnQty, assignment.quantity) : assignment.quantity;

      const assetRes = await client.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [assignment.asset_id]);
      if (assetRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Asset not found' });
      }
      const asset = assetRes.rows[0];

      if (finalReturnQty === assignment.quantity) {
        await client.query('UPDATE asset_assignments SET status = \'Returned\', quantity = 0 WHERE id = $1', [id]);
      } else {
        await client.query('UPDATE asset_assignments SET quantity = quantity - $1 WHERE id = $2', [finalReturnQty, id]);
      }

      const newAssignedQty = Math.max(0, asset.assigned_quantity - finalReturnQty);
      const newAvailableQty = asset.total_quantity - newAssignedQty;
      const newStatus = newAvailableQty > 0 ? 'Available' : 'Assigned';

      const activeAssignmentsRes = await client.query(`
        SELECT employee_name, SUM(quantity) as qty
        FROM asset_assignments
        WHERE asset_id = $1 AND status = 'Assigned'
        GROUP BY employee_name
      `, [assignment.asset_id]);
      const summaryStr = activeAssignmentsRes.rows.map(row => `${row.employee_name} (${row.qty})`).join(', ') || '';

      await client.query(`
        UPDATE assets
        SET assigned_quantity = $1, available_quantity = $2, status = $3, assigned_employee = $4, updated_at = NOW()
        WHERE id = $5
      `, [newAssignedQty, newAvailableQty, newStatus, summaryStr, assignment.asset_id]);

      await client.query(`
        INSERT INTO movements (asset_id, date, type, from_loc, to_loc, actor, notes)
        VALUES ($1, CURRENT_DATE, 'Return', $2, 'Inventory', $3, $4)
      `, [assignment.asset_id, `${assignment.employee_name} (${assignment.department})`, actor, `Returned Qty: ${finalReturnQty}. ${notes || ''}`]);

      await client.query(`
        INSERT INTO system_logs (actor, action, detail)
        VALUES ($1, 'Asset Return', $2)
      `, [
        actor,
        `Returned ${finalReturnQty} of asset ${assignment.asset_id} from ${assignment.employee_name}. Prev Available: ${asset.available_quantity}, New Available: ${newAvailableQty}`
      ]);

      await client.query('COMMIT');
      res.json({ message: 'Assets returned successfully', returnedQuantity: finalReturnQty });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Return operation failed: ' + err.message });
    } finally {
      client.release();
    }
  });

  app.patch('/api/assignments/:id', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'allocations', 'edit');
    if (!actingUser) return;

    const { id } = req.params;
    const { quantity, employeeName, department, notes } = req.body;
    const actor = req.headers['x-user-email'] || 'Admin';

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const assignmentRes = await client.query('SELECT * FROM asset_assignments WHERE id = $1 FOR UPDATE', [id]);
      if (assignmentRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Assignment not found' });
      }

      const assignment = assignmentRes.rows[0];
      const prevQty = assignment.quantity;
      const newQty = quantity !== undefined ? parseInt(quantity) : prevQty;

      const assetRes = await client.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [assignment.asset_id]);
      if (assetRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Asset not found' });
      }
      const asset = assetRes.rows[0];

      const qtyDiff = newQty - prevQty;
      if (asset.available_quantity < qtyDiff) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Insufficient stock to adjust assignment. Available: ${asset.available_quantity}, Requested increase: ${qtyDiff}` });
      }

      let userId = assignment.user_id;
      let employeeNameDb = employeeName;
      if (employeeName) {
        const userRes = await client.query('SELECT workos_user_id AS id, name FROM users WHERE LOWER(name) = LOWER($1) OR LOWER(email) = LOWER($1)', [employeeName]);
        if (userRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Employee "${employeeName}" does not exist in the user directory.` });
        }
        userId = userRes.rows[0].id;
        employeeNameDb = userRes.rows[0].name;
      }

      await client.query(`
        UPDATE asset_assignments
        SET 
          employee_name = COALESCE($1, employee_name),
          user_id = $2,
          quantity = $3,
          department = COALESCE($4, department),
          notes = COALESCE($5, notes)
        WHERE id = $6
      `, [employeeNameDb || null, userId, newQty, department || null, notes || null, id]);

      const newAssignedQty = asset.assigned_quantity + qtyDiff;
      const newAvailableQty = asset.total_quantity - newAssignedQty;
      const newStatus = newAvailableQty > 0 ? 'Available' : 'Assigned';

      const activeAssignmentsRes = await client.query(`
        SELECT employee_name, SUM(quantity) as qty
        FROM asset_assignments
        WHERE asset_id = $1 AND status = 'Assigned'
        GROUP BY employee_name
      `, [assignment.asset_id]);
      const summaryStr = activeAssignmentsRes.rows.map(row => `${row.employee_name} (${row.qty})`).join(', ') || '';

      await client.query(`
        UPDATE assets
        SET assigned_quantity = $1, available_quantity = $2, status = $3, assigned_employee = $4, updated_at = NOW()
        WHERE id = $5
      `, [newAssignedQty, newAvailableQty, newStatus, summaryStr, assignment.asset_id]);

      await client.query(`
        INSERT INTO system_logs (actor, action, detail)
        VALUES ($1, 'Asset Assignment Update', $2)
      `, [
        actor,
        `Updated assignment ${id} for asset ${assignment.asset_id}. Quantity changed from ${prevQty} to ${newQty}.`
      ]);

      await client.query('COMMIT');
      res.json({ message: 'Assignment updated successfully' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Assignment update failed: ' + err.message });
    } finally {
      client.release();
    }
  });
}

module.exports = { register };
