const db = require('../backend/db');

async function check() {
  try {
    const res = await db.query(`
      SELECT 
        conname, 
        contype, 
        pg_get_constraintdef(c.oid) as def
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE conrelid = 'users'::regclass;
    `);
    console.log("Constraints on users table:");
    console.log(res.rows);

    const dupRes = await db.query(`
      SELECT employee_id, COUNT(*) 
      FROM users 
      WHERE employee_id IS NOT NULL AND employee_id <> ''
      GROUP BY employee_id 
      HAVING COUNT(*) > 1;
    `);
    console.log("Duplicate Employee IDs:");
    console.log(dupRes.rows);
  } catch (err) {
    console.error("Error checking constraints:", err);
  }
}

check();
