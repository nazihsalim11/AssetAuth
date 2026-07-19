/**
 * Purchase Requests — the small surface that is genuinely specific to this request type.
 *
 * Everything a purchase request shares with every other request — create, submit, approve,
 * reject, request-more-info, reassign, comment, attach, audit, notify, list, dashboard — is
 * already served by /api/requests and the shared engine, and is *not* duplicated here. A
 * purchase request is raised with POST /api/requests { requestType: 'purchase.request' } like
 * any other type.
 *
 * What is left, and lives here:
 *   - the master-data vocabulary the purchase-request form is built from
 *   - conversion of an approved request into a purchase order, which is a Finance action with
 *     its own permission, not something approval should do silently
 *   - closing a finished request
 */

const engine = require('../requests/engine');
const registry = require('../requests/registry');
const purchaseRequest = require('../requests/purchaseRequest');
const poUpdate = require('../services/poUpdate');
const { cq, cm } = require('../../convexApi');

const TYPE = 'purchase.request';

const send = (res, err, fallback) => {
  const status = err.statusCode || 500;
  if (status === 500) console.error(`[purchase-requests] ${fallback}:`, err);
  res.status(status).json({ error: status === 500 ? `${fallback}: ${err.message}` : err.message });
};

// Declared once, on the registry descriptor, so the generic /api/requests/options and this
// endpoint can never offer different lists. 'Other' takes anything they do not name, so an
// unusual document is filed rather than refused.
const DOC_TYPES = registry.descriptorFor(TYPE).docTypes;

const logAction = (actor, action, detail) =>
  cm('logs:add', { actor, action, detail }).catch((e) =>
    console.warn('[purchase-requests] log failed:', e.message)
  );

function register(app, { requirePermission, roleCan }) {
  /* --------------------------------------------------------------- options */

  /**
   * The vocabulary the form renders from — all of it read from the masters, none of it
   * hardcoded in the frontend. A department added to the Department Master can raise purchase
   * requests the moment it exists.
   */
  app.get('/api/purchase-requests/options', async (req, res) => {
    const user = await requirePermission(req, res, 'purchaseRequests', 'view');
    if (!user) return;
    try {
      const [departments, categories, vendors] = await Promise.all([
        cq('masters:list', { table: 'departments' }),
        cq('generic:list', { table: 'asset_subtypes' }),
        cq('purchaseOrders:vendorList', {}),
      ]);
      res.json({
        departments: departments.map((d) => d.name),
        categories: [...new Set(categories.filter((c) => c.is_active !== false).map((c) => c.name))].sort(),
        vendors: vendors.map((v) => ({ id: v.id, name: v.name })),
        units: poUpdate.UNITS,
        currencies: poUpdate.CURRENCIES,
        docTypes: DOC_TYPES,
        priorities: engine.PRIORITIES,
        // The department a requester defaults to, and whether they may pick another.
        myDepartment: user.department || null,
        canRaiseForAnyDepartment: await roleCan(user, 'purchaseRequests', 'manage'),
      });
    } catch (err) {
      send(res, err, 'Could not load purchase request options');
    }
  });

  /* --------------------------------------------------------------- convert */

  /**
   * Turn an approved purchase request into a purchase order.
   *
   * Separately permissioned on Finance: the people who approve a spend are usually not the
   * people who raise the order for it, and folding the conversion into final approval would
   * mean an approver with no Finance rights silently creating one.
   *
   * The order is built by the shared PO writer from the *approved* payload — the items,
   * quantities and estimated costs the ladder actually signed off, and the preferred vendor.
   * The engine's own guard is what makes this safe: it refuses unless the request reached
   * Completed, and refuses a second conversion of the same request.
   */
  app.post('/api/purchase-requests/:id/convert', async (req, res) => {
    const user = await requirePermission(req, res, 'finance', 'create');
    if (!user) return;
    try {
      const request = await engine.get(req.params.id);
      if (!request) return res.status(404).json({ error: 'Purchase request not found' });
      if (request.requestType !== TYPE) {
        return res.status(400).json({ error: `${request.id} is not a purchase request` });
      }

      const payload = request.proposedChanges || {};
      if (!payload.preferredVendorId) {
        return res.status(400).json({
          error: 'Pick a preferred vendor on the request before converting it — a purchase order needs one.',
        });
      }

      const body = purchaseRequest.toPurchaseOrderBody(payload, req.body || {});
      const { po } = await poUpdate.createPurchaseOrder({ ...body, sourceRequestId: request.id }, user);

      const updated = await engine.linkOutcome(req.params.id, user, {
        patch: { converted_po_id: po.id, converted_po_number: po.po_number, converted_at: new Date().toISOString() },
        action: 'Converted to Purchase Order',
        outcomeLabel: `Purchase Order ${po.po_number}`,
        detail: `${po.po_number} raised on ${po.vendor} for ${po.currency} ${po.amount}`,
        guard: (row) => (row.converted_po_id
          ? `${req.params.id} was already converted into ${row.converted_po_number}`
          : null),
      });

      await logAction(user.name, 'Purchase Request Converted', `${request.id} → ${po.po_number}`);
      res.status(201).json({ request: updated, purchaseOrderId: po.id, poNumber: po.po_number });
    } catch (err) {
      send(res, err, 'Could not convert the purchase request');
    }
  });

  /* ----------------------------------------------------------------- close */

  app.post('/api/purchase-requests/:id/close', async (req, res) => {
    const user = await requirePermission(req, res, 'purchaseRequests', 'edit');
    if (!user) return;
    try {
      const request = await engine.get(req.params.id);
      if (!request) return res.status(404).json({ error: 'Purchase request not found' });
      const isOwner = String(request.requestedBy) === String(user.id);
      if (!isOwner && !(await roleCan(user, 'purchaseRequests', 'manage'))) {
        return res.status(403).json({ error: 'Only the requester or a manager can close this request.' });
      }
      res.json(await engine.close(req.params.id, user, req.body || {}));
    } catch (err) {
      send(res, err, 'Could not close the purchase request');
    }
  });
}

module.exports = { register, TYPE, DOC_TYPES };
