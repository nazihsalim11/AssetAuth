const { cq, cm } = require('../../convexApi');
const { resolveVendor } = require('../utils/vendor');

const stripSys = (d) => {
  if (!d) return d;
  const { _id, _creationTime, ...rest } = d;
  return rest;
};

function cleanErr(err) {
  if (err && err.data) return typeof err.data === 'string' ? err.data : (err.data.message || 'Operation failed.');
  const msg = (err && err.message) || 'Operation failed.';
  const m = msg.match(/Uncaught (?:Convex)?Error:\s*(.+?)(?:\n|\s+at\s|$)/);
  return m ? m[1].trim() : msg;
}

// AMC (annual maintenance contract) API. Backed by native Convex (backend/convex/amc.js).
function register(app, { requirePermission }) {
  app.get('/api/amcs', async (req, res) => {
    try {
      const rows = await cq('amc:list', {});
      res.json(rows.map(stripSys));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database query failed' });
    }
  });

  app.post('/api/amcs', async (req, res) => {
    const actingUser = await requirePermission(req, res, 'amc', 'create');
    if (!actingUser) return;
    const { id, cost, startDate, endDate, serviceSchedule, agreementFile, serviceHistory, poNumber } = req.body;

    // The PO number is the contract's business identifier, so it is required and unique.
    if (!poNumber || !String(poNumber).trim()) {
      return res.status(400).json({ error: 'PO Number is required for an AMC contract.' });
    }

    // Vendor now comes from the registry (vendor_id); the name is snapshotted for display.
    let vendorId, vendorName;
    try {
      ({ vendorId, vendorName } = await resolveVendor(req.body));
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }

    const doc = {
      id,
      vendor: vendorName,
      vendor_id: vendorId,
      cost: cost || 0,
      start_date: startDate,
      end_date: endDate,
      service_schedule: serviceSchedule || 'Quarterly',
      agreement_file: agreementFile || '',
      service_history: serviceHistory || [],
      po_number: String(poNumber).trim(),
    };

    try {
      const created = await cm('amc:create', { doc });
      res.status(201).json(stripSys(created));
    } catch (err) {
      const msg = cleanErr(err);
      if (/already exists/i.test(msg)) return res.status(409).json({ error: msg });
      console.error('POST /api/amcs failed:', err);
      res.status(500).json({ error: 'Database insertion failed: ' + msg });
    }
  });

  app.patch('/api/amcs/:id', async (req, res) => {
    const { id } = req.params;
    const { serviceHistory } = req.body;
    try {
      const updated = await cm('amc:updateServiceHistory', { id, serviceHistory });
      if (!updated) return res.status(404).json({ error: 'AMC not found' });
      res.json(stripSys(updated));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database update failed: ' + cleanErr(err) });
    }
  });
}

module.exports = { register };
