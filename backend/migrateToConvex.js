const { Pool } = require('pg');
const { ConvexHttpClient } = require('convex/browser');
require('dotenv').config();

const TABLES = [
  'users', 'assets', 'amcs', 'invoices', 'asset_assignments', 'movements',
  'documents', 'system_logs', 'notifications', 'notification_deliveries',
  'emails', 'notification_settings', 'notification_preferences', 'notification_recipients',
  'kb_categories', 'kb_articles', 'kb_article_attachments', 'kb_related_articles',
  'purchase_orders', 'purchase_order_items', 'purchase_order_attachments',
  'po_settings', 'po_terms', 'purchase_order_documents', 'business_calendars',
  'calendar_holidays', 'sla_policies', 'sla_escalation_levels', 'scheduled_reports',
  'asset_subtypes', 'departments', 'locations', 'vendors', 'import_jobs', 'role_permissions'
];

function sanitizeForConvex(obj) {
  if (Array.isArray(obj)) {
    return obj.map(sanitizeForConvex);
  } else if (obj !== null && typeof obj === 'object') {
    if (obj instanceof Date) {
      return obj.toISOString();
    }
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      clean[k] = sanitizeForConvex(v);
    }
    return clean;
  }
  return obj;
}

async function runMigration() {
  console.log('=== STARTING SUPABASE TO CONVEX DATA MIGRATION ===');
  
  const dbUrl = process.env.DATABASE_URL;
  const convexUrl = process.env.CONVEX_URL;
  
  if (!dbUrl) {
    console.error('ERROR: DATABASE_URL is not configured in .env');
    process.exit(1);
  }
  if (!convexUrl) {
    console.error('ERROR: CONVEX_URL is not configured in .env');
    process.exit(1);
  }
  
  console.log(`Connecting to Supabase PostgreSQL...`);
  const pgPool = new Pool({ connectionString: dbUrl });
  
  console.log(`Connecting to Convex...`);
  const convexClient = new ConvexHttpClient(convexUrl);
  
  const report = [];
  let totalSucceeded = true;
  
  for (const table of TABLES) {
    console.log(`Migrating table "${table}"...`);
    try {
      // 1. Fetch from Supabase
      const pgRes = await pgPool.query(`SELECT * FROM ${table}`);
      const pgRows = pgRes.rows || [];
      const pgCount = pgRows.length;
      
      // 2. Sync to Convex
      console.log(`- Found ${pgCount} rows in Supabase. Syncing to Convex...`);
      await convexClient.mutation("generic:syncTable", {
        table: table,
        documents: sanitizeForConvex(pgRows)
      });
      
      // 3. Verify count in Convex
      const convexCount = await convexClient.query("generic:count", { table: table });
      
      const success = pgCount === convexCount;
      if (!success) {
        totalSucceeded = false;
      }
      
      report.push({
        table,
        supabaseCount: pgCount,
        convexCount,
        status: success ? 'SUCCESS' : 'FAILED (Count mismatch)',
      });
    } catch (err) {
      console.error(`ERROR migrating table "${table}":`, err.message);
      totalSucceeded = false;
      report.push({
        table,
        supabaseCount: 'UNKNOWN',
        convexCount: 'UNKNOWN',
        status: `FAILED: ${err.message}`,
      });
    }
  }
  
  console.log('\n=== MIGRATION REPORT ===');
  console.table(report);
  
  if (totalSucceeded) {
    console.log('\n✅ MIGRATION COMPLETED SUCCESSFULLY! All records verified.');
  } else {
    console.log('\n❌ MIGRATION COMPLETED WITH ERRORS. Please check the report above.');
  }
  
  await pgPool.end();
}

runMigration().catch(err => {
  console.error('Migration crashed:', err);
  process.exit(1);
});
