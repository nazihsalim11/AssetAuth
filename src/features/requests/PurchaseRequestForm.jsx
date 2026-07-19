import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Send, Trash2, Upload } from 'lucide-react';
import { api } from '../../api';
import Modal from '../../Modal';
import CustomSelect from '../../CustomSelect';
import { SpinnerButton } from '../../SpinnerButton';
import { fmtMoney } from './requestUi';

// No shared "section heading" class exists yet, and one heading does not justify inventing a
// design token. Inline, using the same variables the rest of the sheet reads from.
const SECTION_TITLE = {
  fontSize: '13px', fontWeight: 700, letterSpacing: '0.02em', marginBottom: '10px',
  color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
};

/**
 * The purchase request form — line items, vendor quotations, preferred vendor.
 *
 * Everything it offers comes from GET /api/purchase-requests/options: the departments from
 * the Department Master, the categories from the Category Master, the vendors from the Vendor
 * Master, the units from the same list a purchase order will accept. Nothing is hardcoded
 * here, so a department added to the master can raise requests without a frontend change.
 *
 * Totals are shown as the requester types, but the figure that matters — the one the approval
 * rules band on — is recomputed server-side on submit. This is a preview, not the source of
 * truth, which is why it is safe for it to be this simple.
 */

const BLANK_ITEM = {
  description: '', category: '', quantity: 1, unit: 'pcs',
  estimatedUnitCost: '', justification: '', notes: '',
};

const BLANK_QUOTE = {
  vendorId: '', quotationNumber: '', quotationDate: '', amount: '', filePath: null, fileName: null,
};

const lineTotal = (item) => (Number(item.quantity) || 0) * (Number(item.estimatedUnitCost) || 0);

export default function PurchaseRequestForm({ request, onClose, onSaved, addToast }) {
  const editing = Boolean(request);
  const existing = request?.proposedChanges || {};

  const [options, setOptions] = useState(null);
  const [department, setDepartment] = useState(existing.department || '');
  const [requiredByDate, setRequiredByDate] = useState(existing.requiredByDate || '');
  const [currency, setCurrency] = useState(existing.currency || 'INR');
  const [items, setItems] = useState(existing.items?.length ? existing.items : [{ ...BLANK_ITEM }]);
  const [quotations, setQuotations] = useState(existing.quotations || []);
  const [preferredVendorId, setPreferredVendorId] = useState(
    existing.preferredVendorId ? String(existing.preferredVendorId) : ''
  );
  const [reason, setReason] = useState(request?.reason || '');
  const [description, setDescription] = useState(request?.description || '');
  const [priority, setPriority] = useState(request?.priority || 'Medium');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getPurchaseRequestOptions()
      .then((o) => {
        setOptions(o);
        // Default to the requester's own department — the only one most roles may raise for.
        setDepartment((d) => d || o.myDepartment || '');
      })
      .catch((err) => addToast('Could not load the form', err.message, 'error'));
  }, [addToast]);

  const total = useMemo(() => items.reduce((sum, i) => sum + lineTotal(i), 0), [items]);

  const patchItem = (index, patch) =>
    setItems((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const patchQuote = (index, patch) =>
    setQuotations((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const uploadQuote = async (index, file) => {
    try {
      const meta = await api.uploadFile(file);
      patchQuote(index, { filePath: meta.fileUrl, fileName: meta.name });
    } catch (err) {
      addToast('Upload failed', err.message, 'error');
    }
  };

  // Only vendors that actually quoted can be preferred — the server enforces this too, but
  // offering the impossible choice and then refusing it is a worse form.
  const preferredOptions = quotations
    .filter((q) => q.vendorId)
    .map((q) => ({
      value: String(q.vendorId),
      label: options?.vendors.find((v) => String(v.id) === String(q.vendorId))?.name || `Vendor ${q.vendorId}`,
    }));

  const submit = async (asDraft) => {
    if (!reason.trim()) return addToast('Reason required', 'Say why this purchase is needed.', 'error');
    setBusy(true);
    try {
      const proposedChanges = {
        department,
        requiredByDate: requiredByDate || null,
        currency,
        items: items.map((i) => ({ ...i, quantity: Number(i.quantity) || 0, estimatedUnitCost: Number(i.estimatedUnitCost) || 0 })),
        quotations: quotations.map((q) => ({ ...q, amount: Number(q.amount) || 0 })),
        preferredVendorId: preferredVendorId ? Number(preferredVendorId) : null,
      };
      const saved = editing
        ? await api.reviseRequest(request.id, { proposedChanges, reason: reason.trim(), description, priority })
        : await api.createRequest({
          requestType: 'purchase.request',
          proposedChanges,
          reason: reason.trim(),
          description: description.trim() || undefined,
          priority,
          dueDate: requiredByDate || undefined,
          submit: !asDraft,
        });
      addToast(
        editing ? 'Request updated' : asDraft ? 'Draft saved' : 'Request raised',
        editing ? `${saved.id} was revised.` : asDraft ? `${saved.id} is saved as a draft.` : `${saved.id} is awaiting approval.`,
        'success'
      );
      await onSaved(saved.id);
    } catch (err) {
      addToast(editing ? 'Could not save the revision' : 'Could not raise the request', err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const departmentOptions = (options?.departments || []).map((d) => ({ value: d, label: d }));
  const lockedToOwnDepartment = options && !options.canRaiseForAnyDepartment && options.myDepartment;

  return (
    <Modal isOpen onClose={onClose} maxWidth="1000px"
      title={editing ? `Revise ${request.id}` : 'New purchase request'}
      subtitle="Nothing is ordered until the configured approval workflow completes."
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          {!editing && (
            <SpinnerButton className="btn btn-secondary" loadingText="Saving…" onClick={() => submit(true)}>
              Save as draft
            </SpinnerButton>
          )}
          <SpinnerButton className="btn btn-primary" loadingText="Submitting…" onClick={() => submit(false)}>
            <Send size={14} /> {editing ? 'Save changes' : 'Submit for approval'}
          </SpinnerButton>
        </>
      }>
      {!options ? (
        <div className="skeleton skeleton-row" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {/* ------------------------------------------- general information */}
          <section>
            <div style={SECTION_TITLE}>General information</div>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Department *</label>
                <CustomSelect value={department} placeholder="Which department is buying?"
                  disabled={Boolean(lockedToOwnDepartment)}
                  onChange={(e) => setDepartment(e.target.value)} options={departmentOptions} />
                {lockedToOwnDepartment && (
                  <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Your role may raise requests for {options.myDepartment} only.
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">Priority</label>
                <CustomSelect value={priority} onChange={(e) => setPriority(e.target.value)}
                  options={options.priorities.map((p) => ({ value: p, label: p }))} />
              </div>
              <div className="form-group">
                <label className="form-label">Required by</label>
                <input className="form-input" type="date" value={requiredByDate}
                  onChange={(e) => setRequiredByDate(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Currency</label>
                <CustomSelect value={currency} onChange={(e) => setCurrency(e.target.value)}
                  options={options.currencies.map((c) => ({ value: c, label: c }))} />
              </div>
              <div className="form-group full-width">
                <label className="form-label">Reason *</label>
                <input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="Why does this need to be bought?" />
              </div>
            </div>
          </section>

          {/* --------------------------------------------------- line items */}
          <section>
            <div style={SECTION_TITLE}>
              <span>Item details</span>
              <button className="btn btn-secondary btn-sm" onClick={() => setItems((r) => [...r, { ...BLANK_ITEM }])}>
                <Plus size={13} /> Add item
              </button>
            </div>
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ minWidth: '180px' }}>Description *</th>
                    <th>Category</th><th style={{ width: '80px' }}>Qty *</th><th style={{ width: '100px' }}>Unit *</th>
                    <th style={{ width: '120px' }}>Est. unit cost</th><th style={{ width: '110px' }}>Line total</th>
                    <th style={{ minWidth: '160px' }}>Justification *</th><th style={{ width: '44px' }} />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr key={index}>
                      <td>
                        <input className="form-input" value={item.description}
                          onChange={(e) => patchItem(index, { description: e.target.value })} />
                        <input className="form-input" style={{ marginTop: '4px', fontSize: '12px' }}
                          placeholder="Notes (optional)" value={item.notes || ''}
                          onChange={(e) => patchItem(index, { notes: e.target.value })} />
                      </td>
                      <td>
                        <CustomSelect searchable value={item.category || ''} placeholder="—"
                          onChange={(e) => patchItem(index, { category: e.target.value })}
                          options={options.categories.map((c) => ({ value: c, label: c }))} />
                      </td>
                      <td>
                        <input className="form-input" type="number" min="0" value={item.quantity}
                          onChange={(e) => patchItem(index, { quantity: e.target.value })} />
                      </td>
                      <td>
                        <CustomSelect value={item.unit || ''}
                          onChange={(e) => patchItem(index, { unit: e.target.value })}
                          options={options.units.map((u) => ({ value: u, label: u }))} />
                      </td>
                      <td>
                        <input className="form-input" type="number" min="0" value={item.estimatedUnitCost}
                          onChange={(e) => patchItem(index, { estimatedUnitCost: e.target.value })} />
                      </td>
                      <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtMoney(lineTotal(item), currency)}</td>
                      <td>
                        <textarea className="form-input" rows={2} value={item.justification || ''}
                          onChange={(e) => patchItem(index, { justification: e.target.value })} />
                      </td>
                      <td>
                        <button className="btn-table-action delete" title="Remove line"
                          disabled={items.length === 1}
                          onClick={() => setItems((r) => r.filter((_, i) => i !== index))}>
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'right', fontWeight: 600 }}>Total estimated cost</td>
                    <td style={{ fontWeight: 700 }}>{fmtMoney(total, currency)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {/* ------------------------------------------- vendor quotations */}
          <section>
            <div style={SECTION_TITLE}>
              <span>Vendor quotations</span>
              <button className="btn btn-secondary btn-sm" onClick={() => setQuotations((r) => [...r, { ...BLANK_QUOTE }])}>
                <Plus size={13} /> Add quotation
              </button>
            </div>
            {quotations.length === 0 ? (
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', padding: '6px 0' }}>
                No quotations attached yet. Add one per vendor who quoted, then pick the preferred vendor.
              </div>
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: '180px' }}>Vendor *</th><th>Quotation no.</th>
                      <th style={{ width: '150px' }}>Quotation date</th><th style={{ width: '130px' }}>Amount</th>
                      <th>Document</th><th style={{ width: '44px' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {quotations.map((q, index) => (
                      <tr key={index}>
                        <td>
                          <CustomSelect searchable value={q.vendorId ? String(q.vendorId) : ''}
                            placeholder="Pick from the Vendor Master"
                            onChange={(e) => patchQuote(index, { vendorId: e.target.value })}
                            options={options.vendors.map((v) => ({ value: String(v.id), label: v.name }))} />
                        </td>
                        <td>
                          <input className="form-input" value={q.quotationNumber || ''}
                            onChange={(e) => patchQuote(index, { quotationNumber: e.target.value })} />
                        </td>
                        <td>
                          <input className="form-input" type="date" value={q.quotationDate || ''}
                            onChange={(e) => patchQuote(index, { quotationDate: e.target.value })} />
                        </td>
                        <td>
                          <input className="form-input" type="number" min="0" value={q.amount}
                            onChange={(e) => patchQuote(index, { amount: e.target.value })} />
                        </td>
                        <td>
                          <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                            <Upload size={13} /> {q.fileName || 'Upload'}
                            <input type="file" style={{ display: 'none' }}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = '';
                                if (file) uploadQuote(index, file);
                              }} />
                          </label>
                        </td>
                        <td>
                          <button className="btn-table-action delete" title="Remove quotation"
                            onClick={() => setQuotations((r) => r.filter((_, i) => i !== index))}>
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="form-group" style={{ maxWidth: '340px', marginTop: '12px' }}>
              <label className="form-label">Preferred vendor</label>
              <CustomSelect value={preferredVendorId} placeholder="Pick one of the vendors who quoted"
                disabled={!preferredOptions.length}
                onChange={(e) => setPreferredVendorId(e.target.value)} options={preferredOptions} />
              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '4px' }}>
                The purchase order raised after approval goes to this vendor.
              </div>
            </div>
          </section>

          <div className="form-group">
            <label className="form-label">Notes for the approver</label>
            <textarea className="form-input" rows={2} value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Anything the approver should know." />
          </div>

          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Specifications, images, technical evaluations and other supporting documents can be
            attached from the request once it is raised.
          </div>
        </div>
      )}
    </Modal>
  );
}
