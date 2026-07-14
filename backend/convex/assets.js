import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

// Native Convex data layer for the assets domain. Documents keep the mirrored snake_case
// shape: id (client-supplied VARCHAR PK), name, serial_number (unique), category, type,
// status, cost, department, location, vendor_id, supplier, assigned_employee, ...
// Employee visibility scopes on asset_assignments.user_id (the FK truth), not on the
// assigned_employee display summary.

const nowIso = () => new Date().toISOString();
const norm = (s) => String(s ?? "").trim().toLowerCase();
const byCreatedDesc = (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""));

const findById = (ctx, id) =>
  ctx.db.query("assets").filter((q) => q.eq(q.field("id"), id)).first();

async function activeAssetIdsForUser(ctx, userId) {
  const rows = await ctx.db
    .query("asset_assignments")
    .filter((q) => q.and(q.eq(q.field("user_id"), userId), q.eq(q.field("status"), "Assigned")))
    .collect();
  return new Set(rows.map((r) => r.asset_id));
}

// ---------------------------------------------------------------- queries

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("assets").collect();
    rows.sort(byCreatedDesc);
    return rows;
  },
});

// Employee custodian view: only the assets they currently hold.
export const listForEmployee = query({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const ids = await activeAssetIdsForUser(ctx, userId);
    const rows = (await ctx.db.query("assets").collect()).filter((a) => ids.has(a.id));
    rows.sort(byCreatedDesc);
    return rows;
  },
});

// Item Types (asset tag subtypes) grouped by category — drives the dependent dropdowns.
export const subtypesGrouped = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("asset_subtypes").collect();
    rows.sort(
      (a, b) => norm(a.category).localeCompare(norm(b.category)) || norm(a.name).localeCompare(norm(b.name))
    );
    const grouped = {};
    for (const r of rows) (grouped[r.category] = grouped[r.category] || []).push(r.name);
    return grouped;
  },
});

// ---------------------------------------------------------------- mutations

export const create = mutation({
  args: { doc: v.any() },
  handler: async (ctx, { doc }) => {
    if (doc.id != null && (await findById(ctx, doc.id))) {
      throw new ConvexError(`Asset with id '${doc.id}' already exists.`);
    }
    if (doc.serial_number) {
      const all = await ctx.db.query("assets").collect();
      if (all.some((a) => a.serial_number && norm(a.serial_number) === norm(doc.serial_number))) {
        throw new ConvexError(`Serial number '${doc.serial_number}' is already in use.`);
      }
    }
    const _id = await ctx.db.insert("assets", { created_at: nowIso(), updated_at: nowIso(), ...doc });
    return await ctx.db.get(_id);
  },
});

export const update = mutation({
  args: { id: v.string(), patch: v.any() },
  handler: async (ctx, { id, patch }) => {
    const asset = await findById(ctx, id);
    if (!asset) return null;

    // Relocating to a custodian must name a real, active employee (by name or email).
    if (patch.assigned_employee) {
      const target = norm(patch.assigned_employee);
      const users = await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("status"), "Active"))
        .collect();
      const ok = users.some((u) => norm(u.name) === target || norm(u.email) === target);
      if (!ok) {
        throw new ConvexError(`Employee "${patch.assigned_employee}" does not exist in the user directory.`);
      }
    }

    if (patch.serial_number) {
      const all = await ctx.db.query("assets").collect();
      if (all.some((a) => a._id !== asset._id && a.serial_number && norm(a.serial_number) === norm(patch.serial_number))) {
        throw new ConvexError(`Serial number '${patch.serial_number}' is already in use.`);
      }
    }

    // Drop undefined keys so a partial patch never clobbers a field.
    const clean = {};
    for (const [k, val] of Object.entries(patch)) if (val !== undefined) clean[k] = val;
    await ctx.db.patch(asset._id, { ...clean, updated_at: nowIso() });
    return await ctx.db.get(asset._id);
  },
});

export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const asset = await findById(ctx, id);
    if (!asset) return null;
    const doc = { ...asset };
    await ctx.db.delete(asset._id);
    return doc;
  },
});

export const bulkRemove = mutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const set = new Set(ids);
    const rows = (await ctx.db.query("assets").collect()).filter((a) => set.has(a.id));
    for (const a of rows) await ctx.db.delete(a._id);
    return { deleted: rows.length };
  },
});

export const bulkPatch = mutation({
  args: { ids: v.array(v.string()), patch: v.any() },
  handler: async (ctx, { ids, patch }) => {
    const set = new Set(ids);
    const rows = (await ctx.db.query("assets").collect()).filter((a) => set.has(a.id));
    for (const a of rows) await ctx.db.patch(a._id, { ...patch, updated_at: nowIso() });
    return { updated: rows.length };
  },
});
