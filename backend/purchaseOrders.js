/**
 * Purchase Orders.
 *
 * The PO number is the business identifier and is unique case-insensitively, matching
 * how AMC contracts and usernames are already handled in this codebase.
 *
 * Attachments store an object *path*, resolved to a short-lived signed URL on demand
 * through the existing /api/files/signed-url route — the same flow tickets and
 * knowledge base articles use. Nothing here needs a public bucket.
 *
 * invoice_id / amc_id are nullable links so a PO can later be tied to the invoice it
 * produced and the assets it bought, without requiring that today.
 */

const db = require('./db');

const PO_STATUSES = ['Draft', 'Issued', 'Partially Received', 'Received', 'Cancelled'];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'];
const MANAGE_ROLES = ['Super Admin', 'Finance Team'];

const SORTABLE = {
  poNumber: 'po_number',
  vendor: 'vendor',
  issueDate: 'issue_date',
  expectedDeliveryDate: 'expected_delivery_date',
  status: 'status',
  amount: 'amount',
  createdAt: 'created_at'
};

const mapPo = (row) => ({
  id: row.id,
  poNumber: row.po_number,
  vendor: row.vendor,
  issueDate: row.issue_date,
  expectedDeliveryDate: row.expected_delivery_date,
  status: row.status,
  amount: parseFloat(row.amount),
  currency: row.currency,
  notes: row.notes,
  invoiceId: row.invoice_id,
  amcId: row.amc_id,
  createdByName: row.created_by_name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  attachmentCount: row.attachment_count !== undefined ? Number(row.attachment_count) : undefined
});

const mapAttachment = (row) => ({
  id: row.id,
  name: row.file_name,
  filePath: row.file_path,
  fileType: row.file_type,
  fileSize: row.file_size,
  uploadedBy: row.uploaded_by,
  createdAt: row.created_at
});

const loadAttachments = async (poId) => {
  const { rows } = await db.query(
    'SELECT * FROM purchase_order_attachments WHERE purchase_order_id = $1 ORDER BY id',
    [poId]
  );
  return rows.map(mapAttachment);
};

const validate = ({ poNumber, vendor, issueDate, status, currency, amount }) => {
  if (!poNumber || !String(poNumber).trim()) return 'PO Number is required';
  if (!vendor || !String(vendor).trim()) return 'Vendor is required';
  if (!issueDate) return 'Issue date is required';
  if (status && !PO_STATUSES.includes(status)) return `Status must be one of: ${PO_STATUSES.join(', ')}`;
  if (currency && !CURRENCIES.includes(currency)) return `Currency must be one of: ${CURRENCIES.join(', ')}`;
  if (amount !== undefined && amount !== null && (Number.isNaN(Number(amount)) || Number(amount) < 0)) {
    return 'Amount must be a non-negative number';
  }
  return null;
};

const replaceAttachments = async (client, poId, attachments, actor) => {
  await client.query('DELETE FROM purchase_order_attachments WHERE purchase_order_id = $1', [poId]);
  for (const att of attachments || []) {
    const filePath = att.fileUrl || att.filePath || att.file_path;
    if (!filePath) continue;
    await client.query(
      `INSERT INTO purchase_order_attachments (purchase_order_id, file_name, file_path, file_type, file_size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [poId, att.name || att.file_name || 'attachment', filePath, att.fileType || null, att.fileSize || null, actor]
    );
  }
};

function register(app, { requireUser }) {
  const requireManager = (req, res) => {
    const user = requireUser(req, res);
    if (!user) return null;
    if (!MANAGE_ROLES.includes(user.role)) {
      res.status(403).json({ error: 'Only the Finance Team or Super Admins can manage purchase orders.' });
      return null;
    }
    return user;
  };

  app.get('/api/purchase-orders/options', (req, res) => {
    res.json({ statuses: PO_STATUSES, currencies: CURRENCIES });
  });

  // List with search, filter and sort. Employees have no business here.
  app.get('/api/purchase-orders', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role === 'Employee') {
      return res.status(403).json({ error: 'Purchase orders are not visible to employees.' });
    }

    const { q, status, vendor, sortBy, sortDir } = req.query;
    const filters = [];
    const params = [];

    if (q && q.trim()) {
      params.push(`%${q.trim().toLowerCase()}%`);
      filters.push(`(LOWER(po.po_number) LIKE $${params.length} OR LOWER(po.vendor) LIKE $${params.length} OR LOWER(COALESCE(po.notes, '')) LIKE $${params.length})`);
    }
    if (status) { params.push(status); filters.push(`po.status = $${params.length}`); }
    if (vendor) { params.push(vendor); filters.push(`po.vendor = $${params.length}`); }

    // Whitelisted, so a sort parameter can never be injected into the SQL.
    const column = SORTABLE[sortBy] || 'created_at';
    const direction = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    try {
      const { rows } = await db.query(
        `SELECT po.*, COUNT(a.id)::int AS attachment_count
         FROM purchase_orders po
         LEFT JOIN purchase_order_attachments a ON a.purchase_order_id = po.id
         ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
         GROUP BY po.id
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
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role === 'Employee') {
      return res.status(403).json({ error: 'Purchase orders are not visible to employees.' });
    }
    try {
      const { rows } = await db.query('SELECT * FROM purchase_orders WHERE id = $1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Purchase order not found' });
      res.json({ ...mapPo(rows[0]), attachments: await loadAttachments(rows[0].id) });
    } catch (err) {
      console.error('GET /api/purchase-orders/:id failed:', err);
      res.status(500).json({ error: 'Could not load purchase order: ' + err.message });
    }
  });

  app.post('/api/purchase-orders', async (req, res) => {
    const user = requireManager(req, res);
    if (!user) return;

    const problem = validate(req.body);
    if (problem) return res.status(400).json({ error: problem });

    const { poNumber, vendor, issueDate, expectedDeliveryDate, status, amount, currency, notes, invoiceId, amcId, attachments } = req.body;

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO purchase_orders
           (po_number, vendor, issue_date, expected_delivery_date, status, amount, currency, notes, invoice_id, amc_id, created_by, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [String(poNumber).trim(), String(vendor).trim(), issueDate, expectedDeliveryDate || null,
         status || 'Draft', amount || 0, currency || 'INR', notes || null,
         invoiceId || null, amcId || null, user.id, user.name || user.username]
      );
      const po = rows[0];
      await replaceAttachments(client, po.id, attachments, user.name || user.username);
      await client.query(
        `INSERT INTO system_logs (timestamp, actor, action, detail) VALUES ($1,$2,'Purchase Order Created',$3)`,
        [new Date().toLocaleString(), user.name || user.username, `Created PO ${po.po_number} for ${po.vendor}`]
      );
      await client.query('COMMIT');
      res.status(201).json({ ...mapPo(po), attachments: await loadAttachments(po.id) });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: `PO Number "${poNumber}" already exists.` });
      }
      console.error('POST /api/purchase-orders failed:', err);
      res.status(500).json({ error: 'Could not create purchase order: ' + err.message });
    } finally {
      client.release();
    }
  });

  app.patch('/api/purchase-orders/:id', async (req, res) => {
    const user = requireManager(req, res);
    if (!user) return;
    const id = parseInt(req.params.id, 10);

    if (req.body.status && !PO_STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: `Status must be one of: ${PO_STATUSES.join(', ')}` });
    }
    if (req.body.currency && !CURRENCIES.includes(req.body.currency)) {
      return res.status(400).json({ error: `Currency must be one of: ${CURRENCIES.join(', ')}` });
    }

    const columns = {
      poNumber: 'po_number', vendor: 'vendor', issueDate: 'issue_date',
      expectedDeliveryDate: 'expected_delivery_date', status: 'status',
      amount: 'amount', currency: 'currency', notes: 'notes',
      invoiceId: 'invoice_id', amcId: 'amc_id'
    };
    const setClauses = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (req.body[key] !== undefined) {
        values.push(req.body[key] === '' ? null : req.body[key]);
        setClauses.push(`${column} = $${values.length}`);
      }
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      let po;
      if (setClauses.length) {
        values.push(id);
        const { rows } = await client.query(
          `UPDATE purchase_orders SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
          values
        );
        po = rows[0];
      } else {
        const { rows } = await client.query('SELECT * FROM purchase_orders WHERE id = $1', [id]);
        po = rows[0];
      }
      if (!po) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Purchase order not found' });
      }
      if (req.body.attachments !== undefined) {
        await replaceAttachments(client, id, req.body.attachments, user.name || user.username);
      }
      await client.query('COMMIT');
      res.json({ ...mapPo(po), attachments: await loadAttachments(id) });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: `PO Number "${req.body.poNumber}" already exists.` });
      }
      console.error('PATCH /api/purchase-orders failed:', err);
      res.status(500).json({ error: 'Could not update purchase order: ' + err.message });
    } finally {
      client.release();
    }
  });

  app.delete('/api/purchase-orders/:id', async (req, res) => {
    const user = requireManager(req, res);
    if (!user) return;
    try {
      // Attachments cascade. Assets keep their purchase_order_id set to NULL.
      const { rows } = await db.query('DELETE FROM purchase_orders WHERE id = $1 RETURNING po_number', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Purchase order not found' });
      await db.query(
        `INSERT INTO system_logs (timestamp, actor, action, detail) VALUES ($1,$2,'Purchase Order Deleted',$3)`,
        [new Date().toLocaleString(), user.name || user.username, `Deleted PO ${rows[0].po_number}`]
      );
      res.json({ message: `Purchase order ${rows[0].po_number} deleted` });
    } catch (err) {
      console.error('DELETE /api/purchase-orders failed:', err);
      res.status(500).json({ error: 'Could not delete purchase order: ' + err.message });
    }
  });
}

module.exports = { register, PO_STATUSES, CURRENCIES };
