const db = require('C:\\Users\\Nazih\\Desktop\\AssetTracking\\backend\\db.js');

async function check() {
  try {
    const res = await db.query('SELECT id, username, email, employee_id, password_hash FROM users');
    console.log("Users in public.users:");
    console.log(res.rows);
  } catch (err) {
    console.error("Error reading users:", err);
  } finally {
    process.exit(0);
  }
}

check();
