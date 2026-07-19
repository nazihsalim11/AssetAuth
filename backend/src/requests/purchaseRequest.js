/**
 * Purchase Request — the *data* rules for one request type.
 *
 * Deliberately contains no approval logic, no status machine, no audit writing and no
 * notification code: all of that is the shared Request Engine's, and a purchase request goes
 * through exactly the same engine as every other request type. What lives here is only the
 * shape of a purchase request's payload — its line items, its vendor quotations, the totals
 * the server (never the client) computes, and the translation of an approved request into a
 * purchase order.
 *
 * The engine reaches this file through the registry's generic hooks (normalize / validate /
 * describe / matchContext / displayStatus). A future request type with its own payload plugs
 * in the same way, without either file knowing about the other.
 */

const { cq } = require('../../convexApi');
const { UNITS } = require('../services/poUpdate');

const err = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const trim = (v) => (v === null || v === undefined ? '' : String(v).trim());

/* ------------------------------------------------------------------ shaping */

/**
 * Normalise a submitted payload into what will actually be stored.
 *
 * Every derived figure is recomputed here rather than read off the request body. A client
 * that posts `estimatedTotal: 1` against ten thousand rupees of line items must not be able
 * to route its request past a cost-banded approval rule — so the number the rules match on
 * is one the server produced.
 */
function normalizeItem(raw = {}) {
  const quantity = num(raw.quantity);
  const unitCost = num(raw.estimatedUnitCost);
  return {
    description: trim(raw.description),
    category: trim(raw.category) || null,
    quantity,
    unit: trim(raw.unit) || null,
    estimatedUnitCost: round2(unitCost),
    estimatedTotalCost: round2(quantity * unitCost),
    justification: trim(raw.justification) || null,
    notes: trim(raw.notes) || null,
  };
}

function normalizeQuotation(raw = {}) {
  return {
    vendorId: raw.vendorId === null || raw.vendorId === undefined || raw.vendorId === ''
      ? null
      : Number(raw.vendorId),
    vendorName: trim(raw.vendorName) || null,
    quotationNumber: trim(raw.quotationNumber) || null,
    quotationDate: trim(raw.quotationDate) || null,
    amount: round2(num(raw.amount)),
    // The browser uploads to the private bucket first and records the returned path, the same
    // two-step every other attachment in the system uses.
    filePath: trim(raw.filePath) || null,
    fileName: trim(raw.fileName) || null,
  };
}

async function normalize(payload = {}) {
  const items = (Array.isArray(payload.items) ? payload.items : []).map(normalizeItem);
  const quotations = (Array.isArray(payload.quotations) ? payload.quotations : []).map(normalizeQuotation);

  // Snapshot the vendor names off the master so a reviewer, and the audit line, still read
  // the right vendor after someone renames it.
  for (const q of quotations) {
    if (!q.vendorId) continue;
    const vendor = await cq('purchaseOrders:vendorGet', { id: q.vendorId });
    if (vendor) q.vendorName = vendor.name;
  }

  const preferredVendorId = payload.preferredVendorId ? Number(payload.preferredVendorId) : null;
  const preferred = quotations.find((q) => q.vendorId === preferredVendorId);

  return {
    ...payload,
    department: trim(payload.department) || null,
    requiredByDate: trim(payload.requiredByDate) || null,
    currency: trim(payload.currency) || 'INR',
    items,
    quotations,
    preferredVendorId,
    preferredVendorName: preferred?.vendorName
      || (preferredVendorId ? (await cq('purchaseOrders:vendorGet', { id: preferredVendorId }))?.name ?? null : null),
    estimatedTotal: round2(items.reduce((sum, i) => sum + i.estimatedTotalCost, 0)),
  };
}

/* --------------------------------------------------------------- validation */

/**
 * Reject a proposal the approvers should never have to look at.
 *
 * The department check is the RBAC boundary that matters for this type: a requester raises
 * for their own department unless their role manages the module, so an IT user cannot quietly
 * spend against the HR budget. The route passes `canManage`.
 */
async function validate(payload, user, { canManage = false } = {}) {
  if (!payload.department) throw err('A department is required');

  const departments = await cq('masters:list', { table: 'departments' });
  const department = departments.find(
    (d) => String(d.name).toLowerCase() === String(payload.department).toLowerCase()
  );
  if (!department) {
    throw err(`"${payload.department}" is not a department in the Department Master`);
  }
  if (department.is_active === false) {
    throw err(`${department.name} is archived and cannot raise purchase requests`);
  }
  if (!canManage && user.department && String(user.department).toLowerCase() !== String(department.name).toLowerCase()) {
    throw err(`You can only raise purchase requests for ${user.department}`, 403);
  }

  if (!payload.items.length) throw err('A purchase request needs at least one line item');

  payload.items.forEach((item, index) => {
    const where = `Line ${index + 1}`;
    if (!item.description) throw err(`${where}: an item description is required`);
    if (!(item.quantity > 0)) throw err(`${where}: quantity must be greater than zero`);
    if (!item.unit) throw err(`${where}: a unit of measure is required`);
    if (!UNITS.includes(item.unit)) throw err(`${where}: unit must be one of ${UNITS.join(', ')}`);
    if (item.estimatedUnitCost < 0) throw err(`${where}: estimated unit cost cannot be negative`);
    if (!item.justification) throw err(`${where}: a justification is required`);
  });

  for (const [index, q] of payload.quotations.entries()) {
    const where = `Quotation ${index + 1}`;
    if (!q.vendorId) throw err(`${where}: pick a vendor from the Vendor Master`);
    const vendor = await cq('purchaseOrders:vendorGet', { id: q.vendorId });
    if (!vendor) throw err(`${where}: that vendor no longer exists`);
    if (q.amount < 0) throw err(`${where}: the quoted amount cannot be negative`);
  }

  if (payload.preferredVendorId) {
    const vendor = await cq('purchaseOrders:vendorGet', { id: payload.preferredVendorId });
    if (!vendor) throw err('The preferred vendor no longer exists');
    // A preferred vendor with no quotation behind it is an approval nobody can check.
    if (payload.quotations.length
      && !payload.quotations.some((q) => q.vendorId === payload.preferredVendorId)) {
      throw err('The preferred vendor must be one of the vendors that quoted');
    }
  }
}

/* -------------------------------------------------------------- description */

const describe = (payload = {}) => {
  const items = payload.items || [];
  const first = items[0]?.description || 'purchase';
  const more = items.length > 1 ? ` +${items.length - 1} more` : '';
  return `${payload.department || 'Unassigned'} — ${first}${more}`;
};

/** The facts the (generic) approval-rule engine matches a rule against. */
const matchContext = (payload = {}, user) => ({
  department: payload.department || user?.department || null,
  amount: payload.estimatedTotal ?? 0,
  categories: [...new Set((payload.items || []).map((i) => i.category).filter(Boolean))],
});

/**
 * A purchase request's own vocabulary over the engine's status. The engine only knows
 * Draft/Pending Approval/Under Review/Approved/Rejected/Cancelled/Completed; a purchase
 * request additionally reports whether it became a purchase order, and whether it is closed.
 */
const displayStatus = (row) => {
  if (row.closed_at) return 'Closed';
  if (row.converted_po_id) return 'Converted to Purchase Order';
  if (row.status === 'Completed') return 'Approved';
  return row.status;
};

/**
 * Build the purchase-order body an approved request converts into.
 *
 * Only the preferred vendor's quotation is carried across as the price basis; the line items
 * keep their estimated unit costs, which is what was approved. `overrides` lets the person
 * doing the conversion correct the delivery details the request never captured, but not the
 * items — changing those would mean issuing an order nobody approved.
 */
function toPurchaseOrderBody(payload, overrides = {}) {
  const quotation = (payload.quotations || []).find((q) => q.vendorId === payload.preferredVendorId);
  return {
    vendorId: payload.preferredVendorId,
    issueDate: overrides.issueDate || new Date().toISOString().split('T')[0],
    expectedDeliveryDate: overrides.expectedDeliveryDate || payload.requiredByDate || null,
    status: 'Draft',
    currency: payload.currency || 'INR',
    quotationRef: quotation?.quotationNumber || null,
    deliveryLocation: overrides.deliveryLocation || null,
    contactPerson: overrides.contactPerson || null,
    paymentTerms: overrides.paymentTerms || null,
    notes: overrides.notes || null,
    items: (payload.items || []).map((i) => ({
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      unitPrice: i.estimatedUnitCost,
      taxPercent: 0,
    })),
  };
}

module.exports = {
  normalize, validate, describe, matchContext, displayStatus, toPurchaseOrderBody,
  normalizeItem, normalizeQuotation,
};
