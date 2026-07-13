const { PGlite } = require('@electric-sql/pglite');
const { ConvexHttpClient, ConvexClient } = require('convex/browser');
require('dotenv').config();

const convexUrl = process.env.CONVEX_URL;
let convexClient = null;
if (convexUrl) {
  convexClient = new ConvexHttpClient(convexUrl);
}

let pgliteInstance = null;
let initPromise = null;

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

async function initDb() {
  if (pgliteInstance) return pgliteInstance;
  console.log('[PGlite] Initializing in-memory Postgres...');
  pgliteInstance = new PGlite();
  
  console.log('[PGlite] In-memory Postgres initialized.');
  return pgliteInstance;
}

const getPg = () => {
  if (!initPromise) {
    initPromise = initDb();
  }
  return initPromise;
};

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

// Sync local PGlite table content to Convex
async function syncTableToConvex(table) {
  if (!convexClient) return;
  try {
    const pg = await getPg();
    const res = await pg.query(`SELECT * FROM ${table}`);
    const rows = res.rows || [];
    
    await convexClient.mutation("generic:syncTable", {
      table: table,
      documents: sanitizeForConvex(rows)
    });
  } catch (err) {
    console.error(`[Convex Sync Error] Failed to sync table "${table}":`, err.message);
  }
}

// Background sync handler after database writes
async function handlePostQuerySync(sql, params) {
  if (!convexClient) return;
  
  const cleanSql = sql.toLowerCase();
  const isWrite = /^\s*(insert|update|delete)/i.test(cleanSql);
  if (!isWrite) return;
  
  const affectedTables = TABLES.filter(table => {
    const regex = new RegExp(`\\b${table}\\b`);
    return regex.test(cleanSql);
  });
  
  if (affectedTables.length === 0) return;
  
  for (const table of affectedTables) {
    // Run in background
    syncTableToConvex(table).catch(err => {
      console.error(`[Convex Post-Query Sync Error] Table "${table}":`, err.message);
    });
  }
}

async function executeQuery(text, params) {
  const pg = await getPg();
  
  // If we have no parameters and the query looks like a multi-statement block or DDL, use pg.exec
  if ((!params || params.length === 0) && (text.includes(';') || /^\s*(create|alter|drop|insert|update|delete|begin|commit|rollback)/i.test(text))) {
    const results = await pg.exec(text);
    const lastRes = results[results.length - 1] || { rows: [], affectedRows: 0 };
    const rowCount = lastRes.affectedRows !== undefined ? lastRes.affectedRows : (lastRes.rows ? lastRes.rows.length : 0);
    
    const result = {
      rows: lastRes.rows || [],
      rowCount: rowCount,
    };
    
    handlePostQuerySync(text, params).catch(err => {
      console.error('[Convex Sync Error] post query sync failed:', err);
    });
    
    return result;
  }
  
  const res = await pg.query(text, params);
  
  const rowCount = res.affectedRows !== undefined ? res.affectedRows : (res.rows ? res.rows.length : 0);
  const result = {
    rows: res.rows || [],
    rowCount: rowCount,
  };
  
  handlePostQuerySync(text, params).catch(err => {
    console.error('[Convex Sync Error] post query sync failed:', err);
  });
  
  return result;
}

const mockClient = {
  query: executeQuery,
  release: () => {},
};

const mockPool = {
  connect: async () => mockClient,
  query: executeQuery,
  end: async () => {},
};

// Fetch all data from Convex and overwrite PGlite tables
async function loadFromConvex() {
  if (!convexClient) {
    console.warn('[Convex] CONVEX_URL is not set. Running in local-only mock mode.');
    return;
  }
  
  console.log('[Convex] Loading all data from Convex...');
  const pg = await getPg();
  
  try {
    await pg.exec("SET session_replication_role = 'replica';");
    
    for (const table of TABLES) {
      try {
        const rows = await convexClient.query("generic:list", { table: table });
        if (rows && rows.length > 0) {
          console.log(`[Convex Load] Loading ${rows.length} rows into PGlite table "${table}"...`);
          await pg.exec(`DELETE FROM ${table}`);
          
          for (const row of rows) {
            const cleanRow = { ...row };
            delete cleanRow._id;
            delete cleanRow._creationTime;
            delete cleanRow.username; // retired column: ignore any stale mirrored key
            
            const keys = Object.keys(cleanRow);
            const values = Object.values(cleanRow);
            const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
            const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
            await pg.query(sql, values);
          }
        }
      } catch (err) {
        console.warn(`[Convex Load Error] Could not load table "${table}":`, err.message);
      }
    }
    console.log('[Convex Load] All tables loaded from Convex.');
  } finally {
    await pg.exec("SET session_replication_role = 'origin';");
  }
  
  // Set up WebSocket subscription for real-time changes
  setupRealtimeSync();
}

function setupRealtimeSync() {
  if (!convexUrl) return;
  console.log('[Convex Sync] Setting up real-time WebSocket sync...');
  try {
    const wsClient = new ConvexClient(convexUrl);
    
    for (const table of TABLES) {
      wsClient.onUpdate("generic:list", { table: table }, async (rows) => {
        if (!rows) return;
        try {
          const pg = await getPg();
          const localRes = await pg.query(`SELECT * FROM ${table}`);
          const localRows = localRes.rows || [];
          
          // Map to compare
          const cleanConvexRows = rows.map(r => {
            const clean = { ...r };
            delete clean._id;
            delete clean._creationTime;
            delete clean.username; // retired column: ignore any stale mirrored key
            return clean;
          });
          
          if (localRows.length === cleanConvexRows.length && JSON.stringify(localRows) === JSON.stringify(cleanConvexRows)) {
            // Already identical
            return;
          }
          
          console.log(`[Convex WS Update] Syncing table "${table}" from Convex...`);
          await pg.exec("SET session_replication_role = 'replica';");
          await pg.exec(`DELETE FROM ${table}`);
          for (const row of cleanConvexRows) {
            const keys = Object.keys(row);
            const values = Object.values(row);
            const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
            const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
            await pg.query(sql, values);
          }
          await pg.exec("SET session_replication_role = 'origin';");
        } catch (err) {
          console.error(`[Convex WS Update Error] Failed to sync table "${table}":`, err.message);
        }
      });
    }
  } catch (err) {
    console.error('[Convex WS Sync Error] Failed to initialize WebSocket sync:', err.message);
  }
}

module.exports = {
  query: executeQuery,
  pool: mockPool,
  directQuery: executeQuery,
  directPool: mockPool,
  loadFromConvex,
  syncTableToConvex,
};
