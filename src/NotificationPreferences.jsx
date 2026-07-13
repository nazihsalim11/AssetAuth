import React, { useCallback, useEffect, useState } from 'react';
import { Save, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import { api } from './api';
import Checkbox from './Checkbox';
import CustomSelect from './CustomSelect';
import { SpinnerButton } from './SpinnerButton';
import AsyncBoundary from './AsyncBoundary';
import { STATUS } from './asyncStatus';

/**
 * Per-event notification preferences.
 *
 * One row per event type: which channels fire, the severity floor, and who hears
 * about it. An event with no saved row keeps the built-in behaviour — every globally
 * enabled channel, to the built-in audience — so an admin who never opens this page
 * loses nothing. That is why "unconfigured" and "everything off" must look different
 * here: the checkboxes default to checked, and an empty recipient list reads
 * "Default recipients", not "nobody".
 *
 * The whole configuration is saved in one PUT, because a partial write would leave
 * some events routed to nobody, and silence is the failure mode nobody notices.
 */

const CHANNELS = [
  { key: 'in_app', label: 'In-app' },
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'SMS' }
];

const PRIORITIES = ['Low', 'Medium', 'Critical'];

// Only ticket events carry a priority, so only they can have a severity floor.
const hasPriority = (eventType) => eventType.startsWith('ticket.');

const GROUPS = [
  { prefix: 'ticket.', label: 'Ticket events' },
  { prefix: 'asset.', label: 'Asset events' },
  { prefix: 'amc.', label: 'AMC events' },
  { prefix: 'finance.', label: 'Finance events' },
  { prefix: 'user.', label: 'User & account events' },
  { prefix: 'security.', label: 'Security alerts' },
  { prefix: 'system.', label: 'System alerts' }
];

const prettyEvent = (eventType) =>
  eventType
    .split('.')[1]
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

const NotificationPreferences = ({ addToast, canManage = false }) => {

  const [status, setStatus] = useState(STATUS.LOADING);
  const [error, setError] = useState(null);
  const [eventTypes, setEventTypes] = useState([]);
  const [users, setUsers] = useState([]);
  const [prefs, setPrefs] = useState({});        // prefs[event][channel] = bool
  const [floors, setFloors] = useState({});      // floors[event] = 'Low' | ... | ''
  const [recipients, setRecipients] = useState({}); // recipients[event] = { roles:Set, userIds:Set }
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const hydrate = useCallback((data) => {
    const nextPrefs = {};
    const nextFloors = {};
    const nextRecipients = {};

    for (const event of data.eventTypes) {
      // Unconfigured means "all channels on", not "all off".
      nextPrefs[event] = { in_app: true, email: true, sms: true };
      nextFloors[event] = '';
      nextRecipients[event] = { roles: new Set(), userIds: new Set() };
    }

    for (const row of data.preferences || []) {
      if (!nextPrefs[row.eventType]) continue;
      nextPrefs[row.eventType][row.channel] = row.enabled !== false;
      if (row.minPriority) nextFloors[row.eventType] = row.minPriority;
    }

    for (const row of data.recipients || []) {
      if (!nextRecipients[row.eventType]) continue;
      if (row.role) nextRecipients[row.eventType].roles.add(row.role);
      if (row.userId != null) nextRecipients[row.eventType].userIds.add(row.userId);
    }

    setEventTypes(data.eventTypes || []);
    setUsers(data.users || []);
    setPrefs(nextPrefs);
    setFloors(nextFloors);
    setRecipients(nextRecipients);
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    setStatus(STATUS.LOADING);
    setError(null);
    try {
      hydrate(await api.getNotificationPreferences());
      setStatus(STATUS.READY);
    } catch (err) {
      setError(err);
      setStatus(STATUS.ERROR);
    }
  }, [hydrate]);

  useEffect(() => { load(); }, [load]);

  const roles = [...new Set(users.map((u) => u.role).filter(Boolean))].sort();

  const toggleChannel = (event, channel) => {
    setPrefs((prev) => ({ ...prev, [event]: { ...prev[event], [channel]: !prev[event][channel] } }));
    setDirty(true);
  };

  const setFloor = (event, value) => {
    setFloors((prev) => ({ ...prev, [event]: value }));
    setDirty(true);
  };

  const toggleRole = (event, role) => {
    setRecipients((prev) => {
      const roleSet = new Set(prev[event].roles);
      if (roleSet.has(role)) roleSet.delete(role); else roleSet.add(role);
      return { ...prev, [event]: { ...prev[event], roles: roleSet } };
    });
    setDirty(true);
  };

  const addUser = (event, userId) => {
    if (!userId) return;
    setRecipients((prev) => {
      const idSet = new Set(prev[event].userIds);
      idSet.add(Number(userId));
      return { ...prev, [event]: { ...prev[event], userIds: idSet } };
    });
    setDirty(true);
  };

  const removeUser = (event, userId) => {
    setRecipients((prev) => {
      const idSet = new Set(prev[event].userIds);
      idSet.delete(userId);
      return { ...prev, [event]: { ...prev[event], userIds: idSet } };
    });
    setDirty(true);
  };

  const userById = (id) => users.find((u) => u.id === id);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const preferences = [];
      const recipientRows = [];

      for (const event of eventTypes) {
        for (const { key } of CHANNELS) {
          preferences.push({
            eventType: event,
            channel: key,
            enabled: prefs[event][key],
            // The floor belongs to the event; store it on each row the table has.
            minPriority: hasPriority(event) ? (floors[event] || null) : null
          });
        }
        for (const role of recipients[event].roles) {
          recipientRows.push({ eventType: event, role, userId: null });
        }
        for (const userId of recipients[event].userIds) {
          recipientRows.push({ eventType: event, role: null, userId });
        }
      }

      const result = await api.updateNotificationPreferences({ preferences, recipients: recipientRows });
      addToast('Preferences saved', `${result.preferences} channel rule(s), ${result.recipients} recipient rule(s).`, 'success');
      setDirty(false);
    } catch (err) {
      addToast('Save failed', err.message || 'Could not save notification preferences.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AsyncBoundary
      status={status}
      error={error}
      onRetry={load}
      errorTitle="Unable to load notification preferences"
      skeleton={<div className="card"><div className="skeleton skeleton-title" /><div className="skeleton skeleton-row" /><div className="skeleton skeleton-row" /></div>}
    >
      <div className="card">
        <span className="card-title"><SlidersHorizontal /> Event Preferences</span>
        <p className="card-subtitle" style={{ marginTop: '-8px' }}>
          Which events notify, on which channels, and who hears about them. An event with no
          recipients selected uses its default audience. A global channel switch always wins.
        </p>

        {!canManage && (
          <p className="empty-state-desc" style={{ margin: 0 }}>
            Your role can't change these. Shown read-only.
          </p>
        )}

        {GROUPS.map((group) => {
          const events = eventTypes.filter((e) => e.startsWith(group.prefix));
          if (events.length === 0) return null;

          return (
            <div key={group.prefix} style={{ marginTop: 'var(--sp-4)' }}>
              <h4 style={{ fontSize: '13px', margin: '0 0 8px' }}>{group.label}</h4>
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Event</th>
                      {CHANNELS.map((c) => <th key={c.key} style={{ textAlign: 'center', width: '90px' }}>{c.label}</th>)}
                      <th style={{ width: '150px' }}>Minimum priority</th>
                      <th>Recipients</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr key={event}>
                        <td style={{ fontWeight: 600 }}>{prettyEvent(event)}</td>

                        {CHANNELS.map((c) => (
                          <td key={c.key} style={{ textAlign: 'center' }}>
                            <Checkbox
                              checked={Boolean(prefs[event]?.[c.key])}
                              onChange={() => toggleChannel(event, c.key)}
                              disabled={!canManage}
                              aria-label={`${c.label} for ${prettyEvent(event)}`}
                            />
                          </td>
                        ))}

                        <td>
                          {hasPriority(event) ? (
                            <CustomSelect
                              value={floors[event] || ''}
                              onChange={(e) => setFloor(event, e.target.value)}
                              disabled={!canManage}
                              placeholder="Any"
                              options={[{ value: '', label: 'Any' }, ...PRIORITIES.map((pr) => ({ value: pr, label: `${pr} and above` }))]}
                            />
                          ) : (
                            <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>—</span>
                          )}
                        </td>

                        <td>
                          <div className="action-row">
                            {roles.map((role) => {
                              const on = recipients[event]?.roles.has(role);
                              return (
                                <button
                                  key={role}
                                  type="button"
                                  className={`badge ${on ? 'badge-active' : ''}`}
                                  onClick={() => canManage && toggleRole(event, role)}
                                  disabled={!canManage}
                                  aria-pressed={on}
                                  style={{
                                    cursor: canManage ? 'pointer' : 'default',
                                    background: on ? 'var(--primary-soft)' : 'transparent',
                                    color: on ? 'var(--primary)' : 'var(--text-muted)',
                                    borderColor: on ? 'var(--primary)' : 'var(--border-color)'
                                  }}
                                >
                                  {role}
                                </button>
                              );
                            })}
                            {[...(recipients[event]?.userIds || [])].map((uid) => {
                              const u = userById(uid);
                              return (
                                <button
                                  key={`u-${uid}`}
                                  type="button"
                                  className="badge"
                                  onClick={() => canManage && removeUser(event, uid)}
                                  disabled={!canManage}
                                  title={canManage ? 'Remove this person' : undefined}
                                  style={{
                                    cursor: canManage ? 'pointer' : 'default',
                                    background: 'var(--status-available-bg)',
                                    color: 'var(--status-available)',
                                    borderColor: 'var(--status-available)'
                                  }}
                                >
                                  {u ? (u.name || u.email) : `User #${uid}`}
                                  {canManage && <X size={11} style={{ marginLeft: 4 }} />}
                                </button>
                              );
                            })}

                            {canManage && (
                              <CustomSelect
                                value=""
                                onChange={(e) => addUser(event, e.target.value)}
                                placeholder="Add person…"
                                searchable
                                style={{ width: '160px' }}
                                options={users
                                  .filter((u) => !recipients[event]?.userIds.has(u.id))
                                  .map((u) => ({ value: u.id, label: `${u.name || u.email} (${u.role})` }))}
                              />
                            )}

                            {recipients[event]?.roles.size === 0 && recipients[event]?.userIds.size === 0 && (
                              <span style={{ color: 'var(--text-muted)', fontSize: '11.5px' }}>Default recipients</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}

        {canManage && (
          <div className="action-row" style={{ marginTop: 'var(--sp-4)' }}>
            <SpinnerButton className="btn btn-primary" onClick={save} disabled={!dirty} loading={saving} loadingText="Saving…" icon={Save} spinnerSize={15}>Save preferences</SpinnerButton>
            <button className="btn btn-secondary" onClick={load} disabled={saving || !dirty}>
              <RotateCcw size={15} />
              Discard changes
            </button>
            {dirty && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Unsaved changes</span>}
          </div>
        )}
      </div>
    </AsyncBoundary>
  );
};

export default NotificationPreferences;
