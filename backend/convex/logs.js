import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// system_logs data layer: the audit-line writer used across modules (bulk ops,
// allocations, permission edits, …) plus the read side for the System Logs view.
// system_logs had a SERIAL id, derived here as max(id)+1 since Convex has no
// auto-increment.

const nextId = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("system_logs").collect();
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return rows;
  },
});

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
