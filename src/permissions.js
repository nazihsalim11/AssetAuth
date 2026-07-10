/**
 * Frontend permission helpers. The authoritative model (modules, verbs, roles,
 * matrix) is shipped by GET /api/role-permissions and held in App state; these are
 * the pure functions that read it, plus a compatibility layer so the many existing
 * hasPermission(flatKey) call sites keep working while the app moves to the granular
 * module -> verb matrix.
 *
 * The backend is the real security boundary (Pass 2); this only decides what the UI
 * shows. can() must therefore mirror backend/permissionModel.can exactly.
 */

// Stable display labels, so a role key renders the same before the API responds and
// while offline. Keys match the DB enum; labels are the requested long names.
export const ROLE_LABELS = {
  'Super Admin': 'Super Administrator',
  'Admin Team': 'Admin Team',
  'IT Admin': 'IT Administrator',
  'HR Team': 'HR Team',
  'Manager': 'Manager / Approver',
  'Employee': 'Employee',
  'Facility Admin': 'Facility Admin',
  'Finance Team': 'Finance Team',
  'Auditor': 'Auditor'
};

export const roleLabel = (key) => ROLE_LABELS[key] || key;

// Display order for pickers and the matrix editor. The three legacy roles come last.
export const ROLE_ORDER = [
  'Super Admin', 'Admin Team', 'IT Admin', 'HR Team', 'Manager', 'Employee',
  'Facility Admin', 'Finance Team', 'Auditor'
];

// Ready-made options for a role <CustomSelect>: value = enum key, label = long name.
export const ROLE_OPTIONS = ROLE_ORDER.map((k) => ({ value: k, label: ROLE_LABELS[k] }));

/**
 * The nine legacy flat permission keys, mapped onto (module, verb) in the new matrix.
 * Lets existing hasPermission('write' | 'viewDocuments' | ...) calls resolve against
 * the matrix without touching every call site.
 */
export const LEGACY_MAP = {
  view: ['assets', 'view'],
  write: ['assets', 'edit'],
  allocate: ['allocations', 'create'],
  delete: ['assets', 'delete'],
  finance: ['finance', 'edit'],
  viewReports: ['reports', 'view'],
  viewAMC: ['amc', 'view'],
  viewFinance: ['finance', 'view'],
  viewDocuments: ['documents', 'view']
};

/** Does a role's matrix grant module.verb? Super Admin is always allowed. */
export function can(matrix, role, moduleKey, verb) {
  if (role === 'Super Admin') return true;
  const roleMatrix = matrix && matrix[role];
  return Boolean(roleMatrix && roleMatrix[moduleKey] && roleMatrix[moduleKey][verb]);
}

/** Resolve a legacy flat key against the matrix. Unknown keys deny. */
export function canLegacy(matrix, role, action) {
  if (role === 'Super Admin') return true;
  const mapped = LEGACY_MAP[action];
  if (!mapped) return false;
  return can(matrix, role, mapped[0], mapped[1]);
}

/** Modules this role may see (view granted), for building the nav. Super Admin: all. */
export function visibleModules(matrix, role, modules) {
  return modules.filter((m) => can(matrix, role, m.key, 'view'));
}
