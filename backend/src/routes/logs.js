const { cq, cm } = require('../../convexApi');

const stripSys = (d) => {
  if (!d) return d;
  const { _id, _creationTime, ...rest } = d;
  return rest;
};

// System logs API. Backed by native Convex (backend/convex/logs.js).
function register(app) {
  app.get('/api/logs', async (req, res) => {
    try {
      const rows = await cq('logs:list', {});
      res.json(rows.map(stripSys));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database query failed' });
    }
  });

  app.post('/api/logs', async (req, res) => {
    // A client-supplied timestamp is ignored: created_at is set server-side, so a caller
    // with a wrong clock cannot back-date a log entry.
    const { actor, action, detail } = req.body;
    try {
      const created = await cm('logs:add', { actor, action, detail: detail || '' });
      res.status(201).json(stripSys(created));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database insertion failed: ' + (err.message || err) });
    }
  });
}

module.exports = { register };
