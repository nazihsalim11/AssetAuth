import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Plus, Eye, MessageSquare, AlertCircle, Clock, ChevronDown, Check, 
  Trash2, Send, Paperclip, ClipboardList, Info, FileText, CheckCircle2,
  Users, User, UserCheck, AlertTriangle, X, Search, Filter, ArrowLeft, RefreshCw, BookOpen, Lightbulb, 
  Layers, CheckSquare, Square, Building, ShieldCheck, Mail, Tag, HelpCircle
} from 'lucide-react';
import { api } from './api';
import { openStoredFile } from './files';
import Markdown from './Markdown';

const TicketsPage = ({ isApiConnected, currentRole, currentUser, usersList, addToast }) => {
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
  const [pageSize, setPageSize] = useState(10);

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

  // Load tickets
  const loadTickets = async () => {
    if (isApiConnected) {
      try {
        const data = await api.getTickets();
        setTickets(data);
        const stats = await api.getTicketsAnalytics();
        setAnalytics(stats);
      } catch (err) {
        console.error("Failed to load tickets from API", err);
      }
    } else {
      // Local fallback
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      
      // Filter based on role and department
      let filtered = [];
      if (currentRole === 'Super Admin') {
        filtered = localTickets;
      } else if (currentRole === 'Employee') {
        filtered = localTickets.filter(t => t.createdBy === currentUser?.username || t.createdBy === 'employee' || t.createdByName === currentUser?.name);
      } else {
        filtered = localTickets.filter(t => t.department === (currentUser?.department || currentRole.split(' ')[0]));
      }
      
      setTickets(filtered);
      calculateLocalAnalytics(localTickets);
    }
  };

  useEffect(() => {
    loadTickets();
  }, [isApiConnected, currentRole, currentUser]);

  // SLA Live Countdown Tick
  useEffect(() => {
    const timer = setInterval(() => {
      setSlaTick(Date.now());
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  // Reset pagination on search / filter / view updates
  useEffect(() => {
    setCurrentPage(1);
    setSelectedTicketIds([]);
  }, [selectedView, searchQuery, filterStatus, filterPriority, filterDepartment, filterCategory, filterAssignee, filterRequester]);

  const calculateLocalAnalytics = (allTickets) => {
    const scopeTickets = currentRole === 'Super Admin' 
      ? allTickets 
      : allTickets.filter(t => t.department === (currentUser?.department || currentRole.split(' ')[0]));

    const counts = { total: scopeTickets.length, open: 0, inProgress: 0, waiting: 0, resolved: 0, closed: 0, overdue: 0, avgResolutionTimeHours: 0 };
    const byPriority = {};
    const byDepartment = {};

    let resolvedCount = 0;
    let totalResolutionTime = 0;

    scopeTickets.forEach(t => {
      if (t.status === 'Open') counts.open++;
      else if (t.status === 'In Progress') counts.inProgress++;
      else if (t.status === 'Waiting for Employee') counts.waiting++;
      else if (t.status === 'Resolved') counts.resolved++;
      else if (t.status === 'Closed') counts.closed++;

      // Check SLA Overdue
      const deadline = new Date(t.slaDeadline);
      if (deadline < new Date() && t.status !== 'Resolved' && t.status !== 'Closed') {
        counts.overdue++;
      }

      byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
      byDepartment[t.department] = (byDepartment[t.department] || 0) + 1;

      if (t.resolvedAt && t.createdAt) {
        resolvedCount++;
        totalResolutionTime += (new Date(t.resolvedAt) - new Date(t.createdAt)) / 3600000;
      }
    });

    counts.avgResolutionTimeHours = resolvedCount > 0 ? parseFloat((totalResolutionTime / resolvedCount).toFixed(1)) : 0;
    setAnalytics({ counts, byPriority, byDepartment });
  };

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
      // Local mode
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      const nextId = localTickets.length + 1;
      const deptCode = targetDept === 'IT' ? 'IT' : targetDept === 'HR' ? 'HR' : targetDept === 'Finance' ? 'FIN' : targetDept.substring(0, 3).toUpperCase();
      const ticketId = `${deptCode}-${String(nextId).padStart(6, '0')}`;

      const newTicketObj = {
        id: nextId,
        ticketId,
        subject,
        description,
        department: targetDept,
        category,
        ticketType,
        priority,
        status: 'Open',
        createdBy: currentUser?.id || 1,
        createdByName: currentUser?.name || 'Local User',
        slaDeadline: slaDeadline.toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        comments: [],
        timeline: [{
          id: Date.now(),
          actorName: currentUser?.name || 'Local User',
          action: 'Created',
          detail: 'Ticket created locally',
          createdAt: new Date().toISOString()
        }],
        attachments: uploadedAttachments
      };

      const finalTickets = [newTicketObj, ...localTickets];
      localStorage.setItem('db_tickets', JSON.stringify(finalTickets));
      addToast("Ticket Created (Local)", `Ticket ${ticketId} created locally.`, "success");
      setShowCreateModal(false);
      setSubject('');
      setDescription('');
      setCategory('Software');
      setUploadedAttachments([]);
      loadTickets();
      setIsFiling(false);
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
  const handleAddComment = async (e) => {
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
      // Local
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      const tIdx = localTickets.findIndex(t => t.id === activeTicket.id);
      if (tIdx >= 0) {
        const ticket = localTickets[tIdx];
        if (!ticket.comments) ticket.comments = [];
        if (!ticket.timeline) ticket.timeline = [];
        
        ticket.comments.push({
          id: Date.now(),
          authorName: currentUser?.name || 'Local User',
          authorId: currentUser?.id || 1,
          commentText,
          isInternal: isInternalComment,
          createdAt: new Date().toISOString()
        });

        ticket.timeline.push({
          id: Date.now() + 1,
          actorName: currentUser?.name || 'Local User',
          action: 'Comment Added',
          detail: isInternalComment ? 'Added internal comment' : 'Added public comment',
          createdAt: new Date().toISOString()
        });

        ticket.updatedAt = new Date().toISOString();
        localTickets[tIdx] = ticket;
        localStorage.setItem('db_tickets', JSON.stringify(localTickets));
        setCommentText('');
        setActiveTicket(ticket);
        loadTickets();
      }
    }
  };

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
      // Local assignment
      const targetUser = usersList.find(u => u.id === assignToUserId);
      const name = targetUser ? targetUser.name : 'Unassigned';
      
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      const tIdx = localTickets.findIndex(t => t.id === activeTicket.id);
      if (tIdx >= 0) {
        const ticket = localTickets[tIdx];
        ticket.assignedTo = assignToUserId;
        ticket.assignedToName = name;
        ticket.status = 'In Progress';
        ticket.updatedAt = new Date().toISOString();
        ticket.timeline.push({
          id: Date.now(),
          actorName: currentUser?.name || 'Admin',
          action: 'Assigned',
          detail: `Assigned ticket to ${name}`,
          createdAt: new Date().toISOString()
        });

        localTickets[tIdx] = ticket;
        localStorage.setItem('db_tickets', JSON.stringify(localTickets));
        setActiveTicket(ticket);
        loadTickets();
        addToast("Ticket Assigned (Local)", `Assigned to ${name}`, "success");
      }
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
      // Local Workload Assignment
      let eligibleAgents = usersList.filter(u => u.role !== 'Employee' && u.department === activeTicket.department);
      if (eligibleAgents.length === 0) {
        eligibleAgents = usersList.filter(u => u.role !== 'Employee');
      }
      if (eligibleAgents.length === 0) {
        addToast("Auto Assignment Failed", "No eligible support agents found.", "error");
        return;
      }

      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      const workloads = {};
      eligibleAgents.forEach(a => {
        workloads[a.id] = localTickets.filter(t => t.assignedTo === a.id && ['Open', 'In Progress', 'Pending', 'On Hold', 'Reopened'].includes(t.status)).length;
      });

      eligibleAgents.sort((a, b) => workloads[a.id] - workloads[b.id]);
      const chosenAgent = eligibleAgents[0];
      const targetName = chosenAgent.name || chosenAgent.username;

      const tIdx = localTickets.findIndex(t => t.id === activeTicket.id);
      if (tIdx >= 0) {
        const ticket = localTickets[tIdx];
        ticket.assignedTo = chosenAgent.id;
        ticket.assignedToName = targetName;
        ticket.status = 'In Progress';
        ticket.timeline.push({
          id: Date.now(),
          actorName: currentUser?.name || 'System',
          action: 'Auto-Assigned',
          detail: `Auto-assigned to ${targetName} (Workload: ${workloads[chosenAgent.id]} active tickets)`,
          createdAt: new Date().toISOString()
        });

        localTickets[tIdx] = ticket;
        localStorage.setItem('db_tickets', JSON.stringify(localTickets));
        setActiveTicket(ticket);
        loadTickets();
        addToast("Auto Assigned (Local)", `Assigned to ${targetName} (${workloads[chosenAgent.id]} active)`, "success");
      }
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
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      const tIdx = localTickets.findIndex(t => t.id === activeTicket.id);
      if (tIdx >= 0) {
        const ticket = localTickets[tIdx];
        const prev = ticket.status;
        ticket.status = newStatus;
        ticket.updatedAt = new Date().toISOString();
        if (newStatus === 'Resolved') ticket.resolvedAt = new Date().toISOString();
        if (newStatus === 'Closed') ticket.closedAt = new Date().toISOString();
        
        ticket.timeline.push({
          id: Date.now(),
          actorName: currentUser?.name || 'Local User',
          action: 'Status Changed',
          detail: `Status changed from ${prev} to ${newStatus}`,
          createdAt: new Date().toISOString()
        });

        localTickets[tIdx] = ticket;
        localStorage.setItem('db_tickets', JSON.stringify(localTickets));
        setActiveTicket(ticket);
        loadTickets();
        addToast("Status Updated (Local)", `Status changed to ${newStatus}`, "success");
      }
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
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      const tIdx = localTickets.findIndex(t => t.id === activeTicket.id);
      if (tIdx >= 0) {
        const ticket = localTickets[tIdx];
        const prev = ticket.priority;
        ticket.priority = newPriority;
        ticket.updatedAt = new Date().toISOString();
        
        ticket.timeline.push({
          id: Date.now(),
          actorName: currentUser?.name || 'Local User',
          action: 'Priority Changed',
          detail: `Priority changed from ${prev} to ${newPriority}`,
          createdAt: new Date().toISOString()
        });

        localTickets[tIdx] = ticket;
        localStorage.setItem('db_tickets', JSON.stringify(localTickets));
        setActiveTicket(ticket);
        loadTickets();
        addToast("Priority Updated (Local)", `Priority updated to ${newPriority}`, "success");
      }
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
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      const tIdx = localTickets.findIndex(t => t.id === activeTicket.id);
      if (tIdx >= 0) {
        const ticket = localTickets[tIdx];
        const prev = ticket.category || 'Software';
        ticket.category = newCategory;
        ticket.updatedAt = new Date().toISOString();
        
        ticket.timeline.push({
          id: Date.now(),
          actorName: currentUser?.name || 'Local User',
          action: 'Category Changed',
          detail: `Category changed from ${prev} to ${newCategory}`,
          createdAt: new Date().toISOString()
        });

        localTickets[tIdx] = ticket;
        localStorage.setItem('db_tickets', JSON.stringify(localTickets));
        setActiveTicket(ticket);
        loadTickets();
        addToast("Category Updated (Local)", `Category updated to ${newCategory}`, "success");
      }
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
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      const tIdx = localTickets.findIndex(t => t.id === activeTicket.id);
      if (tIdx >= 0) {
        const ticket = localTickets[tIdx];
        const prev = ticket.department;
        ticket.department = newDept;
        ticket.updatedAt = new Date().toISOString();
        
        ticket.timeline.push({
          id: Date.now(),
          actorName: currentUser?.name || 'Local User',
          action: 'Department Changed',
          detail: `Queue department changed from ${prev} to ${newDept}`,
          createdAt: new Date().toISOString()
        });

        localTickets[tIdx] = ticket;
        localStorage.setItem('db_tickets', JSON.stringify(localTickets));
        setActiveTicket(ticket);
        loadTickets();
        addToast("Department Updated (Local)", `Queue reassigned to ${newDept}`, "success");
      }
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
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      const updated = localTickets.filter(t => !selectedTicketIds.includes(t.id));
      localStorage.setItem('db_tickets', JSON.stringify(updated));
      addToast("Bulk Deleted (Local)", `Deleted ${selectedTicketIds.length} tickets.`, "success");
      setSelectedTicketIds([]);
      loadTickets();
    }
  };

  const handleBulkStatus = async (status) => {
    if (!status) return;
    if (isApiConnected) {
      try {
        await api.bulkUpdateTicketsStatus(selectedTicketIds, status);
        addToast("Bulk Status Updated", `Updated ${selectedTicketIds.length} tickets to ${status}.`, "success");
        setBulkStatusVal('');
        setSelectedTicketIds([]);
        loadTickets();
      } catch (err) {
        addToast("Update Failed", err.message, "error");
      }
    } else {
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      selectedTicketIds.forEach(id => {
        const tIdx = localTickets.findIndex(t => t.id === id);
        if (tIdx >= 0) {
          const prev = localTickets[tIdx].status;
          localTickets[tIdx].status = status;
          localTickets[tIdx].updatedAt = new Date().toISOString();
          if (status === 'Resolved') localTickets[tIdx].resolvedAt = new Date().toISOString();
          if (status === 'Closed') localTickets[tIdx].closedAt = new Date().toISOString();
          localTickets[tIdx].timeline.push({
            id: Date.now() + Math.random(),
            actorName: currentUser?.name || 'Admin',
            action: 'Bulk Status Changed',
            detail: `Bulk status changed from ${prev} to ${status}`,
            createdAt: new Date().toISOString()
          });
        }
      });
      localStorage.setItem('db_tickets', JSON.stringify(localTickets));
      addToast("Bulk Status (Local)", `Updated status of ${selectedTicketIds.length} tickets.`, "success");
      setBulkStatusVal('');
      setSelectedTicketIds([]);
      loadTickets();
    }
  };

  const handleBulkPriority = async (priority) => {
    if (!priority) return;
    if (isApiConnected) {
      try {
        await api.bulkUpdateTicketsPriority(selectedTicketIds, priority);
        addToast("Bulk Priority Updated", `Updated ${selectedTicketIds.length} tickets to ${priority}.`, "success");
        setBulkPriorityVal('');
        setSelectedTicketIds([]);
        loadTickets();
      } catch (err) {
        addToast("Update Failed", err.message, "error");
      }
    } else {
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      selectedTicketIds.forEach(id => {
        const tIdx = localTickets.findIndex(t => t.id === id);
        if (tIdx >= 0) {
          const prev = localTickets[tIdx].priority;
          localTickets[tIdx].priority = priority;
          localTickets[tIdx].updatedAt = new Date().toISOString();
          localTickets[tIdx].timeline.push({
            id: Date.now() + Math.random(),
            actorName: currentUser?.name || 'Admin',
            action: 'Bulk Priority Changed',
            detail: `Bulk priority changed from ${prev} to ${priority}`,
            createdAt: new Date().toISOString()
          });
        }
      });
      localStorage.setItem('db_tickets', JSON.stringify(localTickets));
      addToast("Bulk Priority (Local)", `Updated priority of ${selectedTicketIds.length} tickets.`, "success");
      setBulkPriorityVal('');
      setSelectedTicketIds([]);
      loadTickets();
    }
  };

  const handleBulkCategory = async (cat) => {
    if (!cat) return;
    if (isApiConnected) {
      try {
        await api.bulkUpdateTicketsCategory(selectedTicketIds, cat);
        addToast("Bulk Category Updated", `Updated ${selectedTicketIds.length} tickets to ${cat}.`, "success");
        setBulkCategoryVal('');
        setSelectedTicketIds([]);
        loadTickets();
      } catch (err) {
        addToast("Update Failed", err.message, "error");
      }
    } else {
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      selectedTicketIds.forEach(id => {
        const tIdx = localTickets.findIndex(t => t.id === id);
        if (tIdx >= 0) {
          const prev = localTickets[tIdx].category || 'Software';
          localTickets[tIdx].category = cat;
          localTickets[tIdx].updatedAt = new Date().toISOString();
          localTickets[tIdx].timeline.push({
            id: Date.now() + Math.random(),
            actorName: currentUser?.name || 'Admin',
            action: 'Bulk Category Changed',
            detail: `Bulk category changed from ${prev} to ${cat}`,
            createdAt: new Date().toISOString()
          });
        }
      });
      localStorage.setItem('db_tickets', JSON.stringify(localTickets));
      addToast("Bulk Category (Local)", `Updated category of ${selectedTicketIds.length} tickets.`, "success");
      setBulkCategoryVal('');
      setSelectedTicketIds([]);
      loadTickets();
    }
  };

  const handleBulkDepartment = async (dept) => {
    if (!dept) return;
    if (isApiConnected) {
      try {
        await api.bulkUpdateTicketsDepartment(selectedTicketIds, dept);
        addToast("Bulk Department Updated", `Reassigned ${selectedTicketIds.length} tickets to ${dept} department.`, "success");
        setBulkDeptVal('');
        setSelectedTicketIds([]);
        loadTickets();
      } catch (err) {
        addToast("Reassignment Failed", err.message, "error");
      }
    } else {
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      selectedTicketIds.forEach(id => {
        const tIdx = localTickets.findIndex(t => t.id === id);
        if (tIdx >= 0) {
          const prev = localTickets[tIdx].department;
          localTickets[tIdx].department = dept;
          localTickets[tIdx].updatedAt = new Date().toISOString();
          localTickets[tIdx].timeline.push({
            id: Date.now() + Math.random(),
            actorName: currentUser?.name || 'Admin',
            action: 'Bulk Department Changed',
            detail: `Bulk department reassigned from ${prev} to ${dept}`,
            createdAt: new Date().toISOString()
          });
        }
      });
      localStorage.setItem('db_tickets', JSON.stringify(localTickets));
      addToast("Bulk Department (Local)", `Updated department of ${selectedTicketIds.length} tickets.`, "success");
      setBulkDeptVal('');
      setSelectedTicketIds([]);
      loadTickets();
    }
  };

  const handleBulkAssign = async (agentId) => {
    if (!agentId) return;
    const targetUser = usersList.find(u => u.id === parseInt(agentId));
    const name = targetUser ? (targetUser.name || targetUser.username) : 'Unassigned';

    if (isApiConnected) {
      try {
        await api.bulkAssignTickets(selectedTicketIds, agentId);
        addToast("Bulk Assigned", `Assigned ${selectedTicketIds.length} tickets to ${name}.`, "success");
        setBulkAssignVal('');
        setSelectedTicketIds([]);
        loadTickets();
      } catch (err) {
        addToast("Assignment Failed", err.message, "error");
      }
    } else {
      const localTickets = JSON.parse(localStorage.getItem('db_tickets') || '[]');
      selectedTicketIds.forEach(id => {
        const tIdx = localTickets.findIndex(t => t.id === id);
        if (tIdx >= 0) {
          localTickets[tIdx].assignedTo = parseInt(agentId);
          localTickets[tIdx].assignedToName = name;
          localTickets[tIdx].status = 'In Progress';
          localTickets[tIdx].updatedAt = new Date().toISOString();
          localTickets[tIdx].timeline.push({
            id: Date.now() + Math.random(),
            actorName: currentUser?.name || 'Admin',
            action: 'Bulk Assigned',
            detail: `Bulk assigned ticket to ${name}`,
            createdAt: new Date().toISOString()
          });
        }
      });
      localStorage.setItem('db_tickets', JSON.stringify(localTickets));
      addToast("Bulk Assigned (Local)", `Assigned ${selectedTicketIds.length} tickets to ${name}.`, "success");
      setBulkAssignVal('');
      setSelectedTicketIds([]);
      loadTickets();
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

    const deadline = new Date(deadlineStr);
    const diff = deadline - Date.now();

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
  const distinctDepartments = ['IT', 'HR', 'Finance', 'Operations'];

  return (
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
                <div style={{ position: 'relative', flex: 1 }}>
                  <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                  <input
                    type="text"
                    placeholder="Search tickets by ID, subject, desc, requester or assignee..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="form-input"
                    style={{ paddingLeft: '38px', width: '100%' }}
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
                  <select className="form-input" style={{ padding: '6px 10px', fontSize: '12px' }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                    <option value="">Status: All</option>
                    {['Open', 'In Progress', 'Pending', 'On Hold', 'Resolved', 'Closed', 'Reopened'].map(st => (
                      <option key={st} value={st}>{st}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <select className="form-input" style={{ padding: '6px 10px', fontSize: '12px' }} value={filterPriority} onChange={e => setFilterPriority(e.target.value)}>
                    <option value="">Priority: All</option>
                    {['Critical', 'Medium', 'Low'].map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <select className="form-input" style={{ padding: '6px 10px', fontSize: '12px' }} value={filterDepartment} onChange={e => setFilterDepartment(e.target.value)}>
                    <option value="">Department: All</option>
                    {distinctDepartments.map(d => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <select className="form-input" style={{ padding: '6px 10px', fontSize: '12px' }} value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
                    <option value="">Category: All</option>
                    {distinctCategories.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <select className="form-input" style={{ padding: '6px 10px', fontSize: '12px' }} value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)}>
                    <option value="">Assignee: All</option>
                    {usersList.filter(u => u.role !== 'Employee').map(u => (
                      <option key={u.id} value={u.id}>{u.name || u.username}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <select className="form-input" style={{ padding: '6px 10px', fontSize: '12px' }} value={filterRequester} onChange={e => setFilterRequester(e.target.value)}>
                    <option value="">Requester: All</option>
                    {distinctRequesters.map(req => (
                      <option key={req} value={req}>{req}</option>
                    ))}
                  </select>
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
                        <button 
                          onClick={handleSelectAllPage}
                          style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', margin: 'auto' }}
                        >
                          {isAllPageSelected ? <CheckSquare size={16} className="text-primary" /> : <Square size={16} />}
                        </button>
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
                              <button 
                                onClick={() => handleRowCheckbox(t.id)}
                                style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', margin: 'auto' }}
                              >
                                {isSelected ? <CheckSquare size={16} className="text-primary" /> : <Square size={16} />}
                              </button>
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
            <div style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-sidebar)', borderBottomLeftRadius: 'var(--radius-lg)', borderBottomRightRadius: 'var(--radius-lg)' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Showing {totalItems > 0 ? startIndex + 1 : 0} to {Math.min(startIndex + pageSize, totalItems)} of {totalItems} tickets
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  className="btn btn-secondary"
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage(prev => prev - 1)}
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
                  className="btn btn-secondary"
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage(prev => prev + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>

          {/* Floating Bulk Action Toolbar */}
          <AnimatePresence>
            {selectedTicketIds.length > 0 && (
              <motion.div
                initial={{ y: 100, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 100, opacity: 0 }}
                className="floating-bulk-bar"
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderRight: '1px solid var(--border-color)', paddingRight: '16px' }}>
                  <Layers size={18} style={{ color: 'var(--primary)' }} />
                  <span style={{ fontWeight: 600, fontSize: '14px', whiteSpace: 'nowrap' }}>
                    {selectedTicketIds.length} selected
                  </span>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                  {/* Status update */}
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <select
                      className="form-input"
                      style={{ padding: '4px 8px', fontSize: '12px', width: '130px' }}
                      value={bulkStatusVal}
                      onChange={e => setBulkStatusVal(e.target.value)}
                    >
                      <option value="">Update Status</option>
                      {['Open', 'In Progress', 'Pending', 'On Hold', 'Resolved', 'Closed', 'Reopened'].map(st => (
                        <option key={st} value={st}>{st}</option>
                      ))}
                    </select>
                    <button className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }} onClick={() => handleBulkStatus(bulkStatusVal)}>Go</button>
                  </div>

                  {/* Priority update */}
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <select
                      className="form-input"
                      style={{ padding: '4px 8px', fontSize: '12px', width: '130px' }}
                      value={bulkPriorityVal}
                      onChange={e => setBulkPriorityVal(e.target.value)}
                    >
                      <option value="">Update Priority</option>
                      {['Critical', 'Medium', 'Low'].map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                    <button className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }} onClick={() => handleBulkPriority(bulkPriorityVal)}>Go</button>
                  </div>

                  {/* Category update */}
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <select
                      className="form-input"
                      style={{ padding: '4px 8px', fontSize: '12px', width: '130px' }}
                      value={bulkCategoryVal}
                      onChange={e => setBulkCategoryVal(e.target.value)}
                    >
                      <option value="">Update Category</option>
                      {distinctCategories.map(c => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <button className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }} onClick={() => handleBulkCategory(bulkCategoryVal)}>Go</button>
                  </div>

                  {/* Department reassignment (Admin only) */}
                  {currentRole === 'Super Admin' && (
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <select
                        className="form-input"
                        style={{ padding: '4px 8px', fontSize: '12px', width: '130px' }}
                        value={bulkDeptVal}
                        onChange={e => setBulkDeptVal(e.target.value)}
                      >
                        <option value="">Reassign Dept</option>
                        {distinctDepartments.map(d => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                      <button className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }} onClick={() => handleBulkDepartment(bulkDeptVal)}>Go</button>
                    </div>
                  )}

                  {/* Assign custodian */}
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <select
                      className="form-input"
                      style={{ padding: '4px 8px', fontSize: '12px', width: '140px' }}
                      value={bulkAssignVal}
                      onChange={e => setBulkAssignVal(e.target.value)}
                    >
                      <option value="">Assign Desk Agent</option>
                      {usersList.filter(u => u.role !== 'Employee').map(u => (
                        <option key={u.id} value={u.id}>{u.name || u.username}</option>
                      ))}
                    </select>
                    <button className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '12px' }} onClick={() => handleBulkAssign(bulkAssignVal)}>Go</button>
                  </div>

                  {/* Bulk delete */}
                  <button className="btn btn-danger" style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }} onClick={handleBulkDelete}>
                    <Trash2 size={13} />
                    Delete
                  </button>
                </div>

                <button 
                  onClick={() => setSelectedTicketIds([])}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    marginLeft: '8px',
                    cursor: 'pointer'
                  }}
                  title="Deselect All"
                >
                  <X size={16} />
                </button>
              </motion.div>
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
                      <span>Created: <strong>{activeTicket.createdAt ? new Date(activeTicket.createdAt).toLocaleString('en-IN') : '—'}</strong></span>
                      <span>Last Updated: <strong>{activeTicket.updatedAt ? new Date(activeTicket.updatedAt).toLocaleString('en-IN') : '—'}</strong></span>
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
                        <div className="timeline-time">{new Date(itm.createdAt).toLocaleString('en-IN')}</div>
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
                            <span>{new Date(c.createdAt).toLocaleString('en-IN')}</span>
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
                    <button type="submit" className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Send size={14} />
                      Submit Update
                    </button>
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
                    <select
                      className="form-input"
                      value={activeTicket.status}
                      disabled={currentRole === 'Employee'}
                      onChange={e => handleUpdateStatus(e.target.value)}
                    >
                      {['Open', 'In Progress', 'Pending', 'On Hold', 'Resolved', 'Closed', 'Reopened'].map(st => (
                        <option key={st} value={st}>{st}</option>
                      ))}
                    </select>
                  </div>

                  {/* Priority Dropdown */}
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: '11px' }}>Priority</label>
                    <select
                      className="form-input"
                      value={activeTicket.priority}
                      disabled={currentRole === 'Employee'}
                      onChange={e => handleUpdatePriority(e.target.value)}
                    >
                      {['Critical', 'Medium', 'Low'].map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>

                  {/* Category Dropdown */}
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: '11px' }}>Category</label>
                    <select
                      className="form-input"
                      value={activeTicket.category || 'Software'}
                      disabled={currentRole === 'Employee'}
                      onChange={e => handleUpdateCategory(e.target.value)}
                    >
                      {distinctCategories.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                  </div>

                  {/* Department (Super Admin only) */}
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: '11px' }}>Department Queue</label>
                    {currentRole === 'Super Admin' ? (
                      <select
                        className="form-input"
                        value={activeTicket.department}
                        onChange={e => handleUpdateDepartment(e.target.value)}
                      >
                        {distinctDepartments.map(d => (
                          <option key={d} value={d}>{d} Queue</option>
                        ))}
                      </select>
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
                      <select 
                        className="form-input" 
                        value={activeTicket.assignedTo || ''} 
                        onChange={e => handleAssignTicket(e.target.value ? parseInt(e.target.value) : '')}
                        style={{ marginBottom: '8px' }}
                      >
                        <option value="">-- Choose Agent --</option>
                        {usersList.filter(u => u.role !== 'Employee').map(u => (
                          <option key={u.id} value={u.id}>{u.name || u.username} ({u.role})</option>
                        ))}
                      </select>
                      
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ width: '100%', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                        onClick={handleAutoAssignTicket}
                      >
                        <Users size={14} />
                        Auto-Assign (Workload)
                      </button>
                    </div>
                  )}
                </div>
              </div>

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
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: '500px' }}>
            <div className="modal-header">
              <h3 className="modal-title">File Help Desk Ticket</h3>
              <button className="modal-close-btn" onClick={() => { setShowCreateModal(false); setUploadedAttachments([]); }} disabled={isFiling}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleCreateTicket}>
              <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                
                {/* Unified helpdesk: the requester chooses the queue. Previously this was
                    auto-routed from their own profile, so an HR employee's IT problem
                    was filed to the HR queue. */}
                <div className="form-group">
                  <label className="form-label">Service Queue Department *</label>
                  <select className="form-input" value={ticketDepartment} onChange={e => setTicketDepartment(e.target.value)} required disabled={isFiling}>
                    {HELPDESK_DEPARTMENTS.map(d => (
                      <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                  </select>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    <Building size={11} style={{ verticalAlign: '-1px' }} /> Routed to the {HELPDESK_DEPARTMENTS.find(d => d.value === ticketDepartment)?.label} team.
                  </span>
                </div>

                <div className="form-group">
                  <label className="form-label">Ticket Type *</label>
                  <select className="form-input" value={ticketType} onChange={e => setTicketType(e.target.value)} required disabled={isFiling}>
                    {TICKET_TYPES.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Category *</label>
                  <select className="form-input" value={category} onChange={e => setCategory(e.target.value)} required>
                    {distinctCategories.map(cat => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Priority Impact Level *</label>
                  <select className="form-input" value={priority} onChange={e => setPriority(e.target.value)} required>
                    <option value="Critical">Level 1 (Critical) - 10h SLA Resolution</option>
                    <option value="Medium">Level 2 (Medium) - 24h SLA Resolution</option>
                    <option value="Low">Level 3 (Low) - 48h SLA Resolution</option>
                  </select>
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

              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => { setShowCreateModal(false); setUploadedAttachments([]); }} disabled={isFiling}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={isFiling} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {isFiling ? (
                    <>
                      <RefreshCw size={14} className="animate-spin" />
                      Filing Ticket...
                    </>
                  ) : 'File Ticket'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Article preview, opened from the suggestions panel. Rendered above the create
          modal so the half-filled form is preserved behind it. */}
      {kbArticlePreview && (
        <div className="modal-overlay" style={{ zIndex: 600 }} onClick={() => setKbArticlePreview(null)}>
          <div className="modal-content" style={{ maxWidth: '760px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ minWidth: 0 }}>
                <h3 className="modal-title">{kbArticlePreview.title}</h3>
                {kbArticlePreview.summary && (
                  <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>{kbArticlePreview.summary}</span>
                )}
              </div>
              <button className="modal-close-btn" onClick={() => setKbArticlePreview(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
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
            </div>
            <div className="modal-footer">
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TicketsPage;
