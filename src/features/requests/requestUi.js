/**
 * Presentation helpers shared by the Requests module.
 *
 * Pure and free of JSX so the status/priority vocabulary has one definition rather than one
 * per component. The statuses themselves come from the server (GET /api/requests/options) —
 * these only decide how a status *looks*.
 */

// Reuses the existing status badge palette rather than inventing a second one: amber for
// "someone owes a decision", blue for in-flight, green for done, red for refused.
const STATUS_BADGES = {
  'Draft': 'badge',
  'Pending Approval': 'badge badge-under-maintenance',
  'Under Review': 'badge badge-assigned',
  'Approved': 'badge badge-available',
  'Completed': 'badge badge-available',
  'Rejected': 'badge badge-disposed',
  'Cancelled': 'badge',
  // A type may report its own words over the engine's status (see registry displayStatus).
  'Converted to Purchase Order': 'badge badge-available',
  'Closed': 'badge',
};

export const statusBadge = (status) => STATUS_BADGES[status] || 'badge';

const PRIORITY_BADGES = {
  Low: 'badge',
  Medium: 'badge badge-assigned',
  High: 'badge badge-under-maintenance',
  Critical: 'badge badge-disposed',
};

export const priorityBadge = (priority) => PRIORITY_BADGES[priority] || 'badge';

// Maps a history action onto the timeline dot colours already defined in index.css.
export function historyTone(action = '') {
  const a = action.toLowerCase();
  if (a.includes('reject') || a.includes('fail')) return 'danger';
  if (a.includes('approv') || a.includes('applied')) return 'success';
  if (a.includes('cancel') || a.includes('information')) return 'warning';
  return 'info';
}

/** Render any proposed/current value as something readable in a diff cell. */
export function displayValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Parse a form input back to the type the field expects before it goes over the wire. */
export function coerceInput(raw, type) {
  if (type === 'number') {
    if (raw === '' || raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (type === 'boolean') return raw === true || raw === 'true';
  if (raw === '') return null;
  return raw;
}

/** Money, in the request's own currency. Falls back to a plain number for an unknown code. */
export const fmtMoney = (value, currency = 'INR') => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString()}`;
  }
};

export const fmtDate = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
};

export const fmtDateTime = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
};
