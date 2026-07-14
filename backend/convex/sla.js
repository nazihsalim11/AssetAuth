import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

// Native Convex data layer for SLA configuration: business calendars (+ holidays), SLA
// policies (+ escalation ladders). Documents keep the mirrored snake_case shape. Validation
// / normalisation stays in Node (slaRoutes.js); the pure engine and slaModel are unchanged.
// SERIAL ids are derived as max(id)+1. Escalation ladders and holiday sets are replaced as a
// whole on each write, in one transaction.

const nowIso = () => new Date().toISOString();
const lc = (s) => String(s ?? "").toLowerCase();
const strip = (d) => { if (!d) return d; const { _id, _creationTime, ...rest } = d; return rest; };
const nextId = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
const toYMD = (d) => (d == null ? null : new Date(d).toISOString().slice(0, 10));
const byId = (ctx, table, id) => ctx.db.query(table).filter((q) => q.eq(q.field("id"), id)).first();

/* ------------------------------------------------------------------ calendars */

async function holidaysFor(ctx, calendarId) {
  return (await ctx.db.query("calendar_holidays").filter((q) => q.eq(q.field("calendar_id"), calendarId)).collect())
    .map((h) => toYMD(h.holiday_date)).filter(Boolean);
}

// Replace a calendar's holiday set. Accepts [{date,name}] or ['YYYY-MM-DD'].
async function replaceHolidays(ctx, calendarId, holidays) {
  const existing = await ctx.db.query("calendar_holidays").filter((q) => q.eq(q.field("calendar_id"), calendarId)).collect();
  for (const h of existing) await ctx.db.delete(h._id);
  if (!Array.isArray(holidays)) return;
  let id = nextId(await ctx.db.query("calendar_holidays").collect());
  const seen = new Set();
  for (const h of holidays) {
    const date = typeof h === "string" ? h : h && h.date;
    if (!date || seen.has(date)) continue; // ON CONFLICT (calendar_id, holiday_date) DO NOTHING
    seen.add(date);
    await ctx.db.insert("calendar_holidays", {
      id: id++, calendar_id: calendarId, holiday_date: date,
      name: typeof h === "object" && h.name ? String(h.name) : null,
    });
  }
}

export const calendarsList = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("business_calendars").collect();
    rows.sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) || lc(a.name).localeCompare(lc(b.name)));
    return Promise.all(rows.map(async (c) => ({ ...strip(c), holidays: await holidaysFor(ctx, c.id) })));
  },
});

export const calendarCreate = mutation({
  args: { doc: v.any(), holidays: v.optional(v.any()) },
  handler: async (ctx, { doc, holidays }) => {
    const all = await ctx.db.query("business_calendars").collect();
    if (all.some((c) => lc(c.name) === lc(doc.name))) throw new ConvexError("A calendar with that name already exists.");
    const now = nowIso();
    const _id = await ctx.db.insert("business_calendars", { ...doc, id: nextId(all), created_at: now, updated_at: now });
    const cal = await ctx.db.get(_id);
    await replaceHolidays(ctx, cal.id, holidays);
    return { ...strip(cal), holidays: await holidaysFor(ctx, cal.id) };
  },
});

export const calendarUpdate = mutation({
  args: { id: v.any(), patch: v.any(), holidays: v.optional(v.any()) },
  handler: async (ctx, { id, patch, holidays }) => {
    const cal = await byId(ctx, "business_calendars", id);
    if (!cal) return null;
    if (patch.name != null && lc(patch.name) !== lc(cal.name)) {
      const all = await ctx.db.query("business_calendars").collect();
      if (all.some((c) => c._id !== cal._id && lc(c.name) === lc(patch.name))) throw new ConvexError("A calendar with that name already exists.");
    }
    const clean = {};
    for (const [k, val] of Object.entries(patch)) if (val !== undefined) clean[k] = val;
    await ctx.db.patch(cal._id, { ...clean, updated_at: nowIso() });
    if (holidays !== undefined) await replaceHolidays(ctx, cal.id, holidays);
    const saved = await ctx.db.get(cal._id);
    return { ...strip(saved), holidays: await holidaysFor(ctx, cal.id) };
  },
});

export const calendarRemove = mutation({
  args: { id: v.any() },
  handler: async (ctx, { id }) => {
    const cal = await byId(ctx, "business_calendars", id);
    if (!cal) return { notFound: true };
    const inUse = (await ctx.db.query("sla_policies").filter((q) => q.eq(q.field("calendar_id"), cal.id)).collect())
      .filter((p) => p.archived === false).length;
    if (inUse > 0) return { inUse };
    const holidays = await ctx.db.query("calendar_holidays").filter((q) => q.eq(q.field("calendar_id"), cal.id)).collect();
    for (const h of holidays) await ctx.db.delete(h._id);
    await ctx.db.delete(cal._id);
    return { success: true };
  },
});

/* ------------------------------------------------------------------ policies */

async function shapePolicy(ctx, policy) {
  const cal = policy.calendar_id != null ? await byId(ctx, "business_calendars", policy.calendar_id) : null;
  const levels = (await ctx.db.query("sla_escalation_levels").filter((q) => q.eq(q.field("policy_id"), policy.id)).collect())
    .sort((a, b) => Number(a.level) - Number(b.level));
  return { ...strip(policy), calendar_name: cal ? cal.name : null, escalation_levels: levels.map(strip) };
}

async function insertLevels(ctx, policyId, levels) {
  let id = nextId(await ctx.db.query("sla_escalation_levels").collect());
  for (const lvl of levels || []) {
    await ctx.db.insert("sla_escalation_levels", {
      id: id++, policy_id: policyId, level: lvl.level, trigger_type: lvl.triggerType,
      threshold: lvl.threshold, notify_target: lvl.notifyTarget,
    });
  }
}

export const policiesList = query({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, { includeArchived }) => {
    let rows = await ctx.db.query("sla_policies").collect();
    if (!includeArchived) rows = rows.filter((p) => p.archived === false);
    rows.sort((a, b) => Number(b.priority_rank || 0) - Number(a.priority_rank || 0) || Number(a.id) - Number(b.id));
    return Promise.all(rows.map((p) => shapePolicy(ctx, p)));
  },
});

export const policyGet = query({
  args: { id: v.any() },
  handler: async (ctx, { id }) => {
    const p = await byId(ctx, "sla_policies", id);
    return p ? shapePolicy(ctx, p) : null;
  },
});

export const policyCreate = mutation({
  args: { doc: v.any(), levels: v.optional(v.array(v.any())) },
  handler: async (ctx, { doc, levels }) => {
    const all = await ctx.db.query("sla_policies").collect();
    const now = nowIso();
    const _id = await ctx.db.insert("sla_policies", { ...doc, id: nextId(all), created_at: now, updated_at: now });
    const policy = await ctx.db.get(_id);
    await insertLevels(ctx, policy.id, levels);
    return shapePolicy(ctx, policy);
  },
});

export const policyUpdate = mutation({
  args: { id: v.any(), patch: v.any(), levels: v.optional(v.array(v.any())), replaceLevels: v.boolean() },
  handler: async (ctx, { id, patch, levels, replaceLevels }) => {
    const policy = await byId(ctx, "sla_policies", id);
    if (!policy) return null;
    const clean = {};
    for (const [k, val] of Object.entries(patch)) if (val !== undefined) clean[k] = val;
    await ctx.db.patch(policy._id, { ...clean, updated_at: nowIso() });
    if (replaceLevels) {
      const old = await ctx.db.query("sla_escalation_levels").filter((q) => q.eq(q.field("policy_id"), policy.id)).collect();
      for (const l of old) await ctx.db.delete(l._id);
      await insertLevels(ctx, policy.id, levels);
    }
    return shapePolicy(ctx, await ctx.db.get(policy._id));
  },
});

export const policyArchive = mutation({
  args: { id: v.any(), archived: v.boolean() },
  handler: async (ctx, { id, archived }) => {
    const policy = await byId(ctx, "sla_policies", id);
    if (!policy) return null;
    // Archiving also deactivates; unarchiving leaves active as-is.
    const patch = { archived, updated_at: nowIso() };
    if (archived) patch.active = false;
    await ctx.db.patch(policy._id, patch);
    return shapePolicy(ctx, await ctx.db.get(policy._id));
  },
});

export const policyRemove = mutation({
  args: { id: v.any() },
  handler: async (ctx, { id }) => {
    const policy = await byId(ctx, "sla_policies", id);
    if (!policy) return { notFound: true };
    const governs = (await ctx.db.query("tickets").filter((q) => q.eq(q.field("sla_policy_id"), policy.id)).collect()).length;
    if (governs > 0) return { governs };
    const levels = await ctx.db.query("sla_escalation_levels").filter((q) => q.eq(q.field("policy_id"), policy.id)).collect();
    for (const l of levels) await ctx.db.delete(l._id);
    await ctx.db.delete(policy._id);
    return { success: true };
  },
});
