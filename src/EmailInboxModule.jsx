import React, { useState, useMemo } from 'react';
import { Mail, Bell, Settings, Trash2, CheckCheck, Circle, Square, CheckSquare } from 'lucide-react';
import { api } from './api';
import RelativeTime from './RelativeTime';
import NotificationSettingsPage from './NotificationSettingsPage';

/**
 * The Email Alerts / Inbox module, reorganised into three sections:
 *   - Inbox         : the outgoing email alert log, with multi-select + bulk delete
 *   - Notifications : the bell feed, with multi-select, bulk delete, mark read/unread
 *   - Settings      : NotificationSettingsPage, moved here from User Management
 *
 * Notifications carry a read state so read/unread applies to them; emails do not, so
 * that action is offered only where it is meaningful ("where applicable").
 */

const dotColor = (type) =>
  type === 'error' ? 'var(--status-disposed)' :
  type === 'warning' ? 'var(--status-maintenance)' :
  'var(--primary)';

const EmailInboxModule = ({
  emails, setEmails, selectedEmailId, setSelectedEmailId,
  notifications, setNotifications,
  canManageNotifications = false, addToast, isApiConnected
}) => {
  const [section, setSection] = useState('inbox');
  const [selectedEmails, setSelectedEmails] = useState([]);
  const [selectedNotifs, setSelectedNotifs] = useState([]);
  const [busy, setBusy] = useState(false);

  const selectedEmail = useMemo(
    () => emails.find(e => e.id === selectedEmailId) || null,
    [emails, selectedEmailId]
  );

  const toggle = (list, setList, id) =>
    setList(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);

  const allEmailIds = emails.map(e => e.id);
  const allNotifIds = notifications.map(n => n.id);
  const emailsAllSelected = emails.length > 0 && selectedEmails.length === emails.length;
  const notifsAllSelected = notifications.length > 0 && selectedNotifs.length === notifications.length;

  /* -------------------------------------------------------------- emails */

  const deleteEmails = async (ids) => {
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} email${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      if (isApiConnected) {
        if (ids.length === 1) await api.deleteEmail(ids[0]);
        else await api.bulkDeleteEmails(ids);
      }
      const remaining = emails.filter(e => !ids.includes(e.id));
      setEmails(remaining);
      if (ids.includes(selectedEmailId)) setSelectedEmailId(remaining[0]?.id || null);
      setSelectedEmails(prev => prev.filter(x => !ids.includes(x)));
      addToast('Deleted', `${ids.length} email${ids.length === 1 ? '' : 's'} removed.`, 'success');
    } catch (err) {
      addToast('Delete failed', err.message || 'Could not delete emails.', 'error');
    } finally {
      setBusy(false);
    }
  };

  /* -------------------------------------------------------- notifications */

  const deleteNotifs = async (ids) => {
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} notification${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      if (isApiConnected) {
        if (ids.length === 1) await api.deleteNotification(ids[0]);
        else await api.bulkDeleteNotifications(ids);
      }
      setNotifications(prev => prev.filter(n => !ids.includes(n.id)));
      setSelectedNotifs(prev => prev.filter(x => !ids.includes(x)));
      addToast('Deleted', `${ids.length} notification${ids.length === 1 ? '' : 's'} removed.`, 'success');
    } catch (err) {
      addToast('Delete failed', err.message || 'Could not delete notifications.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const markNotifs = async (ids, read) => {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      if (isApiConnected) await api.bulkMarkNotificationsRead(ids, read);
      setNotifications(prev => prev.map(n => (ids.includes(n.id) ? { ...n, read } : n)));
      addToast('Updated', `Marked ${ids.length} as ${read ? 'read' : 'unread'}.`, 'success');
    } catch (err) {
      addToast('Update failed', err.message || 'Could not update notifications.', 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------------------------------------------ UI */

  const SectionTab = ({ id, icon: Icon, label, count }) => (
    <button
      className={`tab-btn ${section === id ? 'active' : ''}`}
      onClick={() => setSection(id)}
      style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
    >
      <Icon size={14} /> {label}{count !== undefined ? ` (${count})` : ''}
    </button>
  );

  const BulkBar = ({ selected, allSelected, onSelectAll, onClear, children }) => (
    <div className="filters-row" style={{ marginBottom: '12px' }}>
      <div className="filters-left">
        <button
          className="btn btn-secondary btn-sm"
          style={{ display: 'flex', alignItems: 'center', gap: '6px'}}
          onClick={allSelected ? onClear : onSelectAll}
        >
          {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
        {selected.length > 0 && (
          <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>{selected.length} selected</span>
        )}
      </div>
      {selected.length > 0 && (
        <div style={{ display: 'flex', gap: '8px' }}>{children}</div>
      )}
    </div>
  );

  return (
    <>
      <div className="page-header">
        <div className="page-title-section">
          <span className="page-kicker">Stakeholder Alerts</span>
          <h1 className="page-title">Email Alerts &amp; Notifications</h1>
          <span className="page-subtitle">Manage the alert inbox, in-app notifications, and delivery settings in one place.</span>
        </div>
      </div>

      <div className="tabs-container" style={{ marginBottom: '20px' }}>
        <SectionTab id="inbox" icon={Mail} label="Inbox" count={emails.length} />
        <SectionTab id="notifications" icon={Bell} label="Notifications" count={notifications.length} />
        <SectionTab id="settings" icon={Settings} label="Settings" />
      </div>

      {/* ---------------- Inbox ---------------- */}
      {section === 'inbox' && (
        <>
          {emails.length > 0 && (
            <BulkBar
              selected={selectedEmails}
              allSelected={emailsAllSelected}
              onSelectAll={() => setSelectedEmails(allEmailIds)}
              onClear={() => setSelectedEmails([])}
            >
              <button className="btn btn-danger btn-sm" onClick={() => deleteEmails(selectedEmails)} disabled={busy}>
                <Trash2 size={13} /> Delete selected
              </button>
            </BulkBar>
          )}

          <div className="email-inbox-grid">
            <div className="email-list">
              {emails.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center', fontSize: '12.5px', color: 'var(--text-muted)' }}>
                  The alert inbox is empty.
                </div>
              ) : emails.map((eml) => (
                <div
                  key={eml.id}
                  className={`email-item ${selectedEmailId === eml.id ? 'active' : ''}`}
                  onClick={() => setSelectedEmailId(eml.id)}
                >
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      aria-label={`Select email: ${eml.subject}`}
                      checked={selectedEmails.includes(eml.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggle(selectedEmails, setSelectedEmails, eml.id)}
                      style={{ marginTop: '3px' }}
                    />
                    <div style={{ minWidth: 0, flexGrow: 1 }}>
                      <div className="email-header-row">
                        <span className="email-sender">{eml.sender}</span>
                        <span className="email-date">{eml.date}</span>
                      </div>
                      <div className="email-subj">{eml.subject}</div>
                      <div className="email-body-preview">{eml.body}</div>
                    </div>
                    <button
                      className="btn-table-action delete"
                      title="Delete email"
                      aria-label="Delete email"
                      onClick={(e) => { e.stopPropagation(); deleteEmails([eml.id]); }}
                      disabled={busy}
                      style={{ flexShrink: 0 }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="email-detail-view">
              {selectedEmail ? (
                <>
                  <div className="email-detail-header">
                    <h2 className="email-detail-subject">{selectedEmail.subject}</h2>
                    <div className="email-detail-meta">
                      <span>From: <strong>{selectedEmail.sender}</strong></span>
                      <span>{selectedEmail.date}</span>
                    </div>
                  </div>
                  <div className="email-detail-body">{selectedEmail.body}</div>
                </>
              ) : (
                <div className="email-detail-empty">No email selected</div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ---------------- Notifications ---------------- */}
      {section === 'notifications' && (
        <div className="card">
          {notifications.length > 0 && (
            <BulkBar
              selected={selectedNotifs}
              allSelected={notifsAllSelected}
              onSelectAll={() => setSelectedNotifs(allNotifIds)}
              onClear={() => setSelectedNotifs([])}
            >
              <button className="btn btn-secondary btn-sm" onClick={() => markNotifs(selectedNotifs, true)} disabled={busy}>
                <CheckCheck size={13} /> Mark read
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => markNotifs(selectedNotifs, false)} disabled={busy}>
                <Circle size={13} /> Mark unread
              </button>
              <button className="btn btn-danger btn-sm" onClick={() => deleteNotifs(selectedNotifs)} disabled={busy}>
                <Trash2 size={13} /> Delete
              </button>
            </BulkBar>
          )}

          {notifications.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon"><Bell size={22} /></div>
              <div className="empty-state-title">No notifications</div>
              <div className="empty-state-desc">System alerts and ticket updates will appear here.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {notifications.map((n) => (
                <div
                  key={n.id}
                  style={{
                    display: 'flex', gap: '10px', alignItems: 'flex-start',
                    padding: '10px 4px', borderBottom: '1px solid var(--border-color)',
                    opacity: n.read ? 0.6 : 1
                  }}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select notification: ${n.text}`}
                    checked={selectedNotifs.includes(n.id)}
                    onChange={() => toggle(selectedNotifs, setSelectedNotifs, n.id)}
                    style={{ marginTop: '3px' }}
                  />
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor(n.type), marginTop: '6px', flexShrink: 0 }} />
                  <div style={{ flexGrow: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: n.read ? 400 : 600 }}>{n.text}</div>
                    <RelativeTime style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }} value={n.createdAt} />
                  </div>
                  <button
                    className="btn-table-action"
                    title={n.read ? 'Mark unread' : 'Mark read'}
                    aria-label={n.read ? 'Mark unread' : 'Mark read'}
                    onClick={() => markNotifs([n.id], !n.read)}
                    disabled={busy}
                    style={{ flexShrink: 0 }}
                  >
                    {n.read ? <Circle size={13} /> : <CheckCheck size={13} />}
                  </button>
                  <button
                    className="btn-table-action delete"
                    title="Delete notification"
                    aria-label="Delete notification"
                    onClick={() => deleteNotifs([n.id])}
                    disabled={busy}
                    style={{ flexShrink: 0 }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---------------- Settings ---------------- */}
      {section === 'settings' && (
        <NotificationSettingsPage addToast={addToast} canManage={canManageNotifications} />
      )}
    </>
  );
};

export default EmailInboxModule;
