/**
 * Purchase Orders — automated generation. Backed by native Convex
 * (backend/convex/purchaseOrders.js).
 *
 * A PO is captured as structured data (a selected vendor, line items, taxes and an
 * order-level discount) and the server owns everything derived from it: the sequential
 * PO number, the subtotal / tax / discount / grand total, and the amount-in-words. The
 * browser renders the formatted PDF from this same authoritative data (see src/poPdf.js)
 * and uploads it back as a versioned document.
 *
 * Snapshots, deliberately:
 *   - vendor_* columns copy the vendor master at creation time, so editing a vendor later
 *     never rewrites an order already issued to it.
 *   - terms_content / terms_version freeze the master Terms & Conditions used.
 *
 * Totals (poFormat) and the vendor snapshot are resolved here; the sequential PO number,
 * the transactional multi-table writes and the versioned terms/documents are atomic Convex
 * mutations.
 */

const { cq, cm } = require('./convexApi');
const storage = require('./storage');
const emailChannel = require('./notifications/channels/email');
const { amountInWords, computeTotals } = require('./poFormat');
// The PO writer, the vendor snapshot and the header validation live in src/services/poUpdate
// so this route and the Requests approval engine share exactly one code path onto a PO.
const poUpdate = require('./src/services/poUpdate');

const {
  PO_STATUSES, CURRENCIES, DISCOUNT_TYPES, LOCKED_PO_STATUSES,
  resolveVendorSnapshot: resolveVendor, validateHeader, linesToItems,
} = poUpdate;

const UNITS = ['pcs', 'nos', 'set', 'box', 'kg', 'ltr', 'mtr', 'hrs', 'license', 'unit'];
const TAX_RATES = [0, 5, 12, 18, 28];

// Surface a ConvexError's message so route handlers can map it to an HTTP status.
function cleanErr(err) {
  if (err && err.data) return typeof err.data === 'string' ? err.data : (err.data.message || 'Operation failed.');
  const msg = (err && err.message) || 'Operation failed.';
  const m = msg.match(/Uncaught (?:Convex)?Error:\s*(.+?)(?:\n|\s+at\s|$)/);
  return m ? m[1].trim() : msg;
}

/* ------------------------------------------------------------------ mappers */

const num = (v) => (v === null || v === undefined ? 0 : parseFloat(v));

const mapPo = (row) => ({
  id: row.id,
  poNumber: row.po_number,
  vendor: row.vendor,
  vendorId: row.vendor_id,
  vendorAddress: row.vendor_address,
  vendorGst: row.vendor_gst,
  vendorContactPerson: row.vendor_contact_person,
  vendorEmail: row.vendor_email,
  vendorPhone: row.vendor_phone,
  issueDate: row.issue_date,
  expectedDeliveryDate: row.expected_delivery_date,
  status: row.status,
  currency: row.currency,
  quotationRef: row.quotation_ref,
  deliverySchedule: row.delivery_schedule,
  paymentTerms: row.payment_terms,
  contactPerson: row.contact_person,
  deliveryLocation: row.delivery_location,
  subtotal: num(row.subtotal),
  taxTotal: num(row.tax_total),
  discountType: row.discount_type,
  discountValue: num(row.discount_value),
  discountAmount: num(row.discount_amount),
  amount: num(row.amount),
  grandTotal: num(row.amount),
  amountInWords: row.amount_in_words,
  termsVersion: row.terms_version,
  termsContent: row.terms_content,
  notes: row.notes,
  invoiceId: row.invoice_id,
  amcId: row.amc_id,
  createdByName: row.created_by_name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  itemCount: row.item_count !== undefined ? Number(row.item_count) : undefined,
  documentCount: row.document_count !== undefined ? Number(row.document_count) : undefined
});

const mapItem = (row) => ({
  id: row.id,
  lineNo: row.line_no,
  description: row.description,
  hsnCode: row.hsn_code,
  quantity: num(row.quantity),
  unit: row.unit,
  unitPrice: num(row.unit_price),
  taxPercent: num(row.tax_percent),
  lineTotal: num(row.line_total)
});

const mapVendor = (row) => ({
  id: row.id,
  name: row.name,
  address: row.address,
  gstVat: row.gst_vat,
  // gstVat is the legacy free-text field a PO snapshots onto itself; gstNumber is the
  // registered identifier used for compliance. Kept apart rather than merged, because the
  // POs already issued carry a copy of the old one and must keep reading it back.
  gstNumber: row.gst_number ?? null,
  panNumber: row.pan_number ?? null,
  contactPerson: row.contact_person,
  email: row.email,
  phone: row.phone,
  bankName: row.bank_name ?? null,
  bankAccountNumber: row.bank_account_number ?? null,
  bankIfscSwift: row.bank_ifsc_swift ?? null,
  bankAccountHolder: row.bank_account_holder ?? null,
  defaultPaymentTerms: row.default_payment_terms,
  defaultCurrency: row.default_currency,
  isActive: row.is_active,
  documentCount: row.document_count !== undefined ? Number(row.document_count) : undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapVendorDocument = (row) => ({
  id: row.id,
  vendorId: row.vendor_id,
  docType: row.doc_type,
  fileName: row.file_name,
  filePath: row.file_path,
  fileType: row.file_type,
  fileSize: row.file_size,
  notes: row.notes,
  uploadedBy: row.uploaded_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at ?? null
});

// The paperwork a vendor is expected to have on file. Open-ended by design — 'Other' takes
// anything the list does not name, so an unusual document is filed rather than refused.
const VENDOR_DOC_TYPES = [
  'GST Certificate', 'PAN', 'Cancelled Cheque', 'Registration Certificate',
  'Contract', 'Agreement', 'Certification', 'Other'
];

const mapDocument = (row) => ({
  id: row.id,
  purchaseOrderId: row.purchase_order_id,
  version: row.version,
  poNumber: row.po_number,
  filePath: row.file_path,
  fileName: row.file_name,
  generatedBy: row.generated_by,
  createdAt: row.created_at
});

const mapAttachment = (r) => ({
  id: r.id, name: r.file_name, filePath: r.file_path, fileType: r.file_type, fileSize: r.file_size
});

const mapSettings = (row) => ({
  companyName: row.company_name,
  companyAddress: row.company_address,
  companyGst: row.company_gst,
  companyEmail: row.company_email,
  companyPhone: row.company_phone,
  companyWebsite: row.company_website,
  logoDataUrl: row.logo_data_url,
  signatureDataUrl: row.signature_data_url,
  signatureName: row.signature_name,
  signatureDesignation: row.signature_designation,
  numberPrefix: row.number_prefix,
  numberFormat: row.number_format,
  numberPadding: row.number_padding,
  nextSequence: row.next_sequence,
  resetSequenceYearly: row.reset_sequence_yearly,
  sequenceYear: row.sequence_year,
  defaultCurrency: row.default_currency
});

const mapTerm = (r) => ({ version: r.version, content: r.content, updatedBy: r.updated_by, createdAt: r.created_at });

const logAction = (actor, action, detail) => cm('logs:add', { actor, action, detail }).catch((e) => console.warn('[po] log failed:', e.message));

/* ================================================================ endpoints */

function register(app, { requirePermission, requireUser, roleCan }) {
  // Reading the vendor master / PO settings is part of the procurement flow, so it is open
  // to anyone who can view Finance as well as anyone who administers Vendors.
  const canReadProcurement = async (user) =>
    (await roleCan(user, 'finance', 'view')) || (await roleCan(user, 'vendors', 'view'));

  /* ---------------------------------------------------------------- options */

  app.get('/api/purchase-orders/options', (req, res) => {
    res.json({
      statuses: PO_STATUSES, currencies: CURRENCIES, units: UNITS, taxRates: TAX_RATES,
      discountTypes: DISCOUNT_TYPES,
      // The UI reads the lock from here rather than hardcoding a status list, so it offers
      // "raise an edit request" on exactly the orders the server will actually refuse.
      lockedStatuses: LOCKED_PO_STATUSES,
      vendorDocTypes: VENDOR_DOC_TYPES
    });
  });

  /* ---------------------------------------------------------------- vendors */

  app.get('/api/vendors', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await canReadProcurement(user))) return res.status(403).json({ error: 'Your role is not permitted to view vendors.' });
    try {
      const rows = await cq('purchaseOrders:vendorList', { q: req.query.q || undefined, includeInactive: !!req.query.includeInactive });
      res.json(rows.map(mapVendor));
    } catch (err) {
      console.error('GET /api/vendors failed:', err);
      res.status(500).json({ error: 'Could not load vendors: ' + err.message });
    }
  });

  app.get('/api/vendors/:id', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await canReadProcurement(user))) return res.status(403).json({ error: 'Your role is not permitted to view vendors.' });
    try {
      const v = await cq('purchaseOrders:vendorGet', { id: Number(req.params.id) });
      if (!v) return res.status(404).json({ error: 'Vendor not found' });
      res.json(mapVendor(v));
    } catch (err) {
      res.status(500).json({ error: 'Could not load vendor: ' + err.message });
    }
  });

  app.post('/api/vendors', async (req, res) => {
    const user = await requirePermission(req, res, 'vendors', 'create');
    if (!user) return;
    const {
      name, address, gstVat, gstNumber, panNumber, contactPerson, email, phone,
      bankName, bankAccountNumber, bankIfscSwift, bankAccountHolder,
      defaultPaymentTerms, defaultCurrency
    } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Vendor name is required' });
    if (defaultCurrency && !CURRENCIES.includes(defaultCurrency)) {
      return res.status(400).json({ error: `Currency must be one of: ${CURRENCIES.join(', ')}` });
    }
    try {
      const v = await cm('purchaseOrders:vendorCreate', {
        doc: {
          name: String(name).trim(), address: address || null, gst_vat: gstVat || null,
          gst_number: gstNumber || null, pan_number: panNumber || null,
          contact_person: contactPerson || null, email: email || null, phone: phone || null,
          bank_name: bankName || null, bank_account_number: bankAccountNumber || null,
          bank_ifsc_swift: bankIfscSwift || null, bank_account_holder: bankAccountHolder || null,
          default_payment_terms: defaultPaymentTerms || null, default_currency: defaultCurrency || 'INR', created_by: user.name
        }
      });
      res.status(201).json(mapVendor(v));
    } catch (err) {
      const msg = cleanErr(err);
      if (/already exists/i.test(msg)) return res.status(409).json({ error: msg });
      console.error('POST /api/vendors failed:', err);
      res.status(500).json({ error: 'Could not create vendor: ' + msg });
    }
  });

  app.patch('/api/vendors/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'vendors', 'edit');
    if (!user) return;
    const columns = {
      name: 'name', address: 'address', gstVat: 'gst_vat', gstNumber: 'gst_number',
      panNumber: 'pan_number', contactPerson: 'contact_person',
      email: 'email', phone: 'phone',
      bankName: 'bank_name', bankAccountNumber: 'bank_account_number',
      bankIfscSwift: 'bank_ifsc_swift', bankAccountHolder: 'bank_account_holder',
      defaultPaymentTerms: 'default_payment_terms',
      defaultCurrency: 'default_currency', isActive: 'is_active'
    };
    if (req.body.defaultCurrency && !CURRENCIES.includes(req.body.defaultCurrency)) {
      return res.status(400).json({ error: `Currency must be one of: ${CURRENCIES.join(', ')}` });
    }
    const patch = {};
    for (const [key, column] of Object.entries(columns)) {
      if (req.body[key] !== undefined) patch[column] = req.body[key] === '' ? null : req.body[key];
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No fields to update' });
    try {
      const v = await cm('purchaseOrders:vendorUpdate', { id: Number(req.params.id), patch });
      if (!v) return res.status(404).json({ error: 'Vendor not found' });
      res.json(mapVendor(v));
    } catch (err) {
      const msg = cleanErr(err);
      if (/already exists/i.test(msg)) return res.status(409).json({ error: msg });
      console.error('PATCH /api/vendors failed:', err);
      res.status(500).json({ error: 'Could not update vendor: ' + msg });
    }
  });

  app.delete('/api/vendors/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'vendors', 'delete');
    if (!user) return;
    try {
      const removed = await cm('purchaseOrders:vendorRemove', { id: Number(req.params.id) });
      if (!removed) return res.status(404).json({ error: 'Vendor not found' });
      res.json({ message: `Vendor ${removed.name} deleted` });
    } catch (err) {
      console.error('DELETE /api/vendors failed:', err);
      res.status(500).json({ error: 'Could not delete vendor: ' + err.message });
    }
  });

  /* ------------------------------------------------------ vendor documents */

  // Multi-document support for the vendor master: GST certificate, PAN, cancelled cheque,
  // registration, contracts, agreements, certifications, anything else. The browser uploads
  // via POST /api/upload and records the returned storage path here; preview and download
  // both go through POST /api/files/signed-url, so neither needs a route of its own.

  app.get('/api/vendors/:id/documents', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await canReadProcurement(user))) return res.status(403).json({ error: 'Your role is not permitted to view vendor documents.' });
    try {
      const rows = await cq('purchaseOrders:vendorDocumentsList', { vendorId: Number(req.params.id) });
      res.json(rows.map(mapVendorDocument));
    } catch (err) {
      console.error('GET /api/vendors/:id/documents failed:', err);
      res.status(500).json({ error: 'Could not load vendor documents: ' + err.message });
    }
  });

  app.post('/api/vendors/:id/documents', async (req, res) => {
    const user = await requirePermission(req, res, 'vendors', 'edit');
    if (!user) return;
    const { filePath, fileName, docType, fileType, fileSize, notes } = req.body;
    if (!filePath) return res.status(400).json({ error: 'A stored file path is required' });
    if (docType && !VENDOR_DOC_TYPES.includes(docType)) {
      return res.status(400).json({ error: `Document type must be one of: ${VENDOR_DOC_TYPES.join(', ')}` });
    }
    try {
      const row = await cm('purchaseOrders:vendorDocumentAdd', {
        vendorId: Number(req.params.id),
        doc: {
          docType: docType || 'Other', fileName: fileName || 'document', filePath,
          fileType: fileType || null, fileSize: fileSize || null, notes: notes || null,
          uploadedBy: user.name
        }
      });
      await logAction(user.name, 'Vendor Document Added', `${docType || 'Other'} uploaded for vendor ${req.params.id}`);
      res.status(201).json(mapVendorDocument(row));
    } catch (err) {
      const msg = cleanErr(err);
      if (/not found/i.test(msg)) return res.status(404).json({ error: msg });
      console.error('POST /api/vendors/:id/documents failed:', err);
      res.status(500).json({ error: 'Could not attach vendor document: ' + msg });
    }
  });

  app.put('/api/vendors/:id/documents/:docId', async (req, res) => {
    const user = await requirePermission(req, res, 'vendors', 'edit');
    if (!user) return;
    const { filePath, fileName, docType, fileType, fileSize, notes } = req.body;
    if (docType && !VENDOR_DOC_TYPES.includes(docType)) {
      return res.status(400).json({ error: `Document type must be one of: ${VENDOR_DOC_TYPES.join(', ')}` });
    }
    try {
      const row = await cm('purchaseOrders:vendorDocumentReplace', {
        id: Number(req.params.docId),
        doc: { filePath, fileName, docType, fileType, fileSize, notes, uploadedBy: user.name }
      });
      if (!row) return res.status(404).json({ error: 'Vendor document not found' });
      await logAction(user.name, 'Vendor Document Replaced', `Document ${req.params.docId} on vendor ${req.params.id}`);
      res.json(mapVendorDocument(row));
    } catch (err) {
      console.error('PUT /api/vendors/:id/documents/:docId failed:', err);
      res.status(500).json({ error: 'Could not replace vendor document: ' + cleanErr(err) });
    }
  });

  app.delete('/api/vendors/:id/documents/:docId', async (req, res) => {
    const user = await requirePermission(req, res, 'vendors', 'delete');
    if (!user) return;
    try {
      const removed = await cm('purchaseOrders:vendorDocumentRemove', { id: Number(req.params.docId) });
      if (!removed) return res.status(404).json({ error: 'Vendor document not found' });
      await logAction(user.name, 'Vendor Document Deleted', `${removed.doc_type} (${removed.file_name}) from vendor ${req.params.id}`);
      res.json({ message: `Document ${removed.file_name} deleted` });
    } catch (err) {
      console.error('DELETE /api/vendors/:id/documents/:docId failed:', err);
      res.status(500).json({ error: 'Could not delete vendor document: ' + err.message });
    }
  });

  /* ----------------------------------------------------------- PO settings */

  app.get('/api/po-settings', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await canReadProcurement(user))) return res.status(403).json({ error: 'Your role is not permitted to view purchase order settings.' });
    try {
      const [{ settings, nextNumber }, terms] = await Promise.all([
        cq('purchaseOrders:settingsGet', {}),
        cq('purchaseOrders:termsList', {})
      ]);
      res.json({ settings: mapSettings(settings), nextNumber, terms: terms[0] ? mapTerm(terms[0]) : null });
    } catch (err) {
      console.error('GET /api/po-settings failed:', err);
      res.status(500).json({ error: 'Could not load purchase order settings: ' + err.message });
    }
  });

  app.patch('/api/po-settings', async (req, res) => {
    const user = await requirePermission(req, res, 'systemSettings', 'manage');
    if (!user) return;
    const columns = {
      companyName: 'company_name', companyAddress: 'company_address', companyGst: 'company_gst',
      companyEmail: 'company_email', companyPhone: 'company_phone', companyWebsite: 'company_website',
      logoDataUrl: 'logo_data_url', signatureDataUrl: 'signature_data_url',
      signatureName: 'signature_name', signatureDesignation: 'signature_designation',
      numberPrefix: 'number_prefix', numberFormat: 'number_format', numberPadding: 'number_padding',
      nextSequence: 'next_sequence', resetSequenceYearly: 'reset_sequence_yearly', defaultCurrency: 'default_currency'
    };
    if (req.body.defaultCurrency && !CURRENCIES.includes(req.body.defaultCurrency)) {
      return res.status(400).json({ error: `Currency must be one of: ${CURRENCIES.join(', ')}` });
    }
    const patch = {};
    for (const [key, column] of Object.entries(columns)) {
      if (req.body[key] !== undefined) patch[column] = req.body[key] === '' ? null : req.body[key];
    }
    try {
      const { settings, nextNumber } = await cm('purchaseOrders:settingsUpdate', { patch });
      await logAction(user.name, 'PO Settings', `Updated: ${Object.keys(patch).join(', ') || 'no fields'}`);
      res.json({ settings: mapSettings(settings), nextNumber });
    } catch (err) {
      console.error('PATCH /api/po-settings failed:', err);
      res.status(500).json({ error: 'Could not update purchase order settings: ' + err.message });
    }
  });

  /* -------------------------------------------------- master Terms & Conditions */

  app.get('/api/po-terms', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await canReadProcurement(user))) return res.status(403).json({ error: 'Your role is not permitted to view purchase order terms.' });
    try {
      const history = (await cq('purchaseOrders:termsList', {})).map(mapTerm);
      res.json({ current: history[0] || null, history });
    } catch (err) {
      console.error('GET /api/po-terms failed:', err);
      res.status(500).json({ error: 'Could not load terms: ' + err.message });
    }
  });

  // A new master version is appended, never overwritten — that is what lets an already
  // issued PO keep referencing the exact text it was generated with.
  app.put('/api/po-terms', async (req, res) => {
    const user = await requirePermission(req, res, 'systemSettings', 'manage');
    if (!user) return;
    const content = req.body && typeof req.body.content === 'string' ? req.body.content : '';
    if (!content.trim()) return res.status(400).json({ error: 'Terms & Conditions content cannot be empty' });
    try {
      const history = (await cm('purchaseOrders:termsCreate', { content, updatedBy: user.name })).map(mapTerm);
      await logAction(user.name, 'PO Terms Updated', `Published Terms & Conditions version ${history[0].version}`);
      res.json({ current: history[0], history });
    } catch (err) {
      console.error('PUT /api/po-terms failed:', err);
      res.status(500).json({ error: 'Could not update terms: ' + err.message });
    }
  });

  /* ------------------------------------------------------------- PO number */

  app.get('/api/purchase-orders/next-number', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'view');
    if (!user) return;
    try {
      const { nextNumber } = await cq('purchaseOrders:settingsGet', {});
      res.json({ nextNumber });
    } catch (err) {
      res.status(500).json({ error: 'Could not compute next PO number: ' + err.message });
    }
  });

  /* --------------------------------------------------------------- PO list */

  app.get('/api/purchase-orders', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'view');
    if (!user) return;
    const { q, status, vendor, sortBy, sortDir } = req.query;
    try {
      const rows = await cq('purchaseOrders:poList', {
        q: q || undefined, status: status || undefined, vendor: vendor || undefined,
        sortBy: sortBy || undefined, sortDir: sortDir || undefined
      });
      res.json(rows.map(mapPo));
    } catch (err) {
      console.error('GET /api/purchase-orders failed:', err);
      res.status(500).json({ error: 'Could not load purchase orders: ' + err.message });
    }
  });

  app.get('/api/purchase-orders/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'view');
    if (!user) return;
    try {
      const result = await cq('purchaseOrders:poGet', { id: Number(req.params.id) });
      if (!result) return res.status(404).json({ error: 'Purchase order not found' });
      res.json({
        ...mapPo(result.po),
        items: result.items.map(mapItem),
        documents: result.documents.map(mapDocument),
        attachments: result.attachments.map(mapAttachment)
      });
    } catch (err) {
      console.error('GET /api/purchase-orders/:id failed:', err);
      res.status(500).json({ error: 'Could not load purchase order: ' + err.message });
    }
  });

  /* ------------------------------------------------------------- PO create */

  app.post('/api/purchase-orders', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'create');
    if (!user) return;

    const problem = validateHeader(req.body, { isCreate: true });
    if (problem) return res.status(400).json({ error: problem });

    let vendorSnap;
    try {
      vendorSnap = await resolveVendor(req.body);
    } catch (err) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    }

    const currency = req.body.currency || vendorSnap.defaultCurrency || 'INR';
    const paymentTerms = req.body.paymentTerms || vendorSnap.defaultPaymentTerms || null;
    const totals = computeTotals(req.body.items, { discountType: req.body.discountType, discountValue: req.body.discountValue });
    const words = amountInWords(totals.grandTotal, currency);

    try {
      const { po, items, attachments } = await cm('purchaseOrders:poCreate', {
        po: {
          vendor: vendorSnap.vendor, vendor_id: vendorSnap.vendorId, vendor_address: vendorSnap.vendorAddress,
          vendor_gst: vendorSnap.vendorGst, vendor_contact_person: vendorSnap.vendorContactPerson,
          vendor_email: vendorSnap.vendorEmail, vendor_phone: vendorSnap.vendorPhone,
          issue_date: req.body.issueDate, expected_delivery_date: req.body.expectedDeliveryDate || null,
          status: req.body.status || 'Draft', amount: totals.grandTotal, currency,
          quotation_ref: req.body.quotationRef || null, delivery_schedule: req.body.deliverySchedule || null,
          payment_terms: paymentTerms, contact_person: req.body.contactPerson || null,
          delivery_location: req.body.deliveryLocation || null,
          subtotal: totals.subtotal, tax_total: totals.taxTotal, discount_type: totals.discountType,
          discount_value: totals.discountValue, discount_amount: totals.discountAmount, amount_in_words: words,
          notes: req.body.notes || null, invoice_id: req.body.invoiceId || null, amc_id: req.body.amcId || null,
          created_by: user.id ?? null, created_by_name: user.name
        },
        items: linesToItems(totals.lines),
        attachments: req.body.attachments,
        actor: user.name
      });
      await logAction(user.name, 'Purchase Order Created', `Created PO ${po.po_number} for ${po.vendor}`);
      res.status(201).json({ ...mapPo(po), items: items.map(mapItem), documents: [], attachments: attachments.map(mapAttachment) });
    } catch (err) {
      console.error('POST /api/purchase-orders failed:', err);
      res.status(500).json({ error: 'Could not create purchase order: ' + cleanErr(err) });
    }
  });

  /* ------------------------------------------------------------- PO update */

  // Direct edit. A PO that has been issued to a vendor is locked here — those changes must go
  // through a Purchase Order Edit Request, which applies them via the same writer once
  // approved (see src/requests/registry.js 'po.edit'). The lock lives in poUpdate, not in
  // this handler, so no other caller onto a PO can quietly bypass it.
  app.patch('/api/purchase-orders/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'edit');
    if (!user) return;
    const id = parseInt(req.params.id, 10);

    try {
      const result = await poUpdate.updatePurchaseOrder(id, req.body, user.name);
      await logAction(user.name, 'Purchase Order Updated', `Updated PO ${result.po.po_number}`);
      res.json({
        ...mapPo(result.po),
        items: result.items.map(mapItem),
        documents: result.documents.map(mapDocument),
        attachments: result.attachments.map(mapAttachment)
      });
    } catch (err) {
      const status = err.statusCode || 500;
      if (status === 500) console.error('PATCH /api/purchase-orders failed:', err);
      res.status(status).json({
        error: status === 500 ? 'Could not update purchase order: ' + cleanErr(err) : err.message,
        // Lets the UI offer "Raise an edit request" instead of just showing a dead error.
        code: status === 409 ? 'PO_LOCKED_REQUIRES_REQUEST' : undefined
      });
    }
  });

  app.delete('/api/purchase-orders/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'delete');
    if (!user) return;
    try {
      const removed = await cm('purchaseOrders:poRemove', { id: Number(req.params.id) });
      if (!removed) return res.status(404).json({ error: 'Purchase order not found' });
      await logAction(user.name, 'Purchase Order Deleted', `Deleted PO ${removed.po_number}`);
      res.json({ message: `Purchase order ${removed.po_number} deleted` });
    } catch (err) {
      console.error('DELETE /api/purchase-orders failed:', err);
      res.status(500).json({ error: 'Could not delete purchase order: ' + err.message });
    }
  });

  /* --------------------------------------------------- generated documents */

  // The browser generates the PDF and uploads it (getting a storage path); this records
  // that path as the next version in the PO's document history.
  app.post('/api/purchase-orders/:id/documents', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'create');
    if (!user) return;
    const { filePath, fileName } = req.body;
    if (!filePath) return res.status(400).json({ error: 'A generated file path is required' });
    try {
      const result = await cm('purchaseOrders:poDocumentAdd', { id: Number(req.params.id), filePath, fileName: fileName || undefined, actor: user.name });
      if (!result) return res.status(404).json({ error: 'Purchase order not found' });
      res.status(201).json({ document: mapDocument(result.document), documents: result.documents.map(mapDocument) });
    } catch (err) {
      console.error('POST /api/purchase-orders/:id/documents failed:', err);
      res.status(500).json({ error: 'Could not record generated document: ' + err.message });
    }
  });

  app.get('/api/purchase-orders/:id/documents', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'view');
    if (!user) return;
    try {
      const documents = await cq('purchaseOrders:poDocumentsList', { id: Number(req.params.id) });
      res.json(documents.map(mapDocument));
    } catch (err) {
      res.status(500).json({ error: 'Could not load documents: ' + err.message });
    }
  });

  /* --------------------------------------------------------------- email PO */

  // Emails the generated PO to a recipient. When SMTP is unconfigured the message is still
  // recorded in the Email Alerts Inbox (log transport), matching the rest of the system.
  app.post('/api/purchase-orders/:id/email', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'create');
    if (!user) return;
    const id = parseInt(req.params.id, 10);
    const { to, subject, message, filePath } = req.body;
    if (!to || !String(to).trim()) return res.status(400).json({ error: 'A recipient email address is required' });
    try {
      const result = await cq('purchaseOrders:poGet', { id });
      if (!result) return res.status(404).json({ error: 'Purchase order not found' });
      const po = result.po;

      // Attach a short-lived link to the latest generated document (or the one named).
      let link = null;
      let path = filePath;
      if (!path) path = result.documents[0]?.file_path;
      if (path) {
        try {
          const baseUrl = `${req.protocol}://${req.get('host')}`;
          link = await storage.getSignedUrl(path, baseUrl);
        } catch (e) {
          console.warn('Could not sign PO document for email:', e.message);
        }
      }

      const finalSubject = (subject && subject.trim()) || `Purchase Order ${po.po_number} from ${po.created_by_name || 'our company'}`;
      const bodyLines = [
        message && message.trim() ? message.trim() : `Please find our Purchase Order ${po.po_number}.`,
        '',
        `PO Number : ${po.po_number}`,
        `Date      : ${po.issue_date ? new Date(po.issue_date).toISOString().split('T')[0] : ''}`,
        `Vendor    : ${po.vendor}`,
        `Amount    : ${po.currency} ${Number(po.amount).toFixed(2)}`,
        link ? '' : null,
        link ? `Download the Purchase Order (link valid for a few minutes):` : null,
        link || null
      ].filter((l) => l !== null);
      const body = bodyLines.join('\n');

      const sendResult = await emailChannel.send({ to: String(to).trim(), subject: finalSubject, body });

      // Mirror into the shared Email Alerts Inbox.
      await cm('generic:insert', {
        table: 'emails',
        document: { id: `EML-PO-${id}-${Date.now()}`, sender: String(to).trim(), date: new Date().toISOString(), subject: finalSubject, body }
      });
      await logAction(user.name, 'Purchase Order Emailed', `Emailed PO ${po.po_number} to ${to}`);

      res.json({ ok: true, transport: sendResult.transport, delivered: sendResult.transport === 'smtp' });
    } catch (err) {
      console.error('POST /api/purchase-orders/:id/email failed:', err);
      res.status(500).json({ error: 'Could not email purchase order: ' + err.message });
    }
  });
}

module.exports = { register, PO_STATUSES, CURRENCIES, UNITS, TAX_RATES, DISCOUNT_TYPES };
