const db = require('C:\\Users\\Nazih\\Desktop\\AssetTracking\\backend\\db.js');

async function check() {
  try {
    const columns = await db.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users';
    `);
    console.log("Columns in public.users:");
    console.log(columns.rows);

    const fks = await db.query(`
      SELECT
          tc.constraint_name, 
          tc.table_name, 
          kcu.column_name, 
          ccu.table_schema AS foreign_table_schema,
          ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name 
      FROM 
          information_schema.table_constraints AS tc 
          JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name='users';
    `);
    console.log("Foreign keys in public.users:");
    console.log(fks.rows);
  } catch (err) {
    console.error("Error describing table:", err);
  } finally {
    process.exit(0);
  }
}

check();
