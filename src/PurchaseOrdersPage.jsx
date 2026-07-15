import React, { useState, useEffect, useCallback } from 'react';
import CustomSelect from './CustomSelect';
import {
  Plus, Search, Edit2, Trash2, X, Save, FileText, Eye, Printer, Mail,
  ArrowUp, ArrowDown, ShoppingCart, Download, Building2, Settings as SettingsIcon,
  RefreshCw, History, Users
} from 'lucide-react';
import { api } from './api';
import { openStoredFile } from './files';
import Modal from './Modal';
import BulkManager from './BulkManager';
import { SpinnerButton } from './SpinnerButton';
import { downloadPoPdf, previewPoPdf, printPoPdf, poPdfFile } from './poPdf';

const STATUS_BADGE = {
  Draft: 'badge',
  Issued: 'badge badge-assigned',
  'Partially Received': 'badge badge-under-maintenance',
  Received: 'badge badge-available',
  Cancelled: 'badge badge-disposed'
};

const money = (amount, currency) =>
  new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency', currency: currency || 'INR', maximumFractionDigits: 2
  }).format(Number(amount) || 0);

const asDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const dateInput = (d) => (d ? String(d).split('T')[0] : '');
const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

// Mirrors backend/poFormat.computeTotals for a live preview only; the server recomputes
// authoritatively on save.
const previewTotals = (items, discountType, discountValue) => {
  const lines = (items || []).map((it) => {
    const lineTotal = round2((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0));
    const taxAmount = round2((lineTotal * (Number(it.taxPercent) || 0)) / 100);
    return { lineTotal, taxAmount };
  });
  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const taxTotal = round2(lines.reduce((s, l) => s + l.taxAmount, 0));
  let discountAmount = discountType === 'percent'
    ? round2((subtotal * (Number(discountValue) || 0)) / 100)
    : round2(Number(discountValue) || 0);
  discountAmount = Math.min(Math.max(discountAmount, 0), subtotal);
  return { subtotal, taxTotal, discountAmount, grandTotal: round2(subtotal + taxTotal - discountAmount) };
};

const readFileAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the selected file'));
    reader.readAsDataURL(file);
  });

const emptyItem = () => ({ description: '', hsnCode: '', quantity: 1, unit: 'pcs', unitPrice: 0, taxPercent: 18 });

/* =============================================================== PO editor */

const PoEditor = ({ po, options, vendors, poSettings, invoices, amcs, onSave, onCancel, addToast }) => {
  const [form, setForm] = useState({
    vendorId: po?.vendorId ? String(po.vendorId) : '',
    vendor: po?.vendor || '',
    vendorAddress: po?.vendorAddress || '',
    vendorGst: po?.vendorGst || '',
    vendorContactPerson: po?.vendorContactPerson || '',
    vendorEmail: po?.vendorEmail || '',
    vendorPhone: po?.vendorPhone || '',
    issueDate: dateInput(po?.issueDate) || new Date().toISOString().split('T')[0],
    expectedDeliveryDate: dateInput(po?.expectedDeliveryDate),
    status: po?.status || 'Draft',
    currency: po?.currency || poSettings?.defaultCurrency || 'INR',
    quotationRef: po?.quotationRef || '',
    paymentTerms: po?.paymentTerms || '',
    deliverySchedule: po?.deliverySchedule || '',
    deliveryLocation: po?.deliveryLocation || '',
    contactPerson: po?.contactPerson || '',
    discountType: po?.discountType || 'amount',
    discountValue: po?.discountValue ?? 0,
    notes: po?.notes || '',
    invoiceId: po?.invoiceId || '',
    amcId: po?.amcId || ''
  });
  const [items, setItems] = useState(
    po?.items?.length ? po.items.map((i) => ({
      description: i.description || '', hsnCode: i.hsnCode || '', quantity: i.quantity ?? 1,
      unit: i.unit || 'pcs', unitPrice: i.unitPrice ?? 0, taxPercent: i.taxPercent ?? 0
    })) : [emptyItem()]
  );
  const [saving, setSaving] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const onVendorChange = (e) => {
    const id = e.target.value;
    const v = vendors.find((x) => String(x.id) === String(id));
    setForm((f) => ({
      ...f,
      vendorId: id,
      vendor: v ? v.name : f.vendor,
      vendorAddress: v ? (v.address || '') : f.vendorAddress,
      vendorGst: v ? (v.gstVat || '') : f.vendorGst,
      vendorContactPerson: v ? (v.contactPerson || '') : f.vendorContactPerson,
      vendorEmail: v ? (v.email || '') : f.vendorEmail,
      vendorPhone: v ? (v.phone || '') : f.vendorPhone,
      currency: v?.defaultCurrency || f.currency,
      paymentTerms: v?.defaultPaymentTerms || f.paymentTerms
    }));
  };

  const setItem = (idx, key, value) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [key]: value } : it)));
  const addItem = () => setItems((prev) => [...prev, emptyItem()]);
  const removeItem = (idx) => setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));

  const totals = previewTotals(items, form.discountType, form.discountValue);
  const currencyOptions = (options.currencies || ['INR']).map((c) => ({ value: c, label: c }));
  const unitOptions = (options.units || ['pcs']).map((u) => ({ value: u, label: u }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.vendorId && !form.vendor.trim()) {
      addToast('Vendor required', 'Select a vendor from the master or type a name.', 'error');
      return;
    }
    if (!form.issueDate) {
      addToast('Date required', 'PO Date is required.', 'error');
      return;
    }
    const validItems = items.filter((i) => i.description.trim());
    if (validItems.length === 0) {
      addToast('No items', 'Add at least one line item with a description.', 'error');
      return;
    }
    setSaving(true);
    try {
      await onSave({
        ...form,
        vendorId: form.vendorId || null,
        discountValue: Number(form.discountValue) || 0,
        items: validItems.map((i) => ({
          description: i.description,
          hsnCode: i.hsnCode,
          quantity: Number(i.quantity) || 0,
          unit: i.unit,
          unitPrice: Number(i.unitPrice) || 0,
          taxPercent: Number(i.taxPercent) || 0
        }))
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div className="form-group" style={{ background: 'var(--bg-sidebar)', padding: '10px 14px', borderRadius: 'var(--radius-md)' }}>
        <span style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
          PO Number {po ? '' : '(auto-generated on save)'}
        </span>
        <div style={{ fontWeight: 700, color: 'var(--primary)', fontFamily: 'var(--font-mono)', fontSize: '15px' }}>
          {po?.poNumber || poSettings?.__nextNumber || 'Assigned automatically'}
        </div>
      </div>

      {/* Vendor */}
      <div className="form-grid">
        <div className="form-group">
          <label className="form-label">Vendor *</label>
          <CustomSelect
            value={form.vendorId}
            onChange={onVendorChange}
            placeholder="Select from vendor master…"
            searchable
            options={[{ value: '', label: '— Manual entry —' }, ...vendors.map((v) => ({ value: String(v.id), label: v.name }))]}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Vendor name *</label>
          <input className="form-input" value={form.vendor} onChange={set('vendor')} required />
        </div>
        <div className="form-group">
          <label className="form-label">GST / VAT</label>
          <input className="form-input" value={form.vendorGst} onChange={set('vendorGst')} />
        </div>
        <div className="form-group">
          <label className="form-label">Vendor contact person</label>
          <input className="form-input" value={form.vendorContactPerson} onChange={set('vendorContactPerson')} />
        </div>
        <div className="form-group">
          <label className="form-label">Vendor email</label>
          <input className="form-input" value={form.vendorEmail} onChange={set('vendorEmail')} />
        </div>
        <div className="form-group">
          <label className="form-label">Vendor phone</label>
          <input className="form-input" value={form.vendorPhone} onChange={set('vendorPhone')} />
        </div>
        <div className="form-group full-width">
          <label className="form-label">Vendor address</label>
          <textarea className="form-input" rows={2} value={form.vendorAddress} onChange={set('vendorAddress')} />
        </div>
      </div>

      {/* Order details */}
      <div className="form-grid">
        <div className="form-group">
          <label className="form-label">PO Date *</label>
          <input className="form-input" type="date" value={form.issueDate} onChange={set('issueDate')} required />
        </div>
        <div className="form-group">
          <label className="form-label">Expected delivery date</label>
          <input className="form-input" type="date" value={form.expectedDeliveryDate} onChange={set('expectedDeliveryDate')} />
        </div>
        <div className="form-group">
          <label className="form-label">Status</label>
          <CustomSelect value={form.status} onChange={set('status')} options={options.statuses || []} />
        </div>
        <div className="form-group">
          <label className="form-label">Currency</label>
          <CustomSelect value={form.currency} onChange={set('currency')} options={currencyOptions} />
        </div>
        <div className="form-group">
          <label className="form-label">Quotation reference</label>
          <input className="form-input" value={form.quotationRef} onChange={set('quotationRef')} placeholder="Optional" />
        </div>
        <div className="form-group">
          <label className="form-label">Payment terms</label>
          <input className="form-input" value={form.paymentTerms} onChange={set('paymentTerms')} placeholder="e.g. 30 days net" />
        </div>
        <div className="form-group">
          <label className="form-label">Delivery schedule</label>
          <input className="form-input" value={form.deliverySchedule} onChange={set('deliverySchedule')} placeholder="e.g. Within 2 weeks" />
        </div>
        <div className="form-group">
          <label className="form-label">Contact person (ours)</label>
          <input className="form-input" value={form.contactPerson} onChange={set('contactPerson')} />
        </div>
        <div className="form-group full-width">
          <label className="form-label">Delivery location</label>
          <input className="form-input" value={form.deliveryLocation} onChange={set('deliveryLocation')} />
        </div>
      </div>

      {/* Line items */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <label className="form-label" style={{ margin: 0 }}>Item details *</label>
          <button type="button" className="btn btn-secondary" onClick={addItem}><Plus size={13} /> Add item</button>
        </div>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ minWidth: '200px' }}>Description</th>
                <th>HSN/SAC</th>
                <th style={{ width: '80px' }}>Qty</th>
                <th style={{ width: '90px' }}>Unit</th>
                <th style={{ width: '120px' }}>Unit price</th>
                <th style={{ width: '80px' }}>Tax %</th>
                <th style={{ width: '110px', textAlign: 'right' }}>Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => {
                const lineTotal = round2((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0));
                return (
                  <tr key={idx}>
                    <td><input className="form-input" value={it.description} onChange={(e) => setItem(idx, 'description', e.target.value)} placeholder="Item / service description" /></td>
                    <td><input className="form-input" value={it.hsnCode} onChange={(e) => setItem(idx, 'hsnCode', e.target.value)} /></td>
                    <td><input className="form-input" type="number" min="0" step="0.01" value={it.quantity} onChange={(e) => setItem(idx, 'quantity', e.target.value)} /></td>
                    <td><CustomSelect value={it.unit} onChange={(e) => setItem(idx, 'unit', e.target.value)} options={unitOptions} /></td>
                    <td><input className="form-input" type="number" min="0" step="0.01" value={it.unitPrice} onChange={(e) => setItem(idx, 'unitPrice', e.target.value)} /></td>
                    <td><input className="form-input" type="number" min="0" step="0.01" value={it.taxPercent} onChange={(e) => setItem(idx, 'taxPercent', e.target.value)} /></td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: '12.5px' }}>{money(lineTotal, form.currency)}</td>
                    <td>
                      <button type="button" className="btn-table-action delete" title="Remove" onClick={() => removeItem(idx)} disabled={items.length === 1}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Discount + totals */}
      <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div className="form-grid" style={{ flex: '1 1 280px' }}>
          <div className="form-group">
            <label className="form-label">Discount type</label>
            <CustomSelect
              value={form.discountType}
              onChange={set('discountType')}
              options={[{ value: 'amount', label: 'Fixed amount' }, { value: 'percent', label: 'Percentage' }]}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Discount value</label>
            <input className="form-input" type="number" min="0" step="0.01" value={form.discountValue} onChange={set('discountValue')} />
          </div>
        </div>
        <div style={{ flex: '0 1 300px', alignSelf: 'flex-end' }}>
          <TotalsRow label="Subtotal" value={money(totals.subtotal, form.currency)} />
          <TotalsRow label="Tax" value={money(totals.taxTotal, form.currency)} />
          {totals.discountAmount > 0 && <TotalsRow label="Discount" value={`- ${money(totals.discountAmount, form.currency)}`} />}
          <TotalsRow label="Grand total" value={money(totals.grandTotal, form.currency)} strong />
        </div>
      </div>

      <div className="form-grid">
        <div className="form-group">
          <label className="form-label">Link invoice (optional)</label>
          <CustomSelect
            value={form.invoiceId} onChange={set('invoiceId')} placeholder="Not linked" searchable
            options={[{ value: '', label: 'Not linked' }, ...invoices.map((i) => ({ value: i.id, label: `${i.id} — ${i.vendor}` }))]}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Link AMC (optional)</label>
          <CustomSelect
            value={form.amcId} onChange={set('amcId')} placeholder="Not linked" searchable
            options={[{ value: '', label: 'Not linked' }, ...amcs.map((m) => ({ value: m.id, label: `${m.id} — ${m.vendor}` }))]}
          />
        </div>
        <div className="form-group full-width">
          <label className="form-label">Notes</label>
          <textarea className="form-input" rows={2} value={form.notes} onChange={set('notes')} placeholder="Special instructions printed on the PO…" />
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}><X size={14} /> Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          <Save size={14} /> {saving ? 'Saving & generating…' : 'Save & generate PO'}
        </button>
      </div>
    </form>
  );
};

const TotalsRow = ({ label, value, strong }) => (
  <div style={{
    display: 'flex', justifyContent: 'space-between', padding: '6px 4px',
    borderTop: strong ? '2px solid var(--primary)' : '1px solid var(--border-color)',
    fontWeight: strong ? 700 : 500, fontSize: strong ? '15px' : '13px',
    color: strong ? 'var(--primary)' : 'var(--text-secondary)'
  }}>
    <span>{label}</span>
    <span style={{ fontFamily: 'var(--font-mono)' }}>{value}</span>
  </div>
);

/* ============================================================ vendor editor */

const VendorEditor = ({ vendor, currencies, onSave, onCancel }) => {
  const [form, setForm] = useState({
    name: vendor?.name || '', address: vendor?.address || '', gstVat: vendor?.gstVat || '',
    contactPerson: vendor?.contactPerson || '', email: vendor?.email || '', phone: vendor?.phone || '',
    defaultPaymentTerms: vendor?.defaultPaymentTerms || '', defaultCurrency: vendor?.defaultCurrency || 'INR',
    isActive: vendor?.isActive ?? true
  });
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try { await onSave(form); } finally { setSaving(false); }
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div className="form-grid">
        <div className="form-group full-width">
          <label className="form-label">Vendor name *</label>
          <input className="form-input" value={form.name} onChange={set('name')} required />
        </div>
        <div className="form-group">
          <label className="form-label">GST / VAT</label>
          <input className="form-input" value={form.gstVat} onChange={set('gstVat')} />
        </div>
        <div className="form-group">
          <label className="form-label">Contact person</label>
          <input className="form-input" value={form.contactPerson} onChange={set('contactPerson')} />
        </div>
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-input" type="email" value={form.email} onChange={set('email')} />
        </div>
        <div className="form-group">
          <label className="form-label">Phone</label>
          <input className="form-input" value={form.phone} onChange={set('phone')} />
        </div>
        <div className="form-group">
          <label className="form-label">Default payment terms</label>
          <input className="form-input" value={form.defaultPaymentTerms} onChange={set('defaultPaymentTerms')} placeholder="e.g. 30 days net" />
        </div>
        <div className="form-group">
          <label className="form-label">Default currency</label>
          <CustomSelect value={form.defaultCurrency} onChange={set('defaultCurrency')} options={currencies.map((c) => ({ value: c, label: c }))} />
        </div>
        <div className="form-group full-width">
          <label className="form-label">Address</label>
          <textarea className="form-input" rows={2} value={form.address} onChange={set('address')} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}><Save size={14} /> {saving ? 'Saving…' : 'Save vendor'}</button>
      </div>
    </form>
  );
};

/* ============================================================ vendors view */

const VendorsView = ({ canManage, currencies, addToast }) => {
  const [vendors, setVendors] = useState([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showBulk, setShowBulk] = useState(false);

  const load = useCallback(async () => {
    try {
      setVendors(await api.getVendors({ q: query, includeInactive: true }));
    } catch (err) {
      addToast('Error', err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [query, addToast]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const save = async (payload) => {
    try {
      if (editing === 'new') await api.createVendor(payload);
      else await api.updateVendor(editing.id, payload);
      addToast('Saved', 'Vendor saved.', 'success');
      setEditing(null);
      await load();
    } catch (err) {
      addToast('Save failed', err.message, 'error');
    }
  };
  const remove = async (v) => {
    if (!window.confirm(`Delete vendor "${v.name}"? Existing POs keep their copied details.`)) return;
    try {
      await api.deleteVendor(v.id);
      addToast('Deleted', `${v.name} removed.`, 'success');
      await load();
    } catch (err) {
      addToast('Error', err.message, 'error');
    }
  };

  return (
    <div className="card">
      <div className="card-title-section">
        <span className="card-title"><Building2 /> Vendor Master</span>
        {canManage && (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-secondary" onClick={() => setShowBulk(true)}><Download size={15} /> Bulk manage</button>
            <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> New vendor</button>
          </div>
        )}
      </div>
      <BulkManager entity="vendor" isOpen={showBulk} onClose={() => setShowBulk(false)} onComplete={load} addToast={addToast} />
      <div className="filters-row">
        <div className="search-bar-container" style={{ minWidth: 'min(280px, 100%)' }}>
          <Search className="search-icon" />
          <input className="search-bar" placeholder="Search vendors…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      <div className="table-container" style={{ maxHeight: '520px' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th><th>Contact</th><th>GST/VAT</th><th>Terms</th><th>Currency</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7}><div className="skeleton skeleton-row" /></td></tr>
            ) : vendors.length === 0 ? (
              <tr><td colSpan={7}><div className="empty-state"><div className="empty-state-icon"><Building2 size={22} /></div>
                <div className="empty-state-title">No vendors</div>
                <div className="empty-state-desc">{canManage ? 'Add your first vendor to auto-fill purchase orders.' : 'No vendors have been added yet.'}</div>
              </div></td></tr>
            ) : vendors.map((v) => (
              <tr key={v.id}>
                <td style={{ fontWeight: 600 }}>{v.name}</td>
                <td style={{ fontSize: '12px' }}>{v.contactPerson || '—'}{v.email ? <div style={{ color: 'var(--text-muted)' }}>{v.email}</div> : null}</td>
                <td style={{ fontSize: '12px' }}>{v.gstVat || '—'}</td>
                <td style={{ fontSize: '12px' }}>{v.defaultPaymentTerms || '—'}</td>
                <td>{v.defaultCurrency}</td>
                <td><span className={v.isActive ? 'badge badge-available' : 'badge badge-disposed'}>{v.isActive ? 'Active' : 'Inactive'}</span></td>
                <td>
                  <div className="table-actions">
                    {canManage && <>
                      <button className="btn-table-action" title="Edit" onClick={() => setEditing(v)}><Edit2 size={15} /></button>
                      <SpinnerButton className="btn-table-action delete" title="Delete" onClick={() => remove(v)} icon={Trash2} spinnerSize={15} />
                    </>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal isOpen onClose={() => setEditing(null)} title={editing === 'new' ? 'New vendor' : `Edit ${editing.name}`} maxWidth="640px">
          <VendorEditor vendor={editing === 'new' ? null : editing} currencies={currencies} onSave={save} onCancel={() => setEditing(null)} />
        </Modal>
      )}
    </div>
  );
};

/* =========================================================== settings view */

const SettingsView = ({ currencies, addToast, onSettingsChanged }) => {
  const [settings, setSettings] = useState(null);
  const [nextNumber, setNextNumber] = useState('');
  const [terms, setTerms] = useState({ current: null, history: [] });
  const [termsDraft, setTermsDraft] = useState('');
  const [savingCompany, setSavingCompany] = useState(false);
  const [savingTerms, setSavingTerms] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([api.getPoSettings(), api.getPoTerms()]);
      setSettings(s.settings);
      setNextNumber(s.nextNumber);
      setTerms(t);
      setTermsDraft(t.current?.content || '');
    } catch (err) {
      addToast('Error', err.message, 'error');
    }
  }, [addToast]);

  useEffect(() => { load(); }, [load]);

  const setField = (key) => (e) => setSettings((s) => ({ ...s, [key]: e.target.value }));

  const uploadImage = (key) => async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 400 * 1024) { addToast('Image too large', 'Please use an image under 400 KB.', 'error'); e.target.value = ''; return; }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setSettings((s) => ({ ...s, [key]: dataUrl }));
    } catch (err) {
      addToast('Error', err.message, 'error');
    } finally {
      e.target.value = '';
    }
  };

  const saveCompany = async () => {
    setSavingCompany(true);
    try {
      const payload = {
        companyName: settings.companyName, companyAddress: settings.companyAddress, companyGst: settings.companyGst,
        companyEmail: settings.companyEmail, companyPhone: settings.companyPhone, companyWebsite: settings.companyWebsite,
        logoDataUrl: settings.logoDataUrl || '', signatureDataUrl: settings.signatureDataUrl || '',
        signatureName: settings.signatureName, signatureDesignation: settings.signatureDesignation,
        numberPrefix: settings.numberPrefix, numberFormat: settings.numberFormat,
        numberPadding: Number(settings.numberPadding) || 0, nextSequence: Number(settings.nextSequence) || 1,
        resetSequenceYearly: settings.resetSequenceYearly, defaultCurrency: settings.defaultCurrency
      };
      const res = await api.updatePoSettings(payload);
      setSettings(res.settings);
      setNextNumber(res.nextNumber);
      onSettingsChanged?.(res.settings);
      addToast('Saved', 'Company & numbering settings updated.', 'success');
    } catch (err) {
      addToast('Save failed', err.message, 'error');
    } finally {
      setSavingCompany(false);
    }
  };

  const publishTerms = async () => {
    if (!termsDraft.trim()) { addToast('Empty terms', 'Terms cannot be empty.', 'error'); return; }
    setSavingTerms(true);
    try {
      const res = await api.updatePoTerms(termsDraft);
      setTerms(res);
      addToast('Published', `Terms & Conditions version ${res.current.version} is now applied to new POs.`, 'success');
    } catch (err) {
      addToast('Save failed', err.message, 'error');
    } finally {
      setSavingTerms(false);
    }
  };

  if (!settings) return <div className="card"><div className="skeleton skeleton-row" /></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div className="card">
        <span className="card-title"><Building2 /> Company Letterhead</span>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">Company name</label>
            <input className="form-input" value={settings.companyName || ''} onChange={setField('companyName')} />
          </div>
          <div className="form-group">
            <label className="form-label">GST / VAT</label>
            <input className="form-input" value={settings.companyGst || ''} onChange={setField('companyGst')} />
          </div>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input className="form-input" value={settings.companyEmail || ''} onChange={setField('companyEmail')} />
          </div>
          <div className="form-group">
            <label className="form-label">Phone</label>
            <input className="form-input" value={settings.companyPhone || ''} onChange={setField('companyPhone')} />
          </div>
          <div className="form-group">
            <label className="form-label">Website</label>
            <input className="form-input" value={settings.companyWebsite || ''} onChange={setField('companyWebsite')} />
          </div>
          <div className="form-group">
            <label className="form-label">Default currency</label>
            <CustomSelect value={settings.defaultCurrency} onChange={setField('defaultCurrency')} options={currencies.map((c) => ({ value: c, label: c }))} />
          </div>
          <div className="form-group full-width">
            <label className="form-label">Company address</label>
            <textarea className="form-input" rows={2} value={settings.companyAddress || ''} onChange={setField('companyAddress')} />
          </div>
          <div className="form-group">
            <label className="form-label">Logo (letterhead)</label>
            <input className="form-input" type="file" accept="image/*" onChange={uploadImage('logoDataUrl')} />
            {settings.logoDataUrl && <img src={settings.logoDataUrl} alt="logo" style={{ maxHeight: '48px', marginTop: '8px' }} />}
          </div>
          <div className="form-group">
            <label className="form-label">Authorised signature image</label>
            <input className="form-input" type="file" accept="image/*" onChange={uploadImage('signatureDataUrl')} />
            {settings.signatureDataUrl && <img src={settings.signatureDataUrl} alt="signature" style={{ maxHeight: '40px', marginTop: '8px' }} />}
          </div>
          <div className="form-group">
            <label className="form-label">Signatory name</label>
            <input className="form-input" value={settings.signatureName || ''} onChange={setField('signatureName')} />
          </div>
          <div className="form-group">
            <label className="form-label">Signatory designation</label>
            <input className="form-input" value={settings.signatureDesignation || ''} onChange={setField('signatureDesignation')} />
          </div>
        </div>
      </div>

      <div className="card">
        <span className="card-title"><SettingsIcon /> PO Numbering</span>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">Prefix</label>
            <input className="form-input" value={settings.numberPrefix || ''} onChange={setField('numberPrefix')} />
          </div>
          <div className="form-group">
            <label className="form-label">Format</label>
            <input className="form-input" value={settings.numberFormat || ''} onChange={setField('numberFormat')} placeholder="PO/{YYYY}/{SEQ}" />
          </div>
          <div className="form-group">
            <label className="form-label">Sequence padding</label>
            <input className="form-input" type="number" min="0" max="10" value={settings.numberPadding ?? 6} onChange={setField('numberPadding')} />
          </div>
          <div className="form-group">
            <label className="form-label">Next sequence</label>
            <input className="form-input" type="number" min="1" value={settings.nextSequence ?? 1} onChange={setField('nextSequence')} />
          </div>
          <div className="form-group">
            <label className="form-label">Reset sequence yearly</label>
            <CustomSelect
              value={settings.resetSequenceYearly ? 'yes' : 'no'}
              onChange={(e) => setSettings((s) => ({ ...s, resetSequenceYearly: e.target.value === 'yes' }))}
              options={[{ value: 'yes', label: 'Yes — restart at 1 each year' }, { value: 'no', label: 'No — keep counting' }]}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Next PO number preview</label>
            <div className="form-input" style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--primary)', display: 'flex', alignItems: 'center' }}>{nextNumber || '—'}</div>
          </div>
        </div>
        <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '4px' }}>
          Tokens: <code>{'{YYYY}'}</code> year, <code>{'{YY}'}</code> 2-digit year, <code>{'{MM}'}</code> month, <code>{'{SEQ}'}</code> running number, <code>{'{PREFIX}'}</code> prefix.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
          <button className="btn btn-primary" onClick={saveCompany} disabled={savingCompany}>
            <Save size={14} /> {savingCompany ? 'Saving…' : 'Save company & numbering'}
          </button>
        </div>
      </div>

      <div className="card">
        <span className="card-title"><FileText /> Master Terms &amp; Conditions</span>
        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginTop: '-4px' }}>
          Appended automatically to every PO. Publishing a new version applies it to future POs only —
          existing purchase orders keep the version they were generated with.
          {terms.current ? ` Current: version ${terms.current.version}.` : ''}
        </p>
        <textarea className="form-input" rows={10} style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
                  value={termsDraft} onChange={(e) => setTermsDraft(e.target.value)} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px' }}>
          <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
            {terms.history.length} version(s) on record
          </span>
          <button className="btn btn-primary" onClick={publishTerms} disabled={savingTerms}>
            <Save size={14} /> {savingTerms ? 'Publishing…' : 'Publish new version'}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ============================================================ email modal */

const EmailModal = ({ po, onClose, addToast }) => {
  const [to, setTo] = useState(po.vendorEmail || '');
  const [subject, setSubject] = useState(`Purchase Order ${po.poNumber}`);
  const [message, setMessage] = useState(`Dear ${po.vendorContactPerson || po.vendor},\n\nPlease find our Purchase Order ${po.poNumber} attached for your kind processing.\n\nRegards,`);
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (!to.trim()) { addToast('Recipient required', 'Enter an email address.', 'error'); return; }
    setSending(true);
    try {
      const res = await api.emailPurchaseOrder(po.id, { to, subject, message });
      addToast('Email sent', res.delivered ? `PO emailed to ${to}.` : `Recorded in the Email Alerts Inbox (SMTP not configured).`, 'success');
      onClose();
    } catch (err) {
      addToast('Send failed', err.message, 'error');
    } finally {
      setSending(false);
    }
  };
  return (
    <Modal isOpen onClose={onClose} title={`Email ${po.poNumber}`} maxWidth="560px"
      footer={<>
        <button className="btn btn-secondary" onClick={onClose} disabled={sending}>Cancel</button>
        <button className="btn btn-primary" onClick={send} disabled={sending}><Mail size={14} /> {sending ? 'Sending…' : 'Send'}</button>
      </>}>
      <div className="form-group"><label className="form-label">To</label><input className="form-input" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      <div className="form-group"><label className="form-label">Subject</label><input className="form-input" value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
      <div className="form-group"><label className="form-label">Message</label><textarea className="form-input" rows={6} value={message} onChange={(e) => setMessage(e.target.value)} /></div>
      {po.documents?.length ? (
        <p style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>A secure download link to the latest generated PDF (v{po.documents[0].version}) is included in the email.</p>
      ) : (
        <p style={{ fontSize: '11.5px', color: 'var(--warning, #b45309)' }}>No PDF has been generated yet — generate it first so the email can include the document link.</p>
      )}
    </Modal>
  );
};

/* =================================================================== page */

const PurchaseOrdersPage = ({ canManage = false, can, invoices = [], amcs = [], addToast }) => {
  const gate = (mod, verb) => (typeof can === 'function' ? can(mod, verb) : canManage);
  const canEdit = gate('finance', 'edit');
  const canDelete = gate('finance', 'delete');
  const canManageVendors = gate('vendors', 'create') || gate('vendors', 'edit') || gate('vendors', 'delete');
  const canManageSettings = gate('systemSettings', 'manage');

  const [view, setView] = useState('orders');
  const [orders, setOrders] = useState([]);
  const [options, setOptions] = useState({ statuses: [], currencies: ['INR'], units: ['pcs'] });
  const [vendors, setVendors] = useState([]);
  const [poSettings, setPoSettings] = useState(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortDir, setSortDir] = useState('desc');
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [emailing, setEmailing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrders(await api.getPurchaseOrders({ q: query, status, sortBy, sortDir }));
    } catch (err) {
      addToast('Error', err.message || 'Could not load purchase orders.', 'error');
    } finally {
      setLoading(false);
    }
  }, [query, status, sortBy, sortDir, addToast]);

  const refreshSettings = useCallback(async () => {
    try {
      const s = await api.getPoSettings();
      setPoSettings({ ...s.settings, __nextNumber: s.nextNumber, __terms: s.terms });
    } catch { /* settings are best-effort; PDF still renders with blanks */ }
  }, []);

  useEffect(() => {
    api.getPurchaseOrderOptions().then(setOptions).catch(() => {});
    api.getVendors().then(setVendors).catch(() => {});
    refreshSettings();
  }, [refreshSettings]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const toggleSort = (column) => {
    if (sortBy === column) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(column); setSortDir('asc'); }
  };

  const SortHeader = ({ column, children }) => (
    <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort(column)}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        {children}{sortBy === column && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </span>
    </th>
  );

  // Generate the PDF client-side, upload it, and record it as the next version.
  const generateAndStore = async (po) => {
    try {
      let settings = poSettings;
      if (!settings) {
        const s = await api.getPoSettings();
        settings = s.settings;
        setPoSettings({ ...s.settings, __nextNumber: s.nextNumber });
      }
      const file = poPdfFile({ po, items: po.items, settings });
      const uploaded = await api.uploadFile(file);
      await api.recordPurchaseOrderDocument(po.id, { filePath: uploaded.fileUrl, fileName: file.name });
      return true;
    } catch (err) {
      addToast('PDF not stored', `The PO was saved, but the document could not be stored: ${err.message}`, 'error');
      return false;
    }
  };

  const save = async (payload) => {
    setBusy(true);
    try {
      const saved = editing === 'new'
        ? await api.createPurchaseOrder(payload)
        : await api.updatePurchaseOrder(editing.id, payload);
      await generateAndStore(saved);
      addToast(editing === 'new' ? 'Purchase order created' : 'Purchase order updated',
        `${saved.poNumber} saved and PDF generated.`, 'success');
      setEditing(null);
      await load();
    } catch (err) {
      addToast('Save failed', err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (po) => {
    if (!window.confirm(`Delete purchase order ${po.poNumber} permanently?`)) return;
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
      const full = await api.getPurchaseOrder(po.id);
      setViewing(full);
      return full;
    } catch (err) {
      addToast('Error', err.message, 'error');
      return null;
    }
  };

  // PDF actions from anywhere — fetch full detail if we only have a list row.
  const withDoc = async (po, fn) => {
    let settings = poSettings;
    if (!settings) { try { settings = (await api.getPoSettings()).settings; } catch { settings = {}; } }
    const full = po.items ? po : await api.getPurchaseOrder(po.id);
    if (!full) return;
    fn({ po: full, items: full.items, settings });
  };

  const regenerate = async (po) => {
    const full = po.items ? po : await api.getPurchaseOrder(po.id);
    setBusy(true);
    const ok = await generateAndStore(full);
    setBusy(false);
    if (ok) {
      addToast('PDF generated', `A new version of ${full.poNumber} was stored.`, 'success');
      const refreshed = await openDetail(full);
      if (!refreshed) setViewing(full);
    }
  };

  if (editing) {
    return (
      <div className="card">
        <span className="card-title"><ShoppingCart /> {editing === 'new' ? 'New Purchase Order' : `Editing ${editing.poNumber}`}</span>
        <PoEditor
          po={editing === 'new' ? null : editing}
          options={options}
          vendors={vendors}
          poSettings={poSettings}
          invoices={invoices}
          amcs={amcs}
          onSave={save}
          onCancel={() => setEditing(null)}
          addToast={addToast}
        />
      </div>
    );
  }

  const tabs = [
    { id: 'orders', label: 'Purchase Orders', icon: <ShoppingCart size={14} /> },
    { id: 'vendors', label: 'Vendors', icon: <Users size={14} /> }
  ];
  if (canManageSettings) tabs.push({ id: 'settings', label: 'Settings & Terms', icon: <SettingsIcon size={14} /> });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {tabs.map((t) => (
          <button key={t.id} className={`tab-btn ${view === t.id ? 'active' : ''}`} onClick={() => setView(t.id)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {view === 'vendors' && <VendorsView canManage={canManageVendors} currencies={options.currencies || ['INR']} addToast={addToast} />}
      {view === 'settings' && canManageSettings && (
        <SettingsView currencies={options.currencies || ['INR']} addToast={addToast}
          onSettingsChanged={(s) => setPoSettings((prev) => ({ ...prev, ...s }))} />
      )}

      {view === 'orders' && (
        <div className="card">
          <div className="card-title-section">
            <span className="card-title"><ShoppingCart /> Purchase Orders</span>
            {canManage && <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> New purchase order</button>}
          </div>

          <div className="filters-row">
            <div className="filters-left" style={{ flexGrow: 1 }}>
              <div className="search-bar-container" style={{ minWidth: 'min(280px, 100%)' }}>
                <Search className="search-icon" />
                <input className="search-bar" placeholder="Search PO number, vendor or notes…" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <span>Status</span>
              <CustomSelect value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All statuses" style={{ minWidth: '160px' }}
                options={[{ value: '', label: 'All statuses' }, ...(options.statuses || []).map((s) => ({ value: s, label: s }))]} />
            </div>
          </div>

          <div className="table-container" style={{ maxHeight: '560px' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <SortHeader column="poNumber">PO Number</SortHeader>
                  <SortHeader column="vendor">Vendor</SortHeader>
                  <SortHeader column="issueDate">Date</SortHeader>
                  <SortHeader column="status">Status</SortHeader>
                  <SortHeader column="amount">Total</SortHeader>
                  <th>PDF</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7}><div className="skeleton skeleton-row" /></td></tr>
                ) : orders.length === 0 ? (
                  <tr><td colSpan={7}><div className="empty-state">
                    <div className="empty-state-icon"><ShoppingCart size={22} /></div>
                    <div className="empty-state-title">No purchase orders</div>
                    <div className="empty-state-desc">
                      {query || status ? 'Nothing matches the current search and filters.'
                        : canManage ? 'Create the first purchase order to get started.' : 'No purchase orders have been raised yet.'}
                    </div>
                  </div></td></tr>
                ) : orders.map((po) => (
                  <tr key={po.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(po)}>
                    <td style={{ fontWeight: 700, color: 'var(--primary)' }}>{po.poNumber}</td>
                    <td>{po.vendor}</td>
                    <td style={{ fontSize: '12px' }}>{asDate(po.issueDate)}</td>
                    <td><span className={STATUS_BADGE[po.status] || 'badge'}>{po.status}</span></td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{money(po.grandTotal ?? po.amount, po.currency)}</td>
                    <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                      <button className="btn-table-action" title="Download PDF" onClick={() => withDoc(po, downloadPoPdf)}>
                        <Download size={15} />
                      </button>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="table-actions">
                        {canEdit && <button className="btn-table-action" title="Edit" onClick={async () => setEditing(await api.getPurchaseOrder(po.id))}><Edit2 size={15} /></button>}
                        {canDelete && <SpinnerButton className="btn-table-action delete" title="Delete" onClick={() => remove(po)} icon={Trash2} spinnerSize={15} />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {viewing && (
        <Modal isOpen onClose={() => setViewing(null)} closeOnOverlayClick title={viewing.poNumber} maxWidth="760px"
          footer={<>
            <button className="btn btn-secondary" onClick={() => setViewing(null)}>Close</button>
            {canEdit && <button className="btn btn-primary" onClick={async () => { setEditing(viewing); setViewing(null); }}><Edit2 size={14} /> Edit</button>}
          </>}>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
            <button className="btn btn-secondary" onClick={() => withDoc(viewing, previewPoPdf)}><Eye size={14} /> Preview</button>
            <button className="btn btn-secondary" onClick={() => withDoc(viewing, downloadPoPdf)}><Download size={14} /> Download</button>
            <button className="btn btn-secondary" onClick={() => withDoc(viewing, printPoPdf)}><Printer size={14} /> Print</button>
            <button className="btn btn-secondary" onClick={() => setEmailing(viewing)}><Mail size={14} /> Email</button>
            {canManage && <button className="btn btn-secondary" onClick={() => regenerate(viewing)} disabled={busy}><RefreshCw size={14} /> {busy ? 'Working…' : 'Regenerate PDF'}</button>}
          </div>

          <div className="form-grid">
            <Detail label="Vendor" value={viewing.vendor} />
            <Detail label="Status" value={<span className={STATUS_BADGE[viewing.status] || 'badge'}>{viewing.status}</span>} />
            <Detail label="PO date" value={asDate(viewing.issueDate)} />
            <Detail label="Expected delivery" value={asDate(viewing.expectedDeliveryDate)} />
            <Detail label="Quotation ref" value={viewing.quotationRef || '—'} />
            <Detail label="Payment terms" value={viewing.paymentTerms || '—'} />
            <Detail label="Delivery schedule" value={viewing.deliverySchedule || '—'} />
            <Detail label="Delivery location" value={viewing.deliveryLocation || '—'} />
            <Detail label="Currency" value={viewing.currency} />
            <Detail label="Raised by" value={viewing.createdByName || '—'} />
          </div>

          <div className="table-container" style={{ marginTop: '12px' }}>
            <table className="data-table">
              <thead><tr><th>#</th><th>Description</th><th>Qty</th><th>Unit price</th><th>Tax %</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {(viewing.items || []).map((it, i) => (
                  <tr key={it.id || i}>
                    <td>{i + 1}</td>
                    <td>{it.description}{it.hsnCode ? <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}> · HSN {it.hsnCode}</span> : null}</td>
                    <td>{it.quantity} {it.unit}</td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{money(it.unitPrice, viewing.currency)}</td>
                    <td>{it.taxPercent}%</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{money(it.lineTotal, viewing.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginLeft: 'auto', maxWidth: '320px', marginTop: '12px' }}>
            <TotalsRow label="Subtotal" value={money(viewing.subtotal, viewing.currency)} />
            <TotalsRow label="Tax" value={money(viewing.taxTotal, viewing.currency)} />
            {viewing.discountAmount > 0 && <TotalsRow label="Discount" value={`- ${money(viewing.discountAmount, viewing.currency)}`} />}
            <TotalsRow label="Grand total" value={money(viewing.grandTotal ?? viewing.amount, viewing.currency)} strong />
          </div>
          {viewing.amountInWords && (
            <div style={{ marginTop: '8px', fontStyle: 'italic', fontSize: '12.5px', color: 'var(--text-secondary)' }}>
              {viewing.amountInWords}
            </div>
          )}

          <div className="form-group" style={{ marginTop: '16px' }}>
            <label className="form-label"><History size={13} style={{ verticalAlign: '-2px' }} /> Document versions ({viewing.documents?.length || 0})</label>
            {viewing.documents?.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {viewing.documents.map((d) => (
                  <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                    <span style={{ fontSize: '12.5px' }}>
                      <strong>v{d.version}</strong> · {d.fileName} <span style={{ color: 'var(--text-muted)' }}>· {asDate(d.createdAt)} · {d.generatedBy}</span>
                    </span>
                    <button className="btn-table-action" title="Open stored PDF"
                      onClick={() => openStoredFile(d.filePath, (m) => addToast('Cannot open file', m, 'error'))}>
                      <FileText size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No stored PDF yet. Use “Regenerate PDF” to create and store one.</span>
            )}
          </div>
        </Modal>
      )}

      {emailing && <EmailModal po={emailing} onClose={() => setEmailing(null)} addToast={addToast} />}
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
