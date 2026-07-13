import { useState } from 'react'
import { can as canPerm } from '../../permissions'
import RolePermissionMatrix from '../../RolePermissionMatrix'
import UserDirectoryPage from './UserDirectoryPage'
import MasterDataPage from '../masters/MasterDataPage'
import SystemReset from './SystemReset'

const UserManagementPage = ({ usersList, setUsersList, isApiConnected, rolePermissions, setRolePermissions, permModel, onBulkImportClick, addToast, onUsersDeleted, currentRole, departments = [], onMastersChanged }) => {
  const [usersSubTab, setUsersSubTab] = useState('directory');
  // The directory's create/edit/delete controls, and the role-permission editor, are
  // each gated by their own module verb. Backend enforces these too (the real boundary).
  const canManageUsers = canPerm(rolePermissions, currentRole, 'userManagement', 'edit')
    || canPerm(rolePermissions, currentRole, 'userManagement', 'create')
    || canPerm(rolePermissions, currentRole, 'userManagement', 'delete');
  const canManagePerms = canPerm(rolePermissions, currentRole, 'userManagement', 'manage');
  // Department & Location master management, gated by the departments/branches resources.
  const masterPerms = {
    deptCreate: canPerm(rolePermissions, currentRole, 'departments', 'create'),
    deptEdit: canPerm(rolePermissions, currentRole, 'departments', 'edit'),
    deptDelete: canPerm(rolePermissions, currentRole, 'departments', 'delete'),
    locCreate: canPerm(rolePermissions, currentRole, 'branches', 'create'),
    locEdit: canPerm(rolePermissions, currentRole, 'branches', 'edit'),
    locDelete: canPerm(rolePermissions, currentRole, 'branches', 'delete'),
  };
  const canManageMasters = Object.values(masterPerms).some(Boolean);
  const subTabs = [{ id: 'directory', label: '👥  User Management' }];
  if (canManagePerms) subTabs.push({ id: 'permissions', label: '🔐  Role Permissions' });
  if (canManageMasters) subTabs.push({ id: 'masters', label: '🏢  Departments & Locations' });
  if (currentRole === 'Super Admin') {
    subTabs.push({ id: 'reset', label: '⚠️  System Reset' });
  }
  const activeSubTab = (
    (usersSubTab === 'permissions' && !canManagePerms) || 
    (usersSubTab === 'masters' && !canManageMasters) ||
    (usersSubTab === 'reset' && currentRole !== 'Super Admin')
  ) ? 'directory' : usersSubTab;
  
  return (
    <div>
      {/* Sub-tab bar */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '28px', background: 'var(--bg-sidebar)', padding: '4px', borderRadius: 'var(--radius-lg)', width: 'fit-content', border: '1px solid var(--border-color)' }}>
        {subTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setUsersSubTab(tab.id)}
            style={{
              padding: '8px 18px',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 600,
              fontFamily: 'var(--font-sans)',
              transition: 'all 0.2s',
              background: activeSubTab === tab.id ? 'var(--primary)' : 'transparent',
              color: activeSubTab === tab.id ? 'var(--ink-contrast)' : 'var(--text-muted)',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {activeSubTab === 'directory' && (
        <UserDirectoryPage
          usersList={usersList}
          setUsersList={setUsersList}
          isApiConnected={isApiConnected}
          onBulkImportClick={onBulkImportClick}
          addToast={addToast}
          onUsersDeleted={onUsersDeleted}
          departments={departments}
          canManage={canManageUsers}
        />
      )}
      {activeSubTab === 'permissions' && (
        <RolePermissionMatrix
          modules={permModel?.modules || []}
          verbLabels={permModel?.verbLabels || {}}
          matrix={rolePermissions}
          setMatrix={setRolePermissions}
          addToast={addToast}
          currentRole={currentRole}
        />
      )}
      {activeSubTab === 'masters' && (
        <MasterDataPage canManage={masterPerms} addToast={addToast} onChanged={onMastersChanged} />
      )}
      {activeSubTab === 'reset' && (
        <SystemReset addToast={addToast} currentRole={currentRole} />
      )}
    </div>
  );
};

export default UserManagementPage
