/**
 * One-time orphan cleanup and referential-integrity audit.
 *
 *   node cleanupOrphans.js            # report and fix
 *   node cleanupOrphans.js --dry-run  # report only, change nothing
 *
 * Removes asset_assignments rows whose asset or employee no longer exists, audits
 * every other cross-table reference for dangling rows, and repairs the denormalised
 * custodian columns on `assets` so they agree with the surviving assignments.
 *
 * Safe to re-run: every statement is idempotent, and the whole thing runs in one
 * transaction that rolls back on any error.
 */

const db = require('./db');

const DRY_RUN = process.argv.includes('--dry-run');

const findings = [];
let mutations = 0;

const record = (label, count, detail) => {
  findings.push({ check: label, found: Number(count), detail: detail || '' });
};

async function scan(client, label, sql, detail) {
  const { rows } = await client.query(sql);
  record(label, rows[0].count, detail);
  return Number(rows[0].count);
}

async function mutate(client, label, sql) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would run: ${label}`);
    return 0;
  }
  const res = await client.query(sql);
  if (res.rowCount > 0) {
    mutations += res.rowCount;
    console.log(`  fixed ${res.rowCount} row(s): ${label}`);
  }
  return res.rowCount;
}

async function main() {
  const client = await db.directPool.connect();
  try {
    await client.query('BEGIN');

    console.log(DRY_RUN ? '\n== DRY RUN: no changes will be written ==\n' : '\n== Orphan cleanup ==\n');

    // ---- 1. The reported problem: orphaned custodian assignments ----
    console.log('Scanning asset_assignments...');
    const missingAsset = await scan(
      client,
      'asset_assignments -> assets',
      `SELECT count(*) FROM asset_assignments aa
       LEFT JOIN assets a ON aa.asset_id = a.id
       WHERE aa.asset_id IS NULL OR a.id IS NULL`,
      'assignment references a deleted or missing asset'
    );
    const missingUser = await scan(
      client,
      'asset_assignments -> users',
      `SELECT count(*) FROM asset_assignments aa
       LEFT JOIN users u ON aa.user_id = u.id
       WHERE aa.user_id IS NULL OR u.id IS NULL`,
      'assignment references a deleted or missing employee'
    );

    if (missingAsset + missingUser > 0) {
      // Try to re-link rows that only lost their user_id but still name a real
      // employee (legacy rows created before user_id existed). Anything still
      // dangling afterwards is genuinely orphaned and gets removed.
      await mutate(
        client,
        're-link assignments to employees by name',
        `UPDATE asset_assignments aa
         SET user_id = u.id
         FROM users u
         WHERE aa.user_id IS NULL
           AND LOWER(TRIM(aa.employee_name)) = LOWER(TRIM(u.name))`
      );
      await mutate(
        client,
        'delete orphaned assignments',
        `DELETE FROM asset_assignments aa
         WHERE aa.asset_id IS NULL
            OR aa.user_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = aa.asset_id)
            OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = aa.user_id)`
      );
    }

    // ---- 2. Audit every other cross-table reference ----
    console.log('\nAuditing other references...');
    await scan(client, 'movements -> assets',
      `SELECT count(*) FROM movements m
       LEFT JOIN assets a ON m.asset_id = a.id
       WHERE m.asset_id IS NOT NULL AND a.id IS NULL`,
      'movement history for a deleted asset');

    await scan(client, 'assets -> invoices',
      `SELECT count(*) FROM assets a
       LEFT JOIN invoices i ON a.invoice_id = i.id
       WHERE a.invoice_id IS NOT NULL AND i.id IS NULL`,
      'asset linked to a deleted invoice');

    await scan(client, 'assets -> amcs',
      `SELECT count(*) FROM assets a
       LEFT JOIN amcs m ON a.amc_id = m.id
       WHERE a.amc_id IS NOT NULL AND m.id IS NULL`,
      'asset linked to a deleted AMC contract');

    await scan(client, 'users -> auth.users',
      `SELECT count(*) FROM users u
       LEFT JOIN auth.users au ON u.auth_id = au.id
       WHERE u.auth_id IS NOT NULL AND au.id IS NULL`,
      'profile pointing at a deleted auth record');

    // Denormalised custodian text on `assets`: not a foreign key, so nothing stops
    // it naming an employee who has since been deleted.
    const staleCustodian = await scan(client, 'assets.assigned_employee',
      `SELECT count(*) FROM assets a
       WHERE a.assigned_employee IS NOT NULL
         AND a.assigned_employee <> ''
         AND NOT EXISTS (SELECT 1 FROM asset_assignments aa
                         WHERE aa.asset_id = a.id AND aa.status = 'Assigned')`,
      'asset names a custodian but has no active assignment');

    // ---- 3. Rebuild the denormalised columns from the surviving assignments ----
    if (staleCustodian > 0) {
      console.log('\nRepairing asset custodian columns...');
      await mutate(
        client,
        'clear custodian on assets with no active assignment',
        `UPDATE assets a
         SET assigned_employee = NULL,
             assigned_quantity = 0,
             available_quantity = a.total_quantity,
             status = CASE WHEN a.status = 'Assigned' THEN 'Available'::asset_status ELSE a.status END,
             updated_at = NOW()
         WHERE a.assigned_employee IS NOT NULL
           AND a.assigned_employee <> ''
           AND NOT EXISTS (SELECT 1 FROM asset_assignments aa
                           WHERE aa.asset_id = a.id AND aa.status = 'Assigned')`
      );
    }

    // Recompute quantities for assets that still have live assignments.
    await mutate(
      client,
      'recompute assigned/available quantities',
      `UPDATE assets a
       SET assigned_quantity = s.qty,
           available_quantity = GREATEST(0, a.total_quantity - s.qty),
           updated_at = NOW()
       FROM (SELECT asset_id, SUM(quantity)::int AS qty
             FROM asset_assignments WHERE status = 'Assigned' GROUP BY asset_id) s
       WHERE a.id = s.asset_id
         AND (a.assigned_quantity IS DISTINCT FROM s.qty
              OR a.available_quantity IS DISTINCT FROM GREATEST(0, a.total_quantity - s.qty))`
    );

    // ---- 4. Confirm the invariants now hold ----
    const remaining = await client.query(
      `SELECT count(*) FROM asset_assignments aa
       WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = aa.asset_id)
          OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = aa.user_id)`
    );

    console.log('\n== Audit summary ==');
    console.table(findings);

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('Dry run complete. Nothing was written.\n');
    } else if (Number(remaining.rows[0].count) > 0) {
      await client.query('ROLLBACK');
      throw new Error(`${remaining.rows[0].count} orphaned assignment(s) still present after cleanup; rolled back.`);
    } else {
      await client.query('COMMIT');
      console.log(`\nCleanup complete. ${mutations} row(s) changed. 0 orphaned assignments remain.\n`);
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    console.error('\nCleanup failed, no changes were written:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.pool.end().catch(() => {});
    await db.directPool.end().catch(() => {});
  }
}

main();
