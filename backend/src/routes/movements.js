const { cq, cm } = require('../../convexApi');

// Convex system fields aren't part of the SQL row shape the frontend expects.
const stripSys = (d) => {
  if (!d) return d;
  const { _id, _creationTime, ...rest } = d;
  return rest;
};

// Movements API. Movement history names assets and custodians, so it is scoped the same
// way the directory is: an employee sees only the history of assets they currently hold.
// Backed by native Convex (backend/convex/movements.js).
function register(app, { requireUser, requirePermission, isEmployee }) {
  app.get('/api/movements', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const rows = isEmployee(user)
        ? await cq('movements:listForEmployee', { userId: user.id })
        : await cq('movements:listAll', {});
      res.json(rows.map(stripSys));
    } catch (err) {
      console.error('GET /api/movements failed:', err);
      res.status(500).json({ error: 'Database query failed: ' + (err.message || err) });
    }
  });

  app.post('/api/movements', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'allocations', 'create');
    if (!actingUser) return;

    const { assetId, date, type, from, to, actor, notes } = req.body;
    const doc = {
      asset_id: assetId,
      date: date || new Date().toISOString().slice(0, 10),
      type,
      from_loc: from || '',
      to_loc: to || '',
      actor,
      notes: notes || '',
    };

    try {
      const created = await cm('movements:create', { doc });
      res.status(201).json(stripSys(created));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database insertion failed: ' + (err.message || err) });
    }
  });
}

module.exports = { register };
