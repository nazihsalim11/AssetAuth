const { cq, cm } = require('../../convexApi');
const { resolveVendor } = require('../utils/vendor');

// Surface a ConvexError's message (carried on err.data) or unwrap Convex's
// "Uncaught Error:" prefix so the client sees the real reason.
function cleanErr(err) {
  if (err && err.data) return typeof err.data === 'string' ? err.data : (err.data.message || 'Operation failed.');
  const msg = (err && err.message) || 'Operation failed.';
  const m = msg.match(/Uncaught (?:Convex)?Error:\s*(.+?)(?:\n|\s+at\s|$)/);
  return m ? m[1].trim() : msg;
}

// Convex docs carry system fields the SQL rows never had; strip them so the response
// matches the previous snake_case row shape the frontend camelCases.
const stripSys = (d) => {
  if (!d) return d;
  const { _id, _creationTime, ...rest } = d;
  return rest;
};

// Assets API. Employees are custodians, not managers: they see only the assets currently
// assigned to them and may not create, modify or delete any asset. Every mutation is
// gated by the module->verb matrix. Backed by native Convex (backend/convex/assets.js).
function register(app, { requireUser, requirePermission, isEmployee }) {
  // Employees see only the assets currently assigned to them, scoped on
  // asset_assignments.user_id (the FK truth), not the assigned_employee display summary.
  app.get('/api/assets', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const rows = isEmployee(user)
        ? await cq('assets:listForEmployee', { userId: user.id })
        : await cq('assets:listAll', {});
      res.json(rows.map(stripSys));
    } catch (err) {
      console.error('GET /api/assets failed:', err);
      res.status(500).json({ error: 'Database query failed: ' + cleanErr(err) });
    }
  });

  // Master data: valid Item Types (Asset Tag Subtypes) grouped by Asset Category.
  app.get('/api/asset-subtypes', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const grouped = await cq('assets:subtypesGrouped', {});
      res.json(grouped);
    } catch (err) {
      console.error('GET /api/asset-subtypes failed:', err);
      res.status(500).json({ error: 'Could not load asset subtypes: ' + cleanErr(err) });
    }
  });

  app.post('/api/assets', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'assets', 'create');
    if (!actingUser) return;

    const {
      id, name, serialNumber, category, type, status, cost, purchaseDate,
      warrantyExpiry, department, associateDepartment, location, amcId, invoiceId,
      assignedEmployee, depreciationLifeYears, notes, reorderLevel, supplier
    } = req.body;

    // Vendor is optional on an asset, but when supplied it comes from the registry.
    // The resolved name is snapshotted into `supplier` for display/back-compat; vendor_id
    // is the referential link. A free-text supplier (e.g. bulk import) is still accepted.
    let vendorId, vendorName;
    try {
      ({ vendorId, vendorName } = await resolveVendor({ vendorId: req.body.vendorId, vendor: supplier }, { required: false }));
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }

    // Useful Lifespan is optional: an omitted/blank value is stored as NULL rather than
    // forced to a default. reorder_level drives Low Inventory alerts; 0 means "not tracked".
    const doc = {
      id,
      name,
      serial_number: serialNumber,
      category,
      type,
      status: status || 'Available',
      cost: cost || 0,
      purchase_date: purchaseDate || null,
      warranty_expiry: warrantyExpiry || null,
      department: department || '',
      associate_department: associateDepartment || null,
      location: location || '',
      amc_id: amcId || null,
      invoice_id: invoiceId || null,
      assigned_employee: assignedEmployee || '',
      depreciation_life_years: depreciationLifeYears ? parseInt(depreciationLifeYears) : null,
      notes: notes || '',
      reorder_level: reorderLevel ? parseInt(reorderLevel) : 0,
      supplier: vendorName || '',
      vendor_id: vendorId ?? null,
    };

    try {
      const created = await cm('assets:create', { doc });
      res.status(201).json(stripSys(created));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database insertion failed: ' + cleanErr(err) });
    }
  });

  app.patch('/api/assets/:id', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'assets', 'edit');
    if (!actingUser) return;

    const { id } = req.params;
    const fields = req.body;

    // camelCase field -> snake_case column. Custodian existence is validated inside the
    // Convex mutation (must be a real active employee) — the same guard as before.
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
      notes: 'notes',
      reorderLevel: 'reorder_level'
    };

    const patch = {};
    for (const [key, dbCol] of Object.entries(allowedFields)) {
      if (fields[key] !== undefined) {
        // Empty string for a foreign key means "clear it".
        patch[dbCol] = (key === 'amcId' || key === 'invoiceId') && fields[key] === '' ? null : fields[key];
      }
    }

    // Vendor: re-point via the registry (vendorId) or a free-text supplier override,
    // keeping supplier (display name) and vendor_id (FK) in step.
    if (fields.vendorId !== undefined || fields.supplier !== undefined) {
      let resolved;
      try {
        resolved = await resolveVendor({ vendorId: fields.vendorId, vendor: fields.supplier }, { required: false });
      } catch (err) {
        return res.status(err.statusCode || 400).json({ error: err.message });
      }
      patch.supplier = resolved.vendorName || '';
      patch.vendor_id = resolved.vendorId ?? null;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    try {
      const updated = await cm('assets:update', { id, patch });
      if (!updated) return res.status(404).json({ error: 'Asset not found' });
      res.json(stripSys(updated));
    } catch (err) {
      const msg = cleanErr(err);
      // The custodian guard is a client input error, not a server fault.
      if (/does not exist in the user directory|already in use/i.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      console.error(err);
      res.status(500).json({ error: 'Database update failed: ' + msg });
    }
  });

  app.delete('/api/assets/:id', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'assets', 'delete');
    if (!actingUser) return;

    const { id } = req.params;
    try {
      const asset = await cm('assets:remove', { id });
      if (!asset) return res.status(404).json({ error: 'Asset not found' });
      res.json({ message: 'Asset deleted successfully', asset: stripSys(asset) });
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
      await cm('assets:bulkRemove', { ids: assetIds });
      const actor = req.headers['x-user-email'] || 'Admin';
      await cm('logs:add', { actor, action: 'Bulk Delete Assets', detail: `Deleted ${assetIds.length} assets` });
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
      await cm('assets:bulkPatch', { ids: assetIds, patch: { status } });
      const actor = req.headers['x-user-email'] || 'Admin';
      await cm('logs:add', { actor, action: 'Bulk Status Update', detail: `Updated ${assetIds.length} assets to status ${status}` });
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
      await cm('assets:bulkPatch', { ids: assetIds, patch: { category } });
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
      await cm('assets:bulkPatch', { ids: assetIds, patch: { location } });
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
      await cm('assets:bulkPatch', { ids: assetIds, patch: { department } });
      res.json({ message: `Successfully updated department of ${assetIds.length} assets` });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Bulk asset department update failed' });
    }
  });
}

module.exports = { register };
