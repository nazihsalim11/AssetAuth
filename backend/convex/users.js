import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

// Native Convex data layer for the users domain — the first module of the migration off
// SQL/PGlite. Field names are snake_case to match the existing mirrored documents
// (workos_user_id, employee_id, ...). Mutations are atomic transactions.

const nowIso = () => new Date().toISOString();
const lc = (s) => String(s || "").toLowerCase();

async function findByWorkosId(ctx, workosUserId) {
  return await ctx.db
    .query("users")
    .filter((q) => q.eq(q.field("workos_user_id"), workosUserId))
    .first();
}

// ---------------------------------------------------------------- queries

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("users").collect();
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return rows;
  },
});

export const getByWorkosId = query({
  args: { workosUserId: v.string() },
  handler: async (ctx, { workosUserId }) => findByWorkosId(ctx, workosUserId),
});

export const getRole = query({
  args: { workosUserId: v.string() },
  handler: async (ctx, { workosUserId }) => {
    const u = await findByWorkosId(ctx, workosUserId);
    return u ? u.role : null;
  },
});

export const listActive = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("status"), "Active"))
      .collect();
    rows.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    return rows;
  },
});

// ---------------------------------------------------------------- mutations

// Find-or-create used by the auth provisioning flow. On first sign-in it inserts the
// profile with the caller-decided role (Super Admin for the bootstrap email, else
// Employee); returning users keep their stored role. Relinks a pre-seeded profile to
// the real WorkOS id.
export const provision = mutation({
  args: {
    workosUserId: v.string(),
    email: v.string(),
    name: v.string(),
    role: v.string(),
    status: v.optional(v.string()),
  },
  handler: async (ctx, { workosUserId, email, name, role, status }) => {
    const all = await ctx.db.query("users").collect();
    let user = all.find(
      (u) => lc(u.email) === lc(email) || u.workos_user_id === workosUserId
    );

    if (!user) {
      const _id = await ctx.db.insert("users", {
        workos_user_id: workosUserId,
        name,
        role,
        email,
        status: status || "Active",
        notification_preferences: { email: true, push: true },
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return await ctx.db.get(_id);
    }

    if (user.workos_user_id !== workosUserId) {
      await ctx.db.patch(user._id, { workos_user_id: workosUserId });
      user = await ctx.db.get(user._id);
    }
    return user;
  },
});

// Admin user creation. Enforces unique email + employee_id.
export const create = mutation({
  args: { doc: v.any() },
  handler: async (ctx, { doc }) => {
    const all = await ctx.db.query("users").collect();
    if (all.some((u) => lc(u.email) === lc(doc.email))) {
      throw new ConvexError(`Email '${doc.email}' is already registered.`);
    }
    if (doc.employee_id && all.some((u) => lc(u.employee_id) === lc(doc.employee_id))) {
      throw new ConvexError(`Employee ID '${doc.employee_id}' already exists. Please use a unique Employee ID.`);
    }
    const _id = await ctx.db.insert("users", {
      status: "Active",
      notification_preferences: { email: true, push: true },
      created_at: nowIso(),
      updated_at: nowIso(),
      ...doc,
    });
    return await ctx.db.get(_id);
  },
});

export const update = mutation({
  args: { workosUserId: v.string(), patch: v.any() },
  handler: async (ctx, { workosUserId, patch }) => {
    const user = await findByWorkosId(ctx, workosUserId);
    if (!user) return null;

    if (patch.employee_id) {
      const all = await ctx.db.query("users").collect();
      const dup = all.some(
        (u) => u._id !== user._id && lc(u.employee_id) === lc(patch.employee_id)
      );
      if (dup) {
        throw new ConvexError(`Employee ID '${patch.employee_id}' already exists. Please use a unique Employee ID.`);
      }
    }

    // Drop undefined keys so a partial patch never clobbers a field with null.
    const clean = {};
    for (const [k, val] of Object.entries(patch)) if (val !== undefined) clean[k] = val;
    await ctx.db.patch(user._id, { ...clean, updated_at: nowIso() });
    return await ctx.db.get(user._id);
  },
});

// Recompute an asset's assigned/available quantities from its remaining active
// assignments — mirrors the SQL the delete path used to run.
async function recomputeAsset(ctx, assetId) {
  const asset = await ctx.db
    .query("assets")
    .filter((q) => q.eq(q.field("id"), assetId))
    .first();
  if (!asset) return;

  const active = await ctx.db
    .query("asset_assignments")
    .filter((q) => q.and(q.eq(q.field("asset_id"), assetId), q.eq(q.field("status"), "Assigned")))
    .collect();

  const byEmployee = {};
  let assigned = 0;
  for (const r of active) {
    const qty = r.quantity || 0;
    assigned += qty;
    byEmployee[r.employee_name] = (byEmployee[r.employee_name] || 0) + qty;
  }
  const total = asset.total_quantity || 0;
  const available = Math.max(0, total - assigned);
  const summary = Object.entries(byEmployee).map(([n, q]) => `${n} (${q})`).join(", ") || null;

  await ctx.db.patch(asset._id, {
    assigned_quantity: assigned,
    available_quantity: available,
    status: available > 0 ? "Available" : "Assigned",
    assigned_employee: summary,
    updated_at: nowIso(),
  });
}

// Delete one user: remove their assignments, delete the profile, then recompute the
// affected assets' quantities. Returns the deleted profile summary (or null).
async function deleteUserDoc(ctx, user) {
  const assignments = await ctx.db
    .query("asset_assignments")
    .filter((q) => q.eq(q.field("user_id"), user.workos_user_id))
    .collect();
  const affectedAssetIds = [...new Set(assignments.map((a) => a.asset_id))];

  for (const a of assignments) await ctx.db.delete(a._id);
  await ctx.db.delete(user._id);
  for (const assetId of affectedAssetIds) await recomputeAsset(ctx, assetId);

  return { workos_user_id: user.workos_user_id, name: user.name, email: user.email, role: user.role };
}

export const remove = mutation({
  args: { workosUserId: v.string() },
  handler: async (ctx, { workosUserId }) => {
    const user = await findByWorkosId(ctx, workosUserId);
    if (!user) return null;
    return await deleteUserDoc(ctx, user);
  },
});

export const bulkRemove = mutation({
  args: { workosUserIds: v.array(v.string()) },
  handler: async (ctx, { workosUserIds }) => {
    const set = new Set(workosUserIds);
    const users = (await ctx.db.query("users").collect()).filter((u) => set.has(u.workos_user_id));
    for (const u of users) await deleteUserDoc(ctx, u);
    return { deleted: users.length };
  },
});

function makeBulkPatch(field) {
  return mutation({
    args: { workosUserIds: v.array(v.string()), value: v.any() },
    handler: async (ctx, { workosUserIds, value }) => {
      const set = new Set(workosUserIds);
      const users = (await ctx.db.query("users").collect()).filter((u) => set.has(u.workos_user_id));
      for (const u of users) await ctx.db.patch(u._id, { [field]: value, updated_at: nowIso() });
      return { updated: users.length };
    },
  });
}

export const bulkSetRole = makeBulkPatch("role");
export const bulkSetStatus = makeBulkPatch("status");
export const bulkSetDepartment = makeBulkPatch("department");
