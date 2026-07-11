import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  ShieldCheck, Plus, Edit2, Trash2, Archive, ArchiveRestore, Clock, CalendarDays,
  Zap, Play, Target, AlertTriangle, X
} from 'lucide-react';
import { api } from './api';
import Modal from './Modal';
import CustomSelect from './CustomSelect';
import { SpinnerButton } from './SpinnerButton';
import { silk } from './engine/motion';

/* --------------------------------------------------------------- helpers */

// Minutes -> compact human label, e.g. 600 -> "10h", 1470 -> "1d 30m".
const durationLabel = (mins) => {
  if (mins == null) return '—';
  const m = Math.round(mins);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), r = m % 60;
  return [d ? `${d}d` : '', h ? `${h}h` : '', r ? `${r}m` : ''].filter(Boolean).join(' ') || '0m';
};

const WEEKDAY_SHORT = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };
const TRIGGER_LABELS = {
  response_percent: '% of response time elapsed', resolution_percent: '% of resolution time elapsed',
  response_remaining: 'response time remaining (min)', resolution_remaining: 'resolution time remaining (min)',
  response_breach: 'first-response breached', resolution_breach: 'resolution breached'
};
const TARGET_LABELS = {
  assignee: 'Assigned Technician', team_lead: 'Team Lead',
  department_manager: 'Department Manager', it_admin: 'IT Administrator', super_admin: 'Super Admin'
};

// A number + unit (min/hr/day) control that keeps `minutes` as the source of truth.
const DurationInput = ({ minutes, onChange, disabled }) => {
  const [unit, setUnit] = useState(() =>
    minutes && minutes % 1440 === 0 ? 'days' : minutes && minutes % 60 === 0 ? 'hours' : 'minutes');
  const factor = unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1;
  const value = minutes / factor;
  return (
    <div style={{ display: 'flex', gap: '8px' }}>
      <input
        className="form-input" type="number" min="1" step={unit === 'minutes' ? '1' : '0.25'}
        disabled={disabled}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(Math.max(1, Math.round(parseFloat(e.target.value || '0') * factor)))}
        style={{ flex: 1 }}
      />
      <CustomSelect value={unit} onChange={(e) => setUnit(e.target.value)} disabled={disabled}
        style={{ width: '120px' }}
        options={[{ value: 'minutes', label: 'Minutes' }, { value: 'hours', label: 'Hours' }, { value: 'days', label: 'Days' }]} />
    </div>
  );
};

/* ------------------------------------------------------------ policy editor */

const blankPolicy = () => ({
  name: '', description: '', priority: '', category: '', department: '', assetType: '', branch: '',
  firstResponseMinutes: 240, resolutionMinutes: 1440, calendarId: '', autoAssignEnabled: false,
  autoAssignStrategy: 'least_loaded', priorityRank: 0, active: true,
  escalationLevels: [
    { level: 1, triggerType: 'resolution_percent', threshold: 50, notifyTarget: 'assignee' },
    { level: 2, triggerType: 'resolution_percent', threshold: 75, notifyTarget: 'team_lead' },
    { level: 3, triggerType: 'resolution_breach', threshold: 0, notifyTarget: 'department_manager' }
  ]
});

const PolicyEditor = ({ policy, calendars, options, onSave, onCancel, addToast }) => {
  const [form, setForm] = useState(() => ({ ...blankPolicy(), ...policy, escalationLevels: (policy?.escalationLevels || blankPolicy().escalationLevels).map((l) => ({ ...l })) }));
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const setLevel = (i, patch) => setForm((f) => ({
    ...f, escalationLevels: f.escalationLevels.map((l, idx) => idx === i ? { ...l, ...patch } : l)
  }));
  const addLevel = () => setForm((f) => ({
    ...f,
    escalationLevels: [...f.escalationLevels, {
      level: f.escalationLevels.length + 1, triggerType: 'resolution_percent', threshold: 90, notifyTarget: 'super_admin'
    }]
  }));
  const removeLevel = (i) => setForm((f) => ({
    ...f, escalationLevels: f.escalationLevels.filter((_, idx) => idx !== i).map((l, idx) => ({ ...l, level: idx + 1 }))
  }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { addToast('Missing name', 'Policy name is required.', 'error'); return; }
    setSaving(true);
    try {
      await onSave({
        ...form,
        name: form.name.trim(),
        priority: form.priority || null,
        category: form.category.trim() || null,
        department: form.department.trim() || null,
        assetType: form.assetType.trim() || null,
        branch: form.branch.trim() || null,
        calendarId: form.calendarId || null,
        priorityRank: Number(form.priorityRank) || 0
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onCancel} as="form" onSubmit={submit} size="xl"
      title={policy?.id ? 'Edit SLA Policy' : 'New SLA Policy'}
      subtitle="Match rules decide which tickets this policy governs; the most specific match wins."
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
          <SpinnerButton type="submit" className="btn btn-primary" loading={saving} loadingText="Saving…">Save Policy</SpinnerButton>
        </>
      }
    >
      <div className="form-grid">
        <div className="form-group full-width">
          <label className="form-label">Policy Name *</label>
          <input className="form-input" value={form.name} onChange={(e) => set({ name: e.target.value })} required
            placeholder="e.g. Critical IT Incidents" />
        </div>
        <div className="form-group full-width">
          <label className="form-label">Description</label>
          <input className="form-input" value={form.description || ''} onChange={(e) => set({ description: e.target.value })}
            placeholder="Optional note describing when this policy applies" />
        </div>
      </div>

      <h4 style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '18px 0 10px', letterSpacing: '0.04em' }}>
        <Target size={12} style={{ verticalAlign: '-2px' }} /> Applies When (leave blank for "any")
      </h4>
      <div className="form-grid">
        <div className="form-group">
          <label className="form-label">Priority</label>
          <CustomSelect value={form.priority} onChange={(e) => set({ priority: e.target.value })}
            options={[{ value: '', label: 'Any priority' }, ...options.priorities.map((p) => ({ value: p, label: p }))]} />
        </div>
        <div className="form-group">
          <label className="form-label">Category</label>
          <input className="form-input" value={form.category} onChange={(e) => set({ category: e.target.value })} placeholder="Any category" />
        </div>
        <div className="form-group">
          <label className="form-label">Department</label>
          <input className="form-input" value={form.department} onChange={(e) => set({ department: e.target.value })} placeholder="Any department" />
        </div>
        <div className="form-group">
          <label className="form-label">Asset Type</label>
          <input className="form-input" value={form.assetType} onChange={(e) => set({ assetType: e.target.value })} placeholder="Any asset type" />
        </div>
        <div className="form-group">
          <label className="form-label">Branch / Location</label>
          <input className="form-input" value={form.branch} onChange={(e) => set({ branch: e.target.value })} placeholder="Any branch" />
        </div>
        <div className="form-group">
          <label className="form-label">Match Priority (tiebreak)</label>
          <input className="form-input" type="number" value={form.priorityRank} onChange={(e) => set({ priorityRank: e.target.value })}
            title="When two policies are equally specific, the higher number wins." />
        </div>
      </div>

      <h4 style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '18px 0 10px', letterSpacing: '0.04em' }}>
        <Clock size={12} style={{ verticalAlign: '-2px' }} /> Targets
      </h4>
      <div className="form-grid">
        <div className="form-group">
          <label className="form-label">First Response Time *</label>
          <DurationInput minutes={form.firstResponseMinutes} onChange={(m) => set({ firstResponseMinutes: m })} />
        </div>
        <div className="form-group">
          <label className="form-label">Resolution Time *</label>
          <DurationInput minutes={form.resolutionMinutes} onChange={(m) => set({ resolutionMinutes: m })} />
        </div>
        <div className="form-group">
          <label className="form-label">Business Calendar</label>
          <CustomSelect value={form.calendarId || ''} onChange={(e) => set({ calendarId: e.target.value })}
            options={[{ value: '', label: 'Default calendar' }, ...calendars.map((c) => ({ value: c.id, label: c.name + (c.is24x7 ? ' (24×7)' : '') }))]} />
        </div>
        <div className="form-group">
          <label className="form-label">Auto-Assignment</label>
          <CustomSelect value={form.autoAssignEnabled ? form.autoAssignStrategy : 'manual'}
            onChange={(e) => set(e.target.value === 'manual'
              ? { autoAssignEnabled: false }
              : { autoAssignEnabled: true, autoAssignStrategy: e.target.value })}
            options={[
              { value: 'manual', label: 'Manual (no auto-assign)' },
              { value: 'least_loaded', label: 'Least-loaded technician' },
              { value: 'round_robin', label: 'Round robin' }
            ]} />
        </div>
      </div>

      <h4 style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '18px 0 10px', letterSpacing: '0.04em', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span><Zap size={12} style={{ verticalAlign: '-2px' }} /> Escalation Levels</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={addLevel}><Plus size={12} /> Add level</button>
      </h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {form.escalationLevels.length === 0 && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No escalation levels. Add one to notify staff as the SLA is consumed.</div>
        )}
        {form.escalationLevels.map((lvl, i) => {
          const isBreach = lvl.triggerType.endsWith('_breach');
          return (
            <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', background: 'var(--bg-sidebar)', padding: '10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
              <div style={{ fontWeight: 800, fontSize: '13px', width: '28px', textAlign: 'center', paddingBottom: '8px' }}>L{lvl.level}</div>
              <div className="form-group" style={{ margin: 0, flex: 2 }}>
                <label className="form-label" style={{ fontSize: '10px' }}>Trigger</label>
                <CustomSelect value={lvl.triggerType} onChange={(e) => setLevel(i, { triggerType: e.target.value })}
                  options={options.escalationTriggers.map((t) => ({ value: t, label: TRIGGER_LABELS[t] || t }))} />
              </div>
              <div className="form-group" style={{ margin: 0, width: '90px' }}>
                <label className="form-label" style={{ fontSize: '10px' }}>{isBreach ? '—' : 'Threshold'}</label>
                <input className="form-input" type="number" disabled={isBreach} min="0"
                  value={isBreach ? '' : lvl.threshold}
                  onChange={(e) => setLevel(i, { threshold: parseFloat(e.target.value || '0') })} />
              </div>
              <div className="form-group" style={{ margin: 0, flex: 2 }}>
                <label className="form-label" style={{ fontSize: '10px' }}>Notify</label>
                <CustomSelect value={lvl.notifyTarget} onChange={(e) => setLevel(i, { notifyTarget: e.target.value })}
                  options={options.escalationTargets.map((t) => ({ value: t, label: TARGET_LABELS[t] || t }))} />
              </div>
              <button type="button" className="btn btn-danger btn-sm" onClick={() => removeLevel(i)} style={{ marginBottom: '2px' }} aria-label="Remove level"><X size={13} /></button>
            </div>
          );
        })}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', marginTop: '18px', cursor: 'pointer' }}>
        <input type="checkbox" checked={form.active} onChange={(e) => set({ active: e.target.checked })} />
        Active (inactive policies are never matched)
      </label>
    </Modal>
  );
};

/* ---------------------------------------------------------- calendar editor */

const blankCalendar = () => ({
  name: '', description: '', is24x7: false, utcOffsetMinutes: 330,
  workStart: '09:00', workEnd: '18:00', workingDays: [1, 2, 3, 4, 5], branch: '', active: true, holidays: []
});

const CalendarEditor = ({ calendar, options, onSave, onCancel, addToast }) => {
  const [form, setForm] = useState(() => ({ ...blankCalendar(), ...calendar, holidays: (calendar?.holidays || []).map((h) => (typeof h === 'string' ? { date: h, name: '' } : h)) }));
  const [saving, setSaving] = useState(false);
  const [newHoliday, setNewHoliday] = useState({ date: '', name: '' });
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const toggleDay = (d) => setForm((f) => ({
    ...f, workingDays: f.workingDays.includes(d) ? f.workingDays.filter((x) => x !== d) : [...f.workingDays, d].sort()
  }));
  const addHoliday = () => {
    if (!newHoliday.date) return;
    if (form.holidays.some((h) => h.date === newHoliday.date)) { addToast('Duplicate', 'That date is already a holiday.', 'error'); return; }
    set({ holidays: [...form.holidays, { ...newHoliday }].sort((a, b) => a.date.localeCompare(b.date)) });
    setNewHoliday({ date: '', name: '' });
  };
  const removeHoliday = (date) => set({ holidays: form.holidays.filter((h) => h.date !== date) });

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { addToast('Missing name', 'Calendar name is required.', 'error'); return; }
    setSaving(true);
    try {
      await onSave({ ...form, name: form.name.trim(), branch: form.branch.trim() || null });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onCancel} as="form" onSubmit={submit} size="lg"
      title={calendar?.id ? 'Edit Business Calendar' : 'New Business Calendar'}
      subtitle="SLA timers only advance during the working hours defined here."
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
          <SpinnerButton type="submit" className="btn btn-primary" loading={saving} loadingText="Saving…">Save Calendar</SpinnerButton>
        </>
      }
    >
      <div className="form-grid">
        <div className="form-group full-width">
          <label className="form-label">Calendar Name *</label>
          <input className="form-input" value={form.name} onChange={(e) => set({ name: e.target.value })} required placeholder="e.g. India Business Hours" />
        </div>
        <div className="form-group full-width">
          <label className="form-label">Description</label>
          <input className="form-input" value={form.description || ''} onChange={(e) => set({ description: e.target.value })} />
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', margin: '10px 0', cursor: 'pointer' }}>
        <input type="checkbox" checked={form.is24x7} onChange={(e) => set({ is24x7: e.target.checked })} />
        <strong>24×7</strong> — timers never pause (working days, hours and holidays below are ignored)
      </label>

      {!form.is24x7 && (
        <>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Work Start</label>
              <input className="form-input" type="time" value={form.workStart} onChange={(e) => set({ workStart: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Work End</label>
              <input className="form-input" type="time" value={form.workEnd} onChange={(e) => set({ workEnd: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">UTC Offset (minutes)</label>
              <input className="form-input" type="number" step="15" value={form.utcOffsetMinutes} onChange={(e) => set({ utcOffsetMinutes: parseInt(e.target.value || '0', 10) })}
                title="330 = IST (+05:30)" />
            </div>
            <div className="form-group">
              <label className="form-label">Branch (optional)</label>
              <input className="form-input" value={form.branch || ''} onChange={(e) => set({ branch: e.target.value })} placeholder="Applies to a branch" />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Working Days</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {(options.weekdays || []).map((d) => (
                <button type="button" key={d.value} onClick={() => toggleDay(d.value)}
                  className={`btn btn-sm ${form.workingDays.includes(d.value) ? 'btn-primary' : 'btn-secondary'}`}>
                  {WEEKDAY_SHORT[d.value]}
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Holidays</label>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
              <input className="form-input" type="date" value={newHoliday.date} onChange={(e) => setNewHoliday((h) => ({ ...h, date: e.target.value }))} style={{ width: '170px' }} />
              <input className="form-input" placeholder="Name (optional)" value={newHoliday.name} onChange={(e) => setNewHoliday((h) => ({ ...h, name: e.target.value }))} style={{ flex: 1 }} />
              <button type="button" className="btn btn-secondary btn-sm" onClick={addHoliday}><Plus size={13} /> Add</button>
            </div>
            {form.holidays.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '160px', overflowY: 'auto' }}>
                {form.holidays.map((h) => (
                  <div key={h.date} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', padding: '5px 10px', background: 'var(--bg-sidebar)', borderRadius: 'var(--radius-sm)' }}>
                    <span><strong>{h.date}</strong>{h.name ? ` — ${h.name}` : ''}</span>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => removeHoliday(h.date)} aria-label="Remove holiday"><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', marginTop: '10px', cursor: 'pointer' }}>
        <input type="checkbox" checked={form.active} onChange={(e) => set({ active: e.target.checked })} /> Active
      </label>
    </Modal>
  );
};

/* ----------------------------------------------------------- preview panel */

const PreviewPanel = ({ addToast }) => {
  const [form, setForm] = useState({ priority: 'Critical', category: '', department: '', assetType: '', branch: '' });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const run = async () => {
    setLoading(true);
    try {
      const r = await api.previewSla({
        priority: form.priority || null, category: form.category || null,
        department: form.department || null, assetType: form.assetType || null, branch: form.branch || null
      });
      setResult(r);
    } catch (err) {
      addToast('Preview failed', err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card" style={{ padding: '20px' }}>
      <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Play size={14} /> Test Your Configuration
      </h4>
      <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Enter a hypothetical ticket to see which policy matches and the deadlines it would set.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '10px', marginBottom: '12px' }}>
        <input className="form-input" placeholder="Priority" value={form.priority} onChange={(e) => set({ priority: e.target.value })} />
        <input className="form-input" placeholder="Category" value={form.category} onChange={(e) => set({ category: e.target.value })} />
        <input className="form-input" placeholder="Department" value={form.department} onChange={(e) => set({ department: e.target.value })} />
        <input className="form-input" placeholder="Asset type" value={form.assetType} onChange={(e) => set({ assetType: e.target.value })} />
        <input className="form-input" placeholder="Branch" value={form.branch} onChange={(e) => set({ branch: e.target.value })} />
      </div>
      <button className="btn btn-primary btn-sm" onClick={run} disabled={loading}>{loading ? 'Checking…' : 'Preview SLA'}</button>

      {result && (
        <div style={{ marginTop: '14px', fontSize: '13px', borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
          {result.matched ? (
            <>
              <div>Matched policy: <strong>{result.matched.name}</strong></div>
              <div style={{ color: 'var(--text-muted)', marginTop: '6px' }}>
                First response due: <strong>{new Date(result.firstResponseDue).toLocaleString()}</strong><br />
                Resolution due: <strong>{new Date(result.resolutionDue).toLocaleString()}</strong>
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--status-maintenance)' }}>
              <AlertTriangle size={13} style={{ verticalAlign: '-2px' }} /> No policy matches — a default 24h resolution would apply.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ page */

const SlaManagementPage = ({ addToast, canEdit = false }) => {
  const [view, setView] = useState('policies');
  const [policies, setPolicies] = useState([]);
  const [calendars, setCalendars] = useState([]);
  const [options, setOptions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState(null);
  const [editingCalendar, setEditingCalendar] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pol, cal, opt] = await Promise.all([
        api.getSlaPolicies(includeArchived),
        api.getSlaCalendars(),
        options ? Promise.resolve(options) : api.getSlaOptions()
      ]);
      setPolicies(pol);
      setCalendars(cal);
      if (!options) setOptions(opt);
    } catch (err) {
      addToast('Load failed', err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [includeArchived]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const savePolicy = async (data) => {
    try {
      if (editingPolicy?.id) await api.updateSlaPolicy(editingPolicy.id, data);
      else await api.createSlaPolicy(data);
      addToast('Saved', 'SLA policy saved.', 'success');
      setEditingPolicy(null);
      load();
    } catch (err) {
      addToast('Save failed', err.message, 'error');
    }
  };

  const saveCalendar = async (data) => {
    try {
      if (editingCalendar?.id) await api.updateSlaCalendar(editingCalendar.id, data);
      else await api.createSlaCalendar(data);
      addToast('Saved', 'Business calendar saved.', 'success');
      setEditingCalendar(null);
      load();
    } catch (err) {
      addToast('Save failed', err.message, 'error');
    }
  };

  const archivePolicy = async (p, archived) => {
    try {
      await api.archiveSlaPolicy(p.id, archived);
      addToast(archived ? 'Archived' : 'Restored', `${p.name} ${archived ? 'archived' : 'restored'}.`, 'success');
      load();
    } catch (err) {
      addToast('Failed', err.message, 'error');
    }
  };

  const deletePolicy = async (p) => {
    if (!window.confirm(`Delete SLA policy "${p.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteSlaPolicy(p.id);
      addToast('Deleted', `${p.name} deleted.`, 'success');
      load();
    } catch (err) {
      addToast('Delete failed', err.message, 'error');
    }
  };

  const deleteCalendar = async (c) => {
    if (!window.confirm(`Delete calendar "${c.name}"?`)) return;
    try {
      await api.deleteSlaCalendar(c.id);
      addToast('Deleted', `${c.name} deleted.`, 'success');
      load();
    } catch (err) {
      addToast('Delete failed', err.message, 'error');
    }
  };

  const criteriaSummary = (p) => {
    const parts = [];
    if (p.priority) parts.push(p.priority);
    if (p.category) parts.push(p.category);
    if (p.department) parts.push(p.department);
    if (p.assetType) parts.push(p.assetType);
    if (p.branch) parts.push(p.branch);
    return parts.length ? parts.join(' · ') : 'Any ticket (catch-all)';
  };

  return (
    <motion.div {...silk} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ShieldCheck size={20} /> SLA Management
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Configure response and resolution targets, business calendars, and escalation ladders. Fully database-driven.
          </p>
        </div>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => (view === 'policies' ? setEditingPolicy({}) : setEditingCalendar({}))}>
            <Plus size={15} /> {view === 'policies' ? 'New Policy' : 'New Calendar'}
          </button>
        )}
      </div>

      {/* segmented control */}
      <div style={{ display: 'flex', gap: '4px', background: 'var(--bg-sidebar)', padding: '4px', borderRadius: 'var(--radius-lg)', width: 'fit-content', border: '1px solid var(--border-color)' }}>
        {[['policies', 'Policies', ShieldCheck], ['calendars', 'Business Calendars', CalendarDays]].map(([key, label, Icon]) => (
          <button key={key} onClick={() => setView(key)}
            className={`btn btn-sm ${view === key ? 'btn-primary' : 'btn-secondary'}`}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', background: view === key ? undefined : 'transparent', border: 'none' }}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {loading && <div className="card" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>}

      {!loading && view === 'policies' && (
        <>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
            <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} /> Show archived policies
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {policies.length === 0 && <div className="card" style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)' }}>No SLA policies yet.</div>}
            {policies.map((p) => (
              <div key={p.id} className="card" style={{ padding: '16px 20px', opacity: p.archived ? 0.6 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: '15px' }}>{p.name}</strong>
                      {!p.active && <span className="badge badge-on-hold">Inactive</span>}
                      {p.archived && <span className="badge">Archived</span>}
                      {p.autoAssignEnabled && <span className="badge badge-assigned">Auto-assign: {p.autoAssignStrategy.replace('_', ' ')}</span>}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>{criteriaSummary(p)}</div>
                    <div style={{ display: 'flex', gap: '16px', marginTop: '8px', fontSize: '12px', flexWrap: 'wrap' }}>
                      <span><Clock size={11} style={{ verticalAlign: '-1px' }} /> Response <strong>{durationLabel(p.firstResponseMinutes)}</strong></span>
                      <span><Target size={11} style={{ verticalAlign: '-1px' }} /> Resolution <strong>{durationLabel(p.resolutionMinutes)}</strong></span>
                      <span><CalendarDays size={11} style={{ verticalAlign: '-1px' }} /> {p.calendarName || 'Default calendar'}</span>
                      <span><Zap size={11} style={{ verticalAlign: '-1px' }} /> {p.escalationLevels?.length || 0} escalation level(s)</span>
                    </div>
                  </div>
                  {canEdit && (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditingPolicy(p)} aria-label="Edit"><Edit2 size={13} /></button>
                      <SpinnerButton className="btn btn-secondary btn-sm" onClick={() => archivePolicy(p, !p.archived)} icon={p.archived ? ArchiveRestore : Archive} spinnerSize={13} aria-label={p.archived ? 'Restore' : 'Archive'} />
                      <SpinnerButton className="btn btn-danger btn-sm" onClick={() => deletePolicy(p)} icon={Trash2} spinnerSize={13} aria-label="Delete" />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <PreviewPanel addToast={addToast} />
        </>
      )}

      {!loading && view === 'calendars' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {calendars.length === 0 && <div className="card" style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)' }}>No calendars yet.</div>}
          {calendars.map((c) => (
            <div key={c.id} className="card" style={{ padding: '16px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: '15px' }}>{c.name}</strong>
                    {c.isDefault && <span className="badge badge-assigned">Default</span>}
                    {c.is24x7 && <span className="badge badge-available">24×7</span>}
                    {!c.active && <span className="badge badge-on-hold">Inactive</span>}
                  </div>
                  {c.description && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>{c.description}</div>}
                  {!c.is24x7 && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>
                      {c.workStart}–{c.workEnd} · {(c.workingDays || []).map((d) => WEEKDAY_SHORT[d]).join(', ')} · {(c.holidays || []).length} holiday(s)
                    </div>
                  )}
                </div>
                {canEdit && (
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => setEditingCalendar(c)} aria-label="Edit"><Edit2 size={13} /></button>
                    <SpinnerButton className="btn btn-danger btn-sm" onClick={() => deleteCalendar(c)} icon={Trash2} spinnerSize={13} aria-label="Delete" />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editingPolicy && options && (
        <PolicyEditor policy={editingPolicy.id ? editingPolicy : null} calendars={calendars} options={options}
          onSave={savePolicy} onCancel={() => setEditingPolicy(null)} addToast={addToast} />
      )}
      {editingCalendar && options && (
        <CalendarEditor calendar={editingCalendar.id ? editingCalendar : null} options={options}
          onSave={saveCalendar} onCancel={() => setEditingCalendar(null)} addToast={addToast} />
      )}
    </motion.div>
  );
};

export default SlaManagementPage;
