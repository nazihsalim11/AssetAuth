import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { jsPDF } from 'jspdf';
import * as XLSX from 'xlsx';
import {
  FileText, Download, Printer, Mail, Play, CalendarClock, Plus, Trash2, Filter, X
} from 'lucide-react';
import { api } from './api';
import Modal from './Modal';
import CustomSelect from './CustomSelect';
import { silk } from './engine/motion';

/* --------------------------------------------------------------- formatting */

const fmtCell = (value, type) => {
  if (value == null || value === '') return '—';
  switch (type) {
    case 'money': return `Rs ${Number(value).toLocaleString('en-IN')}`;
    case 'number': return String(value);
    case 'bool': return value ? 'Yes' : 'No';
    case 'date': return String(value).slice(0, 10);
    case 'datetime': return new Date(value).toLocaleString();
    default: return String(value);
  }
};

const todayStamp = () => new Date().toISOString().slice(0, 10);

/* ----------------------------------------------------------------- exports */

const exportExcel = (report) => {
  const data = report.rows.map((r) => {
    const o = {};
    report.columns.forEach((c) => { o[c.label] = r[c.key] ?? ''; });
    return o;
  });
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  XLSX.writeFile(wb, `${report.key}_${todayStamp()}.xlsx`);
};

const exportCsv = (report) => {
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = report.columns.map((c) => esc(c.label)).join(',');
  const lines = report.rows.map((r) => report.columns.map((c) => esc(r[c.key])).join(','));
  const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${report.key}_${todayStamp()}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const exportPdf = (report) => {
  const doc = new jsPDF({ orientation: 'landscape' });
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  doc.text(report.title, 14, 18);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(`Generated: ${new Date(report.generatedAt).toLocaleString()}`, 14, 25);

  const cols = report.columns;
  const colWidth = Math.floor(268 / cols.length);
  let y = 34;
  doc.setFont('helvetica', 'bold');
  cols.forEach((c, i) => doc.text(String(c.label).slice(0, Math.floor(colWidth / 1.9)), 14 + i * colWidth, y));
  doc.line(14, y + 2, 282, y + 2);
  doc.setFont('helvetica', 'normal');
  y += 8;

  report.rows.forEach((row) => {
    if (y > 195) {
      doc.addPage(); y = 20;
      doc.setFont('helvetica', 'bold');
      cols.forEach((c, i) => doc.text(String(c.label).slice(0, Math.floor(colWidth / 1.9)), 14 + i * colWidth, y));
      doc.line(14, y + 2, 282, y + 2);
      doc.setFont('helvetica', 'normal'); y += 8;
    }
    cols.forEach((c, i) => {
      const text = fmtCell(row[c.key], c.type).replace('Rs ', 'Rs');
      doc.text(text.length > 18 ? text.slice(0, 16) + '..' : text, 14 + i * colWidth, y);
    });
    y += 6;
  });
  doc.save(`${report.key}_${todayStamp()}.pdf`);
};

/* --------------------------------------------------------------- filter bar */

const FilterBar = ({ report, filters, setFilters, options }) => {
  if (!report) return null;
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const has = (k) => (report.filters || []).includes(k);

  // The status filter's options depend on the report.
  const statusOptions = report.key === 'purchase_orders' ? options.poStatuses
    : report.key === 'finance_summary' ? options.paymentStatuses
      : options.ticketStatuses;

  const Select = ({ k, label, opts }) => (
    <div className="form-group" style={{ margin: 0, minWidth: '160px' }}>
      <label className="form-label" style={{ fontSize: '11px' }}>{label}</label>
      <CustomSelect value={filters[k] || ''} onChange={(e) => set({ [k]: e.target.value })} searchable
        options={[{ value: '', label: `All` }, ...(opts || []).map((o) => ({ value: o, label: o }))]} />
    </div>
  );

  return (
    <div className="card" style={{ padding: '16px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-muted)', fontWeight: 700 }}>
        <Filter size={13} /> Filters
      </span>
      {has('department') && <Select k="department" label="Department" opts={options.departments} />}
      {has('category') && <Select k="category" label="Category" opts={options.categories} />}
      {has('branch') && <Select k="branch" label="Branch / Location" opts={options.branches} />}
      {has('vendor') && <Select k="vendor" label="Vendor" opts={options.vendors} />}
      {has('status') && <Select k="status" label="Status" opts={statusOptions} />}
      {has('priority') && <Select k="priority" label="Priority" opts={options.priorities} />}
      {has('employee') && (
        <div className="form-group" style={{ margin: 0, minWidth: '160px' }}>
          <label className="form-label" style={{ fontSize: '11px' }}>Employee</label>
          <input className="form-input" value={filters.employee || ''} onChange={(e) => set({ employee: e.target.value })} placeholder="Name contains…" />
        </div>
      )}
      {has('dateFrom') && (
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label" style={{ fontSize: '11px' }}>From</label>
          <input className="form-input" type="date" value={filters.dateFrom || ''} onChange={(e) => set({ dateFrom: e.target.value })} />
        </div>
      )}
      {has('dateTo') && (
        <div className="form-group" style={{ margin: 0 }}>
          <label className="form-label" style={{ fontSize: '11px' }}>To</label>
          <input className="form-input" type="date" value={filters.dateTo || ''} onChange={(e) => set({ dateTo: e.target.value })} />
        </div>
      )}
      {Object.keys(filters).some((k) => filters[k]) && (
        <button className="btn btn-secondary btn-sm" onClick={() => setFilters({})}><X size={13} /> Clear</button>
      )}
    </div>
  );
};

/* --------------------------------------------------- schedule editor modal */

const ScheduleModal = ({ reportKey, reportLabel, filters, existing, onClose, onSaved, addToast }) => {
  const [name, setName] = useState(existing?.name || reportLabel);
  const [frequency, setFrequency] = useState(existing?.frequency || 'weekly');
  const [recipients, setRecipients] = useState((existing?.recipients || []).join(', '));
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const list = recipients.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) { addToast('Missing recipients', 'Add at least one email address.', 'error'); return; }
    setSaving(true);
    try {
      const payload = { reportKey: existing?.reportKey || reportKey, name, filters: existing?.filters || filters, frequency, recipients: list, active: true };
      if (existing?.id) await api.updateScheduledReport(existing.id, payload);
      else await api.createScheduledReport(payload);
      addToast('Scheduled', 'Report schedule saved.', 'success');
      onSaved();
    } catch (err) {
      addToast('Save failed', err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} as="form" onSubmit={submit} size="md"
      title={existing ? 'Edit Schedule' : 'Schedule Report'}
      subtitle={existing?.reportLabel || reportLabel}
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Schedule'}</button></>}
    >
      <div className="form-group"><label className="form-label">Schedule name</label>
        <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="form-group"><label className="form-label">Frequency</label>
        <CustomSelect value={frequency} onChange={(e) => setFrequency(e.target.value)}
          options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]} /></div>
      <div className="form-group"><label className="form-label">Recipient emails</label>
        <input className="form-input" value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="a@x.com, b@y.com" />
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Comma or space separated. The current filters are saved with the schedule.</span></div>
    </Modal>
  );
};

/* ------------------------------------------------------------------ page */

const ReportsCenter = ({ addToast, canExport = false }) => {
  const [options, setOptions] = useState(null);
  const [reportKey, setReportKey] = useState('');
  const [filters, setFilters] = useState({});
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);
  const [schedules, setSchedules] = useState([]);
  const [scheduling, setScheduling] = useState(null); // {} to open for current report, or an existing row

  const load = useCallback(async () => {
    try {
      const opt = await api.getReportOptions();
      // The API groups the filter value-lists under `filterOptions`, but this page
      // reads them at the top level (`options.departments`, `options.categories`, …).
      // Flatten the two shapes together — and default every list — so a filter whose
      // options the backend omitted renders as an empty "All" select instead of
      // throwing "Cannot read properties of undefined (reading 'map')".
      const reports = opt?.reports || [];
      setOptions({ ...(opt?.filterOptions || {}), ...opt, reports });
      if (reports.length) setReportKey((k) => k || reports[0].key);
      setSchedules((await api.getScheduledReports()) || []);
    } catch (err) {
      addToast('Load failed', err.message, 'error');
    }
  }, [addToast]);

  useEffect(() => { load(); }, [load]);

  const selectedReport = options?.reports.find((r) => r.key === reportKey);

  // Reset filters and clear the last result whenever the report changes.
  useEffect(() => { setFilters({}); setReport(null); }, [reportKey]);

  const run = async () => {
    if (!reportKey) return;
    setRunning(true);
    try {
      const result = await api.runReport(reportKey, filters);
      // Guarantee the arrays the table/exports iterate over always exist, so a
      // sparse response can never surface as a `.map` of undefined.
      setReport({ ...result, columns: result?.columns || [], rows: result?.rows || [] });
    } catch (err) {
      addToast('Report failed', err.message, 'error');
    } finally {
      setRunning(false);
    }
  };

  const email = async () => {
    const input = window.prompt('Email this report to (comma-separated addresses):');
    if (!input) return;
    const recipients = input.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!recipients.length) return;
    try {
      const res = await api.emailReport(reportKey, filters, recipients);
      addToast('Report sent', res.delivered ? `Emailed to ${res.recipients} recipient(s).` : `Queued to ${res.recipients} recipient(s) (SMTP not configured — see Email Alerts Inbox).`, 'success');
    } catch (err) {
      addToast('Email failed', err.message, 'error');
    }
  };

  const removeSchedule = async (s) => {
    if (!window.confirm(`Delete the schedule "${s.name}"?`)) return;
    try { await api.deleteScheduledReport(s.id); setSchedules(await api.getScheduledReports()); addToast('Deleted', 'Schedule removed.', 'success'); }
    catch (err) { addToast('Delete failed', err.message, 'error'); }
  };

  if (!options) return <div className="card" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading report center…</div>;

  const grouped = options.reports.reduce((acc, r) => { (acc[r.group] ||= []).push(r); return acc; }, {});

  return (
    <motion.div {...silk} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* report picker */}
      <div className="card" style={{ padding: '16px', display: 'flex', gap: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-group" style={{ margin: 0, minWidth: '280px', flex: 1 }}>
          <label className="form-label" style={{ fontSize: '11px' }}><FileText size={12} style={{ verticalAlign: '-1px' }} /> Report</label>
          <CustomSelect value={reportKey} onChange={(e) => setReportKey(e.target.value)} searchable
            options={Object.entries(grouped).flatMap(([group, list]) => list.map((r) => ({ value: r.key, label: `${group} — ${r.label}` })))} />
        </div>
        <button className="btn btn-primary" onClick={run} disabled={running}><Play size={15} /> {running ? 'Running…' : 'Run Report'}</button>
      </div>

      <FilterBar report={selectedReport} filters={filters} setFilters={setFilters} options={options} />

      {report && (
        <>
          {/* actions */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
              {Object.entries(report.summary || {}).map(([k, v]) => <span key={k}>{k}: <strong style={{ color: 'var(--text-primary)' }}>{v}</strong></span>)}
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary btn-sm" onClick={() => exportExcel(report)} disabled={!report.rows.length}><Download size={14} /> Excel</button>
              <button className="btn btn-secondary btn-sm" onClick={() => exportCsv(report)} disabled={!report.rows.length}><Download size={14} /> CSV</button>
              <button className="btn btn-secondary btn-sm" onClick={() => exportPdf(report)} disabled={!report.rows.length}><Download size={14} /> PDF</button>
              <button className="btn btn-secondary btn-sm" onClick={() => window.print()}><Printer size={14} /> Print</button>
              {canExport && <button className="btn btn-secondary btn-sm" onClick={email} disabled={!report.rows.length}><Mail size={14} /> Email</button>}
              {canExport && <button className="btn btn-secondary btn-sm" onClick={() => setScheduling({})}><CalendarClock size={14} /> Schedule</button>}
            </div>
          </div>

          {/* table */}
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%' }}>
              <thead><tr>{report.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {report.rows.length === 0 && <tr><td colSpan={report.columns.length} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px' }}>No rows match these filters.</td></tr>}
                {report.rows.map((r, i) => (
                  <tr key={i}>{report.columns.map((c) => <td key={c.key}>{fmtCell(r[c.key], c.type)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* scheduled reports */}
      <div className="card" style={{ padding: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <span className="card-title" style={{ margin: 0 }}><CalendarClock size={14} style={{ verticalAlign: '-2px' }} /> Scheduled Reports</span>
        </div>
        {schedules.length === 0 && <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No scheduled reports. Run a report and click Schedule to email it on a cadence.</div>}
        {schedules.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {schedules.map((s) => (
              <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', padding: '10px 12px', background: 'var(--bg-sidebar)', borderRadius: 'var(--radius-md)', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '13px' }}>{s.name} <span className="badge badge-assigned" style={{ marginLeft: '6px' }}>{s.frequency}</span> {!s.active && <span className="badge badge-on-hold">paused</span>}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{s.reportLabel} → {(s.recipients || []).join(', ')}{s.nextRun ? ` · next ${new Date(s.nextRun).toLocaleDateString()}` : ''}</div>
                </div>
                {canExport && (
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => setScheduling(s)}>Edit</button>
                    <button className="btn btn-danger btn-sm" onClick={() => removeSchedule(s)} aria-label="Delete"><Trash2 size={13} /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {scheduling && (
        <ScheduleModal
          reportKey={reportKey} reportLabel={selectedReport?.label} filters={filters}
          existing={scheduling.id ? scheduling : null}
          onClose={() => setScheduling(null)}
          onSaved={async () => { setScheduling(null); setSchedules(await api.getScheduledReports()); }}
          addToast={addToast}
        />
      )}
    </motion.div>
  );
};

export default ReportsCenter;
