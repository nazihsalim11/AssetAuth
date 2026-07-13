const db = require('../../db');

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
 */
function register(app, { requirePermission, requireUser }) {
  const mapRow = (r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? r.address ?? null,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  // Counts every record that references this master value by name, across the tables that
  // carry it. A non-empty result blocks a permanent delete (archive is always allowed).
  // Matching is case/whitespace-insensitive to mirror how the pickers store the name.
  async function dependencyReport(deps, name) {
    const found = [];
    for (const d of deps) {
      // Skip tables that do not exist in this database (defensive; all normally present).
      const exists = await db.query('SELECT to_regclass($1) AS t', [`public.${d.table}`]);
      if (!exists.rows[0].t) continue;
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS c FROM ${d.table} WHERE LOWER(TRIM(${d.col})) = LOWER(TRIM($1))`,
        [name]
      );
      if (rows[0].c > 0) found.push({ label: d.label, count: rows[0].c });
    }
    return found;
  }

  // Builds the four CRUD routes for one master table. `extraCol` is the optional second
  // text column (departments → description, locations → address). `dependencies` lists the
  // {table, col, label} references consulted before a permanent delete.
  function crud({ base, table, resource, label, extraCol, dependencies = [] }) {
    const cols = extraCol ? `id, name, ${extraCol} AS description, is_active, created_at, updated_at`
                          : `id, name, NULL AS description, is_active, created_at, updated_at`;

    // LIST — active only unless ?all=true. Readable by any authenticated user: the
    // dropdowns that consume it appear in forms used across every role, so the read gate
    // is deliberately just authentication. Writes below stay permission-gated.
    app.get(`/api/${base}`, async (req, res) => {
      const user = requireUser(req, res);
      if (!user) return;
      try {
        const includeArchived = req.query.all === 'true';
        const where = includeArchived ? '' : 'WHERE is_active = TRUE';
        const { rows } = await db.query(
          `SELECT ${cols} FROM ${table} ${where} ORDER BY LOWER(name)`
        );
        res.json(rows.map(mapRow));
      } catch (err) {
        console.error(`GET /api/${base} failed:`, err);
        res.status(500).json({ error: `Could not load ${label}: ${err.message}` });
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
        const insertCols = extraCol ? `name, ${extraCol}, created_by` : 'name, created_by';
        const insertVals = extraCol ? '$1, $2, $3' : '$1, $2';
        const params = extraCol ? [name, extra, user.name] : [name, user.name];
        const { rows } = await db.query(
          `INSERT INTO ${table} (${insertCols}) VALUES (${insertVals})
           RETURNING ${cols}`,
          params
        );
        res.status(201).json(mapRow(rows[0]));
      } catch (err) {
        if (err.code === '23505') {
          return res.status(409).json({ error: `"${name}" already exists.` });
        }
        console.error(`POST /api/${base} failed:`, err);
        res.status(500).json({ error: `Could not create: ${err.message}` });
      }
    });

    // UPDATE — rename, edit the extra column, or archive/restore via isActive.
    app.patch(`/api/${base}/:id`, async (req, res) => {
      const user = await requirePermission(req, res, resource, 'edit');
      if (!user) return;
      const sets = [];
      const params = [];
      let i = 1;
      if (req.body.name !== undefined) {
        const name = String(req.body.name).trim();
        if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
        sets.push(`name = $${i++}`); params.push(name);
      }
      if (extraCol && (req.body.description !== undefined || req.body.address !== undefined)) {
        sets.push(`${extraCol} = $${i++}`); params.push(req.body.description ?? req.body.address ?? null);
      }
      if (req.body.isActive !== undefined) {
        sets.push(`is_active = $${i++}`); params.push(!!req.body.isActive);
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      params.push(req.params.id);
      try {
        const { rows } = await db.query(
          `UPDATE ${table} SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING ${cols}`,
          params
        );
        if (!rows.length) return res.status(404).json({ error: `${label} not found` });
        res.json(mapRow(rows[0]));
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'That name is already in use.' });
        console.error(`PATCH /api/${base} failed:`, err);
        res.status(500).json({ error: `Could not update: ${err.message}` });
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
        const target = await db.query(`SELECT ${cols} FROM ${table} WHERE id = $1`, [req.params.id]);
        if (!target.rows.length) return res.status(404).json({ error: `${label} not found` });
        const row = target.rows[0];

        if (!permanent) {
          const { rows } = await db.query(
            `UPDATE ${table} SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING ${cols}`,
            [req.params.id]
          );
          return res.json({ archived: true, ...mapRow(rows[0]) });
        }

        // Permanent delete: block if anything still references this value.
        const deps = await dependencyReport(dependencies, row.name);
        if (deps.length) {
          const summary = deps.map((d) => `${d.count} ${d.label}`).join(', ');
          return res.status(409).json({
            error: `"${row.name}" cannot be deleted because it is still used by ${summary}. Reassign those records or archive this ${label} instead.`,
            dependencies: deps,
            canArchive: true
          });
        }

        await db.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
        res.json({ deleted: true, id: Number(req.params.id), name: row.name });
      } catch (err) {
        console.error(`DELETE /api/${base} failed:`, err);
        res.status(500).json({ error: `Could not ${permanent ? 'delete' : 'archive'}: ${err.message}` });
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
