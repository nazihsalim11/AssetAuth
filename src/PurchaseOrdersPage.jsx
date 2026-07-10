import React, { useState, useEffect, useCallback } from 'react';
import CustomSelect from './CustomSelect';
import {
  Plus, Search, Edit2, Trash2, X, Save, FileText, Paperclip,
  ArrowUp, ArrowDown, ShoppingCart, Download
} from 'lucide-react';
import { api } from './api';
import { openStoredFile } from './files';
import Modal from './Modal';

const STATUS_BADGE = {
  Draft: 'badge',
  Issued: 'badge badge-assigned',
  'Partially Received': 'badge badge-under-maintenance',
  Received: 'badge badge-available',
  Cancelled: 'badge badge-disposed'
};

const money = (amount, currency) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 2 })
    .format(Number(amount) || 0);

const asDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');

/* ------------------------------------------------------------------ editor */

const PoEditor = ({ po, options, invoices, amcs, onSave, onCancel, addToast }) => {
  const [form, setForm] = useState({
    poNumber: po?.poNumber || '',
    vendor: po?.vendor || '',
    issueDate: po?.issueDate ? String(po.issueDate).split('T')[0] : new Date().toISOString().split('T')[0],
    expectedDeliveryDate: po?.expectedDeliveryDate ? String(po.expectedDeliveryDate).split('T')[0] : '',
    status: po?.status || 'Draft',
    amount: po?.amount ?? 0,
    currency: po?.currency || 'INR',
    notes: po?.notes || '',
    invoiceId: po?.invoiceId || '',
    amcId: po?.amcId || ''
  });
  // Attachments carry `fileUrl` (a storage path) because that is what /api/upload
  // returns and what the server persists.
  const [attachments, setAttachments] = useState(
    (po?.attachments || []).map((a) => ({ name: a.name, fileUrl: a.filePath, fileType: a.fileType, fileSize: a.fileSize }))
  );
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const uploadFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploading(true);
    try {
      // Sequential: multer accepts one file per request on /api/upload.
      for (const file of files) {
        const res = await api.uploadFile(file);
        setAttachments((prev) => [...prev, { name: res.name, fileUrl: res.fileUrl, fileType: file.type, fileSize: res.fileSize }]);
      }
      addToast('Attached', `${files.length} file(s) uploaded.`, 'success');
    } catch (err) {
      addToast('Upload failed', err.message, 'error');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.poNumber.trim() || !form.vendor.trim() || !form.issueDate) {
      addToast('Missing fields', 'PO Number, Vendor and Issue Date are required.', 'error');
      return;
    }
    setSaving(true);
    try {
      await onSave({ ...form, amount: Number(form.amount) || 0, attachments });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div className="form-grid">
        <div className="form-group">
          <label className="form-label">PO Number *</label>
          <input className="form-input" value={form.poNumber} onChange={set('poNumber')} required placeholder="PO-2026-001" />
        </div>
        <div className="form-group">
          <label className="form-label">Vendor *</label>
          <input className="form-input" value={form.vendor} onChange={set('vendor')} required />
        </div>
        <div className="form-group">
          <label className="form-label">Issue Date *</label>
          <input className="form-input" type="date" value={form.issueDate} onChange={set('issueDate')} required />
        </div>
        <div className="form-group">
          <label className="form-label">Expected Delivery Date</label>
          <input className="form-input" type="date" value={form.expectedDeliveryDate} onChange={set('expectedDeliveryDate')} />
        </div>
        <div className="form-group">
          <label className="form-label">Status</label>
          <CustomSelect value={form.status} onChange={set('status')} options={options.statuses} />
        </div>
        <div className="form-group">
          <label className="form-label">Currency</label>
          <CustomSelect value={form.currency} onChange={set('currency')} options={options.currencies} />
        </div>
        <div className="form-group">
          <label className="form-label">Amount</label>
          <input className="form-input" type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} />
        </div>
        <div className="form-group">
          <label className="form-label">Link Invoice (optional)</label>
          <CustomSelect
            value={form.invoiceId}
            onChange={set('invoiceId')}
            placeholder="Not linked"
            searchable
            options={[{ value: '', label: 'Not linked' }, ...invoices.map((i) => ({ value: i.id, label: `${i.id} — ${i.vendor}` }))]}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Link AMC (optional)</label>
          <CustomSelect
            value={form.amcId}
            onChange={set('amcId')}
            placeholder="Not linked"
            searchable
            options={[{ value: '', label: 'Not linked' }, ...amcs.map((m) => ({ value: m.id, label: `${m.id} — ${m.vendor}` }))]}
          />
        </div>
        <div className="form-group full-width">
          <label className="form-label">Notes</label>
          <textarea className="form-input" value={form.notes} onChange={set('notes')} placeholder="Line items, terms, delivery instructions…" />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Attachments (multiple files supported)</label>
        <input className="form-input" type="file" multiple onChange={uploadFiles} disabled={uploading} />
        {attachments.length > 0 && (
          <div className="attachment-preview-grid">
            {attachments.map((a, i) => (
              <div key={i} className="attachment-preview-card" title="Click to remove"
                   onClick={() => setAttachments((prev) => prev.filter((_, n) => n !== i))}>
                <FileText className="attachment-file-icon" size={20} />
                <span className="attachment-file-name">{a.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}><X size={14} /> Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving || uploading}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save purchase order'}
        </button>
      </div>
    </form>
  );
};

/* -------------------------------------------------------------------- page */

const PurchaseOrdersPage = ({ canManage = false, invoices = [], amcs = [], addToast }) => {
  const [orders, setOrders] = useState([]);
  const [options, setOptions] = useState({ statuses: [], currencies: [] });
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortDir, setSortDir] = useState('desc');
  const [editing, setEditing] = useState(null); // 'new' | po
  const [viewing, setViewing] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const list = await api.getPurchaseOrders({ q: query, status, sortBy, sortDir });
      setOrders(list);
    } catch (err) {
      addToast('Error', err.message || 'Could not load purchase orders.', 'error');
    } finally {
      setLoading(false);
    }
  }, [query, status, sortBy, sortDir, addToast]);

  useEffect(() => {
    api.getPurchaseOrderOptions().then(setOptions).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const toggleSort = (column) => {
    if (sortBy === column) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(column); setSortDir('asc'); }
  };

  const SortHeader = ({ column, children }) => (
    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort(column)}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        {children}
        {sortBy === column && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </span>
    </th>
  );

  const save = async (payload) => {
    try {
      if (editing === 'new') {
        const created = await api.createPurchaseOrder(payload);
        addToast('Purchase order created', `${created.poNumber} saved.`, 'success');
      } else {
        await api.updatePurchaseOrder(editing.id, payload);
        addToast('Purchase order updated', `${payload.poNumber} saved.`, 'success');
      }
      setEditing(null);
      await load();
    } catch (err) {
      addToast('Save failed', err.message, 'error');
    }
  };

  const remove = async (po) => {
    if (!window.confirm(`Delete purchase order ${po.poNumber} permanently? Its attachments will be removed too.`)) return;
    try {
      await api.deletePurchaseOrder(po.id);
      addToast('Deleted', `${po.poNumber} removed.`, 'success');
      if (viewing?.id === po.id) setViewing(null);
      await load();
    } catch (err) {
      addToast('Error', err.message, 'error');
    }
  };

  const openDetail = async (po) => {
    try {
      setViewing(await api.getPurchaseOrder(po.id));
    } catch (err) {
      addToast('Error', err.message, 'error');
    }
  };

  if (editing) {
    return (
      <div className="card">
        <span className="card-title"><ShoppingCart /> {editing === 'new' ? 'New Purchase Order' : `Editing ${editing.poNumber}`}</span>
        <PoEditor
          po={editing === 'new' ? null : editing}
          options={options}
          invoices={invoices}
          amcs={amcs}
          onSave={save}
          onCancel={() => setEditing(null)}
          addToast={addToast}
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div className="card">
        <div className="card-title-section">
          <span className="card-title"><ShoppingCart /> Purchase Orders</span>
          {canManage && (
            <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> New purchase order</button>
          )}
        </div>

        <div className="filters-row">
          <div className="filters-left" style={{ flexGrow: 1 }}>
            <div className="search-bar-container" style={{ minWidth: 'min(280px, 100%)' }}>
              <Search className="search-icon" />
              <input className="search-bar" placeholder="Search PO number, vendor or notes…"
                     value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <span>Status</span>
            <CustomSelect
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              placeholder="All statuses"
              style={{ minWidth: '160px' }}
              options={[{ value: '', label: 'All statuses' }, ...options.statuses.map((s) => ({ value: s, label: s }))]}
            />
          </div>
        </div>

        <div className="table-container" style={{ maxHeight: '560px' }}>
          <table className="data-table">
            <thead>
              <tr>
                <SortHeader column="poNumber">PO Number</SortHeader>
                <SortHeader column="vendor">Vendor</SortHeader>
                <SortHeader column="issueDate">Issued</SortHeader>
                <SortHeader column="expectedDeliveryDate">Expected</SortHeader>
                <SortHeader column="status">Status</SortHeader>
                <SortHeader column="amount">Amount</SortHeader>
                <th>Files</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8}><div className="skeleton skeleton-row" /></td></tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state">
                      <div className="empty-state-icon"><ShoppingCart size={22} /></div>
                      <div className="empty-state-title">No purchase orders</div>
                      <div className="empty-state-desc">
                        {query || status ? 'Nothing matches the current search and filters.'
                                         : canManage ? 'Create the first purchase order to get started.'
                                                     : 'No purchase orders have been raised yet.'}
                      </div>
                    </div>
                  </td>
                </tr>
              ) : orders.map((po) => (
                <tr key={po.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(po)}>
                  <td style={{ fontWeight: 700, color: 'var(--primary)' }}>{po.poNumber}</td>
                  <td>{po.vendor}</td>
                  <td style={{ fontSize: '12px' }}>{asDate(po.issueDate)}</td>
                  <td style={{ fontSize: '12px' }}>{asDate(po.expectedDeliveryDate)}</td>
                  <td><span className={STATUS_BADGE[po.status] || 'badge'}>{po.status}</span></td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{money(po.amount, po.currency)}</td>
                  <td style={{ textAlign: 'center' }}>
                    {po.attachmentCount > 0 ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--text-muted)', fontSize: '12px' }}>
                        <Paperclip size={12} /> {po.attachmentCount}
                      </span>
                    ) : '—'}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="table-actions">
                      {canManage && (
                        <>
                          <button className="btn-table-action" title="Edit"
                                  onClick={async () => setEditing(await api.getPurchaseOrder(po.id))}>
                            <Edit2 size={15} />
                          </button>
                          <button className="btn-table-action delete" title="Delete" onClick={() => remove(po)}>
                            <Trash2 size={15} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {viewing && (
        <Modal
          isOpen
          onClose={() => setViewing(null)}
          closeOnOverlayClick
          title={viewing.poNumber}
          maxWidth="640px"
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setViewing(null)}>Close</button>
              {canManage && (
                <button className="btn btn-primary" onClick={() => { setEditing(viewing); setViewing(null); }}>
                  <Edit2 size={14} /> Edit
                </button>
              )}
            </>
          }
        >
              <div className="form-grid">
                <Detail label="Vendor" value={viewing.vendor} />
                <Detail label="Status" value={<span className={STATUS_BADGE[viewing.status] || 'badge'}>{viewing.status}</span>} />
                <Detail label="Issue date" value={asDate(viewing.issueDate)} />
                <Detail label="Expected delivery" value={asDate(viewing.expectedDeliveryDate)} />
                <Detail label="Amount" value={money(viewing.amount, viewing.currency)} />
                <Detail label="Currency" value={viewing.currency} />
                <Detail label="Linked invoice" value={viewing.invoiceId || 'Not linked'} />
                <Detail label="Linked AMC" value={viewing.amcId || 'Not linked'} />
                <Detail label="Raised by" value={viewing.createdByName || '—'} />
              </div>
              {viewing.notes && (
                <div className="form-group">
                  <label className="form-label">Notes</label>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: '13px', color: 'var(--text-secondary)' }}>{viewing.notes}</div>
                </div>
              )}
              <div className="form-group">
                <label className="form-label">Attachments ({viewing.attachments?.length || 0})</label>
                {viewing.attachments?.length ? (
                  <div className="attachment-preview-grid">
                    {viewing.attachments.map((a) => (
                      <div key={a.id} className="attachment-preview-card" title={`Open ${a.name}`}
                           onClick={() => openStoredFile(a.filePath, (m) => addToast('Cannot open file', m, 'error'))}>
                        <FileText className="attachment-file-icon" size={22} />
                        <span className="attachment-file-name">{a.name}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>No files attached.</span>
                )}
                {viewing.attachments?.length > 0 && (
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                    <Download size={11} style={{ verticalAlign: '-1px' }} /> Files open in a new tab through a short-lived signed link.
                  </span>
                )}
              </div>
        </Modal>
      )}
    </div>
  );
};

const Detail = ({ label, value }) => (
  <div className="form-group">
    <label className="form-label">{label}</label>
    <div style={{ fontSize: '13px', fontWeight: 500 }}>{value}</div>
  </div>
);

export default PurchaseOrdersPage;
