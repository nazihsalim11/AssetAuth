const db = require('C:\\Users\\Nazih\\Desktop\\AssetTracking\\backend\\db.js');

async function check() {
  try {
    const res = await db.query(`
      SELECT 
          trigger_name, 
          event_manipulation, 
          event_object_table, 
          action_statement, 
          action_orientation, 
          action_timing
      FROM information_schema.triggers;
    `);
    console.log("Triggers:");
    console.log(res.rows);

    const funcs = await db.query(`
      SELECT 
          p.proname as function_name,
          pg_get_functiondef(p.oid) as function_definition
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND p.proname NOT LIKE 'pg_%';
    `);
    console.log("Functions:");
    console.log(funcs.rows);
  } catch (err) {
    console.error("Error reading triggers:", err);
  } finally {
    process.exit(0);
  }
}

check();
