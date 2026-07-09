const db = require('C:\\Users\\Nazih\\Desktop\\AssetTracking\\backend\\db.js');

async function check() {
  try {
    const res = await db.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'auth' AND table_name = 'users';
    `);
    console.log("Columns in auth.users:");
    console.log(res.rows);
  } catch (err) {
    console.error("Error describing table:", err);
  } finally {
    process.exit(0);
  }
}

check();
