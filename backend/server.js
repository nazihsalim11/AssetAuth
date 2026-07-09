const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cron = require('node-cron');
const { randomUUID } = require('crypto');
const db = require('./db');
const { runMigrations } = require('./migrations');
const storage = require('./storage');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const app = express();

// Wide-open CORS is fine for local development, but in production only the
// deployed frontend should be able to call this API. Set ALLOWED_ORIGINS to a
// comma-separated list, e.g. "https://assetflow.vercel.app".
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (allowedOrigins.length > 0) {
  app.use(cors({
    origin: (origin, callback) => {
      // Same-origin and server-to-server requests carry no Origin header.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      // Reply without the CORS header rather than throwing: the browser blocks the
      // read, and we avoid turning every stray cross-origin probe into a 500.
      callback(null, false);
    }
  }));
} else {
  if (IS_PRODUCTION) {
    console.warn('WARNING: ALLOWED_ORIGINS is not set — this API accepts requests from any origin.');
  }
  app.use(cors());
}

app.use(express.json());

// Middleware to recursively map snake_case request body keys to camelCase
function normalizeSnakeToCamel(obj) {
  if (Array.isArray(obj)) {
    return obj.map(v => normalizeSnakeToCamel(v));
  } else if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    const keys = Object.keys(obj);
    for (const key of keys) {
      const val = normalizeSnakeToCamel(obj[key]);
      obj[key] = val;
      if (key.includes('_')) {
        const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        if (obj[camelKey] === undefined) {
          obj[camelKey] = val;
        }
      }
    }
  }
  return obj;
}

app.use((req, res, next) => {
  if (req.body) {
    normalizeSnakeToCamel(req.body);
  }
  next();
});

// The development fallback below is committed to this repository, so anyone who
// reads it could forge a token for any user. Refuse to boot without a real secret
// once we are running for real.
if (IS_PRODUCTION && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production. Refusing to start with the public default.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_assetflow_token';

// Files are buffered in memory, then handed to storage.js, which puts them in a
// private Supabase bucket (or on local disk when Supabase is not configured).
// Writing to the container's disk would not survive a redeploy.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Serves files written by the local-disk fallback. In production nothing is
// written here — objects live in the private bucket and are reached via signed URLs.
if (!storage.isRemote) {
  app.use('/uploads', express.static(storage.uploadDir));
}

// --- ASSETS API ---
app.get('/api/assets', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM assets ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

app.post('/api/assets', async (req, res) => {
  const {
    id, name, serialNumber, category, type, status, cost, purchaseDate,
    warrantyExpiry, department, location, amcId, invoiceId,
    assignedEmployee, depreciationLifeYears, notes
  } = req.body;

  const query = `
    INSERT INTO assets (
      id, name, serial_number, category, type, status, cost, purchase_date,
      warranty_expiry, department, location, amc_id, invoice_id,
      assigned_employee, depreciation_life_years, notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    RETURNING *;
  `;
  const values = [
    id, name, serialNumber, category, type, status || 'Available', cost || 0, purchaseDate || null,
    warrantyExpiry || null, department || '', location || '', amcId || null, invoiceId || null,
    assignedEmployee || '', depreciationLifeYears || 5, notes || ''
  ];

  try {
    const result = await db.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database insertion failed: ' + (err.detail || err.message) });
  }
});

app.patch('/api/assets/:id', async (req, res) => {
  const { id } = req.params;
  const fields = req.body;
  
  // Dynamically build the UPDATE query based on fields passed
  const allowedFields = {
    name: 'name',
    serialNumber: 'serial_number',
    category: 'category',
    type: 'type',
    status: 'status',
    cost: 'cost',
    purchaseDate: 'purchase_date',
    warrantyExpiry: 'warranty_expiry',
    department: 'department',
    location: 'location',
    amcId: 'amc_id',
    invoiceId: 'invoice_id',
    assignedEmployee: 'assigned_employee',
    depreciationLifeYears: 'depreciation_life_years',
    disposalDate: 'disposal_date',
    disposalReason: 'disposal_reason',
    notes: 'notes'
  };

  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const [key, dbCol] of Object.entries(allowedFields)) {
    if (fields[key] !== undefined) {
      setClauses.push(`${dbCol} = $${idx}`);
      // Handle potential empty strings for foreign keys
      if ((key === 'amcId' || key === 'invoiceId') && fields[key] === '') {
        values.push(null);
      } else {
        values.push(fields[key]);
      }
      idx++;
    }
  }

  if (setClauses.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  setClauses.push(`updated_at = NOW()`);
  values.push(id);
  const query = `UPDATE assets SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`;

  try {
    const result = await db.query(query, values);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Asset not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database update failed: ' + err.message });
  }
});

app.delete('/api/assets/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query('DELETE FROM assets WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Asset not found' });
    res.json({ message: 'Asset deleted successfully', asset: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database deletion failed' });
  }
});


app.post('/api/assets/bulk/delete', async (req, res) => {
  const { assetIds } = req.body;
  if (!Array.isArray(assetIds)) {
    return res.status(400).json({ error: 'Payload must contain an assetIds array' });
  }
  try {
    await db.query('DELETE FROM assets WHERE id = ANY($1)', [assetIds]);
    const actor = req.headers['x-user-username'] || 'Admin';
    await db.query(
      `INSERT INTO system_logs (timestamp, actor, action, detail)
       VALUES ($1, $2, $3, $4)`,
      [new Date().toLocaleString(), actor, 'Bulk Delete Assets', `Deleted ${assetIds.length} assets`]
    );
    res.json({ message: `Successfully deleted ${assetIds.length} assets` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk asset deletion failed' });
  }
});

app.post('/api/assets/bulk/status', async (req, res) => {
  const { assetIds, status } = req.body;
  if (!Array.isArray(assetIds) || !status) {
    return res.status(400).json({ error: 'Payload must contain assetIds array and status' });
  }
  try {
    await db.query('UPDATE assets SET status = $1 WHERE id = ANY($2)', [status, assetIds]);
    const actor = req.headers['x-user-username'] || 'Admin';
    await db.query(
      `INSERT INTO system_logs (timestamp, actor, action, detail)
       VALUES ($1, $2, $3, $4)`,
      [new Date().toLocaleString(), actor, 'Bulk Status Update', `Updated ${assetIds.length} assets to status ${status}`]
    );
    res.json({ message: `Successfully updated status of ${assetIds.length} assets` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk asset status update failed' });
  }
});

app.post('/api/assets/bulk/category', async (req, res) => {
  const { assetIds, category } = req.body;
  if (!Array.isArray(assetIds) || !category) {
    return res.status(400).json({ error: 'Payload must contain assetIds array and category' });
  }
  try {
    await db.query('UPDATE assets SET category = $1 WHERE id = ANY($2)', [category, assetIds]);
    res.json({ message: `Successfully updated category of ${assetIds.length} assets` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk asset category update failed' });
  }
});

app.post('/api/assets/bulk/location', async (req, res) => {
  const { assetIds, location } = req.body;
  if (!Array.isArray(assetIds) || !location) {
    return res.status(400).json({ error: 'Payload must contain assetIds array and location' });
  }
  try {
    await db.query('UPDATE assets SET location = $1 WHERE id = ANY($2)', [location, assetIds]);
    res.json({ message: `Successfully updated location of ${assetIds.length} assets` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk asset location update failed' });
  }
});

app.post('/api/assets/bulk/department', async (req, res) => {
  const { assetIds, department } = req.body;
  if (!Array.isArray(assetIds) || !department) {
    return res.status(400).json({ error: 'Payload must contain assetIds array and department' });
  }
  try {
    await db.query('UPDATE assets SET department = $1 WHERE id = ANY($2)', [department, assetIds]);
    res.json({ message: `Successfully updated department of ${assetIds.length} assets` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk asset department update failed' });
  }
});

// --- AMCS API ---
app.get('/api/amcs', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM amcs ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

app.post('/api/amcs', async (req, res) => {
  const { id, vendor, cost, startDate, endDate, serviceSchedule, agreementFile, serviceHistory } = req.body;
  const query = `
    INSERT INTO amcs (id, vendor, cost, start_date, end_date, service_schedule, agreement_file, service_history)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *;
  `;
  const values = [
    id, vendor, cost || 0, startDate, endDate, serviceSchedule || 'Quarterly', agreementFile || '',
    JSON.stringify(serviceHistory || [])
  ];

  try {
    const result = await db.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database insertion failed: ' + err.message });
  }
});

app.patch('/api/amcs/:id', async (req, res) => {
  const { id } = req.params;
  const { serviceHistory } = req.body;
  try {
    const result = await db.query(
      'UPDATE amcs SET service_history = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [JSON.stringify(serviceHistory), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'AMC not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database update failed: ' + err.message });
  }
});


// --- INVOICES API ---
app.get('/api/invoices', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM invoices ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

app.post('/api/invoices', async (req, res) => {
  const { id, poReference, vendor, amount, gst, date, paymentStatus, fileName } = req.body;
  const query = `
    INSERT INTO invoices (id, po_reference, vendor, amount, gst, date, payment_status, file_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *;
  `;
  const values = [id, poReference || '', vendor, amount || 0, gst || 0, date, paymentStatus || 'Pending', fileName || ''];

  try {
    const result = await db.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database insertion failed: ' + err.message });
  }
});

app.patch('/api/invoices/:id', async (req, res) => {
  const { id } = req.params;
  const { paymentStatus, fileName } = req.body;
  const setClauses = [];
  const values = [];
  let idx = 1;

  if (paymentStatus !== undefined) {
    setClauses.push(`payment_status = $${idx}`);
    values.push(paymentStatus);
    idx++;
  }
  if (fileName !== undefined) {
    setClauses.push(`file_name = $${idx}`);
    values.push(fileName);
    idx++;
  }

  if (setClauses.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  values.push(id);
  const query = `UPDATE invoices SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`;

  try {
    const result = await db.query(query, values);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database update failed: ' + err.message });
  }
});

app.post('/api/invoices/bulk', async (req, res) => {
  const { invoices } = req.body;
  if (!Array.isArray(invoices)) {
    return res.status(400).json({ error: 'Payload must contain invoices array' });
  }

  const results = {
    successCount: 0,
    failedCount: 0,
    errors: [],
    inserted: []
  };

  const client = await db.pool.connect();
  try {
    for (let i = 0; i < invoices.length; i++) {
      const inv = invoices[i];
      const rowNum = i + 1;
      const { id, po_reference, vendor, amount, gst, date, payment_status, file_name } = inv;

      if (!id || !id.trim()) {
        results.failedCount++;
        results.errors.push({ row: rowNum, id: 'N/A', error: 'Invoice ID is required' });
        continue;
      }

      if (!vendor || !vendor.trim()) {
        results.failedCount++;
        results.errors.push({ row: rowNum, id, error: 'Vendor is required' });
        continue;
      }

      // Check duplicate in DB
      const dupCheck = await client.query('SELECT id FROM invoices WHERE id = $1', [id.trim()]);
      if (dupCheck.rows.length > 0) {
        results.failedCount++;
        results.errors.push({ row: rowNum, id, error: `Invoice ID '${id}' already exists in database` });
        continue;
      }

      // Check duplicate in batch
      const batchDups = invoices.filter((item, index) => item.id && item.id.trim().toLowerCase() === id.trim().toLowerCase() && index < i);
      if (batchDups.length > 0) {
        results.failedCount++;
        results.errors.push({ row: rowNum, id, error: `Duplicate Invoice ID '${id}' in the import batch` });
        continue;
      }

      try {
        const query = `
          INSERT INTO invoices (id, po_reference, vendor, amount, gst, date, payment_status, file_name)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *;
        `;
        const insertRes = await client.query(query, [
          id.trim(),
          po_reference || '',
          vendor.trim(),
          parseFloat(amount) || 0,
          parseInt(gst) || 0,
          date || new Date().toISOString().split('T')[0],
          payment_status || 'Pending',
          file_name || ''
        ]);
        results.successCount++;
        results.inserted.push(insertRes.rows[0]);
      } catch (err) {
        results.failedCount++;
        results.errors.push({ row: rowNum, id, error: err.message });
      }
    }
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk import failed: ' + err.message });
  } finally {
    client.release();
  }
});

app.post('/api/invoices/bulk/delete', async (req, res) => {
  const { invoiceIds } = req.body;
  if (!Array.isArray(invoiceIds)) {
    return res.status(400).json({ error: 'Payload must contain invoiceIds array' });
  }
  try {
    await db.query('DELETE FROM invoices WHERE id = ANY($1::text[])', [invoiceIds]);
    res.json({ message: 'Successfully deleted selected invoices' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk delete failed' });
  }
});

app.post('/api/invoices/bulk/status', async (req, res) => {
  const { invoiceIds, status } = req.body;
  if (!Array.isArray(invoiceIds) || !status) {
    return res.status(400).json({ error: 'Payload must contain invoiceIds array and status' });
  }
  try {
    await db.query('UPDATE invoices SET payment_status = $1, updated_at = NOW() WHERE id = ANY($2::text[])', [status, invoiceIds]);
    res.json({ message: 'Successfully updated status for selected invoices' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk status update failed' });
  }
});

/* ---------------- Invoice ⇆ Asset mapping ----------------
 * The link lives in assets.invoice_id, so an asset belongs to at most one
 * invoice and duplicate mappings are structurally impossible. Every mutation
 * below runs in a transaction and returns the resulting mapping, letting the
 * client resynchronise both the Invoice and Asset views from one response.
 */

const normalizeAssetIds = (assetIds) =>
  [...new Set((assetIds || []).map((id) => String(id).trim()).filter(Boolean))];

// Throws with .statusCode so callers can translate into a response.
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

const assertInvoiceExists = async (client, invoiceId) => {
  const found = await client.query('SELECT id FROM invoices WHERE id = $1', [invoiceId]);
  if (found.rows.length === 0) throw httpError(404, `Invoice '${invoiceId}' not found`);
};

const listInvoiceAssets = async (client, invoiceId) => {
  const result = await client.query(
    'SELECT * FROM assets WHERE invoice_id = $1 ORDER BY id',
    [invoiceId]
  );
  return result.rows;
};

// Applies the requested mapping change and reports exactly what moved.
const applyInvoiceMapping = async (invoiceId, assetIds, mode) => {
  const ids = normalizeAssetIds(assetIds);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await assertInvoiceExists(client, invoiceId);

    let unknown = [];
    let stolenFrom = [];
    if (ids.length > 0) {
      const existing = await client.query('SELECT id, invoice_id FROM assets WHERE id = ANY($1::text[])', [ids]);
      const known = new Set(existing.rows.map((r) => r.id));
      unknown = ids.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw httpError(400, `Unknown asset ID(s): ${unknown.join(', ')}`);
      }
      if (mode !== 'remove') {
        stolenFrom = existing.rows
          .filter((r) => r.invoice_id && r.invoice_id !== invoiceId)
          .map((r) => ({ assetId: r.id, previousInvoiceId: r.invoice_id }));
      }
    }

    if (mode === 'replace') {
      // Unlink everything currently on this invoice that is not in the new set,
      // then link the new set. Assets already linked here are left untouched.
      if (ids.length > 0) {
        await client.query(
          'UPDATE assets SET invoice_id = NULL, updated_at = NOW() WHERE invoice_id = $1 AND NOT (id = ANY($2::text[]))',
          [invoiceId, ids]
        );
        await client.query(
          'UPDATE assets SET invoice_id = $1, updated_at = NOW() WHERE id = ANY($2::text[]) AND (invoice_id IS DISTINCT FROM $1)',
          [invoiceId, ids]
        );
      } else {
        await client.query(
          'UPDATE assets SET invoice_id = NULL, updated_at = NOW() WHERE invoice_id = $1',
          [invoiceId]
        );
      }
    } else if (mode === 'add') {
      if (ids.length > 0) {
        await client.query(
          'UPDATE assets SET invoice_id = $1, updated_at = NOW() WHERE id = ANY($2::text[]) AND (invoice_id IS DISTINCT FROM $1)',
          [invoiceId, ids]
        );
      }
    } else if (mode === 'remove') {
      if (ids.length > 0) {
        // Scoped to this invoice so a stale request cannot unlink another invoice's assets.
        await client.query(
          'UPDATE assets SET invoice_id = NULL, updated_at = NOW() WHERE invoice_id = $1 AND id = ANY($2::text[])',
          [invoiceId, ids]
        );
      }
    }

    const assets = await listInvoiceAssets(client, invoiceId);
    await client.query('COMMIT');
    return { invoiceId, assets, assetIds: assets.map((a) => a.id), relinked: stolenFrom };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const sendMappingError = (res, err, action) => {
  const status = err.statusCode || 500;
  if (status === 500) console.error(`Invoice mapping (${action}) failed:`, err);
  res.status(status).json({ error: status === 500 ? `Failed to ${action}: ${err.message}` : err.message });
};

// Current mapping for an invoice.
app.get('/api/invoices/:id/assets', async (req, res) => {
  const client = await db.pool.connect();
  try {
    await assertInvoiceExists(client, req.params.id);
    const assets = await listInvoiceAssets(client, req.params.id);
    res.json({ invoiceId: req.params.id, assets, assetIds: assets.map((a) => a.id) });
  } catch (err) {
    sendMappingError(res, err, 'load invoice assets');
  } finally {
    client.release();
  }
});

// Replace the invoice's asset set outright. An empty array unlinks every asset.
app.put('/api/invoices/:id/assets', async (req, res) => {
  const { assetIds } = req.body;
  if (!Array.isArray(assetIds)) {
    return res.status(400).json({ error: 'Payload must contain an assetIds array' });
  }
  try {
    res.json(await applyInvoiceMapping(req.params.id, assetIds, 'replace'));
  } catch (err) {
    sendMappingError(res, err, 'replace invoice assets');
  }
});

// Link additional assets, leaving existing links in place. Re-adding is a no-op.
app.post('/api/invoices/:id/assets', async (req, res) => {
  const { assetIds } = req.body;
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    return res.status(400).json({ error: 'Payload must contain a non-empty assetIds array' });
  }
  try {
    res.json(await applyInvoiceMapping(req.params.id, assetIds, 'add'));
  } catch (err) {
    sendMappingError(res, err, 'add invoice assets');
  }
});

// Unlink specific assets from this invoice.
app.delete('/api/invoices/:id/assets', async (req, res) => {
  const { assetIds } = req.body || {};
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    return res.status(400).json({ error: 'Payload must contain a non-empty assetIds array' });
  }
  try {
    res.json(await applyInvoiceMapping(req.params.id, assetIds, 'remove'));
  } catch (err) {
    sendMappingError(res, err, 'remove invoice assets');
  }
});

// Retained for backwards compatibility; replace semantics, and an empty
// assetIds array now unlinks every asset rather than being rejected.
app.post('/api/invoices/bulk/map-assets', async (req, res) => {
  const { invoiceId, assetIds } = req.body;
  if (!invoiceId || !Array.isArray(assetIds)) {
    return res.status(400).json({ error: 'Payload must contain invoiceId and assetIds array' });
  }
  try {
    const result = await applyInvoiceMapping(invoiceId, assetIds, 'replace');
    res.json({ message: 'Assets successfully mapped to invoice', ...result });
  } catch (err) {
    sendMappingError(res, err, 'map assets');
  }
});


// --- MOVEMENTS API ---
app.get('/api/movements', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM movements ORDER BY date DESC, created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

app.post('/api/movements', async (req, res) => {
  const { assetId, date, type, from, to, actor, notes } = req.body;
  const query = `
    INSERT INTO movements (asset_id, date, type, from_loc, to_loc, actor, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *;
  `;
  const values = [assetId, date || new Date(), type, from || '', to || '', actor, notes || ''];

  try {
    const result = await db.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database insertion failed: ' + err.message });
  }
});


// --- DOCUMENTS API ---
app.get('/api/documents', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM documents ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

app.post('/api/documents', async (req, res) => {
  const { id, name, type, size, uploadDate, association, fileUrl } = req.body;
  const query = `
    INSERT INTO documents (id, name, type, file_size, upload_date, association, file_url)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *;
  `;
  const values = [id, name, type, size || '', uploadDate, association || '', fileUrl || ''];

  try {
    const result = await db.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database insertion failed: ' + err.message });
  }
});


// --- LOGS API ---
app.get('/api/logs', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM system_logs ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

app.post('/api/logs', async (req, res) => {
  const { timestamp, actor, action, detail } = req.body;
  const query = `
    INSERT INTO system_logs (timestamp, actor, action, detail)
    VALUES ($1, $2, $3, $4)
    RETURNING *;
  `;
  const values = [timestamp || new Date().toLocaleString(), actor, action, detail || ''];

  try {
    const result = await db.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database insertion failed: ' + err.message });
  }
});


// --- NOTIFICATIONS API ---
app.get('/api/notifications', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM notifications ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

// --- EMAILS API ---
app.get('/api/emails', async (req, res) => {
  try {
    res.json([]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

app.post('/api/notifications', async (req, res) => {
  const { id, text, type, time, read } = req.body;
  const query = `
    INSERT INTO notifications (id, text, type, time, read)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *;
  `;
  const values = [id, text, type || 'info', time || 'Just now', read || false];

  try {
    const result = await db.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database insertion failed: ' + err.message });
  }
});

app.patch('/api/notifications/:id', async (req, res) => {
  const { id } = req.params;
  const { read } = req.body;
  try {
    const result = await db.query(
      'UPDATE notifications SET read = $1 WHERE id = $2 RETURNING *',
      [read, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database update failed: ' + err.message });
  }
});

app.patch('/api/notifications', async (req, res) => {
  try {
    await db.query('UPDATE notifications SET read = TRUE');
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database update failed' });
  }
});

// --- CUSTOM AUTH / JWT USER EXTRACTOR HELPER ---
// Trusting `x-user-role`/`x-user-id` headers let any unauthenticated caller act as
// any user (e.g. create tickets as Super Admin id=1). The frontend never sends them,
// so the fallback is opt-in via env for local integration testing only.
const ALLOW_HEADER_AUTH = process.env.ALLOW_HEADER_AUTH === 'true';

// Returns { user } on success, or { error, code } describing exactly why auth failed,
// so the client can tell an expired session apart from a missing one.
const authenticateRequest = (req) => {
  const authHeader = req.headers['authorization'];

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      return { user: jwt.verify(token, JWT_SECRET) };
    } catch (e) {
      if (e.name === 'TokenExpiredError') {
        return { error: 'Your session has expired. Please sign in again.', code: 'TOKEN_EXPIRED' };
      }
      console.warn('JWT verify failed:', e.message);
      return { error: 'Your session is no longer valid. Please sign in again.', code: 'TOKEN_INVALID' };
    }
  }

  if (ALLOW_HEADER_AUTH) {
    const role = req.headers['x-user-role'] || req.query.role;
    const username = req.headers['x-user-username'] || req.query.username;
    const name = req.headers['x-user-name'] || req.query.name || username;
    const department = req.headers['x-user-department'] || req.query.department;
    const id = req.headers['x-user-id'] || req.query.userId;
    if (role) {
      return { user: { id: id ? parseInt(id, 10) : null, username, name, role, department } };
    }
  }

  return { error: 'You must be signed in to perform this action.', code: 'AUTH_REQUIRED' };
};

// Writes the failure straight to the response. Returns the user, or null if it replied.
const requireUser = (req, res) => {
  const { user, error, code } = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error, code });
    return null;
  }
  return user;
};

const validateAndFormatPhone = (phone) => {
  if (!phone) return { isValid: true, value: '' };
  const cleaned = String(phone).replace(/[\s\-\(\)]/g, '');
  if (!cleaned) return { isValid: true, value: '' };

  if (cleaned.startsWith('+')) {
    const digitsOnly = cleaned.slice(1);
    if (/^\d{7,15}$/.test(digitsOnly)) {
      return { isValid: true, value: cleaned };
    }
    return { isValid: false, error: 'Invalid international phone format. Must be + followed by 7 to 15 digits.' };
  }

  if (/^\d{10}$/.test(cleaned)) {
    return { isValid: true, value: '+91' + cleaned };
  }

  if (/^91\d{10}$/.test(cleaned)) {
    return { isValid: true, value: '+' + cleaned };
  }

  return { isValid: false, error: 'Invalid phone format. Indian numbers require 10 digits. International numbers must start with +.' };
};

// Reliable user creation helper used by both manual registration and bulk import
async function createSingleUser(client, { username, password, name, role, email, employeeId, phoneNumber, department, designation, status, resetRequired = false }) {
  // Validate duplicate username (case-insensitive)
  const usernameExists = await client.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  if (usernameExists.rows.length > 0) {
    throw new Error(`Username '${username}' already exists. Please use a unique Username.`);
  }

  const emailExists = await client.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  if (emailExists.rows.length > 0) {
    throw new Error(`Email '${email}' is already registered.`);
  }

  if (employeeId) {
    const empIdExists = await client.query('SELECT 1 FROM users WHERE LOWER(employee_id) = LOWER($1)', [employeeId]);
    if (empIdExists.rows.length > 0) {
      throw new Error(`Employee ID '${employeeId}' already exists. Please use a unique Employee ID.`);
    }
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  // 1. Generate authId
  const { randomUUID } = require('crypto');
  const authId = randomUUID();

  // 2. Insert into auth.users
  const rawUserMetadata = JSON.stringify({ name, role, username });
  const authQuery = `
    INSERT INTO auth.users (
      id, instance_id, email, encrypted_password, aud, role, 
      is_sso_user, is_anonymous, email_confirmed_at, 
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES ($1, '00000000-0000-0000-0000-000000000000', $2, $3, 'authenticated', 'authenticated', 
              false, false, NOW(), 
              '{"provider":"email","providers":["email"]}'::jsonb, $4::jsonb, NOW(), NOW())
  `;
  await client.query(authQuery, [authId, email, passwordHash, rawUserMetadata]);

  // 3. Insert into public.users
  const query = `
    INSERT INTO users (username, password_hash, name, role, email, employee_id, phone_number, department, designation, status, password_reset_required, auth_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING id, username, name, role, email, employee_id, phone_number, department, designation, status, password_reset_required, created_at, auth_id;
  `;
  const values = [
    username,
    passwordHash,
    name,
    role,
    email,
    employeeId || null,
    phoneNumber || '',
    department || '',
    designation || '',
    status || 'Active',
    resetRequired,
    authId
  ];
  const result = await client.query(query, values);
  return result.rows[0];
}

// --- BULK IMPORT APIS ---
/* ---------------- Employee bulk import ----------------
 * The old handler ran ~4 sequential queries plus a blocking bcrypt hash per row
 * inside the request. Against a remote pool (~186ms RTT) that is ~900ms/employee,
 * so ~34 employees exceeded the client's 30s timeout even though the import
 * itself completed. Two changes fix it:
 *
 *   1. The work runs as a background job. The request returns a jobId at once and
 *      the client polls for progress, so no import can ever time out.
 *   2. Duplicate checks are batched into set lookups and the inserts are chunked
 *      multi-row statements, cutting hundreds of round trips down to a handful.
 *
 * `importKey` is a client-supplied idempotency key: retrying a timed-out import
 * returns the original job instead of importing the same people twice.
 */

const IMPORT_CHUNK_SIZE = 100;
const VALID_ROLES = ['Super Admin', 'IT Admin', 'Facility Admin', 'Finance Team', 'Employee', 'Auditor'];
const DEFAULT_TEMP_PASSWORD = 'Password@123';

const getImportJob = async (jobId) => {
  const r = await db.query('SELECT * FROM import_jobs WHERE id = $1', [jobId]);
  return r.rows[0] || null;
};

const serializeJob = (job) => ({
  jobId: job.id,
  importKey: job.import_key,
  type: job.type,
  status: job.status,
  total: job.total,
  processed: job.processed,
  summary: job.summary,
  error: job.error
});

// Progress is written on a pooled connection, not the import's transaction,
// so pollers can see it before the import commits.
const setImportProgress = async (jobId, processed) => {
  try {
    await db.query('UPDATE import_jobs SET processed = $1, updated_at = NOW() WHERE id = $2', [processed, jobId]);
  } catch (err) {
    console.warn(`Could not update progress for import job ${jobId}:`, err.message);
  }
};

const finishImportJob = async (jobId, status, summary, error) => {
  await db.query(
    'UPDATE import_jobs SET status = $1, summary = $2, error = $3, processed = COALESCE($4, processed), updated_at = NOW() WHERE id = $5',
    [status, summary ? JSON.stringify(summary) : null, error || null, summary ? summary.total : null, jobId]
  );
};

const validateEmployeeRow = (emp) => {
  const { employeeId, firstName, lastName, email, phoneNumber, role } = emp;
  const errors = [];

  if (!employeeId) errors.push('Employee ID is required');
  if (!firstName) errors.push('First Name is required');
  if (!lastName) errors.push('Last Name is required');
  if (!email) {
    errors.push('Email is required');
  } else if (!/\S+@\S+\.\S+/.test(email)) {
    errors.push('Invalid email format');
  }

  let formattedPhone = '';
  if (phoneNumber) {
    const phoneValidation = validateAndFormatPhone(phoneNumber);
    if (!phoneValidation.isValid) errors.push(phoneValidation.error);
    else formattedPhone = phoneValidation.value;
  }

  const targetRole = role || 'Employee';
  if (!VALID_ROLES.includes(targetRole)) {
    errors.push(`Invalid role: must be one of ${VALID_ROLES.join(', ')}`);
  }

  return { errors, formattedPhone, targetRole };
};

// Builds the VALUES tail of a multi-row INSERT plus its flat parameter list.
// `template` maps a row's placeholder names to a tuple, so literal columns can be
// inlined. Placeholders inside a plain `INSERT ... VALUES` take their type from the
// target column, which matters because users.role is a `user_role` enum: routing the
// rows through `SELECT ... FROM (VALUES ...)` instead yields `text` and fails to cast.
const buildMultiRowValues = (rows, template) => {
  const params = [];
  const tuples = rows.map((row) => {
    const placeholders = row.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return template(placeholders);
  });
  return { text: tuples.join(', '), params };
};

const AUTH_META = '{"provider":"email","providers":["email"]}';

const insertUserChunk = async (client, chunk) => {
  const authRows = chunk.map((u) => [
    u.authId,
    u.email,
    u.passwordHash,
    JSON.stringify({ name: u.name, role: u.role, username: u.username })
  ]);
  const authValues = buildMultiRowValues(
    authRows,
    ([id, email, pwd, meta]) =>
      `(${id}, '00000000-0000-0000-0000-000000000000', ${email}, ${pwd}, 'authenticated', 'authenticated', ` +
      `false, false, NOW(), '${AUTH_META}'::jsonb, ${meta}::jsonb, NOW(), NOW())`
  );
  await client.query(
    `INSERT INTO auth.users (
       id, instance_id, email, encrypted_password, aud, role,
       is_sso_user, is_anonymous, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at
     ) VALUES ${authValues.text}`,
    authValues.params
  );

  const userRows = chunk.map((u) => [
    u.username, u.passwordHash, u.name, u.role, u.email, u.employeeId,
    u.phoneNumber, u.department, u.designation, u.status, u.resetRequired, u.authId
  ]);
  const userValues = buildMultiRowValues(userRows, (p) => `(${p.join(', ')})`);
  await client.query(
    `INSERT INTO users (
       username, password_hash, name, role, email, employee_id,
       phone_number, department, designation, status, password_reset_required, auth_id
     ) VALUES ${userValues.text}`,
    userValues.params
  );
};

async function processEmployeeImport(jobId, employees) {
  const summary = { total: employees.length, success: 0, failed: 0, duplicate: 0, errors: [], generatedPasswords: [] };
  const client = await db.pool.connect();

  try {
    // One round trip, instead of three per employee.
    const existing = await client.query(
      'SELECT LOWER(employee_id) AS eid, LOWER(email) AS email, LOWER(username) AS username FROM users'
    );
    const takenEmployeeIds = new Set(existing.rows.map((r) => r.eid).filter(Boolean));
    const takenEmails = new Set(existing.rows.map((r) => r.email).filter(Boolean));
    const takenUsernames = new Set(existing.rows.map((r) => r.username).filter(Boolean));

    // bcryptjs costs ~150ms per hash and blocks the event loop. The generated temp
    // password is a known constant that every such account must reset on first
    // login, so hashing it once leaks nothing that the constant does not already.
    // Passwords supplied in the file get their own salt and hash.
    let sharedDefaultHash = null;
    const hashPassword = async (plaintext, isGeneratedDefault) => {
      if (isGeneratedDefault) {
        if (!sharedDefaultHash) {
          sharedDefaultHash = await bcrypt.hash(plaintext, await bcrypt.genSalt(10));
        }
        return sharedDefaultHash;
      }
      return bcrypt.hash(plaintext, await bcrypt.genSalt(10));
    };

    const prepared = [];
    for (let i = 0; i < employees.length; i++) {
      const rowNum = i + 1;
      const emp = employees[i];
      const { employeeId, firstName, lastName, email, department, designation, status, password } = emp;

      const { errors, formattedPhone, targetRole } = validateEmployeeRow(emp);
      if (errors.length > 0) {
        summary.failed++;
        summary.errors.push({ row: rowNum, employeeId, error: errors.join(', ') });
        continue;
      }

      if (takenEmployeeIds.has(employeeId.toLowerCase())) {
        summary.duplicate++;
        summary.errors.push({ row: rowNum, employeeId, error: `Employee ID '${employeeId}' already exists. Please use a unique Employee ID.` });
        continue;
      }
      if (takenEmails.has(email.toLowerCase())) {
        summary.duplicate++;
        summary.errors.push({ row: rowNum, employeeId, error: `Email "${email}" already exists` });
        continue;
      }

      const baseUsername = email.split('@')[0];
      let username = baseUsername;
      let suffix = 1;
      while (takenUsernames.has(username.toLowerCase())) {
        username = baseUsername + suffix;
        suffix++;
      }

      // Reserve straight away so later rows in the same file cannot collide.
      takenEmployeeIds.add(employeeId.toLowerCase());
      takenEmails.add(email.toLowerCase());
      takenUsernames.add(username.toLowerCase());

      const resetRequired = !password;
      const plaintext = password || DEFAULT_TEMP_PASSWORD;

      prepared.push({
        rowNum,
        authId: randomUUID(),
        username,
        name: `${firstName} ${lastName}`,
        role: targetRole,
        email,
        employeeId,
        phoneNumber: formattedPhone || '',
        department: department || '',
        designation: designation || '',
        status: status || 'Active',
        resetRequired,
        passwordHash: await hashPassword(plaintext, resetRequired),
        plaintext
      });
    }

    const recordSuccess = (u) => {
      summary.success++;
      if (u.resetRequired) {
        summary.generatedPasswords.push({
          employeeId: u.employeeId,
          username: u.username,
          name: u.name,
          email: u.email,
          tempPassword: u.plaintext
        });
      }
    };

    await client.query('BEGIN');

    for (let i = 0; i < prepared.length; i += IMPORT_CHUNK_SIZE) {
      const chunk = prepared.slice(i, i + IMPORT_CHUNK_SIZE);
      await client.query('SAVEPOINT chunk_sp');
      try {
        await insertUserChunk(client, chunk);
        await client.query('RELEASE SAVEPOINT chunk_sp');
        chunk.forEach(recordSuccess);
      } catch (chunkErr) {
        // One bad row poisons its whole chunk, so replay it row by row to
        // attribute the failure and still import everyone else.
        await client.query('ROLLBACK TO SAVEPOINT chunk_sp');
        console.warn(`Chunk insert failed, retrying ${chunk.length} rows individually:`, chunkErr.message);
        for (let k = 0; k < chunk.length; k++) {
          const u = chunk[k];
          await client.query('SAVEPOINT row_sp');
          try {
            await insertUserChunk(client, [u]);
            await client.query('RELEASE SAVEPOINT row_sp');
            recordSuccess(u);
          } catch (rowErr) {
            await client.query('ROLLBACK TO SAVEPOINT row_sp');
            console.error(`Error importing row ${u.rowNum} (${u.employeeId}):`, rowErr.message);
            summary.failed++;
            summary.errors.push({ row: u.rowNum, employeeId: u.employeeId, error: rowErr.message });
          }
          // This path is slow, so keep the progress bar moving within the chunk.
          if (k % 10 === 9) await setImportProgress(jobId, i + k + 1);
        }
      }
      await setImportProgress(jobId, Math.min(i + chunk.length, prepared.length));
    }

    await client.query(
      `INSERT INTO system_logs (timestamp, actor, action, detail) VALUES ($1, $2, $3, $4)`,
      [
        new Date().toLocaleString(),
        'Admin',
        'Employee Bulk Import',
        `Imported employees. Total: ${summary.total}, Success: ${summary.success}, Failed: ${summary.failed}, Duplicate: ${summary.duplicate}`
      ]
    );

    await client.query('COMMIT');
    summary.errors.sort((a, b) => a.row - b.row);
    await finishImportJob(jobId, 'completed', summary);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be gone */
    }
    console.error('Employee import transaction failed:', err);
    await finishImportJob(jobId, 'failed', null, err.message);
  } finally {
    client.release();
  }
}

app.post('/api/import/employees', async (req, res) => {
  const { employees, importKey } = req.body;
  if (!Array.isArray(employees)) {
    return res.status(400).json({ error: 'Payload must contain an employees array' });
  }
  if (employees.length === 0) {
    return res.status(400).json({ error: 'There are no employees to import' });
  }

  // Without a key, every retry counts as a fresh import.
  const key = importKey || randomUUID();
  const jobId = randomUUID();

  try {
    const created = await db.query(
      `INSERT INTO import_jobs (id, import_key, type, status, total, processed)
       VALUES ($1, $2, 'employees', 'running', $3, 0)
       ON CONFLICT (import_key) DO NOTHING
       RETURNING *`,
      [jobId, key, employees.length]
    );

    if (created.rows.length === 0) {
      // This key has been used before: hand back the original job rather than
      // importing the same people a second time.
      const existing = await db.query('SELECT * FROM import_jobs WHERE import_key = $1', [key]);
      return res.status(200).json({ ...serializeJob(existing.rows[0]), reused: true });
    }

    // Respond before the work begins; the client polls the job for progress.
    res.status(202).json({ ...serializeJob(created.rows[0]), reused: false });

    processEmployeeImport(jobId, employees).catch(async (err) => {
      console.error('Unhandled employee import failure:', err);
      await finishImportJob(jobId, 'failed', null, err.message).catch(() => {});
    });
  } catch (err) {
    console.error('Could not start employee import:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not start import: ' + err.message });
    }
  }
});

app.get('/api/import/jobs/:jobId', async (req, res) => {
  try {
    const job = await getImportJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Import job not found' });
    res.json(serializeJob(job));
  } catch (err) {
    console.error('Could not read import job:', err);
    res.status(500).json({ error: 'Could not read import job: ' + err.message });
  }
});

app.post('/api/import/assets', async (req, res) => {
  const { assets } = req.body;
  if (!Array.isArray(assets)) {
    return res.status(400).json({ error: 'Payload must contain an assets array' });
  }

  const client = await db.pool.connect();
  const summary = {
    total: assets.length,
    success: 0,
    failed: 0,
    duplicate: 0,
    errors: []
  };

  try {
    await client.query('BEGIN');
    const batchAssetIds = new Set();

    for (let i = 0; i < assets.length; i++) {
      const rowNum = i + 1;
      const asset = assets[i];
      const {
        assetId, name, category, brand, model, serialNumber, quantity,
        unit, purchaseDate, purchaseCost, supplier, warrantyExpiry, location, status
      } = asset;

      const errors = [];
      if (!assetId) errors.push('Asset ID is required');
      if (!name) errors.push('Asset Name is required');
      if (!category) {
        errors.push('Category is required');
      } else if (category !== 'IT' && category !== 'Office') {
        errors.push('Category must be "IT" or "Office"');
      }

      if (errors.length > 0) {
        summary.failed++;
        summary.errors.push({ row: rowNum, assetId, error: errors.join(', ') });
        continue;
      }

      if (batchAssetIds.has(assetId)) {
        summary.duplicate++;
        summary.errors.push({ row: rowNum, assetId, error: `Duplicate Asset ID "${assetId}" in batch` });
        continue;
      }

      const idExists = await client.query('SELECT 1 FROM assets WHERE id = $1', [assetId]);
      if (idExists.rows.length > 0) {
        summary.duplicate++;
        summary.errors.push({ row: rowNum, assetId, error: `Asset ID "${assetId}" already exists in database` });
        continue;
      }

      const qty = parseInt(quantity) || 1;
      const cost = parseFloat(purchaseCost) || 0;
      const type = category === 'IT' ? 'Laptops' : 'Chairs';

      const insertQuery = `
        INSERT INTO assets (
          id, name, category, type, brand, model, serial_number, total_quantity, available_quantity,
          assigned_quantity, unit, purchase_date, cost, supplier, warranty_expiry, location, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `;
      const values = [
        assetId,
        name,
        category,
        type,
        brand || '',
        model || '',
        serialNumber || null,
        qty,
        qty,
        0,
        unit || 'pcs',
        purchaseDate || null,
        cost,
        supplier || '',
        warrantyExpiry || null,
        location || '',
        status || 'Available'
      ];

      await client.query(insertQuery, values);
      summary.success++;
      batchAssetIds.add(assetId);
    }

    const actor = req.headers['x-user-username'] || 'Admin';
    await client.query(
      `INSERT INTO system_logs (timestamp, actor, action, detail)
       VALUES ($1, $2, $3, $4)`,
      [
        new Date().toLocaleString(),
        actor,
        'Asset Bulk Import',
        `Imported assets. Total: ${summary.total}, Success: ${summary.success}, Failed: ${summary.failed}, Duplicate: ${summary.duplicate}`
      ]
    );

    await client.query('COMMIT');
    res.json(summary);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Asset import transaction failed:', err);
    res.status(500).json({ error: 'Import failed unexpectedly: ' + err.message });
  } finally {
    client.release();
  }
});

// --- QUANTITY BASED ASSIGNMENT APIS ---
app.get('/api/assignments', async (req, res) => {
  try {
    // Inner-joining users as well as assets means a row whose employee or asset
    // has gone away can never surface in the registry, even if one were somehow
    // created outside the ON DELETE CASCADE guarantees.
    const result = await db.query(`
      SELECT aa.*, a.name as asset_name, a.category as asset_category
      FROM asset_assignments aa
      JOIN assets a ON aa.asset_id = a.id
      JOIN users u ON aa.user_id = u.id
      ORDER BY aa.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/assignments failed:', err);
    res.status(500).json({ error: 'Database query failed: ' + err.message });
  }
});

app.post('/api/assignments', async (req, res) => {
  const { assetId, employeeName, quantity, department, notes, date } = req.body;
  const qty = parseInt(quantity) || 1;
  const actor = req.headers['x-user-username'] || 'Admin';

  if (!assetId || !employeeName || qty <= 0) {
    return res.status(400).json({ error: 'Asset ID, Employee Name, and positive quantity are required.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const assetRes = await client.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [assetId]);
    if (assetRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Asset not found' });
    }

    const asset = assetRes.rows[0];
    if (asset.available_quantity < qty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient stock. Available: ${asset.available_quantity}, Requested: ${qty}` });
    }

    const userRes = await client.query('SELECT id, name FROM users WHERE LOWER(name) = LOWER($1) OR LOWER(username) = LOWER($1)', [employeeName]);
    if (userRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Employee "${employeeName}" does not exist in the user directory.` });
    }
    const userId = userRes.rows[0].id;
    const employeeNameDb = userRes.rows[0].name;

    const insertQuery = `
      INSERT INTO asset_assignments (asset_id, employee_name, user_id, quantity, department, date, notes, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'Assigned')
      RETURNING *;
    `;
    const assignmentRes = await client.query(insertQuery, [
      assetId, employeeNameDb, userId, qty, department || asset.department, date || new Date(), notes || ''
    ]);
    const assignment = assignmentRes.rows[0];

    const newAssignedQty = asset.assigned_quantity + qty;
    const newAvailableQty = asset.total_quantity - newAssignedQty;
    const newStatus = newAvailableQty === 0 ? 'Assigned' : 'Available';

    const activeAssignmentsRes = await client.query(`
      SELECT employee_name, SUM(quantity) as qty
      FROM asset_assignments
      WHERE asset_id = $1 AND status = 'Assigned'
      GROUP BY employee_name
    `, [assetId]);
    const summaryStr = activeAssignmentsRes.rows.map(row => `${row.employee_name} (${row.qty})`).join(', ');

    await client.query(`
      UPDATE assets
      SET assigned_quantity = $1, available_quantity = $2, status = $3, assigned_employee = $4, updated_at = NOW()
      WHERE id = $5
    `, [newAssignedQty, newAvailableQty, newStatus, summaryStr, assetId]);

    await client.query(`
      INSERT INTO movements (asset_id, date, type, from_loc, to_loc, actor, notes)
      VALUES ($1, $2, 'Allocation', 'Inventory', $3, $4, $5)
    `, [assetId, date || new Date(), `${employeeName} (${department || asset.department})`, actor, `Assigned Qty: ${qty}. ${notes || ''}`]);

    await client.query(`
      INSERT INTO system_logs (timestamp, actor, action, detail)
      VALUES ($1, $2, 'Asset Allocation', $3)
    `, [
      new Date().toLocaleString(),
      actor,
      `Allocated ${qty} of asset ${assetId} to ${employeeName}. Prev Available: ${asset.available_quantity}, New Available: ${newAvailableQty}`
    ]);

    await client.query('COMMIT');
    res.status(201).json(assignment);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Allocation failed: ' + err.message });
  } finally {
    client.release();
  }
});

app.post('/api/assignments/:id/return', async (req, res) => {
  const { id } = req.params;
  const { quantity, notes } = req.body;
  const returnQty = parseInt(quantity) || null;
  const actor = req.headers['x-user-username'] || 'Admin';

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const assignmentRes = await client.query('SELECT * FROM asset_assignments WHERE id = $1 FOR UPDATE', [id]);
    if (assignmentRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = assignmentRes.rows[0];
    if (assignment.status !== 'Assigned') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Assignment is already returned or inactive.' });
    }

    const finalReturnQty = returnQty !== null ? Math.min(returnQty, assignment.quantity) : assignment.quantity;

    const assetRes = await client.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [assignment.asset_id]);
    if (assetRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Asset not found' });
    }
    const asset = assetRes.rows[0];

    if (finalReturnQty === assignment.quantity) {
      await client.query('UPDATE asset_assignments SET status = \'Returned\', quantity = 0 WHERE id = $1', [id]);
    } else {
      await client.query('UPDATE asset_assignments SET quantity = quantity - $1 WHERE id = $2', [finalReturnQty, id]);
    }

    const newAssignedQty = Math.max(0, asset.assigned_quantity - finalReturnQty);
    const newAvailableQty = asset.total_quantity - newAssignedQty;
    const newStatus = newAvailableQty > 0 ? 'Available' : 'Assigned';

    const activeAssignmentsRes = await client.query(`
      SELECT employee_name, SUM(quantity) as qty
      FROM asset_assignments
      WHERE asset_id = $1 AND status = 'Assigned'
      GROUP BY employee_name
    `, [assignment.asset_id]);
    const summaryStr = activeAssignmentsRes.rows.map(row => `${row.employee_name} (${row.qty})`).join(', ') || '';

    await client.query(`
      UPDATE assets
      SET assigned_quantity = $1, available_quantity = $2, status = $3, assigned_employee = $4, updated_at = NOW()
      WHERE id = $5
    `, [newAssignedQty, newAvailableQty, newStatus, summaryStr, assignment.asset_id]);

    await client.query(`
      INSERT INTO movements (asset_id, date, type, from_loc, to_loc, actor, notes)
      VALUES ($1, CURRENT_DATE, 'Return', $2, 'Inventory', $3, $4)
    `, [assignment.asset_id, `${assignment.employee_name} (${assignment.department})`, actor, `Returned Qty: ${finalReturnQty}. ${notes || ''}`]);

    await client.query(`
      INSERT INTO system_logs (timestamp, actor, action, detail)
      VALUES ($1, $2, 'Asset Return', $3)
    `, [
      new Date().toLocaleString(),
      actor,
      `Returned ${finalReturnQty} of asset ${assignment.asset_id} from ${assignment.employee_name}. Prev Available: ${asset.available_quantity}, New Available: ${newAvailableQty}`
    ]);

    await client.query('COMMIT');
    res.json({ message: 'Assets returned successfully', returnedQuantity: finalReturnQty });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Return operation failed: ' + err.message });
  } finally {
    client.release();
  }
});

app.patch('/api/assignments/:id', async (req, res) => {
  const { id } = req.params;
  const { quantity, employeeName, department, notes } = req.body;
  const actor = req.headers['x-user-username'] || 'Admin';

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const assignmentRes = await client.query('SELECT * FROM asset_assignments WHERE id = $1 FOR UPDATE', [id]);
    if (assignmentRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = assignmentRes.rows[0];
    const prevQty = assignment.quantity;
    const newQty = quantity !== undefined ? parseInt(quantity) : prevQty;

    const assetRes = await client.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [assignment.asset_id]);
    if (assetRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Asset not found' });
    }
    const asset = assetRes.rows[0];

    const qtyDiff = newQty - prevQty;
    if (asset.available_quantity < qtyDiff) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient stock to adjust assignment. Available: ${asset.available_quantity}, Requested increase: ${qtyDiff}` });
    }

    let userId = assignment.user_id;
    let employeeNameDb = employeeName;
    if (employeeName) {
      const userRes = await client.query('SELECT id, name FROM users WHERE LOWER(name) = LOWER($1) OR LOWER(username) = LOWER($1)', [employeeName]);
      if (userRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Employee "${employeeName}" does not exist in the user directory.` });
      }
      userId = userRes.rows[0].id;
      employeeNameDb = userRes.rows[0].name;
    }

    await client.query(`
      UPDATE asset_assignments
      SET 
        employee_name = COALESCE($1, employee_name),
        user_id = $2,
        quantity = $3,
        department = COALESCE($4, department),
        notes = COALESCE($5, notes)
      WHERE id = $6
    `, [employeeNameDb || null, userId, newQty, department || null, notes || null, id]);

    const newAssignedQty = asset.assigned_quantity + qtyDiff;
    const newAvailableQty = asset.total_quantity - newAssignedQty;
    const newStatus = newAvailableQty > 0 ? 'Available' : 'Assigned';

    const activeAssignmentsRes = await client.query(`
      SELECT employee_name, SUM(quantity) as qty
      FROM asset_assignments
      WHERE asset_id = $1 AND status = 'Assigned'
      GROUP BY employee_name
    `, [assignment.asset_id]);
    const summaryStr = activeAssignmentsRes.rows.map(row => `${row.employee_name} (${row.qty})`).join(', ') || '';

    await client.query(`
      UPDATE assets
      SET assigned_quantity = $1, available_quantity = $2, status = $3, assigned_employee = $4, updated_at = NOW()
      WHERE id = $5
    `, [newAssignedQty, newAvailableQty, newStatus, summaryStr, assignment.asset_id]);

    await client.query(`
      INSERT INTO system_logs (timestamp, actor, action, detail)
      VALUES ($1, $2, 'Asset Assignment Update', $3)
    `, [
      new Date().toLocaleString(),
      actor,
      `Updated assignment ${id} for asset ${assignment.asset_id}. Quantity changed from ${prevQty} to ${newQty}.`
    ]);

    await client.query('COMMIT');
    res.json({ message: 'Assignment updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Assignment update failed: ' + err.message });
  } finally {
    client.release();
  }
});

// --- DEPARTMENTAL TICKETING SYSTEM APIS ---

// Map snake_case DB rows to camelCase for the frontend
const mapTicket = (row) => ({
  id: row.id,
  ticketId: row.ticket_id,
  subject: row.subject,
  description: row.description,
  department: row.department,
  priority: row.priority,
  status: row.status,
  category: row.category || 'Software',
  createdBy: row.created_by,
  createdByName: row.created_by_name,
  assignedTo: row.assigned_to,
  assignedToName: row.assigned_to_name,
  slaDeadline: row.sla_deadline,
  resolvedAt: row.resolved_at,
  closedAt: row.closed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapComment = (row) => ({
  id: row.id,
  ticketId: row.ticket_id,
  authorName: row.author_name,
  authorId: row.author_id,
  commentText: row.comment_text,
  text: row.comment_text,
  isInternal: row.is_internal,
  createdAt: row.created_at
});

const mapTimeline = (row) => ({
  id: row.id,
  ticketId: row.ticket_id,
  actorName: row.actor_name,
  action: row.action,
  detail: row.detail,
  createdAt: row.created_at
});

const mapAttachment = (row) => ({
  id: row.id,
  ticketId: row.ticket_id,
  name: row.file_name,
  fileName: row.file_name,
  fileUrl: row.file_url,
  fileType: row.file_type,
  fileSize: row.file_size,
  uploadedBy: row.uploaded_by,
  createdAt: row.created_at
});

app.get('/api/tickets', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  let query = 'SELECT * FROM tickets';
  const params = [];

  if (user.role === 'Super Admin') {
    query += ' ORDER BY created_at DESC';
  } else if (user.role === 'Employee') {
    query += ' WHERE created_by = $1 ORDER BY created_at DESC';
    params.push(user.id);
  } else {
    query += ' WHERE department = $1 ORDER BY created_at DESC';
    params.push(user.department || '');
  }

  try {
    const result = await db.query(query, params);
    res.json(result.rows.map(mapTicket));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

// --- BULK TICKET OPERATIONS (must be defined before /:id routes) ---
app.post('/api/tickets/bulk/status', async (req, res) => {
  const { ticketIds, status } = req.body;
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role === 'Employee') return res.status(403).json({ error: 'Employees cannot bulk update.' });

  const validStatuses = ['Open', 'In Progress', 'Pending', 'On Hold', 'Resolved', 'Closed', 'Reopened', 'Waiting for Employee'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const tid of ticketIds) {
      const ticketRes = await client.query('SELECT * FROM tickets WHERE id = $1', [tid]);
      if (ticketRes.rows.length > 0) {
        const ticket = ticketRes.rows[0];
        const prev = ticket.status;
        const now = new Date();
        let resolvedAt = ticket.resolved_at;
        let closedAt = ticket.closed_at;
        if (status === 'Resolved') resolvedAt = now;
        else if (status === 'Closed') closedAt = now;

        await client.query('UPDATE tickets SET status = $1, resolved_at = $2, closed_at = $3, updated_at = NOW() WHERE id = $4', [status, resolvedAt, closedAt, tid]);
        await client.query(`
          INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
          VALUES ($1, $2, 'Status Changed', $3)
        `, [tid, user.name || user.username, `Bulk status changed from ${prev} to ${status}`]);
      }
    }
    await client.query('COMMIT');
    res.json({ message: 'Bulk status updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed bulk status update' });
  } finally {
    client.release();
  }
});

app.post('/api/tickets/bulk/priority', async (req, res) => {
  const { ticketIds, priority } = req.body;
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role === 'Employee') return res.status(403).json({ error: 'Employees cannot bulk update.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const tid of ticketIds) {
      const ticketRes = await client.query('SELECT * FROM tickets WHERE id = $1', [tid]);
      if (ticketRes.rows.length > 0) {
        const ticket = ticketRes.rows[0];
        const prev = ticket.priority;
        await client.query('UPDATE tickets SET priority = $1, updated_at = NOW() WHERE id = $2', [priority, tid]);
        await client.query(`
          INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
          VALUES ($1, $2, 'Priority Changed', $3)
        `, [tid, user.name || user.username, `Bulk priority changed from ${prev} to ${priority}`]);
      }
    }
    await client.query('COMMIT');
    res.json({ message: 'Bulk priority updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed bulk priority update' });
  } finally {
    client.release();
  }
});

app.post('/api/tickets/bulk/category', async (req, res) => {
  const { ticketIds, category } = req.body;
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role === 'Employee') return res.status(403).json({ error: 'Employees cannot bulk update.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const tid of ticketIds) {
      const ticketRes = await client.query('SELECT * FROM tickets WHERE id = $1', [tid]);
      if (ticketRes.rows.length > 0) {
        const ticket = ticketRes.rows[0];
        const prev = ticket.category || 'Software';
        await client.query('UPDATE tickets SET category = $1, updated_at = NOW() WHERE id = $2', [category, tid]);
        await client.query(`
          INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
          VALUES ($1, $2, 'Category Changed', $3)
        `, [tid, user.name || user.username, `Bulk category changed from ${prev} to ${category}`]);
      }
    }
    await client.query('COMMIT');
    res.json({ message: 'Bulk category updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed bulk category update' });
  } finally {
    client.release();
  }
});

app.post('/api/tickets/bulk/department', async (req, res) => {
  const { ticketIds, department } = req.body;
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role !== 'Super Admin') return res.status(403).json({ error: 'Only Super Admins can reassign departments.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const tid of ticketIds) {
      const ticketRes = await client.query('SELECT * FROM tickets WHERE id = $1', [tid]);
      if (ticketRes.rows.length > 0) {
        const ticket = ticketRes.rows[0];
        const prev = ticket.department;
        await client.query('UPDATE tickets SET department = $1, updated_at = NOW() WHERE id = $2', [department, tid]);
        await client.query(`
          INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
          VALUES ($1, $2, 'Department Changed', $3)
        `, [tid, user.name || user.username, `Bulk department reassigned from ${prev} to ${department}`]);
      }
    }
    await client.query('COMMIT');
    res.json({ message: 'Bulk department reassigned successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed bulk department reassignment' });
  } finally {
    client.release();
  }
});

app.post('/api/tickets/bulk/assign', async (req, res) => {
  const ticketIds = req.body.ticketIds || req.body.ticket_ids;
  const assignToUserId = req.body.assignToUserId || req.body.assign_to_user_id;
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role === 'Employee') return res.status(403).json({ error: 'Employees cannot bulk assign.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    let targetName = null;
    let targetId = null;

    if (assignToUserId) {
      const targetUserRes = await client.query('SELECT id, name, username FROM users WHERE id = $1', [assignToUserId]);
      if (targetUserRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Target user not found.' });
      }
      targetName = targetUserRes.rows[0].name || targetUserRes.rows[0].username;
      targetId = targetUserRes.rows[0].id;
    } else {
      targetName = user.name || user.username;
      targetId = user.id;
    }

    for (const tid of ticketIds) {
      await client.query('UPDATE tickets SET assigned_to = $1, assigned_to_name = $2, status = \'In Progress\', updated_at = NOW() WHERE id = $3', [targetId, targetName, tid]);
      await client.query(`
        INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
        VALUES ($1, $2, 'Assigned', $3)
      `, [tid, user.name || user.username, `Bulk assigned ticket to ${targetName}`]);
    }
    await client.query('COMMIT');
    res.json({ message: 'Bulk assignment updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed bulk assignment' });
  } finally {
    client.release();
  }
});

app.post('/api/tickets/bulk/delete', async (req, res) => {
  const { ticketIds } = req.body;
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role === 'Employee') return res.status(403).json({ error: 'Employees cannot bulk delete.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const tid of ticketIds) {
      await client.query('DELETE FROM tickets WHERE id = $1', [tid]);
    }
    await client.query('COMMIT');
    res.json({ message: 'Bulk deletion successfully executed' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed bulk deletion' });
  } finally {
    client.release();
  }
});
// --- END BULK TICKET OPERATIONS ---

app.get('/api/tickets/:id', async (req, res) => {
  const { id } = req.params;
  const user = requireUser(req, res);
  if (!user) return;

  try {
    let ticketRes;
    const isInteger = /^\d+$/.test(id);
    if (isInteger) {
      ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1 OR ticket_id = $2::text', [parseInt(id), String(id)]);
    } else {
      ticketRes = await db.query('SELECT * FROM tickets WHERE ticket_id = $1', [id]);
    }
    if (ticketRes.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const ticket = ticketRes.rows[0];

    if (user.role !== 'Super Admin' && user.role !== 'Employee' && ticket.department !== user.department) {
      return res.status(403).json({ error: 'Access denied to this ticket queue.' });
    }
    if (user.role === 'Employee' && ticket.created_by !== user.id) {
      return res.status(403).json({ error: 'Access denied: You can only view your own tickets.' });
    }

    let commentsQuery = 'SELECT * FROM ticket_comments WHERE ticket_id = $1';
    const commentsParams = [ticket.id];
    if (user.role === 'Employee') {
      commentsQuery += ' AND is_internal = FALSE';
    }
    commentsQuery += ' ORDER BY created_at ASC';
    const commentsRes = await db.query(commentsQuery, commentsParams);

    const timelineRes = await db.query('SELECT * FROM ticket_timeline WHERE ticket_id = $1 ORDER BY created_at ASC', [ticket.id]);
    const attachmentsRes = await db.query('SELECT * FROM ticket_attachments WHERE ticket_id = $1 ORDER BY created_at ASC', [ticket.id]);

    res.json({
      ...mapTicket(ticket),
      comments: commentsRes.rows.map(mapComment),
      timeline: timelineRes.rows.map(mapTimeline),
      attachments: attachmentsRes.rows.map(mapAttachment)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

app.post('/api/tickets', async (req, res) => {
  const { subject, description, department, priority, attachments } = req.body;
  const user = requireUser(req, res);
  if (!user) return;

  if (!subject || !description || !department || !priority) {
    return res.status(400).json({ error: 'Subject, description, department, and priority are required.' });
  }

  let slaHours = 24;
  if (priority === 'Critical') slaHours = 10;
  else if (priority === 'Low') slaHours = 48;

  const slaDeadline = new Date();
  slaDeadline.setHours(slaDeadline.getHours() + slaHours);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const insertQuery = `
      INSERT INTO tickets (subject, description, department, priority, status, created_by, created_by_name, sla_deadline, ticket_id)
      VALUES ($1, $2, $3, $4, 'Open', $5, $6, $7, '')
      RETURNING *;
    `;
    const result = await client.query(insertQuery, [
      subject, description, department, priority, user.id, user.name || user.username, slaDeadline
    ]);
    const ticket = result.rows[0];

    const deptCode = department === 'IT' ? 'IT' : department === 'HR' ? 'HR' : department === 'Finance' ? 'FIN' : department.substring(0, 3).toUpperCase();
    const ticketId = `${deptCode}-${String(ticket.id).padStart(6, '0')}`;
    await client.query('UPDATE tickets SET ticket_id = $1 WHERE id = $2', [ticketId, ticket.id]);
    ticket.ticket_id = ticketId;

    await client.query(`
      INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
      VALUES ($1, $2, 'Created', 'Ticket created by employee')
    `, [ticket.id, user.name || user.username]);

    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        await client.query(`
          INSERT INTO ticket_attachments (ticket_id, file_name, file_url, file_type, file_size, uploaded_by)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [ticket.id, att.name, att.fileUrl, att.fileType, att.fileSize, user.name || user.username]);
      }
    }

    const notifId = `NTF-TKT-${ticketId}-${Date.now()}`;
    const text = `New ${priority} Ticket ${ticketId} created in ${department}: "${subject}"`;
    await client.query(`
      INSERT INTO notifications (id, text, type, time, read)
      VALUES ($1, $2, $3, 'Just now', FALSE)
    `, [notifId, text, priority === 'Critical' ? 'error' : priority === 'Medium' ? 'warning' : 'info']);

    await client.query(`
      INSERT INTO system_logs (timestamp, actor, action, detail)
      VALUES ($1, $2, 'Ticket Creation', $3)
    `, [new Date().toLocaleString(), user.name || user.username, `Created Ticket ${ticketId} in ${department} department`]);

    await client.query('COMMIT');
    res.status(201).json(mapTicket(ticket));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Ticket creation failed: ' + err.message });
  } finally {
    client.release();
  }
});

app.post('/api/tickets/:id/comments', async (req, res) => {
  const { id } = req.params;
  const commentText = req.body.commentText || req.body.comment_text;
  const isInternal = req.body.isInternal !== undefined ? req.body.isInternal : req.body.is_internal;
  const user = requireUser(req, res);
  if (!user) return;

  if (!commentText) {
    return res.status(400).json({ error: 'Comment text is required.' });
  }

  const isInt = !!isInternal;
  if (isInt && user.role === 'Employee') {
    return res.status(403).json({ error: 'Employees cannot post internal comments.' });
  }

  try {
    const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
    if (ticketRes.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const ticket = ticketRes.rows[0];

    const commentRes = await db.query(`
      INSERT INTO ticket_comments (ticket_id, author_name, author_id, comment_text, is_internal)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `, [ticket.id, user.name || user.username, user.id, commentText, isInt]);

    await db.query(`
      INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
      VALUES ($1, $2, 'Comment Added', $3)
    `, [ticket.id, user.name || user.username, isInt ? 'Added internal comment' : 'Added public comment']);

    const notifId = `NTF-CMT-${ticket.ticket_id}-${Date.now()}`;
    const notifText = `${user.name || user.username} commented on ticket ${ticket.ticket_id}`;
    await db.query(`
      INSERT INTO notifications (id, text, type, time, read)
      VALUES ($1, $2, 'info', 'Just now', FALSE)
    `, [notifId, notifText]);

    res.status(201).json(commentRes.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

app.post('/api/tickets/:id/assign', async (req, res) => {
  const { id } = req.params;
  const assignToUserId = req.body.assignToUserId || req.body.assign_to_user_id;
  const user = requireUser(req, res);
  if (!user) return;

  if (user.role === 'Employee') {
    return res.status(403).json({ error: 'Employees cannot assign tickets.' });
  }

  try {
    const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
    if (ticketRes.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const ticket = ticketRes.rows[0];

    let targetName = null;
    let targetId = null;

    if (assignToUserId) {
      const targetUserRes = await db.query('SELECT id, name, username FROM users WHERE id = $1', [assignToUserId]);
      if (targetUserRes.rows.length === 0) {
        return res.status(400).json({ error: 'Target user not found.' });
      }
      targetName = targetUserRes.rows[0].name || targetUserRes.rows[0].username;
      targetId = targetUserRes.rows[0].id;
    } else {
      targetName = user.name || user.username;
      targetId = user.id;
    }

    await db.query(`
      UPDATE tickets
      SET assigned_to = $1, assigned_to_name = $2, status = 'In Progress', updated_at = NOW()
      WHERE id = $3
    `, [targetId, targetName, ticket.id]);

    await db.query(`
      INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
      VALUES ($1, $2, 'Assigned', $3)
    `, [ticket.id, user.name || user.username, `Assigned ticket to ${targetName}`]);

    await db.query(`
      INSERT INTO system_logs (timestamp, actor, action, detail)
      VALUES ($1, $2, 'Ticket Assignment', $3)
    `, [new Date().toLocaleString(), user.name || user.username, `Assigned Ticket ${ticket.ticket_id} to ${targetName}`]);

    const notifId = `NTF-ASN-${ticket.ticket_id}-${Date.now()}`;
    await db.query(`
      INSERT INTO notifications (id, text, type, time, read)
      VALUES ($1, $2, 'info', 'Just now', FALSE)
    `, [notifId, `Ticket ${ticket.ticket_id} has been assigned to ${targetName}`]);

    res.json({ message: 'Ticket assigned successfully', assignedToName: targetName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Assignment failed' });
  }
});

app.patch('/api/tickets/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const user = requireUser(req, res);
  if (!user) return;

  const validStatuses = ['Open', 'In Progress', 'Waiting for Employee', 'Resolved', 'Closed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value.' });
  }

  try {
    const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
    if (ticketRes.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const ticket = ticketRes.rows[0];

    if (user.role === 'Employee' && ticket.created_by !== user.id) {
      return res.status(403).json({ error: 'Employees can only close their own tickets.' });
    }

    const prevStatus = ticket.status;
    const now = new Date();
    let resolvedAt = ticket.resolved_at;
    let closedAt = ticket.closed_at;

    if (status === 'Resolved') {
      resolvedAt = now;
    } else if (status === 'Closed') {
      closedAt = now;
    }

    await db.query(`
      UPDATE tickets
      SET status = $1, resolved_at = $2, closed_at = $3, updated_at = NOW()
      WHERE id = $4
    `, [status, resolvedAt, closedAt, ticket.id]);

    await db.query(`
      INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
      VALUES ($1, $2, 'Status Changed', $3)
    `, [ticket.id, user.name || user.username, `Status changed from ${prevStatus} to ${status}`]);

    await db.query(`
      INSERT INTO system_logs (timestamp, actor, action, detail)
      VALUES ($1, $2, 'Ticket Status Update', $3)
    `, [new Date().toLocaleString(), user.name || user.username, `Updated Ticket ${ticket.ticket_id} status from ${prevStatus} to ${status}`]);

    const notifId = `NTF-STS-${ticket.ticket_id}-${Date.now()}`;
    await db.query(`
      INSERT INTO notifications (id, text, type, time, read)
      VALUES ($1, $2, 'info', 'Just now', FALSE)
    `, [notifId, `Ticket ${ticket.ticket_id} status updated to ${status}`]);

    res.json({ message: 'Ticket status updated successfully', status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update ticket status' });
  }
});

app.patch('/api/tickets/:id/priority', async (req, res) => {
  const { id } = req.params;
  const { priority } = req.body;
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role === 'Employee') return res.status(403).json({ error: 'Employees cannot change priority.' });

  const validPriorities = ['Critical', 'Medium', 'Low'];
  if (!validPriorities.includes(priority)) return res.status(400).json({ error: 'Invalid priority.' });

  try {
    const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
    if (ticketRes.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = ticketRes.rows[0];

    const prevPriority = ticket.priority;
    await db.query('UPDATE tickets SET priority = $1, updated_at = NOW() WHERE id = $2', [priority, ticket.id]);

    await db.query(`
      INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
      VALUES ($1, $2, 'Priority Changed', $3)
    `, [ticket.id, user.name || user.username, `Priority changed from ${prevPriority} to ${priority}`]);

    const notifId = `NTF-PRI-${ticket.ticket_id}-${Date.now()}`;
    await db.query(`
      INSERT INTO notifications (id, text, type, time, read)
      VALUES ($1, $2, 'info', 'Just now', FALSE)
    `, [notifId, `Ticket ${ticket.ticket_id} priority updated to ${priority}`]);

    res.json({ message: 'Priority updated successfully', priority });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update priority' });
  }
});

app.patch('/api/tickets/:id/category', async (req, res) => {
  const { id } = req.params;
  const { category } = req.body;
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role === 'Employee') return res.status(403).json({ error: 'Employees cannot change category.' });

  try {
    const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
    if (ticketRes.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = ticketRes.rows[0];

    const prevCategory = ticket.category || 'Software';
    await db.query('UPDATE tickets SET category = $1, updated_at = NOW() WHERE id = $2', [category, ticket.id]);

    await db.query(`
      INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
      VALUES ($1, $2, 'Category Changed', $3)
    `, [ticket.id, user.name || user.username, `Category changed from ${prevCategory} to ${category}`]);

    res.json({ message: 'Category updated successfully', category });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

app.patch('/api/tickets/:id/department', async (req, res) => {
  const { id } = req.params;
  const { department } = req.body;
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role !== 'Super Admin') return res.status(403).json({ error: 'Only Super Admins can reassign departments.' });

  try {
    const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
    if (ticketRes.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = ticketRes.rows[0];

    const prevDept = ticket.department;
    await db.query('UPDATE tickets SET department = $1, updated_at = NOW() WHERE id = $2', [department, ticket.id]);

    await db.query(`
      INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
      VALUES ($1, $2, 'Department Changed', $3)
    `, [ticket.id, user.name || user.username, `Department reassigned from ${prevDept} to ${department}`]);

    res.json({ message: 'Department updated successfully', department });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update department' });
  }
});


app.post('/api/tickets/:id/auto-assign', async (req, res) => {
  const { id } = req.params;
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role === 'Employee') return res.status(403).json({ error: 'Employees cannot trigger auto-assign.' });

  try {
    const ticketRes = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
    if (ticketRes.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = ticketRes.rows[0];

    const agentsRes = await db.query(`
      SELECT id, name, username, department FROM users 
      WHERE role IN ('Super Admin', 'IT Admin', 'Facility Admin', 'Finance Team', 'Auditor')
    `);

    let eligibleAgents = agentsRes.rows.filter(a => a.department === ticket.department);
    if (eligibleAgents.length === 0) {
      eligibleAgents = agentsRes.rows;
    }

    if (eligibleAgents.length === 0) {
      return res.status(400).json({ error: 'No eligible agents found for auto-assignment.' });
    }

    const workloadCounts = {};
    for (const agent of eligibleAgents) {
      const activeTicketsRes = await db.query(`
        SELECT COUNT(*) FROM tickets 
        WHERE assigned_to = $1 AND status IN ('Open', 'In Progress', 'Pending', 'On Hold', 'Reopened')
      `, [agent.id]);
      workloadCounts[agent.id] = parseInt(activeTicketsRes.rows[0].count);
    }

    eligibleAgents.sort((a, b) => workloadCounts[a.id] - workloadCounts[b.id]);
    const chosenAgent = eligibleAgents[0];

    const targetName = chosenAgent.name || chosenAgent.username;
    const targetId = chosenAgent.id;

    await db.query(`
      UPDATE tickets
      SET assigned_to = $1, assigned_to_name = $2, status = 'In Progress', updated_at = NOW()
      WHERE id = $3
    `, [targetId, targetName, ticket.id]);

    await db.query(`
      INSERT INTO ticket_timeline (ticket_id, actor_name, action, detail)
      VALUES ($1, $2, 'Assigned', $3)
    `, [ticket.id, user.name || user.username, `Auto-assigned ticket to ${targetName} based on workload (${workloadCounts[targetId]} active tickets)`]);

    const notifId = `NTF-ASN-${ticket.ticket_id}-${Date.now()}`;
    await db.query(`
      INSERT INTO notifications (id, text, type, time, read)
      VALUES ($1, $2, 'info', 'Just now', FALSE)
    `, [notifId, `Ticket ${ticket.ticket_id} has been automatically assigned to ${targetName}`]);

    res.json({ message: 'Ticket auto-assigned successfully', assignedToName: targetName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Auto-assignment failed' });
  }
});

app.get('/api/tickets-analytics', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  let scopeQuery = '';
  const params = [];

  if (user.role !== 'Super Admin') {
    scopeQuery = ' WHERE department = $1';
    params.push(user.department);
  }

  try {
    const statusCounts = await db.query(
      `SELECT status, COUNT(*) as count FROM tickets${scopeQuery} GROUP BY status`,
      params
    );

    const overdueRes = await db.query(
      `SELECT COUNT(*) as count FROM tickets
       WHERE sla_deadline < CURRENT_TIMESTAMP 
         AND status NOT IN ('Resolved', 'Closed')
         ${scopeQuery ? 'AND department = $1' : ''}`,
      params
    );

    const priorityCounts = await db.query(
      `SELECT priority, COUNT(*) as count FROM tickets${scopeQuery} GROUP BY priority`,
      params
    );

    const deptCounts = await db.query(
      `SELECT department, COUNT(*) as count FROM tickets${scopeQuery} GROUP BY department`,
      params
    );

    const avgResTimeRes = await db.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) as avg_hours 
       FROM tickets 
       WHERE resolved_at IS NOT NULL 
         ${scopeQuery ? 'AND department = $1' : ''}`,
      params
    );

    const counts = {
      total: 0,
      open: 0,
      inProgress: 0,
      waiting: 0,
      resolved: 0,
      closed: 0,
      overdue: parseInt(overdueRes.rows[0].count) || 0,
      avgResolutionTimeHours: avgResTimeRes.rows[0].avg_hours ? parseFloat(parseFloat(avgResTimeRes.rows[0].avg_hours).toFixed(1)) : 0
    };

    statusCounts.rows.forEach(row => {
      const cnt = parseInt(row.count);
      counts.total += cnt;
      if (row.status === 'Open') counts.open = cnt;
      else if (row.status === 'In Progress') counts.inProgress = cnt;
      else if (row.status === 'Waiting for Employee') counts.waiting = cnt;
      else if (row.status === 'Resolved') counts.resolved = cnt;
      else if (row.status === 'Closed') counts.closed = cnt;
    });

    res.json({
      counts,
      byPriority: priorityCounts.rows.reduce((acc, row) => {
        acc[row.priority] = parseInt(row.count);
        return acc;
      }, {}),
      byDepartment: deptCounts.rows.reduce((acc, row) => {
        acc[row.department] = parseInt(row.count);
        return acc;
      }, {})
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// --- AUTHENTICATION API ---
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Please enter both username and password.' });
  }

  try {
    const result = await db.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
      [username]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      session: {
        id: user.id,
        username: user.username,
        role: user.role,
        name: user.name,
        email: user.email,
        employeeId: user.employee_id,
        phoneNumber: user.phone_number,
        department: user.department,
        designation: user.designation,
        status: user.status,
        passwordResetRequired: user.password_reset_required
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/change-password', async (req, res) => {
  const { username, currentPassword, newPassword } = req.body;
  if (!username || !newPassword) {
    return res.status(400).json({ error: 'Username and new password are required.' });
  }

  try {
    const result = await db.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    if (currentPassword) {
      const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
      if (!isMatch) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await db.query(
      'UPDATE users SET password_hash = $1, password_reset_required = FALSE WHERE id = $2',
      [passwordHash, user.id]
    );

    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

// --- USER MANAGEMENT API ---
app.get('/api/users', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, username, name, role, email, employee_id, phone_number, department, designation, status, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

app.post('/api/users', async (req, res) => {
  const { username, password, name, role, email, employeeId, phoneNumber, department, designation, status } = req.body;
  if (!username || !password || !name || !role || !email) {
    return res.status(400).json({ error: 'All fields are required (username, password, name, role, email).' });
  }

  // Validate phone number format
  let formattedPhone = '';
  if (phoneNumber) {
    const phoneValidation = validateAndFormatPhone(phoneNumber);
    if (!phoneValidation.isValid) {
      return res.status(400).json({ error: phoneValidation.error });
    }
    formattedPhone = phoneValidation.value;
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const createdUser = await createSingleUser(client, {
      username,
      password,
      name,
      role,
      email,
      employeeId,
      phoneNumber: formattedPhone,
      department,
      designation,
      status,
      resetRequired: false
    });
    await client.query('COMMIT');
    res.status(201).json(createdUser);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during manual user creation:', err);
    res.status(400).json({ error: err.message || 'Database insertion failed.' });
  } finally {
    client.release();
  }
});

// PATCH /api/users/:id - Edit User Details
app.patch('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const { name, role, email, employeeId, phoneNumber, department, designation, status, password } = req.body;

  let formattedPhone = '';
  if (phoneNumber) {
    const phoneValidation = validateAndFormatPhone(phoneNumber);
    if (!phoneValidation.isValid) {
      return res.status(400).json({ error: phoneValidation.error });
    }
    formattedPhone = phoneValidation.value;
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Check if user exists
    const userResult = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    // Check duplicate email
    let finalUsername = user.username;
    if (email && email.toLowerCase() !== user.email?.toLowerCase()) {
      const emailExists = await client.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2', [email, id]);
      if (emailExists.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Email address is already registered by another user.' });
      }

      const emailParts = email.split('@');
      finalUsername = emailParts[0];

      // Check duplicate username
      const usernameExists = await client.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2', [finalUsername, id]);
      if (usernameExists.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Username '${finalUsername}' already exists. Please use a unique Email address.` });
      }
    }

    // Check duplicate employee ID
    if (employeeId && (user.employee_id === null || employeeId.toLowerCase() !== user.employee_id.toLowerCase())) {
      const empIdExists = await client.query('SELECT 1 FROM users WHERE LOWER(employee_id) = LOWER($1) AND id <> $2', [employeeId, id]);
      if (empIdExists.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Employee ID '${employeeId}' already exists. Please use a unique Employee ID.` });
      }
    }

    let passwordHash = user.password_hash;
    if (password) {
      const salt = await bcrypt.genSalt(10);
      passwordHash = await bcrypt.hash(password, salt);
    }

    // Update auth.users if auth_id exists
    if (user.auth_id) {
      const authUpdateQuery = `
        UPDATE auth.users
        SET email = COALESCE($1, email),
            encrypted_password = COALESCE($2, encrypted_password),
            raw_user_meta_data = raw_user_meta_data || $3::jsonb,
            updated_at = NOW()
        WHERE id = $4
      `;
      const metadata = JSON.stringify({
        name: name || user.name,
        role: role || user.role,
        username: finalUsername || user.username
      });
      await client.query(authUpdateQuery, [email || null, password ? passwordHash : null, metadata, user.auth_id]);
    }

    const query = `
      UPDATE users 
      SET name = COALESCE($1, name),
          role = COALESCE($2, role),
          email = COALESCE($3, email),
          employee_id = COALESCE($4, employee_id),
          phone_number = COALESCE($5, phone_number),
          department = COALESCE($6, department),
          designation = COALESCE($7, designation),
          status = COALESCE($8, status),
          password_hash = $9,
          username = COALESCE($11, username)
      WHERE id = $10
      RETURNING id, username, name, role, email, employee_id, phone_number, department, designation, status, password_reset_required, created_at;
    `;
    const values = [
      name,
      role,
      email,
      employeeId,
      formattedPhone || phoneNumber || '',
      department,
      designation,
      status,
      passwordHash,
      id,
      finalUsername
    ];
    const result = await client.query(query, values);
    
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database update failed: ' + (err.detail || err.message) });
  } finally {
    client.release();
  }
});

// DELETE /api/users/:id - Delete User
app.delete('/api/users/:id', async (req, res) => {
  const { id } = req.params;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const check = await client.query('SELECT username, auth_id FROM users WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    const { username, auth_id } = check.rows[0];
    
    // Find affected assets before deleting assignments
    const affectedAssets = await client.query('SELECT DISTINCT asset_id FROM asset_assignments WHERE user_id = $1', [id]);
    const affectedAssetIds = affectedAssets.rows.map(r => r.asset_id);

    await client.query('DELETE FROM asset_assignments WHERE user_id = $1', [id]);
    if (auth_id) {
      await client.query('DELETE FROM auth.users WHERE id = $1', [auth_id]);
    } else {
      await client.query('DELETE FROM users WHERE id = $1', [id]);
    }

    // Recalculate quantities for each affected asset
    for (const assetId of affectedAssetIds) {
      const activeAssignmentsRes = await client.query(`
        SELECT employee_name, SUM(quantity) as qty
        FROM asset_assignments
        WHERE asset_id = $1 AND status = 'Assigned'
        GROUP BY employee_name
      `, [assetId]);
      
      const newAssignedQty = activeAssignmentsRes.rows.reduce((sum, row) => sum + parseInt(row.qty), 0);
      const summaryStr = activeAssignmentsRes.rows.map(row => `${row.employee_name} (${row.qty})`).join(', ') || '';
      
      const assetInfo = await client.query('SELECT total_quantity FROM assets WHERE id = $1', [assetId]);
      if (assetInfo.rows.length > 0) {
        const newAvailableQty = Math.max(0, assetInfo.rows[0].total_quantity - newAssignedQty);
        const newStatus = newAvailableQty > 0 ? 'Available' : 'Assigned';
        
        await client.query(`
          UPDATE assets
          SET 
            assigned_quantity = $1, 
            available_quantity = $2,
            status = $3,
            assigned_employee = $4,
            updated_at = NOW()
          WHERE id = $5
        `, [newAssignedQty, newAvailableQty, newStatus, summaryStr || null, assetId]);
      }
    }

    await client.query('COMMIT');
    res.json({ message: `User "${username}" deleted successfully` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database deletion failed' });
  } finally {
    client.release();
  }
});

// POST /api/users/bulk/delete - Bulk Delete Users
app.post('/api/users/bulk/delete', async (req, res) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: 'Payload must contain a userIds array' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const check = await client.query('SELECT auth_id, id FROM users WHERE id = ANY($1::int[])', [userIds]);
    const authIds = check.rows.map(r => r.auth_id).filter(Boolean);
    const foundIds = check.rows.map(r => r.id);
    
    // Find affected assets before deleting assignments
    const affectedAssets = await client.query('SELECT DISTINCT asset_id FROM asset_assignments WHERE user_id = ANY($1::int[])', [foundIds]);
    const affectedAssetIds = affectedAssets.rows.map(r => r.asset_id);

    await client.query('DELETE FROM asset_assignments WHERE user_id = ANY($1::int[])', [foundIds]);
    if (authIds.length > 0) {
      await client.query('DELETE FROM auth.users WHERE id = ANY($1::uuid[])', [authIds]);
    }
    await client.query('DELETE FROM users WHERE id = ANY($1::int[])', [foundIds]);
    
    // Recalculate quantities for each affected asset
    for (const assetId of affectedAssetIds) {
      const activeAssignmentsRes = await client.query(`
        SELECT employee_name, SUM(quantity) as qty
        FROM asset_assignments
        WHERE asset_id = $1 AND status = 'Assigned'
        GROUP BY employee_name
      `, [assetId]);
      
      const newAssignedQty = activeAssignmentsRes.rows.reduce((sum, row) => sum + parseInt(row.qty), 0);
      const summaryStr = activeAssignmentsRes.rows.map(row => `${row.employee_name} (${row.qty})`).join(', ') || '';
      
      const assetInfo = await client.query('SELECT total_quantity FROM assets WHERE id = $1', [assetId]);
      if (assetInfo.rows.length > 0) {
        const newAvailableQty = Math.max(0, assetInfo.rows[0].total_quantity - newAssignedQty);
        const newStatus = newAvailableQty > 0 ? 'Available' : 'Assigned';
        
        await client.query(`
          UPDATE assets
          SET 
            assigned_quantity = $1, 
            available_quantity = $2,
            status = $3,
            assigned_employee = $4,
            updated_at = NOW()
          WHERE id = $5
        `, [newAssignedQty, newAvailableQty, newStatus, summaryStr || null, assetId]);
      }
    }

    await client.query('COMMIT');
    res.json({ message: `${userIds.length} users deleted successfully` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Bulk deletion failed' });
  } finally {
    client.release();
  }
});

// POST /api/users/bulk/status - Bulk Change Status (Activate/Deactivate)
app.post('/api/users/bulk/status', async (req, res) => {
  const { userIds, status } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0 || !status) {
    return res.status(400).json({ error: 'Payload must contain userIds array and status' });
  }
  try {
    await db.query('UPDATE users SET status = $1 WHERE id = ANY($2::int[])', [status, userIds]);
    res.json({ message: `Status updated to "${status}" for ${userIds.length} users` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk status update failed' });
  }
});

// POST /api/users/bulk/reset-password - Bulk Reset Password
app.post('/api/users/bulk/reset-password', async (req, res) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: 'Payload must contain a userIds array' });
  }
  try {
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash('Welcome@123', salt);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = ANY($2::int[])', [passwordHash, userIds]);
    res.json({ message: `Password reset to "Welcome@123" for ${userIds.length} users` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk password reset failed' });
  }
});

// POST /api/users/bulk/department - Bulk Change Department
app.post('/api/users/bulk/department', async (req, res) => {
  const { userIds, department } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0 || !department) {
    return res.status(400).json({ error: 'Payload must contain userIds array and department' });
  }
  try {
    await db.query('UPDATE users SET department = $1 WHERE id = ANY($2::int[])', [department, userIds]);
    res.json({ message: `Department updated to "${department}" for ${userIds.length} users` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk department update failed' });
  }
});

// POST /api/users/bulk/role - Bulk Change Role
app.post('/api/users/bulk/role', async (req, res) => {
  const { userIds, role } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0 || !role) {
    return res.status(400).json({ error: 'Payload must contain userIds array and role' });
  }
  try {
    await db.query('UPDATE users SET role = $1 WHERE id = ANY($2::int[])', [role, userIds]);
    res.json({ message: `Role updated to "${role}" for ${userIds.length} users` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Bulk role update failed' });
  }
});

// --- FILE UPLOAD API ---
// Uploads write into your storage bucket, so they require a signed-in user.
// `fileUrl` is kept as the response key for compatibility, but it now carries a
// durable storage *path* rather than a URL. Resolve it via /api/files/signed-url.
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const filePath = await storage.saveFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    res.json({
      name: req.file.originalname,
      fileName: filePath.split('/').pop(),
      fileSize: `${(req.file.size / 1024).toFixed(1)} KB`,
      fileUrl: filePath
    });
  } catch (err) {
    console.error('File upload failed:', err);
    res.status(500).json({ error: err.message || 'File upload failed' });
  }
});

// Mints a short-lived link to a stored file. Because the bucket is private, this
// is the only way to read one — and it requires authentication.
app.post('/api/files/signed-url', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const filePath = req.body?.path;
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'A file path is required' });
  }

  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = await storage.getSignedUrl(filePath, baseUrl);
    res.json({ url, expiresIn: storage.SIGNED_URL_TTL_SECONDS });
  } catch (err) {
    console.error('Could not sign file URL:', err);
    res.status(404).json({ error: err.message || 'File is not available' });
  }
});

// --- DAILY EXPIRATIONS CRON JOB ---
const runExpirationsCheck = async () => {
  console.log('Running daily expiration check for warranties and AMCs...');
  const today = new Date();
  
  try {
    // 1. Check Expiring Warranties (within 90 days)
    const assetsRes = await db.query("SELECT * FROM assets WHERE warranty_expiry IS NOT NULL AND status != 'Disposed'");
    for (const asset of assetsRes.rows) {
      const expiry = new Date(asset.warranty_expiry);
      const diffTime = expiry - today;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      if (diffDays > 0 && diffDays <= 90) {
        const notifId = `NTF-WARR-${asset.id}`;
        const text = `Warranty expiring in ${diffDays} days for Asset ${asset.id} (${asset.name})`;
        
        const existsRes = await db.query('SELECT 1 FROM notifications WHERE id = $1', [notifId]);
        if (existsRes.rows.length === 0) {
          await db.query(
            'INSERT INTO notifications (id, text, type, time, read) VALUES ($1, $2, $3, $4, FALSE) ON CONFLICT DO NOTHING',
            [notifId, text, 'warning', 'Today']
          );
          
          const emailId = `EML-WARR-${Date.now()}`;
          const subject = `ALERT: Warranty Expiry Warning for Asset ${asset.id}`;
          const body = `Dear Team,\n\nThe warranty of Asset ${asset.id} (${asset.name}, Serial: ${asset.serial_number}) will expire in ${diffDays} days on ${asset.warranty_expiry}.\n\nRegards,\nAssetFlow Monitoring Bot`;
          await db.query(
            'INSERT INTO emails (id, sender, date, subject, body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
            [emailId, 'Warranty Monitor', today.toLocaleString(), subject, body]
          );
        }
      }
    }

    // 2. Check Expiring AMCs (within 30 days)
    const amcsRes = await db.query("SELECT * FROM amcs");
    for (const amc of amcsRes.rows) {
      const expiry = new Date(amc.end_date);
      const diffTime = expiry - today;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      if (diffDays > 0 && diffDays <= 30) {
        const notifId = `NTF-AMC-${amc.id}`;
        const text = `AMC Contract ${amc.id} with ${amc.vendor} expires in ${diffDays} days!`;
        
        const existsRes = await db.query('SELECT 1 FROM notifications WHERE id = $1', [notifId]);
        if (existsRes.rows.length === 0) {
          await db.query(
            'INSERT INTO notifications (id, text, type, time, read) VALUES ($1, $2, $3, $4, FALSE) ON CONFLICT DO NOTHING',
            [notifId, text, 'error', 'Today']
          );
          
          const emailId = `EML-AMC-${Date.now()}`;
          const subject = `ALERT: AMC Contract ${amc.id} Expiring Soon`;
          const body = `Attention Team,\n\nAMC Contract ${amc.id} with vendor ${amc.vendor} is expiring in ${diffDays} days on ${amc.end_date}.\n\nRegards,\nAssetFlow Contract Engine`;
          await db.query(
            'INSERT INTO emails (id, sender, date, subject, body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
            [emailId, 'AMC Alerts Engine', today.toLocaleString(), subject, body]
          );
        }
      }
    }
  } catch (err) {
    console.error('Error running expiration checks:', err);
  }
};

// Run expiration check once on startup
runExpirationsCheck();

// Schedule daily check (every day at midnight)
cron.schedule('0 0 * * *', runExpirationsCheck);

// --- 404 handler for unmatched API routes (JSON, not Express's default HTML page) ---
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
});

// --- Global error handler (safety net; JSON, not HTML) ---
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
runMigrations().then(() => {
  app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));
}).catch(err => {
  console.error('Server startup failed due to migration failure:', err);
});
