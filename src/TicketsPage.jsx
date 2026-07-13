import React, { useState, useEffect, useRef } from 'react';
import { AnimatePresence } from 'framer-motion';
import {
  Plus, Eye, AlertCircle, Clock, Check,
  Trash2, Send, Paperclip, ClipboardList, FileText, CheckCircle2,
  Users, User, AlertTriangle, Search, ArrowLeft, RefreshCw, BookOpen, Lightbulb,
  Layers, Building, ShieldCheck
} from 'lucide-react';
import { api } from './api';
import { openStoredFile } from './files';
import Modal from './Modal';
import Markdown from './Markdown';
import FloatingBulkBar from './FloatingBulkBar';
import Checkbox from './Checkbox';
import RelativeTime from './RelativeTime';
import { parseTimestamp } from './time';
import CustomSelect from './CustomSelect';
import AsyncBoundary from './AsyncBoundary';
import { STATUS } from './asyncStatus';
import { SpinnerButton } from './SpinnerButton';
import { useAsyncAction } from './useAsyncAction';
import { PageSkeleton } from './Skeleton';

const TicketsPage = ({ isApiConnected, currentRole, currentUser, usersList, addToast, canManageTickets = false, departments = [] }) => {
  const [tickets, setTickets] = useState([]);
  const [activeTicket, setActiveTicket] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Unified helpdesk: the requester now chooses the queue. Default to their own
  // department when it is one of the helpdesk queues, otherwise IT.
  const HELPDESK_DEPARTMENTS = [
    { value: 'IT', label: 'IT Support' },
    { value: 'Administration', label: 'Administration' },
    { value: 'HR', label: 'Human Resources' }
  ];
  const TICKET_TYPES = ['Incident', 'Service Request', 'General Query', 'Purchase Request'];
  const defaultDept = HELPDESK_DEPARTMENTS.some(d => d.value === currentUser?.department)
    ? currentUser.department
    : 'IT';
  const [ticketDepartment, setTicketDepartment] = useState(defaultDept);
  const [ticketType, setTicketType] = useState('Incident');
  const [kbSuggestions, setKbSuggestions] = useState([]);
  const [kbArticlePreview, setKbArticlePreview] = useState(null);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('Software');
  const [priority, setPriority] = useState('Medium');
  const [commentText, setCommentText] = useState('');
  const [isInternalComment, setIsInternalComment] = useState(false);
  const [slaTick, setSlaTick] = useState(Date.now());
  const [isFiling, setIsFiling] = useState(false);
  const [slaPreview, setSlaPreview] = useState(null);

  // Search, views, filter states
  const [selectedView, setSelectedView] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [filterDepartment, setFilterDepartment] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterAssignee, setFilterAssignee] = useState('');
  const [filterRequester, setFilterRequester] = useState('');

  // Sorting
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortOrder, setSortOrder] = useState('desc');

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(10);

  // Bulk selection
  const [selectedTicketIds, setSelectedTicketIds] = useState([]);

  // Toolbar action choices
  const [bulkStatusVal, setBulkStatusVal] = useState('');
  const [bulkPriorityVal, setBulkPriorityVal] = useState('');
  const [bulkCategoryVal, setBulkCategoryVal] = useState('');
  const [bulkDeptVal, setBulkDeptVal] = useState('');
  const [bulkAssignVal, setBulkAssignVal] = useState('');

  const [analytics, setAnalytics] = useState({
    counts: { total: 0, open: 0, inProgress: 0, waiting: 0, resolved: 0, closed: 0, overdue: 0, avgResolutionTimeHours: 0 },
    byPriority: {},
    byDepartment: {}
  });

  const [uploadedAttachments, setUploadedAttachments] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);

  const [ticketsStatus, setTicketsStatus] = useState(STATUS.LOADING);
  const [ticketsError, setTicketsError] = useState(null);

  /**
   * Loads the queue.
   *
   * The old version swallowed a failed fetch into console.error, leaving `tickets`
   * empty and `analytics.counts` at its initial zeros — so a backend outage rendered
   * as "0 tickets", indistinguishable from a genuinely empty queue. It also read a
   * localStorage key and presented it as live data; every such fallback has since
   * been replaced with an explicit "not connected" error.
   *
   * A failure on the *first* load becomes an error state with a Retry. A failure on a
   * background refresh (there is one after each mutation) must not wipe a working
   * screen, so it surfaces as a toast and leaves the data alone.
   */
  const loadTickets = async ({ firstLoad = ticketsStatus === STATUS.LOADING } = {}) => {
    if (!isApiConnected) {
      setTicketsError(new Error('Not connected to the server.'));
      setTicketsStatus(STATUS.ERROR);
      return;
    }

    try {
      const [data, stats] = await Promise.all([api.getTickets(), api.getTicketsAnalytics()]);
      setTickets(data || []);
      // Guard the shape: the stat cards read analytics.counts unconditionally.
      if (stats && stats.counts) setAnalytics(stats);
      setTicketsError(null);
      setTicketsStatus(STATUS.READY);
    } catch (err) {
      console.error('Failed to load tickets from API', err);
      if (firstLoad) {
        setTicketsError(err);
        setTicketsStatus(STATUS.ERROR);
      } else {
        addToast('Refresh failed', err.message || 'Could not refresh the ticket queue.', 'error');
      }
    }
  };

  const retryLoadTickets = () => {
    setTicketsError(null);
    setTicketsStatus(STATUS.LOADING);
    loadTickets({ firstLoad: true });
  };

  useEffect(() => {
    loadTickets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isApiConnected, currentRole, currentUser]);

  // SLA Live Countdown Tick
  useEffect(() => {
    const timer = setInterval(() => {
      setSlaTick(Date.now());
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  // Live SLA preview while filing a ticket: ask the server which policy would apply and
  // what deadlines it would set, so the requester sees the real, database-driven SLA.
  useEffect(() => {
    if (!showCreateModal) { setSlaPreview(null); return; }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const preview = await api.previewSla({ priority, category, department: ticketDepartment });
        if (!cancelled) setSlaPreview(preview);
      } catch {
        if (!cancelled) setSlaPreview(null);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [showCreateModal, priority, category, ticketDepartment]);

  // Reset pagination on search / filter / view updates
  useEffect(() => {
    setCurrentPage(1);
    setSelectedTicketIds([]);
  }, [selectedView, searchQuery, filterStatus, filterPriority, filterDepartment, filterCategory, filterAssignee, filterRequester]);


  // Handle Attachment Upload
  const handleAttachmentUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsUploading(true);
    try {
      if (isApiConnected) {
        const uploaded = await api.uploadFile(file);
        setUploadedAttachments(prev => [...prev, {
          name: uploaded.name,
          fileName: uploaded.fileName,
          fileSize: uploaded.fileSize,
          fileUrl: uploaded.fileUrl,
          fileType: file.type
        }]);
        addToast("File Attached", `"${file.name}" uploaded successfully.`, "success");
      } else {
        setUploadedAttachments(prev => [...prev, {
          name: file.name,
          fileName: `mock-${Date.now()}-${file.name}`,
          fileSize: `${(file.size / 1024).toFixed(1)} KB`,
          fileUrl: URL.createObjectURL(file),
          fileType: file.type
        }]);
        addToast("File Attached (Local)", `"${file.name}" attached locally.`, "success");
      }
    } catch (err) {
      addToast("Upload Failed", err.message, "error");
    } finally {
      setIsUploading(false);
    }
  };

  // Create Ticket
  // Suggest knowledge base articles as the subject is typed. Debounced so each
  // keystroke does not hit the database; api.suggestKbArticles never throws, so a
  // failing lookup can never block someone from filing a ticket.
  useEffect(() => {
    if (!showCreateModal || !isApiConnected || subject.trim().length < 3) {
      setKbSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      setKbSuggestions(await api.suggestKbArticles(subject.trim()));
    }, 350);
    return () => clearTimeout(timer);
  }, [subject, showCreateModal, isApiConnected]);

  const handleCreateTicket = async (e) => {
    e.preventDefault();
    if (isFiling) return;
    if (!subject.trim() || !description.trim()) return;

    setIsFiling(true);
    const targetDept = ticketDepartment;
    let slaHours = 24;
    if (priority === 'Critical') slaHours = 10;
    else if (priority === 'Low') slaHours = 48;

    const slaDeadline = new Date();
    slaDeadline.setHours(slaDeadline.getHours() + slaHours);

    if (isApiConnected) {
      try {
        const newTicket = await api.createTicket({
          subject,
          description,
          department: targetDept,
          priority,
          category,
          ticketType,
          attachments: uploadedAttachments
        });
        addToast("Ticket Created", `Ticket ${newTicket.ticketId} has been created successfully.`, "success");
        setShowCreateModal(false);
        setSubject('');
        setDescription('');
        setCategory('Software');
        setTicketType('Incident');
        setTicketDepartment(defaultDept);
        setKbSuggestions([]);
        setUploadedAttachments([]);
        loadTickets();
      } catch (err) {
        addToast("Creation Failed", err.message, "error");
      } finally {
        setIsFiling(false);
      }
    } else {
      // No local fallback: presenting stale localStorage rows as live server
      // data is worse than refusing the action.
      addToast('Not connected', 'You are not connected to the server. This action was not performed.', 'error');
    }
  };

  // View Ticket Details
  const viewTicketDetails = async (t) => {
    if (isApiConnected) {
      try {
        const details = await api.getTicketById(t.id);
        setActiveTicket(details);
      } catch (err) {
        addToast("Load Failed", err.message, "error");
      }
    } else {
      setActiveTicket(t);
    }
  };

  // Add Comment
  const [handleAddComment, postingComment] = useAsyncAction(async (e) => {
    e.preventDefault();
    if (!commentText.trim() || !activeTicket) return;

    if (isApiConnected) {
      try {
        await api.addTicketComment(activeTicket.id, commentText, isInternalComment);
        setCommentText('');
        addToast("Comment Added", "Your comment has been posted successfully.", "success");
        const details = await api.getTicketById(activeTicket.id);
        setActiveTicket(details);
        loadTickets();
      } catch (err) {
        addToast("Comment Failed", err.message, "error");
      }
    } else {
      // No local fallback: presenting stale localStorage rows as live server
      // data is worse than refusing the action.
      addToast('Not connected', 'You are not connected to the server. This action was not performed.', 'error');
    }
  });

  // Assign Ticket
  const handleAssignTicket = async (assignToUserId) => {
    if (isApiConnected) {
      try {
        await api.assignTicket(activeTicket.id, assignToUserId);
        addToast("Ticket Assigned", "Ticket ownership has been updated.", "success");
        const details = await api.getTicketById(activeTicket.id);
        setActiveTicket(details);
        loadTickets();
      } catch (err) {
        addToast("Assignment Failed", err.message, "error");
      }
    } else {
      // No local fallback: presenting stale localStorage rows as live server
      // data is worse than refusing the action.
      addToast('Not connected', 'You are not connected to the server. This action was not performed.', 'error');
    }
  };

  // Auto Assign Ticket (Workload-based)
  const handleAutoAssignTicket = async () => {
    if (isApiConnected) {
      try {
        const res = await api.autoAssignTicket(activeTicket.id);
        addToast("Auto Assigned", `Ticket automatically routed to ${res.assignedToName} based on workload.`, "success");
        const details = await api.getTicketById(activeTicket.id);
        setActiveTicket(details);
        loadTickets();
      } catch (err) {
        addToast("Routing Failed", err.message, "error");
      }
    } else {
      // No local fallback: presenting stale localStorage rows as live server
      // data is worse than refusing the action.
      addToast('Not connected', 'You are not connected to the server. This action was not performed.', 'error');
    }
  };

  // Update Status
  const handleUpdateStatus = async (newStatus) => {
    if (isApiConnected) {
      try {
        await api.updateTicketStatus(activeTicket.id, newStatus);
        addToast("Status Updated", `Ticket is now marked as "${newStatus}".`, "success");
        const details = await api.getTicketById(activeTicket.id);
        setActiveTicket(details);
        loadTickets();
      } catch (err) {
        addToast("Failed to Update Status", err.message, "error");
      }
    } else {
      // No local fallback: presenting stale localStorage rows as live server
      // data is worse than refusing the action.
      addToast('Not connected', 'You are not connected to the server. This action was not performed.', 'error');
    }
  };

  // Update Priority
  const handleUpdatePriority = async (newPriority) => {
    if (isApiConnected) {
      try {
        await api.updateTicketPriority(activeTicket.id, newPriority);
        addToast("Priority Updated", `Ticket priority changed to "${newPriority}".`, "success");
        const details = await api.getTicketById(activeTicket.id);
        setActiveTicket(details);
        loadTickets();
      } catch (err) {
        addToast("Failed to Update Priority", err.message, "error");
      }
    } else {
      // No local fallback: presenting stale localStorage rows as live server
      // data is worse than refusing the action.
      addToast('Not connected', 'You are not connected to the server. This action was not performed.', 'error');
    }
  };

  // Update Category
  const handleUpdateCategory = async (newCategory) => {
    if (isApiConnected) {
      try {
        await api.updateTicketCategory(activeTicket.id, newCategory);
        addToast("Category Updated", `Ticket category changed to "${newCategory}".`, "success");
        const details = await api.getTicketById(activeTicket.id);
        setActiveTicket(details);
        loadTickets();
      } catch (err) {
        addToast("Failed to Update Category", err.message, "error");
      }
    } else {
      // No local fallback: presenting stale localStorage rows as live server
      // data is worse than refusing the action.
      addToast('Not connected', 'You are not connected to the server. This action was not performed.', 'error');
    }
  };

  // Update Department (Super Admin only)
  const handleUpdateDepartment = async (newDept) => {
    if (isApiConnected) {
      try {
        await api.updateTicketDepartment(activeTicket.id, newDept);
        addToast("Department Reassigned", `Ticket queue moved to "${newDept}" department.`, "success");
        const details = await api.getTicketById(activeTicket.id);
        setActiveTicket(details);
        loadTickets();
      } catch (err) {
        addToast("Failed to Update Department", err.message, "error");
      }
    } else {
      // No local fallback: presenting stale localStorage rows as live server
      // data is worse than refusing the action.
      addToast('Not connected', 'You are not connected to the server. This action was not performed.', 'error');
    }
  };

  // Bulk Actions
  const handleBulkDelete = async () => {
    if (!window.confirm(`Are you sure you want to delete ${selectedTicketIds.length} tickets?`)) return;
    if (isApiConnected) {
      try {
        await api.bulkDeleteTickets(selectedTicketIds);
        addToast("Bulk Deleted", `Deleted ${selectedTicketIds.length} tickets successfully.`, "success");
        setSelectedTicketIds([]);
        loadTickets();
      } catch (err) {
        addToast("Deletion Failed", err.message, "error");
      }
    } else {
      // No local fallback: presenting stale localStorage rows as live server
      // data is worse than refusing the action.
      addToast('Not connected', 'You are not connected to the server. This action was not performed.', 'error');
    }
  };

  const [isApplyingBulk, setIsApplyingBulk] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null);

  /**
   * Everything the user has staged, in the order it will be applied.
   *
   * The old workflow gave each field its own "Go" button, so changing status,
   * priority and assignee across a selection meant three separate round trips, three
   * toasts, and three chances to forget one. Staging them means the user reviews the
   * whole edit before any of it happens.
   */
  const getPendingBulkChanges = () => {
    const changes = [];
    if (bulkStatusVal) {
      changes.push({ field: 'Status', value: bulkStatusVal, run: () => api.bulkUpdateTicketsStatus(selectedTicketIds, bulkStatusVal) });
    }
    if (bulkPriorityVal) {
      changes.push({ field: 'Priority', value: bulkPriorityVal, run: () => api.bulkUpdateTicketsPriority(selectedTicketIds, bulkPriorityVal) });
    }
    if (bulkCategoryVal) {
      changes.push({ field: 'Category', value: bulkCategoryVal, run: () => api.bulkUpdateTicketsCategory(selectedTicketIds, bulkCategoryVal) });
    }
    if (bulkDeptVal) {
      changes.push({ field: 'Department', value: bulkDeptVal, run: () => api.bulkUpdateTicketsDepartment(selectedTicketIds, bulkDeptVal) });
    }
    if (bulkAssignVal) {
      const target = usersList.find(u => u.id === parseInt(bulkAssignVal, 10));
      changes.push({
        field: 'Assignee',
        value: target ? (target.name || target.email) : 'Unassigned',
        run: () => api.bulkAssignTickets(selectedTicketIds, bulkAssignVal)
      });
    }
    return changes;
  };

  const clearBulkFields = () => {
    setBulkStatusVal('');
    setBulkPriorityVal('');
    setBulkCategoryVal('');
    setBulkDeptVal('');
    setBulkAssignVal('');
  };

  /**
   * Applies every staged change to the selection, one field at a time.
   *
   * Sequential rather than parallel: each call rewrites the same rows and appends to
   * the same ticket timeline, and the progress readout would be meaningless otherwise.
   *
   * A partial failure keeps the selection and the remaining staged values, so the
   * user can see what did not land and retry it. Clearing on partial success would
   * hide the failure behind an empty toolbar.
   */
  const handleApplyBulkChanges = async () => {
    const changes = getPendingBulkChanges();
    if (changes.length === 0 || isApplyingBulk) return;

    if (!isApiConnected) {
      addToast('Not connected', 'You are not connected to the server. No changes were applied.', 'error');
      return;
    }

    setIsApplyingBulk(true);
    const failures = [];

    try {
      for (let i = 0; i < changes.length; i += 1) {
        const change = changes[i];
        setBulkProgress({ done: i, total: changes.length, field: change.field });
        try {
          await change.run();
        } catch (err) {
          failures.push(`${change.field}: ${err.message}`);
        }
      }

      const applied = changes.length - failures.length;
      const ticketCount = selectedTicketIds.length;

      if (failures.length === 0) {
        addToast('Changes applied', `${applied} change${applied === 1 ? '' : 's'} applied to ${ticketCount} ticket${ticketCount === 1 ? '' : 's'}.`, 'success');
        clearBulkFields();
        setSelectedTicketIds([]);
      } else if (applied > 0) {
        addToast('Partially applied', `${applied} of ${changes.length} applied. Failed — ${failures.join('; ')}`, 'error');
      } else {
        addToast('Nothing applied', failures.join('; '), 'error');
      }

      await loadTickets();
    } finally {
      setIsApplyingBulk(false);
      setBulkProgress(null);
    }
  };


  const handleRowCheckbox = (id) => {
    setSelectedTicketIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  // SLA Time Calculator
  const renderSlaRemaining = (deadlineStr, status) => {
    if (status === 'Resolved' || status === 'Closed') {
      return <span className="sla-badge good">Resolved</span>;
    }

    // NaN < 0 is false, so an unparseable deadline used to fall through the
    // Overdue branch and render the literal "NaNh NaNm left".
    const deadline = parseTimestamp(deadlineStr);
    if (!deadline) {
      return <span className="sla-badge">No SLA</span>;
    }

    const diff = deadline.getTime() - Date.now();

    if (diff < 0) {
      return <span className="sla-badge urgent">Overdue</span>;
    }

    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return (
      <span className={`sla-badge ${hours <= 4 ? 'urgent' : hours <= 12 ? 'pending' : 'good'}`}>
        {hours}h {minutes}m left
      </span>
    );
  };

  // Remaining time to a deadline as a compact "Xh Ym" / "Xd Yh" / "Overdue" label. The
  // deadline was already computed against business hours by the server, so a plain
  // wall-clock countdown to it is correct.
  const formatCountdown = (deadlineStr) => {
    const deadline = parseTimestamp(deadlineStr);
    if (!deadline) return { label: '—', tone: 'muted' };
    const diff = deadline.getTime() - slaTick;
    if (diff < 0) {
      const over = Math.abs(diff);
      const oh = Math.floor(over / 3600000), om = Math.floor((over % 3600000) / 60000);
      return { label: `Overdue by ${oh >= 24 ? `${Math.floor(oh / 24)}d ` : ''}${oh % 24}h ${om}m`, tone: 'urgent' };
    }
    const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000);
    const label = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h left` : `${h}h ${m}m left`;
    return { label, tone: h <= 4 ? 'urgent' : h <= 12 ? 'pending' : 'good' };
  };

  const TRIGGER_LABELS = {
    response_percent: '% of response time', resolution_percent: '% of resolution time',
    response_remaining: 'min response remaining', resolution_remaining: 'min resolution remaining',
    response_breach: 'on response breach', resolution_breach: 'on resolution breach'
  };
  const TARGET_LABELS = {
    assignee: 'Assigned Technician', team_lead: 'Team Lead',
    department_manager: 'Department Manager', it_admin: 'IT Administrator', super_admin: 'Super Admin'
  };
  const SLA_STATE_LABELS = { on_track: 'On Track', breached: 'Breached', met: 'Met', at_risk: 'At Risk' };

  // SLA tracking panel for the ticket workspace sidebar: policy, both deadlines with a
  // live countdown, first-response state, escalation status and the escalation ladder.
  const renderSlaPanel = (t) => {
    const closed = t.status === 'Resolved' || t.status === 'Closed';
    const respDue = t.firstResponseDue;
    const resDue = t.resolutionDue || t.slaDeadline;
    const respCountdown = formatCountdown(respDue);
    const resCountdown = formatCountdown(resDue);
    const responded = !!t.firstResponseAt;
    const state = t.slaStatus || (t.resolutionBreached ? 'breached' : 'on_track');

    const Row = ({ label, children }) => (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', fontSize: '12px' }}>
        <span style={{ color: 'var(--text-muted)' }}>{label}</span>
        <span style={{ fontWeight: 600, textAlign: 'right' }}>{children}</span>
      </div>
    );

    return (
      <div className="card" style={{ padding: '20px' }}>
        <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '16px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ShieldCheck size={14} /> SLA Tracking
        </h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <Row label="SLA Policy">{t.slaPolicy ? t.slaPolicy.name : (t.slaPolicyId ? `Policy #${t.slaPolicyId}` : 'No policy matched')}</Row>
          {t.slaPolicy?.calendarName && <Row label="Calendar">{t.slaPolicy.calendarName}</Row>}
          <Row label="SLA Status">
            <span className={`sla-badge ${state === 'breached' ? 'urgent' : state === 'met' ? 'good' : 'pending'}`}>
              {SLA_STATE_LABELS[state] || state}
            </span>
          </Row>

          <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />

          <Row label="First Response">
            {responded
              ? <span style={{ color: t.responseBreached ? 'var(--status-disposed)' : 'var(--status-available)' }}>{t.responseBreached ? 'Late' : 'Met'}</span>
              : respDue ? <span className={`sla-badge ${respCountdown.tone}`}>{respCountdown.label}</span> : '—'}
          </Row>
          <Row label="Response Due">{respDue ? <RelativeTime value={respDue} /> : '—'}</Row>

          <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />

          <Row label="Resolution">
            {closed
              ? <span style={{ color: t.resolutionBreached ? 'var(--status-disposed)' : 'var(--status-available)' }}>{t.resolutionBreached ? 'Breached' : 'Met'}</span>
              : resDue ? <span className={`sla-badge ${resCountdown.tone}`}>{resCountdown.label}</span> : '—'}
          </Row>
          <Row label="Resolution Due">{resDue ? <RelativeTime value={resDue} /> : '—'}</Row>

          <Row label="Escalation">
            {t.escalationLevel > 0
              ? <span style={{ color: 'var(--status-disposed)', fontWeight: 700 }}>Level {t.escalationLevel}</span>
              : <span style={{ color: 'var(--text-muted)' }}>None</span>}
          </Row>

          {t.slaPolicy?.escalationLevels?.length > 0 && (
            <details style={{ marginTop: '4px' }}>
              <summary style={{ fontSize: '11px', color: 'var(--text-muted)', cursor: 'pointer' }}>Escalation ladder</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                {t.slaPolicy.escalationLevels.map((lvl) => (
                  <div key={lvl.level} style={{ fontSize: '11px', display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '4px 8px', background: 'var(--bg-sidebar)', borderRadius: 'var(--radius-sm)', opacity: t.escalationLevel >= lvl.level ? 1 : 0.6 }}>
                    <span style={{ fontWeight: 700 }}>L{lvl.level}</span>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {lvl.triggerType.includes('breach') ? '' : `${lvl.threshold} `}{TRIGGER_LABELS[lvl.triggerType] || lvl.triggerType}
                    </span>
                    <span>→ {TARGET_LABELS[lvl.notifyTarget] || lvl.notifyTarget}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    );
  };

  // Filtering + Searching logic
  const getFilteredTickets = () => {
    let list = [...tickets];

    // Views
    const now = new Date();
    if (selectedView === 'unassigned') {
      list = list.filter(t => !t.assignedTo && !t.assignedToName);
    } else if (selectedView === 'my_tickets') {
      list = list.filter(t => t.assignedTo === currentUser?.id);
    } else if (selectedView === 'open') {
      list = list.filter(t => t.status === 'Open' || t.status === 'Reopened');
    } else if (selectedView === 'pending') {
      list = list.filter(t => t.status === 'Pending' || t.status === 'On Hold' || t.status === 'Waiting for Employee');
    } else if (selectedView === 'resolved') {
      list = list.filter(t => t.status === 'Resolved');
    } else if (selectedView === 'closed') {
      list = list.filter(t => t.status === 'Closed');
    } else if (selectedView === 'overdue') {
      list = list.filter(t => {
        const deadline = new Date(t.slaDeadline);
        return deadline < now && t.status !== 'Resolved' && t.status !== 'Closed';
      });
    }

    // Search Query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(t =>
        (t.ticketId && t.ticketId.toLowerCase().includes(q)) ||
        (t.subject && t.subject.toLowerCase().includes(q)) ||
        (t.description && t.description.toLowerCase().includes(q)) ||
        (t.createdByName && t.createdByName.toLowerCase().includes(q)) ||
        (t.assignedToName && t.assignedToName.toLowerCase().includes(q))
      );
    }

    // Filters
    if (filterStatus) list = list.filter(t => t.status === filterStatus);
    if (filterPriority) list = list.filter(t => t.priority === filterPriority);
    if (filterDepartment) list = list.filter(t => t.department === filterDepartment);
    if (filterCategory) list = list.filter(t => (t.category || 'Software') === filterCategory);
    if (filterAssignee) list = list.filter(t => String(t.assignedTo) === String(filterAssignee));
    if (filterRequester) list = list.filter(t => t.createdByName === filterRequester || String(t.createdBy) === String(filterRequester));

    // Sort
    list.sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];

      if (valA === undefined || valA === null) valA = '';
      if (valB === undefined || valB === null) valB = '';

      if (typeof valA === 'string') {
        valA = valA.toLowerCase();
        valB = valB.toLowerCase();
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return list;
  };

  // Recomputed each render: the staged edit is derived from the select values.
  const pendingBulkChanges = getPendingBulkChanges();

  const filteredTickets = getFilteredTickets();
  const totalItems = filteredTickets.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedTickets = filteredTickets.slice(startIndex, startIndex + pageSize);

  const handleSort = (field) => {
    if (sortBy === field) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder('asc');
    }
  };

  const isAllPageSelected = paginatedTickets.length > 0 && paginatedTickets.every(t => selectedTicketIds.includes(t.id));
  const isSomePageSelected = paginatedTickets.some(t => selectedTicketIds.includes(t.id));

  const handleSelectAllPage = () => {
    const paginatedIds = paginatedTickets.map(t => t.id);
    if (isAllPageSelected) {
      setSelectedTicketIds(prev => prev.filter(id => !paginatedIds.includes(id)));
    } else {
      setSelectedTicketIds(prev => Array.from(new Set([...prev, ...paginatedIds])));
    }
  };

  const distinctRequesters = Array.from(new Set(tickets.map(t => t.createdByName))).filter(Boolean);
  const distinctCategories = ['Software', 'Hardware', 'Network', 'Access Request', 'Billing / Finance', 'General Request', 'Other'];
  // Department options come from the Department master (passed in), not a hardcoded list.
  // Any department already present on a ticket is unioned in so historical rows stay filterable.
  const distinctDepartments = Array.from(
    new Set([...departments, ...tickets.map(t => t.department)])
  ).filter(Boolean);

  return (
    <AsyncBoundary
      status={ticketsStatus}
      error={ticketsError}
      onRetry={retryLoadTickets}
      errorTitle="Unable to load the ticket queue"
      skeleton={<PageSkeleton cards={4} rows={8} />}
    >
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

      {/* 1. Dashboard View (Ticketing Registry Queue) */}
      {!activeTicket && (
        <>
          <div className="page-header" style={{ marginBottom: '4px' }}>
            <div className="page-title-section">
              <h1 className="page-title">Service Desk Ticket Queue</h1>
              <span className="page-subtitle">Track, filter, and resolve incoming service tickets in real time.</span>
            </div>
            <div className="page-actions" style={{ display: 'flex', gap: '12px' }}>
              <button className="btn btn-secondary" onClick={loadTickets} title="Refresh ticket queue">
                <RefreshCw size={15} />
              </button>
              <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
                <Plus size={16} />
                Create Support Ticket
              </button>
            </div>
          </div>

          {/* SLA Count grid */}
          <div className="ticket-stats-grid">
            <div className="ticket-stat-card" onClick={() => setSelectedView('all')} style={{ cursor: 'pointer' }}>
              <div className="ticket-stat-info">
                <div className="ticket-stat-number">{analytics.counts.total}</div>
                <div className="ticket-stat-label">Total Queue Tickets</div>
              </div>
              <div className="ticket-stat-icon"><ClipboardList size={20} /></div>
            </div>
            <div className="ticket-stat-card" onClick={() => setSelectedView('open')} style={{ cursor: 'pointer' }}>
              <div className="ticket-stat-info">
                <div className="ticket-stat-number" style={{ color: 'var(--primary)' }}>
                  {analytics.counts.open + analytics.counts.inProgress}
                </div>
                <div className="ticket-stat-label">Active Support</div>
              </div>
              <div className="ticket-stat-icon"><Clock size={20} /></div>
            </div>
            <div className="ticket-stat-card" onClick={() => setSelectedView('resolved')} style={{ cursor: 'pointer' }}>
              <div className="ticket-stat-info">
                <div className="ticket-stat-number" style={{ color: 'var(--status-available)' }}>
                  {analytics.counts.resolved}
                </div>
                <div className="ticket-stat-label">Resolved Tickets</div>
              </div>
              <div className="ticket-stat-icon"><CheckCircle2 size={20} /></div>
            </div>
            <div className="ticket-stat-card is-overdue" onClick={() => setSelectedView('overdue')} style={{ cursor: 'pointer' }}>
              <div className="ticket-stat-info">
                <div className="ticket-stat-number" style={{ color: 'var(--status-disposed)' }}>
                  {analytics.counts.overdue}
                </div>
                <div className="ticket-stat-label">SLA Overdue</div>
              </div>
              <div className="ticket-stat-icon"><AlertCircle size={20} /></div>
            </div>
          </div>

          {/* Saved Views Tabs */}
          <div className="card" style={{ padding: '0px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)' }}>
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-sidebar)', overflowX: 'auto', borderTopLeftRadius: 'var(--radius-lg)', borderTopRightRadius: 'var(--radius-lg)' }}>
              {[
                { id: 'all', label: 'All Tickets' },
                { id: 'unassigned', label: 'Unassigned Queue' },
                { id: 'my_tickets', label: 'Assigned to Me' },
                { id: 'open', label: 'Open / Reopened' },
                { id: 'pending', label: 'Pending / On Hold' },
                { id: 'resolved', label: 'Resolved' },
                { id: 'closed', label: 'Closed' },
                { id: 'overdue', label: 'SLA Overdue' }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setSelectedView(tab.id)}
                  style={{
                    padding: '14px 20px',
                    border: 'none',
                    background: 'transparent',
                    borderBottom: selectedView === tab.id ? '2px solid var(--primary)' : '2px solid transparent',
                    color: selectedView === tab.id ? 'var(--primary)' : 'var(--text-secondary)',
                    fontWeight: selectedView === tab.id ? '700' : '500',
                    fontSize: '13px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    transition: 'all 0.2s ease'
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Filter toolbar */}
            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', borderBottom: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <div className="search-field" style={{ flex: 1 }}>
                  <Search size={16} className="search-field-icon" />
                  <input
                    type="text"
                    placeholder="Search tickets by ID, subject, desc, requester or assignee..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="form-input"

                  />
                </div>
                {(filterStatus || filterPriority || filterDepartment || filterCategory || filterAssignee || filterRequester || searchQuery) && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      setSearchQuery('');
                      setFilterStatus('');
                      setFilterPriority('');
                      setFilterDepartment('');
                      setFilterCategory('');
                      setFilterAssignee('');
                      setFilterRequester('');
                    }}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    Clear Search & Filters
                  </button>
                )}
              </div>

              {/* Multi-select filter dropdowns */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <CustomSelect className="form-input-sm" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                    placeholder="Status: All"
                    options={[{ value: '', label: 'Status: All' }, ...['Open', 'In Progress', 'Pending', 'On Hold', 'Resolved', 'Closed', 'Reopened'].map(st => ({ value: st, label: st }))]} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <CustomSelect className="form-input-sm" value={filterPriority} onChange={e => setFilterPriority(e.target.value)}
                    placeholder="Priority: All"
                    options={[{ value: '', label: 'Priority: All' }, ...['Critical', 'Medium', 'Low'].map(pr => ({ value: pr, label: pr }))]} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <CustomSelect className="form-input-sm" value={filterDepartment} onChange={e => setFilterDepartment(e.target.value)}
                    placeholder="Department: All"
                    options={[{ value: '', label: 'Department: All' }, ...distinctDepartments.map(d => ({ value: d, label: d }))]} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <CustomSelect className="form-input-sm" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}
                    placeholder="Category: All"
                    options={[{ value: '', label: 'Category: All' }, ...distinctCategories.map(c => ({ value: c, label: c }))]} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <CustomSelect className="form-input-sm" value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)}
                    placeholder="Assignee: All" searchable
                    options={[{ value: '', label: 'Assignee: All' }, ...usersList.filter(u => u.role !== 'Employee').map(u => ({ value: u.id, label: u.name || u.email }))]} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <CustomSelect className="form-input-sm" value={filterRequester} onChange={e => setFilterRequester(e.target.value)}
                    placeholder="Requester: All" searchable
                    options={[{ value: '', label: 'Requester: All' }, ...distinctRequesters.map(rq => ({ value: rq, label: rq }))]} />
                </div>
              </div>
            </div>

            {/* Registry Queue Table */}
            <div className="table-container" style={{ margin: 0, borderRadius: 0, border: 'none' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    {currentRole !== 'Employee' && (
                      <th style={{ width: '40px', textAlign: 'center' }}>
                        <Checkbox
                          checked={isAllPageSelected}
                          indeterminate={isSomePageSelected}
                          onChange={handleSelectAllPage}
                          aria-label="Select all tickets on this page"
                        />
                      </th>
                    )}
                    <th onClick={() => handleSort('ticketId')} style={{ cursor: 'pointer' }}>
                      Ticket ID {sortBy === 'ticketId' && (sortOrder === 'asc' ? '▲' : '▼')}
                    </th>
                    <th onClick={() => handleSort('subject')} style={{ cursor: 'pointer' }}>
                      Subject {sortBy === 'subject' && (sortOrder === 'asc' ? '▲' : '▼')}
                    </th>
                    <th onClick={() => handleSort('department')} style={{ cursor: 'pointer' }}>
                      Department {sortBy === 'department' && (sortOrder === 'asc' ? '▲' : '▼')}
                    </th>
                    <th>Category</th>
                    <th onClick={() => handleSort('priority')} style={{ cursor: 'pointer' }}>
                      Priority {sortBy === 'priority' && (sortOrder === 'asc' ? '▲' : '▼')}
                    </th>
                    <th>Custodian Assigned</th>
                    <th>SLA Countdown</th>
                    <th onClick={() => handleSort('status')} style={{ cursor: 'pointer' }}>
                      Status {sortBy === 'status' && (sortOrder === 'asc' ? '▲' : '▼')}
                    </th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedTickets.length === 0 ? (
                    <tr>
                      <td colSpan={currentRole !== 'Employee' ? 10 : 9} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                        No support tickets match the selected views or filters.
                      </td>
                    </tr>
                  ) : (
                    paginatedTickets.map(t => {
                      const isSelected = selectedTicketIds.includes(t.id);
                      return (
                        <tr key={t.id} className={isSelected ? 'row-selected' : ''}>
                          {currentRole !== 'Employee' && (
                            <td style={{ textAlign: 'center' }}>
                              <Checkbox
                                checked={isSelected}
                                onChange={() => handleRowCheckbox(t.id)}
                                aria-label={`Select ticket ${t.ticketId}`}
                              />
                            </td>
                          )}
                          <td style={{ fontFamily: 'var(--font-mono)', fontWeight: '700', color: 'var(--primary)' }}>{t.ticketId}</td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ fontWeight: '600' }}>{t.subject}</span>
                              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Requester: {t.createdByName}</span>
                            </div>
                          </td>
                          <td>
                            <span className="badge" style={{ background: 'var(--bg-sidebar)' }}>{t.department}</span>
                          </td>
                          <td>
                            <span style={{ fontSize: '12px', fontWeight: '500', color: 'var(--text-secondary)' }}>
                              {t.category || 'Software'}
                            </span>
                          </td>
                          <td>
                            <span className={`badge ${
                              t.priority === 'Critical' ? 'badge-under-maintenance' :
                              t.priority === 'Medium' ? 'badge-assigned' : 'badge-available'
                            }`}>
                              {t.priority}
                            </span>
                          </td>
                          <td style={{ fontWeight: '500' }}>
                            {t.assignedToName ? t.assignedToName : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Unassigned</span>}
                          </td>
                          <td>
                            {renderSlaRemaining(t.slaDeadline, t.status)}
                          </td>
                          <td>
                            <span className={`badge badge-${t.status.toLowerCase().replace(/ /g, '-')}`}>
                              {t.status}
                            </span>
                          </td>
                          <td>
                            <button className="btn-table-action" onClick={() => viewTicketDetails(t)} title="Open Ticket Workspace">
                              <Eye size={15} />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination footer */}
            <div className="action-row" style={{ padding: '16px', justifyContent: 'space-between', background: 'var(--bg-sidebar)', borderBottomLeftRadius: 'var(--radius-lg)', borderBottomRightRadius: 'var(--radius-lg)' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Showing {totalItems > 0 ? startIndex + 1 : 0} to {Math.min(startIndex + pageSize, totalItems)} of {totalItems} tickets
              </div>
              <div className="action-row">
                <button
                  className="btn btn-secondary btn-sm" disabled={currentPage === 1} onClick={() => setCurrentPage(prev => prev - 1)}
                >
                  Previous
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(pageNum => (
                  <button
                    key={pageNum}
                    onClick={() => setCurrentPage(pageNum)}
                    style={{
                      padding: '6px 10px',
                      fontSize: '12px',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-color)',
                      background: currentPage === pageNum ? 'var(--primary)' : 'var(--bg-card)',
                      color: currentPage === pageNum ? '#fff' : 'var(--text-primary)',
                      cursor: 'pointer'
                    }}
                  >
                    {pageNum}
                  </button>
                ))}
                <button
                  className="btn btn-secondary btn-sm" disabled={currentPage === totalPages} onClick={() => setCurrentPage(prev => prev + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>

          {/* Floating Bulk Action Toolbar */}
          <AnimatePresence>
            {selectedTicketIds.length > 0 && (
              <FloatingBulkBar
                onClear={() => setSelectedTicketIds([])}
                summary={
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderRight: '1px solid var(--border-color)', paddingRight: '16px' }}>
                    <Layers size={18} style={{ color: 'var(--primary)' }} />
                    <span style={{ fontWeight: 600, fontSize: '14px', whiteSpace: 'nowrap' }}>
                      {selectedTicketIds.length} selected
                    </span>
                  </div>
                }
                actions={
                  <>
                  {/* Stage the fields; nothing is sent until Apply Changes. */}
                  <div className="action-row">
                    <CustomSelect className="form-input-sm" style={{ width: '130px' }}
                      value={bulkStatusVal} onChange={e => setBulkStatusVal(e.target.value)} disabled={isApplyingBulk}
                      placeholder="Status…"
                      options={[{ value: '', label: 'Status…' }, ...['Open', 'In Progress', 'Pending', 'On Hold', 'Resolved', 'Closed', 'Reopened'].map(st => ({ value: st, label: st }))]} />

                    <CustomSelect className="form-input-sm" style={{ width: '130px' }}
                      value={bulkPriorityVal} onChange={e => setBulkPriorityVal(e.target.value)} disabled={isApplyingBulk}
                      placeholder="Priority…"
                      options={[{ value: '', label: 'Priority…' }, ...['Critical', 'Medium', 'Low'].map(pr => ({ value: pr, label: pr }))]} />

                    <CustomSelect className="form-input-sm" style={{ width: '130px' }}
                      value={bulkCategoryVal} onChange={e => setBulkCategoryVal(e.target.value)} disabled={isApplyingBulk}
                      placeholder="Category…"
                      options={[{ value: '', label: 'Category…' }, ...distinctCategories.map(c => ({ value: c, label: c }))]} />

                    {canManageTickets && (
                      <CustomSelect className="form-input-sm" style={{ width: '130px' }}
                        value={bulkDeptVal} onChange={e => setBulkDeptVal(e.target.value)} disabled={isApplyingBulk}
                        placeholder="Department…"
                        options={[{ value: '', label: 'Department…' }, ...distinctDepartments.map(d => ({ value: d, label: d }))]} />
                    )}

                    <CustomSelect className="form-input-sm" style={{ width: '140px' }} searchable
                      value={bulkAssignVal} onChange={e => setBulkAssignVal(e.target.value)} disabled={isApplyingBulk}
                      placeholder="Assignee…"
                      options={[{ value: '', label: 'Assignee…' }, ...usersList.filter(u => u.role !== 'Employee').map(u => ({ value: u.id, label: u.name || u.email }))]} />
                  </div>

                  {/* Review: exactly what Apply Changes will do. */}
                  {pendingBulkChanges.length > 0 && (
                    <div className="bulk-pending" role="status" aria-live="polite">
                      {pendingBulkChanges.map(c => (
                        <span key={c.field} className="bulk-pending-chip">
                          {c.field} <strong>{c.value}</strong>
                        </span>
                      ))}
                    </div>
                  )}

                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleApplyBulkChanges}
                    disabled={pendingBulkChanges.length === 0 || isApplyingBulk}
                    aria-busy={isApplyingBulk}
                  >
                    {isApplyingBulk ? (
                      <>
                        <RefreshCw size={13} className="animate-spin" />
                        {bulkProgress
                          ? `Applying ${Math.min(bulkProgress.done + 1, bulkProgress.total)} of ${bulkProgress.total}…`
                          : 'Applying…'}
                      </>
                    ) : (
                      <>
                        <Check size={13} />
                        Apply Changes{pendingBulkChanges.length > 0 ? ` (${pendingBulkChanges.length})` : ''}
                      </>
                    )}
                  </button>

                  <button
                    className="btn btn-danger btn-sm"
                    style={{ display: 'flex', alignItems: 'center', gap: '6px'}}
                    onClick={handleBulkDelete}
                    disabled={isApplyingBulk}
                  >
                    <Trash2 size={13} />
                    Delete
                  </button>
                  </>
                }
              />
            )}
          </AnimatePresence>
        </>
      )}

      {/* 2. Ticket Details Workspace Panel */}
      {activeTicket && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <button className="btn btn-secondary" onClick={() => { setActiveTicket(null); loadTickets(); }} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <ArrowLeft size={15} />
                Back to Ticket Queue
              </button>
              <h2 style={{ fontSize: '20px', fontWeight: '800', margin: 0 }}>Ticket Workspace — {activeTicket.ticketId}</h2>
            </div>
            {renderSlaRemaining(activeTicket.slaDeadline, activeTicket.status)}
          </div>

          <div className="ticket-details-layout">

            {/* Main workspace section */}
            <div className="ticket-activity-section">
              <div className="card" style={{ padding: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px', borderBottom: '1px solid var(--border-color)', paddingBottom: '16px' }}>
                  <div>
                    <h3 style={{ fontSize: '20px', fontWeight: '800', margin: '4px 0', color: 'var(--text-primary)' }}>{activeTicket.subject}</h3>
                    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <User size={13} />
                        Requester: <strong>{activeTicket.createdByName}</strong>
                      </span>
                      <span>Created: <strong><RelativeTime value={activeTicket.createdAt} /></strong></span>
                      <span>Last Updated: <strong><RelativeTime value={activeTicket.updatedAt} /></strong></span>
                      <span>Type: <strong>{activeTicket.ticketType || 'Incident'}</strong></span>
                      <span>Department: <strong>{activeTicket.department}</strong></span>
                      <span>Priority: <strong>{activeTicket.priority}</strong></span>
                      <span>Agent: <strong>{activeTicket.assignedToName || 'Unassigned'}</strong></span>
                      {activeTicket.resolutionHours !== null && activeTicket.resolutionHours !== undefined && (
                        <span style={{ color: 'var(--status-available)' }}>
                          Resolved in: <strong>{activeTicket.resolutionHours}h</strong>
                        </span>
                      )}
                      {activeTicket.escalated && (
                        <span style={{ color: 'var(--status-disposed)', fontWeight: 600 }}>
                          <AlertTriangle size={12} style={{ verticalAlign: '-2px' }} /> Escalated
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className={`badge badge-${(activeTicket.status || 'open').toLowerCase().replace(/ /g, '-')}`} style={{ fontSize: '14px', padding: '6px 14px' }}>
                      {activeTicket.status}
                    </span>
                  </div>
                </div>

                <div style={{ background: 'var(--bg-sidebar)', padding: '20px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-color)', fontSize: '14px', lineHeight: '1.6', marginBottom: '24px', whiteSpace: 'pre-wrap' }}>
                  {activeTicket.description}
                </div>

                {/* Attachments */}
                {activeTicket.attachments && activeTicket.attachments.length > 0 && (
                  <div style={{ marginBottom: '24px' }}>
                    <h4 style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px', fontWeight: 700 }}>Attachments</h4>
                    <div className="attachment-preview-grid">
                      {activeTicket.attachments.map((att, idx) => (
                        <div key={idx} className="attachment-preview-card" style={{ cursor: 'pointer' }} onClick={() => openStoredFile(att.fileUrl)}>
                          <FileText className="attachment-file-icon" size={24} />
                          <span className="attachment-file-name" title={att.name}>{att.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Activity Timeline */}
                <div>
                  <h4 style={{ fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '16px', fontWeight: 700 }}>Activity Timeline & Auditing</h4>
                  <div className="timeline-list">
                    {activeTicket.timeline && activeTicket.timeline.map((itm, idx) => (
                      <div key={itm.id || idx} className="timeline-item active">
                        <RelativeTime className="timeline-time" style={{ display: 'block' }} value={itm.createdAt} />
                        <div className="timeline-title">{itm.action} by <span style={{ color: 'var(--primary)' }}>{itm.actorName}</span></div>
                        {itm.detail && <div className="timeline-detail">{itm.detail}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Chat Thread */}
              <div className="card" style={{ padding: '24px' }}>
                <h3 style={{ fontSize: '16px', fontWeight: '800', marginBottom: '16px' }}>Communications & Thread History</h3>

                <div className="ticket-comments-container" style={{ marginBottom: '20px', background: 'var(--bg-sidebar)' }}>
                  {(!activeTicket.comments || activeTicket.comments.length === 0) ? (
                    <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      No comments or resolution notes filed.
                    </div>
                  ) : (
                    activeTicket.comments.map(c => {
                      const isCurrentUser = c.authorId === currentUser?.id || c.authorName === currentUser?.name;
                      return (
                        <div
                          key={c.id}
                          className={`comment-bubble ${c.isInternal ? 'is-internal' : ''}`}
                          style={{
                            alignSelf: isCurrentUser ? 'flex-end' : 'flex-start',
                            borderLeft: c.isInternal ? '4px solid var(--status-maintenance)' : '1px solid var(--border-color)'
                          }}
                        >
                          <div className="comment-meta">
                            <span className="comment-author">{c.authorName}</span>
                            <RelativeTime value={c.createdAt} />
                          </div>
                          <div className="comment-body">{c.commentText || c.text || ''}</div>
                          {c.isInternal && (
                            <span
                              className="comment-type-badge"
                              style={{
                                position: 'absolute',
                                top: '-8px',
                                right: '12px',
                                background: 'var(--status-maintenance-glow)',
                                color: 'var(--status-maintenance)'
                              }}
                            >
                              Internal Staff Note
                            </span>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                <form onSubmit={handleAddComment} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <textarea
                    value={commentText}
                    onChange={e => setCommentText(e.target.value)}
                    placeholder={isInternalComment ? "Type private internal notes for support staff..." : "Type public reply to requester..."}
                    className="form-input"
                    style={{
                      minHeight: '100px',
                      borderColor: isInternalComment ? 'var(--status-maintenance)' : 'var(--border-color)',
                      background: isInternalComment ? 'var(--status-maintenance-glow)' : 'var(--bg-card)'
                    }}
                    required
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    {currentRole !== 'Employee' ? (
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={isInternalComment}
                          onChange={e => setIsInternalComment(e.target.checked)}
                        />
                        <span style={{ color: 'var(--status-maintenance)', fontWeight: 600 }}>Mark as Private Internal staff note</span>
                      </label>
                    ) : <div />}
                    <SpinnerButton type="submit" className="btn btn-primary" icon={Send} loading={postingComment} loadingText="Submitting Update…">Submit Update</SpinnerButton>
                  </div>
                </form>
              </div>
            </div>

            {/* Sidebar actions */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div className="card" style={{ padding: '20px' }}>
                <h4 style={{ fontSize: '13px', fontWeight: '700', marginBottom: '16px', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>Ticket Attributes</h4>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

                  {/* Status Dropdown */}
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: '11px' }}>Status</label>
                    <CustomSelect value={activeTicket.status} disabled={currentRole === 'Employee'}
                      onChange={e => handleUpdateStatus(e.target.value)}
                      options={['Open', 'In Progress', 'Pending', 'On Hold', 'Resolved', 'Closed', 'Reopened']} />
                  </div>

                  {/* Priority Dropdown */}
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: '11px' }}>Priority</label>
                    <CustomSelect value={activeTicket.priority} disabled={currentRole === 'Employee'}
                      onChange={e => handleUpdatePriority(e.target.value)}
                      options={['Critical', 'Medium', 'Low']} />
                  </div>

                  {/* Category Dropdown */}
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: '11px' }}>Category</label>
                    <CustomSelect value={activeTicket.category || 'Software'} disabled={currentRole === 'Employee'}
                      onChange={e => handleUpdateCategory(e.target.value)}
                      options={distinctCategories} />
                  </div>

                  {/* Department queue — only roles that can manage tickets may reassign */}
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: '11px' }}>Department Queue</label>
                    {canManageTickets ? (
                      <CustomSelect value={activeTicket.department}
                        onChange={e => handleUpdateDepartment(e.target.value)}
                        options={distinctDepartments.map(d => ({ value: d, label: d + ' Queue' }))} />
                    ) : (
                      <div style={{ padding: '6px 12px', background: 'var(--bg-sidebar)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', fontSize: '13px', fontWeight: '600' }}>
                        {activeTicket.department}
                      </div>
                    )}
                  </div>

                  {/* Assignee selection */}
                  {currentRole !== 'Employee' && (
                    <div className="form-group" style={{ margin: 0, borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
                      <label className="form-label" style={{ fontSize: '11px' }}>Desk Officer Assignment</label>
                      <CustomSelect value={activeTicket.assignedTo || ''} searchable style={{ marginBottom: '8px' }}
                        onChange={e => handleAssignTicket(e.target.value ? parseInt(e.target.value) : '')}
                        placeholder="-- Choose Agent --"
                        options={[{ value: '', label: '-- Choose Agent --' }, ...usersList.filter(u => u.role !== 'Employee').map(u => ({ value: u.id, label: (u.name || u.email) + ' (' + u.role + ')' }))]} />

                      <SpinnerButton
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ width: '100%' }}
                        onClick={handleAutoAssignTicket}
                        icon={Users}
                        loadingText="Assigning…"
                      >Auto-Assign (Workload)</SpinnerButton>
                    </div>
                  )}
                </div>
              </div>

              {/* SLA tracking (database-driven policy, deadlines, escalation) */}
              {renderSlaPanel(activeTicket)}

              {/* Employee self-close or reopen */}
              {activeTicket.status === 'Resolved' && (
                <button
                  className="btn btn-primary"
                  onClick={() => handleUpdateStatus('Closed')}
                  style={{ width: '100%' }}
                >
                  Confirm Resolution & Close
                </button>
              )}
              {activeTicket.status === 'Closed' && (
                <button
                  className="btn btn-secondary"
                  onClick={() => handleUpdateStatus('Reopened')}
                  style={{ width: '100%' }}
                >
                  Reopen Ticket
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 3. Ticket Creation Modal */}
      {showCreateModal && (
        <Modal
          isOpen
          onClose={() => { setShowCreateModal(false); setUploadedAttachments([]); }}
          title="File Help Desk Ticket"
          as="form"
          onSubmit={handleCreateTicket}
          maxWidth="560px"
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => { setShowCreateModal(false); setUploadedAttachments([]); }} disabled={isFiling}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={isFiling} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {isFiling ? (
                  <>
                    <RefreshCw size={14} className="animate-spin" />
                    Filing Ticket...
                  </>
                ) : 'File Ticket'}
              </button>
            </>
          }
        >

                {/* Unified helpdesk: the requester chooses the queue. Previously this was
                    auto-routed from their own profile, so an HR employee's IT problem
                    was filed to the HR queue. */}
                <div className="form-group">
                  <label className="form-label">Service Queue Department *</label>
                  <CustomSelect value={ticketDepartment} onChange={e => setTicketDepartment(e.target.value)} required disabled={isFiling}
                    options={HELPDESK_DEPARTMENTS.map(d => ({ value: d.value, label: d.label }))} />
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    <Building size={11} style={{ verticalAlign: '-1px' }} /> Routed to the {HELPDESK_DEPARTMENTS.find(d => d.value === ticketDepartment)?.label} team.
                  </span>
                </div>

                <div className="form-group">
                  <label className="form-label">Ticket Type *</label>
                  <CustomSelect value={ticketType} onChange={e => setTicketType(e.target.value)} required disabled={isFiling}
                    options={TICKET_TYPES} />
                </div>

                <div className="form-group">
                  <label className="form-label">Category *</label>
                  <CustomSelect value={category} onChange={e => setCategory(e.target.value)} required
                    options={distinctCategories} />
                </div>

                <div className="form-group">
                  <label className="form-label">Priority Impact Level *</label>
                  <CustomSelect value={priority} onChange={e => setPriority(e.target.value)} required
                    options={[
                      { value: 'Critical', label: 'Critical — highest urgency' },
                      { value: 'High', label: 'High' },
                      { value: 'Medium', label: 'Medium' },
                      { value: 'Low', label: 'Low' }
                    ]} />
                  {/* Live SLA preview: the deadlines the configured policies would set for
                      this ticket. No hardcoded hours — this reads the database. */}
                  {slaPreview && (
                    <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      {slaPreview.matched ? (
                        <>
                          <span><ShieldCheck size={11} style={{ verticalAlign: '-1px' }} /> SLA policy: <strong>{slaPreview.matched.name}</strong></span>
                          <span>First response due: <strong><RelativeTime value={slaPreview.firstResponseDue} /></strong> · Resolution due: <strong><RelativeTime value={slaPreview.resolutionDue} /></strong></span>
                        </>
                      ) : (
                        <span>No SLA policy matches this combination — a default 24h target will apply.</span>
                      )}
                    </div>
                  )}
                </div>

                <div className="form-group">
                  <label className="form-label">Subject *</label>
                  <input
                    type="text"
                    placeholder="e.g. Dell workstation keeps overheating on boot"
                    className="form-input"
                    value={subject}
                    onChange={e => setSubject(e.target.value)}
                    required
                    disabled={isFiling}
                  />
                </div>

                {/* Deflection: surface matching knowledge base articles before the
                    user commits to a ticket. Opening one is offered as an alternative,
                    never a replacement — the form stays exactly as it was. */}
                {kbSuggestions.length > 0 && (
                  <div style={{
                    border: '1px solid var(--primary-glow)',
                    background: 'var(--primary-soft)',
                    borderRadius: 'var(--radius-lg)',
                    padding: '14px 16px'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                      <Lightbulb size={15} style={{ color: 'var(--primary)' }} />
                      <span style={{ fontWeight: 600, fontSize: '13px' }}>
                        {kbSuggestions.length} article{kbSuggestions.length === 1 ? '' : 's'} may already answer this
                      </span>
                    </div>
                    <div style={{ display: 'grid', gap: '6px' }}>
                      {kbSuggestions.map(a => (
                        <button
                          key={a.id}
                          type="button"
                          className="btn btn-secondary"
                          style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '8px 12px' }}
                          onClick={async () => {
                            try {
                              setKbArticlePreview(await api.getKbArticle(a.id));
                            } catch (err) {
                              addToast('Error', err.message || 'Could not open the article.', 'error');
                            }
                          }}
                        >
                          <BookOpen size={14} style={{ flexShrink: 0 }} />
                          <span style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 }}>
                            <span style={{ fontWeight: 600 }}>{a.title}</span>
                            {a.summary && (
                              <span style={{ fontSize: '11.5px', color: 'var(--text-muted)', fontWeight: 400 }}>{a.summary}</span>
                            )}
                          </span>
                        </button>
                      ))}
                    </div>
                    <span style={{ display: 'block', marginTop: '10px', fontSize: '11px', color: 'var(--text-muted)' }}>
                      Still stuck? Carry on filling in the form below.
                    </span>
                  </div>
                )}

                <div className="form-group">
                  <label className="form-label">Detailed Description *</label>
                  <textarea
                    placeholder="Describe your request or workstation issues in details..."
                    className="form-input"
                    style={{ minHeight: '100px' }}
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    required
                    disabled={isFiling}
                  />
                </div>

                {/* Attachments */}
                <div className="form-group">
                  <label className="form-label">Attachments (Optional)</label>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleAttachmentUpload}
                      style={{ display: 'none' }}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => fileInputRef.current.click()}
                      disabled={isUploading || isFiling}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
                    >
                      <Paperclip size={15} />
                      Attach Document
                    </button>
                    {isUploading && <span style={{ fontSize: '11px', color: 'var(--primary)' }}>Uploading...</span>}
                  </div>

                  {uploadedAttachments.length > 0 && (
                    <div className="attachment-preview-grid" style={{ marginTop: '10px' }}>
                      {uploadedAttachments.map((att, idx) => (
                        <div key={idx} className="attachment-preview-card">
                          <FileText size={18} className="attachment-file-icon" />
                          <span className="attachment-file-name" title={att.name}>{att.name}</span>
                          <button
                            type="button"
                            style={{ background: 'transparent', border: 'none', color: 'var(--status-disposed)', marginTop: '4px', cursor: 'pointer' }}
                            onClick={() => setUploadedAttachments(prev => prev.filter((_, i) => i !== idx))}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

        </Modal>
      )}

      {/* Article preview, opened from the suggestions panel. Rendered above the create
          modal so the half-filled form is preserved behind it. */}
      {/* Stacked above the create modal; the half-filled form is preserved behind it. */}
      {kbArticlePreview && (
        <Modal
          isOpen
          onClose={() => setKbArticlePreview(null)}
          closeOnOverlayClick
          title={kbArticlePreview.title}
          subtitle={kbArticlePreview.summary}
          maxWidth="760px"
          zIndex={600}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setKbArticlePreview(null)}>
                Back to my ticket
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setKbArticlePreview(null);
                  setShowCreateModal(false);
                  setSubject('');
                  setDescription('');
                  setKbSuggestions([]);
                  addToast('Glad that helped', 'No ticket was created.', 'success');
                }}
              >
                This answered my question
              </button>
            </>
          }
        >
          <Markdown>{kbArticlePreview.body}</Markdown>
          {kbArticlePreview.attachments?.length > 0 && (
            <div className="attachment-preview-grid">
              {kbArticlePreview.attachments.map(a => (
                <div key={a.id} className="attachment-preview-card"
                     onClick={() => openStoredFile(a.file_path, m => addToast('Cannot open file', m, 'error'))}>
                  <FileText className="attachment-file-icon" size={22} />
                  <span className="attachment-file-name" title={a.file_name}>{a.file_name}</span>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
    </AsyncBoundary>
  );
};

export default TicketsPage;
