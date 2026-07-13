import { useState, useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import Modal from '../../Modal'
import CustomSelect from '../../CustomSelect'
import FloatingBulkBar from '../../FloatingBulkBar'
import { SpinnerButton } from '../../SpinnerButton'
import { api } from '../../api'
import { ROLE_OPTIONS } from '../../permissions'
import { validateAndFormatPhone } from '../../utils/format'
import { Search, Edit2, Trash2, ChevronLeft, ChevronRight, Layers, RefreshCw, Check, KeyRound, Download } from 'lucide-react'

const UserDirectoryPage = ({ usersList, setUsersList, isApiConnected, onBulkImportClick, addToast, onUsersDeleted, departments = [], canManage = false }) => {
  const [formPassword, setFormPassword] = useState('');
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formRole, setFormRole] = useState('Employee');
  const [formEmployeeId, setFormEmployeeId] = useState('');
  const [formPhoneNumber, setFormPhoneNumber] = useState('');
  const [formDepartment, setFormDepartment] = useState('IT');
  const [formDesignation, setFormDesignation] = useState('');
  const [formStatus, setFormStatus] = useState('Active');

  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showRegisterModal, setShowRegisterModal] = useState(false);

  // Close register modal on Escape press
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && showRegisterModal && !isSubmitting) {
        setShowRegisterModal(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showRegisterModal, isSubmitting]);

  // Pagination & Filters State
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(10);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterRole, setFilterRole] = useState('All');
  const [filterStatus, setFilterStatus] = useState('All');

  // Multi-select State
  const [selectedUserIds, setSelectedUserIds] = useState([]);

  // Edit User Modal State
  const [editingUser, setEditingUser] = useState(null);
  const [editFormName, setEditFormName] = useState('');
  const [editFormEmail, setEditFormEmail] = useState('');
  const [editFormPhoneNumber, setEditFormPhoneNumber] = useState('');
  const [editFormDepartment, setEditFormDepartment] = useState('IT');
  const [editFormDesignation, setEditFormDesignation] = useState('');
  const [editFormRole, setEditFormRole] = useState('Employee');
  const [editFormStatus, setEditFormStatus] = useState('Active');
  const [editFormPassword, setEditFormPassword] = useState('');
  const [editError, setEditError] = useState('');
  const [editSuccess, setEditSuccess] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);

  // Bulk edit — staged field values (nothing is committed until Apply Changes), matching
  // the Support Tickets bulk bar. Empty means "leave unchanged".
  const [bulkStatusVal, setBulkStatusVal] = useState('');
  const [bulkDeptValue, setBulkDeptValue] = useState('');
  const [bulkRoleValue, setBulkRoleValue] = useState('');
  const [isApplyingBulk, setIsApplyingBulk] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null);

  // Reset page & selections on filter changes
  useEffect(() => {
    setSelectedUserIds([]);
    setCurrentPage(1);
  }, [searchTerm, filterRole, filterStatus]);

  const handleCreateUser = async (e) => {
    e.preventDefault();
    setFormError('');
    setFormSuccess('');
    if (!formName.trim() || !formEmail.trim()) {
      setFormError('Name and email are required.');
      return;
    }

    // Phone format validation
    let formattedPhone = '';
    if (formPhoneNumber.trim()) {
      const phoneValidation = validateAndFormatPhone(formPhoneNumber);
      if (!phoneValidation.isValid) {
        setFormError(phoneValidation.error);
        return;
      }
      formattedPhone = phoneValidation.value;
    }

    // Uniqueness validation on Employee ID (case-insensitive)
    if (formEmployeeId.trim()) {
      const empIdExists = usersList.some(u => String(u.employeeId || '').toLowerCase() === formEmployeeId.trim().toLowerCase());
      if (empIdExists) {
        setFormError(`Employee ID '${formEmployeeId.trim()}' already exists. Please use a unique Employee ID.`);
        return;
      }
    }

    // Uniqueness validation on Email (case-insensitive)
    if (formEmail.trim()) {
      const emailExists = usersList.some(u => String(u.email || '').toLowerCase() === formEmail.trim().toLowerCase());
      if (emailExists) {
        setFormError(`Email '${formEmail.trim()}' already exists. Please use a unique Email.`);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const newUserPayload = {
        name: formName.trim(),
        email: formEmail.trim(),
        role: formRole,
        employeeId: formEmployeeId.trim(),
        phoneNumber: formattedPhone,
        department: formDepartment,
        designation: formDesignation.trim(),
        status: formStatus
      };

      // Database-only: creation must go through the API. There is no local fallback.
      const created = await api.createUser(newUserPayload);
      setUsersList(prev => [created, ...prev]);

      setFormSuccess(`User "${formName.trim()}" created successfully!`);
      if (addToast) {
        addToast("User Registered", `User "${formName.trim()}" created successfully!`, "success");
      }
      setShowRegisterModal(false);
      setFormPassword('');
      setFormName('');
      setFormEmail('');
      setFormEmployeeId('');
      setFormPhoneNumber('');
      setFormDesignation('');
      setFormRole('Employee');
      setFormDepartment('IT');
      setFormStatus('Active');
    } catch (err) {
      console.error('Error in handleCreateUser:', err);
      setFormError(err.message || 'Failed to create user.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditUserClick = (u) => {
    setEditingUser(u);
    setEditFormName(u.name || '');
    setEditFormEmail(u.email || '');
    setEditFormPhoneNumber(u.phoneNumber || '');
    setEditFormDepartment(u.department || 'IT');
    setEditFormDesignation(u.designation || '');
    setEditFormRole(u.role || 'Employee');
    setEditFormStatus(u.status || 'Active');
    setEditFormPassword('');
    setEditError('');
    setEditSuccess('');
  };

  const handleEditUserSubmit = async (e) => {
    e.preventDefault();
    setEditError('');
    setEditSuccess('');

    let formattedPhone = '';
    if (editFormPhoneNumber.trim()) {
      const phoneValidation = validateAndFormatPhone(editFormPhoneNumber);
      if (!phoneValidation.isValid) {
        setEditError(phoneValidation.error);
        return;
      }
      formattedPhone = phoneValidation.value;
    }

    if (editFormEmail.trim()) {
      const emailExists = usersList.some(u => u.id !== editingUser.id && String(u.email || '').toLowerCase() === editFormEmail.trim().toLowerCase());
      if (emailExists) {
        setEditError('Email address is already registered by another user.');
        return;
      }
    }

    setIsUpdating(true);
    try {
      const updatedFields = {
        name: editFormName.trim(),
        email: editFormEmail.trim(),
        phoneNumber: formattedPhone,
        department: editFormDepartment,
        designation: editFormDesignation.trim(),
        role: editFormRole,
        status: editFormStatus
      };
      if (editFormPassword.trim()) {
        updatedFields.password = editFormPassword.trim();
      }

      const updated = await api.updateUser(editingUser.id, updatedFields);
      setUsersList(prev => prev.map(u => u.id === editingUser.id ? updated : u));

      setEditSuccess('User details updated successfully!');
      setTimeout(() => {
        setEditingUser(null);
      }, 800);
    } catch (err) {
      console.error('Error in handleEditUserSubmit:', err);
      setEditError(err.message || 'Failed to update user details.');
    } finally {
      setIsUpdating(false);
    }
  };

  const editUserFooter = (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => setEditingUser(null)} disabled={isUpdating}>Cancel</button>
      <SpinnerButton type="submit" className="btn btn-primary" loading={isUpdating} loadingText="Saving…">Save Changes</SpinnerButton>
    </>
  );

  const handleDeleteUser = async (u) => {
    if (!window.confirm(`Are you sure you want to permanently delete user "${u.name || u.email}"?`)) return;
    try {
      if (isApiConnected) {
        await api.deleteUser(u.id);
      }
      setUsersList(prev => prev.filter(x => x.id !== u.id));
      // Deleting the user cascades its assignments away in the database; pull the
      // registry back down so the UI matches. `setAssignments` was called directly
      // here but is not in this component's scope — it threw a ReferenceError after
      // the delete had already succeeded, leaving the stale rows on screen.
      await onUsersDeleted?.([u]);
      if (editingUser?.id === u.id) setEditingUser(null);
    } catch (err) {
      alert(err.message || 'Failed to delete user.');
    }
  };

  // Bulk Actions
  const handleSelectUser = (id) => {
    setSelectedUserIds(prev => 
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleSelectAllPage = (visibleUserIds) => {
    const allSelected = visibleUserIds.every(id => selectedUserIds.includes(id));
    if (allSelected) {
      setSelectedUserIds(prev => prev.filter(id => !visibleUserIds.includes(id)));
    } else {
      setSelectedUserIds(prev => {
        const added = visibleUserIds.filter(id => !prev.includes(id));
        return [...prev, ...added];
      });
    }
  };

  const handleBulkDelete = async () => {
    if (!window.confirm(`Are you sure you want to delete the ${selectedUserIds.length} selected users?`)) return;
    try {
      if (isApiConnected) {
        await api.bulkDeleteUsers(selectedUserIds);
      }
      const deletedUsers = usersList.filter(u => selectedUserIds.includes(u.id));
      setUsersList(prev => prev.filter(u => !selectedUserIds.includes(u.id)));
      await onUsersDeleted?.(deletedUsers);
      addToast?.('Users deleted', `Deleted ${deletedUsers.length} user${deletedUsers.length === 1 ? '' : 's'}.`, 'success');
      setSelectedUserIds([]);
    } catch (err) {
      addToast?.('Deletion failed', err.message || 'Bulk deletion failed.', 'error');
    }
  };

  const handleBulkResetPassword = async () => {
    if (!window.confirm(`Reset password to "Welcome@123" for ${selectedUserIds.length} selected users?`)) return;
    try {
      if (isApiConnected) {
        await api.bulkResetUsersPassword(selectedUserIds);
      }
      addToast?.('Passwords reset', 'Password reset to "Welcome@123" for the selected users.', 'success');
      setSelectedUserIds([]);
    } catch (err) {
      addToast?.('Reset failed', err.message || 'Bulk password reset failed.', 'error');
    }
  };

  /**
   * Everything the user has staged, in the order it will be applied. Mirrors the Support
   * Tickets bulk bar: each field's change carries the API call (`run`) and the matching
   * local-state update (`apply`), so nothing is committed until Apply Changes is pressed.
   */
  const getPendingBulkChanges = () => {
    const changes = [];
    if (bulkStatusVal) {
      changes.push({
        field: 'Status',
        value: bulkStatusVal === 'Active' ? 'Activate' : 'Deactivate',
        run: () => api.bulkUpdateUsersStatus(selectedUserIds, bulkStatusVal),
        apply: () => setUsersList(prev => prev.map(u => selectedUserIds.includes(u.id) ? { ...u, status: bulkStatusVal } : u)),
      });
    }
    if (bulkDeptValue) {
      changes.push({
        field: 'Department',
        value: bulkDeptValue,
        run: () => api.bulkUpdateUsersDepartment(selectedUserIds, bulkDeptValue),
        apply: () => setUsersList(prev => prev.map(u => selectedUserIds.includes(u.id) ? { ...u, department: bulkDeptValue } : u)),
      });
    }
    if (bulkRoleValue) {
      changes.push({
        field: 'Role',
        value: bulkRoleValue,
        run: () => api.bulkUpdateUsersRole(selectedUserIds, bulkRoleValue),
        apply: () => setUsersList(prev => prev.map(u => selectedUserIds.includes(u.id) ? { ...u, role: bulkRoleValue } : u)),
      });
    }
    return changes;
  };

  const clearBulkFields = () => {
    setBulkStatusVal('');
    setBulkDeptValue('');
    setBulkRoleValue('');
  };

  /**
   * Applies every staged change to the selection in one workflow. Sequential so the
   * progress readout is meaningful; a partial failure keeps the selection and the staged
   * values so the user can see what did not land and retry it.
   */
  const handleApplyBulkChanges = async () => {
    const changes = getPendingBulkChanges();
    if (changes.length === 0 || isApplyingBulk) return;

    setIsApplyingBulk(true);
    const failures = [];
    try {
      for (let i = 0; i < changes.length; i += 1) {
        const change = changes[i];
        setBulkProgress({ done: i, total: changes.length, field: change.field });
        try {
          if (isApiConnected) await change.run();
          change.apply();
        } catch (err) {
          failures.push(`${change.field}: ${err.message}`);
        }
      }

      const applied = changes.length - failures.length;
      const userCount = selectedUserIds.length;
      if (failures.length === 0) {
        addToast?.('Changes applied', `${applied} change${applied === 1 ? '' : 's'} applied to ${userCount} user${userCount === 1 ? '' : 's'}.`, 'success');
        clearBulkFields();
        setSelectedUserIds([]);
      } else if (applied > 0) {
        addToast?.('Partially applied', `${applied} of ${changes.length} applied. Failed — ${failures.join('; ')}`, 'error');
      } else {
        addToast?.('Nothing applied', failures.join('; '), 'error');
      }
    } finally {
      setIsApplyingBulk(false);
      setBulkProgress(null);
    }
  };

  const handleExportSelected = () => {
    const selectedUsers = usersList.filter(u => selectedUserIds.includes(u.id));
    let csv = "Employee ID,Full Name,Email,Phone Number,Department,Designation,Role,Status,Created At\n";
    selectedUsers.forEach(u => {
      csv += `"${u.employeeId || ''}","${u.name || ''}","${u.email || ''}","${u.phoneNumber || ''}","${u.department || ''}","${u.designation || ''}","${u.role || ''}","${u.status || ''}","${u.created_at || ''}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.setAttribute("download", `exported_employees_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Filters logic
  const filteredUsers = usersList.filter(u => {
    const term = searchTerm.toLowerCase();
    const matchSearch = !searchTerm || 
      (u.name || '').toLowerCase().includes(term) ||
      (u.email || '').toLowerCase().includes(term) ||
      (u.phoneNumber || '').toLowerCase().includes(term) ||
      (u.employeeId || '').toLowerCase().includes(term) ||
      (u.department || '').toLowerCase().includes(term) ||
      (u.designation || '').toLowerCase().includes(term);

    const matchRole = filterRole === 'All' || u.role === filterRole;
    const matchStatus = filterStatus === 'All' || u.status === filterStatus;

    return matchSearch && matchRole && matchStatus;
  });

  const totalPages = Math.ceil(filteredUsers.length / pageSize) || 1;

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [filteredUsers.length, totalPages, currentPage]);

  const startIndex = (currentPage - 1) * pageSize;
  const visibleUsers = filteredUsers.slice(startIndex, startIndex + pageSize);
  const visibleUserIds = visibleUsers.map(u => u.id);
  const pendingBulkChanges = getPendingBulkChanges();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%' }}>
      {/* ---- User table & actions ---- */}
      <div style={{ width: '100%' }}>
        <div className="page-header" style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="page-title-section">
            <h2 className="page-title">User Management</h2>
            <p className="page-subtitle">
              {filteredUsers.length} registered account{filteredUsers.length !== 1 ? 's' : ''} shown
            </p>
          </div>
          {canManage && (
            <div className="action-row" style={{ gap: '10px' }}>
              <button className="btn btn-primary" onClick={() => { setShowRegisterModal(true); setFormError(''); setFormSuccess(''); }} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                👤 Register New User
              </button>
              <button className="btn btn-secondary" onClick={onBulkImportClick} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                👥 Bulk Import Employees
              </button>
            </div>
          )}
        </div>

        {/* Search & Filters Toolbar */}
        <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Search Input - Prominent */}
            <div className="search-field" style={{ flexGrow: 1, minWidth: 'min(280px, 100%)' }}>
              <Search size={16} className="search-field-icon" />
              <input
                type="text"
                placeholder="Search employees by ID, name, email, phone, designation…"
                className="form-input"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}

              />
            </div>

            {/* Filter Controls */}
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ width: '160px' }}>
                <CustomSelect
                  options={[{ value: 'All', label: '🔑 Role: All' }, ...ROLE_OPTIONS]}
                  value={filterRole}
                  onChange={e => setFilterRole(e.target.value)}
                  placeholder="Role"
                />
              </div>
              <div style={{ width: '150px' }}>
                <CustomSelect
                  options={['All', 'Active', 'Inactive', 'Deactivated'].map(s => ({ value: s, label: s === 'All' ? '📊 Status: All' : s }))}
                  value={filterStatus}
                  onChange={e => setFilterStatus(e.target.value)}
                  placeholder="Status"
                />
              </div>
              {/* Active Filter Badges + Clear */}
              {(searchTerm || filterRole !== 'All' || filterStatus !== 'All') && (
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ width: '1px', height: '24px', background: 'var(--border-color)', margin: '0 4px' }} />
                  {searchTerm && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 10px', borderRadius: '99px', background: 'rgba(99, 44, 237, 0.1)', color: 'var(--primary)', fontSize: '11px', fontWeight: '600' }}>
                      "{searchTerm.length > 15 ? searchTerm.slice(0, 15) + '…' : searchTerm}"
                      <button onClick={() => setSearchTerm('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', padding: '0 2px', fontSize: '14px', lineHeight: 1 }}>×</button>
                    </span>
                  )}
                  {filterRole !== 'All' && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 10px', borderRadius: '99px', background: 'rgba(99, 44, 237, 0.1)', color: 'var(--primary)', fontSize: '11px', fontWeight: '600' }}>
                      {filterRole}
                      <button onClick={() => setFilterRole('All')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', padding: '0 2px', fontSize: '14px', lineHeight: 1 }}>×</button>
                    </span>
                  )}
                  {filterStatus !== 'All' && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 10px', borderRadius: '99px', background: 'rgba(99, 44, 237, 0.1)', color: 'var(--primary)', fontSize: '11px', fontWeight: '600' }}>
                      {filterStatus}
                      <button onClick={() => setFilterStatus('All')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', padding: '0 2px', fontSize: '14px', lineHeight: 1 }}>×</button>
                    </span>
                  )}
                  <button 
                    onClick={() => { setSearchTerm(''); setFilterRole('All'); setFilterStatus('All'); }}
                    className="btn btn-secondary btn-sm" 
                    style={{ fontWeight: '600', borderRadius: '99px', display: 'flex', alignItems: 'center', gap: '4px'}}
                  >
                    ✕ Clear All
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Floating Bulk Action Toolbar — same interaction model as Support Tickets:
            stage Status / Department / Role, review, then commit with one Apply Changes. */}
        <AnimatePresence>
          {selectedUserIds.length > 0 && (
            <FloatingBulkBar
              onClear={() => { clearBulkFields(); setSelectedUserIds([]); }}
              summary={
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderRight: '1px solid var(--border-color)', paddingRight: '16px' }}>
                  <Layers size={18} style={{ color: 'var(--primary)' }} />
                  <span style={{ fontWeight: 600, fontSize: '14px', whiteSpace: 'nowrap' }}>
                    {selectedUserIds.length} selected
                  </span>
                </div>
              }
              actions={
                <>
                  {canManage && (
                    <div className="action-row">
                      <CustomSelect className="form-input-sm" style={{ width: '140px' }}
                        value={bulkStatusVal} onChange={e => setBulkStatusVal(e.target.value)} disabled={isApplyingBulk}
                        placeholder="Status…"
                        options={[{ value: '', label: 'Status…' }, { value: 'Active', label: 'Activate' }, { value: 'Inactive', label: 'Deactivate' }]} />

                      <CustomSelect className="form-input-sm" style={{ width: '150px' }} searchable
                        value={bulkDeptValue} onChange={e => setBulkDeptValue(e.target.value)} disabled={isApplyingBulk}
                        placeholder="Department…"
                        options={[{ value: '', label: 'Department…' }, ...departments.map(d => ({ value: d, label: d }))]} />

                      <CustomSelect className="form-input-sm" style={{ width: '150px' }}
                        value={bulkRoleValue} onChange={e => setBulkRoleValue(e.target.value)} disabled={isApplyingBulk}
                        placeholder="Role…"
                        options={[{ value: '', label: 'Role…' }, ...ROLE_OPTIONS]} />
                    </div>
                  )}

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

                  {canManage && (
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
                  )}

                  {canManage && (
                    <button className="btn btn-secondary btn-sm" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                      onClick={handleBulkResetPassword} disabled={isApplyingBulk}>
                      <KeyRound size={13} /> Reset Password
                    </button>
                  )}

                  <button className="btn btn-secondary btn-sm" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                    onClick={handleExportSelected} disabled={isApplyingBulk}>
                    <Download size={13} /> Export CSV
                  </button>

                  {canManage && (
                    <button className="btn btn-danger btn-sm" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                      onClick={handleBulkDelete} disabled={isApplyingBulk}>
                      <Trash2 size={13} /> Delete
                    </button>
                  )}
                </>
              }
            />
          )}
        </AnimatePresence>

        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '40px', textAlign: 'center' }}>
                  <input 
                    type="checkbox" 
                    checked={visibleUserIds.length > 0 && visibleUserIds.every(id => selectedUserIds.includes(id))}
                    onChange={() => handleSelectAllPage(visibleUserIds)}
                  />
                </th>
                <th>Employee ID</th>
                <th>Full Name</th>
                <th>Email</th>
                <th>Phone Number</th>
                <th>Dept / Design.</th>
                <th>Role</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((u, idx) => (
                <tr key={u.id || u.email || idx} style={{ cursor: canManage ? 'pointer' : 'default' }} onClick={(e) => {
                  if (canManage && e.target.type !== 'checkbox' && !e.target.closest('button')) {
                    handleEditUserClick(u);
                  }
                }}>
                  <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                    <input 
                      type="checkbox" 
                      checked={selectedUserIds.includes(u.id)}
                      onChange={() => handleSelectUser(u.id)}
                    />
                  </td>
                  <td><strong style={{ fontFamily: 'var(--mono)', fontSize: '11px' }}>{u.employeeId || '—'}</strong></td>
                  <td><strong>{u.name || u.email}</strong></td>
                  <td style={{ color: 'var(--text-muted)' }}>{u.email || '—'}</td>
                  <td>{u.phoneNumber || '—'}</td>
                  <td>
                    {u.department ? (
                      <span style={{ fontSize: '12px' }}>
                        {u.department} <span style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>({u.designation || 'Staff'})</span>
                      </span>
                    ) : '—'}
                  </td>
                  <td>
                    <span className={`badge ${
                      u.role === 'Super Admin' ? 'badge-available' :
                      u.role === 'Auditor'    ? 'badge-under-maintenance' : 'badge-assigned'
                    }`}>
                      {u.role}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${u.status === 'Active' ? 'badge-available' : 'badge-disposed'}`}>
                      {u.status || 'Active'}
                    </span>
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    {canManage ? (
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button className="btn-table-action" onClick={() => handleEditUserClick(u)} title="Edit User">
                          <Edit2 size={13} />
                        </button>
                        <SpinnerButton className="btn-table-action delete" onClick={() => handleDeleteUser(u)} icon={Trash2} spinnerSize={13} title="Delete User" />
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'center', padding: '40px', color: 'var(--color-muted)' }}>
                    No users found matching parameters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px', padding: '0 4px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Page {currentPage} of {totalPages} (Showing {startIndex + 1} to {Math.min(startIndex + pageSize, filteredUsers.length)} of {filteredUsers.length} records)
            </span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button 
                className="btn btn-secondary btn-sm" 
                style={{ display: 'flex', alignItems: 'center'}} 
                disabled={currentPage === 1} 
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
              >
                <ChevronLeft size={14} />
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(pg => (
                <button
                  key={pg}
                  className={`btn ${currentPage === pg ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '6px 12px', minWidth: '32px' }}
                  onClick={() => setCurrentPage(pg)}
                >
                  {pg}
                </button>
              ))}
              <button 
                className="btn btn-secondary btn-sm" 
                style={{ display: 'flex', alignItems: 'center'}} 
                disabled={currentPage === totalPages} 
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Centered Register New User Modal */}
      {showRegisterModal && (
        <Modal
          isOpen
          onClose={() => setShowRegisterModal(false)}
          closeOnOverlayClick={!isSubmitting}
          closeOnEscape={!isSubmitting}
          closeDisabled={isSubmitting}
          title="Register New User"
          as="form"
          onSubmit={handleCreateUser}
          maxWidth="520px"
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setShowRegisterModal(false)} disabled={isSubmitting}>
                Cancel
              </button>
              <SpinnerButton type="submit" className="btn btn-primary" loading={isSubmitting} loadingText="Creating…">Create User</SpinnerButton>
            </>
          }
        >
              <div className="form-group">
                <label className="form-label">Employee ID</label>
                <input className="form-input" type="text" placeholder="e.g. EMP-101"
                  value={formEmployeeId} onChange={e => setFormEmployeeId(e.target.value)} disabled={isSubmitting} />
              </div>
              <div className="form-group">
                <label className="form-label">Full Name *</label>
                <input className="form-input" type="text" placeholder="e.g. John Doe"
                  value={formName} onChange={e => setFormName(e.target.value)} disabled={isSubmitting} />
              </div>
              <div className="form-group">
                <label className="form-label">Email *</label>
                <input className="form-input" type="email" placeholder="john@company.com"
                  value={formEmail} onChange={e => setFormEmail(e.target.value)} required disabled={isSubmitting} />
              </div>
              <div className="form-group">
                <label className="form-label">Phone Number</label>
                <input className="form-input" type="text" placeholder="e.g. +91 98765 43210"
                  value={formPhoneNumber} onChange={e => setFormPhoneNumber(e.target.value)} disabled={isSubmitting} />
              </div>
              <div className="form-group">
                <label className="form-label">Department</label>
                <CustomSelect
                  options={departments.map(d => ({ value: d, label: d }))}
                  value={formDepartment}
                  onChange={e => setFormDepartment(e.target.value)}
                  disabled={isSubmitting}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Designation</label>
                <input className="form-input" type="text" placeholder="e.g. Software Engineer"
                  value={formDesignation} onChange={e => setFormDesignation(e.target.value)} disabled={isSubmitting} />
              </div>
              <div className="form-row" style={{ gap: '10px' }}>
                <div className="form-group">
                  <label className="form-label">Role</label>
                  <CustomSelect
                    options={ROLE_OPTIONS}
                    value={formRole}
                    onChange={e => setFormRole(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Status</label>
                  <CustomSelect
                    options={['Active', 'Inactive', 'Deactivated'].map(s => ({ value: s, label: s }))}
                    value={formStatus}
                    onChange={e => setFormStatus(e.target.value)}
                    disabled={isSubmitting}
                  />
                </div>
              </div>
              {formError && (
                <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#ef4444' }}>
                  {formError}
                </div>
              )}
              {formSuccess && (
                <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#22c55e' }}>
                  {formSuccess}
                </div>
              )}
        </Modal>
      )}

      {/* Edit User Details Overlay Modal */}
      {editingUser && (
        <Modal
          isOpen
          onClose={() => setEditingUser(null)}
          title={<>Edit User: <span style={{ color: 'var(--primary)' }}>{editingUser.name || editingUser.email}</span></>}
          as="form"
          onSubmit={handleEditUserSubmit}
          maxWidth="520px"
          footer={editUserFooter}
        >
                <div className="form-group">
                  <label className="form-label">Full Name *</label>
                  <input className="form-input" type="text" value={editFormName} onChange={e => setEditFormName(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Email *</label>
                  <input className="form-input" type="email" value={editFormEmail} onChange={e => setEditFormEmail(e.target.value)} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Phone Number</label>
                  <input className="form-input" type="text" value={editFormPhoneNumber} onChange={e => setEditFormPhoneNumber(e.target.value)} placeholder="e.g. +91 98765 43210" />
                </div>
                <div className="form-grid" style={{ gap: '12px' }}>
                  <div className="form-group">
                    <label className="form-label">Department</label>
                    <CustomSelect
                      options={departments.map(d => ({ value: d, label: d }))}
                      value={editFormDepartment}
                      onChange={e => setEditFormDepartment(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Designation</label>
                    <input className="form-input" type="text" value={editFormDesignation} onChange={e => setEditFormDesignation(e.target.value)} />
                  </div>
                </div>
                <div className="form-grid" style={{ gap: '12px' }}>
                  <div className="form-group">
                    <label className="form-label">Role</label>
                    <CustomSelect
                      options={ROLE_OPTIONS}
                      value={editFormRole}
                      onChange={e => setEditFormRole(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Status</label>
                    <CustomSelect
                      options={['Active', 'Inactive', 'Deactivated'].map(s => ({ value: s, label: s }))}
                      value={editFormStatus}
                      onChange={e => setEditFormStatus(e.target.value)}
                    />
                  </div>
                </div>
                <div className="form-group" style={{ borderTop: '1px solid var(--border-color)', paddingTop: '10px', marginTop: '4px' }}>
                  <label className="form-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Reset Password</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Leave blank to keep current</span>
                  </label>
                  <input className="form-input" type="password" placeholder="Enter new password" value={editFormPassword} onChange={e => setEditFormPassword(e.target.value)} autoComplete="new-password" />
                </div>

                {editError && (
                  <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#ef4444' }}>
                    {editError}
                  </div>
                )}
                {editSuccess && (
                  <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#22c55e' }}>
                    {editSuccess}
                  </div>
                )}
        </Modal>
      )}
    </div>
  );
};

// ─── Default role permission matrix ───────────────────────────────────────────
// Keys match the action strings used in hasPermission().
// 'Super Admin' is always full-access and cannot be edited.

export default UserDirectoryPage
