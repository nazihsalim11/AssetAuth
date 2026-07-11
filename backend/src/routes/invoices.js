const db = require('../../db');
const notifications = require('../../notifications');

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

// Invoices API + the invoice⇆asset mapping endpoints — extracted verbatim from server.js.
function register(app, { requirePermission, actorOf }) {
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
    const actingUser = await requirePermission(req, res, 'finance', 'create');
    if (!actingUser) return;
    const { id, poReference, vendor, amount, gst, date, paymentStatus, fileName } = req.body;
    const query = `
      INSERT INTO invoices (id, po_reference, vendor, amount, gst, date, payment_status, file_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;
    const values = [id, poReference || '', vendor, amount || 0, gst || 0, date, paymentStatus || 'Pending', fileName || ''];

    try {
      const result = await db.query(query, values);
      const invoice = result.rows[0];
      res.status(201).json(invoice);

      notifications.notify('finance.invoice_created', `invoice-created:${invoice.id}`, {
        invoiceId: invoice.id,
        vendor: invoice.vendor,
        amount: invoice.amount,
        poReference: invoice.po_reference,
        paymentStatus: invoice.payment_status,
        actor: actorOf(req)
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database insertion failed: ' + err.message });
    }
  });

  app.patch('/api/invoices/:id', async (req, res) => {
    const gateUser = await requirePermission(req, res, 'finance', 'edit');
    if (!gateUser) return;
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
      const invoice = result.rows[0];
      res.json(invoice);

      // Invoices carry no due date, so "overdue" is a status somebody sets. The event
      // key is the invoice id, so re-saving an already-overdue invoice notifies once.
      if (paymentStatus === 'Overdue') {
        notifications.notify('finance.invoice_overdue', `invoice-overdue:${invoice.id}`, {
          invoiceId: invoice.id,
          vendor: invoice.vendor,
          amount: invoice.amount,
          date: invoice.date
        });
      }
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
}

module.exports = { register };
