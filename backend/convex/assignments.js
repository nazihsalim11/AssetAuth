import { query, mutation } from "./_generated/server";
import { v, ConvexError } from "convex/values";

// Native Convex data layer for the quantity-based assignment engine: the custodian
// registry, employee lookups, and the allocate / transfer / return / edit flows. Each of
// the old multi-statement SQL transactions (BEGIN…COMMIT with FOR UPDATE row locks) maps
// to a single Convex mutation — Convex mutations are serializable transactions, so the
// asset-quantity recompute, movement, and audit log all commit atomically or not at all.
//
// Mirrored snake_case shapes:
//   asset_assignments: id (SERIAL), asset_id, employee_name, user_id, quantity,
//                      department, date, notes, status, expected_return_date, created_at
//   assets: total_quantity, assigned_quantity, available_quantity, assigned_employee, ...

const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const nextIntId = (rows) => rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
const norm = (s) => String(s ?? "").trim().toLowerCase();

// Structured error so the HTTP layer can pick the right status code from err.data.code.
const cerr = (code, message) => new ConvexError({ code, message });

const findAsset = (ctx, id) =>
  ctx.db.query("assets").filter((q) => q.eq(q.field("id"), id)).first();
const findAssignment = (ctx, id) =>
  ctx.db.query("asset_assignments").filter((q) => q.eq(q.field("id"), id)).first();

// Recompute the denormalised "Name (qty), …" summary from the live active custody rows.
async function activeSummary(ctx, assetId) {
  const rows = (await ctx.db.query("asset_assignments").collect()).filter(
    (r) => r.asset_id === assetId && r.status === "Assigned"
  );
  const byEmp = {};
  for (const r of rows) byEmp[r.employee_name] = (byEmp[r.employee_name] || 0) + (r.quantity || 0);
  return Object.entries(byEmp).map(([n, q]) => `${n} (${q})`).join(", ");
}

// Match a user by name or email. The old allocate/edit paths did NOT filter on status;
// transfer required an Active user — so activeOnly is passed through to preserve that.
async function findUserByNameOrEmail(ctx, value, { activeOnly = false } = {}) {
  const target = norm(value);
  const users = await ctx.db.query("users").collect();
  return users.find(
    (u) => (!activeOnly || u.status === "Active") && (norm(u.name) === target || norm(u.email) === target)
  );
}

async function insertMovement(ctx, mv) {
  const rows = await ctx.db.query("movements").collect();
  await ctx.db.insert("movements", { id: nextIntId(rows), created_at: nowIso(), ...mv });
}
async function insertLog(ctx, actor, action, detail) {
  const rows = await ctx.db.query("system_logs").collect();
  const now = nowIso();
  await ctx.db.insert("system_logs", { id: nextIntId(rows), timestamp: now, actor, action, detail, created_at: now });
}

// ---------------------------------------------------------------- queries

// Custody registry. Inner-join semantics: a row whose asset or user has gone away never
// surfaces. Employees see only their own rows.
export const list = query({
  args: { userId: v.optional(v.string()), scoped: v.boolean() },
  handler: async (ctx, { userId, scoped }) => {
    let rows = await ctx.db.query("asset_assignments").collect();
    if (scoped) rows = rows.filter((r) => r.user_id === userId);

    const assetById = new Map((await ctx.db.query("assets").collect()).map((a) => [a.id, a]));
    const userSet = new Set((await ctx.db.query("users").collect()).map((u) => u.workos_user_id));

    const out = [];
    for (const r of rows) {
      const a = assetById.get(r.asset_id);
      if (!a || !userSet.has(r.user_id)) continue;
      out.push({ ...r, asset_name: a.name, asset_category: a.category });
    }
    out.sort((x, y) => String(y.created_at || "").localeCompare(String(x.created_at || "")));
    return out;
  },
});

// Directory search. Employees may only look themselves up (selfId set); everyone else
// searches Active users by name / email / employee id.
export const employeeSearch = query({
  args: { q: v.string(), selfId: v.optional(v.string()) },
  handler: async (ctx, { q, selfId }) => {
    const pick = (u) => ({
      id: u.workos_user_id, name: u.name, email: u.email, employee_id: u.employee_id,
      department: u.department, designation: u.designation, status: u.status,
    });
    if (selfId) {
      const u = await ctx.db.query("users").filter((x) => x.eq(x.field("workos_user_id"), selfId)).first();
      return u ? [pick(u)] : [];
    }
    const needle = q.toLowerCase();
    const users = (await ctx.db.query("users").filter((x) => x.eq(x.field("status"), "Active")).collect()).filter(
      (u) =>
        String(u.name || "").toLowerCase().includes(needle) ||
        String(u.email || "").toLowerCase().includes(needle) ||
        String(u.employee_id || "").toLowerCase().includes(needle)
    );
    users.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    return users.slice(0, 25).map(pick);
  },
});

// Current holdings plus full history for one employee. Returns null if the user is gone.
export const employeeAssets = query({
  args: { targetId: v.string() },
  handler: async (ctx, { targetId }) => {
    const u = await ctx.db.query("users").filter((x) => x.eq(x.field("workos_user_id"), targetId)).first();
    if (!u) return null;
    const employee = {
      id: u.workos_user_id, name: u.name, email: u.email, employee_id: u.employee_id,
      department: u.department, designation: u.designation, status: u.status,
    };

    const assigns = (await ctx.db.query("asset_assignments").collect()).filter((r) => r.user_id === targetId);
    const assetById = new Map((await ctx.db.query("assets").collect()).map((a) => [a.id, a]));

    const history = [];
    for (const r of assigns) {
      const a = assetById.get(r.asset_id);
      if (!a) continue;
      history.push({
        id: r.id, asset_id: r.asset_id, quantity: r.quantity, department: r.department, date: r.date,
        notes: r.notes, status: r.status, created_at: r.created_at, asset_name: a.name,
        asset_category: a.category, serial_number: a.serial_number, location: a.location, asset_status: a.status,
      });
    }
    history.sort((x, y) => String(y.created_at || "").localeCompare(String(x.created_at || "")));
    const current = history.filter((r) => r.status === "Assigned");
    return {
      employee,
      currentAssets: current,
      history,
      totalQuantityHeld: current.reduce((s, r) => s + (r.quantity || 0), 0),
    };
  },
});

// ---------------------------------------------------------------- mutations

export const allocate = mutation({
  args: {
    assetId: v.string(), employeeName: v.string(), quantity: v.optional(v.any()),
    department: v.optional(v.string()), notes: v.optional(v.string()), date: v.optional(v.string()),
    expectedReturnDate: v.optional(v.string()), actor: v.string(),
  },
  handler: async (ctx, a) => {
    const qty = parseInt(a.quantity) || 1;
    if (!a.assetId || !a.employeeName || qty <= 0) {
      throw cerr(400, "Asset ID, Employee Name, and positive quantity are required.");
    }
    const asset = await findAsset(ctx, a.assetId);
    if (!asset) throw cerr(404, "Asset not found");
    if ((asset.available_quantity || 0) < qty) {
      throw cerr(400, `Insufficient stock. Available: ${asset.available_quantity}, Requested: ${qty}`);
    }
    const user = await findUserByNameOrEmail(ctx, a.employeeName);
    if (!user) throw cerr(400, `Employee "${a.employeeName}" does not exist in the user directory.`);

    const now = nowIso();
    const assignRows = await ctx.db.query("asset_assignments").collect();
    const _aid = await ctx.db.insert("asset_assignments", {
      id: nextIntId(assignRows), asset_id: a.assetId, employee_name: user.name, user_id: user.workos_user_id,
      quantity: qty, department: a.department || asset.department, date: a.date || today(),
      notes: a.notes || "", status: "Assigned", expected_return_date: a.expectedReturnDate || null, created_at: now,
    });

    const newAssigned = (asset.assigned_quantity || 0) + qty;
    const newAvailable = (asset.total_quantity || 0) - newAssigned;
    const newStatus = newAvailable === 0 ? "Assigned" : "Available";
    const summary = await activeSummary(ctx, a.assetId);
    await ctx.db.patch(asset._id, {
      assigned_quantity: newAssigned, available_quantity: newAvailable, status: newStatus,
      assigned_employee: summary, updated_at: now,
    });

    await insertMovement(ctx, {
      asset_id: a.assetId, date: a.date || today(), type: "Allocation", from_loc: "Inventory",
      to_loc: `${a.employeeName} (${a.department || asset.department})`, actor: a.actor,
      notes: `Assigned Qty: ${qty}. ${a.notes || ""}`,
    });
    await insertLog(ctx, a.actor, "Asset Allocation",
      `Allocated ${qty} of asset ${a.assetId} to ${a.employeeName}. Prev Available: ${asset.available_quantity}, New Available: ${newAvailable}`);

    return await ctx.db.get(_aid);
  },
});

// Custodian transfer / handover. Moves the underlying custody rows in the same
// transaction as the asset update, so registry/lookup/history all follow the asset.
export const transfer = mutation({
  args: {
    id: v.string(), targetType: v.string(), employeeName: v.optional(v.string()),
    department: v.optional(v.string()), location: v.optional(v.string()),
    date: v.optional(v.string()), notes: v.optional(v.string()), actor: v.string(),
  },
  handler: async (ctx, a) => {
    if (a.targetType !== "employee" && a.targetType !== "department") {
      throw cerr(400, 'targetType must be "employee" or "department".');
    }
    const asset = await findAsset(ctx, a.id);
    if (!asset) throw cerr(404, "Asset not found");

    const when = a.date || today();
    const now = nowIso();
    const prevEmployee = asset.assigned_employee;
    const prevDept = asset.department;
    const prevLoc = asset.location;
    const targetDept = a.department || asset.department;
    const targetLoc = a.location || asset.location;

    const activeRows = (await ctx.db.query("asset_assignments").collect()).filter(
      (r) => r.asset_id === a.id && r.status === "Assigned"
    );
    const movedQty = activeRows.reduce((sum, r) => sum + (r.quantity || 0), 0);

    let newAssigned = asset.assigned_quantity || 0;
    let newAvailable = asset.available_quantity || 0;
    const total = asset.total_quantity || 0;

    if (a.targetType === "employee") {
      if (!a.employeeName) throw cerr(400, "employeeName is required for a custodian transfer.");
      const user = await findUserByNameOrEmail(ctx, a.employeeName, { activeOnly: true });
      if (!user) throw cerr(400, `Employee "${a.employeeName}" does not exist in the user directory.`);

      if (activeRows.length > 0) {
        for (const r of activeRows) {
          await ctx.db.patch(r._id, { employee_name: user.name, user_id: user.workos_user_id, department: targetDept });
        }
      } else {
        const qty = Math.max(1, asset.available_quantity || asset.total_quantity || 1);
        const assignRows = await ctx.db.query("asset_assignments").collect();
        await ctx.db.insert("asset_assignments", {
          id: nextIntId(assignRows), asset_id: a.id, employee_name: user.name, user_id: user.workos_user_id,
          quantity: qty, department: targetDept, date: when, notes: a.notes || "", status: "Assigned", created_at: now,
        });
        newAssigned = Math.min(total || qty, newAssigned + qty);
        newAvailable = Math.max(0, (total || qty) - newAssigned);
      }

      const summary = await activeSummary(ctx, a.id);
      const status = newAvailable === 0 ? "Assigned" : "Available";
      await ctx.db.patch(asset._id, {
        assigned_employee: summary, department: targetDept, location: targetLoc,
        assigned_quantity: newAssigned, available_quantity: newAvailable, status, updated_at: now,
      });
    } else {
      // Return to department inventory: close active custody rows, restore the pool.
      for (const r of activeRows) {
        await ctx.db.patch(r._id, { status: "Returned", quantity: 0 });
      }
      newAssigned = Math.max(0, newAssigned - movedQty);
      newAvailable = total > 0 ? Math.min(total, newAvailable + movedQty) : newAvailable + movedQty;
      const status = newAvailable > 0 || newAssigned === 0 ? "Available" : "Assigned";
      await ctx.db.patch(asset._id, {
        assigned_employee: "", department: targetDept, location: targetLoc,
        assigned_quantity: newAssigned, available_quantity: newAvailable, status, updated_at: now,
      });
    }

    const source = prevEmployee ? `${prevEmployee} (${prevDept})` : `Dept: ${prevDept} (${prevLoc})`;
    const destination = a.targetType === "employee"
      ? `${a.employeeName} (${targetDept})`
      : `Dept: ${targetDept} (${targetLoc})`;

    await insertMovement(ctx, {
      asset_id: a.id, date: when, type: "Transfer", from_loc: source, to_loc: destination,
      actor: a.actor, notes: a.notes || "",
    });
    await insertLog(ctx, a.actor, "Asset Transfer", `Transferred ${a.id} from ${source} to ${destination}`);

    const updated = await ctx.db.get(asset._id);
    return { ok: true, asset: updated };
  },
});

export const returnAssignment = mutation({
  args: { id: v.float64(), quantity: v.optional(v.any()), notes: v.optional(v.string()), actor: v.string() },
  handler: async (ctx, a) => {
    const returnQty = a.quantity != null && a.quantity !== "" ? parseInt(a.quantity) : null;
    const assignment = await findAssignment(ctx, a.id);
    if (!assignment) throw cerr(404, "Assignment not found");
    if (assignment.status !== "Assigned") throw cerr(400, "Assignment is already returned or inactive.");

    const finalReturnQty = returnQty !== null ? Math.min(returnQty, assignment.quantity) : assignment.quantity;

    const asset = await findAsset(ctx, assignment.asset_id);
    if (!asset) throw cerr(404, "Asset not found");

    if (finalReturnQty === assignment.quantity) {
      await ctx.db.patch(assignment._id, { status: "Returned", quantity: 0 });
    } else {
      await ctx.db.patch(assignment._id, { quantity: assignment.quantity - finalReturnQty });
    }

    const now = nowIso();
    const newAssigned = Math.max(0, (asset.assigned_quantity || 0) - finalReturnQty);
    const newAvailable = (asset.total_quantity || 0) - newAssigned;
    const newStatus = newAvailable > 0 ? "Available" : "Assigned";
    const summary = await activeSummary(ctx, assignment.asset_id);
    await ctx.db.patch(asset._id, {
      assigned_quantity: newAssigned, available_quantity: newAvailable, status: newStatus,
      assigned_employee: summary, updated_at: now,
    });

    await insertMovement(ctx, {
      asset_id: assignment.asset_id, date: today(), type: "Return",
      from_loc: `${assignment.employee_name} (${assignment.department})`, to_loc: "Inventory",
      actor: a.actor, notes: `Returned Qty: ${finalReturnQty}. ${a.notes || ""}`,
    });
    await insertLog(ctx, a.actor, "Asset Return",
      `Returned ${finalReturnQty} of asset ${assignment.asset_id} from ${assignment.employee_name}. Prev Available: ${asset.available_quantity}, New Available: ${newAvailable}`);

    return { returnedQuantity: finalReturnQty };
  },
});

export const updateAssignment = mutation({
  args: {
    id: v.float64(), quantity: v.optional(v.any()), employeeName: v.optional(v.string()),
    department: v.optional(v.string()), notes: v.optional(v.string()), actor: v.string(),
  },
  handler: async (ctx, a) => {
    const assignment = await findAssignment(ctx, a.id);
    if (!assignment) throw cerr(404, "Assignment not found");

    const prevQty = assignment.quantity;
    const newQty = a.quantity !== undefined ? parseInt(a.quantity) : prevQty;

    const asset = await findAsset(ctx, assignment.asset_id);
    if (!asset) throw cerr(404, "Asset not found");

    const qtyDiff = newQty - prevQty;
    if ((asset.available_quantity || 0) < qtyDiff) {
      throw cerr(400, `Insufficient stock to adjust assignment. Available: ${asset.available_quantity}, Requested increase: ${qtyDiff}`);
    }

    let userId = assignment.user_id;
    let employeeNameDb = a.employeeName;
    if (a.employeeName) {
      const user = await findUserByNameOrEmail(ctx, a.employeeName);
      if (!user) throw cerr(400, `Employee "${a.employeeName}" does not exist in the user directory.`);
      userId = user.workos_user_id;
      employeeNameDb = user.name;
    }

    // COALESCE semantics: only overwrite the fields the caller supplied.
    const patch = { user_id: userId, quantity: newQty };
    if (employeeNameDb) patch.employee_name = employeeNameDb;
    if (a.department) patch.department = a.department;
    if (a.notes) patch.notes = a.notes;
    await ctx.db.patch(assignment._id, patch);

    const now = nowIso();
    const newAssigned = (asset.assigned_quantity || 0) + qtyDiff;
    const newAvailable = (asset.total_quantity || 0) - newAssigned;
    const newStatus = newAvailable > 0 ? "Available" : "Assigned";
    const summary = await activeSummary(ctx, assignment.asset_id);
    await ctx.db.patch(asset._id, {
      assigned_quantity: newAssigned, available_quantity: newAvailable, status: newStatus,
      assigned_employee: summary, updated_at: now,
    });

    await insertLog(ctx, a.actor, "Asset Assignment Update",
      `Updated assignment ${a.id} for asset ${assignment.asset_id}. Quantity changed from ${prevQty} to ${newQty}.`);

    return { ok: true };
  },
});
