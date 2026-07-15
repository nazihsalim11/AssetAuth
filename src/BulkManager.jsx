import React, { useState, useEffect, useCallback } from 'react';
import { Download, FileUp, AlertTriangle, RefreshCw, FileSpreadsheet, CheckCircle2, Trash2 } from 'lucide-react';
import { api } from './api';
import Modal from './Modal';
import {
  parseSpreadsheet, downloadTemplate, downloadExport, downloadValidationReport,
} from './utils/spreadsheet';

/**
 * One reusable bulk-management dialog for every entity the backend registers
 * (Vendors, AMC, and anything added to backend/src/bulk/registry.js later). It is entirely
 * schema-driven: it fetches /api/bulk/:entity/schema on open and renders template columns,
 * parsing, validation, preview, import/update/delete and export from that description — so a
 * new entity needs no new component, just a registry entry.
 *
 * Props:
 *   entity      registry key, e.g. "vendor" | "amc"
 *   isOpen, onClose
 *   onComplete  called after a successful write so the host can reload its list
 *   addToast    (title, message, type) toast helper
 */

const MODES = [
  { key: 'import', label: 'Import new', verb: 'Import', icon: FileUp },
  { key: 'update', label: 'Update existing', verb: 'Update', icon: RefreshCw },
  { key: 'delete', label: 'Delete', verb: 'Delete', icon: Trash2 },
];

const BulkManager = ({ entity, isOpen, onClose, onComplete, addToast }) => {
  const [schema, setSchema] = useState(null);
  const [schemaError, setSchemaError] = useState('');
  const [mode, setMode] = useState('import');
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);   // { summary, errors }
  const [validated, setValidated] = useState(false);

  const reset = useCallback(() => {
    setFile(null); setRows(null); setResult(null); setValidated(false);
  }, []);

  // Load the entity's schema once per open.
  useEffect(() => {
    if (!isOpen) return;
    setSchema(null); setSchemaError(''); setMode('import'); reset();
    let cancelled = false;
    (async () => {
      try {
        const s = await api.getBulkSchema(entity);
        if (!cancelled) setSchema(s);
      } catch (err) {
        if (!cancelled) setSchemaError(err.message || 'Could not load the import schema.');
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, entity, reset]);

  if (!isOpen) return null;

  const label = schema?.labelPlural || entity;

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f); setResult(null); setValidated(false);
    try {
      const parsed = await parseSpreadsheet(f);
      setRows(parsed);
      if (parsed.length === 0) addToast?.('Empty file', 'No rows were found in that file.', 'error');
    } catch (err) {
      addToast?.('Parse failed', err.message, 'error');
      setRows(null);
    }
  };

  const doTemplate = async () => {
    try { await downloadTemplate(entity, schema.headers, schema.sample); }
    catch (err) { addToast?.('Error', err.message, 'error'); }
  };

  const doExport = async () => {
    setBusy(true);
    try {
      const { headers, rows: data } = await api.bulkExport(entity);
      await downloadExport(entity, headers, data);
      addToast?.('Exported', `${data.length} ${label} exported.`, 'success');
    } catch (err) {
      addToast?.('Export failed', err.message, 'error');
    } finally { setBusy(false); }
  };

  const doValidate = async () => {
    if (!rows?.length) return;
    setBusy(true);
    try {
      const res = await api.bulkValidate(entity, rows);
      setResult(res); setValidated(true);
    } catch (err) {
      addToast?.('Validation failed', err.message, 'error');
    } finally { setBusy(false); }
  };

  const doRun = async () => {
    if (mode === 'delete') return doDelete();
    if (!rows?.length) return;
    setBusy(true);
    try {
      const res = mode === 'update'
        ? await api.bulkUpdate(entity, rows)
        : await api.bulkImport(entity, rows);
      setResult(res);
      const n = res.summary?.success || 0;
      if (n > 0) { addToast?.('Done', `${n} ${label} ${mode === 'update' ? 'updated' : 'imported'}.`, 'success'); onComplete?.(); }
      else addToast?.('Nothing applied', 'No rows passed validation. See the report below.', 'error');
    } catch (err) {
      addToast?.('Operation failed', err.message, 'error');
    } finally { setBusy(false); }
  };

  const doDelete = async () => {
    if (!rows?.length) return;
    const header = schema.matchHeader;
    const ids = rows.map((r) => r[header]).filter((v) => v !== undefined && v !== null && String(v).trim() !== '');
    if (ids.length === 0) {
      addToast?.('Missing key column', `The file must contain a "${header}" column identifying rows to delete.`, 'error');
      return;
    }
    if (!window.confirm(`Delete ${ids.length} ${label} by ${header}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const res = await api.bulkDelete(entity, ids);
      setResult({ summary: { total: ids.length, success: res.deleted, failed: res.notFound?.length || 0, duplicate: 0 }, errors: (res.notFound || []).map((v) => ({ row: '-', column: header, value: v, expected: '', suggestion: null, error: `No ${schema.label} found with ${header} "${v}".` })) });
      if (res.deleted > 0) { addToast?.('Deleted', `${res.deleted} ${label} removed.`, 'success'); onComplete?.(); }
    } catch (err) {
      addToast?.('Delete failed', err.message, 'error');
    } finally { setBusy(false); }
  };

  const summary = result?.summary;
  const errors = result?.errors || [];
  const activeMode = MODES.find((m) => m.key === mode);

  return (
    <Modal
      isOpen
      onClose={onClose}
      closeDisabled={busy}
      closeOnEscape={!busy}
      title={`Bulk Management — ${label}`}
      subtitle="Template, import, update, delete, export & validation"
      size="xl"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Close</button>
          {mode !== 'delete' && (
            <button type="button" className="btn btn-secondary" onClick={doValidate} disabled={!rows?.length || busy}>
              <CheckCircle2 size={15} /> Validate only
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={doRun} disabled={!rows?.length || busy} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {activeMode.icon && <activeMode.icon size={15} />} {activeMode.verb}
          </button>
        </>
      }
    >
      {schemaError && (
        <div className="import-error-log"><div className="import-error-title"><AlertTriangle size={16} /><span>{schemaError}</span></div></div>
      )}

      {!schema && !schemaError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--primary)' }}>
          <RefreshCw className="animate-spin" size={16} /> Loading schema…
        </div>
      )}

      {schema && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '18px' }}>
            <button className="btn btn-secondary" onClick={doTemplate} disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Download size={15} /> Download Template
            </button>
            <button className="btn btn-secondary" onClick={doExport} disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FileSpreadsheet size={15} /> Export Current
            </button>
          </div>

          {/* Mode selector */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
            {MODES.map((m) => (
              <button
                key={m.key}
                className={`btn ${mode === m.key ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => { setMode(m.key); setResult(null); setValidated(false); }}
                disabled={busy}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px' }}
              >
                <m.icon size={14} /> {m.label}
              </button>
            ))}
          </div>

          <p style={{ margin: '0 0 12px', fontSize: '12.5px', color: 'var(--text-secondary)' }}>
            {mode === 'delete'
              ? <>Upload a file whose <strong>{schema.matchHeader}</strong> column lists the {label} to delete.</>
              : mode === 'update'
                ? <>Upload a file keyed by <strong>{schema.matchHeader}</strong>; matching {label} are updated. Missing rows are reported, not created.</>
                : <>Upload an .xlsx/.csv using the template columns. Every row is validated; valid rows are imported and duplicates are reported.</>}
          </p>

          {/* Column reference */}
          <details style={{ marginBottom: '14px' }}>
            <summary style={{ cursor: 'pointer', fontSize: '12px', color: 'var(--text-muted)' }}>Template columns ({schema.headers.length})</summary>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
              {schema.columns.map((c) => (
                <span key={c.key} style={{ fontSize: '11px', padding: '2px 8px', borderRadius: 'var(--radius-full)', background: 'var(--bg-sidebar)', border: '1px solid var(--border-color)' }}>
                  {c.header}{c.required ? ' *' : ''}{c.options ? ` (${c.options.join('/')})` : ''}{c.master ? ` ↪ ${c.master}` : ''}
                </span>
              ))}
            </div>
          </details>

          {/* Dropzone */}
          <div style={{ border: '2px dashed var(--border-color)', borderRadius: 'var(--radius-lg)', padding: '24px 20px', textAlign: 'center', background: 'var(--bg-sidebar)', position: 'relative' }}>
            <input type="file" accept=".xlsx,.csv" onChange={onFile} disabled={busy}
              style={{ opacity: 0, position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'pointer' }} />
            <FileUp size={30} style={{ color: 'var(--primary)', marginBottom: '8px' }} />
            {file
              ? <p style={{ fontWeight: 600, fontSize: '13px' }}>{file.name}{rows ? ` — ${rows.length} row(s)` : ''}</p>
              : <p style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>Drag & drop or click to choose an Excel/CSV file</p>}
          </div>

          {busy && (
            <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--primary)' }}>
              <RefreshCw className="animate-spin" size={16} /> Working…
            </div>
          )}

          {summary && (
            <div style={{ marginTop: '20px' }}>
              <h4 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>
                {validated ? 'Validation Results' : `${activeMode.verb} Results`}
              </h4>
              <div className="import-summary-container">
                <div className="import-summary-card"><div className="import-summary-val" style={{ color: 'var(--primary)' }}>{summary.total}</div><div className="import-summary-lbl">Total Rows</div></div>
                <div className="import-summary-card"><div className="import-summary-val" style={{ color: 'var(--status-available)' }}>{summary.success}</div><div className="import-summary-lbl">{validated ? 'Would Apply' : 'Applied'}</div></div>
                <div className="import-summary-card"><div className="import-summary-val" style={{ color: 'var(--status-disposed)' }}>{summary.failed}</div><div className="import-summary-lbl">Failed</div></div>
                <div className="import-summary-card"><div className="import-summary-val" style={{ color: 'var(--status-maintenance)' }}>{summary.duplicate}</div><div className="import-summary-lbl">Duplicates</div></div>
              </div>

              {errors.length > 0 && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '14px' }}>
                    <button className="btn btn-secondary" onClick={() => downloadValidationReport(entity, errors)} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                      <Download size={14} /> Download validation report
                    </button>
                  </div>
                  <div className="import-error-log">
                    <div className="import-error-title"><AlertTriangle size={16} /><span>Row-Level Faults ({errors.length})</span></div>
                    <ul className="import-error-list">
                      {errors.slice(0, 200).map((err, idx) => (
                        <li key={idx} className="import-error-item">
                          <span className="import-error-row">Row {err.row}{err.column && err.column !== '(row)' ? ` · ${err.column}` : ''}:</span>
                          <span style={{ color: 'var(--text-primary)' }}>
                            {err.error}
                            {err.suggestion ? <em style={{ color: 'var(--text-muted)' }}> — did you mean “{err.suggestion}”?</em> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
};

export default BulkManager;
