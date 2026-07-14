const { randomUUID } = require('crypto');
const { cq, cm } = require('../../convexApi');
const notifications = require('../../notifications');
const validateAndFormatPhone = require('../utils/phone');

/* ---------------- Bulk import (employees + assets) ----------------
 * Backed by native Convex. Employee imports run as a background job: the request returns
 * a jobId at once and the client polls for progress, so a large import can never time out.
 *
 * Validation, WorkOS user creation and master-data checks happen here; the actual inserts
 * are committed by atomic batch mutations (convex/imports.js) — one per chunk — which also
 * do the final duplicate guard and report a per-row outcome.
 *
 * `importKey` is a client-supplied idempotency key: retrying a timed-out import returns the
 * original job instead of importing the same people twice.
 */

const IMPORT_CHUNK_SIZE = 100;
const VALID_ROLES = ['Super Admin', 'IT Admin', 'Facility Admin', 'Finance Team', 'Employee', 'Auditor'];

const strip = (d) => { if (!d) return d; const { _id, _creationTime, ...rest } = d; return rest; };

const getImportJob = async (jobId) => {
  const job = await cq('generic:get', { table: 'import_jobs', idField: 'id', idVal: jobId });
  return job ? strip(job) : null;
};

const serializeJob = (job) => ({
  jobId: job.id,
  importKey: job.import_key,
  type: job.type,
  status: job.status,
  total: job.total,
  processed: job.processed,
  summary: job.summary,
  error: job.error
});

const updateJob = async (jobId, patch) =>
  cm('generic:update', { table: 'import_jobs', idField: 'id', idVal: jobId, patch: { ...patch, updated_at: new Date().toISOString() } });

// Progress is a best-effort write so pollers see movement mid-import.
const setImportProgress = async (jobId, processed) => {
  try {
    await updateJob(jobId, { processed });
  } catch (err) {
    console.warn(`Could not update progress for import job ${jobId}:`, err.message);
  }
};

const finishImportJob = async (jobId, status, summary, error) => {
  const patch = { status, error: error || null };
  if (summary) { patch.summary = summary; patch.processed = summary.total; }
  try {
    await updateJob(jobId, patch);
  } catch (err) {
    console.error(`Could not finalize import job ${jobId}:`, err.message);
  }
};

const validateEmployeeRow = (emp) => {
  const { employeeId, firstName, lastName, email, phoneNumber, role } = emp;
  const errors = [];

  if (!employeeId) errors.push('Employee ID is required');
  if (!firstName) errors.push('First Name is required');
  if (!lastName) errors.push('Last Name is required');
  if (!email) {
    errors.push('Email is required');
  } else if (!/\S+@\S+\.\S+/.test(email)) {
    errors.push('Invalid email format');
  }

  let formattedPhone = '';
  if (phoneNumber) {
    const phoneValidation = validateAndFormatPhone(phoneNumber);
    if (!phoneValidation.isValid) errors.push(phoneValidation.error);
    else formattedPhone = phoneValidation.value;
  }

  const targetRole = role || 'Employee';
  if (!VALID_ROLES.includes(targetRole)) {
    errors.push(`Invalid role: must be one of ${VALID_ROLES.join(', ')}`);
  }

  return { errors, formattedPhone, targetRole };
};

const { WorkOS } = require('@workos-inc/node');
const emailChannel = require('../../notifications/channels/email');
const workos = process.env.WORKOS_API_KEY ? new WorkOS(process.env.WORKOS_API_KEY) : null;

// Best-effort: email a WorkOS-hosted password-setup link to an imported user so they
// can set a password and sign in (WorkOS owns the credential).
async function sendImportResetLink(email) {
  if (!workos || !email) return;
  try {
    const reset = await workos.userManagement.createPasswordReset({ email });
    if (reset && reset.passwordResetUrl && emailChannel.isConfigured()) {
      await emailChannel.send({
        to: email,
        subject: 'Set your AssetFlow password',
        body: `An AssetFlow account has been created for you.\n\nSet your password to sign in:\n${reset.passwordResetUrl}\n`,
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('[Import Invite] Failed to create WorkOS password reset:', e.message);
  }
}

async function processEmployeeImport(jobId, employees) {
  const summary = { total: employees.length, success: 0, failed: 0, duplicate: 0, errors: [] };

  try {
    const [users, deptMaster] = await Promise.all([
      cq('users:list', {}),
      cq('masters:list', { table: 'departments' }) // active departments only
    ]);
    const takenEmployeeIds = new Set(users.map((u) => String(u.employee_id || '').toLowerCase()).filter(Boolean));
    const takenEmails = new Set(users.map((u) => String(u.email || '').toLowerCase()).filter(Boolean));
    const validDepartments = new Set(deptMaster.map((d) => String(d.name).toLowerCase()));

    // Validate, dedupe (against the snapshot) and create the WorkOS user for each row that
    // survives, building the docs to commit.
    const prepared = [];
    for (let i = 0; i < employees.length; i++) {
      const rowNum = i + 1;
      const emp = employees[i];
      const { employeeId, firstName, lastName, email, department, designation, status } = emp;

      const { errors, formattedPhone, targetRole } = validateEmployeeRow(emp);
      const deptValue = (department || '').trim();
      if (deptValue && validDepartments.size && !validDepartments.has(deptValue.toLowerCase())) {
        errors.push(`Department "${deptValue}" is not in the Department master. Add it under Users → Departments & Locations first.`);
      }
      if (errors.length > 0) {
        summary.failed++;
        summary.errors.push({ row: rowNum, employeeId, error: errors.join(', ') });
        continue;
      }

      if (takenEmployeeIds.has(employeeId.toLowerCase())) {
        summary.duplicate++;
        summary.errors.push({ row: rowNum, employeeId, error: `Employee ID '${employeeId}' already exists. Please use a unique Employee ID.` });
        continue;
      }
      if (takenEmails.has(email.toLowerCase())) {
        summary.duplicate++;
        summary.errors.push({ row: rowNum, employeeId, error: `Email "${email}" already exists` });
        continue;
      }
      takenEmployeeIds.add(employeeId.toLowerCase());
      takenEmails.add(email.toLowerCase());

      let authId = null;
      if (workos) {
        try {
          const workosUser = await workos.userManagement.createUser({
            email, emailVerified: true, firstName: firstName || '', lastName: lastName || '',
          });
          authId = workosUser.id;
        } catch (workosErr) {
          console.warn('[WorkOS Import User Creation Warning] Failed to create user in WorkOS:', workosErr.message);
        }
      }
      if (!authId) {
        authId = 'mock-' + email.split('@')[0] + '-' + Math.random().toString(36).substring(2, 7);
      }

      prepared.push({
        _ref: rowNum,
        employeeId, // kept for reset-link bookkeeping, stripped before insert below
        email,
        authId,
        doc: {
          _ref: rowNum,
          workos_user_id: authId,
          name: `${firstName} ${lastName}`,
          role: targetRole,
          email,
          employee_id: employeeId,
          phone_number: formattedPhone || '',
          department: department || '',
          designation: designation || '',
          status: status || 'Active',
        }
      });
    }

    const byRef = new Map(prepared.map((p) => [p._ref, p]));
    const recordSuccess = (ref) => {
      summary.success++;
      const p = byRef.get(ref);
      if (p && workos && p.authId && !p.authId.startsWith('mock-')) sendImportResetLink(p.email);
    };

    // Commit in chunks; each chunk is one atomic mutation. Progress ticks per chunk.
    for (let i = 0; i < prepared.length; i += IMPORT_CHUNK_SIZE) {
      const chunk = prepared.slice(i, i + IMPORT_CHUNK_SIZE);
      const results = await cm('imports:insertUsers', { docs: chunk.map((p) => p.doc) });
      for (const r of results) {
        if (r.status === 'success') recordSuccess(r.ref);
        else { summary.duplicate++; summary.errors.push({ row: r.ref, employeeId: byRef.get(r.ref)?.employeeId, error: r.error }); }
      }
      await setImportProgress(jobId, Math.min(i + chunk.length, prepared.length));
    }

    await cm('logs:add', {
      actor: 'Admin',
      action: 'Employee Bulk Import',
      detail: `Imported employees. Total: ${summary.total}, Success: ${summary.success}, Failed: ${summary.failed}, Duplicate: ${summary.duplicate}`
    });

    // Keyed on the import job so a retried request does not re-notify. Runs in a background
    // worker with no request in scope, hence the 'Admin' actor (as with the system_logs row).
    notifications.notify('system.bulk_import_completed', `import:employees:${jobId}`, {
      kind: 'employee', total: summary.total, success: summary.success,
      failed: summary.failed, duplicate: summary.duplicate, actor: 'Admin'
    });

    summary.errors.sort((a, b) => a.row - b.row);
    await finishImportJob(jobId, 'completed', summary);
  } catch (err) {
    console.error('Employee import failed:', err);
    await finishImportJob(jobId, 'failed', null, err.message);
  }
}

// --- BULK IMPORT APIS ---
function register(app) {
  app.post('/api/import/employees', async (req, res) => {
    const { employees, importKey } = req.body;
    if (!Array.isArray(employees)) {
      return res.status(400).json({ error: 'Payload must contain an employees array' });
    }
    if (employees.length === 0) {
      return res.status(400).json({ error: 'There are no employees to import' });
    }

    // Without a key, every retry counts as a fresh import.
    const key = importKey || randomUUID();
    const jobId = randomUUID();

    try {
      const { job, reused } = await cm('imports:jobCreate', { id: jobId, importKey: key, type: 'employees', total: employees.length });

      if (reused) {
        // This key has been used before: hand back the original job rather than
        // importing the same people a second time.
        return res.status(200).json({ ...serializeJob(job), reused: true });
      }

      // Respond before the work begins; the client polls the job for progress.
      res.status(202).json({ ...serializeJob(job), reused: false });

      processEmployeeImport(jobId, employees).catch(async (err) => {
        console.error('Unhandled employee import failure:', err);
        await finishImportJob(jobId, 'failed', null, err.message).catch(() => {});
      });
    } catch (err) {
      console.error('Could not start employee import:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Could not start import: ' + err.message });
      }
    }
  });

  app.get('/api/import/jobs/:jobId', async (req, res) => {
    try {
      const job = await getImportJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Import job not found' });
      res.json(serializeJob(job));
    } catch (err) {
      console.error('Could not read import job:', err);
      res.status(500).json({ error: 'Could not read import job: ' + err.message });
    }
  });

  app.post('/api/import/assets', async (req, res) => {
    const { assets } = req.body;
    if (!Array.isArray(assets)) {
      return res.status(400).json({ error: 'Payload must contain an assets array' });
    }

    const summary = { total: assets.length, success: 0, failed: 0, duplicate: 0, errors: [] };

    try {
      // Load master data once. A value in the sheet is validated against the active master
      // (the single source of truth) — the importer honours the masters exactly like the
      // in-app dropdowns. Validation only bites once a master is populated, so a brand-new
      // system with no departments/locations yet is not blocked from its first import.
      const [subtypesGrouped, deptMaster, locMaster] = await Promise.all([
        cq('assets:subtypesGrouped', {}),
        cq('masters:list', { table: 'departments' }),
        cq('masters:list', { table: 'locations' })
      ]);
      const validSubtypes = {};
      for (const [category, names] of Object.entries(subtypesGrouped)) {
        validSubtypes[category] = new Set(names.map((n) => String(n).toLowerCase()));
      }
      const validDepartments = new Set(deptMaster.map((d) => String(d.name).toLowerCase()));
      const validLocations = new Set(locMaster.map((l) => String(l.name).toLowerCase()));

      const batchAssetIds = new Set();
      const prepared = [];
      for (let i = 0; i < assets.length; i++) {
        const rowNum = i + 1;
        const asset = assets[i];
        const {
          assetId, name, category, type, brand, model, serialNumber, quantity,
          unit, purchaseDate, purchaseCost, supplier, warrantyExpiry, location, status,
          department, associateDepartment, depreciationLifeYears
        } = asset;

        const errors = [];
        if (!assetId) errors.push('Asset ID is required');
        if (!name) errors.push('Asset Name is required');
        if (!category) {
          errors.push('Category is required');
        } else if (category !== 'IT' && category !== 'Office') {
          errors.push('Category must be "IT" or "Office"');
        }

        // Item Type is optional, but when supplied it must be a configured subtype for the
        // chosen category — this is what makes the mapping data-driven.
        const subtype = (type || '').trim();
        if (subtype && validSubtypes[category] && !validSubtypes[category].has(subtype.toLowerCase())) {
          errors.push(`"${subtype}" is not a valid Asset Tag Subtype for category "${category}"`);
        }

        const deptValue = (department || '').trim();
        if (deptValue && validDepartments.size && !validDepartments.has(deptValue.toLowerCase())) {
          errors.push(`Department "${deptValue}" is not in the Department master. Add it under Users → Departments & Locations first.`);
        }
        const locValue = (location || '').trim();
        if (locValue && validLocations.size && !validLocations.has(locValue.toLowerCase())) {
          errors.push(`Location "${locValue}" is not in the Location master. Add it under Users → Departments & Locations first.`);
        }
        const assocDeptValue = (associateDepartment || '').trim();
        if (assocDeptValue && validDepartments.size && !validDepartments.has(assocDeptValue.toLowerCase())) {
          errors.push(`Associate Department "${assocDeptValue}" is not in the Department master.`);
        }

        const lifespan = depreciationLifeYears === undefined || depreciationLifeYears === null || depreciationLifeYears === ''
          ? null
          : parseInt(depreciationLifeYears);
        if (lifespan !== null && (Number.isNaN(lifespan) || lifespan < 0)) {
          errors.push('Useful Lifespan must be a non-negative whole number');
        }

        if (errors.length > 0) {
          summary.failed++;
          summary.errors.push({ row: rowNum, assetId, error: errors.join(', ') });
          continue;
        }

        if (batchAssetIds.has(assetId)) {
          summary.duplicate++;
          summary.errors.push({ row: rowNum, assetId, error: `Duplicate Asset ID "${assetId}" in batch` });
          continue;
        }
        batchAssetIds.add(assetId);

        const qty = parseInt(quantity) || 1;
        const cost = parseFloat(purchaseCost) || 0;

        prepared.push({
          _ref: rowNum,
          id: assetId,
          name,
          category,
          type: subtype,
          brand: brand || '',
          model: model || '',
          serial_number: serialNumber || null,
          total_quantity: qty,
          available_quantity: qty,
          assigned_quantity: 0,
          unit: unit || 'pcs',
          purchase_date: purchaseDate || null,
          cost,
          supplier: supplier || '',
          warranty_expiry: warrantyExpiry || null,
          location: location || '',
          status: status || 'Available',
          department: department || '',
          associate_department: associateDepartment || null,
          depreciation_life_years: lifespan
        });
      }

      const refToAssetId = new Map(prepared.map((p) => [p._ref, p.id]));
      if (prepared.length) {
        const results = await cm('imports:insertAssets', { docs: prepared });
        for (const r of results) {
          if (r.status === 'success') summary.success++;
          else { summary.duplicate++; summary.errors.push({ row: r.ref, assetId: refToAssetId.get(r.ref), error: r.error }); }
        }
      }

      const actor = req.headers['x-user-email'] || 'Admin';
      await cm('logs:add', {
        actor,
        action: 'Asset Bulk Import',
        detail: `Imported assets. Total: ${summary.total}, Success: ${summary.success}, Failed: ${summary.failed}, Duplicate: ${summary.duplicate}`
      });

      notifications.notify('system.bulk_import_completed', `import:assets:${Date.now()}`, {
        kind: 'asset', total: summary.total, success: summary.success,
        failed: summary.failed, duplicate: summary.duplicate, actor
      });

      res.json(summary);
    } catch (err) {
      console.error('Asset import failed:', err);
      res.status(500).json({ error: 'Import failed unexpectedly: ' + err.message });
    }
  });
}

module.exports = { register };
