import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Archive, Check, Pencil, Plus, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import { SpinnerButton } from '../../SpinnerButton';

/**
 * Admin management for a single master table (departments or locations).
 *
 * Data-driven end to end: the list is fetched from the API (including archived rows), and
 * add / rename / archive / restore all go straight to the backend. There is no hardcoded
 * seed here — an empty master shows an informative empty state, never placeholder values.
 * A failed load shows an error with Retry.
 */
export function MasterList({ title, noun, listFn, createFn, updateFn, deleteFn, canCreate, canEdit, canDelete, addToast, onChanged, softDelete = true }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listFn({ all: true }));
    } catch (err) {
      setError(err.message || `Could not load ${noun}s`);
    } finally {
      setLoading(false);
    }
  }, [listFn, noun]);

  useEffect(() => { load(); }, [load]);

  const afterChange = async () => { await load(); onChanged?.(); };

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await createFn({ name });
      setNewName('');
      addToast?.(`${title} added`, `"${name}" is now available.`, 'success');
      await afterChange();
    } catch (err) {
      addToast?.('Could not add', err.message, 'error');
    }
  };

  const saveRename = async (row) => {
    const name = editName.trim();
    if (!name || name === row.name) { setEditingId(null); return; }
    try {
      await updateFn(row.id, { name });
      setEditingId(null);
      addToast?.(`${title} renamed`, `"${row.name}" → "${name}".`, 'success');
      await afterChange();
    } catch (err) {
      addToast?.('Could not rename', err.message, 'error');
    }
  };

  const archive = async (row) => {
    try {
      await deleteFn(row.id);
      addToast?.(`${title} archived`, `"${row.name}" will no longer appear in pickers.`, 'success');
      await afterChange();
    } catch (err) {
      addToast?.('Could not archive', err.message, 'error');
    }
  };

  // Permanent delete. The backend refuses (409) if anything still references the record;
  // its message explains what and suggests archiving instead, which we surface as-is.
  const remove = async (row) => {
    if (!window.confirm(`Permanently delete "${row.name}"? This cannot be undone.`)) return;
    try {
      await deleteFn(row.id, { permanent: true });
      addToast?.(`${title} deleted`, `"${row.name}" was permanently removed.`, 'success');
      await afterChange();
    } catch (err) {
      addToast?.('Cannot delete', err.message, 'error');
    }
  };

  const restore = async (row) => {
    try {
      await updateFn(row.id, { isActive: true });
      addToast?.(`${title} restored`, `"${row.name}" is available again.`, 'success');
      await afterChange();
    } catch (err) {
      addToast?.('Could not restore', err.message, 'error');
    }
  };

  return (
    <div className="card" style={{ flex: 1, minWidth: '280px' }}>
      <span className="card-title">{title}</span>

      {canCreate && (
        <div style={{ display: 'flex', gap: '8px', margin: '10px 0 16px' }}>
          <input
            className="form-input"
            placeholder={`Add a ${noun}…`}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          />
          <SpinnerButton className="btn btn-primary btn-sm" onClick={add} loadingText="Adding…">
            <Plus size={14} style={{ verticalAlign: '-2px' }} /> Add
          </SpinnerButton>
        </div>
      )}

      {loading && <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '8px 0' }}>Loading…</div>}

      {error && !loading && (
        <div style={{ padding: '16px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' }}>
          <AlertTriangle size={18} style={{ color: 'var(--status-disposed)' }} />
          <span style={{ fontSize: '13px', color: 'var(--status-disposed)' }}>{error}</span>
          <button className="btn btn-secondary btn-sm" onClick={load}><RefreshCw size={13} style={{ verticalAlign: '-2px', marginRight: '5px' }} />Retry</button>
        </div>
      )}

      {!loading && !error && rows && rows.length === 0 && (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
          No {noun}s yet. {canCreate ? `Add your first ${noun} above.` : `Ask an administrator to add ${noun}s.`}
        </div>
      )}

      {!loading && !error && rows && rows.length > 0 && (
        <div className="master-list">
          {rows.map((row) => {
            // Masters without an is_active column (e.g. KB categories, softDelete=false) are
            // always "active" — the archive/restore controls simply do not apply to them.
            const active = row.isActive !== false;
            return (
            <div key={row.id} className="master-row" style={{ opacity: active ? 1 : 0.6 }}>
              {editingId === row.id ? (
                <>
                  <input className="form-input form-input-sm" value={editName} autoFocus
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveRename(row); if (e.key === 'Escape') setEditingId(null); }} />
                  <div className="master-row-actions">
                    <button className="btn btn-secondary btn-sm" title="Save" onClick={() => saveRename(row)}><Check size={14} /></button>
                    <button className="btn btn-secondary btn-sm" title="Cancel" onClick={() => setEditingId(null)}><X size={14} /></button>
                  </div>
                </>
              ) : (
                <>
                  <span className="master-row-name">
                    {row.name}
                    {!active && <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' }}>(archived)</span>}
                  </span>
                  <div className="master-row-actions">
                    {canEdit && active && (
                      <button className="btn btn-secondary btn-sm" title="Rename" onClick={() => { setEditingId(row.id); setEditName(row.name); }}><Pencil size={13} /></button>
                    )}
                    {softDelete && canDelete && active && (
                      <button className="btn btn-secondary btn-sm" title="Archive (hide from pickers, keep history)" style={{ color: 'var(--status-maintenance)' }} onClick={() => archive(row)}><Archive size={13} /></button>
                    )}
                    {softDelete && canEdit && !active && (
                      <button className="btn btn-secondary btn-sm" title="Restore" onClick={() => restore(row)}><RotateCcw size={13} /></button>
                    )}
                    {canDelete && (
                      <button className="btn btn-secondary btn-sm" title={softDelete ? 'Delete permanently (only if unused)' : 'Delete'} style={{ color: 'var(--status-disposed)' }} onClick={() => remove(row)}><Trash2 size={13} /></button>
                    )}
                  </div>
                </>
              )}
            </div>
          );
          })}
        </div>
      )}
    </div>
  );
}

export default function MasterDataPage({ canManage, addToast, onChanged }) {
  // The list read is open to all; the write verbs gate the controls (backend re-checks).
  const c = canManage || {};
  return (
    <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
      <MasterList
        title="Departments" noun="department"
        listFn={api.getDepartments} createFn={api.createDepartment} updateFn={api.updateDepartment} deleteFn={api.deleteDepartment}
        canCreate={c.deptCreate} canEdit={c.deptEdit} canDelete={c.deptDelete}
        addToast={addToast} onChanged={onChanged}
      />
      <MasterList
        title="Locations" noun="location"
        listFn={api.getLocations} createFn={api.createLocation} updateFn={api.updateLocation} deleteFn={api.deleteLocation}
        canCreate={c.locCreate} canEdit={c.locEdit} canDelete={c.locDelete}
        addToast={addToast} onChanged={onChanged}
      />
    </div>
  );
}
