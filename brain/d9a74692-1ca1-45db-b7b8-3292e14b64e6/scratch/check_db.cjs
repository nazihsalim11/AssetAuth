const db = require('C:\\Users\\Nazih\\Desktop\\AssetTracking\\backend\\db.js');

async function check() {
  try {
    const res = await db.query(`
      SELECT 
          i.relname as index_name,
          idx.indisunique as is_unique,
          pg_get_indexdef(idx.indexrelid) as index_definition
      FROM pg_index idx
      JOIN pg_class t ON t.oid = idx.indrelid
      JOIN pg_class i ON i.oid = idx.indexrelid
      WHERE t.relname = 'users';
    `);
    console.log("Indexes on users table:");
    console.log(res.rows);
  } catch (err) {
    console.error("Error checking indexes:", err);
  } finally {
    process.exit(0);
  }
}

check();
