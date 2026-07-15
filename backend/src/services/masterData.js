/**
 * Reusable master-data lookup service.
 *
 * One place that knows how to load every master list (Departments, Locations, Vendors,
 * Categories, …) regardless of which Convex module actually stores it. Everything that needs
 * master data — the import validation engine, the bulk framework's FK resolution, and the
 * dropdown data endpoints — goes through here instead of re-deriving the source each time.
 *
 * Each source yields rows with at least { id, name }. Helpers then expose them as:
 *   getList(name)  -> [{ id, name }]                 (for dropdowns / export)
 *   getSet(name)   -> Set of lowercased names        (for "does this value exist" checks)
 *   getNames(name) -> [name]                          (canonical casing, for suggestions)
 *   getMap(name)   -> Map(lowercased name -> row)     (for resolving a name to its id)
 */

const { cq } = require('../../convexApi');

const lc = (s) => String(s ?? '').trim().toLowerCase();

// name -> loader returning rows with { id, name }. Adding a new master is one line here.
const SOURCES = {
  departments: () => cq('masters:list', { table: 'departments' }),
  locations: () => cq('masters:list', { table: 'locations' }),
  vendors: () => cq('purchaseOrders:vendorList', { includeInactive: true }),
  kbCategories: () => cq('knowledgeBase:categories', {}),
};

function assertKnown(name) {
  if (!SOURCES[name]) {
    throw new Error(`Unknown master "${name}". Known: ${Object.keys(SOURCES).join(', ')}.`);
  }
}

async function getList(name) {
  assertKnown(name);
  const rows = await SOURCES[name]();
  return rows.map((r) => ({ ...r, id: r.id, name: r.name }));
}

async function getSet(name) {
  const rows = await getList(name);
  return new Set(rows.map((r) => lc(r.name)).filter(Boolean));
}

async function getNames(name) {
  const rows = await getList(name);
  return rows.map((r) => r.name).filter(Boolean);
}

async function getMap(name) {
  const rows = await getList(name);
  const map = new Map();
  for (const r of rows) if (r.name) map.set(lc(r.name), r);
  return map;
}

module.exports = { getList, getSet, getNames, getMap, SOURCES, isKnown: (n) => !!SOURCES[n] };
