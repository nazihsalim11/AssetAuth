import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

// Native Convex data layer for procurement: vendors, PO settings + terms, and purchase
// orders with their items / documents / attachments. Documents keep the mirrored
// snake_case shape. Totals (poFormat) and the vendor snapshot are computed in Node; the
// atomic bits — sequential PO number allocation, multi-table PO writes, versioned terms /
// documents, unique vendor names — live here as serializable mutations.
//
// SERIAL ids are derived as max(id)+1. Callers pass integer ids (Number-coerced in Node).

const nowIso = () => new Date().toISOString();
const lc = (s) => String(s ?? "").toLowerCase();
const strip = (d) => { if (!d) return d; const { _id, _creationTime, ...rest } = d; return rest; };
const stripAll = (rows) => rows.map(strip);
const nextId = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
const byId = (ctx, table, id) => ctx.db.query(table).filter((q) => q.eq(q.field("id"), id)).first();

/* ------------------------------------------------------------------ PO number */

const DEFAULT_SETTINGS = {
  id: 1, number_format: "PO/{YYYY}/{SEQ}", number_prefix: "", number_padding: 0,
  next_sequence: 1, reset_sequence_yearly: false, sequence_year: null, default_currency: "INR",
};

function buildPoNumber(settings, seq) {
  const now = new Date();
  const pad = Math.max(0, settings.number_padding || 0);
  const seqStr = String(seq).padStart(pad, "0");
  return String(settings.number_format || "PO/{YYYY}/{SEQ}")
    .replace(/\{PREFIX\}/g, settings.number_prefix || "")
    .replace(/\{YYYY\}/g, String(now.getFullYear()))
    .replace(/\{YY\}/g, String(now.getFullYear()).slice(-2))
    .replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, "0"))
    .replace(/\{SEQ\}/g, seqStr);
}

const seqFor = (settings, year) =>
  settings.reset_sequence_yearly && settings.sequence_year !== year ? 1 : (settings.next_sequence ?? 1);

const previewNextNumber = (settings) => buildPoNumber(settings, seqFor(settings, new Date().getFullYear()));

async function getSettingsRow(ctx) {
  return await ctx.db.query("po_settings").filter((q) => q.eq(q.field("id"), 1)).first();
}

// Consume the next PO number. One serializable mutation, so concurrent creates can never
// be handed the same sequence — the old FOR UPDATE row lock is implicit.
async function allocatePoNumber(ctx) {
  let settings = await getSettingsRow(ctx);
  if (!settings) {
    const _id = await ctx.db.insert("po_settings", { ...DEFAULT_SETTINGS, updated_at: nowIso() });
    settings = await ctx.db.get(_id);
  }
  const year = new Date().getFullYear();
  const seq = seqFor(settings, year);
  const poNumber = buildPoNumber(settings, seq);
  await ctx.db.patch(settings._id, { next_sequence: seq + 1, sequence_year: year, updated_at: nowIso() });
  return poNumber;
}

/* ------------------------------------------------------------------ vendors */

export const vendorList = query({
  args: { q: v.optional(v.string()), includeInactive: v.optional(v.boolean()) },
  handler: async (ctx, { q, includeInactive }) => {
    let rows = await ctx.db.query("vendors").collect();
    if (!includeInactive) rows = rows.filter((r) => r.is_active === true);
    if (q && q.trim()) {
      const n = lc(q.trim());
      rows = rows.filter((r) => lc(r.name).includes(n) || lc(r.contact_person).includes(n) || lc(r.email).includes(n));
    }
    rows.sort((a, b) => lc(a.name).localeCompare(lc(b.name)));
    return stripAll(rows.slice(0, 500));
  },
});

export const vendorGet = query({
  args: { id: v.any() },
  handler: async (ctx, { id }) => strip(await byId(ctx, "vendors", id)),
});

export const vendorCreate = mutation({
  args: { doc: v.any() },
  handler: async (ctx, { doc }) => {
    const all = await ctx.db.query("vendors").collect();
    if (all.some((x) => lc(x.name) === lc(doc.name))) {
      throw new ConvexError(`Vendor "${doc.name}" already exists.`);
    }
    const now = nowIso();
    const _id = await ctx.db.insert("vendors", {
      id: nextId(all), is_active: true, default_currency: "INR",
      created_at: now, updated_at: now, ...doc,
    });
    return strip(await ctx.db.get(_id));
  },
});

export const vendorUpdate = mutation({
  args: { id: v.any(), patch: v.any() },
  handler: async (ctx, { id, patch }) => {
    const row = await byId(ctx, "vendors", id);
    if (!row) return null;
    if (patch.name != null && lc(patch.name) !== lc(row.name)) {
      const all = await ctx.db.query("vendors").collect();
      if (all.some((x) => x._id !== row._id && lc(x.name) === lc(patch.name))) {
        throw new ConvexError(`Vendor "${patch.name}" already exists.`);
      }
    }
    const clean = {};
    for (const [k, val] of Object.entries(patch)) if (val !== undefined) clean[k] = val;
    await ctx.db.patch(row._id, { ...clean, updated_at: nowIso() });
    return strip(await ctx.db.get(row._id));
  },
});

export const vendorRemove = mutation({
  args: { id: v.any() },
  handler: async (ctx, { id }) => {
    const row = await byId(ctx, "vendors", id);
    if (!row) return null;
    // ON DELETE SET NULL across every table that FKs vendors(id); the snapshot columns on
    // POs/invoices/AMCs keep the vendor *name* for history.
    for (const table of ["purchase_orders", "invoices", "amcs", "assets"]) {
      const refs = await ctx.db.query(table).filter((q) => q.eq(q.field("vendor_id"), row.id)).collect();
      for (const r of refs) await ctx.db.patch(r._id, { vendor_id: null });
    }
    // Documents belong to the vendor, not to history — unlike the snapshot columns above,
    // nothing else references them, so they go with it rather than dangling.
    const docs = await ctx.db.query("vendor_documents").filter((q) => q.eq(q.field("vendor_id"), row.id)).collect();
    for (const d of docs) await ctx.db.delete(d._id);

    const name = row.name;
    await ctx.db.delete(row._id);
    return { name };
  },
});

/* -------------------------------------------------------- vendor documents */

// Compliance and contract paperwork: many files per vendor, each tagged with a doc_type
// (GST Certificate, PAN, Cancelled Cheque, …). Only metadata lives here — the bytes are in
// the storage bucket, reached via a signed URL like every other attachment in the system.

export const vendorDocumentsList = query({
  args: { vendorId: v.any() },
  handler: async (ctx, { vendorId }) => {
    const rows = await ctx.db
      .query("vendor_documents")
      .filter((q) => q.eq(q.field("vendor_id"), vendorId))
      .collect();
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return stripAll(rows);
  },
});

export const vendorDocumentAdd = mutation({
  args: { vendorId: v.any(), doc: v.any() },
  handler: async (ctx, { vendorId, doc }) => {
    const vendor = await byId(ctx, "vendors", vendorId);
    if (!vendor) throw new ConvexError("Vendor not found.");
    const all = await ctx.db.query("vendor_documents").collect();
    const _id = await ctx.db.insert("vendor_documents", {
      id: nextId(all),
      vendor_id: vendorId,
      doc_type: doc.docType ?? "Other",
      file_name: doc.fileName ?? "document",
      file_path: doc.filePath,
      file_type: doc.fileType ?? null,
      file_size: doc.fileSize ?? null,
      notes: doc.notes ?? null,
      uploaded_by: doc.uploadedBy ?? null,
      created_at: nowIso(),
    });
    return strip(await ctx.db.get(_id));
  },
});

// Replace keeps the row (and its doc_type slot) and swaps the file underneath, so
// "renewed GST certificate" stays one document rather than accumulating duplicates.
export const vendorDocumentReplace = mutation({
  args: { id: v.any(), doc: v.any() },
  handler: async (ctx, { id, doc }) => {
    const row = await byId(ctx, "vendor_documents", id);
    if (!row) return null;
    await ctx.db.patch(row._id, {
      file_name: doc.fileName ?? row.file_name,
      file_path: doc.filePath ?? row.file_path,
      file_type: doc.fileType ?? row.file_type,
      file_size: doc.fileSize ?? row.file_size,
      doc_type: doc.docType ?? row.doc_type,
      notes: doc.notes !== undefined ? doc.notes : row.notes,
      uploaded_by: doc.uploadedBy ?? row.uploaded_by,
      updated_at: nowIso(),
    });
    return strip(await ctx.db.get(row._id));
  },
});

export const vendorDocumentRemove = mutation({
  args: { id: v.any() },
  handler: async (ctx, { id }) => {
    const row = await byId(ctx, "vendor_documents", id);
    if (!row) return null;
    await ctx.db.delete(row._id);
    return strip(row);
  },
});

/* ------------------------------------------------------------- PO settings */

export const settingsGet = query({
  args: {},
  handler: async (ctx) => {
    const settings = (await getSettingsRow(ctx)) || DEFAULT_SETTINGS;
    return { settings: strip(settings), nextNumber: previewNextNumber(settings) };
  },
});

export const settingsUpdate = mutation({
  args: { patch: v.any() },
  handler: async (ctx, { patch }) => {
    let settings = await getSettingsRow(ctx);
    if (!settings) {
      const _id = await ctx.db.insert("po_settings", { ...DEFAULT_SETTINGS, updated_at: nowIso() });
      settings = await ctx.db.get(_id);
    }
    const clean = {};
    for (const [k, val] of Object.entries(patch)) if (val !== undefined) clean[k] = val;
    if (Object.keys(clean).length) {
      await ctx.db.patch(settings._id, { ...clean, updated_at: nowIso() });
      settings = await ctx.db.get(settings._id);
    }
    return { settings: strip(settings), nextNumber: previewNextNumber(settings) };
  },
});

/* --------------------------------------------------- master Terms & Conditions */

export const termsList = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("po_terms").collect();
    rows.sort((a, b) => Number(b.version) - Number(a.version));
    return stripAll(rows);
  },
});

export const termsCreate = mutation({
  args: { content: v.string(), updatedBy: v.string() },
  handler: async (ctx, { content, updatedBy }) => {
    const all = await ctx.db.query("po_terms").collect();
    const nextVersion = all.reduce((m, r) => Math.max(m, Number(r.version) || 0), 0) + 1;
    await ctx.db.insert("po_terms", { id: nextId(all), version: nextVersion, content, updated_by: updatedBy, created_at: nowIso() });
    const rows = (await ctx.db.query("po_terms").collect()).sort((a, b) => Number(b.version) - Number(a.version));
    return stripAll(rows);
  },
});

/* ---------------------------------------------------------------- purchase orders */

const SORTABLE = {
  poNumber: "po_number", vendor: "vendor", issueDate: "issue_date",
  expectedDeliveryDate: "expected_delivery_date", status: "status",
  amount: "amount", createdAt: "created_at",
};

function cmpNullsLast(a, b, dir) {
  const an = a === null || a === undefined, bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  const c = typeof a === "number" || typeof b === "number"
    ? Number(a) - Number(b)
    : String(a).localeCompare(String(b));
  return c * dir;
}

export const poList = query({
  args: {
    q: v.optional(v.string()), status: v.optional(v.string()), vendor: v.optional(v.string()),
    sortBy: v.optional(v.string()), sortDir: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let rows = await ctx.db.query("purchase_orders").collect();
    if (args.q && args.q.trim()) {
      const n = lc(args.q.trim());
      rows = rows.filter((po) => lc(po.po_number).includes(n) || lc(po.vendor).includes(n) || lc(po.notes).includes(n));
    }
    if (args.status) rows = rows.filter((po) => po.status === args.status);
    if (args.vendor) rows = rows.filter((po) => po.vendor === args.vendor);

    const column = SORTABLE[args.sortBy] || "created_at";
    const dir = lc(args.sortDir) === "asc" ? 1 : -1;
    rows.sort((a, b) => cmpNullsLast(a[column], b[column], dir));
    rows = rows.slice(0, 500);

    const items = await ctx.db.query("purchase_order_items").collect();
    const docs = await ctx.db.query("purchase_order_documents").collect();
    const itemCount = {}, docCount = {};
    for (const i of items) itemCount[i.purchase_order_id] = (itemCount[i.purchase_order_id] || 0) + 1;
    for (const d of docs) docCount[d.purchase_order_id] = (docCount[d.purchase_order_id] || 0) + 1;
    return rows.map((po) => ({ ...strip(po), item_count: itemCount[po.id] || 0, document_count: docCount[po.id] || 0 }));
  },
});

async function childrenOf(ctx, poId) {
  const items = (await ctx.db.query("purchase_order_items").filter((q) => q.eq(q.field("purchase_order_id"), poId)).collect())
    .sort((a, b) => Number(a.line_no) - Number(b.line_no));
  const documents = (await ctx.db.query("purchase_order_documents").filter((q) => q.eq(q.field("purchase_order_id"), poId)).collect())
    .sort((a, b) => Number(b.version) - Number(a.version));
  const attachments = (await ctx.db.query("purchase_order_attachments").filter((q) => q.eq(q.field("purchase_order_id"), poId)).collect())
    .sort((a, b) => Number(a.id) - Number(b.id));
  return { items: stripAll(items), documents: stripAll(documents), attachments: stripAll(attachments) };
}

export const poGet = query({
  args: { id: v.any() },
  handler: async (ctx, { id }) => {
    const po = await byId(ctx, "purchase_orders", id);
    if (!po) return null;
    return { po: strip(po), ...(await childrenOf(ctx, po.id)) };
  },
});

export const poDocumentsList = query({
  args: { id: v.any() },
  handler: async (ctx, { id }) => {
    const documents = (await ctx.db.query("purchase_order_documents").filter((q) => q.eq(q.field("purchase_order_id"), id)).collect())
      .sort((a, b) => Number(b.version) - Number(a.version));
    return stripAll(documents);
  },
});

async function insertItems(ctx, poId, lines, baseId) {
  let id = baseId;
  for (const l of lines || []) {
    await ctx.db.insert("purchase_order_items", {
      id: id++, purchase_order_id: poId, line_no: l.line_no, description: l.description,
      hsn_code: l.hsn_code ?? null, quantity: l.quantity, unit: l.unit,
      unit_price: l.unit_price, tax_percent: l.tax_percent, line_total: l.line_total,
    });
  }
  return id;
}

async function replaceAttachments(ctx, poId, attachments, actor) {
  const existing = await ctx.db.query("purchase_order_attachments").filter((q) => q.eq(q.field("purchase_order_id"), poId)).collect();
  for (const a of existing) await ctx.db.delete(a._id);
  let id = nextId(await ctx.db.query("purchase_order_attachments").collect());
  for (const att of attachments || []) {
    const filePath = att.fileUrl || att.filePath || att.file_path;
    if (!filePath) continue;
    await ctx.db.insert("purchase_order_attachments", {
      id: id++, purchase_order_id: poId, file_name: att.name || "attachment", file_path: filePath,
      file_type: att.fileType || null, file_size: att.fileSize || null, uploaded_by: actor, created_at: nowIso(),
    });
  }
}

// Create a PO: allocate its number, snapshot the current terms, insert header + items +
// attachments — all in one transaction. Totals/word amounts are computed in Node.
export const poCreate = mutation({
  args: { po: v.any(), items: v.array(v.any()), attachments: v.optional(v.array(v.any())), actor: v.string() },
  handler: async (ctx, { po, items, attachments, actor }) => {
    const poNumber = await allocatePoNumber(ctx);
    const terms = (await ctx.db.query("po_terms").collect()).sort((a, b) => Number(b.version) - Number(a.version))[0] || null;
    const now = nowIso();
    const id = nextId(await ctx.db.query("purchase_orders").collect());

    const _id = await ctx.db.insert("purchase_orders", {
      ...po,
      id,
      po_number: poNumber,
      terms_version: terms ? terms.version : null,
      terms_content: terms ? terms.content : null,
      created_at: now,
      updated_at: now,
    });

    const itemBase = nextId(await ctx.db.query("purchase_order_items").collect());
    await insertItems(ctx, id, items, itemBase);
    if (attachments !== undefined) await replaceAttachments(ctx, id, attachments, actor);

    const saved = await ctx.db.get(_id);
    return { po: strip(saved), ...(await childrenOf(ctx, id)) };
  },
});

export const poUpdate = mutation({
  args: { id: v.any(), patch: v.any(), items: v.optional(v.array(v.any())), attachments: v.optional(v.array(v.any())), actor: v.string() },
  handler: async (ctx, { id, patch, items, attachments, actor }) => {
    const existing = await byId(ctx, "purchase_orders", id);
    if (!existing) return null;

    const clean = {};
    for (const [k, val] of Object.entries(patch)) if (val !== undefined) clean[k] = val;
    await ctx.db.patch(existing._id, { ...clean, updated_at: nowIso() });

    if (items !== undefined) {
      const old = await ctx.db.query("purchase_order_items").filter((q) => q.eq(q.field("purchase_order_id"), existing.id)).collect();
      for (const it of old) await ctx.db.delete(it._id);
      await insertItems(ctx, existing.id, items, nextId(await ctx.db.query("purchase_order_items").collect()));
    }
    if (attachments !== undefined) await replaceAttachments(ctx, existing.id, attachments, actor);

    const saved = await ctx.db.get(existing._id);
    return { po: strip(saved), ...(await childrenOf(ctx, existing.id)) };
  },
});

export const poRemove = mutation({
  args: { id: v.any() },
  handler: async (ctx, { id }) => {
    const po = await byId(ctx, "purchase_orders", id);
    if (!po) return null;
    for (const table of ["purchase_order_items", "purchase_order_documents", "purchase_order_attachments"]) {
      const children = await ctx.db.query(table).filter((q) => q.eq(q.field("purchase_order_id"), po.id)).collect();
      for (const c of children) await ctx.db.delete(c._id);
    }
    const poNumber = po.po_number;
    await ctx.db.delete(po._id);
    return { po_number: poNumber };
  },
});

export const poDocumentAdd = mutation({
  args: { id: v.any(), filePath: v.string(), fileName: v.optional(v.string()), actor: v.string() },
  handler: async (ctx, { id, filePath, fileName, actor }) => {
    const po = await byId(ctx, "purchase_orders", id);
    if (!po) return null;
    const all = await ctx.db.query("purchase_order_documents").collect();
    const forPo = all.filter((d) => d.purchase_order_id === po.id);
    const version = forPo.reduce((m, d) => Math.max(m, Number(d.version) || 0), 0) + 1;
    const _id = await ctx.db.insert("purchase_order_documents", {
      id: nextId(all), purchase_order_id: po.id, version, po_number: po.po_number,
      file_path: filePath, file_name: fileName || `${po.po_number}.pdf`, generated_by: actor, created_at: nowIso(),
    });
    const document = strip(await ctx.db.get(_id));
    const documents = (await ctx.db.query("purchase_order_documents").filter((q) => q.eq(q.field("purchase_order_id"), po.id)).collect())
      .sort((a, b) => Number(b.version) - Number(a.version));
    return { document, documents: stripAll(documents) };
  },
});
