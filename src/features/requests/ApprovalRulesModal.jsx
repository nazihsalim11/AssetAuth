import React, { useEffect, useState } from 'react';
import { AlertTriangle, GitBranch, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import Modal from '../../Modal';
import CustomSelect from '../../CustomSelect';
import Checkbox from '../../Checkbox';
import { SpinnerButton } from '../../SpinnerButton';

/**
 * Approval rules — who has to sign what, configured rather than coded.
 *
 * A rule matches on the facts a request publishes about itself (type, department, cost band,
 * priority, category) and builds the ladder. The vocabulary is all server-supplied, so the
 * editor cannot offer a role or a department the matching engine would not recognise.
 *
 * The screen is deliberately blunt about two things that are easy to get wrong: which rule
 * actually wins when several match (the most specific one, shown on each row), and what a
 * level with several approvers means (all of them, or any one of them).
 */

const BLANK_LEVEL = { level: 1, mode: 'all', roles: [], userIds: [] };

const BLANK_RULE = {
  name: '',
  description: '',
  requestType: '',
  active: true,
  match: { departments: [], priorities: [], categories: [], minAmount: '', maxAmount: '' },
  levels: [{ ...BLANK_LEVEL }],
};

// A rule row as the server stores it -> the shape this editor works in.
const toForm = (rule) => ({
  id: rule.id,
  name: rule.name || '',
  description: rule.description || '',
  requestType: rule.request_type || '',
  active: rule.active !== false,
  match: {
    departments: rule.match?.departments || [],
    priorities: rule.match?.priorities || [],
    categories: rule.match?.categories || [],
    minAmount: rule.match?.minAmount ?? '',
    maxAmount: rule.match?.maxAmount ?? '',
  },
  levels: (rule.levels || []).map((l) => ({
    level: l.level, mode: l.mode || 'all', roles: l.roles || [], userIds: l.userIds || [],
  })),
});

export default function ApprovalRulesModal({ onClose, addToast }) {
  const [data, setData] = useState(null);
  const [approvers, setApprovers] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      const [payload, people] = await Promise.all([api.getApprovalRules(), api.getRequestApprovers()]);
      setData(payload);
      setApprovers(people);
    } catch (err) {
      setError(err.message || 'Could not load approval rules');
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async (rule) => {
    if (!window.confirm(`Delete "${rule.name}"? Requests already in flight keep the ladder they were given.`)) return;
    try {
      await api.deleteApprovalRule(rule.id);
      addToast('Rule deleted', `"${rule.name}" no longer applies.`, 'success');
      await load();
    } catch (err) {
      addToast('Could not delete the rule', err.message, 'error');
    }
  };

  return (
    <Modal isOpen onClose={onClose} maxWidth="900px"
      title="Approval rules"
      subtitle="Which requests need whose signature. Applies to every request type, not just purchases."
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={() => setEditing({ ...BLANK_RULE })}>
            <Plus size={15} /> New rule
          </button>
        </>
      }>
      {error ? (
        <div className="empty-state">
          <div className="empty-state-icon"><AlertTriangle size={20} /></div>
          <div className="empty-state-title">{error}</div>
        </div>
      ) : !data ? (
        <div className="skeleton skeleton-row" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{
            padding: '10px 12px', borderRadius: '8px', fontSize: '12.5px',
            background: 'var(--bg-subtle)', border: '1px solid var(--border-color)',
            color: 'var(--text-secondary)',
          }}>
            When several rules match a request, the <strong>most specific</strong> one wins — the one
            that had to satisfy the most criteria. With no rule matching at all, the request falls back
            to the default approvers for its type.
          </div>

          {data.rules.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon"><GitBranch size={22} /></div>
              <div className="empty-state-title">No approval rules yet</div>
              <div className="empty-state-desc">
                Every request currently uses the default approvers for its type. Add a rule to send
                particular departments, cost bands or categories to particular people.
              </div>
            </div>
          ) : (
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr><th>Rule</th><th>Applies to</th><th>Ladder</th><th style={{ width: '90px' }} /></tr>
                </thead>
                <tbody>
                  {data.rules.map((rule) => (
                    <tr key={rule.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>
                          {rule.name}
                          {rule.active === false && (
                            <span className="badge" style={{ marginLeft: '6px' }}>Inactive</span>
                          )}
                        </div>
                        {rule.description && (
                          <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>{rule.description}</div>
                        )}
                      </td>
                      <td style={{ fontSize: '12px' }}>{summarizeMatch(rule, data.vocabulary)}</td>
                      <td style={{ fontSize: '12px' }}>{summarizeLevels(rule)}</td>
                      <td>
                        <div className="table-actions">
                          <button className="btn-table-action" title="Edit"
                            onClick={() => setEditing(toForm(rule))}>Edit</button>
                          <button className="btn-table-action delete" title="Delete"
                            onClick={() => remove(rule)}><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {editing && data && (
        <RuleEditor
          rule={editing}
          vocabulary={data.vocabulary}
          approvers={approvers}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
          addToast={addToast}
        />
      )}
    </Modal>
  );
}

/* ================================================================ summaries */

function summarizeMatch(rule, vocabulary) {
  const parts = [];
  const type = vocabulary.requestTypes.find((t) => t.key === rule.request_type);
  parts.push(type ? type.label : 'Any request type');
  const m = rule.match || {};
  if (m.departments?.length) parts.push(m.departments.join(' / '));
  if (m.categories?.length) parts.push(m.categories.join(' / '));
  if (m.priorities?.length) parts.push(`${m.priorities.join(' / ')} priority`);
  if (m.minAmount != null && m.maxAmount != null) parts.push(`${m.minAmount}–${m.maxAmount}`);
  else if (m.minAmount != null) parts.push(`over ${m.minAmount}`);
  else if (m.maxAmount != null) parts.push(`up to ${m.maxAmount}`);
  return parts.join(' · ');
}

const summarizeLevels = (rule) =>
  (rule.levels || [])
    .map((l) => {
      const who = [...(l.roles || []), ...(l.userIds || []).map(() => 'named user')].join(', ') || '—';
      return `L${l.level}: ${who}${l.mode === 'any' ? ' (any one)' : ''}`;
    })
    .join(' → ');

/* =================================================================== editor */

function RuleEditor({ rule, vocabulary, approvers, onClose, onSaved, addToast }) {
  const [form, setForm] = useState(rule);
  const editing = Boolean(rule.id);

  const patch = (p) => setForm((f) => ({ ...f, ...p }));
  const patchMatch = (p) => setForm((f) => ({ ...f, match: { ...f.match, ...p } }));
  const patchLevel = (index, p) =>
    setForm((f) => ({ ...f, levels: f.levels.map((l, i) => (i === index ? { ...l, ...p } : l)) }));

  // Levels are renumbered on every change, so removing the middle of a three-level ladder
  // cannot leave a gap the engine would strand a request on.
  const setLevels = (levels) =>
    patch({ levels: levels.map((l, i) => ({ ...l, level: i + 1 })) });

  const save = async () => {
    try {
      const body = {
        ...form,
        match: {
          ...form.match,
          minAmount: form.match.minAmount === '' ? null : Number(form.match.minAmount),
          maxAmount: form.match.maxAmount === '' ? null : Number(form.match.maxAmount),
        },
      };
      if (editing) await api.updateApprovalRule(form.id, body);
      else await api.createApprovalRule(body);
      addToast('Rule saved', `"${form.name}" now governs the requests it matches.`, 'success');
      await onSaved();
    } catch (err) {
      addToast('Could not save the rule', err.message, 'error');
    }
  };

  return (
    <Modal isOpen onClose={onClose} maxWidth="760px"
      title={editing ? `Edit "${rule.name}"` : 'New approval rule'}
      subtitle="Leave a criterion empty to match anything."
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <SpinnerButton className="btn btn-primary" loadingText="Saving…" onClick={save}>Save rule</SpinnerButton>
        </>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <div className="form-grid">
          <div className="form-group full-width">
            <label className="form-label">Rule name *</label>
            <input className="form-input" value={form.name} onChange={(e) => patch({ name: e.target.value })}
              placeholder="e.g. IT purchases over ₹1,00,000" />
          </div>
          <div className="form-group full-width">
            <label className="form-label">Description</label>
            <input className="form-input" value={form.description}
              onChange={(e) => patch({ description: e.target.value })}
              placeholder="Why this rule exists — read by whoever inherits it." />
          </div>
          <div className="form-group">
            <label className="form-label">Request type</label>
            <CustomSelect value={form.requestType} placeholder="Any request type"
              onChange={(e) => patch({ requestType: e.target.value })}
              options={[
                { value: '', label: 'Any request type' },
                ...vocabulary.requestTypes.map((t) => ({ value: t.key, label: t.label })),
              ]} />
          </div>
          <div className="form-group" style={{ justifyContent: 'flex-end' }}>
            <Checkbox checked={form.active} onChange={() => patch({ active: !form.active })}
              label="Active" />
          </div>
        </div>

        <section>
          <Heading>Applies when…</Heading>
          <ChipPicker label="Department" options={vocabulary.departments}
            selected={form.match.departments} onChange={(departments) => patchMatch({ departments })} />
          <ChipPicker label="Category" options={vocabulary.categories}
            selected={form.match.categories} onChange={(categories) => patchMatch({ categories })} />
          <ChipPicker label="Priority" options={vocabulary.priorities}
            selected={form.match.priorities} onChange={(priorities) => patchMatch({ priorities })} />
          <div className="form-grid" style={{ marginTop: '10px' }}>
            <div className="form-group">
              <label className="form-label">Estimated cost from</label>
              <input className="form-input" type="number" min="0" value={form.match.minAmount}
                placeholder="no minimum"
                onChange={(e) => patchMatch({ minAmount: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">up to</label>
              <input className="form-input" type="number" min="0" value={form.match.maxAmount}
                placeholder="no maximum"
                onChange={(e) => patchMatch({ maxAmount: e.target.value })} />
            </div>
          </div>
        </section>

        <section>
          <Heading>
            Approval ladder
            <button className="btn btn-secondary btn-sm"
              onClick={() => setLevels([...form.levels, { ...BLANK_LEVEL }])}>
              <Plus size={13} /> Add level
            </button>
          </Heading>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            Levels are decided in order — level 2 is only asked once level 1 has cleared.
          </div>

          {form.levels.map((level, index) => (
            <div key={index} style={{
              padding: '12px', borderRadius: '8px', marginBottom: '10px',
              background: 'var(--bg-subtle)', border: '1px solid var(--border-color)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <strong style={{ fontSize: '13px' }}>Level {index + 1}</strong>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <div style={{ minWidth: '220px' }}>
                    <CustomSelect value={level.mode} onChange={(e) => patchLevel(index, { mode: e.target.value })}
                      options={[
                        { value: 'all', label: 'Everyone named must approve' },
                        { value: 'any', label: 'Any one of them is enough' },
                      ]} />
                  </div>
                  <button className="btn-table-action delete" title="Remove level"
                    disabled={form.levels.length === 1}
                    onClick={() => setLevels(form.levels.filter((_, i) => i !== index))}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <ChipPicker label="By role" options={vocabulary.roles.map((r) => r.key)}
                labels={Object.fromEntries(vocabulary.roles.map((r) => [r.key, r.label]))}
                selected={level.roles} onChange={(roles) => patchLevel(index, { roles })} />
              <ChipPicker label="Or specific people" options={approvers.map((a) => String(a.id))}
                labels={Object.fromEntries(approvers.map((a) => [String(a.id), a.name]))}
                selected={level.userIds} onChange={(userIds) => patchLevel(index, { userIds })} />
              {!level.roles.length && !level.userIds.length && (
                <div style={{ fontSize: '11.5px', color: 'var(--status-disposed)', marginTop: '6px' }}>
                  This level names nobody — the rule will be refused until it does.
                </div>
              )}
            </div>
          ))}
        </section>
      </div>
    </Modal>
  );
}

/* ==================================================================== bits */

const Heading = ({ children }) => (
  <div style={{
    fontSize: '13px', fontWeight: 700, marginBottom: '8px', color: 'var(--text-secondary)',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  }}>
    {children}
  </div>
);

/**
 * A multi-select as toggle chips. CustomSelect is single-value, and a rule routinely names
 * three departments or two roles — a row of chips shows the whole selection at once, which a
 * collapsed multi-select would not.
 */
function ChipPicker({ label, options, selected = [], labels, onChange }) {
  if (!options?.length) return null;
  const toggle = (value) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);

  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '5px' }}>
        {label} {selected.length === 0 && <em>— any</em>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {options.map((value) => {
          const on = selected.includes(value);
          return (
            <button key={value} onClick={() => toggle(value)}
              className={on ? 'badge badge-available' : 'badge'}
              style={{ cursor: 'pointer', border: 'none', font: 'inherit', fontSize: '11.5px' }}>
              {labels?.[value] || value}
            </button>
          );
        })}
      </div>
    </div>
  );
}
