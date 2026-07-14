import { mutation } from "./_generated/server";
import { v } from "convex/values";

// Write side of the reporting engine. The reports themselves are read-only and served by
// fetching raw tables via generic:list and aggregating in Node (see backend/reports.js);
// only two writes need dedicated mutations:
//   - scheduledCreate: scheduled_reports has a SERIAL id (max(id)+1 here) plus server-set
//     defaults (active, timestamps).
//   - emailInsert: mirrors a sent report into the Email Alerts Inbox, ON CONFLICT DO
//     NOTHING on the client-supplied string id.
// Edits / deletes / mark-run reuse generic:update / generic:remove.

const strip = (d) => {
  if (!d) return d;
  const { _id, _creationTime, ...rest } = d;
  return rest;
};

export const scheduledCreate = mutation({
  args: { doc: v.any() },
  handler: async (ctx, { doc }) => {
    const rows = await ctx.db.query("scheduled_reports").collect();
    const id = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
    const now = new Date().toISOString();
    const _id = await ctx.db.insert("scheduled_reports", {
      ...doc,
      id,
      active: true,
      last_run: null,
      created_at: now,
      updated_at: now,
    });
    return strip(await ctx.db.get(_id));
  },
});

export const emailInsert = mutation({
  args: { email: v.any() },
  handler: async (ctx, { email }) => {
    const found = await ctx.db
      .query("emails")
      .withIndex("by_original_id", (q) => q.eq("id", email.id))
      .first();
    if (found) return null; // ON CONFLICT (id) DO NOTHING
    await ctx.db.insert("emails", email);
    return { inserted: true };
  },
});
