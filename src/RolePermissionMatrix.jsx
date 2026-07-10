import React, { useEffect, useMemo, useState } from 'react';
import { Save, RotateCcw, ShieldCheck, Lock } from 'lucide-react';
import { api } from './api';
import Checkbox from './Checkbox';
import CustomSelect from './CustomSelect';
import { roleLabel, ROLE_ORDER } from './permissions';

/**
 * The Super-Admin permission matrix editor.
 *
 * One role at a time (20 modules x up to 7 verbs is too wide to show every role at
 * once), rendered as modules-down x verbs-across. A cell exists only where the verb
 * applies to that module — the model, not this component, decides which verbs a module
 * has, so the grid can never offer a nonsensical grant like "delete Dashboard".
 *
 * Super Admin is unrestricted in code, so its row is shown fully-granted and locked:
 * editing it would imply it could be reduced, which it cannot.
 *
 * Saving sends only the edited role's full sub-matrix; the backend replaces that role
 * wholesale (a shallow merge would drop sibling verbs) and re-reads its cache.
 */

const ALL_VERBS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage'];

const RolePermissionMatrix = ({ modules = [], verbLabels = {}, matrix, setMatrix, addToast, currentRole }) => {
  const isSuperAdmin = currentRole === 'Super Admin';

  // Roles to offer, in the canonical order, intersected with what the API shipped.
  const roleKeys = useMemo(() => {
    const known = new Set(Object.keys(matrix || {}));
    known.add('Super Admin');
    return ROLE_ORDER.filter((r) => known.has(r));
  }, [matrix]);

  const [selectedRole, setSelectedRole] = useState('Employee');
  const [draft, setDraft] = useState({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load the selected role's cells into an editable draft whenever either changes.
  useEffect(() => {
    const roleMatrix = (matrix && matrix[selectedRole]) || {};
    const next = {};
    for (const m of modules) {
      next[m.key] = {};
      for (const verb of m.verbs) {
        next[m.key][verb] = Boolean(roleMatrix[m.key] && roleMatrix[m.key][verb]);
      }
    }
    setDraft(next);
    setDirty(false);
  }, [selectedRole, matrix, modules]);

  const locked = isSuperAdmin ? false : selectedRole === 'Super Admin';
  const readOnly = !isSuperAdmin;

  const toggle = (moduleKey, verb) => {
    if (readOnly || locked) return;
    setDraft((prev) => ({ ...prev, [moduleKey]: { ...prev[moduleKey], [verb]: !prev[moduleKey][verb] } }));
    setDirty(true);
  };

  // Column select-all: toggle a verb across every module that supports it.
  const toggleColumn = (verb, value) => {
    if (readOnly || locked) return;
    setDraft((prev) => {
      const next = { ...prev };
      for (const m of modules) {
        if (m.verbs.includes(verb)) next[m.key] = { ...next[m.key], [verb]: value };
      }
      return next;
    });
    setDirty(true);
  };

  const save = async () => {
    if (saving || locked) return;
    setSaving(true);
    try {
      const payload = { matrix: { [selectedRole]: draft } };
      await api.updateRolePermissions(payload);
      // Reflect the change in the parent matrix so gating updates without a refetch.
      setMatrix((prev) => ({ ...prev, [selectedRole]: draft }));
      addToast('Permissions saved', `${roleLabel(selectedRole)} updated.`, 'success');
      setDirty(false);
    } catch (err) {
      addToast('Save failed', err.message || 'Could not save permissions.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    const roleMatrix = (matrix && matrix[selectedRole]) || {};
    const next = {};
    for (const m of modules) {
      next[m.key] = {};
      for (const verb of m.verbs) next[m.key][verb] = Boolean(roleMatrix[m.key] && roleMatrix[m.key][verb]);
    }
    setDraft(next);
    setDirty(false);
  };

  const verbsInUse = ALL_VERBS.filter((v) => modules.some((m) => m.verbs.includes(v)));

  return (
    <div className="card">
      <span className="card-title"><ShieldCheck /> Role & Permission Matrix</span>
      <p className="card-subtitle" style={{ marginTop: '-8px' }}>
        Grant each role granular access per module. Super Administrator is unrestricted and
        cannot be limited. {readOnly && 'Only a Super Administrator can make changes; shown read-only.'}
      </p>

      <div className="action-row" style={{ marginBottom: 'var(--sp-4)' }}>
        <div style={{ minWidth: '220px' }}>
          <CustomSelect
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value)}
            options={roleKeys.map((r) => ({ value: r, label: roleLabel(r) }))}
          />
        </div>
        {locked && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: 'var(--text-muted)' }}>
            <Lock size={14} /> Unrestricted — every permission is always granted.
          </span>
        )}
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ minWidth: '180px' }}>Module</th>
              {verbsInUse.map((verb) => (
                <th key={verb} style={{ textAlign: 'center', width: '84px' }}>
                  <div>{verbLabels[verb] || verb}</div>
                  {isSuperAdmin && !locked && (
                    <div style={{ display: 'flex', justifyContent: 'center', gap: '4px', marginTop: '2px' }}>
                      <button type="button" className="btn btn-secondary btn-sm" style={{ padding: '0 6px', minHeight: '20px', fontSize: '10px' }}
                        onClick={() => toggleColumn(verb, true)}>all</button>
                      <button type="button" className="btn btn-secondary btn-sm" style={{ padding: '0 6px', minHeight: '20px', fontSize: '10px' }}
                        onClick={() => toggleColumn(verb, false)}>none</button>
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => (
              <tr key={m.key}>
                <td style={{ fontWeight: 600 }}>{m.label}</td>
                {verbsInUse.map((verb) => (
                  <td key={verb} style={{ textAlign: 'center' }}>
                    {m.verbs.includes(verb) ? (
                      <Checkbox
                        checked={locked ? true : Boolean(draft[m.key] && draft[m.key][verb])}
                        disabled={readOnly || locked}
                        onChange={() => toggle(m.key, verb)}
                        aria-label={`${verbLabels[verb] || verb} ${m.label} for ${roleLabel(selectedRole)}`}
                      />
                    ) : (
                      <span style={{ color: 'var(--border-color)' }}>·</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isSuperAdmin && !locked && (
        <div className="action-row" style={{ marginTop: 'var(--sp-4)' }}>
          <button className="btn btn-primary" onClick={save} disabled={!dirty || saving} aria-busy={saving}>
            <Save size={15} />
            {saving ? 'Saving…' : `Save ${roleLabel(selectedRole)}`}
          </button>
          <button className="btn btn-secondary" onClick={discard} disabled={!dirty || saving}>
            <RotateCcw size={15} /> Discard
          </button>
          {dirty && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Unsaved changes</span>}
        </div>
      )}
    </div>
  );
};

export default RolePermissionMatrix;
