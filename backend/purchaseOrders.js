/**
 * Purchase Orders — automated generation.
 *
 * A PO is captured as structured data (a selected vendor, line items, taxes and an
 * order-level discount) and the server owns everything derived from it: the sequential
 * PO number, the subtotal / tax / discount / grand total, and the amount-in-words. The
 * browser renders the formatted PDF from this same authoritative data (see src/poPdf.js)
 * and uploads it back as a versioned document, so the stored document can never disagree
 * with the figures the server computed.
 *
 * Snapshots, deliberately:
 *   - vendor_* columns copy the vendor master at creation time, so editing a vendor
 *     later never rewrites an order already issued to it.
 *   - terms_content / terms_version freeze the master Terms & Conditions used, so an
 *     existing PO keeps its wording after the master template is revised.
 *
 * The PO number is the business identifier, unique case-insensitively, matching how AMC
 * contracts and user accounts are handled elsewhere in this codebase.
 */

const db = require('./db');
const storage = require('./storage');
const emailChannel = require('./notifications/channels/email');
const { amountInWords, computeTotals } = require('./poFormat');

const PO_STATUSES = ['Draft', 'Issued', 'Partially Received', 'Received', 'Cancelled'];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'];
const UNITS = ['pcs', 'nos', 'set', 'box', 'kg', 'ltr', 'mtr', 'hrs', 'license', 'unit'];
const TAX_RATES = [0, 5, 12, 18, 28];
const DISCOUNT_TYPES = ['amount', 'percent'];

const SORTABLE = {
  poNumber: 'po_number',
  vendor: 'vendor',
  issueDate: 'issue_date',
  expectedDeliveryDate: 'expected_delivery_date',
  status: 'status',
  amount: 'amount',
  createdAt: 'created_at'
};

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
  contactPerson: row.contact_person,
  email: row.email,
  phone: row.phone,
  defaultPaymentTerms: row.default_payment_terms,
  defaultCurrency: row.default_currency,
  isActive: row.is_active,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

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

/* ---------------------------------------------------------------- PO number */

const buildPoNumber = (settings, seq) => {
  const now = new Date();
  const pad = Math.max(0, settings.number_padding || 0);
  const seqStr = String(seq).padStart(pad, '0');
  return String(settings.number_format || 'PO/{YYYY}/{SEQ}')
    .replace(/\{PREFIX\}/g, settings.number_prefix || '')
    .replace(/\{YYYY\}/g, String(now.getFullYear()))
    .replace(/\{YY\}/g, String(now.getFullYear()).slice(-2))
    .replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, '0'))
    .replace(/\{SEQ\}/g, seqStr);
};

/** The next number without consuming it — used only for the live preview. */
const previewNextNumber = (settings) => {
  const year = new Date().getFullYear();
  const seq = settings.reset_sequence_yearly && settings.sequence_year !== year ? 1 : settings.next_sequence;
  return buildPoNumber(settings, seq);
};

/**
 * Consume the next PO number under a row lock, so two concurrent creates can never
 * be handed the same sequence. Resets the running sequence when the configured year
 * rolls over.
 */
async function allocatePoNumber(client) {
  await client.query(`INSERT INTO po_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const { rows } = await client.query('SELECT * FROM po_settings WHERE id = 1 FOR UPDATE');
  const settings = rows[0];
  const year = new Date().getFullYear();
  const seq = settings.reset_sequence_yearly && settings.sequence_year !== year ? 1 : settings.next_sequence;
  const poNumber = buildPoNumber(settings, seq);
  await client.query(
    'UPDATE po_settings SET next_sequence = $1, sequence_year = $2, updated_at = NOW() WHERE id = 1',
    [seq + 1, year]
  );
  return poNumber;
}

/* --------------------------------------------------------------- item / terms */

const loadItems = async (poId) => {
  const { rows } = await db.query(
    'SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY line_no',
    [poId]
  );
  return rows.map(mapItem);
};

const loadDocuments = async (poId) => {
  const { rows } = await db.query(
    'SELECT * FROM purchase_order_documents WHERE purchase_order_id = $1 ORDER BY version DESC',
    [poId]
  );
  return rows.map(mapDocument);
};

const loadAttachments = async (poId) => {
  const { rows } = await db.query(
    'SELECT * FROM purchase_order_attachments WHERE purchase_order_id = $1 ORDER BY id',
    [poId]
  );
  return rows.map((r) => ({
    id: r.id, name: r.file_name, filePath: r.file_path, fileType: r.file_type, fileSize: r.file_size
  }));
};

const loadCurrentTerms = async (q = db.query.bind(db)) => {
  const { rows } = await q('SELECT * FROM po_terms ORDER BY version DESC LIMIT 1', []);
  return rows[0] || null;
};

const insertItems = async (client, poId, lines) => {
  for (const l of lines) {
    await client.query(
      `INSERT INTO purchase_order_items
         (purchase_order_id, line_no, description, hsn_code, quantity, unit, unit_price, tax_percent, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [poId, l.lineNo, l.description, l.hsnCode || null, l.quantity, l.unit, l.unitPrice, l.taxPercent, l.lineTotal]
    );
  }
};

const replaceAttachments = async (client, poId, attachments, actor) => {
  await client.query('DELETE FROM purchase_order_attachments WHERE purchase_order_id = $1', [poId]);
  for (const att of attachments || []) {
    const filePath = att.fileUrl || att.filePath || att.file_path;
    if (!filePath) continue;
    await client.query(
      `INSERT INTO purchase_order_attachments (purchase_order_id, file_name, file_path, file_type, file_size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [poId, att.name || 'attachment', filePath, att.fileType || null, att.fileSize || null, actor]
    );
  }
};

/** Resolve the vendor snapshot + sensible defaults for a create/update. */
async function resolveVendor(body) {
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
    const { rows } = await db.query('SELECT * FROM vendors WHERE id = $1', [body.vendorId]);
    if (rows.length === 0) throw Object.assign(new Error('Selected vendor no longer exists'), { statusCode: 400 });
    const v = rows[0];
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

/* ---------------------------------------------------------------- validation */

const validateHeader = (body, { isCreate }) => {
  if (isCreate && !body.issueDate) return 'PO Date is required';
  if (isCreate && !body.vendorId && !(body.vendor && String(body.vendor).trim())) {
    return 'A vendor is required — pick one from the vendor master or type a name';
  }
  if (body.status && !PO_STATUSES.includes(body.status)) return `Status must be one of: ${PO_STATUSES.join(', ')}`;
  if (body.currency && !CURRENCIES.includes(body.currency)) return `Currency must be one of: ${CURRENCIES.join(', ')}`;
  if (body.discountType && !DISCOUNT_TYPES.includes(body.discountType)) return 'Discount type must be amount or percent';
  return null;
};

/* ================================================================ endpoints */

function register(app, { requirePermission, requireUser, roleCan }) {
  // Reading the vendor master / PO settings is part of the procurement flow, so it is
  // open to anyone who can view Finance as well as anyone who administers Vendors.
  const canReadProcurement = async (user) =>
    (await roleCan(user, 'finance', 'view')) || (await roleCan(user, 'vendors', 'view'));

  /* ---------------------------------------------------------------- options */

  app.get('/api/purchase-orders/options', (req, res) => {
    res.json({
      statuses: PO_STATUSES,
      currencies: CURRENCIES,
      units: UNITS,
      taxRates: TAX_RATES,
      discountTypes: DISCOUNT_TYPES
    });
  });

  /* ---------------------------------------------------------------- vendors */

  app.get('/api/vendors', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await canReadProcurement(user))) {
      return res.status(403).json({ error: 'Your role is not permitted to view vendors.' });
    }
    const { q, includeInactive } = req.query;
    const params = [];
    const filters = [];
    if (!includeInactive) filters.push('is_active = TRUE');
    if (q && q.trim()) {
      params.push(`%${q.trim().toLowerCase()}%`);
      filters.push(`(LOWER(name) LIKE $${params.length} OR LOWER(COALESCE(contact_person,'')) LIKE $${params.length} OR LOWER(COALESCE(email,'')) LIKE $${params.length})`);
    }
    try {
      const { rows } = await db.query(
        `SELECT * FROM vendors ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY LOWER(name) LIMIT 500`,
        params
      );
      res.json(rows.map(mapVendor));
    } catch (err) {
      console.error('GET /api/vendors failed:', err);
      res.status(500).json({ error: 'Could not load vendors: ' + err.message });
    }
  });

  app.get('/api/vendors/:id', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await canReadProcurement(user))) {
      return res.status(403).json({ error: 'Your role is not permitted to view vendors.' });
    }
    try {
      const { rows } = await db.query('SELECT * FROM vendors WHERE id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
      res.json(mapVendor(rows[0]));
    } catch (err) {
      res.status(500).json({ error: 'Could not load vendor: ' + err.message });
    }
  });

  app.post('/api/vendors', async (req, res) => {
    const user = await requirePermission(req, res, 'vendors', 'create');
    if (!user) return;
    const { name, address, gstVat, contactPerson, email, phone, defaultPaymentTerms, defaultCurrency } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Vendor name is required' });
    if (defaultCurrency && !CURRENCIES.includes(defaultCurrency)) {
      return res.status(400).json({ error: `Currency must be one of: ${CURRENCIES.join(', ')}` });
    }
    try {
      const { rows } = await db.query(
        `INSERT INTO vendors (name, address, gst_vat, contact_person, email, phone, default_payment_terms, default_currency, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [String(name).trim(), address || null, gstVat || null, contactPerson || null, email || null,
         phone || null, defaultPaymentTerms || null, defaultCurrency || 'INR', user.name]
      );
      res.status(201).json(mapVendor(rows[0]));
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: `Vendor "${name}" already exists.` });
      console.error('POST /api/vendors failed:', err);
      res.status(500).json({ error: 'Could not create vendor: ' + err.message });
    }
  });

  app.patch('/api/vendors/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'vendors', 'edit');
    if (!user) return;
    const columns = {
      name: 'name', address: 'address', gstVat: 'gst_vat', contactPerson: 'contact_person',
      email: 'email', phone: 'phone', defaultPaymentTerms: 'default_payment_terms',
      defaultCurrency: 'default_currency', isActive: 'is_active'
    };
    if (req.body.defaultCurrency && !CURRENCIES.includes(req.body.defaultCurrency)) {
      return res.status(400).json({ error: `Currency must be one of: ${CURRENCIES.join(', ')}` });
    }
    const setClauses = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (req.body[key] !== undefined) {
        values.push(req.body[key] === '' ? null : req.body[key]);
        setClauses.push(`${column} = $${values.length}`);
      }
    }
    if (setClauses.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id);
    try {
      const { rows } = await db.query(
        `UPDATE vendors SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
        values
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
      res.json(mapVendor(rows[0]));
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: `Vendor "${req.body.name}" already exists.` });
      console.error('PATCH /api/vendors failed:', err);
      res.status(500).json({ error: 'Could not update vendor: ' + err.message });
    }
  });

  app.delete('/api/vendors/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'vendors', 'delete');
    if (!user) return;
    try {
      // POs keep their vendor snapshot; only the master link is nulled (ON DELETE SET NULL).
      const { rows } = await db.query('DELETE FROM vendors WHERE id = $1 RETURNING name', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
      res.json({ message: `Vendor ${rows[0].name} deleted` });
    } catch (err) {
      console.error('DELETE /api/vendors failed:', err);
      res.status(500).json({ error: 'Could not delete vendor: ' + err.message });
    }
  });

  /* ----------------------------------------------------------- PO settings */

  app.get('/api/po-settings', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await canReadProcurement(user))) {
      return res.status(403).json({ error: 'Your role is not permitted to view purchase order settings.' });
    }
    try {
      await db.query(`INSERT INTO po_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
      const { rows } = await db.query('SELECT * FROM po_settings WHERE id = 1');
      const terms = await loadCurrentTerms();
      const settings = mapSettings(rows[0]);
      res.json({
        settings,
        nextNumber: previewNextNumber(rows[0]),
        terms: terms ? { version: terms.version, content: terms.content, updatedBy: terms.updated_by, createdAt: terms.created_at } : null
      });
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
      nextSequence: 'next_sequence', resetSequenceYearly: 'reset_sequence_yearly',
      defaultCurrency: 'default_currency'
    };
    if (req.body.defaultCurrency && !CURRENCIES.includes(req.body.defaultCurrency)) {
      return res.status(400).json({ error: `Currency must be one of: ${CURRENCIES.join(', ')}` });
    }
    const setClauses = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (req.body[key] !== undefined) {
        values.push(req.body[key] === '' ? null : req.body[key]);
        setClauses.push(`${column} = $${values.length}`);
      }
    }
    try {
      await db.query(`INSERT INTO po_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
      if (setClauses.length > 0) {
        await db.query(`UPDATE po_settings SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = 1`, values);
      }
      const { rows } = await db.query('SELECT * FROM po_settings WHERE id = 1');
      await db.query(
        `INSERT INTO system_logs (actor, action, detail) VALUES ($1,'PO Settings',$2)`,
        [user.name, `Updated: ${setClauses.map((c) => c.split(' = ')[0]).join(', ') || 'no fields'}`]
      );
      res.json({ settings: mapSettings(rows[0]), nextNumber: previewNextNumber(rows[0]) });
    } catch (err) {
      console.error('PATCH /api/po-settings failed:', err);
      res.status(500).json({ error: 'Could not update purchase order settings: ' + err.message });
    }
  });

  /* -------------------------------------------------- master Terms & Conditions */

  app.get('/api/po-terms', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!(await canReadProcurement(user))) {
      return res.status(403).json({ error: 'Your role is not permitted to view purchase order terms.' });
    }
    try {
      const { rows } = await db.query('SELECT * FROM po_terms ORDER BY version DESC');
      const history = rows.map((r) => ({ version: r.version, content: r.content, updatedBy: r.updated_by, createdAt: r.created_at }));
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
      const { rows: maxRows } = await db.query('SELECT COALESCE(MAX(version),0) AS v FROM po_terms');
      const nextVersion = Number(maxRows[0].v) + 1;
      await db.query(
        `INSERT INTO po_terms (version, content, updated_by) VALUES ($1,$2,$3)`,
        [nextVersion, content, user.name]
      );
      await db.query(
        `INSERT INTO system_logs (actor, action, detail) VALUES ($1,'PO Terms Updated',$2)`,
        [user.name, `Published Terms & Conditions version ${nextVersion}`]
      );
      const { rows } = await db.query('SELECT * FROM po_terms ORDER BY version DESC');
      const history = rows.map((r) => ({ version: r.version, content: r.content, updatedBy: r.updated_by, createdAt: r.created_at }));
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
      await db.query(`INSERT INTO po_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
      const { rows } = await db.query('SELECT * FROM po_settings WHERE id = 1');
      res.json({ nextNumber: previewNextNumber(rows[0]) });
    } catch (err) {
      res.status(500).json({ error: 'Could not compute next PO number: ' + err.message });
    }
  });

  /* --------------------------------------------------------------- PO list */

  app.get('/api/purchase-orders', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'view');
    if (!user) return;

    const { q, status, vendor, sortBy, sortDir } = req.query;
    const filters = [];
    const params = [];
    if (q && q.trim()) {
      params.push(`%${q.trim().toLowerCase()}%`);
      filters.push(`(LOWER(po.po_number) LIKE $${params.length} OR LOWER(po.vendor) LIKE $${params.length} OR LOWER(COALESCE(po.notes, '')) LIKE $${params.length})`);
    }
    if (status) { params.push(status); filters.push(`po.status = $${params.length}`); }
    if (vendor) { params.push(vendor); filters.push(`po.vendor = $${params.length}`); }

    const column = SORTABLE[sortBy] || 'created_at';
    const direction = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    try {
      const { rows } = await db.query(
        `SELECT po.*,
                (SELECT COUNT(*) FROM purchase_order_items i WHERE i.purchase_order_id = po.id)::int AS item_count,
                (SELECT COUNT(*) FROM purchase_order_documents d WHERE d.purchase_order_id = po.id)::int AS document_count
         FROM purchase_orders po
         ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
         ORDER BY po.${column} ${direction} NULLS LAST
         LIMIT 500`,
        params
      );
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
      const { rows } = await db.query('SELECT * FROM purchase_orders WHERE id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Purchase order not found' });
      const po = rows[0];
      res.json({
        ...mapPo(po),
        items: await loadItems(po.id),
        documents: await loadDocuments(po.id),
        attachments: await loadAttachments(po.id)
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
    const totals = computeTotals(req.body.items, {
      discountType: req.body.discountType,
      discountValue: req.body.discountValue
    });
    const words = amountInWords(totals.grandTotal, currency);

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const poNumber = await allocatePoNumber(client);
      const terms = await loadCurrentTerms((text, params) => client.query(text, params));

      const { rows } = await client.query(
        `INSERT INTO purchase_orders
           (po_number, vendor, vendor_id, vendor_address, vendor_gst, vendor_contact_person, vendor_email, vendor_phone,
            issue_date, expected_delivery_date, status, amount, currency, quotation_ref, delivery_schedule, payment_terms,
            contact_person, delivery_location, subtotal, tax_total, discount_type, discount_value, discount_amount,
            amount_in_words, terms_version, terms_content, notes, invoice_id, amc_id, created_by, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
         RETURNING *`,
        [
          poNumber, vendorSnap.vendor, vendorSnap.vendorId, vendorSnap.vendorAddress, vendorSnap.vendorGst,
          vendorSnap.vendorContactPerson, vendorSnap.vendorEmail, vendorSnap.vendorPhone,
          req.body.issueDate, req.body.expectedDeliveryDate || null, req.body.status || 'Draft',
          totals.grandTotal, currency, req.body.quotationRef || null, req.body.deliverySchedule || null, paymentTerms,
          req.body.contactPerson || null, req.body.deliveryLocation || null,
          totals.subtotal, totals.taxTotal, totals.discountType, totals.discountValue, totals.discountAmount,
          words, terms ? terms.version : null, terms ? terms.content : null,
          req.body.notes || null, req.body.invoiceId || null, req.body.amcId || null,
          user.id, user.name
        ]
      );
      const po = rows[0];
      await insertItems(client, po.id, totals.lines);
      if (req.body.attachments !== undefined) {
        await replaceAttachments(client, po.id, req.body.attachments, user.name);
      }
      await client.query(
        `INSERT INTO system_logs (actor, action, detail) VALUES ($1,'Purchase Order Created',$2)`,
        [user.name, `Created PO ${po.po_number} for ${po.vendor}`]
      );
      await client.query('COMMIT');
      res.status(201).json({
        ...mapPo(po),
        items: await loadItems(po.id),
        documents: [],
        attachments: await loadAttachments(po.id)
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: `PO Number "${err.detail || ''}" collided — please retry.` });
      }
      console.error('POST /api/purchase-orders failed:', err);
      res.status(500).json({ error: 'Could not create purchase order: ' + err.message });
    } finally {
      client.release();
    }
  });

  /* ------------------------------------------------------------- PO update */

  app.patch('/api/purchase-orders/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'edit');
    if (!user) return;
    const id = parseInt(req.params.id, 10);

    const problem = validateHeader(req.body, { isCreate: false });
    if (problem) return res.status(400).json({ error: problem });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const existingRes = await client.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [id]);
      if (existingRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Purchase order not found' });
      }
      const existing = existingRes.rows[0];

      // Re-snapshot the vendor only when the caller changed the vendor link.
      let vendorSnap = null;
      if (req.body.vendorId !== undefined || req.body.vendor !== undefined) {
        vendorSnap = await resolveVendor(req.body);
      }

      const currency = req.body.currency || existing.currency;
      // Items may be omitted on a status-only edit; fall back to the stored lines.
      const items = req.body.items !== undefined ? req.body.items : (await loadItems(id));
      const totals = computeTotals(items, {
        discountType: req.body.discountType !== undefined ? req.body.discountType : existing.discount_type,
        discountValue: req.body.discountValue !== undefined ? req.body.discountValue : existing.discount_value
      });
      const words = amountInWords(totals.grandTotal, currency);

      const fields = {
        vendor: vendorSnap ? vendorSnap.vendor : undefined,
        vendor_id: vendorSnap ? vendorSnap.vendorId : undefined,
        vendor_address: vendorSnap ? vendorSnap.vendorAddress : undefined,
        vendor_gst: vendorSnap ? vendorSnap.vendorGst : undefined,
        vendor_contact_person: vendorSnap ? vendorSnap.vendorContactPerson : undefined,
        vendor_email: vendorSnap ? vendorSnap.vendorEmail : undefined,
        vendor_phone: vendorSnap ? vendorSnap.vendorPhone : undefined,
        issue_date: req.body.issueDate,
        expected_delivery_date: req.body.expectedDeliveryDate === '' ? null : req.body.expectedDeliveryDate,
        status: req.body.status,
        currency: req.body.currency,
        quotation_ref: req.body.quotationRef,
        delivery_schedule: req.body.deliverySchedule,
        payment_terms: req.body.paymentTerms,
        contact_person: req.body.contactPerson,
        delivery_location: req.body.deliveryLocation,
        notes: req.body.notes,
        invoice_id: req.body.invoiceId === '' ? null : req.body.invoiceId,
        amc_id: req.body.amcId === '' ? null : req.body.amcId,
        // Always refreshed from the recomputed totals.
        subtotal: totals.subtotal,
        tax_total: totals.taxTotal,
        discount_type: totals.discountType,
        discount_value: totals.discountValue,
        discount_amount: totals.discountAmount,
        amount: totals.grandTotal,
        amount_in_words: words
      };

      const setClauses = [];
      const values = [];
      for (const [column, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        values.push(value);
        setClauses.push(`${column} = $${values.length}`);
      }
      values.push(id);
      const { rows } = await client.query(
        `UPDATE purchase_orders SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
        values
      );
      const po = rows[0];

      if (req.body.items !== undefined) {
        await client.query('DELETE FROM purchase_order_items WHERE purchase_order_id = $1', [id]);
        await insertItems(client, id, totals.lines);
      }
      if (req.body.attachments !== undefined) {
        await replaceAttachments(client, id, req.body.attachments, user.name);
      }
      await client.query(
        `INSERT INTO system_logs (actor, action, detail) VALUES ($1,'Purchase Order Updated',$2)`,
        [user.name, `Updated PO ${po.po_number}`]
      );
      await client.query('COMMIT');
      res.json({
        ...mapPo(po),
        items: await loadItems(id),
        documents: await loadDocuments(id),
        attachments: await loadAttachments(id)
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('PATCH /api/purchase-orders failed:', err);
      res.status(err.statusCode || 500).json({ error: 'Could not update purchase order: ' + err.message });
    } finally {
      client.release();
    }
  });

  app.delete('/api/purchase-orders/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'delete');
    if (!user) return;
    try {
      const { rows } = await db.query('DELETE FROM purchase_orders WHERE id = $1 RETURNING po_number', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Purchase order not found' });
      await db.query(
        `INSERT INTO system_logs (actor, action, detail) VALUES ($1,'Purchase Order Deleted',$2)`,
        [user.name, `Deleted PO ${rows[0].po_number}`]
      );
      res.json({ message: `Purchase order ${rows[0].po_number} deleted` });
    } catch (err) {
      console.error('DELETE /api/purchase-orders failed:', err);
      res.status(500).json({ error: 'Could not delete purchase order: ' + err.message });
    }
  });

  /* --------------------------------------------------- generated documents */

  // The browser generates the PDF and uploads it (getting a storage path); this
  // records that path as the next version in the PO's document history.
  app.post('/api/purchase-orders/:id/documents', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'create');
    if (!user) return;
    const id = parseInt(req.params.id, 10);
    const { filePath, fileName } = req.body;
    if (!filePath) return res.status(400).json({ error: 'A generated file path is required' });
    try {
      const poRes = await db.query('SELECT po_number FROM purchase_orders WHERE id = $1', [id]);
      if (poRes.rows.length === 0) return res.status(404).json({ error: 'Purchase order not found' });
      const versionRes = await db.query(
        'SELECT COALESCE(MAX(version),0) AS v FROM purchase_order_documents WHERE purchase_order_id = $1',
        [id]
      );
      const version = Number(versionRes.rows[0].v) + 1;
      const { rows } = await db.query(
        `INSERT INTO purchase_order_documents (purchase_order_id, version, po_number, file_path, file_name, generated_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, version, poRes.rows[0].po_number, filePath, fileName || `${poRes.rows[0].po_number}.pdf`, user.name]
      );
      res.status(201).json({ document: mapDocument(rows[0]), documents: await loadDocuments(id) });
    } catch (err) {
      console.error('POST /api/purchase-orders/:id/documents failed:', err);
      res.status(500).json({ error: 'Could not record generated document: ' + err.message });
    }
  });

  app.get('/api/purchase-orders/:id/documents', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'view');
    if (!user) return;
    try {
      res.json(await loadDocuments(parseInt(req.params.id, 10)));
    } catch (err) {
      res.status(500).json({ error: 'Could not load documents: ' + err.message });
    }
  });

  /* --------------------------------------------------------------- email PO */

  // Emails the generated PO to a recipient. When SMTP is unconfigured the message is
  // still recorded in the Email Alerts Inbox (log transport), matching the rest of the
  // notification system.
  app.post('/api/purchase-orders/:id/email', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'create');
    if (!user) return;
    const id = parseInt(req.params.id, 10);
    const { to, subject, message, filePath } = req.body;
    if (!to || !String(to).trim()) return res.status(400).json({ error: 'A recipient email address is required' });
    try {
      const poRes = await db.query('SELECT * FROM purchase_orders WHERE id = $1', [id]);
      if (poRes.rows.length === 0) return res.status(404).json({ error: 'Purchase order not found' });
      const po = poRes.rows[0];

      // Attach a short-lived link to the latest generated document (or the one named).
      let link = null;
      let path = filePath;
      if (!path) {
        const docs = await loadDocuments(id);
        path = docs[0]?.filePath;
      }
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

      const result = await emailChannel.send({ to: String(to).trim(), subject: finalSubject, body });

      // Mirror into the shared Email Alerts Inbox.
      const emailId = `EML-PO-${id}-${Date.now()}`;
      await db.query(
        `INSERT INTO emails (id, sender, date, subject, body) VALUES ($1,$2,$3,$4,$5)`,
        [emailId, String(to).trim(), new Date().toISOString(), finalSubject, body]
      );
      await db.query(
        `INSERT INTO system_logs (actor, action, detail) VALUES ($1,'Purchase Order Emailed',$2)`,
        [user.name, `Emailed PO ${po.po_number} to ${to}`]
      );

      res.json({ ok: true, transport: result.transport, delivered: result.transport === 'smtp' });
    } catch (err) {
      console.error('POST /api/purchase-orders/:id/email failed:', err);
      res.status(500).json({ error: 'Could not email purchase order: ' + err.message });
    }
  });
}

module.exports = { register, PO_STATUSES, CURRENCIES, UNITS, TAX_RATES, DISCOUNT_TYPES };
