/**
 * Request-type registry — the single declarative description of every approval workflow.
 *
 * This is the file that makes the Requests module generic. The engine, the routes, the diff,
 * the notifications and the UI all read the vocabulary from here; none of them contains a
 * branch on "is this a purchase order?". Adding a new request type is one entry below — no
 * new table, no new endpoint, no new approval logic.
 *
 * A descriptor:
 *   key            stable request_type stored on the row, e.g. 'po.edit'
 *   label          display name ("Purchase Order Edit Request")
 *   module         permission-matrix module key of the *target* record. Creating a request
 *                  requires `requests.create` AND view on this module — a request must never
 *                  become a side door into a record its raiser cannot otherwise see.
 *   table          Convex table holding the target record
 *   idField        field identifying the record within that table
 *   idType         'number' | 'string' — how to coerce the record id off the wire
 *   labelField     field used to name the record in lists, notifications and audit lines
 *   kind           'edit' (proposes field changes) | 'action' (proposes a state change)
 *   fields         camelKey -> { label, column, type } — the whitelist of proposable fields.
 *                  `column` is the snake_case Convex field the default applier writes.
 *   load           optional (id) => camelCase record, when the table's shape needs mapping
 *   apply          optional async (record, changes, ctx) => void, when the write is not a
 *                  plain column patch (recomputed totals, cascading updates, …)
 *   levels         default number of approval levels
 *   fixedChanges   for 'action' types: changes the type always applies, on top of proposed
 *
 * `type` drives the diff's comparison rules only (see requests/diff.js), not validation of
 * the value — the target module's own writer stays the authority on what it will accept.
 */

const { cq } = require('../../convexApi');
const poUpdate = require('../services/poUpdate');

const f = (label, column, type = 'string') => ({ label, column, type });

/** Default record loader: read the row and expose it under the descriptor's camel keys. */
async function loadByColumns(descriptor, id) {
  const row = await cq('generic:get', {
    table: descriptor.table,
    idField: descriptor.idField,
    idVal: coerceId(descriptor, id),
  });
  if (!row) return null;
  const out = { __raw: row };
  for (const [key, spec] of Object.entries(descriptor.fields)) {
    out[key] = row[spec.column] ?? null;
  }
  out.__label = row[descriptor.labelField] ?? String(id);
  return out;
}

function coerceId(descriptor, id) {
  return descriptor.idType === 'number' ? Number(id) : String(id);
}

/* ------------------------------------------------------------- descriptors */

const TYPES = {
  'po.edit': {
    key: 'po.edit',
    label: 'Purchase Order Edit Request',
    module: 'finance',
    table: 'purchase_orders',
    idField: 'id',
    idType: 'number',
    labelField: 'po_number',
    kind: 'edit',
    levels: 1,
    fields: {
      vendorId: f('Vendor', 'vendor_id', 'number'),
      issueDate: f('PO Date', 'issue_date', 'date'),
      expectedDeliveryDate: f('Expected Delivery', 'expected_delivery_date', 'date'),
      status: f('Status', 'status'),
      currency: f('Currency', 'currency'),
      quotationRef: f('Quotation Ref', 'quotation_ref'),
      deliverySchedule: f('Delivery Schedule', 'delivery_schedule'),
      paymentTerms: f('Payment Terms', 'payment_terms'),
      contactPerson: f('Contact Person', 'contact_person'),
      deliveryLocation: f('Delivery Location', 'delivery_location'),
      discountType: f('Discount Type', 'discount_type'),
      discountValue: f('Discount Value', 'discount_value', 'number'),
      notes: f('Notes', 'notes'),
      items: f('Line Items', 'items', 'json'),
    },
    // A PO is not a bag of columns: totals, tax and amount-in-words are derived from the
    // line items, and the vendor block is a snapshot. Approval therefore replays the change
    // through the same writer the direct-edit route uses, rather than patching columns.
    apply: async (record, changes, { actor }) => {
      const body = {};
      for (const change of changes) body[change.field] = change.after;
      await poUpdate.updatePurchaseOrder(Number(record.__id), body, actor, { skipLockCheck: true });
    },
  },

  'invoice.edit': {
    key: 'invoice.edit',
    label: 'Invoice Edit Request',
    module: 'finance',
    table: 'invoices',
    idField: 'id',
    idType: 'string',
    labelField: 'id',
    kind: 'edit',
    levels: 1,
    fields: {
      poReference: f('PO Reference', 'po_reference'),
      vendorId: f('Vendor', 'vendor_id', 'number'),
      amount: f('Amount', 'amount', 'number'),
      gst: f('GST', 'gst', 'number'),
      date: f('Invoice Date', 'date', 'date'),
      paymentStatus: f('Payment Status', 'payment_status'),
    },
  },

  'amc.edit': {
    key: 'amc.edit',
    label: 'AMC Edit Request',
    module: 'amc',
    table: 'amcs',
    idField: 'id',
    idType: 'string',
    labelField: 'id',
    kind: 'edit',
    levels: 1,
    fields: {
      vendorId: f('Vendor', 'vendor_id', 'number'),
      poNumber: f('PO Number', 'po_number'),
      cost: f('Cost', 'cost', 'number'),
      startDate: f('Start Date', 'start_date', 'date'),
      endDate: f('End Date', 'end_date', 'date'),
      serviceSchedule: f('Service Schedule', 'service_schedule'),
    },
  },

  'asset.edit': {
    key: 'asset.edit',
    label: 'Asset Edit Request',
    module: 'assets',
    table: 'assets',
    idField: 'id',
    idType: 'string',
    labelField: 'name',
    kind: 'edit',
    levels: 1,
    fields: {
      name: f('Name', 'name'),
      serialNumber: f('Serial Number', 'serial_number'),
      category: f('Category', 'category'),
      type: f('Type', 'type'),
      status: f('Status', 'status'),
      cost: f('Cost', 'cost', 'number'),
      purchaseDate: f('Purchase Date', 'purchase_date', 'date'),
      warrantyExpiry: f('Warranty Expiry', 'warranty_expiry', 'date'),
      department: f('Department', 'department'),
      location: f('Location', 'location'),
      notes: f('Notes', 'notes'),
    },
  },

  'asset.disposal': {
    key: 'asset.disposal',
    label: 'Asset Disposal Request',
    module: 'assets',
    table: 'assets',
    idField: 'id',
    idType: 'string',
    labelField: 'name',
    kind: 'action',
    levels: 2,
    fields: {
      disposalDate: f('Disposal Date', 'disposal_date', 'date'),
      disposalReason: f('Disposal Reason', 'disposal_reason'),
    },
    // Disposal is the point of the request; the requester proposes when and why, never
    // whether the status flips. That is the approval's to grant.
    fixedChanges: { status: 'Disposed' },
    fixedFields: { status: f('Status', 'status') },
  },

  'asset.transfer': {
    key: 'asset.transfer',
    label: 'Asset Transfer Request',
    module: 'assets',
    table: 'assets',
    idField: 'id',
    idType: 'string',
    labelField: 'name',
    kind: 'action',
    levels: 1,
    fields: {
      department: f('Department', 'department'),
      associateDepartment: f('Associate Department', 'associate_department'),
      location: f('Location', 'location'),
      assignedEmployee: f('Assigned To', 'assigned_employee'),
    },
  },

  'asset.return': {
    key: 'asset.return',
    label: 'Asset Return Request',
    module: 'assets',
    table: 'assets',
    idField: 'id',
    idType: 'string',
    labelField: 'name',
    kind: 'action',
    levels: 1,
    fields: {
      location: f('Return To Location', 'location'),
      notes: f('Condition Notes', 'notes'),
    },
    // Returning an asset puts it back in inventory and clears the custodian.
    fixedChanges: { status: 'Available', assignedEmployee: null },
    fixedFields: {
      status: f('Status', 'status'),
      assignedEmployee: f('Assigned To', 'assigned_employee'),
    },
  },

  'employee.update': {
    key: 'employee.update',
    label: 'Employee Update Request',
    module: 'userDirectory',
    table: 'users',
    idField: 'employee_id',
    idType: 'string',
    labelField: 'name',
    kind: 'edit',
    levels: 1,
    fields: {
      name: f('Name', 'name'),
      email: f('Email', 'email'),
      phone: f('Phone', 'phone'),
      department: f('Department', 'department'),
      designation: f('Designation', 'designation'),
      location: f('Location', 'location'),
    },
  },

  'vendor.update': {
    key: 'vendor.update',
    label: 'Vendor Update Request',
    module: 'vendors',
    table: 'vendors',
    idField: 'id',
    idType: 'number',
    labelField: 'name',
    kind: 'edit',
    levels: 1,
    fields: {
      name: f('Name', 'name'),
      address: f('Address', 'address'),
      gstVat: f('GST / VAT', 'gst_vat'),
      gstNumber: f('GST Number', 'gst_number'),
      panNumber: f('PAN Number', 'pan_number'),
      contactPerson: f('Contact Person', 'contact_person'),
      email: f('Email', 'email'),
      phone: f('Phone', 'phone'),
      bankName: f('Bank Name', 'bank_name'),
      bankAccountNumber: f('Bank Account Number', 'bank_account_number'),
      bankIfscSwift: f('IFSC / SWIFT', 'bank_ifsc_swift'),
      bankAccountHolder: f('Account Holder Name', 'bank_account_holder'),
      defaultPaymentTerms: f('Payment Terms', 'default_payment_terms'),
      defaultCurrency: f('Currency', 'default_currency'),
      isActive: f('Active', 'is_active', 'boolean'),
    },
  },

  'department.update': {
    key: 'department.update',
    label: 'Department Update Request',
    module: 'departments',
    table: 'departments',
    idField: 'id',
    idType: 'number',
    labelField: 'name',
    kind: 'edit',
    levels: 1,
    fields: {
      name: f('Name', 'name'),
      description: f('Description', 'description'),
      isActive: f('Active', 'is_active', 'boolean'),
    },
  },

  'location.update': {
    key: 'location.update',
    label: 'Location Update Request',
    module: 'branches',
    table: 'locations',
    idField: 'id',
    idType: 'number',
    labelField: 'name',
    kind: 'edit',
    levels: 1,
    fields: {
      name: f('Name', 'name'),
      address: f('Address', 'address'),
      isActive: f('Active', 'is_active', 'boolean'),
    },
  },

  'category.update': {
    key: 'category.update',
    label: 'Category Update Request',
    module: 'categories',
    table: 'asset_subtypes',
    idField: 'id',
    idType: 'number',
    labelField: 'name',
    kind: 'edit',
    levels: 1,
    fields: {
      name: f('Name', 'name'),
      category: f('Parent Category', 'category'),
      isActive: f('Active', 'is_active', 'boolean'),
    },
  },
};

/* ----------------------------------------------------------------- helpers */

function descriptorFor(requestType) {
  const d = TYPES[requestType];
  if (!d) {
    const err = new Error(
      `Unknown request type "${requestType}". Known: ${Object.keys(TYPES).join(', ')}.`
    );
    err.statusCode = 400;
    throw err;
  }
  return d;
}

/** Every field a request of this type may carry — proposable plus type-fixed. */
const allFields = (descriptor) => ({ ...descriptor.fields, ...(descriptor.fixedFields || {}) });

/** Load the target record's current values, keyed by the descriptor's camel field names. */
async function loadRecord(requestType, recordId) {
  const descriptor = descriptorFor(requestType);
  const record = descriptor.load
    ? await descriptor.load(recordId)
    : await loadByColumns({ ...descriptor, fields: allFields(descriptor) }, recordId);
  if (!record) return null;
  record.__id = recordId;
  return record;
}

/**
 * Write an approved diff onto the target record. Uses the descriptor's own applier when the
 * write is more than a column patch (see po.edit), otherwise patches the mapped columns.
 */
async function applyChanges(requestType, record, changes, ctx) {
  const descriptor = descriptorFor(requestType);
  if (descriptor.apply) return descriptor.apply(record, changes, ctx);

  const { toColumnPatch } = require('./diff');
  const patch = toColumnPatch(changes, allFields(descriptor));
  if (Object.keys(patch).length === 0) return;

  const { cm } = require('../../convexApi');
  await cm('generic:update', {
    table: descriptor.table,
    idField: descriptor.idField,
    idVal: coerceId(descriptor, record.__id),
    patch: { ...patch, updated_at: new Date().toISOString() },
  });
}

/** The vocabulary the frontend renders its type picker and forms from. */
const catalog = () =>
  Object.values(TYPES).map((d) => ({
    key: d.key,
    label: d.label,
    module: d.module,
    kind: d.kind,
    levels: d.levels,
    fields: Object.entries(d.fields).map(([key, spec]) => ({
      key,
      label: spec.label,
      type: spec.type,
    })),
  }));

module.exports = { TYPES, descriptorFor, loadRecord, applyChanges, allFields, coerceId, catalog };
