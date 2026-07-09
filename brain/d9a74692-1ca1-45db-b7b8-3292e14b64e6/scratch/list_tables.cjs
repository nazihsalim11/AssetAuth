const db = require('C:\\Users\\Nazih\\Desktop\\AssetTracking\\backend\\db.js');

async function check() {
  try {
    const res = await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    console.log("Tables in public schema:");
    console.log(res.rows.map(r => r.tablename));
  } catch (err) {
    console.error("Error listing tables:", err);
  } finally {
    process.exit(0);
  }
}

check();
