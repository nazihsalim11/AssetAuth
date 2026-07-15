/**
 * Bulk-entity registry — the single declarative description of every entity the shared bulk
 * framework can import/update/delete/export/validate. Adding a new entity to the whole bulk
 * pipeline is one entry here; no new engine code, no new route, no new component.
 *
 * A descriptor:
 *   key          route segment, e.g. 'vendor' -> /api/bulk/vendor/*
 *   label        singular / plural for UI copy
 *   table        Convex table
 *   matchField   Convex field that identifies a row for update & delete (a business key)
 *   idType       'number' | 'string' — how to coerce the match value off the wire
 *   serialId     true when the table uses SERIAL integer PKs (insert assigns id)
 *   permission   permission-matrix module key (verbs: view/create/edit/delete)
 *   masters      master-data sets to load into the validation context (FK checks)
 *   existing     duplicate-detection sets: key -> { table, field } (loaded lazily)
 *   columns      ordered list of { header, key, ...validationRules } — drives the template,
 *                header<->key mapping, and the validation schema all at once
 *   unique       Convex-doc business keys guarded at insert (snake_case fields)
 *   cascade      FK columns to null on delete (ON DELETE SET NULL)
 *   rowRule      optional cross-field validation over a normalised row
 *   sample       one example row (header -> value) for the downloadable template
 *   toDoc        validated row -> Convex insert doc (snake_case)
 *   toPatch      validated row -> Convex update patch (snake_case, no identity/audit fields)
 *   toExport     Convex row -> export object (header -> value)
 */

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'];
const AMC_SCHEDULES = ['Monthly', 'Quarterly', 'Bi-Annual', 'Annual'];

const orNull = (v) => (v === undefined || v === null || v === '' ? null : v);

const VENDOR = {
  key: 'vendor',
  label: 'Vendor',
  labelPlural: 'Vendors',
  table: 'vendors',
  matchField: 'name',
  idType: 'string',
  serialId: true,
  permission: 'vendors',
  masters: [],
  existing: { vendorNames: { table: 'vendors', field: 'name' } },
  columns: [
    { header: 'Vendor Name', key: 'name', type: 'string', required: true, unique: true, existing: 'vendorNames' },
    { header: 'Address', key: 'address', type: 'string' },
    { header: 'GST/VAT', key: 'gstVat', type: 'string' },
    { header: 'Contact Person', key: 'contactPerson', type: 'string' },
    { header: 'Email', key: 'email', type: 'email' },
    { header: 'Phone', key: 'phone', type: 'phone' },
    { header: 'Payment Terms', key: 'defaultPaymentTerms', type: 'string' },
    { header: 'Currency', key: 'defaultCurrency', enum: CURRENCIES, default: 'INR' },
  ],
  unique: [{ field: 'name', label: 'Vendor name' }],
  cascade: [
    { table: 'purchase_orders', field: 'vendor_id' },
    { table: 'invoices', field: 'vendor_id' },
    { table: 'amcs', field: 'vendor_id' },
    { table: 'assets', field: 'vendor_id' },
  ],
  sample: {
    'Vendor Name': 'Dell Commercial Sales', 'Address': '2 Dell Way, Round Rock', 'GST/VAT': '29ABCDE1234F1Z5',
    'Contact Person': 'Priya Nair', 'Email': 'sales@dell.example', 'Phone': '9876543210',
    'Payment Terms': 'Net 30', 'Currency': 'INR',
  },
  toDoc: (r) => ({
    name: r.name, address: orNull(r.address), gst_vat: orNull(r.gstVat),
    contact_person: orNull(r.contactPerson), email: orNull(r.email), phone: orNull(r.phone),
    default_payment_terms: orNull(r.defaultPaymentTerms), default_currency: r.defaultCurrency || 'INR',
    is_active: true, created_by: 'Bulk Import',
  }),
  toPatch: (r) => ({
    address: orNull(r.address), gst_vat: orNull(r.gstVat), contact_person: orNull(r.contactPerson),
    email: orNull(r.email), phone: orNull(r.phone), default_payment_terms: orNull(r.defaultPaymentTerms),
    default_currency: r.defaultCurrency || undefined,
  }),
  toExport: (v) => ({
    'Vendor Name': v.name, 'Address': v.address, 'GST/VAT': v.gst_vat, 'Contact Person': v.contact_person,
    'Email': v.email, 'Phone': v.phone, 'Payment Terms': v.default_payment_terms, 'Currency': v.default_currency,
  }),
};

const AMC = {
  key: 'amc',
  label: 'AMC Contract',
  labelPlural: 'AMC Contracts',
  table: 'amcs',
  matchField: 'id',
  idType: 'string',
  serialId: false, // AMC id is a caller-supplied business key
  permission: 'amc',
  masters: ['vendors'],
  existing: {
    amcIds: { table: 'amcs', field: 'id' },
    amcPoNumbers: { table: 'amcs', field: 'po_number' },
  },
  columns: [
    { header: 'AMC ID', key: 'id', type: 'string', required: true, unique: true, existing: 'amcIds' },
    { header: 'Vendor Business Name', key: 'vendor', type: 'string', required: true, master: 'vendors' },
    { header: 'PO Number', key: 'poNumber', type: 'string', required: true, unique: true, existing: 'amcPoNumbers' },
    { header: 'Cost', key: 'cost', type: 'number', min: 0, default: 0 },
    { header: 'Start Date', key: 'startDate', type: 'date' },
    { header: 'End Date', key: 'endDate', type: 'date' },
    { header: 'Service Schedule', key: 'serviceSchedule', enum: AMC_SCHEDULES, default: 'Quarterly' },
    { header: 'Agreement File', key: 'agreementFile', type: 'string' },
  ],
  unique: [
    { field: 'id', label: 'AMC ID' },
    { field: 'po_number', label: 'PO Number' },
  ],
  cascade: [],
  rowRule: (data) =>
    data.startDate && data.endDate && data.endDate < data.startDate
      ? 'End Date must be on or after Start Date.'
      : null,
  sample: {
    'AMC ID': 'AMC-2026-01', 'Vendor Business Name': 'Dell Commercial Sales', 'PO Number': 'PO-2026-88',
    'Cost': '48000', 'Start Date': '2026-04-01', 'End Date': '2027-03-31',
    'Service Schedule': 'Quarterly', 'Agreement File': '',
  },
  // Resolves the vendor snapshot (name + id) from the vendor master loaded into ctx.lookups.
  toDoc: (r, ctx) => {
    const vrow = ctx.lookups?.vendors?.get(String(r.vendor || '').trim().toLowerCase());
    return {
      id: r.id,
      vendor: vrow ? vrow.name : r.vendor,
      vendor_id: vrow ? vrow.id : null,
      cost: r.cost || 0,
      start_date: orNull(r.startDate),
      end_date: orNull(r.endDate),
      service_schedule: r.serviceSchedule || 'Quarterly',
      agreement_file: r.agreementFile || '',
      service_history: [],
      po_number: String(r.poNumber).trim(),
    };
  },
  toPatch: (r, ctx) => {
    const vrow = ctx.lookups?.vendors?.get(String(r.vendor || '').trim().toLowerCase());
    return {
      vendor: vrow ? vrow.name : r.vendor,
      vendor_id: vrow ? vrow.id : undefined,
      cost: r.cost,
      start_date: orNull(r.startDate),
      end_date: orNull(r.endDate),
      service_schedule: r.serviceSchedule || undefined,
      agreement_file: r.agreementFile || undefined,
      po_number: r.poNumber ? String(r.poNumber).trim() : undefined,
    };
  },
  toExport: (a) => ({
    'AMC ID': a.id, 'Vendor Business Name': a.vendor, 'PO Number': a.po_number, 'Cost': a.cost,
    'Start Date': a.start_date, 'End Date': a.end_date, 'Service Schedule': a.service_schedule,
    'Agreement File': a.agreement_file,
  }),
};

const REGISTRY = { vendor: VENDOR, amc: AMC };

function getDescriptor(key) {
  const d = REGISTRY[key];
  if (!d) {
    const err = new Error(`Unknown bulk entity "${key}". Known: ${Object.keys(REGISTRY).join(', ')}.`);
    err.statusCode = 404;
    throw err;
  }
  return d;
}

module.exports = { REGISTRY, getDescriptor, CURRENCIES, AMC_SCHEDULES };
