import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// Native Convex data layer for movement history. Documents keep the mirrored snake_case
// shape: id (SERIAL), asset_id, date, type, from_loc, to_loc, actor, notes, created_at.
// Employees see only the history of assets they currently hold.

const nowIso = () => new Date().toISOString();
const nextId = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
const byDateDesc = (a, b) =>
  String(b.date || "").localeCompare(String(a.date || "")) ||
  String(b.created_at || "").localeCompare(String(a.created_at || ""));

async function activeAssetIdsForUser(ctx, userId) {
  const rows = await ctx.db
    .query("asset_assignments")
    .filter((q) => q.and(q.eq(q.field("user_id"), userId), q.eq(q.field("status"), "Assigned")))
    .collect();
  return new Set(rows.map((r) => r.asset_id));
}

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("movements").collect();
    rows.sort(byDateDesc);
    return rows;
  },
});

export const listForEmployee = query({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const ids = await activeAssetIdsForUser(ctx, userId);
    const rows = (await ctx.db.query("movements").collect()).filter((m) => ids.has(m.asset_id));
    rows.sort(byDateDesc);
    return rows;
  },
});

export const create = mutation({
  args: { doc: v.any() },
  handler: async (ctx, { doc }) => {
    const rows = await ctx.db.query("movements").collect();
    const _id = await ctx.db.insert("movements", { id: nextId(rows), created_at: nowIso(), ...doc });
    return await ctx.db.get(_id);
  },
});
