import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// Native Convex data layer for the notification system: global settings, per-event
// preferences + recipient rules, the delivery ledger (with its dedup claim), the in-app
// bell feed, the email-alerts inbox, and the admin read APIs. The dispatcher, templates,
// policy decisions and channel transports stay in Node (notifications/*); this module owns
// the persistence. Recipients/users are keyed by workos_user_id throughout (the old engine
// mixed in the numeric users.id, which never matched the per-user filters).
//
// The Postgres ON CONFLICT dedup (unique (event_key, channel, recipient_user_id) on
// deliveries; unique id on notifications; partial unique event_key on emails) is emulated
// inside serializable mutations, so concurrent dispatches of the same event still dedup.

const nowIso = () => new Date().toISOString();
const strip = (d) => { if (!d) return d; const { _id, _creationTime, ...rest } = d; return rest; };
const stripAll = (rows) => rows.map(strip);
const nextIdFor = async (ctx, table) => (await ctx.db.query(table).collect()).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;

/* ------------------------------------------------------------------ settings */

const DEFAULT_SETTINGS = {
  id: 1, in_app_enabled: true, email_enabled: true, sms_enabled: false,
  warranty_reminder_days: 60, amc_reminder_days: 60, sla_warning_hours: 4,
};

export const settingsGet = query({
  args: {},
  handler: async (ctx) => {
    const s = await ctx.db.query("notification_settings").filter((q) => q.eq(q.field("id"), 1)).first();
    return s ? strip(s) : null;
  },
});

export const settingsUpdate = mutation({
  args: { patch: v.any() },
  handler: async (ctx, { patch }) => {
    let s = await ctx.db.query("notification_settings").filter((q) => q.eq(q.field("id"), 1)).first();
    const clean = {};
    for (const [k, val] of Object.entries(patch)) if (val !== undefined) clean[k] = val;
    if (!s) {
      const _id = await ctx.db.insert("notification_settings", { ...DEFAULT_SETTINGS, ...clean, updated_at: nowIso() });
      return strip(await ctx.db.get(_id));
    }
    await ctx.db.patch(s._id, { ...clean, updated_at: nowIso() });
    return strip(await ctx.db.get(s._id));
  },
});

/* -------------------------------------------------- preferences + recipients */

export const policyData = query({
  args: {},
  handler: async (ctx) => ({
    preferences: stripAll(await ctx.db.query("notification_preferences").collect()),
    recipients: stripAll(await ctx.db.query("notification_recipients").collect()),
  }),
});

// Replace the whole configuration in one transaction (partial writes would route some
// events to nobody).
export const preferencesReplace = mutation({
  args: { preferences: v.array(v.any()), recipients: v.array(v.any()) },
  handler: async (ctx, { preferences, recipients }) => {
    for (const table of ["notification_preferences", "notification_recipients"]) {
      for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id);
    }
    let pid = 1;
    for (const p of preferences) {
      await ctx.db.insert("notification_preferences", {
        id: pid++, event_type: p.eventType, channel: p.channel,
        enabled: p.enabled !== false, min_priority: p.minPriority || null,
      });
    }
    let rid = 1;
    for (const r of recipients) {
      await ctx.db.insert("notification_recipients", {
        id: rid++, event_type: r.eventType, role: r.role || null, user_id: r.userId ?? null,
      });
    }
    return { preferences: preferences.length, recipients: recipients.length };
  },
});

/* ---------------------------------------------------------------- users */

// Active users for recipient resolution, keyed by workos_user_id.
export const usersActive = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("users").filter((q) => q.eq(q.field("status"), "Active")).collect();
    return rows.map((u) => ({
      id: u.workos_user_id, name: u.name, email: u.email,
      phone_number: u.phone_number, role: u.role, department: u.department,
    }));
  },
});

/* ------------------------------------------------------------- deliveries */

// Claim delivery rows, emulating ON CONFLICT (event_key, channel, recipient_user_id) DO
// NOTHING. Only rows that did not already exist for this event are inserted + returned.
export const claim = mutation({
  args: { eventKey: v.string(), eventType: v.string(), rows: v.array(v.any()) },
  handler: async (ctx, { eventKey, eventType, rows }) => {
    const existing = await ctx.db.query("notification_deliveries").filter((q) => q.eq(q.field("event_key"), eventKey)).collect();
    const seen = new Set(existing.map((d) => `${d.channel}|${d.recipient_user_id ?? 0}`));
    let id = await nextIdFor(ctx, "notification_deliveries");
    const claimed = [];
    for (const r of rows) {
      const key = `${r.channel}|${r.userId ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const now = nowIso();
      const rid = id++;
      await ctx.db.insert("notification_deliveries", {
        id: rid, event_key: eventKey, event_type: eventType, channel: r.channel,
        recipient_user_id: r.userId ?? null, recipient_name: r.userName ?? null,
        recipient_address: r.address ?? null, subject: r.subject ?? null, body: r.body,
        status: r.status, last_error: r.error ?? null, attempts: 0,
        sent_at: r.status === "Sent" ? now : null, created_at: now, updated_at: now,
      });
      claimed.push({ id: rid, channel: r.channel, status: r.status, recipient_user_id: r.userId ?? null });
    }
    return claimed;
  },
});

// Mirror newly-claimed in-app deliveries into the bell feed (ON CONFLICT (id) DO NOTHING).
export const insertInApp = mutation({
  args: { items: v.array(v.any()) },
  handler: async (ctx, { items }) => {
    const existing = new Set((await ctx.db.query("notifications").collect()).map((n) => n.id));
    const now = nowIso();
    for (const it of items) {
      if (existing.has(it.id)) continue;
      existing.add(it.id);
      await ctx.db.insert("notifications", {
        id: it.id, text: it.text, type: it.type, read: false,
        user_id: it.userId ?? null, event_key: it.eventKey, created_at: now,
      });
    }
    return { inserted: items.length };
  },
});

export const pendingDeliveries = query({
  args: { ids: v.optional(v.array(v.number())) },
  handler: async (ctx, { ids }) => {
    let rows = await ctx.db.query("notification_deliveries").filter((q) => q.eq(q.field("status"), "Pending")).collect();
    if (ids) { const set = new Set(ids); rows = rows.filter((r) => set.has(r.id)); }
    return stripAll(rows.slice(0, 200));
  },
});

export const failedDeliveries = query({
  args: { maxAttempts: v.number() },
  handler: async (ctx, { maxAttempts }) => {
    const rows = (await ctx.db.query("notification_deliveries").filter((q) => q.eq(q.field("status"), "Failed")).collect())
      .filter((r) => Number(r.attempts || 0) < maxAttempts)
      .sort((a, b) => String(a.updated_at || "").localeCompare(String(b.updated_at || "")));
    return stripAll(rows.slice(0, 100));
  },
});

const findDelivery = (ctx, id) => ctx.db.query("notification_deliveries").filter((q) => q.eq(q.field("id"), id)).first();

// Mark a delivery Sent (+ mirror an email into the inbox, deduped on event_key).
export const markSent = mutation({
  args: { id: v.number() },
  handler: async (ctx, { id }) => {
    const row = await findDelivery(ctx, id);
    if (!row) return null;
    const now = nowIso();
    if (row.channel === "email") {
      // Partial unique on event_key: one inbox entry per event, not per recipient.
      const dupe = row.event_key
        ? await ctx.db.query("emails").filter((q) => q.eq(q.field("event_key"), row.event_key)).first()
        : null;
      if (!dupe) {
        await ctx.db.insert("emails", {
          id: `EML-${row.id}`, sender: "AssetFlow Notifications", date: new Date().toLocaleString(),
          subject: row.subject || "(no subject)", body: row.body, event_key: row.event_key ?? null, created_at: now,
        });
      }
    }
    await ctx.db.patch(row._id, { status: "Sent", attempts: Number(row.attempts || 0) + 1, sent_at: now, last_error: null, updated_at: now });
    return { ok: true };
  },
});

export const markFailed = mutation({
  args: { id: v.number(), error: v.string() },
  handler: async (ctx, { id, error }) => {
    const row = await findDelivery(ctx, id);
    if (!row) return null;
    await ctx.db.patch(row._id, { status: "Failed", attempts: Number(row.attempts || 0) + 1, last_error: error, updated_at: nowIso() });
    return { ok: true };
  },
});

// Delivery audit log + status summary.
export const history = query({
  args: { status: v.optional(v.string()), channel: v.optional(v.string()), recipientUserId: v.optional(v.string()), limit: v.number() },
  handler: async (ctx, { status, channel, recipientUserId, limit }) => {
    let rows = await ctx.db.query("notification_deliveries").collect();
    if (status) rows = rows.filter((r) => r.status === status);
    if (channel) rows = rows.filter((r) => r.channel === channel);
    if (recipientUserId !== undefined) rows = rows.filter((r) => r.recipient_user_id === recipientUserId);
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    const all = await ctx.db.query("notification_deliveries").collect();
    const summary = {};
    for (const r of all) summary[r.status] = (summary[r.status] || 0) + 1;
    return { deliveries: stripAll(rows.slice(0, limit)), summary };
  },
});

/* ---------------------------------------------------- in-app notifications */

export const listForUser = query({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, { userId }) => {
    let rows = await ctx.db.query("notifications").collect();
    rows = rows.filter((n) => n.user_id == null || (userId !== undefined && n.user_id === userId));
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return stripAll(rows.slice(0, 200));
  },
});

export const create = mutation({
  args: { id: v.string(), text: v.string(), type: v.optional(v.string()), read: v.optional(v.boolean()) },
  handler: async (ctx, { id, text, type, read }) => {
    const _id = await ctx.db.insert("notifications", { id, text, type: type || "info", read: read || false, user_id: null, event_key: null, created_at: nowIso() });
    return strip(await ctx.db.get(_id));
  },
});

export const setRead = mutation({
  args: { id: v.string(), read: v.boolean() },
  handler: async (ctx, { id, read }) => {
    const n = await ctx.db.query("notifications").filter((q) => q.eq(q.field("id"), id)).first();
    if (!n) return null;
    await ctx.db.patch(n._id, { read });
    return strip(await ctx.db.get(n._id));
  },
});

// Visibility rule everywhere: your own notifications plus broadcasts (user_id == null).
const visibleTo = (n, userId) => n.user_id == null || (userId !== undefined && n.user_id === userId);

export const markAllRead = mutation({
  args: { userId: v.optional(v.string()) },
  handler: async (ctx, { userId }) => {
    const rows = (await ctx.db.query("notifications").collect()).filter((n) => visibleTo(n, userId));
    for (const n of rows) if (n.read !== true) await ctx.db.patch(n._id, { read: true });
    return { ok: true };
  },
});

export const remove = mutation({
  args: { id: v.string(), userId: v.optional(v.string()) },
  handler: async (ctx, { id, userId }) => {
    const n = await ctx.db.query("notifications").filter((q) => q.eq(q.field("id"), id)).first();
    if (!n || !visibleTo(n, userId)) return { deleted: 0 };
    await ctx.db.delete(n._id);
    return { deleted: 1 };
  },
});

export const bulkRemove = mutation({
  args: { ids: v.array(v.string()), userId: v.optional(v.string()) },
  handler: async (ctx, { ids, userId }) => {
    const set = new Set(ids.map(String));
    const rows = (await ctx.db.query("notifications").collect()).filter((n) => set.has(String(n.id)) && visibleTo(n, userId));
    for (const n of rows) await ctx.db.delete(n._id);
    return { deleted: rows.length };
  },
});

export const bulkRead = mutation({
  args: { ids: v.array(v.string()), read: v.boolean(), userId: v.optional(v.string()) },
  handler: async (ctx, { ids, read, userId }) => {
    const set = new Set(ids.map(String));
    const rows = (await ctx.db.query("notifications").collect()).filter((n) => set.has(String(n.id)) && visibleTo(n, userId));
    for (const n of rows) await ctx.db.patch(n._id, { read });
    return { updated: rows.length };
  },
});

/* ------------------------------------------------------------------ emails */

export const emailsList = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("emails").collect();
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return stripAll(rows.slice(0, 200));
  },
});

export const emailRemove = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const e = await ctx.db.query("emails").filter((q) => q.eq(q.field("id"), id)).first();
    if (!e) return { deleted: 0 };
    await ctx.db.delete(e._id);
    return { deleted: 1 };
  },
});

export const emailsBulkRemove = mutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const set = new Set(ids.map(String));
    const rows = (await ctx.db.query("emails").collect()).filter((e) => set.has(String(e.id)));
    for (const e of rows) await ctx.db.delete(e._id);
    return { deleted: rows.length };
  },
});
