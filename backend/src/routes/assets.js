const db = require('../../db');

// Assets API — extracted verbatim from server.js. Employees are custodians, not
// managers: they see only the assets currently assigned to them and may not create,
// modify or delete any asset. Every mutation is gated by the module->verb matrix.
function register(app, { requireUser, requirePermission, isEmployee, EMPLOYEE_ASSET_IDS }) {
  // Employees see only the assets currently assigned to them. Scoping keys on
  // asset_assignments.user_id, not assets.assigned_employee: that column stores a
  // display summary like "Alice Johnson (1)", so matching it against a name never
  // worked. Auth is optional so the unauthenticated connection probe still succeeds.
  // Authentication is required. Making auth optional here meant an employee could see
  // every asset simply by omitting the Authorization header.
  app.get('/api/assets', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const result = isEmployee(user)
        ? await db.query(
            `SELECT * FROM assets WHERE id IN (${EMPLOYEE_ASSET_IDS}) ORDER BY created_at DESC`,
            [user.id]
          )
        : await db.query('SELECT * FROM assets ORDER BY created_at DESC');
      res.json(result.rows);
    } catch (err) {
      console.error('GET /api/assets failed:', err);
      res.status(500).json({ error: 'Database query failed: ' + err.message });
    }
  });

  // Master data: valid Item Types (Asset Tag Subtypes) grouped by Asset Category.
  // Drives the category-dependent dropdowns in the UI and validates bulk imports,
  // replacing the old hard-coded IT->Laptop / Office->Chair mapping.
  app.get('/api/asset-subtypes', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const { rows } = await db.query('SELECT category, name FROM asset_subtypes ORDER BY category, name');
      const grouped = {};
      for (const r of rows) (grouped[r.category] = grouped[r.category] || []).push(r.name);
      res.json(grouped);
    } catch (err) {
      console.error('GET /api/asset-subtypes failed:', err);
      res.status(500).json({ error: 'Could not load asset subtypes: ' + err.message });
    }
  });

  app.post('/api/assets', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'assets', 'create');
    if (!actingUser) return;

    const {
      id, name, serialNumber, category, type, status, cost, purchaseDate,
      warrantyExpiry, department, associateDepartment, location, amcId, invoiceId,
      assignedEmployee, depreciationLifeYears, notes
    } = req.body;

    const query = `
      INSERT INTO assets (
        id, name, serial_number, category, type, status, cost, purchase_date,
        warranty_expiry, department, associate_department, location, amc_id, invoice_id,
        assigned_employee, depreciation_life_years, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *;
    `;
    // Useful Lifespan is optional: an omitted/blank value is stored as NULL rather
    // than being forced to a default, so "no value" is preserved faithfully.
    const values = [
      id, name, serialNumber, category, type, status || 'Available', cost || 0, purchaseDate || null,
      warrantyExpiry || null, department || '', associateDepartment || null, location || '', amcId || null, invoiceId || null,
      assignedEmployee || '', depreciationLifeYears ? parseInt(depreciationLifeYears) : null, notes || ''
    ];

    try {
      const result = await db.query(query, values);
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database insertion failed: ' + (err.detail || err.message) });
    }
  });

  app.patch('/api/assets/:id', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'assets', 'edit');
    if (!actingUser) return;

    const { id } = req.params;
    const fields = req.body;

    // Relocating to a custodian must name a real, active employee. Without this an
    // asset could be handed to a person who does not exist, which is how the orphaned
    // custodian records arose in the first place.
    if (fields.assignedEmployee) {
      try {
        const { rows } = await db.query(
          `SELECT id FROM users
           WHERE status = 'Active' AND (LOWER(TRIM(name)) = LOWER(TRIM($1)) OR LOWER(username) = LOWER($1))`,
          [String(fields.assignedEmployee)]
        );
        if (rows.length === 0) {
          return res.status(400).json({ error: `Employee "${fields.assignedEmployee}" does not exist in the user directory.` });
        }
      } catch (err) {
        console.error('Custodian validation failed:', err);
        return res.status(500).json({ error: 'Could not validate the selected employee: ' + err.message });
      }
    }

    // Dynamically build the UPDATE query based on fields passed
    const allowedFields = {
      name: 'name',
      serialNumber: 'serial_number',
      category: 'category',
      type: 'type',
      status: 'status',
      cost: 'cost',
      purchaseDate: 'purchase_date',
      warrantyExpiry: 'warranty_expiry',
      department: 'department',
      associateDepartment: 'associate_department',
      location: 'location',
      amcId: 'amc_id',
      invoiceId: 'invoice_id',
      assignedEmployee: 'assigned_employee',
      depreciationLifeYears: 'depreciation_life_years',
      disposalDate: 'disposal_date',
      disposalReason: 'disposal_reason',
      notes: 'notes'
    };

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const [key, dbCol] of Object.entries(allowedFields)) {
      if (fields[key] !== undefined) {
        setClauses.push(`${dbCol} = $${idx}`);
        // Handle potential empty strings for foreign keys
        if ((key === 'amcId' || key === 'invoiceId') && fields[key] === '') {
          values.push(null);
        } else {
          values.push(fields[key]);
        }
        idx++;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(id);
    const query = `UPDATE assets SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`;

    try {
      const result = await db.query(query, values);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Asset not found' });
      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database update failed: ' + err.message });
    }
  });

  app.delete('/api/assets/:id', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'assets', 'delete');
    if (!actingUser) return;

    const { id } = req.params;
    try {
      const result = await db.query('DELETE FROM assets WHERE id = $1 RETURNING *', [id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Asset not found' });
      res.json({ message: 'Asset deleted successfully', asset: result.rows[0] });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database deletion failed' });
    }
  });


  app.post('/api/assets/bulk/delete', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'assets', 'delete');
    if (!actingUser) return;

    const { assetIds } = req.body;
    if (!Array.isArray(assetIds)) {
      return res.status(400).json({ error: 'Payload must contain an assetIds array' });
    }
    try {
      await db.query('DELETE FROM assets WHERE id = ANY($1)', [assetIds]);
      const actor = req.headers['x-user-username'] || 'Admin';
      await db.query(
        `INSERT INTO system_logs (actor, action, detail)
         VALUES ($1, $2, $3)`,
        [actor, 'Bulk Delete Assets', `Deleted ${assetIds.length} assets`]
      );
      res.json({ message: `Successfully deleted ${assetIds.length} assets` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Bulk asset deletion failed' });
    }
  });

  app.post('/api/assets/bulk/status', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'assets', 'edit');
    if (!actingUser) return;

    const { assetIds, status } = req.body;
    if (!Array.isArray(assetIds) || !status) {
      return res.status(400).json({ error: 'Payload must contain assetIds array and status' });
    }
    try {
      await db.query('UPDATE assets SET status = $1 WHERE id = ANY($2)', [status, assetIds]);
      const actor = req.headers['x-user-username'] || 'Admin';
      await db.query(
        `INSERT INTO system_logs (actor, action, detail)
         VALUES ($1, $2, $3)`,
        [actor, 'Bulk Status Update', `Updated ${assetIds.length} assets to status ${status}`]
      );
      res.json({ message: `Successfully updated status of ${assetIds.length} assets` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Bulk asset status update failed' });
    }
  });

  app.post('/api/assets/bulk/category', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'assets', 'edit');
    if (!actingUser) return;

    const { assetIds, category } = req.body;
    if (!Array.isArray(assetIds) || !category) {
      return res.status(400).json({ error: 'Payload must contain assetIds array and category' });
    }
    try {
      await db.query('UPDATE assets SET category = $1 WHERE id = ANY($2)', [category, assetIds]);
      res.json({ message: `Successfully updated category of ${assetIds.length} assets` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Bulk asset category update failed' });
    }
  });

  app.post('/api/assets/bulk/location', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'assets', 'edit');
    if (!actingUser) return;

    const { assetIds, location } = req.body;
    if (!Array.isArray(assetIds) || !location) {
      return res.status(400).json({ error: 'Payload must contain assetIds array and location' });
    }
    try {
      await db.query('UPDATE assets SET location = $1 WHERE id = ANY($2)', [location, assetIds]);
      res.json({ message: `Successfully updated location of ${assetIds.length} assets` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Bulk asset location update failed' });
    }
  });

  app.post('/api/assets/bulk/department', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'assets', 'edit');
    if (!actingUser) return;

    const { assetIds, department } = req.body;
    if (!Array.isArray(assetIds) || !department) {
      return res.status(400).json({ error: 'Payload must contain assetIds array and department' });
    }
    try {
      await db.query('UPDATE assets SET department = $1 WHERE id = ANY($2)', [department, assetIds]);
      res.json({ message: `Successfully updated department of ${assetIds.length} assets` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Bulk asset department update failed' });
    }
  });
}

module.exports = { register };
