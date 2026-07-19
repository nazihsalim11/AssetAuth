/**
 * Approval-rule engine — configurable ladders, in the database, for every request type.
 *
 * Nothing here knows what a purchase request is. A rule matches on facts a request type
 * publishes about itself (`descriptor.matchContext`) — department, amount, priority,
 * category, request type — and produces the approver ladder the shared engine then runs.
 * Add a rule row and a purchase request over ₹5,00,000 needs three signatures; no code
 * changes, and the same mechanism is available to every other type.
 *
 * A stored rule:
 *   id            integer
 *   name          display name, e.g. "IT purchases over ₹1,00,000"
 *   request_type  the type it applies to, or null for any type
 *   active        false takes it out of play without deleting the audit of what it was
 *   match         { departments[], priorities[], categories[], minAmount, maxAmount }
 *                 every present criterion must match; an absent one matches anything
 *   levels        [{ level, mode, roles: [], userIds: [] }] — the ladder to build, in order.
 *                 Entries at ascending levels = sequential approval. Several approvers on one
 *                 level = parallel approval, and `mode` says how that level clears:
 *                   'all' (default) every one of them must sign
 *                   'any'           the first approval carries it — a quorum of one, for
 *                                   "any duty manager" rather than "both of them".
 *
 * Selection: the most *specific* matching rule wins — the one that had to satisfy the most
 * criteria to match. A general "everything needs a manager" rule and a narrow "IT over a
 * lakh needs the CFO too" rule can therefore coexist without ordering games, and the narrow
 * one wins where it applies. Ties break on the lower id, so the outcome is deterministic.
 */

const { cq, cm } = require('../../convexApi');

const TABLE = 'approval_rules';

const err = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && x !== '') : []);

const eqi = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

const strip = ({ _id, _creationTime, ...rest }) => rest;

const list = async () => {
  const rows = await cq('generic:list', { table: TABLE });
  return rows.map(strip).sort((a, b) => Number(a.id) - Number(b.id));
};

/* ------------------------------------------------------------------ matching */

/**
 * Does this rule apply, and how specifically? Returns null for no match, otherwise the
 * number of criteria it actually had to satisfy.
 */
function score(rule, context) {
  if (rule.active === false) return null;
  if (rule.request_type && rule.request_type !== context.requestType) return null;

  const match = rule.match || {};
  let specificity = rule.request_type ? 1 : 0;

  const departments = asArray(match.departments);
  if (departments.length) {
    if (!departments.some((d) => eqi(d, context.department))) return null;
    specificity += 1;
  }

  const priorities = asArray(match.priorities);
  if (priorities.length) {
    if (!priorities.some((p) => eqi(p, context.priority))) return null;
    specificity += 1;
  }

  // A request carries a set of categories (one purchase request can span several); the rule
  // applies if any of them falls in its list. Requiring all of them would mean a mixed
  // request quietly escaping a rule meant to catch exactly that category.
  const categories = asArray(match.categories);
  if (categories.length) {
    const own = asArray(context.categories);
    if (!own.some((c) => categories.some((r) => eqi(r, c)))) return null;
    specificity += 1;
  }

  const amount = Number(context.amount ?? 0);
  if (match.minAmount !== null && match.minAmount !== undefined && match.minAmount !== '') {
    if (!(amount >= Number(match.minAmount))) return null;
    specificity += 1;
  }
  if (match.maxAmount !== null && match.maxAmount !== undefined && match.maxAmount !== '') {
    if (!(amount <= Number(match.maxAmount))) return null;
    specificity += 1;
  }

  return specificity;
}

/** The rule that governs a request, or null when none does. */
async function match(context, rules) {
  const all = rules || (await list());
  let best = null;
  let bestScore = -1;
  for (const rule of all) {
    const s = score(rule, context);
    if (s === null) continue;
    if (s > bestScore) { best = rule; bestScore = s; }
  }
  return best;
}

/* ------------------------------------------------------------------ ladders */

/**
 * Expand a matched rule into the approver list the engine's `buildLadder` consumes.
 *
 * A level names roles, explicit users, or both. Roles are resolved against the live user
 * list, so a rule keeps working when the person holding a role changes — which is the whole
 * point of configuring by role rather than by name.
 *
 * The requester is filtered out of their own ladder. Self-approval would make the module
 * theatre, and a rule that names the requester's own role is a configuration mistake, not an
 * instruction to skip approval.
 */
function expand(rule, users, requester) {
  const out = [];
  for (const [index, level] of (rule.levels || []).entries()) {
    const roles = asArray(level.roles);
    const userIds = asArray(level.userIds).map(String);
    const chosen = users.filter(
      (u) => (userIds.includes(String(u.id)) || roles.some((r) => eqi(r, u.role)))
        && String(u.id) !== String(requester?.id)
    );
    for (const u of chosen) {
      out.push({
        level: Number(level.level) || index + 1,
        mode: level.mode === 'any' ? 'any' : 'all',
        userId: String(u.id),
        userName: u.name,
      });
    }
  }
  return out;
}

/**
 * Resolve the ladder for one request. Returns [] when no rule matches, which is the caller's
 * signal to fall back to its default approver policy.
 */
async function resolve(context, { users, requester }) {
  const rule = await match(context);
  if (!rule) return { rule: null, approvers: [] };
  return { rule, approvers: expand(rule, users, requester) };
}

/* --------------------------------------------------------------------- CRUD */

function validateRule(body) {
  if (!body?.name || !String(body.name).trim()) throw err('A rule name is required');
  const levels = Array.isArray(body.levels) ? body.levels : [];
  if (!levels.length) throw err('A rule needs at least one approval level');
  for (const [index, level] of levels.entries()) {
    if (!asArray(level.roles).length && !asArray(level.userIds).length) {
      throw err(`Level ${index + 1} names no approver — pick a role or a user`);
    }
    if (level.mode && !['all', 'any'].includes(level.mode)) {
      throw err(`Level ${index + 1}: mode must be "all" (everyone signs) or "any" (first approval carries it)`);
    }
  }
  const { minAmount, maxAmount } = body.match || {};
  if (minAmount != null && minAmount !== '' && maxAmount != null && maxAmount !== ''
    && Number(minAmount) > Number(maxAmount)) {
    throw err('The minimum amount cannot be greater than the maximum');
  }
  return {
    name: String(body.name).trim(),
    description: body.description ? String(body.description).trim() : null,
    request_type: body.requestType || null,
    active: body.active !== false,
    match: {
      departments: asArray(body.match?.departments),
      priorities: asArray(body.match?.priorities),
      categories: asArray(body.match?.categories),
      minAmount: body.match?.minAmount === '' || body.match?.minAmount == null ? null : Number(body.match.minAmount),
      maxAmount: body.match?.maxAmount === '' || body.match?.maxAmount == null ? null : Number(body.match.maxAmount),
    },
    levels: levels.map((level, index) => ({
      level: Number(level.level) || index + 1,
      mode: level.mode === 'any' ? 'any' : 'all',
      roles: asArray(level.roles),
      userIds: asArray(level.userIds).map(String),
    })),
  };
}

async function create(body, user) {
  const doc = validateRule(body);
  const rows = await list();
  // ponytail: next-id from the current max, not a reserved sequence. Rules are written by
  // administrators one at a time; move to idGenerator.reserve if that ever stops being true.
  return cm('generic:insert', {
    table: TABLE,
    document: {
      ...doc,
      id: rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1,
      created_by: user?.name || null,
      created_at: new Date().toISOString(),
    },
  });
}

async function update(id, body) {
  const doc = validateRule(body);
  return cm('generic:update', {
    table: TABLE,
    idField: 'id',
    idVal: Number(id),
    patch: { ...doc, updated_at: new Date().toISOString() },
  });
}

const remove = (id) => cm('generic:remove', { table: TABLE, idField: 'id', idVal: Number(id) });

module.exports = { list, match, score, expand, resolve, create, update, remove, validateRule, TABLE };
