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

- [ ] **tickets** — `src/routes/tickets.js` (~1012 lines, ~91 query sites). Biggest; has
      SLA hooks. Convert alongside / before the SLA files.
- [ ] **purchaseOrders** — `purchaseOrders.js` (~907, ~54). **Owns vendors CRUD** — once
      converted, the vendor registry write-path is fully on Convex (read-path already is
      via `src/utils/vendor.js`).
- [ ] **SLA** — `slaRoutes.js` (~493), `slaModel.js` (~101), `slaAssignment.js` (~71).
      Includes SLA policy escalation + the scheduler; coordinate with tickets.
- [ ] **imports** — `src/routes/imports.js` (~525). Bulk asset import + import_jobs.
- [ ] **reports** — `reports.js` (~517, only ~4 query sites — mostly JS already).
      Aggregation-heavy: reimplement group-by/rollups in JS over Convex queries.
- [ ] **dashboards** — `dashboards.js` (~300, ~14). Aggregation-heavy (read-only).
- [ ] **notifications** — `src/routes/notifications.js` (~402) **and** the notify engine
      `backend/notifications.js`. Central: already-converted modules (invoices,
      permissions) call `notifications.notify()`, which still writes PGlite during the
      hybrid phase. Covers templates / deliveries / preferences / recipients / scheduler.
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
- [ ] Re-add the missing Convex schema tables discovered mid-migration
      (`tickets` is not yet in `convex/schema.js`; the masters dependency check
      currently skips it).
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
  (`role_permissions` added in commit `3bd373e`; `tickets` still to add).
- Local `.env` has `DATABASE_URL` commented out (`# [convex-migration: disabled]`) — keep
  it disabled so `db.js` stays in PGlite/Convex mode, not Postgres mode.
