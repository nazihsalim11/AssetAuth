import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ClipboardList, Clock, Download, FileWarning, Inbox, Pencil,
  GitBranch, Plus, RefreshCw, Search, Send, ShieldQuestion, ShoppingCart, Trash2, UserCog,
  XCircle
} from 'lucide-react';
import { api } from '../../api';
import Modal from '../../Modal';
import CustomSelect from '../../CustomSelect';
import Checkbox from '../../Checkbox';
import { SpinnerButton } from '../../SpinnerButton';
import { ApprovalTimeline, AttachmentList, AuditTimeline, CommentThread, DiffTable } from './RequestPieces';
import ApprovalRulesModal from './ApprovalRulesModal';
import PurchaseRequestForm from './PurchaseRequestForm';
import PurchaseRequestPanel from './PurchaseRequestPanel';
import { coerceInput, fmtDate, fmtDateTime, priorityBadge, statusBadge } from './requestUi';

// The one request type with a form of its own: its payload is line items and quotations, not
// a list of scalar fields, so the generated form cannot express it. Everything else about it
// — the ladder, the drawer, the audit trail — is the shared machinery.
const PURCHASE_REQUEST = 'purchase.request';

/**
 * Requests — the central approval workspace.
 *
 * Type-agnostic by construction: the request types, their fields, the statuses and the
 * priorities all arrive from GET /api/requests/options, which reads the server-side registry.
 * A workflow added there appears here — in the picker, the create form, the filters and the
 * review drawer — with no change to this file.
 *
 * The named dashboard lists are server-side scopes rather than client-side filters, because
 * "awaiting my approval" depends on which ladder level a request is sitting on, which only
 * the data layer knows.
 */

const SCOPES = [
  { key: 'awaiting_me', label: 'Awaiting my approval', icon: Inbox, countKey: 'awaitingMyApproval' },
  { key: 'pending', label: 'Pending', icon: Clock, countKey: 'pending', status: ['Pending Approval', 'Under Review'] },
  { key: 'mine', label: 'My requests', icon: ClipboardList, countKey: 'mine' },
  { key: 'approved', label: 'Approved', icon: CheckCircle2, countKey: 'approved', status: ['Approved', 'Completed'] },
  { key: 'rejected', label: 'Rejected', icon: XCircle, countKey: 'rejected', status: ['Rejected'] },
  { key: 'completed', label: 'Recently completed', icon: CheckCircle2, countKey: 'recentlyCompleted', status: ['Completed'] },
  { key: 'overdue', label: 'Overdue', icon: FileWarning, countKey: 'overdue' },
  { key: 'all', label: 'All requests', icon: ClipboardList, countKey: 'total' },
];

const SORTS = [
  { value: 'createdAt:desc', label: 'Newest first' },
  { value: 'createdAt:asc', label: 'Oldest first' },
  { value: 'priority:desc', label: 'Priority (high → low)' },
  { value: 'dueDate:asc', label: 'Due date (soonest)' },
  { value: 'status:asc', label: 'Status (A → Z)' },
];

const PRIORITY_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 };

export default function RequestsPage({ can, currentUser, addToast }) {
  const [options, setOptions] = useState(null);
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [scope, setScope] = useState('awaiting_me');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sort, setSort] = useState('createdAt:desc');
  const [selected, setSelected] = useState(new Set());

  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [raisingPurchase, setRaisingPurchase] = useState(false);
  const [editingRules, setEditingRules] = useState(false);

  const canApprove = can('requests', 'approve');
  const canManage = can('requests', 'manage');
  const canCreate = can('requests', 'create');
  const canDelete = can('requests', 'delete');

  /* --------------------------------------------------------------- loading */

  useEffect(() => {
    api.getRequestOptions()
      .then(setOptions)
      .catch((err) => setError(err.message || 'Could not load request options'));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const active = SCOPES.find((s) => s.key === scope);
    const params = { q: query || undefined, requestType: typeFilter || undefined };

    // Scope first, then the explicit filters on top of it.
    if (scope === 'mine') params.scope = 'mine';
    if (scope === 'awaiting_me') params.scope = 'awaiting_me';
    if (scope === 'overdue') params.overdue = 'true';
    const statuses = statusFilter ? [statusFilter] : active?.status;
    if (statuses?.length) params.status = statuses.join(',');

    try {
      const [list, counts] = await Promise.all([api.getRequests(params), api.getRequestSummary()]);
      setRows(list);
      setSummary(counts);
      setSelected(new Set());
    } catch (err) {
      setError(err.message || 'Could not load requests');
    } finally {
      setLoading(false);
    }
  }, [scope, query, typeFilter, statusFilter]);

  useEffect(() => {
    const t = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  /* --------------------------------------------------------------- sorting */

  const sorted = useMemo(() => {
    if (!rows) return null;
    const [key, dir] = sort.split(':');
    const factor = dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      let x = a[key];
      let y = b[key];
      if (key === 'priority') { x = PRIORITY_RANK[x] || 0; y = PRIORITY_RANK[y] || 0; }
      if (x === y) return 0;
      // Rows with no due date sort last regardless of direction — an absent deadline is not
      // "the most urgent", which is what a naive null comparison would make it.
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return x < y ? -factor : factor;
    });
  }, [rows, sort]);

  /* --------------------------------------------------------- bulk actions */

  const bulk = async (action) => {
    const ids = [...selected];
    if (!ids.length) return;
    const needsReason = action === 'reject';
    let comment;
    if (needsReason) {
      comment = window.prompt(`Reason for rejecting ${ids.length} request(s):`);
      if (!comment || !comment.trim()) return;
    }
    try {
      const result = await api.bulkRequestAction(action, { ids, comment });
      const failed = result.results.filter((r) => !r.ok);
      if (result.succeeded) addToast('Done', `${result.succeeded} request(s) ${action}d.`, 'success');
      // Partial failure is normal here (someone else decided one first), so it is reported
      // rather than swallowed or treated as a total failure.
      if (failed.length) {
        addToast(
          `${failed.length} could not be ${action}d`,
          failed.map((f) => `${f.id}: ${f.error}`).join(' • '),
          'error'
        );
      }
      await load();
    } catch (err) {
      addToast('Bulk action failed', err.message, 'error');
    }
  };

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const allShownSelected = sorted?.length > 0 && sorted.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected(allShownSelected ? new Set() : new Set(sorted.map((r) => r.id)));

  /* ----------------------------------------------------------------- view */

  const typeOptions = [
    { value: '', label: 'All types' },
    ...(options?.types || []).map((t) => ({ value: t.key, label: t.label })),
  ];
  const statusOptions = [
    { value: '', label: 'Any status' },
    ...(options?.statuses || []).map((s) => ({ value: s, label: s })),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* ------------------------------------------------------- dashboard */}
      <div className="stat-strip">
        {SCOPES.map((s) => {
          const Icon = s.icon;
          const count = summary ? summary[s.countKey] : null;
          return (
            <button key={s.key} className="stat-cell" onClick={() => { setScope(s.key); setStatusFilter(''); }}
              style={{
                cursor: 'pointer', textAlign: 'left', border: 'none',
                borderBottom: scope === s.key ? '2px solid var(--primary)' : '2px solid transparent',
                background: scope === s.key ? 'var(--bg-subtle)' : 'transparent'
              }}>
              <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Icon size={13} /> {s.label}
              </div>
              <div className="stat-value" style={{ color: s.key === 'overdue' && count > 0 ? 'var(--status-disposed)' : undefined }}>
                {count === null ? '—' : count}
              </div>
            </button>
          );
        })}
      </div>

      <div className="card">
        <div className="card-title-section">
          <span className="card-title"><ClipboardList /> {SCOPES.find((s) => s.key === scope)?.label}</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-secondary" onClick={load}><RefreshCw size={14} /> Refresh</button>
            {can('requests', 'export') && (
              <button className="btn btn-secondary" onClick={() => exportCsv(sorted)} disabled={!sorted?.length}>
                <Download size={14} /> Export
              </button>
            )}
            {canManage && (
              <button className="btn btn-secondary" onClick={() => setEditingRules(true)}>
                <GitBranch size={14} /> Approval rules
              </button>
            )}
            {canCreate && (
              <button className="btn btn-secondary" onClick={() => setRaisingPurchase(true)}>
                <ShoppingCart size={15} /> New purchase request
              </button>
            )}
            {canCreate && (
              <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={15} /> New request</button>
            )}
          </div>
        </div>

        {/* --------------------------------------------------- search + filters */}
        <div className="filters-row">
          <div className="search-bar-container" style={{ minWidth: 'min(280px, 100%)' }}>
            <Search className="search-icon" />
            <input className="search-bar" placeholder="Search by id, record, requester, reason…"
              value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <CustomSelect value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} options={typeOptions} />
          <CustomSelect value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} options={statusOptions} />
          <CustomSelect value={sort} onChange={(e) => setSort(e.target.value)} options={SORTS} />
        </div>

        {/* --------------------------------------------------- bulk action bar */}
        {selected.size > 0 && (
          <div style={{
            display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap',
            padding: '10px 12px', marginBottom: '12px', borderRadius: '8px',
            background: 'var(--bg-subtle)', border: '1px solid var(--border-color)'
          }}>
            <span style={{ fontSize: '13px', fontWeight: 600 }}>{selected.size} selected</span>
            <div style={{ flex: 1 }} />
            {canApprove && <SpinnerButton className="btn btn-primary btn-sm" onClick={() => bulk('approve')} loadingText="Approving…">Approve</SpinnerButton>}
            {canApprove && <SpinnerButton className="btn btn-secondary btn-sm" onClick={() => bulk('reject')} loadingText="Rejecting…">Reject</SpinnerButton>}
            <SpinnerButton className="btn btn-secondary btn-sm" onClick={() => bulk('cancel')} loadingText="Cancelling…">Cancel</SpinnerButton>
            <button className="btn btn-secondary btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}

        {error && (
          <div style={{ padding: '16px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' }}>
            <AlertTriangle size={18} style={{ color: 'var(--status-disposed)' }} />
            <span style={{ fontSize: '13px', color: 'var(--status-disposed)' }}>{error}</span>
            <button className="btn btn-secondary btn-sm" onClick={load}><RefreshCw size={13} /> Retry</button>
          </div>
        )}

        {/* ----------------------------------------------------------- table */}
        {!error && (
          <div className="table-container" style={{ maxHeight: '560px' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '34px' }}>
                    <Checkbox
                      checked={allShownSelected}
                      indeterminate={selected.size > 0 && !allShownSelected}
                      onChange={toggleAll}
                      aria-label="Select all shown requests"
                    />
                  </th>
                  <th>Request</th><th>Type</th><th>Record</th><th>Requested by</th>
                  <th>Priority</th><th>Status</th><th>Approval</th><th>Raised</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={9}><div className="skeleton skeleton-row" /></td></tr>
                ) : !sorted?.length ? (
                  <tr><td colSpan={9}>
                    <div className="empty-state">
                      <div className="empty-state-icon"><Inbox size={22} /></div>
                      <div className="empty-state-title">Nothing here</div>
                      <div className="empty-state-desc">
                        {scope === 'awaiting_me'
                          ? 'No requests are waiting on your approval.'
                          : 'No requests match this view.'}
                      </div>
                    </div>
                  </td></tr>
                ) : sorted.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={selected.has(r.id)} onChange={() => toggle(r.id)}
                        aria-label={`Select ${r.id}`} />
                    </td>
                    <td onClick={() => setOpenId(r.id)} style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                      {r.id}
                      {r.overdue && (
                        <span className="badge badge-disposed" style={{ marginLeft: '6px' }}>Overdue</span>
                      )}
                    </td>
                    <td onClick={() => setOpenId(r.id)} style={{ fontSize: '12.5px' }}>{r.requestTypeLabel}</td>
                    <td onClick={() => setOpenId(r.id)} style={{ fontSize: '12.5px' }}>{r.recordLabel}</td>
                    <td onClick={() => setOpenId(r.id)} style={{ fontSize: '12.5px' }}>{r.requestedByName}</td>
                    <td onClick={() => setOpenId(r.id)}><span className={priorityBadge(r.priority)}>{r.priority}</span></td>
                    <td onClick={() => setOpenId(r.id)}>
                      <span className={statusBadge(r.displayStatus || r.status)}>{r.displayStatus || r.status}</span>
                    </td>
                    <td onClick={() => setOpenId(r.id)} style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      {r.totalLevels > 1 ? `Level ${r.currentLevel} of ${r.totalLevels}` : '—'}
                    </td>
                    <td onClick={() => setOpenId(r.id)} style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      {fmtDate(r.requestedOn)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openId && (
        <RequestDrawer
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={load}
          currentUser={currentUser}
          canApprove={canApprove}
          canManage={canManage}
          canDelete={canDelete}
          canConvert={can('finance', 'create')}
          docTypes={options?.types.find((t) => t.key === PURCHASE_REQUEST)?.docTypes}
          addToast={addToast}
        />
      )}

      {editingRules && (
        <ApprovalRulesModal onClose={() => setEditingRules(false)} addToast={addToast} />
      )}

      {raisingPurchase && (
        <PurchaseRequestForm
          onClose={() => setRaisingPurchase(false)}
          onSaved={async (id) => { setRaisingPurchase(false); await load(); setOpenId(id); }}
          addToast={addToast}
        />
      )}

      {creating && options && (
        <CreateRequestModal
          options={options}
          onClose={() => setCreating(false)}
          onCreated={async (id) => { setCreating(false); await load(); setOpenId(id); }}
          addToast={addToast}
        />
      )}
    </div>
  );
}

/**
 * Export what is on screen, after the active scope, filters and sort — exporting the whole
 * table regardless of the view would be a different (and mostly useless) report.
 */
function exportCsv(rows = []) {
  const columns = [
    ['Request', (r) => r.id],
    ['Type', (r) => r.requestTypeLabel],
    ['Subject', (r) => r.recordLabel],
    ['Requested by', (r) => r.requestedByName],
    ['Raised on', (r) => r.requestedOn],
    ['Priority', (r) => r.priority],
    ['Status', (r) => r.displayStatus || r.status],
    ['Approval', (r) => `Level ${r.currentLevel} of ${r.totalLevels}`],
    ['Due', (r) => r.dueDate || ''],
    ['Completed', (r) => r.completedAt || ''],
  ];
  // A field containing a comma, a quote or a newline has to be quoted, or the file silently
  // gains columns when someone opens it.
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    columns.map(([label]) => cell(label)).join(','),
    ...rows.map((r) => columns.map(([, get]) => cell(get(r))).join(',')),
  ].join('\r\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `requests-${new Date().toISOString().split('T')[0]}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/* ====================================================== review drawer */

function RequestDrawer({ id, onClose, onChanged, currentUser, canApprove, canManage, canDelete, canConvert, docTypes, addToast }) {
  const [request, setRequest] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('review');
  const [comment, setComment] = useState('');
  const [reassigning, setReassigning] = useState(false);
  const [approvers, setApprovers] = useState([]);
  const [revising, setRevising] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, c] = await Promise.all([api.getRequest(id), api.getRequestComparison(id)]);
      setRequest(r);
      setComparison(c);
    } catch (err) {
      addToast('Could not load request', err.message, 'error');
      onClose();
    } finally {
      setLoading(false);
    }
  }, [id, addToast, onClose]);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => { await load(); await onChanged(); };

  // Every action funnels through here so a 409 from the concurrency guard is reported the
  // same way everywhere: tell the reviewer someone else moved first, then reload.
  const act = async (fn, successTitle, successMsg) => {
    try {
      await fn();
      addToast(successTitle, successMsg, 'success');
      setComment('');
      await refresh();
    } catch (err) {
      addToast('Action failed', err.message, 'error');
      if (err.status === 409) await refresh();
    }
  };

  const openReassign = async () => {
    try {
      setApprovers(await api.getRequestApprovers());
      setReassigning(true);
    } catch (err) {
      addToast('Could not load approvers', err.message, 'error');
    }
  };

  const isMine = request && String(request.requestedBy) === String(currentUser?.id);
  const myTurn = request && (request.approvers || []).some(
    (a) => String(a.userId) === String(currentUser?.id) &&
      a.status === 'Pending' && a.level === request.currentLevel
  );
  const decidable = request && ['Pending Approval', 'Under Review'].includes(request.status);
  const canDecideNow = canApprove && myTurn && decidable;
  const isPurchase = request?.requestType === PURCHASE_REQUEST;
  // Approved, applied, not yet turned into an order, not closed. The server re-checks all of
  // this — the button is only hidden where it would certainly fail.
  const convertible = isPurchase && request.status === 'Completed'
    && !request.convertedTo && !request.closedAt;

  return (
    <Modal isOpen onClose={onClose} maxWidth="880px"
      title={request ? `${request.id} — ${request.requestTypeLabel}` : 'Request'}
      subtitle={request ? `${request.recordLabel} • raised by ${request.requestedByName} on ${fmtDate(request.requestedOn)}` : undefined}
      footer={request && (
        <div style={{ display: 'flex', gap: '8px', width: '100%', flexWrap: 'wrap', alignItems: 'center' }}>
          {request.status === 'Approved' && request.applyError && canApprove && (
            <SpinnerButton className="btn btn-primary" loadingText="Applying…"
              onClick={() => act(() => api.applyRequest(request.id), 'Applied', 'The approved changes were applied.')}>
              Retry apply
            </SpinnerButton>
          )}
          {convertible && canConvert && (
            <SpinnerButton className="btn btn-primary" loadingText="Converting…"
              onClick={() => act(
                () => api.convertPurchaseRequest(request.id),
                'Purchase order raised',
                'The approved request has been converted.'
              )}>
              <ShoppingCart size={14} /> Convert to purchase order
            </SpinnerButton>
          )}
          {isPurchase && isMine && ['Draft', 'Under Review'].includes(request.status) && (
            <button className="btn btn-secondary" onClick={() => setRevising(true)}>
              <Pencil size={14} /> Edit request
            </button>
          )}
          {isPurchase && (isMine || canManage) && ['Completed', 'Rejected', 'Cancelled'].includes(request.status) && !request.closedAt && (
            <SpinnerButton className="btn btn-secondary" loadingText="Closing…"
              onClick={() => act(() => api.closePurchaseRequest(request.id, { comment }), 'Closed', 'The request has been closed.')}>
              Close request
            </SpinnerButton>
          )}
          {request.status === 'Draft' && isMine && (
            <SpinnerButton className="btn btn-primary" loadingText="Submitting…"
              onClick={() => act(() => api.submitRequest(request.id), 'Submitted', 'Sent for approval.')}>
              <Send size={14} /> Submit for approval
            </SpinnerButton>
          )}
          {request.status === 'Under Review' && isMine && (
            <SpinnerButton className="btn btn-primary" loadingText="Sending…"
              onClick={() => act(() => api.respondToRequest(request.id, { comment }), 'Sent back', 'Returned to the approver.')}>
              Send back for approval
            </SpinnerButton>
          )}
          {canDecideNow && (
            <>
              <SpinnerButton className="btn btn-primary" loadingText="Approving…"
                onClick={() => act(() => api.approveRequest(request.id, { comment }), 'Approved', 'The request has been approved.')}>
                <CheckCircle2 size={14} /> Approve
              </SpinnerButton>
              <SpinnerButton className="btn btn-secondary" loadingText="Rejecting…"
                onClick={() => {
                  if (!comment.trim()) return addToast('Reason required', 'Say why you are rejecting this request.', 'error');
                  return act(() => api.rejectRequest(request.id, { comment }), 'Rejected', 'No changes were applied.');
                }}>
                <XCircle size={14} /> Reject
              </SpinnerButton>
              <SpinnerButton className="btn btn-secondary" loadingText="Sending…"
                onClick={() => {
                  if (!comment.trim()) return addToast('Say what you need', 'Describe the information you need.', 'error');
                  return act(() => api.requestMoreInfo(request.id, { comment }), 'Sent', 'The requester has been asked for more information.');
                }}>
                <ShieldQuestion size={14} /> Request info
              </SpinnerButton>
            </>
          )}
          {canManage && decidable && (
            <button className="btn btn-secondary" onClick={openReassign}><UserCog size={14} /> Reassign</button>
          )}
          <div style={{ flex: 1 }} />
          {(isMine || canManage) && ['Draft', 'Pending Approval', 'Under Review'].includes(request.status) && (
            <SpinnerButton className="btn btn-secondary" loadingText="Cancelling…"
              onClick={() => act(() => api.cancelRequest(request.id, { comment }), 'Cancelled', 'The request was cancelled.')}>
              Cancel request
            </SpinnerButton>
          )}
          {canDelete && (
            <SpinnerButton className="btn btn-secondary" icon={Trash2} loadingText="Deleting…"
              onClick={async () => {
                if (!window.confirm(`Delete ${request.id} and its audit history? This cannot be undone.`)) return;
                await act(() => api.deleteRequest(request.id), 'Deleted', `${request.id} removed.`);
                onClose();
              }}>
              Delete
            </SpinnerButton>
          )}
        </div>
      )}
    >
      {loading || !request ? (
        <div className="skeleton skeleton-row" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* header facts */}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <span className={statusBadge(request.displayStatus)}>{request.displayStatus}</span>
            <span className={priorityBadge(request.priority)}>{request.priority}</span>
            {request.totalLevels > 1 && (
              <span className="badge">Level {request.currentLevel} of {request.totalLevels}</span>
            )}
            {request.overdue && <span className="badge badge-disposed">Overdue — due {fmtDate(request.dueDate)}</span>}
            {request.completedAt && <span className="badge">Completed {fmtDateTime(request.completedAt)}</span>}
          </div>

          {request.applyError && (
            <div style={{
              padding: '10px 12px', borderRadius: '8px',
              background: 'var(--status-disposed-bg)', border: '1px solid var(--status-disposed-glow)'
            }}>
              <strong style={{ color: 'var(--status-disposed)', fontSize: '13px' }}>Approved, but the changes were not applied.</strong>
              <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginTop: '4px' }}>{request.applyError}</div>
            </div>
          )}

          <div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '2px' }}>Reason</div>
            <div style={{ fontSize: '13.5px' }}>{request.reason}</div>
            {request.description && (
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '8px', whiteSpace: 'pre-wrap' }}>
                {request.description}
              </div>
            )}
          </div>

          {/* tabs */}
          <div className="tabs-container">
            {[
              ['review', 'Comparison'],
              ['approvals', 'Approvals'],
              ['documents', `Documents (${request.attachments.length})`],
              ['comments', `Comments (${request.comments.length})`],
              ['history', 'Audit history'],
            ].map(([key, label]) => (
              <button key={key} className={`tab-btn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'review' && (isPurchase
            ? <PurchaseRequestPanel request={request} addToast={addToast} />
            : <DiffTable comparison={comparison} />)}
          {tab === 'approvals' && <ApprovalTimeline request={request} />}
          {tab === 'documents' && (
            <AttachmentList
              attachments={request.attachments}
              docTypes={isPurchase ? docTypes : undefined}
              canEdit={(isMine || canApprove) && ['Draft', 'Pending Approval', 'Under Review'].includes(request.status)}
              addToast={addToast}
              onAdd={async (doc) => { await api.addRequestAttachment(request.id, doc); await refresh(); }}
              onReplace={async (attId, doc) => { await api.replaceRequestAttachment(request.id, attId, doc); await refresh(); }}
              onDelete={async (attId) => { await api.deleteRequestAttachment(request.id, attId); await refresh(); }}
            />
          )}
          {tab === 'comments' && (
            <CommentThread
              comments={request.comments}
              canComment
              onSubmit={async (body) => {
                try {
                  await api.addRequestComment(request.id, body);
                  await refresh();
                } catch (err) {
                  addToast('Could not comment', err.message, 'error');
                }
              }}
            />
          )}
          {tab === 'history' && <AuditTimeline history={request.history} />}

          {/* the decision note, shared by approve/reject/info/cancel */}
          {(canDecideNow || (isMine && request.status === 'Under Review')) && (
            <div className="form-group">
              <label className="form-label">
                {request.status === 'Under Review' && isMine ? 'Your response' : 'Comment (required to reject or request info)'}
              </label>
              <textarea className="form-input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)}
                placeholder="Recorded on the request and sent to the other party…" />
            </div>
          )}
        </div>
      )}

      {revising && request && (
        <PurchaseRequestForm
          request={request}
          onClose={() => setRevising(false)}
          onSaved={async () => { setRevising(false); await refresh(); }}
          addToast={addToast}
        />
      )}

      {reassigning && request && (
        <ReassignModal
          request={request}
          approvers={approvers}
          onClose={() => setReassigning(false)}
          onDone={async () => { setReassigning(false); await refresh(); }}
          addToast={addToast}
        />
      )}
    </Modal>
  );
}

/* ====================================================== reassign */

function ReassignModal({ request, approvers, onClose, onDone, addToast }) {
  const [toUserId, setToUserId] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const target = approvers.find((a) => String(a.id) === String(toUserId));

  const submit = async () => {
    if (!toUserId) return;
    setBusy(true);
    try {
      await api.reassignRequest(request.id, {
        toUserId, toUserName: target?.name, level: request.currentLevel, comment,
      });
      addToast('Reassigned', `${request.id} now sits with ${target?.name}.`, 'success');
      await onDone();
    } catch (err) {
      addToast('Could not reassign', err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Reassign ${request.id}`} maxWidth="480px"
      subtitle={`Level ${request.currentLevel} of ${request.totalLevels}`}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !toUserId}>
            {busy ? 'Reassigning…' : 'Reassign'}
          </button>
        </>
      }>
      <div className="form-group">
        <label className="form-label">New approver *</label>
        <CustomSelect searchable value={toUserId} onChange={(e) => setToUserId(e.target.value)}
          placeholder="Pick an approver…"
          options={approvers.map((a) => ({ value: String(a.id), label: `${a.name} — ${a.role}` }))} />
      </div>
      <div className="form-group">
        <label className="form-label">Note</label>
        <textarea className="form-input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)}
          placeholder="Why is this moving?" />
      </div>
    </Modal>
  );
}

/* ====================================================== create */

/**
 * The create form is generated from the chosen type's field list, which the server derives
 * from the registry. That is what makes a new request type need no frontend work: pick the
 * type, the form appears, prefilled with the record's current values.
 */
function CreateRequestModal({ options, onClose, onCreated, addToast }) {
  const [type, setType] = useState('');
  const [recordId, setRecordId] = useState('');
  const [record, setRecord] = useState(null);
  const [loadingRecord, setLoadingRecord] = useState(false);
  const [values, setValues] = useState({});
  const [reason, setReason] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('Medium');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);

  // Types that propose a *new* document rather than an edit carry a payload the generated
  // form cannot express (line items, quotations), and have no record to look up. They get
  // their own entry point — see the "New purchase request" button.
  const editTypes = options.types.filter((t) => t.needsRecord !== false);
  const descriptor = editTypes.find((t) => t.key === type);

  const lookup = async () => {
    if (!type || !recordId.trim()) return;
    setLoadingRecord(true);
    setRecord(null);
    try {
      const r = await api.getRequestRecord(type, recordId.trim());
      setRecord(r);
      // Prefill with what the record holds now, so the requester edits reality rather than
      // retyping it — and so an untouched field produces no spurious diff.
      const prefill = {};
      for (const f of r.fields) prefill[f.key] = r.values[f.key] ?? '';
      setValues(prefill);
    } catch (err) {
      addToast('Record not found', err.message, 'error');
    } finally {
      setLoadingRecord(false);
    }
  };

  const submit = async () => {
    if (!reason.trim()) return addToast('Reason required', 'Say why this change is needed.', 'error');
    setBusy(true);
    try {
      const proposed = {};
      for (const f of descriptor.fields) {
        if (!(f.key in values)) continue;
        proposed[f.key] = coerceInput(values[f.key], f.type);
      }
      const created = await api.createRequest({
        requestType: type,
        recordId: recordId.trim(),
        proposedChanges: proposed,
        reason: reason.trim(),
        description: description.trim() || undefined,
        priority,
        dueDate: dueDate || undefined,
      });
      addToast('Request raised', `${created.id} is awaiting approval.`, 'success');
      await onCreated(created.id);
    } catch (err) {
      addToast('Could not raise the request', err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="New request" maxWidth="760px"
      subtitle="The record stays unchanged until the request is approved."
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !record || !reason.trim()}>
            <Send size={14} /> {busy ? 'Submitting…' : 'Submit for approval'}
          </button>
        </>
      }>
      <div className="form-grid">
        <div className="form-group">
          <label className="form-label">Request type *</label>
          <CustomSelect value={type} placeholder="What kind of request?"
            onChange={(e) => { setType(e.target.value); setRecord(null); setValues({}); }}
            options={editTypes.map((t) => ({ value: t.key, label: t.label }))} />
        </div>
        <div className="form-group">
          <label className="form-label">Record *</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input className="form-input" value={recordId} disabled={!type}
              placeholder={type ? 'Record id…' : 'Pick a type first'}
              onChange={(e) => setRecordId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } }} />
            <button className="btn btn-secondary" onClick={lookup} disabled={!type || !recordId.trim() || loadingRecord}>
              {loadingRecord ? 'Loading…' : 'Load'}
            </button>
          </div>
        </div>
      </div>

      {record && (
        <>
          <div style={{
            padding: '8px 12px', borderRadius: '8px', margin: '4px 0 14px',
            background: 'var(--bg-subtle)', border: '1px solid var(--border-color)', fontSize: '13px'
          }}>
            Editing <strong>{record.label}</strong> — change only what should differ. Untouched fields are left alone.
          </div>

          <div className="form-grid">
            {descriptor.fields.map((f) => (
              <div className="form-group" key={f.key}>
                <label className="form-label">{f.label}</label>
                {f.type === 'boolean' ? (
                  <CustomSelect value={String(values[f.key] ?? false)}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value === 'true' }))}
                    options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} />
                ) : f.type === 'json' ? (
                  // Line items and the like: not hand-editable here. Left out of the proposal
                  // entirely rather than shown as an input that would corrupt them.
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>
                    Edit this from the record’s own screen and raise the request from there.
                  </div>
                ) : (
                  <input className="form-input"
                    type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="form-grid">
        <div className="form-group full-width">
          <label className="form-label">Reason *</label>
          <input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Why does this need to change?" />
        </div>
        <div className="form-group">
          <label className="form-label">Priority</label>
          <CustomSelect value={priority} onChange={(e) => setPriority(e.target.value)}
            options={options.priorities.map((p) => ({ value: p, label: p }))} />
        </div>
        <div className="form-group">
          <label className="form-label">Needed by</label>
          <input className="form-input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
        <div className="form-group full-width">
          <label className="form-label">Description</label>
          <textarea className="form-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Anything the approver should know." />
        </div>
      </div>

      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
        Supporting documents can be attached from the request once it is raised.
      </div>
    </Modal>
  );
}
