/**
 * Bulk framework engine.
 *
 * Orchestrates one shared pipeline for every registered entity (backend/src/bulk/registry.js):
 *   schema   -> the columns/template/sample a client needs to render the importer
 *   validate -> run the centralized validation engine over mapped rows (no writes)
 *   import   -> validate, then atomically commit the valid rows (duplicates reported per row)
 *   update   -> validate, then patch existing rows matched by the entity's business key
 *   remove   -> delete rows by business key, nulling FK references
 *   export   -> the entity's rows shaped back into template columns
 *
 * It reuses the shared services rather than re-implementing anything:
 *   - validation:  backend/src/services/validationEngine.js
 *   - master data: backend/src/services/masterData.js  (FK + suggestion sources)
 *   - persistence: backend/convex/bulk.js               (generic atomic batch mutations)
 */

const { cq, cm } = require('../../convexApi');
const { validate: runValidation } = require('../services/validationEngine');
const masterData = require('../services/masterData');
const { getDescriptor } = require('./registry');

const strip = (d) => { if (!d) return d; const { _id, _creationTime, ...rest } = d; return rest; };
const headerToKey = (d) => Object.fromEntries(d.columns.map((c) => [c.header, c.key]));

// Map an incoming raw row (keyed by header, or already by key) to the descriptor's keys.
function mapRow(descriptor, raw) {
  const h2k = headerToKey(descriptor);
  const out = {};
  for (const [k, val] of Object.entries(raw)) {
    if (h2k[k]) out[h2k[k]] = val;           // header -> key
    else if (descriptor.columns.some((c) => c.key === k)) out[k] = val; // already a key
  }
  return out;
}

// The columns array IS the validation schema — each column carries its rules plus the header
// used as the human `column` in every fault it raises. In 'update' mode the existing-record
// duplicate check is dropped: the row is *expected* to already exist, so matching an existing
// value is not a fault (in-batch `unique` and all format/master rules still apply).
const schemaOf = (descriptor, mode = 'import') =>
  descriptor.columns.map((c) => {
    const field = { ...c, column: c.header };
    if (mode === 'update') delete field.existing;
    return field;
  });

// Load the validation context an entity needs: master sets (+ canonical names for
// suggestions), duplicate-detection sets, name->row lookups for FK resolution, and the
// cross-field row rule. Loaded once per request and shared by validate/import/update.
async function loadContext(descriptor) {
  const ctx = { masters: {}, masterNames: {}, existing: {}, lookups: {} };

  for (const m of descriptor.masters || []) {
    ctx.masters[m] = await masterData.getSet(m);
    ctx.masterNames[m] = await masterData.getNames(m);
    ctx.lookups[m] = await masterData.getMap(m);
  }
  for (const [name, { table, field }] of Object.entries(descriptor.existing || {})) {
    const rows = await cq('generic:list', { table });
    ctx.existing[name] = new Set(rows.map((r) => String(r[field] ?? '').trim().toLowerCase()).filter(Boolean));
  }
  if (typeof descriptor.rowRule === 'function') ctx.rowRule = descriptor.rowRule;
  return ctx;
}

function schema(entity) {
  const d = getDescriptor(entity);
  return {
    entity: d.key,
    label: d.label,
    labelPlural: d.labelPlural,
    matchField: d.matchField,
    matchHeader: (d.columns.find((c) => c.key === d.matchField) || {}).header || d.matchField,
    permission: d.permission,
    columns: d.columns.map((c) => ({
      header: c.header,
      key: c.key,
      type: c.enum ? 'enum' : (c.type || 'string'),
      required: !!c.required,
      options: c.enum || null,
      master: c.master || null,
    })),
    headers: d.columns.map((c) => c.header),
    sample: d.sample,
  };
}

// Validate mapped rows without writing. Shared by both /validate and the commit paths.
// `mode` is 'import' (default) or 'update' — see schemaOf for the difference.
async function validate(entity, rawRows, { ctx, mode = 'import' } = {}) {
  const d = getDescriptor(entity);
  const context = ctx || (await loadContext(d));
  const mapped = rawRows.map((r) => mapRow(d, r));
  const result = runValidation(mapped, schemaOf(d, mode), context);
  return { descriptor: d, context, ...result };
}

async function preview(entity, rawRows) {
  const { descriptor, valid, errors, summary } = await validate(entity, rawRows);
  return {
    summary,
    errors,
    preview: valid.slice(0, 50).map((v) => ({ row: v.row, ...descriptor.toExport(descriptor.toDoc(v.data, {})) })),
  };
}

async function importRows(entity, rawRows) {
  const { descriptor, context, valid, errors, summary } = await validate(entity, rawRows);
  if (valid.length) {
    const docs = valid.map((v) => ({ _ref: v.row, ...descriptor.toDoc(v.data, context) }));
    const results = await cm('bulk:insertBatch', {
      table: descriptor.table,
      docs,
      unique: descriptor.unique || [],
      serialId: !!descriptor.serialId,
    });
    for (const r of results) {
      if (r.status !== 'success') {
        summary.success--;
        summary.duplicate++;
        errors.push({ row: r.ref, column: '(commit)', value: '', expected: '', suggestion: null, error: r.error, kind: 'duplicate' });
      }
    }
  }
  errors.sort((a, b) => a.row - b.row);
  return { summary, errors };
}

async function updateRows(entity, rawRows) {
  const { descriptor, context, valid, errors, summary } = await validate(entity, rawRows, { mode: 'update' });
  let updated = 0;
  let notFound = 0;
  if (valid.length) {
    const updates = valid.map((v) => ({
      _ref: v.row,
      idVal: coerceId(descriptor, v.data[descriptor.matchField] ?? v.data[keyForMatch(descriptor)]),
      patch: descriptor.toPatch(v.data, context),
    }));
    const results = await cm('bulk:updateBatch', { table: descriptor.table, idField: descriptor.matchField, updates });
    for (const r of results) {
      if (r.status === 'success') updated++;
      else { notFound++; errors.push({ row: r.ref, column: '(update)', value: '', expected: '', suggestion: null, error: r.error, kind: 'validation' }); }
    }
  }
  errors.sort((a, b) => a.row - b.row);
  return { summary: { ...summary, success: updated, notFound }, errors };
}

async function removeByIds(entity, ids) {
  const d = getDescriptor(entity);
  const idVals = (ids || []).map((v) => coerceId(d, v));
  const res = await cm('bulk:removeBatch', {
    table: d.table,
    idField: d.matchField,
    idVals,
    cascade: d.cascade || [],
  });
  return res;
}

async function exportRows(entity) {
  const d = getDescriptor(entity);
  const rows = (await cq('generic:list', { table: d.table })).map(strip);
  return {
    headers: d.columns.map((c) => c.header),
    rows: rows.map((r) => d.toExport(r)),
  };
}

// The descriptor's matchField is a Convex (snake) field; find the mapped-row key that feeds it.
function keyForMatch(d) {
  const col = d.columns.find((c) => c.key === d.matchField || c.key === toCamel(d.matchField));
  return col ? col.key : d.matchField;
}
const toCamel = (s) => s.replace(/_([a-z])/g, (_, l) => l.toUpperCase());

function coerceId(descriptor, val) {
  if (descriptor.idType === 'number') return Number(val);
  return val === undefined || val === null ? val : String(val);
}

module.exports = { schema, preview, importRows, updateRows, removeByIds, exportRows, validate, loadContext };
