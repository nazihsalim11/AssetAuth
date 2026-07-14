import { mutation } from "./_generated/server";
import { v } from "convex/values";

// System reset (Super-Admin only). Replaces the old PGlite TRUNCATE: clears the business
// tables, removes everyone who is not a Super Admin, and records the reset in system_logs.
// Config tables (settings, calendars, SLA policies, PO settings/terms, role_permissions,
// asset_subtypes) and tickets are deliberately preserved — matching the original reset.
//
// NOTE: this deletes every row of the listed tables in one mutation. That is fine for the
// modest datasets this app targets; a very large deployment would need to page the deletes.

const WIPE_TABLES = [
  "assets", "amcs", "invoices", "asset_assignments", "movements", "documents",
  "notifications", "notification_deliveries", "emails", "notification_preferences",
  "notification_recipients", "kb_categories", "kb_articles", "kb_article_attachments",
  "kb_related_articles", "purchase_orders", "purchase_order_items", "purchase_order_attachments",
  "purchase_order_documents", "calendar_holidays", "scheduled_reports", "import_jobs",
  "departments", "locations", "vendors", "system_logs",
];

export const reset = mutation({
  args: { actor: v.string() },
  handler: async (ctx, { actor }) => {
    for (const table of WIPE_TABLES) {
      for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id);
    }
    // Remove everyone who is not a Super Admin (their WorkOS accounts are unaffected).
    for (const u of await ctx.db.query("users").collect()) {
      if (String(u.role) !== "Super Admin") await ctx.db.delete(u._id);
    }
    // system_logs was just wiped, so the reset entry starts a fresh id sequence.
    const now = new Date().toISOString();
    await ctx.db.insert("system_logs", {
      id: 1, timestamp: now, actor, action: "SYSTEM_RESET",
      detail: "System reset completed. All other business data wiped.", created_at: now,
    });
    return { success: true };
  },
});
