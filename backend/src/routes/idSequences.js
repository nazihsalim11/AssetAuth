/**
 * Generic ID-generation endpoints, reusable for every registered entity.
 *
 *   GET   /api/id/:entity/next   -> { nextId, number, prefix, padding }   preview (no consume)
 *   GET   /api/id/:entity/config -> { prefix, padding, next_number }
 *   PATCH /api/id/:entity/config -> update format (Super Admin / IT Admin)
 *
 * Reservation is deliberately not exposed as its own endpoint: an id is consumed atomically
 * at the moment the owning record is created (e.g. a blank Employee ID on POST /api/users),
 * so previews never leave gaps in the sequence.
 */

const idGenerator = require('../services/idGenerator');

const CONFIG_ROLES = ['Super Admin', 'IT Admin'];

function register(app, { requireUser }) {
  app.get('/api/id/:entity/next', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      res.json(await idGenerator.peek(req.params.entity));
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  app.get('/api/id/:entity/config', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      res.json(await idGenerator.getConfig(req.params.entity));
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });

  app.patch('/api/id/:entity/config', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!CONFIG_ROLES.includes(user.role)) {
      return res.status(403).json({ error: 'Only an administrator can change ID formats.' });
    }
    const { prefix, padding, nextNumber } = req.body || {};
    if (padding !== undefined && (Number.isNaN(Number(padding)) || Number(padding) < 0 || Number(padding) > 12)) {
      return res.status(400).json({ error: 'Padding must be a number between 0 and 12.' });
    }
    try {
      res.json(await idGenerator.configure(req.params.entity, { prefix, padding, nextNumber }));
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  });
}

module.exports = { register };
