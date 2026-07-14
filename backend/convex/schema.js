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

  import_jobs: defineTable(v.any())
    .index("by_original_id", ["id"])
    .index("by_import_key", ["importKey"]),
});
