const { ConvexHttpClient } = require('convex/browser');
require('dotenv').config();

const TABLES_TO_WIPE = [
  'assets', 'amcs', 'invoices', 'asset_assignments', 'movements',
  'documents', 'system_logs', 'notifications', 'notification_deliveries',
  'emails', 'notification_preferences', 'notification_recipients',
  'kb_categories', 'kb_articles', 'kb_article_attachments', 'kb_related_articles',
  'purchase_orders', 'purchase_order_items', 'purchase_order_attachments',
  'purchase_order_documents', 'calendar_holidays', 'scheduled_reports',
  'import_jobs', 'departments', 'locations', 'vendors'
];

async function wipe() {
  console.log('=== WIPING CONVEX DEMO DATA FOR PRODUCTION ===');
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    console.error('ERROR: CONVEX_URL is not configured in .env');
    process.exit(1);
  }
  
  const client = new ConvexHttpClient(convexUrl);
  
  // 1. Wipe all data tables
  for (const table of TABLES_TO_WIPE) {
    console.log(`Clearing table "${table}"...`);
    await client.mutation("generic:syncTable", {
      table: table,
      documents: []
    });
  }
  
  // 2. Keep only Super Admins in users table
  console.log('Cleaning users table (preserving Super Admins only)...');
  const allUsers = await client.query("generic:list", { table: "users" });
  const admins = allUsers.filter(u => u.role === 'Super Admin');
  if (admins.length > 0) {
    await client.mutation("generic:syncTable", {
      table: "users",
      documents: admins
    });
    console.log(`Successfully preserved ${admins.length} Super Admin user(s).`);
  } else {
    console.warn('WARNING: No Super Admin user found in Convex users table. Did you run migrations/seeding?');
  }
  
  console.log('\n✅ CONVEX DATA WIPED SUCCESSFULLY! Database is clean for production.');
}

wipe().catch(err => {
  console.error('Wipe failed:', err);
  process.exit(1);
});
