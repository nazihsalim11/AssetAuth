/**
 * Generic bulk-management endpoints. One router serves every registered entity
 * (backend/src/bulk/registry.js) through the shared engine — Vendors and AMC today, any
 * future entity with zero new route code.
 *
 *   GET  /api/bulk/:entity/schema     columns + template sample (drives the UI)      [view]
 *   GET  /api/bulk/:entity/export     all rows shaped into template columns          [view]
 *   POST /api/bulk/:entity/validate   { rows } -> validation report, no writes       [view]
 *   POST /api/bulk/:entity/preview    { rows } -> report + normalised preview         [view]
 *   POST /api/bulk/:entity/import     { rows } -> commit new rows                     [create]
 *   POST /api/bulk/:entity/update     { rows } -> patch existing rows by business key [edit]
 *   POST /api/bulk/:entity/delete     { ids }  -> delete rows by business key         [delete]
 */

const engine = require('../bulk/engine');
const { getDescriptor } = require('../bulk/registry');

function register(app, { requirePermission }) {
  // Resolve the descriptor and enforce the module/verb permission for this action.
  async function guard(req, res, verb) {
    let descriptor;
    try {
      descriptor = getDescriptor(req.params.entity);
    } catch (err) {
      res.status(err.statusCode || 404).json({ error: err.message });
      return null;
    }
    const user = await requirePermission(req, res, descriptor.permission, verb);
    if (!user) return null; // requirePermission already answered
    return { descriptor, user };
  }

  const fail = (res, err, action) => {
    console.error(`Bulk ${action} failed:`, err);
    res.status(err.statusCode || 500).json({ error: `Bulk ${action} failed: ${err.message}` });
  };

  app.get('/api/bulk/:entity/schema', async (req, res) => {
    if (!(await guard(req, res, 'view'))) return;
    try { res.json(engine.schema(req.params.entity)); }
    catch (err) { fail(res, err, 'schema'); }
  });

  app.get('/api/bulk/:entity/export', async (req, res) => {
    if (!(await guard(req, res, 'view'))) return;
    try { res.json(await engine.exportRows(req.params.entity)); }
    catch (err) { fail(res, err, 'export'); }
  });

  app.post('/api/bulk/:entity/validate', async (req, res) => {
    if (!(await guard(req, res, 'view'))) return;
    const rows = req.body && req.body.rows;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'Body must contain a rows array.' });
    try {
      const { errors, summary } = await engine.validate(req.params.entity, rows);
      res.json({ summary, errors });
    } catch (err) { fail(res, err, 'validate'); }
  });

  app.post('/api/bulk/:entity/preview', async (req, res) => {
    if (!(await guard(req, res, 'view'))) return;
    const rows = req.body && req.body.rows;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'Body must contain a rows array.' });
    try { res.json(await engine.preview(req.params.entity, rows)); }
    catch (err) { fail(res, err, 'preview'); }
  });

  app.post('/api/bulk/:entity/import', async (req, res) => {
    if (!(await guard(req, res, 'create'))) return;
    const rows = req.body && req.body.rows;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'Body must contain a rows array.' });
    if (rows.length === 0) return res.status(400).json({ error: 'There are no rows to import.' });
    try { res.json(await engine.importRows(req.params.entity, rows)); }
    catch (err) { fail(res, err, 'import'); }
  });

  app.post('/api/bulk/:entity/update', async (req, res) => {
    if (!(await guard(req, res, 'edit'))) return;
    const rows = req.body && req.body.rows;
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'Body must contain a rows array.' });
    try { res.json(await engine.updateRows(req.params.entity, rows)); }
    catch (err) { fail(res, err, 'update'); }
  });

  app.post('/api/bulk/:entity/delete', async (req, res) => {
    if (!(await guard(req, res, 'delete'))) return;
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'Body must contain an ids array.' });
    try { res.json(await engine.removeByIds(req.params.entity, ids)); }
    catch (err) { fail(res, err, 'delete'); }
  });
}

module.exports = { register };
