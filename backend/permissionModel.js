/**
 * The single source of truth for roles, modules, granular verbs, and the default
 * permission matrix. The database stores the *current* matrix; this file defines its
 * shape and the seed defaults, and both the API and (via the API) the frontend read
 * their vocabulary from here. Nothing else should hardcode a module or verb list.
 *
 * Design decisions, per the role/permission brief:
 *   - Internal role keys stay as the existing enum values ('Super Admin', ...), so no
 *     risky ALTER TYPE rename cascade. `label` carries the display name.
 *   - Super Admin is unrestricted in code (hasPermission short-circuits), so its row is
 *     seeded fully-true only as belt-and-suspenders.
 *   - A module lists only the verbs that make sense for it. Pretending Dashboard has a
 *     Delete verb would be dishonest granularity.
 */

const VERBS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage'];

const VERB_LABELS = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  approve: 'Approve',
  export: 'Export',
  manage: 'Manage'
};

// key: stable identifier used in permission JSON and by hasPermission(module, verb).
// nav: the frontend activeTab this module gates, or null if it is not a nav page.
const MODULES = [
  { key: 'dashboard',            label: 'Dashboard',              nav: 'dashboard',  verbs: ['view'] },
  // Requests is the approval engine every module routes through. `approve` covers reject and
  // request-more-info too — they are the same act of deciding, and splitting them would let a
  // role approve but not reject, which is not a coherent reviewer. `manage` is reassignment.
  { key: 'requests',             label: 'Requests & Approvals',   nav: 'requests',   verbs: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage'] },
  // Purchase Requests ride the Requests engine, but who may *raise* a spend request is a
  // separate question from who may take part in approvals at all — hence its own module.
  // `manage` is what lets a role raise one for a department other than its own.
  { key: 'purchaseRequests',     label: 'Purchase Requests',      nav: null,         verbs: ['view', 'create', 'edit', 'delete', 'export', 'manage'] },
  { key: 'assets',               label: 'Asset Directory',        nav: 'assets',     verbs: ['view', 'create', 'edit', 'delete', 'export', 'manage'] },
  { key: 'allocations',          label: 'Allocations & Movements', nav: 'allocations', verbs: ['view', 'create', 'edit', 'delete', 'approve', 'export'] },
  { key: 'amc',                  label: 'AMC Contracts',          nav: 'amc',        verbs: ['view', 'create', 'edit', 'delete', 'export'] },
  { key: 'finance',              label: 'Finance & Invoices',     nav: 'finance',    verbs: ['view', 'create', 'edit', 'delete', 'approve', 'export'] },
  { key: 'documents',            label: 'Document Repository',    nav: 'documents',  verbs: ['view', 'create', 'edit', 'delete', 'export'] },
  { key: 'qr',                   label: 'QR Stickers & Scan',     nav: 'qr_lookup',  verbs: ['view', 'manage'] },
  { key: 'reports',              label: 'Reports & Logs',         nav: 'reports',    verbs: ['view', 'export'] },
  { key: 'emails',               label: 'Email Alerts Inbox',     nav: 'emails',     verbs: ['view', 'manage'] },
  { key: 'tickets',              label: 'Support Tickets',        nav: 'tickets',    verbs: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage'] },
  { key: 'sla',                  label: 'SLA Management',         nav: 'sla',        verbs: ['view', 'create', 'edit', 'delete', 'manage'] },
  { key: 'knowledge',            label: 'Knowledge Base',         nav: 'knowledge_base', verbs: ['view', 'create', 'edit', 'delete'] },
  { key: 'userDirectory',        label: 'User Directory',         nav: 'users',      verbs: ['view', 'export'] },
  { key: 'userManagement',       label: 'User Management',        nav: null,         verbs: ['view', 'create', 'edit', 'delete', 'manage'] },
  { key: 'departments',          label: 'Departments',            nav: null,         verbs: ['view', 'create', 'edit', 'delete'] },
  { key: 'branches',             label: 'Branches',               nav: null,         verbs: ['view', 'create', 'edit', 'delete'] },
  { key: 'categories',           label: 'Categories',             nav: null,         verbs: ['view', 'create', 'edit', 'delete'] },
  { key: 'vendors',              label: 'Vendors',                nav: null,         verbs: ['view', 'create', 'edit', 'delete'] },
  { key: 'notificationSettings', label: 'Notification Settings',  nav: null,         verbs: ['view', 'manage'] },
  { key: 'systemSettings',       label: 'System Settings',        nav: null,         verbs: ['view', 'manage'] },
  { key: 'auditLogs',            label: 'Audit Logs',             nav: null,         verbs: ['view', 'export'] }
];

// order drives display order and the create-user picker. `legacy` marks the three
// pre-existing roles that are kept but not in the requested set.
const ROLES = [
  { key: 'Super Admin',   label: 'Super Administrator', order: 1, unrestricted: true },
  { key: 'Admin Team',    label: 'Admin Team',          order: 2 },
  { key: 'IT Admin',      label: 'IT Administrator',    order: 3 },
  { key: 'HR Team',       label: 'HR Team',             order: 4 },
  { key: 'Manager',       label: 'Manager / Approver',  order: 5 },
  { key: 'Employee',      label: 'Employee',            order: 6 },
  { key: 'Facility Admin', label: 'Facility Admin',     order: 7, legacy: true },
  { key: 'Finance Team',  label: 'Finance Team',        order: 8, legacy: true },
  { key: 'Auditor',       label: 'Auditor',             order: 9, legacy: true }
];

const ALL = (module) => module.verbs.slice();

// Shorthand default grants: { module: [verbs] | 'all' }. Missing modules/verbs = denied.
// Super Admin is intentionally absent — it is unrestricted in code.
const DEFAULT_GRANTS = {
  'Admin Team': {
    dashboard: 'all', assets: 'all', allocations: 'all', amc: 'all', finance: 'all',
    documents: 'all', qr: 'all', reports: 'all', emails: 'all', tickets: 'all',
    sla: 'all', knowledge: 'all', userDirectory: 'all', requests: 'all',
    purchaseRequests: 'all',
    userManagement: ['view', 'create', 'edit'],           // not manage (permission editing)
    departments: 'all', branches: 'all', categories: 'all', vendors: 'all',
    notificationSettings: 'all', auditLogs: ['view', 'export']
    // systemSettings intentionally excluded — Super-Admin-only unless granted.
  },
  'IT Admin': {
    dashboard: 'all', assets: 'all', allocations: 'all', amc: 'all',
    documents: ['view', 'create', 'edit'], qr: 'all', reports: ['view', 'export'],
    tickets: 'all', sla: 'all', knowledge: ['view', 'create', 'edit'],
    userDirectory: ['view'], categories: 'all', vendors: 'all',
    requests: ['view', 'create', 'edit', 'approve', 'export'],
    purchaseRequests: ['view', 'create', 'edit', 'export']
  },
  'HR Team': {
    dashboard: 'all', userDirectory: 'all',
    userManagement: ['view', 'create', 'edit'],
    departments: 'all', documents: ['view'], knowledge: ['view'],
    reports: ['view', 'export'], tickets: ['view', 'create'],
    requests: ['view', 'create', 'edit'],
    purchaseRequests: ['view', 'create', 'edit', 'export']
  },
  'Manager': {
    dashboard: 'all', assets: ['view'], allocations: ['view', 'approve'],
    amc: ['view'], finance: ['view', 'approve'], documents: ['view'],
    reports: ['view', 'export'], tickets: ['view', 'edit', 'approve'],
    sla: ['view'], knowledge: ['view'], userDirectory: ['view'],
    // The approver role: decides and reassigns, but does not delete the audit trail.
    requests: ['view', 'create', 'edit', 'approve', 'export', 'manage'],
    // Managers approve spend across departments, so they may raise for any of them.
    purchaseRequests: ['view', 'create', 'edit', 'export', 'manage']
  },
  'Employee': {
    dashboard: 'all', tickets: ['view', 'create'], knowledge: ['view'],
    documents: ['view'],
    // Employees raise requests (an asset return, a detail correction) and track their own.
    // The route scopes a view-without-approve role to its own + assigned requests.
    requests: ['view', 'create']
  },
  // Legacy roles, migrated to a sensible matrix so existing users keep working.
  'Facility Admin': {
    dashboard: 'all', assets: 'all', allocations: 'all', amc: 'all',
    documents: ['view', 'create', 'edit'], qr: 'all', reports: ['view', 'export'],
    tickets: 'all', knowledge: ['view'], userDirectory: ['view'],
    requests: ['view', 'create', 'edit', 'approve'],
    purchaseRequests: ['view', 'create', 'edit', 'export']
  },
  'Finance Team': {
    dashboard: 'all', finance: 'all', amc: ['view'], reports: ['view', 'export'],
    documents: ['view'], assets: ['view'], auditLogs: ['view', 'export'],
    // Purchase order edit requests land here, so this role decides them.
    requests: ['view', 'create', 'edit', 'approve', 'export'],
    purchaseRequests: ['view', 'create', 'edit', 'export', 'manage']
  },
  'Auditor': {
    // Read-only everywhere it can see, plus export. No create/edit/delete/approve/manage.
    dashboard: 'all', assets: ['view', 'export'], allocations: ['view', 'export'],
    amc: ['view', 'export'], finance: ['view', 'export'], documents: ['view', 'export'],
    reports: ['view', 'export'], tickets: ['view', 'export'], knowledge: ['view'],
    userDirectory: ['view', 'export'], auditLogs: ['view', 'export'],
    requests: ['view', 'export'], purchaseRequests: ['view', 'export']
  }
};

const moduleByKey = Object.fromEntries(MODULES.map((m) => [m.key, m]));

/** Materialise a role's full matrix: every valid module.verb present as a boolean. */
function buildMatrixForRole(roleKey) {
  const role = ROLES.find((r) => r.key === roleKey);
  const grants = DEFAULT_GRANTS[roleKey] || {};
  const out = {};

  for (const module of MODULES) {
    out[module.key] = {};
    const grant = grants[module.key];
    const granted = grant === 'all' ? ALL(module) : Array.isArray(grant) ? grant : [];
    for (const verb of module.verbs) {
      // Super Admin materialises fully-true, though code never actually reads it.
      out[module.key][verb] = role && role.unrestricted ? true : granted.includes(verb);
    }
  }
  return out;
}

/** The full default matrix for every role. */
function buildDefaultMatrix() {
  return Object.fromEntries(ROLES.map((r) => [r.key, buildMatrixForRole(r.key)]));
}

/**
 * Validate and normalise a submitted matrix: keep only known module.verb pairs,
 * coerce to booleans, drop unknown roles. Prevents a client from persisting junk keys.
 */
function sanitizeMatrix(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const role of ROLES) {
    const submitted = input[role.key];
    if (!submitted || typeof submitted !== 'object') continue;
    out[role.key] = {};
    for (const module of MODULES) {
      const cell = submitted[module.key];
      if (!cell || typeof cell !== 'object') continue;
      out[role.key][module.key] = {};
      for (const verb of module.verbs) {
        if (verb in cell) out[role.key][module.key][verb] = Boolean(cell[verb]);
      }
    }
  }
  return out;
}

/** Does a role's stored matrix grant module.verb? Super Admin is always true. */
function can(matrix, roleKey, moduleKey, verb) {
  const role = ROLES.find((r) => r.key === roleKey);
  if (role && role.unrestricted) return true;
  const roleMatrix = matrix && matrix[roleKey];
  return Boolean(roleMatrix && roleMatrix[moduleKey] && roleMatrix[moduleKey][verb]);
}

module.exports = {
  VERBS, VERB_LABELS, MODULES, ROLES, moduleByKey,
  buildMatrixForRole, buildDefaultMatrix, sanitizeMatrix, can
};
