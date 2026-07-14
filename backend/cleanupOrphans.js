/**
 * One-time orphan cleanup and referential-integrity audit (native Convex).
 *
 *   node cleanupOrphans.js            # report and fix
 *   node cleanupOrphans.js --dry-run  # report only, change nothing
 *
 * Removes asset_assignments rows whose asset or employee no longer exists, audits every
 * other cross-table reference for dangling rows, and repairs the denormalised custodian
 * columns on `assets` so they agree with the surviving assignments.
 *
 * The scan and repair now live in backend/convex/cleanupOrphans.js and run inside a single
 * Convex mutation (a serializable transaction), so the whole thing still commits atomically
 * or rolls back on any error. No local Postgres is involved.
 */

const { cq, cm } = require('./convexApi');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  try {
    console.log(DRY_RUN ? '\n== DRY RUN: no changes will be written ==\n' : '\n== Orphan cleanup ==\n');

    const findings = await cq('cleanupOrphans:audit', {});
    console.log('== Audit summary ==');
    console.table(findings);

    if (DRY_RUN) {
      console.log('\nDry run complete. Nothing was written.\n');
      return;
    }

    const result = await cm('cleanupOrphans:fix', {});
    for (const { label, count } of result.applied) {
      console.log(`  fixed ${count} row(s): ${label}`);
    }
    console.log(
      `\nCleanup complete. ${result.mutations} row(s) changed. ` +
        `${result.remaining} orphaned assignment(s) remain.\n`
    );
  } catch (err) {
    // Convex surfaces a thrown mutation error's message here; nothing was committed.
    console.error('\nCleanup failed, no changes were written:', err.message);
    process.exitCode = 1;
  }
}

main();
