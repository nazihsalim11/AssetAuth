/**
 * SLA Management API — CRUD for business calendars, SLA policies and their escalation
 * ladders. Everything the SLA engine consumes at runtime is editable here; nothing about
 * response/resolution times, working hours, holidays or escalation is hardcoded.
 *
 * Backed by native Convex (backend/convex/sla.js): a policy write replaces its whole
 * escalation ladder in one transaction, and a calendar write replaces its holiday set,
 * which keeps them consistent and spares the client a second round of calls. Validation /
 * normalisation stays here; the pure engine and slaModel are unchanged.
 */

const { cq, cm } = require('./convexApi');
const engine = require('./slaEngine');
const slaModel = require('./slaModel');

/* ------------------------------------------------------------------ vocab */

const AUTO_ASSIGN_STRATEGIES = ['manual', 'least_loaded', 'round_robin'];
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
// JS day-of-week: 0=Sun … 6=Sat, matching Date.getUTCDay and the engine.
const WEEKDAYS = [
  { value: 1, label: 'Monday' }, { value: 2, label: 'Tuesday' }, { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' }, { value: 5, label: 'Friday' }, { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' }
];

// Surface a ConvexError message so route handlers can map it (e.g. unique name -> 409).
function cleanErr(err) {
  if (err && err.data) return typeof err.data === 'string' ? err.data : (err.data.message || 'Operation failed.');
  const msg = (err && err.message) || 'Operation failed.';
  const m = msg.match(/Uncaught (?:Convex)?Error:\s*(.+?)(?:\n|\s+at\s|$)/);
  return m ? m[1].trim() : msg;
}

/* ---------------------------------------------------------------- mappers */

const mapCalendar = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  is24x7: row.is_24x7,
  utcOffsetMinutes: row.utc_offset_minutes,
  workStart: row.work_start,
  workEnd: row.work_end,
  workingDays: row.working_days || [],
  branch: row.branch,
  isDefault: row.is_default,
  active: row.active,
  holidays: row.holidays || [],
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapLevel = (row) => ({
  id: row.id,
  level: row.level,
  triggerType: row.trigger_type,
  threshold: Number(row.threshold),
  notifyTarget: row.notify_target
});

const mapPolicy = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  priority: row.priority,
  category: row.category,
  department: row.department,
  assetType: row.asset_type,
  branch: row.branch,
  firstResponseMinutes: row.first_response_minutes,
  resolutionMinutes: row.resolution_minutes,
  calendarId: row.calendar_id,
  calendarName: row.calendar_name || null,
  autoAssignEnabled: row.auto_assign_enabled,
  autoAssignStrategy: row.auto_assign_strategy,
  priorityRank: row.priority_rank,
  active: row.active,
  archived: row.archived,
  escalationLevels: Array.isArray(row.escalation_levels) ? row.escalation_levels.map(mapLevel) : [],
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

/* -------------------------------------------------------------- validation */

const toInt = (v, fallback = null) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

const cleanStr = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

// Validate and normalise an escalation ladder. Returns { levels, error }.
function normalizeLevels(input) {
  if (input === undefined || input === null) return { levels: [] };
  if (!Array.isArray(input)) return { error: 'escalationLevels must be an array' };
  const levels = [];
  const seen = new Set();
  input.forEach((raw, i) => {
    const level = toInt(raw.level, i + 1);
    if (seen.has(level)) return; // drop duplicate level numbers rather than erroring
    seen.add(level);
    const triggerType = String(raw.triggerType || raw.trigger_type || 'resolution_percent');
    if (!engine.ESCALATION_TRIGGERS.has(triggerType)) return;
    const notifyTarget = String(raw.notifyTarget || raw.notify_target || 'assignee');
    if (!engine.ESCALATION_TARGETS.includes(notifyTarget)) return;
    let threshold = Number(raw.threshold);
    if (!Number.isFinite(threshold)) threshold = 0;
    // Percent triggers are clamped to 0–100; breach triggers ignore threshold.
    if (triggerType.endsWith('_percent')) threshold = Math.max(0, Math.min(100, threshold));
    if (triggerType.endsWith('_remaining')) threshold = Math.max(0, threshold);
    levels.push({ level, triggerType, threshold, notifyTarget });
  });
  levels.sort((a, b) => a.level - b.level);
  return { levels };
}

function validatePolicyBody(body) {
  if (!cleanStr(body.name)) return 'Policy name is required.';
  const fr = toInt(body.firstResponseMinutes);
  const rs = toInt(body.resolutionMinutes);
  if (!Number.isFinite(fr) || fr <= 0) return 'First response time must be a positive number of minutes.';
  if (!Number.isFinite(rs) || rs <= 0) return 'Resolution time must be a positive number of minutes.';
  if (body.priority != null && body.priority !== '' && !PRIORITIES.includes(body.priority)) {
    return `Priority must be one of: ${PRIORITIES.join(', ')} (or blank for any).`;
  }
  if (body.autoAssignStrategy && !AUTO_ASSIGN_STRATEGIES.includes(body.autoAssignStrategy)) {
    return `Auto-assign strategy must be one of: ${AUTO_ASSIGN_STRATEGIES.join(', ')}.`;
  }
  return null;
}

// A calendar's stored (snake_case) shape from the request body.
const calendarDoc = (body) => ({
  name: cleanStr(body.name),
  description: cleanStr(body.description),
  is_24x7: Boolean(body.is24x7),
  utc_offset_minutes: toInt(body.utcOffsetMinutes, 330),
  work_start: cleanStr(body.workStart) || '09:00',
  work_end: cleanStr(body.workEnd) || '18:00',
  working_days: Array.isArray(body.workingDays) ? body.workingDays.map(Number) : [1, 2, 3, 4, 5],
  branch: cleanStr(body.branch),
  active: body.active === false ? false : true
});

// A policy's stored (snake_case) shape from the request body. created_by is set at create
// time only; callers drop it for updates.
const policyDoc = (body, user) => ({
  name: cleanStr(body.name),
  description: cleanStr(body.description),
  priority: cleanStr(body.priority),
  category: cleanStr(body.category),
  department: cleanStr(body.department),
  asset_type: cleanStr(body.assetType),
  branch: cleanStr(body.branch),
  first_response_minutes: toInt(body.firstResponseMinutes, 240),
  resolution_minutes: toInt(body.resolutionMinutes, 1440),
  calendar_id: toInt(body.calendarId),
  auto_assign_enabled: Boolean(body.autoAssignEnabled),
  auto_assign_strategy: cleanStr(body.autoAssignStrategy) || 'least_loaded',
  priority_rank: toInt(body.priorityRank, 0),
  active: body.active === false ? false : true,
  created_by: user.name
});

/* ------------------------------------------------------------------ routes */

function register(app, { requireUser, requirePermission }) {
  /* ------------------------------------------------------------ options */

  app.get('/api/sla/options', async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    res.json({
      priorities: PRIORITIES,
      strategies: AUTO_ASSIGN_STRATEGIES,
      weekdays: WEEKDAYS,
      escalationTriggers: [...engine.ESCALATION_TRIGGERS],
      escalationTargets: engine.ESCALATION_TARGETS
    });
  });

  /* --------------------------------------------------------- calendars */

  app.get('/api/sla/calendars', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'view');
    if (!user) return;
    try {
      const rows = await cq('sla:calendarsList', {});
      res.json(rows.map(mapCalendar));
    } catch (err) {
      console.error('GET /api/sla/calendars failed:', err);
      res.status(500).json({ error: 'Could not load calendars: ' + err.message });
    }
  });

  app.post('/api/sla/calendars', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'create');
    if (!user) return;
    const name = cleanStr(req.body.name);
    if (!name) return res.status(400).json({ error: 'Calendar name is required.' });
    try {
      const cal = await cm('sla:calendarCreate', { doc: calendarDoc(req.body), holidays: req.body.holidays });
      res.status(201).json(mapCalendar(cal));
    } catch (err) {
      const msg = cleanErr(err);
      if (/already exists/i.test(msg)) return res.status(409).json({ error: msg });
      console.error('POST /api/sla/calendars failed:', err);
      res.status(500).json({ error: 'Could not create calendar: ' + msg });
    }
  });

  app.put('/api/sla/calendars/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'edit');
    if (!user) return;
    const name = cleanStr(req.body.name);
    if (!name) return res.status(400).json({ error: 'Calendar name is required.' });
    try {
      const cal = await cm('sla:calendarUpdate', {
        id: toInt(req.params.id), patch: calendarDoc(req.body),
        holidays: req.body.holidays !== undefined ? req.body.holidays : undefined
      });
      if (!cal) return res.status(404).json({ error: 'Calendar not found' });
      res.json(mapCalendar(cal));
    } catch (err) {
      const msg = cleanErr(err);
      if (/already exists/i.test(msg)) return res.status(409).json({ error: msg });
      console.error('PUT /api/sla/calendars failed:', err);
      res.status(500).json({ error: 'Could not update calendar: ' + msg });
    }
  });

  app.delete('/api/sla/calendars/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'delete');
    if (!user) return;
    try {
      const r = await cm('sla:calendarRemove', { id: toInt(req.params.id) });
      if (r.notFound) return res.status(404).json({ error: 'Calendar not found' });
      if (r.inUse) return res.status(409).json({ error: `This calendar is used by ${r.inUse} active policy(ies). Reassign them first.` });
      res.json({ success: true });
    } catch (err) {
      console.error('DELETE /api/sla/calendars failed:', err);
      res.status(500).json({ error: 'Could not delete calendar: ' + err.message });
    }
  });

  /* ---------------------------------------------------------- policies */

  app.get('/api/sla/policies', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'view');
    if (!user) return;
    try {
      const rows = await cq('sla:policiesList', { includeArchived: req.query.includeArchived === 'true' });
      res.json(rows.map(mapPolicy));
    } catch (err) {
      console.error('GET /api/sla/policies failed:', err);
      res.status(500).json({ error: 'Could not load policies: ' + err.message });
    }
  });

  app.get('/api/sla/policies/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'view');
    if (!user) return;
    try {
      const row = await cq('sla:policyGet', { id: toInt(req.params.id) });
      if (!row) return res.status(404).json({ error: 'Policy not found' });
      res.json(mapPolicy(row));
    } catch (err) {
      console.error('GET /api/sla/policies/:id failed:', err);
      res.status(500).json({ error: 'Could not load policy: ' + err.message });
    }
  });

  app.post('/api/sla/policies', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'create');
    if (!user) return;
    const err = validatePolicyBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const { levels, error: lvlErr } = normalizeLevels(req.body.escalationLevels);
    if (lvlErr) return res.status(400).json({ error: lvlErr });
    try {
      const row = await cm('sla:policyCreate', { doc: policyDoc(req.body, user), levels });
      res.status(201).json(mapPolicy(row));
    } catch (e) {
      console.error('POST /api/sla/policies failed:', e);
      res.status(500).json({ error: 'Could not create policy: ' + e.message });
    }
  });

  app.put('/api/sla/policies/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'edit');
    if (!user) return;
    const err = validatePolicyBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const { levels, error: lvlErr } = normalizeLevels(req.body.escalationLevels);
    if (lvlErr) return res.status(400).json({ error: lvlErr });
    try {
      // created_by is set at creation only; drop it from the update.
      const { created_by, ...patch } = policyDoc(req.body, user);
      const row = await cm('sla:policyUpdate', {
        id: toInt(req.params.id), patch, levels, replaceLevels: req.body.escalationLevels !== undefined
      });
      if (!row) return res.status(404).json({ error: 'Policy not found' });
      res.json(mapPolicy(row));
    } catch (e) {
      console.error('PUT /api/sla/policies failed:', e);
      res.status(500).json({ error: 'Could not update policy: ' + e.message });
    }
  });

  // Archive (soft) vs delete (hard). Archiving keeps historical tickets' policy link intact
  // while removing it from matching; deleting is only offered for policies that never
  // governed a ticket.
  app.post('/api/sla/policies/:id/archive', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'edit');
    if (!user) return;
    try {
      const row = await cm('sla:policyArchive', { id: toInt(req.params.id), archived: req.body.archived === false ? false : true });
      if (!row) return res.status(404).json({ error: 'Policy not found' });
      res.json(mapPolicy(row));
    } catch (err) {
      console.error('POST /api/sla/policies/:id/archive failed:', err);
      res.status(500).json({ error: 'Could not archive policy: ' + err.message });
    }
  });

  app.delete('/api/sla/policies/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'delete');
    if (!user) return;
    try {
      const r = await cm('sla:policyRemove', { id: toInt(req.params.id) });
      if (r.notFound) return res.status(404).json({ error: 'Policy not found' });
      if (r.governs) return res.status(409).json({ error: `This policy governs ${r.governs} ticket(s). Archive it instead of deleting.` });
      res.json({ success: true });
    } catch (err) {
      console.error('DELETE /api/sla/policies failed:', err);
      res.status(500).json({ error: 'Could not delete policy: ' + err.message });
    }
  });

  /* ------------------------------------------------- preview / simulate */

  // Given a hypothetical ticket, return the policy that would match and the deadlines it
  // would produce. Powers the "test your configuration" panel in the SLA UI.
  app.post('/api/sla/preview', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'view');
    if (!user) return;
    try {
      const at = req.body.createdAt ? new Date(req.body.createdAt) : new Date();
      const result = await slaModel.computeDeadlines({
        priority: cleanStr(req.body.priority),
        category: cleanStr(req.body.category),
        department: cleanStr(req.body.department),
        assetType: cleanStr(req.body.assetType),
        branch: cleanStr(req.body.branch)
      }, at);
      res.json({
        matched: result.policy ? mapPolicy(await cq('sla:policyGet', { id: result.policyId })) : null,
        createdAt: at,
        firstResponseDue: result.firstResponseDue,
        resolutionDue: result.resolutionDue
      });
    } catch (err) {
      console.error('POST /api/sla/preview failed:', err);
      res.status(500).json({ error: 'Could not preview SLA: ' + err.message });
    }
  });
}

module.exports = { register, AUTO_ASSIGN_STRATEGIES, PRIORITIES, mapPolicy, mapCalendar };
