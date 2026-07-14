const { cq, cm } = require('../../convexApi');

/**
 * Department & Location master data.
 *
 * These replace the old free-text-with-hardcoded-fallback approach: every module now
 * populates its department/location pickers from these endpoints, which are the single
 * source of truth. Records elsewhere (assets, users, tickets…) continue to store the
 * *name* for display and historical stability, but the name always originates here.
 *
 * List endpoints return active rows only by default; pass ?all=true (admin management
 * screens) to include archived ones. DELETE archives rather than destroys, so the
 * historical rows that reference a department by name stay meaningful.
 *
 * Departments are gated by the `departments` permission resource, locations by
 * `branches` (the pre-existing key for physical sites).
 *
 * Backed by native Convex (backend/convex/masters.js) — no SQL.
 */

// Surface a ConvexError's message (carried on err.data) or unwrap the "Uncaught Error:"
// wrapper Convex puts around a thrown Error, so the client sees the real reason.
function cleanErr(err) {
  if (err && err.data) return typeof err.data === 'string' ? err.data : (err.data.message || 'Operation failed.');
  const msg = (err && err.message) || 'Operation failed.';
  const m = msg.match(/Uncaught (?:Convex)?Error:\s*(.+?)(?:\n|\s+at\s|$)/);
  return m ? m[1].trim() : msg;
}

function register(app, { requirePermission, requireUser }) {
  const mapRow = (r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? r.address ?? null,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  // Builds the four CRUD routes for one master table. `extraCol` is the optional second
  // text column (departments → description, locations → address). `dependencies` lists the
  // {table, col, label} references consulted before a permanent delete.
  function crud({ base, table, resource, label, extraCol, dependencies = [] }) {
    // LIST — active only unless ?all=true. Readable by any authenticated user: the
    // dropdowns that consume it appear in forms used across every role, so the read gate
    // is deliberately just authentication. Writes below stay permission-gated.
    app.get(`/api/${base}`, async (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      try {
        const includeArchived = req.query.all === 'true';
        const rows = await cq('masters:list', { table, includeArchived });
        res.json(rows.map(mapRow));
      } catch (err) {
        console.error(`GET /api/${base} failed:`, err);
        res.status(500).json({ error: `Could not load ${label}: ${cleanErr(err)}` });
      }
    });

    // CREATE
    app.post(`/api/${base}`, async (req, res) => {
      const user = await requirePermission(req, res, resource, 'create');
      if (!user) return;
      const name = (req.body.name || '').trim();
      const extra = extraCol ? (req.body.description ?? req.body.address ?? null) : null;
      if (!name) return res.status(400).json({ error: 'Name is required' });
      try {
        const row = await cm('masters:create', {
          table, name, extraCol: extraCol || undefined, extra, createdBy: user.name,
        });
        res.status(201).json(mapRow(row));
      } catch (err) {
        const msg = cleanErr(err);
        if (/already exists/i.test(msg)) return res.status(409).json({ error: msg });
        console.error(`POST /api/${base} failed:`, err);
        res.status(500).json({ error: `Could not create: ${msg}` });
      }
    });

    // UPDATE — rename, edit the extra column, or archive/restore via isActive.
    app.patch(`/api/${base}/:id`, async (req, res) => {
      const user = await requirePermission(req, res, resource, 'edit');
      if (!user) return;
      const patch = {};
      if (req.body.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
        patch.name = name;
      }
      if (extraCol && (req.body.description !== undefined || req.body.address !== undefined)) {
        patch[extraCol] = req.body.description ?? req.body.address ?? null;
      }
      if (req.body.isActive !== undefined) patch.is_active = !!req.body.isActive;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'No fields to update' });
      try {
        const row = await cm('masters:update', { table, id: Number(req.params.id), patch });
        if (!row) return res.status(404).json({ error: `${label} not found` });
        res.json(mapRow(row));
      } catch (err) {
        const msg = cleanErr(err);
        if (/already in use/i.test(msg)) return res.status(409).json({ error: msg });
        console.error(`PATCH /api/${base} failed:`, err);
        res.status(500).json({ error: `Could not update: ${msg}` });
      }
    });

    // DELETE — archive (soft) by default. Records that reference the name by value stay
    // valid. Pass ?permanent=true to remove the row outright, which first verifies nothing
    // references it; if anything does, the delete is refused (409) with a breakdown so the
    // caller can archive instead. Both paths require the resource's `delete` permission.
    app.delete(`/api/${base}/:id`, async (req, res) => {
      const user = await requirePermission(req, res, resource, 'delete');
      if (!user) return;

      const permanent = req.query.permanent === 'true';
      try {
        if (!permanent) {
          const row = await cm('masters:archive', { table, id: Number(req.params.id) });
          if (!row) return res.status(404).json({ error: `${label} not found` });
          return res.json({ archived: true, ...mapRow(row) });
        }

        const result = await cm('masters:remove', { table, id: Number(req.params.id), dependencies });
        if (result.notFound) return res.status(404).json({ error: `${label} not found` });
        if (result.blocked) {
          const summary = result.dependencies.map((d) => `${d.count} ${d.label}`).join(', ');
          return res.status(409).json({
            error: `"${result.name}" cannot be deleted because it is still used by ${summary}. Reassign those records or archive this ${label} instead.`,
            dependencies: result.dependencies,
            canArchive: true,
          });
        }
        res.json({ deleted: true, id: result.id, name: result.name });
      } catch (err) {
        console.error(`DELETE /api/${base} failed:`, err);
        res.status(500).json({ error: `Could not ${permanent ? 'delete' : 'archive'}: ${cleanErr(err)}` });
      }
    });
  }

  crud({
    base: 'departments', table: 'departments', resource: 'departments', label: 'department', extraCol: 'description',
    dependencies: [
      { table: 'assets', col: 'department', label: 'asset(s)' },
      { table: 'assets', col: 'associate_department', label: 'asset(s) as associate department' },
      { table: 'users', col: 'department', label: 'employee(s)' },
      { table: 'tickets', col: 'department', label: 'ticket(s)' },
      { table: 'asset_assignments', col: 'department', label: 'allocation(s)' },
      { table: 'kb_categories', col: 'department', label: 'knowledge base category(ies)' },
    ],
  });
  crud({
    base: 'locations', table: 'locations', resource: 'branches', label: 'location', extraCol: 'address',
    dependencies: [
      { table: 'assets', col: 'location', label: 'asset(s)' },
    ],
  });
}

module.exports = { register };
