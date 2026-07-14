import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// Native Convex data layer for the ticketing system: the queue, ticket detail (with
// comments / timeline / attachments / governing SLA policy), create (with SLA deadlines and
// optional auto-assignment resolved in Node), assignment, status/priority/category/
// department changes, bulk operations, and analytics. Documents keep the mirrored
// snake_case shape. SERIAL ids are derived as max(id)+1. created_by / assigned_to are
// workos_user_ids.
//
// NOTE (hybrid seam): the SLA breach/escalation sweep still lives in notifications/
// scheduler.js on PGlite; it will read tickets from Convex when the notifications module is
// migrated. notifications.notify() dispatch likewise stays hybrid for now.

const nowIso = () => new Date().toISOString();
const strip = (d) => { if (!d) return d; const { _id, _creationTime, ...rest } = d; return rest; };
const stripAll = (rows) => rows.map(strip);
const byCreatedAsc = (a, b) => String(a.created_at || "").localeCompare(String(b.created_at || ""));
const CLOSED = ["Resolved", "Closed"];

const nextIdFor = async (ctx, table) =>
  (await ctx.db.query(table).collect()).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;

const codeFor = (d) =>
  d === "IT" ? "IT" : d === "HR" ? "HR" : d === "Administration" ? "ADM" : d === "Finance" ? "FIN"
    : String(d || "").substring(0, 3).toUpperCase();

async function resolveTicket(ctx, id) {
  const s = String(id);
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    const byNum = await ctx.db.query("tickets").filter((q) => q.eq(q.field("id"), n)).first();
    if (byNum) return byNum;
  }
  return await ctx.db.query("tickets").filter((q) => q.eq(q.field("ticket_id"), s)).first();
}

async function addTimeline(ctx, ticketId, actorName, action, detail) {
  await ctx.db.insert("ticket_timeline", {
    id: await nextIdFor(ctx, "ticket_timeline"),
    ticket_id: ticketId, actor_name: actorName, action, detail, created_at: nowIso(),
  });
}

/* ------------------------------------------------------------------ queries */

export const list = query({
  args: { createdBy: v.optional(v.string()), department: v.optional(v.string()) },
  handler: async (ctx, { createdBy, department }) => {
    let rows = await ctx.db.query("tickets").collect();
    if (createdBy !== undefined) rows = rows.filter((t) => t.created_by === createdBy);
    else if (department !== undefined) rows = rows.filter((t) => t.department === department);
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return stripAll(rows);
  },
});

// Light lookup (no children) for pre-checks: employee ownership, auto-assign strategy.
export const find = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => strip(await resolveTicket(ctx, id)),
});

export const getDetail = query({
  args: { id: v.string(), includeInternal: v.boolean() },
  handler: async (ctx, { id, includeInternal }) => {
    const ticket = await resolveTicket(ctx, id);
    if (!ticket) return null;

    let comments = await ctx.db.query("ticket_comments").filter((q) => q.eq(q.field("ticket_id"), ticket.id)).collect();
    if (!includeInternal) comments = comments.filter((c) => !c.is_internal);
    comments.sort(byCreatedAsc);
    const timeline = (await ctx.db.query("ticket_timeline").filter((q) => q.eq(q.field("ticket_id"), ticket.id)).collect()).sort(byCreatedAsc);
    const attachments = (await ctx.db.query("ticket_attachments").filter((q) => q.eq(q.field("ticket_id"), ticket.id)).collect()).sort(byCreatedAsc);

    // Governing SLA policy detail (name + escalation ladder) for the tracking panel.
    let slaPolicy = null;
    if (ticket.sla_policy_id) {
      const p = await ctx.db.query("sla_policies").filter((q) => q.eq(q.field("id"), ticket.sla_policy_id)).first();
      if (p) {
        const cal = p.calendar_id != null
          ? await ctx.db.query("business_calendars").filter((q) => q.eq(q.field("id"), p.calendar_id)).first()
          : null;
        const levels = (await ctx.db.query("sla_escalation_levels").filter((q) => q.eq(q.field("policy_id"), p.id)).collect())
          .sort((a, b) => Number(a.level) - Number(b.level));
        slaPolicy = {
          id: p.id, name: p.name, calendarName: cal ? cal.name : null,
          firstResponseMinutes: p.first_response_minutes, resolutionMinutes: p.resolution_minutes,
          escalationLevels: levels.map((e) => ({ level: e.level, triggerType: e.trigger_type, threshold: Number(e.threshold), notifyTarget: e.notify_target })),
        };
      }
    }

    return { ticket: strip(ticket), comments: stripAll(comments), timeline: stripAll(timeline), attachments: stripAll(attachments), slaPolicy };
  },
});

export const analytics = query({
  args: { department: v.optional(v.string()) },
  handler: async (ctx, { department }) => {
    let rows = await ctx.db.query("tickets").collect();
    if (department !== undefined) rows = rows.filter((t) => t.department === department);
    const now = Date.now();
    const counts = { total: rows.length, open: 0, inProgress: 0, waiting: 0, resolved: 0, closed: 0, overdue: 0, avgResolutionTimeHours: 0 };
    const byPriority = {}, byDepartment = {};
    let resSum = 0, resN = 0;
    for (const t of rows) {
      if (t.status === "Open") counts.open++;
      else if (t.status === "In Progress") counts.inProgress++;
      else if (t.status === "Waiting for Employee") counts.waiting++;
      else if (t.status === "Resolved") counts.resolved++;
      else if (t.status === "Closed") counts.closed++;
      if (t.sla_deadline && new Date(t.sla_deadline).getTime() < now && !CLOSED.includes(t.status)) counts.overdue++;
      if (t.priority != null) byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
      if (t.department != null) byDepartment[t.department] = (byDepartment[t.department] || 0) + 1;
      if (t.resolved_at) { resSum += (new Date(t.resolved_at) - new Date(t.created_at)) / 3600000; resN++; }
    }
    counts.avgResolutionTimeHours = resN ? Math.round((resSum / resN) * 10) / 10 : 0;
    return { counts, byPriority, byDepartment };
  },
});

/* ------------------------------------------------------------------ create */

export const create = mutation({
  args: { ticket: v.any(), attachments: v.optional(v.array(v.any())), autoAssign: v.optional(v.any()), actorName: v.string() },
  handler: async (ctx, { ticket, attachments, autoAssign, actorName }) => {
    const id = await nextIdFor(ctx, "tickets");
    const ticketId = `${codeFor(ticket.department)}-${String(id).padStart(6, "0")}`;
    const now = nowIso();

    const doc = { ...ticket, id, ticket_id: ticketId, status: "Open", created_at: now, updated_at: now };
    let autoAssigned = null;
    if (autoAssign && autoAssign.agent) {
      doc.assigned_to = autoAssign.agent.id;
      doc.assigned_to_name = autoAssign.agent.name;
      doc.status = "In Progress";
      autoAssigned = { id: autoAssign.agent.id, name: autoAssign.agent.name };
    }

    const _id = await ctx.db.insert("tickets", doc);
    await addTimeline(ctx, id, actorName, "Created", "Ticket created by employee");
    if (autoAssigned) {
      await addTimeline(ctx, id, "System", "Assigned",
        `Auto-assigned to ${autoAssigned.name} (${autoAssign.strategyLabel}, ${autoAssign.agent.workload} open ticket(s))`);
    }
    for (const att of attachments || []) {
      await ctx.db.insert("ticket_attachments", {
        id: await nextIdFor(ctx, "ticket_attachments"),
        ticket_id: id, file_name: att.name, file_url: att.fileUrl, file_type: att.fileType,
        file_size: att.fileSize, uploaded_by: actorName, created_at: nowIso(),
      });
    }
    return { ticket: strip(await ctx.db.get(_id)), autoAssigned };
  },
});

/* --------------------------------------------------------------- comments */

export const addComment = mutation({
  args: { id: v.string(), authorName: v.string(), authorId: v.optional(v.string()), commentText: v.string(), isInternal: v.boolean() },
  handler: async (ctx, { id, authorName, authorId, commentText, isInternal }) => {
    const ticket = await resolveTicket(ctx, id);
    if (!ticket) return null;

    const _id = await ctx.db.insert("ticket_comments", {
      id: await nextIdFor(ctx, "ticket_comments"),
      ticket_id: ticket.id, author_name: authorName, author_id: authorId ?? null,
      comment_text: commentText, is_internal: isInternal, created_at: nowIso(),
    });
    await addTimeline(ctx, ticket.id, authorName, "Comment Added", isInternal ? "Added internal comment" : "Added public comment");

    // First response: the earliest public reply from someone other than the requester
    // stops the response-SLA clock. Recorded once.
    if (!ticket.first_response_at && !isInternal && authorId && authorId !== ticket.created_by) {
      const now = new Date();
      const breached = ticket.first_response_due != null && now > new Date(ticket.first_response_due);
      await ctx.db.patch(ticket._id, { first_response_at: now.toISOString(), response_breached: breached });
    }

    await ctx.db.insert("notifications", {
      id: `NTF-CMT-${ticket.ticket_id}-${Date.now()}`,
      text: `${authorName} commented on ticket ${ticket.ticket_id}`,
      type: "info", read: false, created_at: nowIso(),
    });

    return strip(await ctx.db.get(_id));
  },
});

/* ------------------------------------------------------------- assignment */

// Manual assign is reassignment-aware and returns flags for the notifier. Auto-assign / the
// create path pass `detail` to override the timeline text and skip the reassign wording.
export const assign = mutation({
  args: { id: v.string(), targetId: v.string(), targetName: v.string(), actorName: v.string(), detail: v.optional(v.string()) },
  handler: async (ctx, { id, targetId, targetName, actorName, detail }) => {
    const ticket = await resolveTicket(ctx, id);
    if (!ticket) return null;
    const previousAssignee = ticket.assigned_to || null;
    const previousAssigneeName = ticket.assigned_to_name || null;
    const isReassignment = !!(previousAssignee && previousAssignee !== targetId);

    await ctx.db.patch(ticket._id, { assigned_to: targetId, assigned_to_name: targetName, status: "In Progress", updated_at: nowIso() });
    await addTimeline(ctx, ticket.id, actorName, "Assigned",
      detail || (isReassignment ? `Reassigned ticket from ${previousAssigneeName || "previous agent"} to ${targetName}` : `Assigned ticket to ${targetName}`));

    return { ticket: strip(await ctx.db.get(ticket._id)), isReassignment, previousAssignee, previousAssigneeName };
  },
});

/* ----------------------------------------------------- single-field changes */

export const setStatus = mutation({
  args: { id: v.string(), status: v.string(), actorName: v.string() },
  handler: async (ctx, { id, status, actorName }) => {
    const ticket = await resolveTicket(ctx, id);
    if (!ticket) return null;
    const prevStatus = ticket.status;
    const patch = { status, updated_at: nowIso() };
    if (status === "Resolved") patch.resolved_at = new Date().toISOString();
    else if (status === "Closed") patch.closed_at = new Date().toISOString();
    await ctx.db.patch(ticket._id, patch);
    await addTimeline(ctx, ticket.id, actorName, "Status Changed", `Status changed from ${prevStatus} to ${status}`);
    return { ticket: strip(await ctx.db.get(ticket._id)), prevStatus };
  },
});

export const setPriority = mutation({
  args: { id: v.string(), priority: v.string(), actorName: v.string() },
  handler: async (ctx, { id, priority, actorName }) => {
    const ticket = await resolveTicket(ctx, id);
    if (!ticket) return null;
    const prevPriority = ticket.priority;
    await ctx.db.patch(ticket._id, { priority, updated_at: nowIso() });
    await addTimeline(ctx, ticket.id, actorName, "Priority Changed", `Priority changed from ${prevPriority} to ${priority}`);
    return { ticket: strip(await ctx.db.get(ticket._id)), prevPriority };
  },
});

export const setCategory = mutation({
  args: { id: v.string(), category: v.string(), actorName: v.string() },
  handler: async (ctx, { id, category, actorName }) => {
    const ticket = await resolveTicket(ctx, id);
    if (!ticket) return null;
    const prevCategory = ticket.category || "Software";
    await ctx.db.patch(ticket._id, { category, updated_at: nowIso() });
    await addTimeline(ctx, ticket.id, actorName, "Category Changed", `Category changed from ${prevCategory} to ${category}`);
    return { ticket: strip(await ctx.db.get(ticket._id)) };
  },
});

export const setDepartment = mutation({
  args: { id: v.string(), department: v.string(), actorName: v.string() },
  handler: async (ctx, { id, department, actorName }) => {
    const ticket = await resolveTicket(ctx, id);
    if (!ticket) return null;
    const prevDept = ticket.department;
    await ctx.db.patch(ticket._id, { department, updated_at: nowIso() });
    await addTimeline(ctx, ticket.id, actorName, "Department Changed", `Department reassigned from ${prevDept} to ${department}`);
    return { ticket: strip(await ctx.db.get(ticket._id)) };
  },
});

/* ------------------------------------------------------------------ bulk */

const bulkChange = (kind) => mutation({
  args: { ticketIds: v.array(v.any()), value: v.string(), actorName: v.string() },
  handler: async (ctx, { ticketIds, value, actorName }) => {
    for (const tid of ticketIds) {
      const ticket = await resolveTicket(ctx, String(tid));
      if (!ticket) continue;
      if (kind === "status") {
        const prev = ticket.status;
        const patch = { status: value, updated_at: nowIso() };
        if (value === "Resolved") patch.resolved_at = new Date().toISOString();
        else if (value === "Closed") patch.closed_at = new Date().toISOString();
        await ctx.db.patch(ticket._id, patch);
        await addTimeline(ctx, ticket.id, actorName, "Status Changed", `Bulk status changed from ${prev} to ${value}`);
      } else if (kind === "priority") {
        const prev = ticket.priority;
        await ctx.db.patch(ticket._id, { priority: value, updated_at: nowIso() });
        await addTimeline(ctx, ticket.id, actorName, "Priority Changed", `Bulk priority changed from ${prev} to ${value}`);
      } else if (kind === "category") {
        const prev = ticket.category || "Software";
        await ctx.db.patch(ticket._id, { category: value, updated_at: nowIso() });
        await addTimeline(ctx, ticket.id, actorName, "Category Changed", `Bulk category changed from ${prev} to ${value}`);
      } else if (kind === "department") {
        const prev = ticket.department;
        await ctx.db.patch(ticket._id, { department: value, updated_at: nowIso() });
        await addTimeline(ctx, ticket.id, actorName, "Department Changed", `Bulk department reassigned from ${prev} to ${value}`);
      }
    }
    return { ok: true };
  },
});

export const bulkStatus = bulkChange("status");
export const bulkPriority = bulkChange("priority");
export const bulkCategory = bulkChange("category");
export const bulkDepartment = bulkChange("department");

export const bulkAssign = mutation({
  args: { ticketIds: v.array(v.any()), targetId: v.string(), targetName: v.string(), actorName: v.string() },
  handler: async (ctx, { ticketIds, targetId, targetName, actorName }) => {
    for (const tid of ticketIds) {
      const ticket = await resolveTicket(ctx, String(tid));
      if (!ticket) continue;
      await ctx.db.patch(ticket._id, { assigned_to: targetId, assigned_to_name: targetName, status: "In Progress", updated_at: nowIso() });
      await addTimeline(ctx, ticket.id, actorName, "Assigned", `Bulk assigned ticket to ${targetName}`);
    }
    return { ok: true };
  },
});

/* ---------------------------------------------------- SLA escalation (scheduler) */

// Single-level "escalate to admins on breach" for unpoliced tickets. Guarded on
// escalated=false so two overlapping sweeps cannot both escalate.
export const escalateOnBreach = mutation({
  args: { ticketId: v.any(), detail: v.string() },
  handler: async (ctx, { ticketId, detail }) => {
    const t = await resolveTicket(ctx, String(ticketId));
    if (!t || t.escalated) return { claimed: false };
    const now = nowIso();
    await ctx.db.patch(t._id, { escalated: true, escalated_at: now, updated_at: now });
    await addTimeline(ctx, t.id, "System", "Escalated", detail);
    return { claimed: true };
  },
});

// Multi-level ladder advance for policy-governed tickets. Guarded on the current level so
// overlapping sweeps cannot double-advance; a timeline entry is written per newly crossed
// level (the caller computes them from the pre-advance level).
export const escalateLadder = mutation({
  args: { ticketId: v.any(), maxLevel: v.number(), entries: v.array(v.any()) },
  handler: async (ctx, { ticketId, maxLevel, entries }) => {
    const t = await resolveTicket(ctx, String(ticketId));
    if (!t || Number(t.escalation_level || 0) >= maxLevel) return { claimed: false };
    const now = nowIso();
    await ctx.db.patch(t._id, { escalation_level: maxLevel, escalated: true, escalated_at: t.escalated_at || now, updated_at: now });
    for (const e of entries) await addTimeline(ctx, t.id, "System", "Escalated", e.detail);
    return { claimed: true };
  },
});

export const bulkDelete = mutation({
  args: { ticketIds: v.array(v.any()) },
  handler: async (ctx, { ticketIds }) => {
    let deleted = 0;
    for (const tid of ticketIds) {
      const ticket = await resolveTicket(ctx, String(tid));
      if (!ticket) continue;
      // ON DELETE CASCADE: remove the ticket's comments / timeline / attachments too.
      for (const table of ["ticket_comments", "ticket_timeline", "ticket_attachments"]) {
        const children = await ctx.db.query(table).filter((q) => q.eq(q.field("ticket_id"), ticket.id)).collect();
        for (const c of children) await ctx.db.delete(c._id);
      }
      await ctx.db.delete(ticket._id);
      deleted++;
    }
    return { deleted };
  },
});
