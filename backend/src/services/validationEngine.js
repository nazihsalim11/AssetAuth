/**
 * Centralized bulk-import validation engine.
 *
 * One rule-driven validator for every bulk import (assets, employees, vendors, AMC,
 * purchase orders, invoices, departments, locations, categories, …). Callers describe
 * an entity's columns once as a *field schema*; the engine walks every row, applies the
 * rules, and returns detailed, row-level faults WITHOUT stopping at the first error, so a
 * single pass produces a complete, downloadable validation report.
 *
 * A field descriptor (see backend/src/bulk/registry.js for real examples):
 *   {
 *     key:        'employeeId',        // normalised key on the mapped row object
 *     column:     'Employee ID',       // human header, used in every fault it raises
 *     type:       'string'             // string|integer|number|date|email|phone|enum|boolean
 *     required:   true,                // missing/blank -> fault
 *     enum:       ['Active','Inactive']// allowed values (case-insensitive); implies type 'enum'
 *     master:     'departments',       // must exist in context.masters[name] (a Set of names)
 *     unique:     true,                // duplicated within the uploaded batch -> duplicate fault
 *     existing:   'employeeIds',       // already present in context.existing[name] -> duplicate fault
 *     min, max,                        // numeric bounds (type number/integer)
 *     pattern:    /regex/,             // custom format
 *     expected:   'EMP0001',           // overrides the auto-derived "expected format" text
 *     rule:       (value, row, ctx) => string|null,   // business-rule hook; return a message to fail
 *     normalize:  (value, row, ctx) => newValue,      // canonicalise before writing (runs after checks)
 *     default:    'Active',            // substituted when the cell is blank and not required
 *   }
 *
 * Two fault kinds are distinguished so summaries can report them separately, matching the
 * existing importers' { success, failed, duplicate } shape:
 *   - 'validation' — a bad/missing/unknown value
 *   - 'duplicate'  — collides with another row in the batch or an existing record
 */

const validateAndFormatPhone = require('../utils/phone');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
const norm = (v) => String(v ?? '').trim().toLowerCase();

// Levenshtein distance, capped — only used to suggest a near master-data match, so a small
// bound keeps it cheap on long strings.
function editDistance(a, b) {
  a = String(a); b = String(b);
  if (Math.abs(a.length - b.length) > 4) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(
        dp[i] + 1,
        dp[i - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[a.length];
}

// Nearest value from a set of allowed strings, if it is close enough to be a likely typo.
function closest(value, allowed) {
  const v = norm(value);
  let best = null;
  let bestD = Infinity;
  for (const candidate of allowed) {
    const d = editDistance(v, norm(candidate));
    if (d < bestD) { bestD = d; best = candidate; }
  }
  const limit = Math.max(1, Math.floor(v.length / 3));
  return bestD <= limit ? best : null;
}

// The "expected format / valid values" string shown on a fault, derived from the field type
// unless the descriptor supplies an explicit `expected`.
function expectedFor(field, ctx) {
  if (field.expected) return field.expected;
  switch (field.type) {
    case 'email': return 'name@example.com';
    case 'phone': return '10-digit number, or + followed by 7-15 digits';
    case 'date': return 'YYYY-MM-DD';
    case 'integer': return 'a whole number';
    case 'number': return 'a number';
    case 'boolean': return 'Yes or No';
    case 'enum': return `one of: ${(field.enum || []).join(', ')}`;
    default:
      if (field.master && ctx && ctx.masters && ctx.masters[field.master]) {
        return `an existing ${field.master.replace(/s$/, '')} (${[...ctx.masters[field.master].values()].slice(0, 8).join(', ')}${ctx.masters[field.master].size > 8 ? ', …' : ''})`;
      }
      if (field.pattern) return String(field.pattern);
      return 'a valid value';
  }
}

// Parse a date cell. Accepts ISO / YYYY-MM-DD / anything Date understands, plus Excel serial
// day numbers (xlsx often yields those). Returns { ok, iso } — iso is the normalised
// YYYY-MM-DD form so imports store one consistent shape.
function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { ok: true, iso: value.toISOString().slice(0, 10) };
  }
  const s = String(value).trim();
  // Excel serial date (days since 1899-12-30).
  if (/^\d{4,6}$/.test(s)) {
    const serial = parseInt(s, 10);
    if (serial > 59 && serial < 60000) {
      const ms = (serial - 25569) * 86400 * 1000;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return { ok: true, iso: d.toISOString().slice(0, 10) };
    }
  }
  const iso = /^\d{4}-\d{2}-\d{2}/.test(s);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, iso: iso ? s.slice(0, 10) : d.toISOString().slice(0, 10) };
}

/**
 * Validate one field of one row. Returns { fault, value } where fault is null when the cell
 * passes; `value` is the normalised value to write on success.
 */
function validateField(field, rawRow, ctx, batchSeen) {
  const column = field.column || field.key;
  const raw = rawRow[field.key];
  const mkFault = (kind, message, extra = {}) => ({
    kind,
    column,
    value: raw === undefined || raw === null ? '' : String(raw),
    expected: expectedFor(field, ctx),
    suggestion: null,
    message,
    ...extra,
  });

  if (isBlank(raw)) {
    if (field.required) {
      return { fault: mkFault('validation', `${column} is required.`) };
    }
    return { fault: null, value: field.default !== undefined ? field.default : (raw ?? null) };
  }

  let value = typeof raw === 'string' ? raw.trim() : raw;
  const type = field.enum ? 'enum' : (field.type || 'string');

  switch (type) {
    case 'integer':
    case 'number': {
      const n = type === 'integer' ? parseInt(value, 10) : parseFloat(value);
      if (Number.isNaN(n) || (type === 'integer' && !/^-?\d+$/.test(String(value).trim()))) {
        return { fault: mkFault('validation', `${column} must be ${type === 'integer' ? 'a whole number' : 'a number'}.`) };
      }
      if (field.min !== undefined && n < field.min) {
        return { fault: mkFault('validation', `${column} must be at least ${field.min}.`, { expected: `>= ${field.min}` }) };
      }
      if (field.max !== undefined && n > field.max) {
        return { fault: mkFault('validation', `${column} must be at most ${field.max}.`, { expected: `<= ${field.max}` }) };
      }
      value = n;
      break;
    }
    case 'date': {
      const parsed = parseDate(value);
      if (!parsed.ok) {
        return { fault: mkFault('validation', `${column} is not a valid date.`) };
      }
      value = parsed.iso;
      break;
    }
    case 'email': {
      if (!EMAIL_RE.test(String(value))) {
        return { fault: mkFault('validation', `${column} is not a valid email address.`) };
      }
      value = String(value).trim();
      break;
    }
    case 'phone': {
      const r = validateAndFormatPhone(value);
      if (!r.isValid) {
        return { fault: mkFault('validation', r.error || `${column} is not a valid phone number.`) };
      }
      value = r.value;
      break;
    }
    case 'boolean': {
      const t = norm(value);
      if (['true', 'yes', 'y', '1'].includes(t)) value = true;
      else if (['false', 'no', 'n', '0'].includes(t)) value = false;
      else return { fault: mkFault('validation', `${column} must be Yes or No.`) };
      break;
    }
    case 'enum': {
      const match = (field.enum || []).find((opt) => norm(opt) === norm(value));
      if (!match) {
        const guess = closest(value, field.enum || []);
        return { fault: mkFault('validation', `"${value}" is not a valid ${column}.`, { suggestion: guess }) };
      }
      value = match; // canonical casing
      break;
    }
    default: {
      value = String(value);
      if (field.pattern && !field.pattern.test(value)) {
        return { fault: mkFault('validation', `${column} has an invalid format.`) };
      }
    }
  }

  // Master-data reference (Departments, Vendors, Locations, Categories, …).
  if (field.master && ctx.masters && ctx.masters[field.master]) {
    const set = ctx.masters[field.master];
    // Only enforced once the master is populated — a brand-new system is not blocked.
    if (set.size && !set.has(norm(value))) {
      const guess = closest(value, [...(ctx.masterNames?.[field.master] || set)]);
      return {
        fault: mkFault('validation',
          `"${value}" is not in the ${field.master.replace(/s$/, '')} master.`,
          { suggestion: guess }),
      };
    }
  }

  // Custom business rule.
  if (typeof field.rule === 'function') {
    const msg = field.rule(value, rawRow, ctx);
    if (msg) return { fault: mkFault('validation', msg) };
  }

  // Duplicate against another row in this upload.
  if (field.unique) {
    const seen = batchSeen[field.key] || (batchSeen[field.key] = new Set());
    const key = norm(value);
    if (seen.has(key)) {
      return { fault: mkFault('duplicate', `Duplicate ${column} "${value}" in the uploaded file.`) };
    }
    seen.add(key);
  }

  // Duplicate against an existing record.
  if (field.existing && ctx.existing && ctx.existing[field.existing]) {
    if (ctx.existing[field.existing].has(norm(value))) {
      return { fault: mkFault('duplicate', `${column} "${value}" already exists.`) };
    }
  }

  if (typeof field.normalize === 'function') value = field.normalize(value, rawRow, ctx);
  return { fault: null, value };
}

/**
 * Validate an array of mapped rows against a field schema.
 *
 * @param {object[]} rows    Mapped rows (keys match field.key).
 * @param {object[]} schema  Array of field descriptors.
 * @param {object}   context { masters, masterNames, existing, rules } — see module docs.
 * @returns {{ valid, errors, summary }}
 *   valid   — [{ row, data }] rows that passed every field (data = normalised values).
 *   errors  — [{ row, column, value, expected, suggestion, error, kind }] one per failing cell.
 *   summary — { total, success, failed, duplicate }.
 */
function validate(rows, schema, context = {}) {
  const ctx = { masters: {}, existing: {}, ...context };
  const errors = [];
  const valid = [];
  const batchSeen = {};
  let failed = 0;
  let duplicate = 0;

  rows.forEach((rawRow, index) => {
    const rowNum = index + 1;
    const rowFaults = [];
    const data = {};

    for (const field of schema) {
      const { fault, value } = validateField(field, rawRow, ctx, batchSeen);
      if (fault) {
        rowFaults.push({
          row: rowNum,
          column: fault.column,
          value: fault.value,
          expected: fault.expected,
          suggestion: fault.suggestion || null,
          error: fault.message,
          kind: fault.kind,
        });
      } else {
        data[field.key] = value;
      }
    }

    // Whole-row business rules (cross-field), only if the individual cells passed.
    if (rowFaults.length === 0 && typeof ctx.rowRule === 'function') {
      const msg = ctx.rowRule(data, rawRow, ctx);
      if (msg) {
        rowFaults.push({ row: rowNum, column: '(row)', value: '', expected: '', suggestion: null, error: msg, kind: 'validation' });
      }
    }

    if (rowFaults.length) {
      // A row counts as a duplicate if any of its faults is a duplicate and none is a plain
      // validation error; otherwise it is a validation failure. This mirrors how the existing
      // importers bucket each row exactly once.
      const hasValidation = rowFaults.some((f) => f.kind === 'validation');
      if (hasValidation) failed++; else duplicate++;
      errors.push(...rowFaults);
    } else {
      valid.push({ row: rowNum, data });
    }
  });

  errors.sort((a, b) => a.row - b.row);
  return {
    valid,
    errors,
    summary: { total: rows.length, success: valid.length, failed, duplicate },
  };
}

module.exports = { validate, validateField, parseDate, closest, expectedFor, EMAIL_RE };
