# Convex Migration — TODO

Migrating the backend off SQL/PGlite (in-memory Postgres mirrored to Convex) onto
**native Convex**. Goal: remove PGlite entirely so the Render backend fits under 512 MB.

Branch: `convex-migration` · Pattern per module: write `backend/convex/<mod>.js` →
rewrite the route to call `cq`/`cm` (via `convexApi.js`) → `npx convex dev --once` →
verify with `convex run` → commit.

---

## ✅ Done (9 commits, `18cfd56` → `f276464`)

- [x] **users** — directory, auth provisioning, RBAC role/dept lookups
- [x] **masters** — departments + locations (CRUD, archive, ref-guarded delete)
- [x] **assets** — list/employee-scope, CRUD, 5 bulk ops (+ vendor resolver, + logs writer)
- [x] **movements + documents**
- [x] **assignments** — allocate / transfer / return / edit (the allocation engine)
- [x] **role-permissions** — matrix store + **auth middleware cut off SQL**
- [x] **amc + invoices** — finance cluster, incl. invoice⇆asset mapping engine
- [x] **logs** — system_logs read + write
- [x] **knowledge base** — categories/articles/search (FTS reimplemented in JS)

---

## ⬜ Remaining modules (still on PGlite)

- [x] **tickets** — `src/routes/tickets.js` (~1012). Converted with `slaModel` + `slaAssignment`
      (both now read Convex via generic:list; `slaEngine` is pure, untouched). `convex/tickets.js`
      holds queue/detail/analytics queries + create (SLA deadlines computed in Node, atomic
      insert + ticket_id gen + timeline + attachments + optional auto-assign), comments (first-
      response clock), assign (reassignment-aware), status/priority/category/department, and all
      bulk ops (with cascade delete). Fixes: added the missing `knowledgeBase` require (latent
      ReferenceError on create); auto-assign now keys on `workos_user_id` (was numeric users.id,
      inconsistent with manual assign + dashboards); route ISO-serialises SLA `Date`s (Convex
      client rejects Date). Verified end-to-end (24 assertions): SLA-match, auto-assign,
      lifecycle, comments/first-response, bulk, analytics, cascade.
      **HYBRID SEAM (deferred to notifications task):** the SLA breach/escalation sweep in
      `notifications/scheduler.js` still reads/writes tickets via PGlite → runs on stale
      boot-time data until notifications is migrated. `notifications.notify()` dispatch also
      still hybrid (as with every converted module).
- [x] **purchaseOrders** — `purchaseOrders.js` (~907). **Vendor registry write-path now on
      Convex** (read-path already was via `src/utils/vendor.js`). `convex/purchaseOrders.js`
      covers vendor CRUD (case-insensitive unique name; delete nulls `vendor_id` across
      purchase_orders/invoices/amcs/assets per ON DELETE SET NULL), PO settings + versioned
      terms, and PO CRUD with atomic sequential number allocation (old FOR UPDATE →
      serializable mutation), multi-table item/attachment writes, and versioned documents.
      Totals (`poFormat`), vendor snapshot, storage links + email stay in Node. Logs via
      `logs:add`, inbox mirror via `generic:insert`. Verified end-to-end (23 assertions):
      vendor uniqueness + FK-null, number allocation/sequence, terms/doc versioning, PO
      create/list/update/delete cascade.
- [x] **SLA** — `slaModel.js` ✅ + `slaAssignment.js` ✅ (with tickets) + `slaRoutes.js` ✅.
      `convex/sla.js` holds calendar CRUD (+ holiday sets, case-insensitive unique name,
      in-use guard), policy CRUD (+ escalation ladders replaced atomically, calendar-name
      join, archive/soft-delete, ticket-governed delete guard). Validation/normalisation
      stays in Node; preview reuses `slaModel.computeDeadlines`. Verified (21 assertions).
      The escalation *scheduler* still lives in `notifications/scheduler.js` → convert with
      the notifications engine (the deferred tickets seam).
- [x] **imports** — `src/routes/imports.js` (~525). Bulk employee + asset import + import_jobs.
      `convex/imports.js` adds `jobCreate` (ON CONFLICT import_key DO NOTHING), `insertUsers`
      and `insertAssets` (atomic batch inserts with in-mutation dup guards). The old
      chunk/SAVEPOINT retry dance collapses to one atomic mutation per chunk; validation +
      WorkOS user creation + master-data checks stay in Node. Reads via `users:list` /
      `masters:list` / `assets:subtypesGrouped`; job progress/finish via `generic:update`;
      logs via `logs:add`. Fixed the dead `import_jobs.by_import_key` index (camelCase →
      `import_key`). Added a serial-dup guard to asset import (native `assets:create`
      enforces it; the old importer only relied on the DB UNIQUE constraint, which aborted
      the whole batch). `notifications.notify()` left on the hybrid engine (its own task).
      Verified: jobCreate idempotency, user/asset batch dedup, serial guard, job get/update.
- [x] **reports** — `reports.js` (~517). All 14 report builders + `filterOptions` now fetch
      whole tables via `cq('generic:list')` and fold in JS (WHERE/JOIN/GROUP BY/COUNT-FILTER
      ported). Scheduled-reports writes: `convex/reports.js` adds `scheduledCreate` (SERIAL
      id-gen) + `emailInsert` (insert-if-absent inbox mirror); edit/delete/mark-run reuse
      `generic:update`/`generic:remove` (note: id coerced to Number — Convex stores int ids).
      Verified: all builders run + aggregation math checked against seeded rows + full
      scheduled CRUD roundtrip.
- [x] **dashboards** — `dashboards.js` (~300, ~14). Aggregation-heavy (read-only).
      Reimplemented in `convex/dashboards.js` (4 queries: tickets/sla/technicians/assets);
      the SQL COUNT-FILTER / GROUP BY / EXTRACT folds are now JS over `collect()`. Route
      resolves the department scope and calls `cq('dashboards:*')`. Also added the four
      `ticket*` tables to the `TABLES` mirror list in `db.js` so ticket data actually
      flows to Convex (they were absent, so the ticket dashboards read empty).
- [x] **notifications** — dispatcher `notifications/index.js` ✅ + route
      `src/routes/notifications.js` ✅ + scheduler ✅. `convex/notifications.js` owns settings,
      per-event preferences + recipient rules, the delivery ledger with its **dedup claim**
      (emulating the ON CONFLICT unique index in serializable mutations), in-app bell feed,
      email inbox mirror (event_key-deduped), and admin read APIs. `templates.js` /
      `notificationPolicy.js` / channels are pure (untouched). **Fix:** recipients now keyed
      by `workos_user_id` throughout (the old engine mixed numeric users.id, which never
      matched the per-user filters — targeted notifications were effectively invisible).
      `notifications.notify()` is now fully Convex, so every module that calls it is off the
      PGlite seam. Verified (14 assertions): recipient resolution, dedup, configured-audience
      override, email mirror dedup, CRUD, retry.
      `notifications/scheduler.js` (~506) ✅ — lifecycle reminder digests + SLA
      breach/escalation sweep now read Convex and write ticket escalation via
      `tickets:escalateOnBreach` / `escalateLadder`. **This closes the deferred tickets SLA
      seam** — the escalation sweep no longer runs on stale PGlite tickets. Verified
      (8 assertions: low-inventory, breach escalation + idempotency, ladder advance + guard).
      **NOTE:** live SMTP delivery + node-cron wiring unchanged but untested here — needs a
      real-app smoke test.
- [x] **cleanupOrphans** — `cleanupOrphans.js` (~196, ~9). Scan/repair moved into
      `convex/cleanupOrphans.js` (`audit` query + `fix` mutation); the obsolete
      `users -> auth.users` (Supabase) scan was dropped.

---

## ⬜ Teardown (where the Render memory win actually lands)

- [ ] Remove PGlite + the Convex mirror sync from `db.js` (loadFromConvex /
      syncTableToConvex / setupRealtimeSync / handlePostQuerySync).
- [ ] Delete/neutralize `seed.js` and `migrations.js` (SQL schema no longer used).
- [ ] `server.js` — drop the `db` wiring, `DISABLE_REALTIME_SYNC`, and DB bootstrap.
- [ ] Drop Supabase remnants: `storage.js`, `src/routes/files.js`, `cronAuth.js`,
      `cronRoutes.js` (audit each for Supabase/Postgres usage).
- [ ] Prune one-off scripts if obsolete: `migrateToConvex.js`, `wipeConvex.js`,
      `migrateDropUsername.js` (keep `createAdmin.js` if still used for bootstrap).
- [ ] Remove `pg` / `@electric-sql/pglite` from `package.json` deps.

---

## ✅ Validation before merging to `main`

- [ ] Boot backend with only `CONVEX_URL` set (no `DATABASE_URL`) — confirm healthy.
- [ ] Smoke-test each domain end-to-end through the running API (not just `convex run`).
- [x] Re-add the missing Convex schema tables discovered mid-migration.
      `tickets` + `ticket_timeline` / `ticket_comments` / `ticket_attachments`
      added to `convex/schema.js` (snake_case indexes, deployed via
      `npx convex dev --once`). Masters dependency check can now include `tickets`.
- [ ] Deploy to Render and confirm memory stays under 512 MB.
- [ ] Merge `convex-migration` → `main`.

---

## Notes / gotchas

- Convex docs use **snake_case** fields (mirrored from PGlite) — not the camelCase in some
  `schema.js` indexes. Always verify a table's real field names with `convex run` first.
- Convex mutations are **serializable transactions**, so old `BEGIN…COMMIT` /
  `FOR UPDATE` blocks map to a single mutation.
- SERIAL ids are derived as `max(id)+1`; client-supplied VARCHAR ids are checked for dups.
- Strip `_id` / `_creationTime` from Convex docs before returning to the frontend.
- `tickets` and `role_permissions` were missing from `convex/schema.js`
  (`role_permissions` added in commit `3bd373e`; `tickets` + its child tables
  added — schema now complete).
- Local `.env` has `DATABASE_URL` commented out (`# [convex-migration: disabled]`) — keep
  it disabled so `db.js` stays in PGlite/Convex mode, not Postgres mode.
