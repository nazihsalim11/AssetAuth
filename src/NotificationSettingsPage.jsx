import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Mail, MessageSquare, Bell, AlertCircle, CheckCircle2, Clock, MinusCircle } from 'lucide-react';
import { api } from './api';
import RelativeTime from './RelativeTime';
import NotificationPreferences from './NotificationPreferences';

const STATUS_STYLE = {
  Sent: { color: 'var(--status-available)', bg: 'var(--status-available-bg)', Icon: CheckCircle2 },
  Failed: { color: 'var(--status-disposed)', bg: 'var(--status-disposed-bg)', Icon: AlertCircle },
  Pending: { color: 'var(--status-maintenance)', bg: 'var(--status-maintenance-bg)', Icon: Clock },
  Skipped: { color: 'var(--text-muted)', bg: 'var(--bg-subtle)', Icon: MinusCircle }
};

const StatusBadge = ({ status }) => {
  const s = STATUS_STYLE[status] || STATUS_STYLE.Skipped;
  const Icon = s.Icon;
  return (
    <span className="badge" style={{ color: s.color, background: s.bg, borderColor: 'transparent' }}>
      <Icon size={12} />
      {status}
    </span>
  );
};

const CHANNEL_META = {
  inApp: { key: 'inAppEnabled', column: 'in_app_enabled', label: 'In-app', Icon: Bell },
  email: { key: 'emailEnabled', column: 'email_enabled', label: 'Email', Icon: Mail },
  sms: { key: 'smsEnabled', column: 'sms_enabled', label: 'SMS', Icon: MessageSquare }
};

const NotificationSettingsPage = ({ addToast, canManage = false }) => {
  const [settings, setSettings] = useState(null);
  const [channels, setChannels] = useState(null);
  const [history, setHistory] = useState([]);
  const [summary, setSummary] = useState({});
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadHistory = useCallback(async (status) => {
    try {
      const res = await api.getNotificationHistory({ status, limit: 100 });
      setHistory(res.deliveries || []);
      setSummary(res.summary || {});
    } catch (err) {
      addToast('Error', err.message || 'Could not load notification history.', 'error');
    }
  }, [addToast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await api.getNotificationSettings();
        if (!cancelled) {
          setSettings(res.settings);
          setChannels(res.channels);
        }
        await loadHistory('');
      } catch (err) {
        if (!cancelled) addToast('Error', err.message || 'Could not load notification settings.', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [addToast, loadHistory]);

  const toggleChannel = async (channelName) => {
    if (!canManage || !settings) return;
    const meta = CHANNEL_META[channelName];
    const next = !settings[meta.column];
    setSaving(true);
    try {
      const res = await api.updateNotificationSettings({ [meta.key]: next });
      setSettings(res.settings);
      setChannels(res.channels);
      addToast('Saved', `${meta.label} notifications ${next ? 'enabled' : 'disabled'}.`, 'success');
    } catch (err) {
      addToast('Error', err.message || 'Could not update settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const updateNumber = async (key, value) => {
    if (!canManage) return;
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 1) return;
    setSaving(true);
    try {
      const res = await api.updateNotificationSettings({ [key]: parsed });
      setSettings(res.settings);
      addToast('Saved', 'Reminder schedule updated.', 'success');
    } catch (err) {
      addToast('Error', err.message || 'Could not update settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const retry = async () => {
    setSaving(true);
    try {
      const res = await api.retryFailedNotifications();
      addToast('Retry complete', res.message, 'success');
      await loadHistory(statusFilter);
    } catch (err) {
      addToast('Error', err.message || 'Retry failed.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const filterBy = async (status) => {
    setStatusFilter(status);
    await loadHistory(status);
  };

  if (loading) {
    return (
      <div className="card">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-text" />
        <div className="skeleton skeleton-text" />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Channels */}
      <div className="card">
        <span className="card-title"><Bell /> Notification Channels</span>
        <p className="card-subtitle" style={{ marginTop: '-8px' }}>
          Global switches. A channel with no provider configured stays off and its deliveries are recorded as Skipped.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
          {Object.entries(CHANNEL_META).map(([name, meta]) => {
            const enabled = settings?.[meta.column];
            const configured = channels?.[name]?.configured;
            const Icon = meta.Icon;
            return (
              <div
                key={name}
                style={{
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '16px',
                  background: enabled ? 'var(--primary-soft)' : 'var(--bg-subtle)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                    <Icon size={16} style={{ color: enabled ? 'var(--primary)' : 'var(--text-muted)' }} />
                    {meta.label}
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: canManage ? 'pointer' : 'not-allowed' }}>
                    <input
                      type="checkbox"
                      checked={!!enabled}
                      disabled={!canManage || saving}
                      onChange={() => toggleChannel(name)}
                      aria-label={`Toggle ${meta.label} notifications`}
                    />
                  </label>
                </div>
                <div style={{ fontSize: '11.5px', color: configured ? 'var(--text-muted)' : 'var(--status-maintenance)', lineHeight: 1.5 }}>
                  {channels?.[name]?.description}
                </div>
              </div>
            );
          })}
        </div>

        {!canManage && (
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Your role can't change these settings.
          </p>
        )}
      </div>

      <NotificationPreferences addToast={addToast} canManage={canManage} />

      {/* Schedules */}
      <div className="card">
        <span className="card-title"><Clock /> Reminder Schedule</span>
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">Warranty reminder (days before expiry)</label>
            <input
              className="form-input"
              type="number"
              min="1"
              defaultValue={settings?.warranty_reminder_days}
              disabled={!canManage || saving}
              onBlur={(e) => updateNumber('warrantyReminderDays', e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">AMC reminder (days before expiry)</label>
            <input
              className="form-input"
              type="number"
              min="1"
              defaultValue={settings?.amc_reminder_days}
              disabled={!canManage || saving}
              onBlur={(e) => updateNumber('amcReminderDays', e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">SLA warning (hours before deadline)</label>
            <input
              className="form-input"
              type="number"
              min="1"
              defaultValue={settings?.sla_warning_hours}
              disabled={!canManage || saving}
              onBlur={(e) => updateNumber('slaWarningHours', e.target.value)}
            />
          </div>
        </div>
        <p style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
          Checks run daily at midnight for expiries and hourly for SLA deadlines. Each stakeholder is
          notified once per event; changing a reminder window starts a fresh reminder.
        </p>
      </div>

      {/* History */}
      <div className="card">
        <div className="card-title-section">
          <span className="card-title"><CheckCircle2 /> Delivery History</span>
          {canManage && (
            <button className="btn btn-secondary" onClick={retry} disabled={saving}>
              <RefreshCw size={14} className={saving ? 'animate-spin' : ''} />
              Retry failed
            </button>
          )}
        </div>

        <div className="filters-row">
          <div className="filters-left">
            <span>Filter</span>
            {['', 'Sent', 'Failed', 'Pending', 'Skipped'].map((s) => (
              <button
                key={s || 'all'}
                className={`btn ${statusFilter === s ? 'btn-primary' : 'btn-secondary'}`}
                style={{ minHeight: '32px', padding: '6px 12px', fontSize: '12px' }}
                onClick={() => filterBy(s)}
              >
                {s || 'All'}
                {s && summary[s] !== undefined ? ` (${summary[s]})` : ''}
              </button>
            ))}
          </div>
        </div>

        <div className="table-container" style={{ maxHeight: '480px' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Channel</th>
                <th>Event</th>
                <th>Recipient</th>
                <th>Subject</th>
                <th>Attempts</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">
                      <div className="empty-state-icon"><Bell size={22} /></div>
                      <div className="empty-state-title">No deliveries yet</div>
                      <div className="empty-state-desc">
                        Notifications appear here as tickets change and lifecycle reminders fire.
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                history.map((d) => (
                  <tr key={d.id}>
                    <td><StatusBadge status={d.status} /></td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}>{d.channel}</td>
                    <td style={{ fontSize: '12px' }}>{d.eventType}</td>
                    <td>{d.recipientName || '—'}</td>
                    <td style={{ maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={d.subject || d.body}>
                      {d.subject || d.body}
                    </td>
                    <td style={{ textAlign: 'center' }}>{d.attempts}</td>
                    <td style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                      <RelativeTime value={d.createdAt} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {history.some((d) => d.status === 'Failed') && (
          <p style={{ fontSize: '11.5px', color: 'var(--status-disposed)' }}>
            Failed deliveries are retried automatically every 15 minutes, up to 3 attempts.
          </p>
        )}
      </div>
    </div>
  );
};

export default NotificationSettingsPage;
