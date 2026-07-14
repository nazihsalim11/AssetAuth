const { cq, cm } = require('../../convexApi');
const notifications = require('../../notifications');
const { resolveVendor } = require('../utils/vendor');

const stripSys = (d) => {
  if (!d) return d;
  const { _id, _creationTime, ...rest } = d;
  return rest;
};

function cleanErr(err) {
  if (err && err.data) {
    if (typeof err.data === 'string') return err.data;
    return err.data.message || 'Operation failed.';
  }
  const msg = (err && err.message) || 'Operation failed.';
  const m = msg.match(/Uncaught (?:Convex)?Error:\s*(.+?)(?:\n|\s+at\s|$)/);
  return m ? m[1].trim() : msg;
}

// Map a Convex error to an HTTP status for the invoice⇆asset mapping endpoints. Structured
// errors carry { code, message } on err.data; anything else is a 500.
const sendMappingError = (res, err, action) => {
  const d = err && err.data;
  const status = d && typeof d === 'object' && d.code ? d.code : 500;
  const message = cleanErr(err);
  if (status === 500) console.error(`Invoice mapping (${action}) failed:`, err);
  res.status(status).json({ error: status === 500 ? `Failed to ${action}: ${message}` : message });
};

// Invoices API + the invoice⇆asset mapping endpoints. Backed by native Convex
// (backend/convex/invoices.js); each mapping mutation is a single atomic transaction.
function register(app, { requirePermission, actorOf }) {
  app.get('/api/invoices', async (req, res) => {
    try {
      const rows = await cq('invoices:list', {});
      res.json(rows.map(stripSys));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database query failed' });
    }
  });

  app.post('/api/invoices', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'finance', 'create');
    if (!actingUser) return;
    const { id, poReference, amount, gst, date, paymentStatus, fileName } = req.body;

    let vendorId, vendorName;
    try {
      ({ vendorId, vendorName } = await resolveVendor(req.body));
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }

    const doc = {
      id,
      po_reference: poReference || '',
      vendor: vendorName,
      vendor_id: vendorId,
      amount: amount || 0,
      gst: gst || 0,
      date,
      payment_status: paymentStatus || 'Pending',
      file_name: fileName || '',
    };

    try {
      const invoice = stripSys(await cm('invoices:create', { doc }));
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
      res.status(500).json({ error: 'Database insertion failed: ' + cleanErr(err) });
    }
  });

  app.patch('/api/invoices/:id', async (req, res) => {
    const gateUser = await requirePermission(req, res, 'finance', 'edit');
    if (!gateUser) return;
    const { id } = req.params;
    const { paymentStatus, fileName, vendorId, vendor } = req.body;

    const patch = {};
    if (paymentStatus !== undefined) patch.payment_status = paymentStatus;
    if (fileName !== undefined) patch.file_name = fileName;

    // Re-point the vendor via the registry (or a free-text override).
    if (vendorId !== undefined || vendor !== undefined) {
      let resolved;
      try {
        resolved = await resolveVendor({ vendorId, vendor }, { required: false });
      } catch (err) {
        return res.status(err.statusCode || 400).json({ error: err.message });
      }
      if (resolved.vendorName !== null) {
        patch.vendor = resolved.vendorName;
        patch.vendor_id = resolved.vendorId;
      }
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    try {
      const invoice = stripSys(await cm('invoices:update', { id, patch }));
      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      res.json(invoice);

      // Invoices carry no due date, so "overdue" is a status somebody sets. The event key
      // is the invoice id, so re-saving an already-overdue invoice notifies once.
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
      res.status(500).json({ error: 'Database update failed: ' + cleanErr(err) });
    }
  });

  app.post('/api/invoices/bulk', async (req, res) => {
    const { invoices } = req.body;
    if (!Array.isArray(invoices)) {
      return res.status(400).json({ error: 'Payload must contain invoices array' });
    }
    try {
      const results = await cm('invoices:bulkCreate', { invoices });
      results.inserted = (results.inserted || []).map(stripSys);
      res.json(results);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Bulk import failed: ' + cleanErr(err) });
    }
  });

  app.post('/api/invoices/bulk/delete', async (req, res) => {
    const { invoiceIds } = req.body;
    if (!Array.isArray(invoiceIds)) {
      return res.status(400).json({ error: 'Payload must contain invoiceIds array' });
    }
    try {
      await cm('invoices:bulkDelete', { ids: invoiceIds });
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
      await cm('invoices:bulkSetStatus', { ids: invoiceIds, status });
      res.json({ message: 'Successfully updated status for selected invoices' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Bulk status update failed' });
    }
  });

  /* ---------------- Invoice ⇆ Asset mapping ---------------- */

  // Current mapping for an invoice.
  app.get('/api/invoices/:id/assets', async (req, res) => {
    try {
      const result = await cq('invoices:getAssets', { invoiceId: req.params.id });
      if (result.notFound) return sendMappingError(res, { data: { code: 404, message: `Invoice '${req.params.id}' not found` } }, 'load invoice assets');
      res.json({ ...result, assets: result.assets.map(stripSys) });
    } catch (err) {
      sendMappingError(res, err, 'load invoice assets');
    }
  });

  // Replace the invoice's asset set outright. An empty array unlinks every asset.
  app.put('/api/invoices/:id/assets', async (req, res) => {
    const { assetIds } = req.body;
    if (!Array.isArray(assetIds)) {
      return res.status(400).json({ error: 'Payload must contain an assetIds array' });
    }
    try {
      const result = await cm('invoices:applyMapping', { invoiceId: req.params.id, assetIds, mode: 'replace' });
      res.json({ ...result, assets: result.assets.map(stripSys) });
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
      const result = await cm('invoices:applyMapping', { invoiceId: req.params.id, assetIds, mode: 'add' });
      res.json({ ...result, assets: result.assets.map(stripSys) });
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
      const result = await cm('invoices:applyMapping', { invoiceId: req.params.id, assetIds, mode: 'remove' });
      res.json({ ...result, assets: result.assets.map(stripSys) });
    } catch (err) {
      sendMappingError(res, err, 'remove invoice assets');
    }
  });

  // Retained for backwards compatibility; replace semantics, and an empty assetIds array
  // now unlinks every asset rather than being rejected.
  app.post('/api/invoices/bulk/map-assets', async (req, res) => {
    const { invoiceId, assetIds } = req.body;
    if (!invoiceId || !Array.isArray(assetIds)) {
      return res.status(400).json({ error: 'Payload must contain invoiceId and assetIds array' });
    }
    try {
      const result = await cm('invoices:applyMapping', { invoiceId, assetIds, mode: 'replace' });
      res.json({ message: 'Assets successfully mapped to invoice', ...result, assets: result.assets.map(stripSys) });
    } catch (err) {
      sendMappingError(res, err, 'map assets');
    }
  });
}

module.exports = { register };
