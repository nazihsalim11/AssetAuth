const db = require('C:\\Users\\Nazih\\Desktop\\AssetTracking\\backend\\db.js');

async function check() {
  try {
    const res = await db.query('SELECT id, email, encrypted_password, role FROM auth.users');
    console.log("Users in auth.users:");
    console.log(res.rows);
  } catch (err) {
    console.error("Error reading auth.users:", err);
  } finally {
    process.exit(0);
  }
}

check();
