import { query, mutation } from "./_generated/server";

// Native-Convex reimplementation of the one-off orphan cleanup / referential-integrity
// audit that used to run raw SQL against PGlite (driven by ../cleanupOrphans.js). Convex
// mutations are serializable transactions, so the whole repair — re-linking, deleting
// orphaned custody rows, clearing stale custodians and rebuilding the denormalised
// quantity columns on `assets` — commits atomically or not at all, exactly like the old
// BEGIN…COMMIT block (which rolled back on any error).
//
// Real (snake_case) shapes, mirrored from PGlite:
//   asset_assignments: id, asset_id, user_id (a users.workos_user_id), employee_name,
//                      quantity, status, department, date, notes, created_at
//   assets: id, total_quantity, assigned_quantity, available_quantity, assigned_employee,
//           status, invoice_id, amc_id, updated_at
//
// Note: the old "users -> auth.users" scan checked a Supabase auth table that no longer
// exists under Convex/WorkOS, so it is intentionally dropped.

const norm = (s) => String(s ?? "").trim().toLowerCase();
const nowIso = () => new Date().toISOString();

const hasActiveAssignment = (assignments, assetId) =>
  assignments.some((r) => r.asset_id === assetId && r.status === "Assigned");

// Load every table once and derive the lookup sets the checks share.
async function loadWorld(ctx) {
  const assignments = await ctx.db.query("asset_assignments").collect();
  const assets = await ctx.db.query("assets").collect();
  const users = await ctx.db.query("users").collect();
  const movements = await ctx.db.query("movements").collect();
  const invoices = await ctx.db.query("invoices").collect();
  const amcs = await ctx.db.query("amcs").collect();
  return {
    assignments, assets, users, movements, invoices, amcs,
    assetIds: new Set(assets.map((a) => a.id)),
    userIds: new Set(users.map((u) => u.workos_user_id)),
    invoiceIds: new Set(invoices.map((i) => i.id)),
    amcIds: new Set(amcs.map((m) => m.id)),
  };
}

// The read-only referential-integrity scan. Returns the same {check, found, detail}
// shape the old script rendered with console.table, plus the counts the repair gates on.
function runScans(w) {
  const { assignments, assets, movements, assetIds, userIds, invoiceIds, amcIds } = w;
  const findings = [];
  const record = (check, found, detail) => findings.push({ check, found, detail });

  const missingAsset = assignments.filter((aa) => aa.asset_id == null || !assetIds.has(aa.asset_id)).length;
  record("asset_assignments -> assets", missingAsset, "assignment references a deleted or missing asset");

  const missingUser = assignments.filter((aa) => aa.user_id == null || !userIds.has(aa.user_id)).length;
  record("asset_assignments -> users", missingUser, "assignment references a deleted or missing employee");

  record("movements -> assets",
    movements.filter((m) => m.asset_id != null && !assetIds.has(m.asset_id)).length,
    "movement history for a deleted asset");

  record("assets -> invoices",
    assets.filter((a) => a.invoice_id != null && !invoiceIds.has(a.invoice_id)).length,
    "asset linked to a deleted invoice");

  record("assets -> amcs",
    assets.filter((a) => a.amc_id != null && !amcIds.has(a.amc_id)).length,
    "asset linked to a deleted AMC contract");

  const staleCustodian = assets.filter(
    (a) => a.assigned_employee && String(a.assigned_employee).trim() !== "" && !hasActiveAssignment(assignments, a.id)
  ).length;
  record("assets.assigned_employee", staleCustodian, "asset names a custodian but has no active assignment");

  return { findings, missingAsset, missingUser, staleCustodian };
}

// Report only: scan every cross-table reference and hand back the findings table.
export const audit = query({
  args: {},
  handler: async (ctx) => runScans(await loadWorld(ctx)).findings,
});

// Report and repair, atomically. Throws (rolling the whole mutation back) if any orphaned
// assignment survives the cleanup — the same guarantee as the old ROLLBACK-on-invariant.
export const fix = mutation({
  args: {},
  handler: async (ctx) => {
    const w = await loadWorld(ctx);
    const applied = [];
    let mutations = 0;
    const note = (label, count) => {
      if (count > 0) { applied.push({ label, count }); mutations += count; }
    };

    // 1. Re-link assignments that lost their user_id but still name a real employee
    //    (legacy rows created before user_id existed). Keep the in-memory copy in sync so
    //    the later steps see the repaired link.
    const usersByName = new Map(w.users.map((u) => [norm(u.name), u]));
    let relinked = 0;
    for (const aa of w.assignments) {
      if (aa.user_id == null || !w.userIds.has(aa.user_id)) {
        const u = usersByName.get(norm(aa.employee_name));
        if (u) {
          await ctx.db.patch(aa._id, { user_id: u.workos_user_id });
          aa.user_id = u.workos_user_id;
          relinked++;
        }
      }
    }
    note("re-link assignments to employees by name", relinked);

    // 2. Delete anything still dangling (no live asset or no live user).
    let deleted = 0;
    for (const aa of w.assignments) {
      const orphan = aa.asset_id == null || !w.assetIds.has(aa.asset_id) ||
        aa.user_id == null || !w.userIds.has(aa.user_id);
      if (orphan) { await ctx.db.delete(aa._id); deleted++; }
    }
    note("delete orphaned assignments", deleted);
    const survivors = w.assignments.filter(
      (aa) => aa.asset_id != null && w.assetIds.has(aa.asset_id) && aa.user_id != null && w.userIds.has(aa.user_id)
    );

    // 3. Clear the denormalised custodian on assets with no surviving active assignment.
    let cleared = 0;
    for (const a of w.assets) {
      if (a.assigned_employee && String(a.assigned_employee).trim() !== "" && !hasActiveAssignment(survivors, a.id)) {
        await ctx.db.patch(a._id, {
          assigned_employee: null,
          assigned_quantity: 0,
          available_quantity: a.total_quantity ?? 0,
          status: a.status === "Assigned" ? "Available" : a.status,
          updated_at: nowIso(),
        });
        cleared++;
      }
    }
    note("clear custodian on assets with no active assignment", cleared);

    // 4. Recompute assigned/available quantities from the surviving active custody rows.
    //    Assets with no active rows aren't in the group-by (they're handled by step 3).
    const qtyByAsset = new Map();
    for (const aa of survivors) {
      if (aa.status === "Assigned") {
        qtyByAsset.set(aa.asset_id, (qtyByAsset.get(aa.asset_id) || 0) + (aa.quantity || 0));
      }
    }
    let recomputed = 0;
    for (const a of w.assets) {
      const qty = qtyByAsset.get(a.id);
      if (!qty) continue;
      const available = Math.max(0, (a.total_quantity || 0) - qty);
      if (a.assigned_quantity !== qty || a.available_quantity !== available) {
        await ctx.db.patch(a._id, { assigned_quantity: qty, available_quantity: available, updated_at: nowIso() });
        recomputed++;
      }
    }
    note("recompute assigned/available quantities", recomputed);

    // 5. Confirm the invariants now hold; throw to roll back if they don't.
    const after = runScans(await loadWorld(ctx));
    const remaining = after.missingAsset + after.missingUser;
    if (remaining > 0) {
      throw new Error(`${remaining} orphaned assignment(s) still present after cleanup; transaction rolled back.`);
    }
    return { mutations, applied, remaining, findings: after.findings };
  },
});
