import { mutation } from "./_generated/server";
import { v } from "convex/values";

// Minimal system_logs writer used by modules that record audit lines (bulk asset ops,
// etc.). The full logs route conversion can extend this with listing. system_logs had a
// SERIAL id, derived here as max(id)+1 since Convex has no auto-increment.

const nextId = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;

export const add = mutation({
  args: { actor: v.string(), action: v.string(), detail: v.optional(v.string()) },
  handler: async (ctx, { actor, action, detail }) => {
    const rows = await ctx.db.query("system_logs").collect();
    const now = new Date().toISOString();
    const _id = await ctx.db.insert("system_logs", {
      id: nextId(rows),
      timestamp: now,
      actor,
      action,
      detail: detail ?? null,
      created_at: now,
    });
    return await ctx.db.get(_id);
  },
});
