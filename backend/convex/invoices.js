import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

// Native Convex data layer for invoices + the invoice⇆asset mapping. The link lives in
// assets.invoice_id (an asset belongs to at most one invoice), so mapping mutations edit
// assets. Mirrored snake_case invoice shape: id (VARCHAR PK), po_reference, vendor,
// vendor_id, amount, gst, date, payment_status, file_name, created_at, updated_at.

const nowIso = () => new Date().toISOString();
const cerr = (code, message) => new ConvexError({ code, message });
const normIds = (assetIds) => [...new Set((assetIds || []).map((x) => String(x).trim()).filter(Boolean))];

const findInvoice = (ctx, id) =>
  ctx.db.query("invoices").filter((q) => q.eq(q.field("id"), id)).first();

const invoiceAssets = async (ctx, invoiceId) =>
  (await ctx.db.query("assets").collect())
    .filter((a) => a.invoice_id === invoiceId)
    .sort((x, y) => String(x.id).localeCompare(String(y.id)));

// ---------------------------------------------------------------- queries

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("invoices").collect();
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return rows;
  },
});

// Current mapping for an invoice. Returns { notFound: true } if the invoice is gone.
export const getAssets = query({
  args: { invoiceId: v.string() },
  handler: async (ctx, { invoiceId }) => {
    const invoice = await findInvoice(ctx, invoiceId);
    if (!invoice) return { notFound: true };
    const assets = await invoiceAssets(ctx, invoiceId);
    return { invoiceId, assets, assetIds: assets.map((a) => a.id) };
  },
});

// ---------------------------------------------------------------- mutations

export const create = mutation({
  args: { doc: v.any() },
  handler: async (ctx, { doc }) => {
    if (doc.id != null && (await findInvoice(ctx, doc.id))) {
      throw new ConvexError(`Invoice ID '${doc.id}' already exists.`);
    }
    const _id = await ctx.db.insert("invoices", { created_at: nowIso(), updated_at: nowIso(), ...doc });
    return await ctx.db.get(_id);
  },
});

export const update = mutation({
  args: { id: v.string(), patch: v.any() },
  handler: async (ctx, { id, patch }) => {
    const invoice = await findInvoice(ctx, id);
    if (!invoice) return null;
    const clean = {};
    for (const [k, val] of Object.entries(patch)) if (val !== undefined) clean[k] = val;
    await ctx.db.patch(invoice._id, { ...clean, updated_at: nowIso() });
    return await ctx.db.get(invoice._id);
  },
});

// Bulk import with per-row validation + duplicate detection (against the DB and earlier
// rows in the same batch), mirroring the old row-by-row loop.
export const bulkCreate = mutation({
  args: { invoices: v.array(v.any()) },
  handler: async (ctx, { invoices }) => {
    const results = { successCount: 0, failedCount: 0, errors: [], inserted: [] };
    const existing = new Set((await ctx.db.query("invoices").collect()).map((i) => i.id));
    const seen = new Set(); // lowercased ids at earlier indices

    for (let i = 0; i < invoices.length; i++) {
      const inv = invoices[i];
      const rowNum = i + 1;
      const rawId = inv.id;
      if (!rawId || !String(rawId).trim()) {
        results.failedCount++;
        results.errors.push({ row: rowNum, id: "N/A", error: "Invoice ID is required" });
        continue;
      }
      const trimmedId = String(rawId).trim();
      const lc = trimmedId.toLowerCase();
      const vendor = inv.vendor;
      if (!vendor || !String(vendor).trim()) {
        results.failedCount++;
        results.errors.push({ row: rowNum, id: rawId, error: "Vendor is required" });
        seen.add(lc);
        continue;
      }
      if (existing.has(trimmedId)) {
        results.failedCount++;
        results.errors.push({ row: rowNum, id: rawId, error: `Invoice ID '${rawId}' already exists in database` });
        seen.add(lc);
        continue;
      }
      if (seen.has(lc)) {
        results.failedCount++;
        results.errors.push({ row: rowNum, id: rawId, error: `Duplicate Invoice ID '${rawId}' in the import batch` });
        seen.add(lc);
        continue;
      }
      const now = nowIso();
      const _id = await ctx.db.insert("invoices", {
        id: trimmedId,
        po_reference: inv.po_reference || "",
        vendor: String(vendor).trim(),
        amount: parseFloat(inv.amount) || 0,
        gst: parseInt(inv.gst) || 0,
        date: inv.date || new Date().toISOString().split("T")[0],
        payment_status: inv.payment_status || "Pending",
        file_name: inv.file_name || "",
        created_at: now,
        updated_at: now,
      });
      results.successCount++;
      results.inserted.push(await ctx.db.get(_id));
      existing.add(trimmedId);
      seen.add(lc);
    }
    return results;
  },
});

export const bulkDelete = mutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const set = new Set(ids);
    const rows = (await ctx.db.query("invoices").collect()).filter((i) => set.has(i.id));
    for (const r of rows) await ctx.db.delete(r._id);
    return { deleted: rows.length };
  },
});

export const bulkSetStatus = mutation({
  args: { ids: v.array(v.string()), status: v.string() },
  handler: async (ctx, { ids, status }) => {
    const set = new Set(ids);
    const rows = (await ctx.db.query("invoices").collect()).filter((i) => set.has(i.id));
    for (const r of rows) await ctx.db.patch(r._id, { payment_status: status, updated_at: nowIso() });
    return { updated: rows.length };
  },
});

// Apply an invoice⇆asset mapping change (replace | add | remove) and report what moved.
export const applyMapping = mutation({
  args: { invoiceId: v.string(), assetIds: v.array(v.any()), mode: v.string() },
  handler: async (ctx, { invoiceId, assetIds, mode }) => {
    const invoice = await findInvoice(ctx, invoiceId);
    if (!invoice) throw cerr(404, `Invoice '${invoiceId}' not found`);

    const ids = normIds(assetIds);
    const allAssets = await ctx.db.query("assets").collect();
    const byId = new Map(allAssets.map((a) => [a.id, a]));
    const now = nowIso();

    let stolenFrom = [];
    if (ids.length > 0) {
      const unknown = ids.filter((id) => !byId.has(id));
      if (unknown.length > 0) throw cerr(400, `Unknown asset ID(s): ${unknown.join(", ")}`);
      if (mode !== "remove") {
        stolenFrom = ids
          .map((id) => byId.get(id))
          .filter((a) => a.invoice_id && a.invoice_id !== invoiceId)
          .map((a) => ({ assetId: a.id, previousInvoiceId: a.invoice_id }));
      }
    }

    const setInvoice = async (a, val) => {
      if ((a.invoice_id ?? null) !== (val ?? null)) await ctx.db.patch(a._id, { invoice_id: val, updated_at: now });
    };

    if (mode === "replace") {
      const idSet = new Set(ids);
      if (ids.length > 0) {
        for (const a of allAssets) if (a.invoice_id === invoiceId && !idSet.has(a.id)) await setInvoice(a, null);
        for (const id of ids) await setInvoice(byId.get(id), invoiceId);
      } else {
        for (const a of allAssets) if (a.invoice_id === invoiceId) await setInvoice(a, null);
      }
    } else if (mode === "add") {
      for (const id of ids) await setInvoice(byId.get(id), invoiceId);
    } else if (mode === "remove") {
      const idSet = new Set(ids);
      for (const a of allAssets) if (a.invoice_id === invoiceId && idSet.has(a.id)) await setInvoice(a, null);
    }

    const assets = await invoiceAssets(ctx, invoiceId);
    return { invoiceId, assets, assetIds: assets.map((a) => a.id), relinked: stolenFrom };
  },
});
