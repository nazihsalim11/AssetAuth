/**
 * Reusable entity-ID generation service.
 *
 * Wraps the generic Convex counter (backend/convex/idSequences.js) with a small per-entity
 * registry describing where each entity's ids live and how they are formatted. Adding ID
 * generation for a new entity is one registry entry — no new code, no new endpoint.
 *
 *   peek(entity)      -> { nextId, number, prefix, padding }   preview, does NOT consume
 *   reserve(entity)   -> { nextId, number, prefix, padding }   atomic, race-safe, consumes
 *   getConfig(entity) -> stored { prefix, padding, next_number } | defaults
 *   configure(entity, { prefix, padding, nextNumber })
 */

const { cq, cm } = require('../../convexApi');

// entity -> { table, field, prefix, padding, label }
// table/field say where existing ids live (so "next from highest existing" works even for
// hand-entered rows); prefix/padding are the default format until reconfigured. Adding ID
// generation for another entity is one line here — no new code or endpoint.
const REGISTRY = {
  employee: { table: 'users', field: 'employee_id', prefix: 'EMP', padding: 4, label: 'Employee' },
  asset:    { table: 'assets', field: 'id', prefix: 'AST', padding: 4, label: 'Asset' },
};

function descriptorFor(entity) {
  const d = REGISTRY[entity];
  if (!d) {
    const err = new Error(`Unknown ID entity "${entity}". Known: ${Object.keys(REGISTRY).join(', ')}.`);
    err.statusCode = 404;
    throw err;
  }
  return d;
}

const argsFor = (entity) => {
  const { table, field, prefix, padding } = descriptorFor(entity);
  return { entity, table, field, prefix, padding };
};

async function peek(entity) {
  return cq('idSequences:peek', argsFor(entity));
}

async function reserve(entity) {
  return cm('idSequences:reserve', argsFor(entity));
}

async function getConfig(entity) {
  const { prefix, padding } = descriptorFor(entity);
  const stored = await cq('idSequences:config', { entity });
  return stored || { entity, prefix, padding, next_number: 1, defaulted: true };
}

async function configure(entity, { prefix, padding, nextNumber } = {}) {
  descriptorFor(entity); // validates entity
  return cm('idSequences:configure', {
    entity,
    ...(prefix !== undefined ? { prefix } : {}),
    ...(padding !== undefined ? { padding: Number(padding) } : {}),
    ...(nextNumber !== undefined ? { nextNumber: Number(nextNumber) } : {}),
  });
}

module.exports = { peek, reserve, getConfig, configure, REGISTRY, descriptorFor };
