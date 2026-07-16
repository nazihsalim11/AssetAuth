/**
 * Comparison / diff engine.
 *
 * Pure functions over { before, after, fields } — no database, no request shape, no module
 * knowledge. The review UI's "old vs new" table, the audit line recorded on approval, and
 * the "nothing actually changed" guard at submit time all read from the same diff, so the
 * three can never disagree about what a request proposes.
 *
 * `fields` is a registry field map: camelKey -> { label, column, type }. A proposed key that
 * is not in the map is ignored — that is the whitelist that stops a request from smuggling
 * an edit to a field its type never declared.
 */

/** Compare two scalars the way a reviewer would read them, not the way JS would. */
function sameValue(a, b, type) {
  const aNull = a === null || a === undefined || a === '';
  const bNull = b === null || b === undefined || b === '';
  if (aNull && bNull) return true;
  if (aNull !== bNull) return false;

  if (type === 'number') {
    const na = Number(a);
    const nb = Number(b);
    // Both unparseable: fall through to the string compare rather than call NaN === NaN.
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  }
  if (type === 'date') {
    // '2026-07-16' and '2026-07-16T00:00:00.000Z' are the same day to a human.
    const da = new Date(a);
    const db = new Date(b);
    if (!Number.isNaN(da.getTime()) && !Number.isNaN(db.getTime())) {
      return da.toISOString().split('T')[0] === db.toISOString().split('T')[0];
    }
  }
  if (type === 'boolean') return Boolean(a) === Boolean(b);
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

/**
 * The field-level changes a set of proposed values would make to a record.
 *
 * @param before  the current record, keyed by camelCase field name
 * @param after   the proposed values, keyed by camelCase field name (partial)
 * @param fields  registry field map: key -> { label, type, column }
 * @returns [{ field, label, before, after }] — only fields that actually differ
 */
function diffFields(before = {}, after = {}, fields = {}) {
  const out = [];
  for (const [key, spec] of Object.entries(fields)) {
    if (!(key in after)) continue; // not proposed — untouched, not "changed to null"
    const from = before ? before[key] : undefined;
    const to = after[key];
    if (sameValue(from, to, spec.type)) continue;
    out.push({
      field: key,
      label: spec.label || key,
      before: from === undefined ? null : from,
      after: to === undefined ? null : to,
    });
  }
  return out;
}

/** Keep only the proposed keys the field map declares. Everything else is dropped. */
function pickAllowed(proposed = {}, fields = {}) {
  const out = {};
  for (const key of Object.keys(fields)) {
    if (key in proposed) out[key] = proposed[key];
  }
  return out;
}

/** Diff -> the snake_case column patch that applies it. Used at approval time. */
function toColumnPatch(changes = [], fields = {}) {
  const patch = {};
  for (const change of changes) {
    const spec = fields[change.field];
    if (!spec) continue;
    patch[spec.column || change.field] = change.after === '' ? null : change.after;
  }
  return patch;
}

/** One-line human summary of a diff, for audit lines and notification bodies. */
function summarize(changes = []) {
  if (!changes.length) return 'no field changes';
  return changes.map((c) => `${c.label}: ${format(c.before)} → ${format(c.after)}`).join('; ');
}

const format = (v) => {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

module.exports = { diffFields, pickAllowed, toColumnPatch, summarize, sameValue };
