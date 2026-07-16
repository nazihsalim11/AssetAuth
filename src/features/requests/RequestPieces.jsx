import React, { useRef, useState } from 'react';
import { AlertTriangle, Download, Eye, Paperclip, RefreshCw, Trash2, Upload } from 'lucide-react';
import { api } from '../../api';
import { openStoredFile } from '../../files';
import CustomSelect from '../../CustomSelect';
import { SpinnerButton } from '../../SpinnerButton';
import { displayValue, fmtDateTime, historyTone, statusBadge } from './requestUi';

/**
 * The reusable review components. Each takes plain data, so any module that later grows its
 * own request screen renders the same comparison, timeline and attachment list rather than
 * a lookalike of it.
 */

/* ======================================================= comparison / diff */

/**
 * Old vs new, field by field.
 *
 * `stale` means the target record changed after the request was raised, so what would be
 * applied now differs from what the requester submitted. Silently approving that is how a
 * week-old proposal clobbers someone else's legitimate edit — so it is called out loudly,
 * with both versions shown.
 */
export function DiffTable({ comparison, loading }) {
  if (loading) return <div className="skeleton skeleton-row" />;
  if (!comparison) return null;

  const { changes = [], submitted = [], stale, recordMissing } = comparison;

  if (recordMissing) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon"><AlertTriangle size={20} /></div>
        <div className="empty-state-title">The target record no longer exists</div>
        <div className="empty-state-desc">This request can no longer be applied. Cancel it.</div>
      </div>
    );
  }

  if (!changes.length) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">Nothing left to change</div>
        <div className="empty-state-desc">
          The record already holds every proposed value. Approving this will complete it without writing anything.
        </div>
      </div>
    );
  }

  const submittedBy = new Map(submitted.map((c) => [c.field, c]));

  return (
    <>
      {stale && (
        <div style={{
          display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '10px 12px',
          borderRadius: '8px', marginBottom: '12px',
          background: 'var(--status-maintenance-bg)', border: '1px solid var(--status-maintenance-glow)'
        }}>
          <AlertTriangle size={15} style={{ color: 'var(--status-maintenance)', flexShrink: 0, marginTop: '2px' }} />
          <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--status-maintenance)' }}>The record has changed since this was raised.</strong>{' '}
            The table below is what would be applied <em>now</em>. Check it still reflects the intent before approving.
          </div>
        </div>
      )}
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr><th>Field</th><th>Current value</th><th>Proposed value</th></tr>
          </thead>
          <tbody>
            {changes.map((c) => {
              const original = submittedBy.get(c.field);
              const movedUnderneath = original && JSON.stringify(original.before) !== JSON.stringify(c.before);
              return (
                <tr key={c.field}>
                  <td style={{ fontWeight: 600 }}>{c.label}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>
                    <span style={{ textDecoration: 'line-through', opacity: 0.75 }}>{displayValue(c.before)}</span>
                    {movedUnderneath && (
                      <div style={{ fontSize: '11px', color: 'var(--status-maintenance)', marginTop: '3px' }}>
                        was {displayValue(original.before)} when raised
                      </div>
                    )}
                  </td>
                  <td style={{ fontWeight: 600, color: 'var(--status-available)' }}>{displayValue(c.after)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ================================================== approval timeline */

/** Where the request is in its ladder: who signed, who is deciding, who is next. */
export function ApprovalTimeline({ request }) {
  const levels = [...new Set((request.approvers || []).map((a) => a.level))].sort((a, b) => a - b);
  if (!levels.length) return <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No approvers assigned.</div>;

  return (
    <div className="timeline-container">
      {levels.map((level) => {
        const at = request.approvers.filter((a) => a.level === level);
        const active = level === request.currentLevel && ['Pending Approval', 'Under Review'].includes(request.status);
        const decided = at.every((a) => a.status !== 'Pending');
        const rejected = at.some((a) => a.status === 'Rejected');
        const tone = rejected ? 'danger' : decided ? 'success' : active ? 'warning' : 'info';
        return (
          <div className="timeline-node" key={level}>
            <div className={`timeline-dot ${tone}`} />
            <div className="timeline-content">
              <div className="timeline-date-row">
                <span className="timeline-date">
                  Level {level} of {request.totalLevels}{active ? ' — deciding now' : ''}
                </span>
              </div>
              {at.map((a) => (
                <div key={`${a.level}-${a.userId}`} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
                  <span style={{ fontSize: '13px' }}>{a.userName || a.userId}</span>
                  <span className={statusBadge(a.status === 'Pending' ? 'Draft' : a.status === 'Approved' ? 'Approved' : 'Rejected')}>
                    {a.status}
                  </span>
                </div>
              ))}
              {at.filter((a) => a.comment).map((a) => (
                <div key={`c-${a.userId}`} style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  “{a.comment}” — {a.userName || a.userId}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ================================================== audit history */

/** Append-only. There is deliberately no edit or delete control anywhere in this view. */
export function AuditTimeline({ history = [] }) {
  if (!history.length) return <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No history yet.</div>;
  return (
    <div className="timeline-container">
      {[...history].reverse().map((h) => (
        <div className="timeline-node" key={h.id}>
          <div className={`timeline-dot ${historyTone(h.action)}`} />
          <div className="timeline-content">
            <div className="timeline-date-row">
              <span className="timeline-date">{h.action}</span>
              <span className="timeline-actor">{fmtDateTime(h.createdAt)}</span>
            </div>
            {h.detail && <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{h.detail}</div>}
            <div className="timeline-actor">{h.actorName || 'System'}</div>
            {h.fromStatus && h.toStatus && h.fromStatus !== h.toStatus && (
              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                {h.fromStatus} → {h.toStatus}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ================================================== attachments */

/**
 * Upload / preview / download / replace / delete over the shared storage service. The bucket
 * is private, so both preview and download exchange the stored path for a short-lived signed
 * URL — there is no permanent URL to hand out.
 */
export function AttachmentList({ attachments = [], canEdit, onAdd, onReplace, onDelete, addToast, docTypes }) {
  const addRef = useRef(null);
  const replaceRef = useRef(null);
  const [replacing, setReplacing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [docType, setDocType] = useState(docTypes?.[0] || '');

  const upload = async (file) => {
    const meta = await api.uploadFile(file);
    return {
      fileName: meta.name,
      filePath: meta.fileUrl,
      fileSize: meta.fileSize,
      fileType: file.type || null,
      ...(docTypes ? { docType } : {}),
    };
  };

  const pick = async (e, handler) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be chosen again after an error
    if (!file) return;
    setBusy(true);
    try {
      await handler(await upload(file));
    } catch (err) {
      addToast?.('Upload failed', err.message, 'error');
    } finally {
      setBusy(false);
      setReplacing(null);
    }
  };

  const open = (path) => openStoredFile(path, (msg) => addToast?.('Could not open', msg, 'error'));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {canEdit && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {docTypes && (
            <div style={{ minWidth: '200px' }}>
              <CustomSelect value={docType} onChange={(e) => setDocType(e.target.value)}
                options={docTypes.map((t) => ({ value: t, label: t }))} />
            </div>
          )}
          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => addRef.current?.click()}>
            <Upload size={14} /> {busy ? 'Uploading…' : 'Upload document'}
          </button>
          <input ref={addRef} type="file" style={{ display: 'none' }} onChange={(e) => pick(e, onAdd)} />
          <input ref={replaceRef} type="file" style={{ display: 'none' }}
            onChange={(e) => pick(e, (doc) => onReplace(replacing, doc))} />
        </div>
      )}

      {attachments.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '8px 0' }}>
          <Paperclip size={13} style={{ verticalAlign: '-2px', marginRight: '6px' }} />
          No supporting documents.
        </div>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                {docTypes && <th>Type</th>}
                <th>File</th><th>Uploaded by</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {attachments.map((a) => (
                <tr key={a.id}>
                  {docTypes && <td><span className="badge">{a.docType || 'Other'}</span></td>}
                  <td style={{ fontWeight: 600 }}>
                    {a.fileName}
                    {a.fileSize && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{a.fileSize}</div>}
                  </td>
                  <td style={{ fontSize: '12px' }}>
                    {a.uploadedBy || '—'}
                    <div style={{ color: 'var(--text-muted)' }}>{fmtDateTime(a.createdAt)}</div>
                  </td>
                  <td>
                    <div className="table-actions">
                      <button className="btn-table-action" title="Preview" onClick={() => open(a.filePath)}><Eye size={15} /></button>
                      <button className="btn-table-action" title="Download" onClick={() => open(a.filePath)}><Download size={15} /></button>
                      {canEdit && (
                        <>
                          <button className="btn-table-action" title="Replace"
                            onClick={() => { setReplacing(a.id); replaceRef.current?.click(); }}>
                            <RefreshCw size={15} />
                          </button>
                          <SpinnerButton className="btn-table-action delete" title="Delete" icon={Trash2} spinnerSize={15}
                            onClick={() => onDelete(a.id)} />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ================================================== comments */

export function CommentThread({ comments = [], canComment, onSubmit }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    try {
      await onSubmit(text);
      setBody('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {comments.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No comments yet.</div>
      )}
      {comments.map((c) => (
        <div key={c.id} style={{
          padding: '10px 12px', borderRadius: '8px',
          background: 'var(--bg-subtle)', border: '1px solid var(--border-color)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '4px' }}>
            <span style={{ fontWeight: 600, fontSize: '12.5px' }}>{c.authorName}</span>
            <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>{fmtDateTime(c.createdAt)}</span>
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{c.body}</div>
        </div>
      ))}

      {canComment && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
          <textarea className="form-input" rows={2} placeholder="Add a comment…" value={body}
            onChange={(e) => setBody(e.target.value)} />
          <button className="btn btn-secondary" disabled={busy || !body.trim()} onClick={submit}>
            {busy ? 'Posting…' : 'Post'}
          </button>
        </div>
      )}
    </div>
  );
}
