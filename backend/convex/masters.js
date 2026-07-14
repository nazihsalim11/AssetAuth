import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

// Native Convex data layer for the department & location master tables (the `masters`
// route). Generic over the table name so both share one implementation, mirroring the
// old `crud()` factory. Documents keep the mirrored snake_case shape: id (integer PK),
// name, is_active, created_by, created_at, updated_at, plus an optional extra text
// column (departments -> description, locations -> address).

const nowIso = () => new Date().toISOString();
const norm = (s) => String(s ?? "").trim().toLowerCase();

// Tables that actually exist in the Convex schema. Dependency checks skip anything else
// (e.g. `tickets`, not yet migrated) rather than throwing on an unknown table — the same
// defensive intent as the old to_regclass() guard.
const KNOWN_TABLES = new Set([
  "assets",
  "users",
  "asset_assignments",
  "kb_categories",
  "departments",
  "locations",
]);

// SERIAL had auto-increment; Convex does not, so derive the next integer id from the
// existing rows to keep the mirrored `id` contiguous with prior data.
const nextId = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;

const findById = (ctx, table, id) =>
  ctx.db.query(table).filter((q) => q.eq(q.field("id"), Number(id))).first();

// ---------------------------------------------------------------- queries

export const list = query({
  args: { table: v.string(), includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, { table, includeArchived }) => {
    let rows = await ctx.db.query(table).collect();
    if (!includeArchived) rows = rows.filter((r) => r.is_active !== false);
    rows.sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
    return rows;
  },
});

// ---------------------------------------------------------------- mutations

export const create = mutation({
  args: {
    table: v.string(),
    name: v.string(),
    extraCol: v.optional(v.string()),
    extra: v.optional(v.any()),
    createdBy: v.optional(v.string()),
  },
  handler: async (ctx, { table, name, extraCol, extra, createdBy }) => {
    const rows = await ctx.db.query(table).collect();
    if (rows.some((r) => norm(r.name) === norm(name))) {
      throw new ConvexError(`"${name}" already exists.`);
    }
    const doc = {
      id: nextId(rows),
      name,
      is_active: true,
      created_by: createdBy ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    if (extraCol) doc[extraCol] = extra ?? null;
    const _id = await ctx.db.insert(table, doc);
    return await ctx.db.get(_id);
  },
});

export const update = mutation({
  args: { table: v.string(), id: v.float64(), patch: v.any() },
  handler: async (ctx, { table, id, patch }) => {
    const row = await findById(ctx, table, id);
    if (!row) return null;

    if (patch.name !== undefined) {
      const rows = await ctx.db.query(table).collect();
      if (rows.some((r) => r._id !== row._id && norm(r.name) === norm(patch.name))) {
        throw new ConvexError("That name is already in use.");
      }
    }

    // Drop undefined keys so a partial patch never clobbers a field.
    const clean = {};
    for (const [k, val] of Object.entries(patch)) if (val !== undefined) clean[k] = val;
    await ctx.db.patch(row._id, { ...clean, updated_at: nowIso() });
    return await ctx.db.get(row._id);
  },
});

// Soft delete — archive by leaving the row but flipping is_active. Records elsewhere that
// reference the name by value stay valid.
export const archive = mutation({
  args: { table: v.string(), id: v.float64() },
  handler: async (ctx, { table, id }) => {
    const row = await findById(ctx, table, id);
    if (!row) return null;
    await ctx.db.patch(row._id, { is_active: false, updated_at: nowIso() });
    return await ctx.db.get(row._id);
  },
});

// Permanent delete with the reference guard. Counts rows in the dependency tables whose
// column matches this value (case/whitespace-insensitive, like the pickers store it).
// Returns { blocked, dependencies } if anything references it, otherwise { deleted }.
export const remove = mutation({
  args: {
    table: v.string(),
    id: v.float64(),
    dependencies: v.array(
      v.object({ table: v.string(), col: v.string(), label: v.string() })
    ),
  },
  handler: async (ctx, { table, id, dependencies }) => {
    const row = await findById(ctx, table, id);
    if (!row) return { notFound: true };

    const name = norm(row.name);
    const found = [];
    for (const d of dependencies) {
      if (!KNOWN_TABLES.has(d.table)) continue;
      const rows = await ctx.db.query(d.table).collect();
      const c = rows.filter((r) => norm(r[d.col]) === name).length;
      if (c > 0) found.push({ label: d.label, count: c });
    }
    if (found.length) return { blocked: true, name: row.name, dependencies: found };

    await ctx.db.delete(row._id);
    return { deleted: true, id: Number(row.id), name: row.name };
  },
});
