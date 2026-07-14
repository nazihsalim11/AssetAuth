import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

// Native Convex data layer for AMC (annual maintenance contract) records. Mirrored
// snake_case shape: id (client-supplied VARCHAR PK), vendor, vendor_id, cost, start_date,
// end_date, service_schedule, agreement_file, service_history (array), po_number (unique
// case-insensitive), created_at, updated_at.

const nowIso = () => new Date().toISOString();
const norm = (s) => String(s ?? "").trim().toLowerCase();

const findById = (ctx, id) =>
  ctx.db.query("amcs").filter((q) => q.eq(q.field("id"), id)).first();

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("amcs").collect();
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return rows;
  },
});

export const create = mutation({
  args: { doc: v.any() },
  handler: async (ctx, { doc }) => {
    const all = await ctx.db.query("amcs").collect();
    if (doc.id != null && all.some((a) => a.id === doc.id)) {
      throw new ConvexError(`AMC ID "${doc.id}" already exists.`);
    }
    if (doc.po_number && all.some((a) => norm(a.po_number) === norm(doc.po_number))) {
      throw new ConvexError(`PO Number "${doc.po_number}" already exists.`);
    }
    const _id = await ctx.db.insert("amcs", { created_at: nowIso(), updated_at: nowIso(), ...doc });
    return await ctx.db.get(_id);
  },
});

// The UI only ever patches the service history log on an existing AMC.
export const updateServiceHistory = mutation({
  args: { id: v.string(), serviceHistory: v.any() },
  handler: async (ctx, { id, serviceHistory }) => {
    const amc = await findById(ctx, id);
    if (!amc) return null;
    await ctx.db.patch(amc._id, { service_history: serviceHistory, updated_at: nowIso() });
    return await ctx.db.get(amc._id);
  },
});
