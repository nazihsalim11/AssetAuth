import { mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Generic, entity-agnostic bulk write mutations shared by the bulk framework
 * (backend/src/bulk/engine.js). Every entity — vendors, AMC, and anything added later —
 * commits through these three mutations instead of hand-rolling its own batch logic.
 *
 * Each is a single Convex mutation, i.e. a serializable transaction: if any insert throws,
 * the whole batch for that call rolls back (the "transaction rollback" guarantee). Row-level
 * duplicate/not-found outcomes are reported per row (not thrown) so a partial-but-valid
 * import still lands the good rows, matching the existing employee/asset importers.
 */

const nowIso = () => new Date().toISOString();
const norm = (s) => String(s ?? "").trim().toLowerCase();
const nextId = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;

// Insert a batch. `unique` are the business keys to guard (case-insensitive) against both
// existing rows and earlier rows in this same batch. `serialId` assigns an integer id
// (max+1) when the table uses SERIAL PKs; otherwise the doc must carry its own id.
export const insertBatch = mutation({
  args: {
    table: v.string(),
    docs: v.array(v.any()), // each may carry a _ref echoed back in the result
    unique: v.optional(v.array(v.object({ field: v.string(), label: v.string() }))),
    serialId: v.optional(v.boolean()),
  },
  handler: async (ctx, { table, docs, unique = [], serialId = false }) => {
    const existing = await ctx.db.query(table).collect();
    let maxId = existing.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
    const seen = {};
    for (const u of unique) {
      seen[u.field] = new Set(existing.map((r) => norm(r[u.field])).filter(Boolean));
    }

    const results = [];
    for (const item of docs) {
      const { _ref, ...doc } = item;

      let dup = null;
      for (const u of unique) {
        const val = norm(doc[u.field]);
        if (val && seen[u.field].has(val)) { dup = `${u.label} "${doc[u.field]}" already exists.`; break; }
      }
      if (dup) { results.push({ ref: _ref, status: "duplicate", error: dup }); continue; }

      if (serialId) doc.id = ++maxId;
      const now = nowIso();
      if (doc.created_at === undefined) doc.created_at = now;
      doc.updated_at = now;

      for (const u of unique) { const val = norm(doc[u.field]); if (val) seen[u.field].add(val); }
      await ctx.db.insert(table, doc);
      results.push({ ref: _ref, status: "success", id: doc.id });
    }
    return results;
  },
});

// Patch a batch, matching each update by `idField`. Rows that do not exist are reported, not
// created (use insertBatch for creation). `patch` keys with undefined values are dropped.
export const updateBatch = mutation({
  args: {
    table: v.string(),
    idField: v.string(),
    updates: v.array(v.object({ _ref: v.optional(v.any()), idVal: v.any(), patch: v.any() })),
  },
  handler: async (ctx, { table, idField, updates }) => {
    const results = [];
    for (const u of updates) {
      const row = await ctx.db.query(table).filter((q) => q.eq(q.field(idField), u.idVal)).first();
      if (!row) { results.push({ ref: u._ref, status: "notfound", error: `${idField} "${u.idVal}" not found.` }); continue; }
      const clean = {};
      for (const [k, val] of Object.entries(u.patch)) if (val !== undefined) clean[k] = val;
      await ctx.db.patch(row._id, { ...clean, updated_at: nowIso() });
      results.push({ ref: u._ref, status: "success", id: row.id });
    }
    return results;
  },
});

// Delete a batch by id, optionally nulling foreign-key references first (ON DELETE SET NULL).
export const removeBatch = mutation({
  args: {
    table: v.string(),
    idField: v.string(),
    idVals: v.array(v.any()),
    cascade: v.optional(v.array(v.object({ table: v.string(), field: v.string() }))),
  },
  handler: async (ctx, { table, idField, idVals, cascade = [] }) => {
    let deleted = 0;
    const notFound = [];
    for (const idVal of idVals) {
      const row = await ctx.db.query(table).filter((q) => q.eq(q.field(idField), idVal)).first();
      if (!row) { notFound.push(idVal); continue; }
      for (const c of cascade) {
        const refs = await ctx.db.query(c.table).filter((q) => q.eq(q.field(c.field), row.id)).collect();
        for (const r of refs) await ctx.db.patch(r._id, { [c.field]: null });
      }
      await ctx.db.delete(row._id);
      deleted++;
    }
    return { deleted, notFound };
  },
});
