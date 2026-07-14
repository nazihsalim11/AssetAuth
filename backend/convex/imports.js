import { mutation } from "./_generated/server";
import { v } from "convex/values";

// Write side of the bulk-import flows (employees + assets). Validation, WorkOS user
// creation and master-data checks stay in Node (backend/src/routes/imports.js); these
// mutations are the atomic commit points.
//
// Convex mutations are serializable transactions, so the old chunk/SAVEPOINT retry dance
// collapses into a single batch insert per call: dup-check against a one-time snapshot,
// insert the rest, report a per-row outcome keyed by the caller's `_ref` (the sheet row).

const nowIso = () => new Date().toISOString();
const lc = (s) => String(s ?? "").toLowerCase();
const strip = (d) => { if (!d) return d; const { _id, _creationTime, ...rest } = d; return rest; };

// import_jobs create with ON CONFLICT (import_key) DO NOTHING semantics: a retried import
// (same key) gets the original job back instead of importing the same people twice.
export const jobCreate = mutation({
  args: { id: v.string(), importKey: v.string(), type: v.string(), total: v.number() },
  handler: async (ctx, { id, importKey, type, total }) => {
    const existing = await ctx.db
      .query("import_jobs")
      .withIndex("by_import_key", (q) => q.eq("import_key", importKey))
      .first();
    if (existing) return { job: strip(existing), reused: true };
    const now = nowIso();
    const _id = await ctx.db.insert("import_jobs", {
      id, import_key: importKey, type, status: "running",
      total, processed: 0, summary: null, error: null,
      created_at: now, updated_at: now,
    });
    return { job: strip(await ctx.db.get(_id)), reused: false };
  },
});

export const insertUsers = mutation({
  args: { docs: v.array(v.any()) },
  handler: async (ctx, { docs }) => {
    const users = await ctx.db.query("users").collect();
    const takenEid = new Set(users.map((u) => lc(u.employee_id)).filter(Boolean));
    const takenEmail = new Set(users.map((u) => lc(u.email)).filter(Boolean));
    const now = nowIso();
    const results = [];
    for (const doc of docs) {
      const { _ref, ...clean } = doc;
      const eid = lc(clean.employee_id), email = lc(clean.email);
      if (eid && takenEid.has(eid)) {
        results.push({ ref: _ref, status: "duplicate", error: `Employee ID '${clean.employee_id}' already exists. Please use a unique Employee ID.` });
        continue;
      }
      if (email && takenEmail.has(email)) {
        results.push({ ref: _ref, status: "duplicate", error: `Email "${clean.email}" already exists` });
        continue;
      }
      // Match native user creation: default status + notification prefs, timestamps.
      await ctx.db.insert("users", {
        status: "Active",
        notification_preferences: { email: true, push: true },
        created_at: now, updated_at: now,
        ...clean,
      });
      takenEid.add(eid); takenEmail.add(email);
      results.push({ ref: _ref, status: "success" });
    }
    return results;
  },
});

export const insertAssets = mutation({
  args: { docs: v.array(v.any()) },
  handler: async (ctx, { docs }) => {
    const assets = await ctx.db.query("assets").collect();
    const takenId = new Set(assets.map((a) => String(a.id)));
    // serial_number is unique (enforced by assets:create); guard it here too so an import
    // can't introduce a collision. Skip the row gracefully rather than abort the batch.
    const takenSerial = new Set(assets.filter((a) => a.serial_number).map((a) => lc(a.serial_number)));
    const now = nowIso();
    const results = [];
    for (const doc of docs) {
      const { _ref, ...clean } = doc;
      const id = String(clean.id);
      if (takenId.has(id)) {
        results.push({ ref: _ref, status: "duplicate", error: `Asset ID "${clean.id}" already exists in database` });
        continue;
      }
      if (clean.serial_number && takenSerial.has(lc(clean.serial_number))) {
        results.push({ ref: _ref, status: "duplicate", error: `Serial number "${clean.serial_number}" is already in use` });
        continue;
      }
      await ctx.db.insert("assets", { created_at: now, updated_at: now, ...clean });
      takenId.add(id);
      if (clean.serial_number) takenSerial.add(lc(clean.serial_number));
      results.push({ ref: _ref, status: "success" });
    }
    return results;
  },
});
