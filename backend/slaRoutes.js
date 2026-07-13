/**
 * SLA Management API — CRUD for business calendars, SLA policies and their escalation
 * ladders. Everything the SLA engine consumes at runtime is editable here; nothing about
 * response/resolution times, working hours, holidays or escalation is hardcoded.
 *
 * Escalation levels are owned by their policy and edited as a set: a policy write
 * replaces its whole ladder in one transaction, which keeps the levels consistent and
 * spares the client a second round of calls.
 */

const db = require('./db');
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

/* ------------------------------------------------------------ data loading */

// Policies with their calendar name and full escalation ladder, in one round trip.
async function loadPolicies({ includeArchived } = {}, client = db) {
  const { rows } = await client.query(
    `SELECT p.*, c.name AS calendar_name,
            COALESCE(
              (SELECT json_agg(e ORDER BY e.level)
               FROM sla_escalation_levels e WHERE e.policy_id = p.id),
              '[]'
            ) AS escalation_levels
     FROM sla_policies p
     LEFT JOIN business_calendars c ON c.id = p.calendar_id
     ${includeArchived ? '' : 'WHERE p.archived = FALSE'}
     ORDER BY p.priority_rank DESC, p.id ASC`
  );
  return rows;
}

async function loadOnePolicy(id, client = db) {
  const { rows } = await client.query(
    `SELECT p.*, c.name AS calendar_name,
            COALESCE(
              (SELECT json_agg(e ORDER BY e.level)
               FROM sla_escalation_levels e WHERE e.policy_id = p.id),
              '[]'
            ) AS escalation_levels
     FROM sla_policies p
     LEFT JOIN business_calendars c ON c.id = p.calendar_id
     WHERE p.id = $1`,
    [id]
  );
  return rows[0] || null;
}

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
      const { rows } = await db.query('SELECT * FROM business_calendars ORDER BY is_default DESC, LOWER(name)');
      const withHolidays = await Promise.all(rows.map((c) => slaModel.attachHolidays(c)));
      res.json(withHolidays.map(mapCalendar));
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
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO business_calendars (name, description, is_24x7, utc_offset_minutes, work_start, work_end, working_days, branch, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          name, cleanStr(req.body.description), Boolean(req.body.is24x7),
          toInt(req.body.utcOffsetMinutes, 330), cleanStr(req.body.workStart) || '09:00',
          cleanStr(req.body.workEnd) || '18:00',
          Array.isArray(req.body.workingDays) ? req.body.workingDays.map(Number) : [1, 2, 3, 4, 5],
          cleanStr(req.body.branch), req.body.active === false ? false : true
        ]
      );
      const cal = ins.rows[0];
      await replaceHolidays(client, cal.id, req.body.holidays);
      await client.query('COMMIT');
      const withHolidays = await slaModel.attachHolidays(cal);
      res.status(201).json(mapCalendar(withHolidays));
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('POST /api/sla/calendars failed:', err);
      if (err.code === '23505') return res.status(409).json({ error: 'A calendar with that name already exists.' });
      res.status(500).json({ error: 'Could not create calendar: ' + err.message });
    } finally {
      client.release();
    }
  });

  app.put('/api/sla/calendars/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'edit');
    if (!user) return;
    const id = toInt(req.params.id);
    const name = cleanStr(req.body.name);
    if (!name) return res.status(400).json({ error: 'Calendar name is required.' });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE business_calendars
         SET name=$1, description=$2, is_24x7=$3, utc_offset_minutes=$4, work_start=$5, work_end=$6,
             working_days=$7, branch=$8, active=$9, updated_at=NOW()
         WHERE id=$10 RETURNING *`,
        [
          name, cleanStr(req.body.description), Boolean(req.body.is24x7),
          toInt(req.body.utcOffsetMinutes, 330), cleanStr(req.body.workStart) || '09:00',
          cleanStr(req.body.workEnd) || '18:00',
          Array.isArray(req.body.workingDays) ? req.body.workingDays.map(Number) : [1, 2, 3, 4, 5],
          cleanStr(req.body.branch), req.body.active === false ? false : true, id
        ]
      );
      if (upd.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Calendar not found' }); }
      if (req.body.holidays !== undefined) await replaceHolidays(client, id, req.body.holidays);
      await client.query('COMMIT');
      const withHolidays = await slaModel.attachHolidays(upd.rows[0]);
      res.json(mapCalendar(withHolidays));
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('PUT /api/sla/calendars failed:', err);
      if (err.code === '23505') return res.status(409).json({ error: 'A calendar with that name already exists.' });
      res.status(500).json({ error: 'Could not update calendar: ' + err.message });
    } finally {
      client.release();
    }
  });

  app.delete('/api/sla/calendars/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'delete');
    if (!user) return;
    const id = toInt(req.params.id);
    try {
      const inUse = await db.query('SELECT COUNT(*)::int AS c FROM sla_policies WHERE calendar_id = $1 AND archived = FALSE', [id]);
      if (inUse.rows[0].c > 0) {
        return res.status(409).json({ error: `This calendar is used by ${inUse.rows[0].c} active policy(ies). Reassign them first.` });
      }
      const del = await db.query('DELETE FROM business_calendars WHERE id = $1 RETURNING id', [id]);
      if (del.rowCount === 0) return res.status(404).json({ error: 'Calendar not found' });
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
      const rows = await loadPolicies({ includeArchived: req.query.includeArchived === 'true' });
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
      const row = await loadOnePolicy(toInt(req.params.id));
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

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO sla_policies
           (name, description, priority, category, department, asset_type, branch,
            first_response_minutes, resolution_minutes, calendar_id,
            auto_assign_enabled, auto_assign_strategy, priority_rank, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        policyParams(req.body, user)
      );
      const policyId = ins.rows[0].id;
      await insertLevels(client, policyId, levels);
      await client.query('COMMIT');
      const row = await loadOnePolicy(policyId);
      res.status(201).json(mapPolicy(row));
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('POST /api/sla/policies failed:', e);
      res.status(500).json({ error: 'Could not create policy: ' + e.message });
    } finally {
      client.release();
    }
  });

  app.put('/api/sla/policies/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'edit');
    if (!user) return;
    const id = toInt(req.params.id);
    const err = validatePolicyBody(req.body);
    if (err) return res.status(400).json({ error: err });
    const { levels, error: lvlErr } = normalizeLevels(req.body.escalationLevels);
    if (lvlErr) return res.status(400).json({ error: lvlErr });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      // created_by is set at creation only, so drop it from the update param list.
      const p = policyParams(req.body, user).slice(0, 14);
      const upd = await client.query(
        `UPDATE sla_policies SET
           name=$1, description=$2, priority=$3, category=$4, department=$5, asset_type=$6, branch=$7,
           first_response_minutes=$8, resolution_minutes=$9, calendar_id=$10,
           auto_assign_enabled=$11, auto_assign_strategy=$12, priority_rank=$13, active=$14,
           updated_at=NOW()
         WHERE id=$15 RETURNING id`,
        [...p, id]
      );
      if (upd.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Policy not found' }); }
      if (req.body.escalationLevels !== undefined) {
        await client.query('DELETE FROM sla_escalation_levels WHERE policy_id = $1', [id]);
        await insertLevels(client, id, levels);
      }
      await client.query('COMMIT');
      const row = await loadOnePolicy(id);
      res.json(mapPolicy(row));
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('PUT /api/sla/policies failed:', e);
      res.status(500).json({ error: 'Could not update policy: ' + e.message });
    } finally {
      client.release();
    }
  });

  // Archive (soft) vs delete (hard). Archiving keeps historical tickets' policy link
  // intact while removing it from matching; deleting is only offered for policies that
  // never governed a ticket.
  app.post('/api/sla/policies/:id/archive', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'edit');
    if (!user) return;
    const id = toInt(req.params.id);
    const archived = req.body.archived === false ? false : true;
    try {
      const upd = await db.query(
        'UPDATE sla_policies SET archived=$1, active = CASE WHEN $1 THEN FALSE ELSE active END, updated_at=NOW() WHERE id=$2 RETURNING id',
        [archived, id]
      );
      if (upd.rowCount === 0) return res.status(404).json({ error: 'Policy not found' });
      const row = await loadOnePolicy(id);
      res.json(mapPolicy(row));
    } catch (err) {
      console.error('POST /api/sla/policies/:id/archive failed:', err);
      res.status(500).json({ error: 'Could not archive policy: ' + err.message });
    }
  });

  app.delete('/api/sla/policies/:id', async (req, res) => {
    const user = await requirePermission(req, res, 'sla', 'delete');
    if (!user) return;
    const id = toInt(req.params.id);
    try {
      const used = await db.query('SELECT COUNT(*)::int AS c FROM tickets WHERE sla_policy_id = $1', [id]);
      if (used.rows[0].c > 0) {
        return res.status(409).json({ error: `This policy governs ${used.rows[0].c} ticket(s). Archive it instead of deleting.` });
      }
      const del = await db.query('DELETE FROM sla_policies WHERE id = $1 RETURNING id', [id]);
      if (del.rowCount === 0) return res.status(404).json({ error: 'Policy not found' });
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
        matched: result.policy ? mapPolicy(await loadOnePolicy(result.policyId)) : null,
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

/* --------------------------------------------------------------- helpers */

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

function policyParams(body, user) {
  return [
    cleanStr(body.name), cleanStr(body.description), cleanStr(body.priority), cleanStr(body.category),
    cleanStr(body.department), cleanStr(body.assetType), cleanStr(body.branch),
    toInt(body.firstResponseMinutes, 240), toInt(body.resolutionMinutes, 1440),
    toInt(body.calendarId), Boolean(body.autoAssignEnabled),
    cleanStr(body.autoAssignStrategy) || 'least_loaded', toInt(body.priorityRank, 0),
    body.active === false ? false : true, user.name
  ];
}

async function insertLevels(client, policyId, levels) {
  for (const lvl of levels) {
    await client.query(
      `INSERT INTO sla_escalation_levels (policy_id, level, trigger_type, threshold, notify_target)
       VALUES ($1,$2,$3,$4,$5)`,
      [policyId, lvl.level, lvl.triggerType, lvl.threshold, lvl.notifyTarget]
    );
  }
}

// Replace a calendar's holiday set. Accepts [{date,name}] or ['YYYY-MM-DD'].
async function replaceHolidays(client, calendarId, holidays) {
  await client.query('DELETE FROM calendar_holidays WHERE calendar_id = $1', [calendarId]);
  if (!Array.isArray(holidays)) return;
  for (const h of holidays) {
    const date = typeof h === 'string' ? h : h && h.date;
    if (!date) continue;
    await client.query(
      `INSERT INTO calendar_holidays (calendar_id, holiday_date, name)
       VALUES ($1,$2,$3) ON CONFLICT (calendar_id, holiday_date) DO NOTHING`,
      [calendarId, date, typeof h === 'object' ? cleanStr(h.name) : null]
    );
  }
}

module.exports = { register, AUTO_ASSIGN_STRATEGIES, PRIORITIES, mapPolicy, mapCalendar };
