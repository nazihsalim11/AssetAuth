/**
 * The one place a purchase order is written.
 *
 * Extracted out of the PATCH route so that route and the Requests approval engine share a
 * single code path. If an approved PO Edit Request applied changes with its own copy of this
 * logic, the two would drift — and the copy that recomputes totals wrongly is the one that
 * writes the figures onto an already-issued order.
 *
 * Everything derived stays derived here: totals and amount-in-words are recomputed from the
 * line items on every write, so neither a stale client payload nor an old request's stored
 * proposal can produce an order whose figures disagree with its own math.
 */

const { cq, cm } = require('../../convexApi');
const { amountInWords, computeTotals } = require('../../poFormat');

const PO_STATUSES = ['Draft', 'Issued', 'Partially Received', 'Received', 'Cancelled'];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'];
const DISCOUNT_TYPES = ['amount', 'percent'];

// A PO past Draft has been issued to a vendor: the numbers on it are a commitment someone
// outside the company is holding us to. Those are the orders whose edits must go through an
// approval request rather than a direct write. `Cancelled` is dead, not editable at all.
const LOCKED_PO_STATUSES = ['Issued', 'Partially Received', 'Received', 'Cancelled'];

const isLocked = (status) => LOCKED_PO_STATUSES.includes(status);

const num = (v) => (v === null || v === undefined ? 0 : parseFloat(v));

// computeTotals emits camelCase lines; the Convex item rows are snake_case.
const linesToItems = (lines) => lines.map((l) => ({
  line_no: l.lineNo, description: l.description, hsn_code: l.hsnCode || null,
  quantity: l.quantity, unit: l.unit, unit_price: l.unitPrice,
  tax_percent: l.taxPercent, line_total: l.lineTotal
}));

// Stored snake_case item rows -> the camelCase shape computeTotals expects, so a status-only
// edit that omits `items` still recomputes from the order's real lines.
const itemsToLines = (rows) => rows.map((r) => ({
  description: r.description, hsnCode: r.hsn_code, quantity: num(r.quantity),
  unit: r.unit, unitPrice: num(r.unit_price), taxPercent: num(r.tax_percent)
}));

const err = (message, statusCode) => Object.assign(new Error(message), { statusCode });

/** Resolve the vendor snapshot + sensible defaults for a create/update. */
async function resolveVendorSnapshot(body) {
  let snapshot = {
    vendor: (body.vendor || '').trim(),
    vendorId: body.vendorId || null,
    vendorAddress: body.vendorAddress || null,
    vendorGst: body.vendorGst || null,
    vendorContactPerson: body.vendorContactPerson || null,
    vendorEmail: body.vendorEmail || null,
    vendorPhone: body.vendorPhone || null,
    defaultPaymentTerms: null,
    defaultCurrency: null
  };
  if (body.vendorId) {
    const v = await cq('purchaseOrders:vendorGet', { id: Number(body.vendorId) });
    if (!v) throw err('Selected vendor no longer exists', 400);
    snapshot = {
      vendor: snapshot.vendor || v.name,
      vendorId: v.id,
      vendorAddress: body.vendorAddress ?? v.address,
      vendorGst: body.vendorGst ?? v.gst_vat,
      vendorContactPerson: body.vendorContactPerson ?? v.contact_person,
      vendorEmail: body.vendorEmail ?? v.email,
      vendorPhone: body.vendorPhone ?? v.phone,
      defaultPaymentTerms: v.default_payment_terms,
      defaultCurrency: v.default_currency
    };
  }
  return snapshot;
}

function validateHeader(body, { isCreate }) {
  if (isCreate && !body.issueDate) return 'PO Date is required';
  if (isCreate && !body.vendorId && !(body.vendor && String(body.vendor).trim())) {
    return 'A vendor is required — pick one from the vendor master or type a name';
  }
  if (body.status && !PO_STATUSES.includes(body.status)) return `Status must be one of: ${PO_STATUSES.join(', ')}`;
  if (body.currency && !CURRENCIES.includes(body.currency)) return `Currency must be one of: ${CURRENCIES.join(', ')}`;
  if (body.discountType && !DISCOUNT_TYPES.includes(body.discountType)) return 'Discount type must be amount or percent';
  return null;
}

/**
 * Apply a set of changes to a purchase order and return the fresh { po, items, documents,
 * attachments }. Throws with .statusCode for 400/404 conditions.
 *
 * `skipLockCheck` is how an approved request writes to an issued order: the lock exists to
 * force the edit through approval, and this *is* the far side of that approval. Callers on
 * the direct-edit path must never pass it.
 */
async function updatePurchaseOrder(id, body, actor, { skipLockCheck = false } = {}) {
  const problem = validateHeader(body, { isCreate: false });
  if (problem) throw err(problem, 400);

  const existing = await cq('purchaseOrders:poGet', { id });
  if (!existing) throw err('Purchase order not found', 404);
  const po = existing.po;

  if (!skipLockCheck && isLocked(po.status)) {
    throw err(
      `Purchase order ${po.po_number} is ${po.status} and cannot be edited directly. ` +
      `Raise a Purchase Order Edit Request — the changes apply once approved.`,
      409
    );
  }

  // Re-snapshot the vendor only when the caller changed the vendor link.
  let vendorSnap = null;
  if (body.vendorId !== undefined || body.vendor !== undefined) {
    vendorSnap = await resolveVendorSnapshot(body);
  }

  const currency = body.currency || po.currency;
  // Items may be omitted on a status-only edit; fall back to the stored lines.
  const items = body.items !== undefined ? body.items : itemsToLines(existing.items);
  const totals = computeTotals(items, {
    discountType: body.discountType !== undefined ? body.discountType : po.discount_type,
    discountValue: body.discountValue !== undefined ? body.discountValue : po.discount_value
  });
  const words = amountInWords(totals.grandTotal, currency);

  const patch = {
    vendor: vendorSnap ? vendorSnap.vendor : undefined,
    vendor_id: vendorSnap ? vendorSnap.vendorId : undefined,
    vendor_address: vendorSnap ? vendorSnap.vendorAddress : undefined,
    vendor_gst: vendorSnap ? vendorSnap.vendorGst : undefined,
    vendor_contact_person: vendorSnap ? vendorSnap.vendorContactPerson : undefined,
    vendor_email: vendorSnap ? vendorSnap.vendorEmail : undefined,
    vendor_phone: vendorSnap ? vendorSnap.vendorPhone : undefined,
    issue_date: body.issueDate,
    expected_delivery_date: body.expectedDeliveryDate === '' ? null : body.expectedDeliveryDate,
    status: body.status,
    currency: body.currency,
    quotation_ref: body.quotationRef,
    delivery_schedule: body.deliverySchedule,
    payment_terms: body.paymentTerms,
    contact_person: body.contactPerson,
    delivery_location: body.deliveryLocation,
    notes: body.notes,
    invoice_id: body.invoiceId === '' ? null : body.invoiceId,
    amc_id: body.amcId === '' ? null : body.amcId,
    // Always refreshed from the recomputed totals.
    subtotal: totals.subtotal, tax_total: totals.taxTotal, discount_type: totals.discountType,
    discount_value: totals.discountValue, discount_amount: totals.discountAmount,
    amount: totals.grandTotal, amount_in_words: words
  };

  return cm('purchaseOrders:poUpdate', {
    id, patch,
    items: body.items !== undefined ? linesToItems(totals.lines) : undefined,
    attachments: body.attachments,
    actor
  });
}

module.exports = {
  updatePurchaseOrder, resolveVendorSnapshot, validateHeader, linesToItems, itemsToLines,
  isLocked, LOCKED_PO_STATUSES, PO_STATUSES, CURRENCIES, DISCOUNT_TYPES
};
