import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// Native Convex store for the role_permissions matrix — the per-role { module: { verb:
// bool } } overrides that Super Admins persist. Rows hold only stored edits; the code
// defaults (permissionModel.buildDefaultMatrix) are layered on top by the auth middleware,
// so an empty table simply means "everyone uses the defaults".

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("role_permissions").collect();
    return rows.map((r) => ({ role: r.role, permissions: r.permissions }));
  },
});

// Upsert one row per role (PK = role). The editor sends whole roles, so each is replaced
// wholesale — matching the old INSERT … ON CONFLICT (role) DO UPDATE.
export const upsertMany = mutation({
  args: { entries: v.array(v.object({ role: v.string(), permissions: v.any() })) },
  handler: async (ctx, { entries }) => {
    const now = new Date().toISOString();
    for (const { role, permissions } of entries) {
      const existing = await ctx.db
        .query("role_permissions")
        .filter((q) => q.eq(q.field("role"), role))
        .first();
      if (existing) await ctx.db.patch(existing._id, { permissions, updated_at: now });
      else await ctx.db.insert("role_permissions", { role, permissions, updated_at: now });
    }
    return { count: entries.length };
  },
});
