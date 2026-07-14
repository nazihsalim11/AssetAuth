import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Live dashboard aggregates, reimplemented natively over Convex. Every figure is computed
 * from the mirrored tables on request — nothing cached — so dashboards reflect current
 * state. The old dashboards.js ran these as one big SQL query per figure (COUNT FILTER,
 * GROUP BY, EXTRACT(EPOCH ...)); here we collect() the rows and fold them in JS.
 *
 * Department scoping is decided by the caller (the Node route knows the user's role) and
 * passed in as `department`; `from`/`to` bound created_at. All three are optional.
 */

/* ------------------------------------------------------------------ helpers */

const num = (v) => (v == null ? 0 : Number(v));
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const round1 = (v) => (v == null ? null : Math.round(Number(v) * 10) / 10);

const dayKey = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : null);
const todayUTC = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

// Filter tickets to the requested department + created_at window.
function scopeTickets(rows, { department, from, to }) {
  return rows.filter((r) => {
    if (department && r.department !== department) return false;
    if (from && !(new Date(r.created_at) >= new Date(from))) return false;
    if (to && !(new Date(r.created_at) <= new Date(to))) return false;
    return true;
  });
}

// COALESCE(col, 'Unspecified') group-count, ordered by count desc (matches the old
// `GROUP BY 1 ORDER BY c DESC`). Only NULL becomes 'Unspecified'; empty strings stay.
function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key] == null ? "Unspecified" : String(r[key]);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
}

// Average of (endField - startField) in hours, over rows where endField is set.
function avgHours(rows, endField, startField = "created_at") {
  let sum = 0, n = 0;
  for (const r of rows) {
    if (r[endField] && r[startField]) {
      sum += (new Date(r[endField]) - new Date(r[startField])) / 3600000;
      n++;
    }
  }
  return n ? sum / n : null;
}

const CLOSED = new Set(["Resolved", "Closed"]);
const scopeArgs = {
  department: v.optional(v.string()),
  from: v.optional(v.string()),
  to: v.optional(v.string()),
};

/* ------------------------------------------------------------ ticket dashboard */

export const tickets = query({
  args: scopeArgs,
  handler: async (ctx, args) => {
    const rows = scopeTickets(await ctx.db.query("tickets").collect(), args);

    const counts = {
      total: rows.length,
      open: rows.filter((r) => r.status === "Open").length,
      inProgress: rows.filter((r) => r.status === "In Progress").length,
      pending: rows.filter((r) => ["Pending", "On Hold", "Waiting for Employee"].includes(r.status)).length,
      resolved: rows.filter((r) => r.status === "Resolved").length,
      closed: rows.filter((r) => r.status === "Closed").length,
      reopened: rows.filter((r) => r.status === "Reopened").length,
      unassigned: rows.filter((r) => r.assigned_to == null && !CLOSED.has(r.status)).length,
      assigned: rows.filter((r) => r.assigned_to != null).length,
    };

    // 30-day trend: created vs resolved per day, gap-filled from a 30-day series.
    const cutoff = addDays(todayUTC(), -29);
    const createdMap = {}, resolvedMap = {};
    for (const r of rows) {
      if (r.created_at && new Date(r.created_at) >= cutoff) {
        const k = dayKey(r.created_at);
        createdMap[k] = (createdMap[k] || 0) + 1;
      }
      if (r.resolved_at && new Date(r.resolved_at) >= cutoff) {
        const k = dayKey(r.resolved_at);
        resolvedMap[k] = (resolvedMap[k] || 0) + 1;
      }
    }
    const trend = [];
    for (let n = 29; n >= 0; n--) {
      const day = dayKey(addDays(todayUTC(), -n));
      trend.push({ date: day, created: createdMap[day] || 0, resolved: resolvedMap[day] || 0 });
    }

    return {
      counts,
      avgResolutionHours: round1(avgHours(rows, "resolved_at")),
      avgFirstResponseHours: round1(avgHours(rows, "first_response_at")),
      byPriority: groupBy(rows, "priority"),
      byCategory: groupBy(rows, "category"),
      byDepartment: groupBy(rows, "department"),
      byBranch: groupBy(rows, "branch"),
      trend,
    };
  },
});

/* --------------------------------------------------------------- sla dashboard */

export const sla = query({
  args: scopeArgs,
  handler: async (ctx, args) => {
    const rows = scopeTickets(await ctx.db.query("tickets").collect(), args);

    const settings = await ctx.db
      .query("notification_settings")
      .withIndex("by_original_id", (q) => q.eq("id", 1))
      .first();
    const warnHours = settings?.sla_warning_hours ?? 8;

    const now = Date.now();
    const closed = rows.filter((r) => CLOSED.has(r.status));
    const responded = rows.filter((r) => r.first_response_at != null);

    const counts = {
      withSla: rows.filter((r) => r.resolution_due != null).length,
      closedTotal: closed.length,
      breachedOpen: rows.filter((r) => !CLOSED.has(r.status) && r.resolution_due && new Date(r.resolution_due).getTime() < now).length,
      resolutionBreached: rows.filter((r) => !!r.resolution_breached).length,
      responseBreached: rows.filter((r) => !!r.response_breached).length,
      // approaching breach: open, not yet due, due within the warning window.
      approaching: rows.filter((r) => {
        if (CLOSED.has(r.status) || !r.resolution_due) return false;
        const due = new Date(r.resolution_due).getTime();
        return due > now && due <= now + warnHours * 3600000;
      }).length,
      escalated: rows.filter((r) => num(r.escalation_level) > 0).length,
    };

    const resolvedOnTime = closed.filter((r) => !r.resolution_breached).length;
    const respondedOnTime = responded.filter((r) => !r.response_breached).length;

    // escalations by level (level > 0), ascending by level.
    const levelMap = new Map();
    for (const r of rows) {
      const lvl = num(r.escalation_level);
      if (lvl > 0) levelMap.set(lvl, (levelMap.get(lvl) || 0) + 1);
    }
    const escalationsByLevel = {};
    for (const lvl of [...levelMap.keys()].sort((a, b) => a - b)) escalationsByLevel[`L${lvl}`] = levelMap.get(lvl);

    return {
      compliance: {
        resolution: pct(resolvedOnTime, closed.length),
        response: pct(respondedOnTime, responded.length),
      },
      counts,
      avgResponseHours: round1(avgHours(rows, "first_response_at")),
      avgResolutionHours: round1(avgHours(rows, "resolved_at")),
      escalationsByLevel,
      warningHours: warnHours,
    };
  },
});

/* -------------------------------------------------------- technician dashboard */

export const technicians = query({
  args: scopeArgs,
  handler: async (ctx, args) => {
    const rows = scopeTickets(await ctx.db.query("tickets").collect(), args)
      .filter((r) => r.assigned_to != null);

    const users = await ctx.db.query("users").collect();
    const userMap = new Map(users.map((u) => [u.workos_user_id, u]));

    // Aggregate per assignee (the old GROUP BY t.assigned_to). The original used an INNER
    // JOIN to users, so tickets assigned to a since-deleted user are dropped.
    const byTech = new Map();
    for (const r of rows) {
      if (!userMap.has(r.assigned_to)) continue;
      let t = byTech.get(r.assigned_to);
      if (!t) {
        const u = userMap.get(r.assigned_to);
        t = {
          id: r.assigned_to, name: u.name, department: u.department, role: u.role,
          assigned: 0, resolved: 0, openWorkload: 0, resolvedOnTime: 0, escalated: 0,
          resSum: 0, resN: 0,
        };
        byTech.set(r.assigned_to, t);
      }
      t.assigned++;
      const isClosed = CLOSED.has(r.status);
      if (isClosed) { t.resolved++; if (!r.resolution_breached) t.resolvedOnTime++; }
      else t.openWorkload++;
      if (num(r.escalation_level) > 0) t.escalated++;
      if (r.resolved_at) { t.resSum += (new Date(r.resolved_at) - new Date(r.created_at)) / 3600000; t.resN++; }
    }

    const technicians = [...byTech.values()].map((t) => ({
      id: t.id, name: t.name, department: t.department, role: t.role,
      assigned: t.assigned, resolved: t.resolved, openWorkload: t.openWorkload,
      escalated: t.escalated,
      avgResolutionHours: t.resN ? round1(t.resSum / t.resN) : null,
      slaCompliance: pct(t.resolvedOnTime, t.resolved),
    }));

    // Ranking: most resolved, then best SLA compliance, then lightest current load.
    technicians.sort((a, b) =>
      b.resolved - a.resolved ||
      (b.slaCompliance ?? -1) - (a.slaCompliance ?? -1) ||
      a.openWorkload - b.openWorkload
    );
    technicians.forEach((t, i) => { t.rank = i + 1; });

    return { technicians };
  },
});

/* -------------------------------------------------------------- asset dashboard */

const assigned = (r) => {
  const e = r.assigned_employee;
  return e != null && String(e).trim() !== "" && e !== "Inventory";
};

export const assets = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("assets").collect();
    const live = all.filter((r) => r.status !== "Disposed");

    const today = todayUTC();
    const in90 = addDays(today, 90);
    const warranty = (r) => (r.warranty_expiry ? new Date(r.warranty_expiry) : null);
    const low = (r) => num(r.reorder_level) > 0 && num(r.available_quantity) <= num(r.reorder_level);

    const counts = {
      total: live.length,
      assigned: live.filter(assigned).length,
      unassigned: live.filter((r) => !assigned(r)).length,
      totalUnits: live.reduce((s, r) => s + num(r.total_quantity), 0),
      assignedUnits: live.reduce((s, r) => s + num(r.assigned_quantity), 0),
      availableUnits: live.reduce((s, r) => s + num(r.available_quantity), 0),
      warrantyExpiring: live.filter((r) => { const w = warranty(r); return w && w > today && w <= in90; }).length,
      warrantyExpired: live.filter((r) => { const w = warranty(r); return w && w < today; }).length,
      amcExpiring: 0, // filled below
      lowInventory: live.filter(low).length,
    };

    const amcs = await ctx.db.query("amcs").collect();
    counts.amcExpiring = amcs.filter((m) => {
      if (!m.end_date) return false;
      const e = new Date(m.end_date);
      return e > today && e <= in90;
    }).length;

    // Most recently registered (created_at desc, nulls last), top 6.
    const recentlyAdded = [...all]
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
      .slice(0, 6)
      .map((r) => ({
        id: r.id, name: r.name, category: r.category, department: r.department,
        status: r.status, createdAt: r.created_at,
      }));

    // Items at/below reorder level (available asc), top 8.
    const lowStock = live.filter(low)
      .sort((a, b) => num(a.available_quantity) - num(b.available_quantity))
      .slice(0, 8)
      .map((r) => ({
        id: r.id, name: r.name, category: r.category, location: r.location,
        availableQuantity: r.available_quantity, reorderLevel: r.reorder_level,
      }));

    return {
      counts,
      byCategory: groupBy(live, "category"),
      byDepartment: groupBy(live, "department"),
      byLocation: groupBy(live, "location"),
      byStatus: groupBy(live, "status"),
      recentlyAdded,
      lowStock,
    };
  },
});
