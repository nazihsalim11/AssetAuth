import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Reusable, race-safe ID generation for any entity.
 *
 * "Next ID from the highest existing ID" is reconciled with a persistent counter so the
 * generator is correct even when rows were created out of band (manual entry, imports):
 * the next number is max(stored counter, highest suffix already in the target table) and is
 * then bumped past any value that is somehow still taken. Because a Convex mutation is a
 * serializable transaction, `reserve` cannot hand the same number to two concurrent callers.
 *
 * The engine is generic — the target table, the id field, and the format (prefix + zero
 * padding) are all passed in by the Node service (backend/src/services/idGenerator.js),
 * mirroring how masters.js stays generic over the table name. Format is stored on the
 * sequence row on first use and can be reconfigured via `configure`.
 *
 * Sequence row shape: { id, entity, prefix, padding, next_number, updated_at }.
 */

const nowIso = () => new Date().toISOString();
const nextRowId = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;

const format = (prefix, padding, n) => `${prefix}${String(n).padStart(padding, "0")}`;

// Highest numeric suffix among existing ids that match the prefix, e.g. "EMP0042" -> 42.
// Prefix match is case-insensitive; a trailing run of digits is the number.
function highestExisting(rows, field, prefix) {
  const p = String(prefix || "").toLowerCase();
  let max = 0;
  for (const r of rows) {
    const val = String(r[field] ?? "");
    if (!val) continue;
    const lower = val.toLowerCase();
    if (p && !lower.startsWith(p)) continue;
    const m = val.slice(prefix.length).match(/^0*(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}

const getSeq = (ctx, entity) =>
  ctx.db.query("id_sequences").filter((q) => q.eq(q.field("entity"), entity)).first();

// Compute the next free formatted id + number, given the current counter and the target
// table's contents. Pure of side effects, so both peek and reserve share it.
async function computeNext(ctx, { entity, table, field, prefix, padding }) {
  const seq = await getSeq(ctx, entity);
  const usePrefix = seq?.prefix ?? prefix ?? "";
  const usePadding = seq?.padding ?? padding ?? 4;
  const counter = seq?.next_number ?? 1;

  const rows = table ? await ctx.db.query(table).collect() : [];
  const taken = new Set(rows.map((r) => String(r[field] ?? "").toLowerCase()));

  let n = Math.max(counter, highestExisting(rows, field, usePrefix) + 1);
  while (taken.has(format(usePrefix, usePadding, n).toLowerCase())) n++;

  return { seq, nextId: format(usePrefix, usePadding, n), number: n, prefix: usePrefix, padding: usePadding };
}

// ---------------------------------------------------------------- queries

// Preview only — never persists. Used to pre-fill a form field the user may overwrite.
export const peek = query({
  args: {
    entity: v.string(),
    table: v.optional(v.string()),
    field: v.optional(v.string()),
    prefix: v.optional(v.string()),
    padding: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const { nextId, number, prefix, padding } = await computeNext(ctx, args);
    return { nextId, number, prefix, padding };
  },
});

export const config = query({
  args: { entity: v.string() },
  handler: async (ctx, { entity }) => {
    const seq = await getSeq(ctx, entity);
    if (!seq) return null;
    const { _id, _creationTime, ...rest } = seq;
    return rest;
  },
});

// ---------------------------------------------------------------- mutations

// Atomically hand out the next id and advance the counter past it. Race-safe.
export const reserve = mutation({
  args: {
    entity: v.string(),
    table: v.optional(v.string()),
    field: v.optional(v.string()),
    prefix: v.optional(v.string()),
    padding: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const { seq, nextId, number, prefix, padding } = await computeNext(ctx, args);
    if (seq) {
      await ctx.db.patch(seq._id, { next_number: number + 1, prefix, padding, updated_at: nowIso() });
    } else {
      const all = await ctx.db.query("id_sequences").collect();
      await ctx.db.insert("id_sequences", {
        id: nextRowId(all),
        entity: args.entity,
        prefix,
        padding,
        next_number: number + 1,
        updated_at: nowIso(),
      });
    }
    return { nextId, number, prefix, padding };
  },
});

// Change the format (prefix / padding) and optionally the counter floor. Creates the row
// if it does not exist yet. Authorised callers only (gated in the route).
export const configure = mutation({
  args: {
    entity: v.string(),
    prefix: v.optional(v.string()),
    padding: v.optional(v.float64()),
    nextNumber: v.optional(v.float64()),
  },
  handler: async (ctx, { entity, prefix, padding, nextNumber }) => {
    const seq = await getSeq(ctx, entity);
    if (seq) {
      const patch = { updated_at: nowIso() };
      if (prefix !== undefined) patch.prefix = prefix;
      if (padding !== undefined) patch.padding = padding;
      if (nextNumber !== undefined) patch.next_number = nextNumber;
      await ctx.db.patch(seq._id, patch);
      const { _id, _creationTime, ...rest } = await ctx.db.get(seq._id);
      return rest;
    }
    const all = await ctx.db.query("id_sequences").collect();
    const doc = {
      id: nextRowId(all),
      entity,
      prefix: prefix ?? "",
      padding: padding ?? 4,
      next_number: nextNumber ?? 1,
      updated_at: nowIso(),
    };
    const _id = await ctx.db.insert("id_sequences", doc);
    const { _id: _drop, _creationTime, ...rest } = await ctx.db.get(_id);
    return rest;
  },
});
