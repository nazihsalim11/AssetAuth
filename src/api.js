import { mockAuthService } from './auth';
import { API_BASE_URL } from './config';

// Auth failures that mean the stored session is unusable. The app listens for
// `assetflow:session-expired` and returns the user to the login screen instead of
// leaving them clicking a UI that silently 401s.
const SESSION_DEAD_CODES = new Set(['TOKEN_EXPIRED', 'TOKEN_INVALID', 'AUTH_REQUIRED']);

function handleAuthFailure(code) {
  if (!SESSION_DEAD_CODES.has(code)) return;
  mockAuthService.logout();
  window.dispatchEvent(new CustomEvent('assetflow:session-expired', { detail: { code } }));
}

// Recursively convert snake_case object/array keys to camelCase
function snakeToCamel(obj) {
  if (Array.isArray(obj)) {
    return obj.map(v => snakeToCamel(v));
  } else if (obj !== null && obj.constructor === Object) {
    return Object.keys(obj).reduce((result, key) => {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      result[camelKey] = snakeToCamel(obj[key]);
      return result;
    }, {});
  }
  return obj;
}

// Recursively convert camelCase object/array keys to snake_case
function camelToSnake(obj) {
  if (Array.isArray(obj)) {
    return obj.map(v => camelToSnake(v));
  } else if (obj !== null && obj.constructor === Object) {
    return Object.keys(obj).reduce((result, key) => {
      const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      result[snakeKey] = camelToSnake(obj[key]);
      return result;
    }, {});
  }
  return obj;
}

// Base Fetch Wrapper
async function apiFetch(endpoint, options = {}) {
  const timeoutMs = options.timeout !== undefined ? options.timeout : 30000;
  const controller = new AbortController();
  const id = setTimeout(() => {
    controller.abort(new Error(`Timeout of ${timeoutMs}ms exceeded while calling ${endpoint}`));
  }, timeoutMs);

  const token = mockAuthService.getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const fetchOptions = { ...options };
  delete fetchOptions.timeout;

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...fetchOptions,
      credentials: 'include',
      signal: controller.signal,
      headers,
    });
    clearTimeout(id);
    if (!response.ok) {
      let errMsg = `HTTP ${response.status}`;
      let errCode;
      const errorText = await response.text();
      try {
        const errJson = JSON.parse(errorText);
        errMsg = errJson.error || errJson.message || errMsg;
        errCode = errJson.code;
      } catch {
        if (errorText) errMsg = errorText;
      }
      if (response.status === 401) handleAuthFailure(errCode);
      const err = new Error(errMsg);
      err.status = response.status;
      err.code = errCode;
      throw err;
    }
    const data = await response.json();
    return snakeToCamel(data);
  } catch (err) {
    clearTimeout(id);
    console.error(`[AssetFlow API Error] Request to ${endpoint} failed:`, err);
    throw err;
  }
}

const IMPORT_POLL_INTERVAL_MS = 700;
const IMPORT_MAX_WAIT_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// "?a=1&b=2" from an object, dropping empty values; "" when nothing is set.
const qsFrom = (params) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return qs ? `?${qs}` : '';
};

// Polls an import job to completion and resolves with its summary. A job that is
// already finished (because this key was used by an earlier, timed-out attempt)
// resolves immediately without re-importing anything.
async function waitForImportJob(job, onProgress) {
  let current = job;
  const startedAt = Date.now();

  for (;;) {
    if (current.status === 'completed') {
      onProgress?.({ processed: current.total, total: current.total, status: current.status });
      return current.summary;
    }
    if (current.status === 'failed') {
      throw new Error(current.error || 'The import failed on the server.');
    }
    if (Date.now() - startedAt > IMPORT_MAX_WAIT_MS) {
      throw new Error('The import is taking longer than expected. It is still running on the server — refresh in a moment to see the result.');
    }

    onProgress?.({ processed: current.processed || 0, total: current.total || 0, status: current.status });
    await sleep(IMPORT_POLL_INTERVAL_MS);
    current = await apiFetch(`/import/jobs/${current.jobId}`);
  }
}

export const api = {
  // Test connection
  checkConnection: async () => {
    try {
      // Hit the unauthenticated health route, not /assets. The old probe fired a
      // HEAD at an authenticated endpoint and ignored the status, so it "worked"
      // only by catching network errors — while logging a 401 on every page load.
      const response = await fetch(`${API_BASE_URL}/health`, { method: 'GET', mode: 'cors' });
      return response.ok;
    } catch {
      return false;
    }
  },

  // Auth Password Flow
  changePassword: (email, currentPassword, newPassword) => apiFetch('/auth/change-password', { method: 'POST', body: JSON.stringify({ email, currentPassword, newPassword }) }),

  // Reusable bulk management framework. Rows are sent verbatim (keyed by the template's
  // column headers) — never camel/snake-mapped — so the server's declared schema is the one
  // source of truth for column names. Every bulk-enabled entity uses these same six calls.
  getBulkSchema: (entity) => apiFetch(`/bulk/${entity}/schema`),
  bulkValidate: (entity, rows) => apiFetch(`/bulk/${entity}/validate`, { method: 'POST', body: JSON.stringify({ rows }) }),
  bulkPreview: (entity, rows) => apiFetch(`/bulk/${entity}/preview`, { method: 'POST', body: JSON.stringify({ rows }) }),
  bulkImport: (entity, rows) => apiFetch(`/bulk/${entity}/import`, { method: 'POST', body: JSON.stringify({ rows }) }),
  bulkUpdate: (entity, rows) => apiFetch(`/bulk/${entity}/update`, { method: 'POST', body: JSON.stringify({ rows }) }),
  bulkDelete: (entity, ids) => apiFetch(`/bulk/${entity}/delete`, { method: 'POST', body: JSON.stringify({ ids }) }),
  bulkExport: (entity) => apiFetch(`/bulk/${entity}/export`),

  // Reusable ID generation. `next` previews the next id for an entity (employee, asset,
  // vendor, …) without consuming it — the record's create call reserves the real one, so
  // the prefilled value is just a suggestion the user may override.
  getNextId: (entity) => apiFetch(`/id/${entity}/next`),
  getIdConfig: (entity) => apiFetch(`/id/${entity}/config`),
  updateIdConfig: (entity, fields) => apiFetch(`/id/${entity}/config`, { method: 'PATCH', body: JSON.stringify(fields) }),

  // Assets
  getAssets: () => apiFetch('/assets'),
  // Master data: valid Item Types (Asset Tag Subtypes) grouped by Asset Category.
  getAssetSubtypes: () => apiFetch('/asset-subtypes'),
  createAsset: (asset) => apiFetch('/assets', { method: 'POST', body: JSON.stringify(camelToSnake(asset)) }),
  updateAsset: (id, fields) => apiFetch(`/assets/${id}`, { method: 'PATCH', body: JSON.stringify(camelToSnake(fields)) }),
  // Custodian handover: moves the underlying asset_assignments rows so the registry
  // and employee lookups follow the asset. Returns the updated asset.
  transferAsset: (id, payload) => apiFetch(`/assets/${id}/transfer`, { method: 'POST', body: JSON.stringify(camelToSnake(payload)) }),
  deleteAsset: (id) => apiFetch(`/assets/${id}`, { method: 'DELETE' }),
  bulkDeleteAssets: (assetIds) => apiFetch('/assets/bulk/delete', { method: 'POST', body: JSON.stringify({ assetIds }) }),
  bulkUpdateAssetsStatus: (assetIds, status) => apiFetch('/assets/bulk/status', { method: 'POST', body: JSON.stringify({ assetIds, status }) }),
  bulkUpdateAssetsCategory: (assetIds, category) => apiFetch('/assets/bulk/category', { method: 'POST', body: JSON.stringify({ assetIds, category }) }),
  bulkUpdateAssetsLocation: (assetIds, location) => apiFetch('/assets/bulk/location', { method: 'POST', body: JSON.stringify({ assetIds, location }) }),
  bulkUpdateAssetsDepartment: (assetIds, department) => apiFetch('/assets/bulk/department', { method: 'POST', body: JSON.stringify({ assetIds, department }) }),

  // AMCs
  getAmcs: () => apiFetch('/amcs'),
  createAmc: (amc) => apiFetch('/amcs', { method: 'POST', body: JSON.stringify(camelToSnake(amc)) }),
  updateAmc: (id, fields) => apiFetch(`/amcs/${id}`, { method: 'PATCH', body: JSON.stringify(camelToSnake(fields)) }),

  // Invoices
  getInvoices: () => apiFetch('/invoices'),
  createInvoice: (invoice) => apiFetch('/invoices', { method: 'POST', body: JSON.stringify(camelToSnake(invoice)) }),
  updateInvoice: (id, fields) => apiFetch(`/invoices/${id}`, { method: 'PATCH', body: JSON.stringify(camelToSnake(fields)) }),
  bulkDeleteInvoices: (invoiceIds) => apiFetch('/invoices/bulk/delete', { method: 'POST', body: JSON.stringify({ invoiceIds }) }),
  bulkUpdateInvoicesStatus: (invoiceIds, status) => apiFetch('/invoices/bulk/status', { method: 'POST', body: JSON.stringify({ invoiceIds, status }) }),
  bulkImportInvoices: (invoices) => apiFetch('/invoices/bulk', { method: 'POST', body: JSON.stringify({ invoices: invoices.map(camelToSnake) }) }),

  // Invoice <-> asset mapping. Each returns the resulting { invoiceId, assetIds, assets }
  // so callers can resync the Invoice and Asset views from a single response.
  getInvoiceAssets: (invoiceId) => apiFetch(`/invoices/${invoiceId}/assets`),
  setInvoiceAssets: (invoiceId, assetIds) => apiFetch(`/invoices/${invoiceId}/assets`, { method: 'PUT', body: JSON.stringify({ assetIds }) }),
  addInvoiceAssets: (invoiceId, assetIds) => apiFetch(`/invoices/${invoiceId}/assets`, { method: 'POST', body: JSON.stringify({ assetIds }) }),
  removeInvoiceAssets: (invoiceId, assetIds) => apiFetch(`/invoices/${invoiceId}/assets`, { method: 'DELETE', body: JSON.stringify({ assetIds }) }),
  bulkMapAssetsToInvoice: (invoiceId, assetIds) => apiFetch(`/invoices/${invoiceId}/assets`, { method: 'PUT', body: JSON.stringify({ assetIds }) }),

  // Movements
  getMovements: () => apiFetch('/movements'),
  createMovement: (movement) => apiFetch('/movements', { method: 'POST', body: JSON.stringify(camelToSnake(movement)) }),

  // Documents
  getDocuments: () => apiFetch('/documents'),
  createDocument: (doc) => apiFetch('/documents', { method: 'POST', body: JSON.stringify(camelToSnake(doc)) }),

  // Logs
  getLogs: () => apiFetch('/logs'),
  createLog: (log) => apiFetch('/logs', { method: 'POST', body: JSON.stringify(camelToSnake(log)) }),

  // Notifications
  getNotifications: () => apiFetch('/notifications'),
  createNotification: (notif) => apiFetch('/notifications', { method: 'POST', body: JSON.stringify(camelToSnake(notif)) }),
  markNotificationRead: (id, read) => apiFetch(`/notifications/${id}`, { method: 'PATCH', body: JSON.stringify({ read }) }),
  markAllNotificationsRead: () => apiFetch('/notifications', { method: 'PATCH' }),
  deleteNotification: (id) => apiFetch(`/notifications/${id}`, { method: 'DELETE' }),
  bulkDeleteNotifications: (notificationIds) => apiFetch('/notifications/bulk/delete', { method: 'POST', body: JSON.stringify({ notificationIds }) }),
  bulkMarkNotificationsRead: (notificationIds, read) => apiFetch('/notifications/bulk/read', { method: 'POST', body: JSON.stringify({ notificationIds, read }) }),

  // Employee asset lookup
  searchEmployees: (q) => apiFetch(`/employees/search?q=${encodeURIComponent(q)}`),
  getEmployeeAssets: (id) => apiFetch(`/employees/${id}/assets`),

  // Purchase Orders
  getPurchaseOrderOptions: () => apiFetch('/purchase-orders/options'),
  getPurchaseOrders: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();
    return apiFetch(`/purchase-orders${qs ? `?${qs}` : ''}`);
  },
  getPurchaseOrder: (id) => apiFetch(`/purchase-orders/${id}`),
  createPurchaseOrder: (po) => apiFetch('/purchase-orders', { method: 'POST', body: JSON.stringify(po) }),
  updatePurchaseOrder: (id, fields) => apiFetch(`/purchase-orders/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  deletePurchaseOrder: (id) => apiFetch(`/purchase-orders/${id}`, { method: 'DELETE' }),
  getNextPoNumber: () => apiFetch('/purchase-orders/next-number'),
  // The browser generates the PO PDF, uploads it via uploadFile(), then records the
  // returned storage path here as the next version in the PO's document history.
  recordPurchaseOrderDocument: (id, doc) => apiFetch(`/purchase-orders/${id}/documents`, { method: 'POST', body: JSON.stringify(doc) }),
  getPurchaseOrderDocuments: (id) => apiFetch(`/purchase-orders/${id}/documents`),
  emailPurchaseOrder: (id, payload) => apiFetch(`/purchase-orders/${id}/email`, { method: 'POST', body: JSON.stringify(payload) }),

  // Vendor master. Selecting a vendor auto-fills a PO; the chosen values are then
  // snapshotted onto the order server-side.
  getVendors: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();
    return apiFetch(`/vendors${qs ? `?${qs}` : ''}`);
  },
  getVendor: (id) => apiFetch(`/vendors/${id}`),
  createVendor: (vendor) => apiFetch('/vendors', { method: 'POST', body: JSON.stringify(vendor) }),
  updateVendor: (id, fields) => apiFetch(`/vendors/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  deleteVendor: (id) => apiFetch(`/vendors/${id}`, { method: 'DELETE' }),

  // Company letterhead, authorised signature and PO-number rule.
  getPoSettings: () => apiFetch('/po-settings'),
  updatePoSettings: (fields) => apiFetch('/po-settings', { method: 'PATCH', body: JSON.stringify(fields) }),

  // Master Terms & Conditions. Saving publishes a new version; existing POs keep theirs.
  getPoTerms: () => apiFetch('/po-terms'),
  updatePoTerms: (content) => apiFetch('/po-terms', { method: 'PUT', body: JSON.stringify({ content }) }),

  // Notification administration. `channels` reports whether each provider is actually
  // configured, so the UI can explain why a channel is unavailable rather than just
  // showing a toggle that does nothing.
  getNotificationSettings: () => apiFetch('/notification-settings'),
  updateNotificationSettings: (fields) => apiFetch('/notification-settings', { method: 'PATCH', body: JSON.stringify(fields) }),
  getNotificationHistory: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return apiFetch(`/notification-history${qs ? `?${qs}` : ''}`);
  },
  retryFailedNotifications: () => apiFetch('/notifications/retry-failed', { method: 'POST' }),
  getNotificationPreferences: () => apiFetch('/notification-preferences'),
  updateNotificationPreferences: (payload) => apiFetch('/notification-preferences', { method: 'PUT', body: JSON.stringify(payload) }),

  // Department & Location masters — the single source of truth for their dropdowns.
  // List endpoints return active rows as { id, name, description, isActive }; pass
  // { all: true } from admin screens to include archived rows.
  // deleteX archives by default; pass { permanent: true } to remove the row outright
  // (backend refuses with 409 + a dependency breakdown if anything still references it).
  getDepartments: (params = {}) => apiFetch(`/departments${params.all ? '?all=true' : ''}`),
  createDepartment: (dept) => apiFetch('/departments', { method: 'POST', body: JSON.stringify(dept) }),
  updateDepartment: (id, fields) => apiFetch(`/departments/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  deleteDepartment: (id, { permanent = false } = {}) => apiFetch(`/departments/${id}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' }),

  getLocations: (params = {}) => apiFetch(`/locations${params.all ? '?all=true' : ''}`),
  createLocation: (loc) => apiFetch('/locations', { method: 'POST', body: JSON.stringify(loc) }),
  updateLocation: (id, fields) => apiFetch(`/locations/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  deleteLocation: (id, { permanent = false } = {}) => apiFetch(`/locations/${id}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' }),

  // Role permissions — the authoritative matrix, fetched from and saved to the DB.
  getRolePermissions: () => apiFetch('/role-permissions'),
  updateRolePermissions: (updates) => apiFetch('/role-permissions', { method: 'PATCH', body: JSON.stringify(updates) }),

  // Emails
  getEmails: () => apiFetch('/emails'),
  deleteEmail: (id) => apiFetch(`/emails/${id}`, { method: 'DELETE' }),
  bulkDeleteEmails: (emailIds) => apiFetch('/emails/bulk/delete', { method: 'POST', body: JSON.stringify({ emailIds }) }),

  // Users
  getUsers: () => apiFetch('/users'),
  createUser: (user) => apiFetch('/users', { method: 'POST', body: JSON.stringify(user) }),
  updateUser: (id, fields) => apiFetch(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  deleteUser: (id) => apiFetch(`/users/${id}`, { method: 'DELETE' }),
  bulkDeleteUsers: (userIds) => apiFetch('/users/bulk/delete', { method: 'POST', body: JSON.stringify({ userIds }) }),
  bulkUpdateUsersStatus: (userIds, status) => apiFetch('/users/bulk/status', { method: 'POST', body: JSON.stringify({ userIds, status }) }),
  bulkResetUsersPassword: (userIds) => apiFetch('/users/bulk/reset-password', { method: 'POST', body: JSON.stringify({ userIds }) }),
  bulkUpdateUsersDepartment: (userIds, department) => apiFetch('/users/bulk/department', { method: 'POST', body: JSON.stringify({ userIds, department }) }),
  bulkUpdateUsersRole: (userIds, role) => apiFetch('/users/bulk/role', { method: 'POST', body: JSON.stringify({ userIds, role }) }),

  // Upload File
  // Returns { name, fileName, fileSize, fileUrl }. Despite the name, `fileUrl` is a
  // durable storage path, not a URL — the bucket is private. Pass it to getFileUrl()
  // to obtain a short-lived link when the user actually opens the file.
  uploadFile: async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const token = mockAuthService.getToken();
      const response = await fetch(`${API_BASE_URL}/upload`, {
        method: 'POST',
        credentials: 'include',
        // Do NOT set Content-Type here; the browser must add the multipart boundary.
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData
      });
      if (!response.ok) {
        const errText = await response.text();
        let msg = `HTTP ${response.status}`;
        try {
          const parsed = JSON.parse(errText);
          msg = parsed.error || msg;
          if (response.status === 401) handleAuthFailure(parsed.code);
        } catch {
          if (errText) msg = errText;
        }
        throw new Error(msg);
      }
      const data = await response.json();
      return snakeToCamel(data);
    } catch (err) {
      console.error("[AssetFlow API] File upload failed", err);
      throw err;
    }
  },

  // Exchanges a stored file path for a short-lived signed URL.
  getFileUrl: (path) => apiFetch('/files/signed-url', { method: 'POST', body: JSON.stringify({ path }) }),

  // Bulk Import
  //
  // Employee import runs as a background job on the server, so the request no
  // longer holds the connection open for the duration of the work (which is what
  // blew the 30s timeout). This starts the job, polls it, and resolves with the
  // same summary shape the caller has always received.
  //
  // `importKey` is an idempotency key: retrying with the same key returns the
  // original job instead of importing the same employees twice.
  importEmployees: async (employees, { importKey, onProgress } = {}) => {
    const job = await apiFetch('/import/employees', {
      method: 'POST',
      body: JSON.stringify({ employees, importKey })
    });
    return waitForImportJob(job, onProgress);
  },
  getImportJob: (jobId) => apiFetch(`/import/jobs/${jobId}`),

  importAssets: (assets) => apiFetch('/import/assets', { method: 'POST', body: JSON.stringify({ assets }) }),

  // Assignments
  getAssignments: () => apiFetch('/assignments'),
  createAssignment: (assignment) => apiFetch('/assignments', { method: 'POST', body: JSON.stringify(camelToSnake(assignment)) }),
  returnAssignment: (id, quantity, notes) => apiFetch(`/assignments/${id}/return`, { method: 'POST', body: JSON.stringify(camelToSnake({ quantity, notes })) }),
  updateAssignment: (id, fields) => apiFetch(`/assignments/${id}`, { method: 'PATCH', body: JSON.stringify(camelToSnake(fields)) }),

  // Tickets
  getTickets: () => apiFetch('/tickets'),
  getTicketById: (id) => apiFetch(`/tickets/${id}`),
  createTicket: (ticket) => apiFetch('/tickets', { method: 'POST', body: JSON.stringify(camelToSnake(ticket)) }),
  addTicketComment: (id, commentText, isInternal) => apiFetch(`/tickets/${id}/comments`, { method: 'POST', body: JSON.stringify(camelToSnake({ commentText, isInternal })) }),
  assignTicket: (id, assignToUserId) => apiFetch(`/tickets/${id}/assign`, { method: 'POST', body: JSON.stringify(camelToSnake({ assignToUserId })) }),
  updateTicketStatus: (id, status) => apiFetch(`/tickets/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  updateTicketPriority: (id, priority) => apiFetch(`/tickets/${id}/priority`, { method: 'PATCH', body: JSON.stringify({ priority }) }),
  updateTicketCategory: (id, category) => apiFetch(`/tickets/${id}/category`, { method: 'PATCH', body: JSON.stringify({ category }) }),
  updateTicketDepartment: (id, department) => apiFetch(`/tickets/${id}/department`, { method: 'PATCH', body: JSON.stringify({ department }) }),
  bulkUpdateTicketsStatus: (ticketIds, status) => apiFetch('/tickets/bulk/status', { method: 'POST', body: JSON.stringify({ ticketIds, status }) }),
  bulkUpdateTicketsPriority: (ticketIds, priority) => apiFetch('/tickets/bulk/priority', { method: 'POST', body: JSON.stringify({ ticketIds, priority }) }),
  bulkUpdateTicketsCategory: (ticketIds, category) => apiFetch('/tickets/bulk/category', { method: 'POST', body: JSON.stringify({ ticketIds, category }) }),
  bulkUpdateTicketsDepartment: (ticketIds, department) => apiFetch('/tickets/bulk/department', { method: 'POST', body: JSON.stringify({ ticketIds, department }) }),
  bulkAssignTickets: (ticketIds, assignToUserId) => apiFetch('/tickets/bulk/assign', { method: 'POST', body: JSON.stringify({ ticketIds, assignToUserId }) }),
  bulkDeleteTickets: (ticketIds) => apiFetch('/tickets/bulk/delete', { method: 'POST', body: JSON.stringify({ ticketIds }) }),
  autoAssignTicket: (id) => apiFetch(`/tickets/${id}/auto-assign`, { method: 'POST' }),
  getTicketsAnalytics: () => apiFetch('/tickets-analytics'),

  // SLA Management. Bodies are sent as raw camelCase — the SLA endpoints read camelCase
  // directly (unlike the older snake-cased endpoints), and responses already arrive
  // camelCased from the server mappers.
  getSlaOptions: () => apiFetch('/sla/options'),
  getSlaPolicies: (includeArchived = false) => apiFetch(`/sla/policies${includeArchived ? '?includeArchived=true' : ''}`),
  getSlaPolicy: (id) => apiFetch(`/sla/policies/${id}`),
  createSlaPolicy: (policy) => apiFetch('/sla/policies', { method: 'POST', body: JSON.stringify(policy) }),
  updateSlaPolicy: (id, policy) => apiFetch(`/sla/policies/${id}`, { method: 'PUT', body: JSON.stringify(policy) }),
  archiveSlaPolicy: (id, archived = true) => apiFetch(`/sla/policies/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) }),
  deleteSlaPolicy: (id) => apiFetch(`/sla/policies/${id}`, { method: 'DELETE' }),
  previewSla: (ticket) => apiFetch('/sla/preview', { method: 'POST', body: JSON.stringify(ticket) }),
  getSlaCalendars: () => apiFetch('/sla/calendars'),

  // Dashboards (live aggregates). Optional filters: { department, from, to }.
  getTicketDashboard: (params = {}) => apiFetch(`/dashboards/tickets${qsFrom(params)}`),
  getSlaDashboard: (params = {}) => apiFetch(`/dashboards/sla${qsFrom(params)}`),
  getTechnicianDashboard: (params = {}) => apiFetch(`/dashboards/technicians${qsFrom(params)}`),
  getAssetDashboard: () => apiFetch('/dashboards/assets'),

  // Reports (backend engine). Bodies sent raw camelCase.
  getReportOptions: () => apiFetch('/reports/options'),
  runReport: (key, filters = {}) => apiFetch('/reports/run', { method: 'POST', body: JSON.stringify({ key, filters }) }),
  emailReport: (key, filters, recipients) => apiFetch('/reports/email', { method: 'POST', body: JSON.stringify({ key, filters, recipients }) }),
  getScheduledReports: () => apiFetch('/reports/scheduled'),
  createScheduledReport: (payload) => apiFetch('/reports/scheduled', { method: 'POST', body: JSON.stringify(payload) }),
  updateScheduledReport: (id, payload) => apiFetch(`/reports/scheduled/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteScheduledReport: (id) => apiFetch(`/reports/scheduled/${id}`, { method: 'DELETE' }),
  createSlaCalendar: (calendar) => apiFetch('/sla/calendars', { method: 'POST', body: JSON.stringify(calendar) }),
  updateSlaCalendar: (id, calendar) => apiFetch(`/sla/calendars/${id}`, { method: 'PUT', body: JSON.stringify(calendar) }),
  deleteSlaCalendar: (id) => apiFetch(`/sla/calendars/${id}`, { method: 'DELETE' }),

  // Helpdesk + Knowledge Base
  getHelpdeskOptions: () => apiFetch('/helpdesk/options'),

  getKbCategories: () => apiFetch('/kb/categories'),
  createKbCategory: (category) => apiFetch('/kb/categories', { method: 'POST', body: JSON.stringify(category) }),
  updateKbCategory: (id, fields) => apiFetch(`/kb/categories/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  deleteKbCategory: (id) => apiFetch(`/kb/categories/${id}`, { method: 'DELETE' }),

  getKbArticles: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
    ).toString();
    return apiFetch(`/kb/articles${qs ? `?${qs}` : ''}`);
  },
  getKbArticle: (idOrSlug) => apiFetch(`/kb/articles/${idOrSlug}`),
  createKbArticle: (article) => apiFetch('/kb/articles', { method: 'POST', body: JSON.stringify(article) }),
  updateKbArticle: (id, fields) => apiFetch(`/kb/articles/${id}`, { method: 'PATCH', body: JSON.stringify(fields) }),
  deleteKbArticle: (id) => apiFetch(`/kb/articles/${id}`, { method: 'DELETE' }),

  // Typeahead for the ticket form. Never throws: a failing suggestion lookup must not
  // block the user from filing a ticket.
  suggestKbArticles: async (q) => {
    try {
      return await apiFetch(`/kb/suggest?q=${encodeURIComponent(q)}`);
    } catch {
      return [];
    }
  }
};
