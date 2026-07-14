const { cq, cm } = require('../../convexApi');

// Convex system fields aren't part of the SQL row shape the frontend expects.
const stripSys = (d) => {
  if (!d) return d;
  const { _id, _creationTime, ...rest } = d;
  return rest;
};

// Map a Convex error back to an HTTP status + message. Structured errors carry
// { code, message } on err.data; anything else is an unexpected 500.
function errBody(err) {
  const d = err && err.data;
  if (d && typeof d === 'object' && d.code) return { status: d.code, message: d.message || 'Operation failed.' };
  const msg = (err && err.message) || 'Operation failed.';
  const m = msg.match(/Uncaught (?:Convex)?Error:\s*(.+?)(?:\n|\s+at\s|$)/);
  return { status: 500, message: m ? m[1].trim() : msg };
}

// Quantity-based assignment APIs — the custody registry, employee search/asset lookup,
// and the assign/transfer/return/edit flows. Backed by native Convex
// (backend/convex/assignments.js); each mutation is a single atomic transaction.
function register(app, { requireUser, requirePermission, isEmployee }) {
  app.get('/api/assignments', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const scoped = isEmployee(user);
      const rows = await cq('assignments:list', { scoped, userId: scoped ? user.id : undefined });
      res.json(rows.map(stripSys));
    } catch (err) {
      console.error('GET /api/assignments failed:', err);
      res.status(500).json({ error: 'Database query failed: ' + errBody(err).message });
    }
  });

  /* ---------------- Employee asset lookup ---------------- */

  // Search the directory. Employees may only look themselves up.
  app.get('/api/employees/search', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);

    try {
      const rows = await cq('assignments:employeeSearch', {
        q,
        selfId: user.role === 'Employee' ? user.id : undefined,
      });
      res.json(rows);
    } catch (err) {
      console.error('GET /api/employees/search failed:', err);
      res.status(500).json({ error: 'Employee search failed: ' + errBody(err).message });
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
      const result = await cq('assignments:employeeAssets', { targetId });
      if (!result) return res.status(404).json({ error: 'Employee not found' });
      res.json(result);
    } catch (err) {
      console.error('GET /api/employees/:id/assets failed:', err);
      res.status(500).json({ error: 'Could not load employee assets: ' + errBody(err).message });
    }
  });

  app.post('/api/assignments', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'allocations', 'create');
    if (!actingUser) return;

    const { assetId, employeeName, quantity, department, notes, date, expectedReturnDate } = req.body;
    const actor = req.headers['x-user-email'] || 'Admin';

    try {
      const assignment = await cm('assignments:allocate', {
        assetId, employeeName, quantity, department, notes, date, expectedReturnDate, actor,
      });
      res.status(201).json(stripSys(assignment));
    } catch (err) {
      const { status, message } = errBody(err);
      if (status !== 500) return res.status(status).json({ error: message });
      console.error(err);
      res.status(500).json({ error: 'Allocation failed: ' + message });
    }
  });

  // Custodian transfer / handover.
  app.post('/api/assets/:id/transfer', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'allocations', 'edit');
    if (!actingUser) return;

    const { id } = req.params;
    const { targetType, employeeName, department, location, date, notes } = req.body;
    const actor = req.headers['x-user-email'] || actingUser.email || 'Admin';

    try {
      const result = await cm('assignments:transfer', {
        id, targetType, employeeName, department, location, date, notes, actor,
      });
      res.json({ ok: true, asset: stripSys(result.asset) });
    } catch (err) {
      const { status, message } = errBody(err);
      if (status !== 500) return res.status(status).json({ error: message });
      console.error('POST /api/assets/:id/transfer failed:', err);
      res.status(500).json({ error: 'Transfer failed: ' + message });
    }
  });

  app.post('/api/assignments/:id/return', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'allocations', 'edit');
    if (!actingUser) return;

    const { id } = req.params;
    const { quantity, notes } = req.body;
    const actor = req.headers['x-user-email'] || 'Admin';

    try {
      const result = await cm('assignments:returnAssignment', { id: Number(id), quantity, notes, actor });
      res.json({ message: 'Assets returned successfully', returnedQuantity: result.returnedQuantity });
    } catch (err) {
      const { status, message } = errBody(err);
      if (status !== 500) return res.status(status).json({ error: message });
      console.error(err);
      res.status(500).json({ error: 'Return operation failed: ' + message });
    }
  });

  app.patch('/api/assignments/:id', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'allocations', 'edit');
    if (!actingUser) return;

    const { id } = req.params;
    const { quantity, employeeName, department, notes } = req.body;
    const actor = req.headers['x-user-email'] || 'Admin';

    try {
      await cm('assignments:updateAssignment', {
        id: Number(id), quantity, employeeName, department, notes, actor,
      });
      res.json({ message: 'Assignment updated successfully' });
    } catch (err) {
      const { status, message } = errBody(err);
      if (status !== 500) return res.status(status).json({ error: message });
      console.error(err);
      res.status(500).json({ error: 'Assignment update failed: ' + message });
    }
  });
}

module.exports = { register };
