import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable(v.any())
    .index("by_workos_user_id", ["workos_user_id"])
    .index("by_email", ["email"])
    .index("by_employee_id", ["employee_id"]),
  
  assets: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_serial_number", ["serialNumber"])
    .index("by_category", ["category"])
    .index("by_status", ["status"])
    .index("by_vendor_id", ["vendorId"])
    .index("by_amc_id", ["amcId"])
    .index("by_invoice_id", ["invoiceId"]),

  amcs: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_po_number", ["poNumber"])
    .index("by_vendor_id", ["vendorId"]),

  invoices: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_vendor_id", ["vendorId"]),

  asset_assignments: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_asset_id", ["assetId"])
    .index("by_user_id", ["userId"])
    .index("by_status", ["status"]),

  movements: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_asset_id", ["assetId"]),

  documents: defineTable(v.any())
    .index("by_original_id", ["id"]),

  system_logs: defineTable(v.any())
    .index("by_original_id", ["id"]),

  notifications: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_user_id", ["userId"])
    .index("by_created_at", ["createdAt"]),

  notification_deliveries: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_event_key_channel_user", ["eventKey", "channel", "recipientUserId"])
    .index("by_status", ["status"]),

  emails: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_event_key", ["eventKey"]),

  notification_settings: defineTable(v.any())
    .index("by_original_id", ["id"]),

  notification_preferences: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_event_type_channel", ["eventType", "channel"]),

  notification_recipients: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_event_type", ["eventType"]),

  kb_categories: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_name", ["name"]),

  kb_articles: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_slug", ["slug"])
    .index("by_category_id", ["categoryId"])
    .index("by_is_published", ["isPublished"]),

  kb_article_attachments: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_article_id", ["articleId"]),

  kb_related_articles: defineTable(v.any())
    .index("by_article_id_related", ["articleId", "relatedArticleId"]),

  purchase_orders: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_po_number", ["poNumber"])
    .index("by_status", ["status"])
    .index("by_vendor_id", ["vendorId"]),

  purchase_order_items: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_purchase_order_id", ["purchaseOrderId"]),

  purchase_order_attachments: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_purchase_order_id", ["purchaseOrderId"]),

  po_settings: defineTable(v.any())
    .index("by_original_id", ["id"]),

  po_terms: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_version", ["version"]),

  purchase_order_documents: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_purchase_order_id", ["purchaseOrderId"]),

  business_calendars: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_name", ["name"]),

  calendar_holidays: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_calendar_id_date", ["calendarId", "holidayDate"]),

  sla_policies: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_active_archived", ["active", "archived"]),

  sla_escalation_levels: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_policy_id_level", ["policyId", "level"]),

  scheduled_reports: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_active_next_run", ["active", "nextRun"]),

  asset_subtypes: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_category_name", ["category", "name"]),

  departments: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_name", ["name"]),

  locations: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_name", ["name"]),

  vendors: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_name", ["name"]),

  // Vendor compliance/contract paperwork: many rows per vendor, one per uploaded file.
  vendor_documents: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_vendor_id", ["vendor_id"]),

  // --- Requests: the generic approval engine (see backend/src/requests/). ---
  // One row per request of any type. `request_type` keys into the registry, which is what
  // makes a new workflow a registry entry rather than new tables or new approval code.
  requests: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_status", ["status"])
    .index("by_request_type", ["request_type"])
    .index("by_requested_by", ["requested_by"])
    .index("by_record", ["module", "record_id"]),

  request_comments: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_request_id", ["request_id"]),

  request_attachments: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_request_id", ["request_id"]),

  // Append-only. Nothing updates or deletes a row here — that is the audit guarantee.
  request_history: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_request_id", ["request_id"]),

  // Configurable approval ladders (see backend/src/requests/rules.js). One row per rule:
  // what it matches (type, department, cost band, priority, category) and the levels it
  // builds. Generic across every request type — there is no per-module rule table.
  approval_rules: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_request_type", ["request_type"]),

  import_jobs: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_import_key", ["import_key"]),

  // Reusable, race-safe entity-ID counters (see backend/convex/idSequences.js).
  // One row per entity: { id, entity, prefix, padding, next_number, updated_at }.
  id_sequences: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_entity", ["entity"]),

  role_permissions: defineTable(v.any())
    .index("by_role", ["role"]),

  // Fields are snake_case, mirrored from PGlite (see notes in todo.md).
  tickets: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_ticket_id", ["ticket_id"])
    .index("by_status", ["status"])
    .index("by_department", ["department"])
    .index("by_assigned_to", ["assigned_to"])
    .index("by_created_by", ["created_by"]),

  ticket_timeline: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_ticket_id", ["ticket_id"]),

  ticket_comments: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_ticket_id", ["ticket_id"]),

  ticket_attachments: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_ticket_id", ["ticket_id"]),
});
