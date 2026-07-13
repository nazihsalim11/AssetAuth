const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../../db');
const notifications = require('../../notifications');
const validateAndFormatPhone = require('../utils/phone');

/* ---------------- Employee bulk import ----------------
 * The old handler ran ~4 sequential queries plus a blocking bcrypt hash per row
 * inside the request. Against a remote pool (~186ms RTT) that is ~900ms/employee,
 * so ~34 employees exceeded the client's 30s timeout even though the import
 * itself completed. Two changes fix it:
 *
 *   1. The work runs as a background job. The request returns a jobId at once and
 *      the client polls for progress, so no import can ever time out.
 *   2. Duplicate checks are batched into set lookups and the inserts are chunked
 *      multi-row statements, cutting hundreds of round trips down to a handful.
 *
 * `importKey` is a client-supplied idempotency key: retrying a timed-out import
 * returns the original job instead of importing the same people twice.
 */

const IMPORT_CHUNK_SIZE = 100;
const VALID_ROLES = ['Super Admin', 'IT Admin', 'Facility Admin', 'Finance Team', 'Employee', 'Auditor'];
const DEFAULT_TEMP_PASSWORD = 'Password@123';

const getImportJob = async (jobId) => {
  const r = await db.query('SELECT * FROM import_jobs WHERE id = $1', [jobId]);
  return r.rows[0] || null;
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

// Progress is written on a pooled connection, not the import's transaction,
// so pollers can see it before the import commits.
const setImportProgress = async (jobId, processed) => {
  try {
    await db.query('UPDATE import_jobs SET processed = $1, updated_at = NOW() WHERE id = $2', [processed, jobId]);
  } catch (err) {
    console.warn(`Could not update progress for import job ${jobId}:`, err.message);
  }
};

const finishImportJob = async (jobId, status, summary, error) => {
  await db.query(
    'UPDATE import_jobs SET status = $1, summary = $2, error = $3, processed = COALESCE($4, processed), updated_at = NOW() WHERE id = $5',
    [status, summary ? JSON.stringify(summary) : null, error || null, summary ? summary.total : null, jobId]
  );
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

// Builds the VALUES tail of a multi-row INSERT plus its flat parameter list.
// `template` maps a row's placeholder names to a tuple, so literal columns can be
// inlined. Placeholders inside a plain `INSERT ... VALUES` take their type from the
// target column, which matters because users.role is a `user_role` enum: routing the
// rows through `SELECT ... FROM (VALUES ...)` instead yields `text` and fails to cast.
const buildMultiRowValues = (rows, template) => {
  const params = [];
  const tuples = rows.map((row) => {
    const placeholders = row.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return template(placeholders);
  });
  return { text: tuples.join(', '), params };
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

const insertUserChunk = async (client, chunk) => {
  const userRows = chunk.map((u) => [
    u.authId, u.name, u.role, u.email, u.employeeId,
    u.phoneNumber, u.department, u.designation, u.status
  ]);
  const userValues = buildMultiRowValues(userRows, (p) => `(${p.join(', ')})`);
  await client.query(
    `INSERT INTO users (
       workos_user_id, name, role, email, employee_id,
       phone_number, department, designation, status
     ) VALUES ${userValues.text}`,
    userValues.params
  );
};

async function processEmployeeImport(jobId, employees) {
  const summary = { total: employees.length, success: 0, failed: 0, duplicate: 0, errors: [] };
  const client = await db.pool.connect();

  try {
    const existing = await client.query(
      'SELECT LOWER(employee_id) AS eid, LOWER(email) AS email FROM users'
    );
    const takenEmployeeIds = new Set(existing.rows.map((r) => r.eid).filter(Boolean));
    const takenEmails = new Set(existing.rows.map((r) => r.email).filter(Boolean));

    const deptMaster = await client.query('SELECT LOWER(name) AS name FROM departments WHERE is_active');
    const validDepartments = new Set(deptMaster.rows.map((r) => r.name));

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

      // Create on WorkOS or fallback to mock UUID
      let authId = null;
      if (workos) {
        try {
          const workosUser = await workos.userManagement.createUser({
            email,
            emailVerified: true,
            firstName: firstName || '',
            lastName: lastName || '',
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
        rowNum,
        authId,
        name: `${firstName} ${lastName}`,
        role: targetRole,
        email,
        employeeId,
        phoneNumber: formattedPhone || '',
        department: department || '',
        designation: designation || '',
        status: status || 'Active',
      });
    }

    const recordSuccess = (u) => {
      summary.success++;
      if (workos && u.authId && !u.authId.startsWith('mock-')) {
        sendImportResetLink(u.email);
      }
    };

    await client.query('BEGIN');

    for (let i = 0; i < prepared.length; i += IMPORT_CHUNK_SIZE) {
      const chunk = prepared.slice(i, i + IMPORT_CHUNK_SIZE);
      await client.query('SAVEPOINT chunk_sp');
      try {
        await insertUserChunk(client, chunk);
        await client.query('RELEASE SAVEPOINT chunk_sp');
        chunk.forEach(recordSuccess);
      } catch (chunkErr) {
        await client.query('ROLLBACK TO SAVEPOINT chunk_sp');
        console.warn(`Chunk insert failed, retrying ${chunk.length} rows individually:`, chunkErr.message);
        for (let k = 0; k < chunk.length; k++) {
          const u = chunk[k];
          await client.query('SAVEPOINT row_sp');
          try {
            await insertUserChunk(client, [u]);
            await client.query('RELEASE SAVEPOINT row_sp');
            recordSuccess(u);
          } catch (rowErr) {
            await client.query('ROLLBACK TO SAVEPOINT row_sp');
            console.error(`Error importing row ${u.rowNum} (${u.employeeId}):`, rowErr.message);
            summary.failed++;
            summary.errors.push({ row: u.rowNum, employeeId: u.employeeId, error: rowErr.message });
          }
          if (k % 10 === 9) await setImportProgress(jobId, i + k + 1);
        }
      }
      await setImportProgress(jobId, Math.min(i + chunk.length, prepared.length));
    }

    await client.query(
      `INSERT INTO system_logs (actor, action, detail) VALUES ($1, $2, $3)`,
      [
        'Admin',
        'Employee Bulk Import',
        `Imported employees. Total: ${summary.total}, Success: ${summary.success}, Failed: ${summary.failed}, Duplicate: ${summary.duplicate}`
      ]
    );

    // Keyed on the import job, so a retried request does not re-notify.
    notifications.notify('system.bulk_import_completed', `import:employees:${jobId}`, {
      kind: 'employee',
      total: summary.total,
      success: summary.success,
      failed: summary.failed,
      duplicate: summary.duplicate,
      // This runs in a background worker, with no request in scope. The matching
      // system_logs row records 'Admin' for the same reason.
      actor: 'Admin'
    });

    await client.query('COMMIT');
    summary.errors.sort((a, b) => a.row - b.row);
    await finishImportJob(jobId, 'completed', summary);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be gone */
    }
    console.error('Employee import transaction failed:', err);
    await finishImportJob(jobId, 'failed', null, err.message);
  } finally {
    client.release();
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
      const created = await db.query(
        `INSERT INTO import_jobs (id, import_key, type, status, total, processed)
         VALUES ($1, $2, 'employees', 'running', $3, 0)
         ON CONFLICT (import_key) DO NOTHING
         RETURNING *`,
        [jobId, key, employees.length]
      );

      if (created.rows.length === 0) {
        // This key has been used before: hand back the original job rather than
        // importing the same people a second time.
        const existing = await db.query('SELECT * FROM import_jobs WHERE import_key = $1', [key]);
        return res.status(200).json({ ...serializeJob(existing.rows[0]), reused: true });
      }

      // Respond before the work begins; the client polls the job for progress.
      res.status(202).json({ ...serializeJob(created.rows[0]), reused: false });

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

    const client = await db.pool.connect();
    const summary = {
      total: assets.length,
      success: 0,
      failed: 0,
      duplicate: 0,
      errors: []
    };

    try {
      await client.query('BEGIN');
      const batchAssetIds = new Set();

      // Load the master data once so every category exposes all of its valid Item
      // Types. A subtype in the sheet is validated against this set rather than being
      // overwritten with a hard-coded value.
      const subtypeRows = await client.query('SELECT category, LOWER(name) AS name FROM asset_subtypes');
      const validSubtypes = {};
      for (const r of subtypeRows.rows) (validSubtypes[r.category] = validSubtypes[r.category] || new Set()).add(r.name);

      // Department & Location masters, loaded once. A value in the sheet is validated
      // against the active master (the single source of truth) — the importer honours the
      // masters exactly like the in-app dropdowns do, rather than accepting free text.
      // Validation only bites once the master is populated, so a brand-new system with no
      // departments/locations yet is not blocked from its first import.
      const [deptMaster, locMaster] = await Promise.all([
        client.query('SELECT LOWER(name) AS name FROM departments WHERE is_active'),
        client.query('SELECT LOWER(name) AS name FROM locations WHERE is_active')
      ]);
      const validDepartments = new Set(deptMaster.rows.map((r) => r.name));
      const validLocations = new Set(locMaster.rows.map((r) => r.name));

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

        // Item Type is optional, but when supplied it must be a configured subtype for
        // the chosen category — this is what makes the mapping data-driven.
        const subtype = (type || '').trim();
        if (subtype && validSubtypes[category] && !validSubtypes[category].has(subtype.toLowerCase())) {
          errors.push(`"${subtype}" is not a valid Asset Tag Subtype for category "${category}"`);
        }

        // Department & Location must come from their masters when supplied (and once the
        // master exists), mirroring the in-app dropdowns.
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

        const idExists = await client.query('SELECT 1 FROM assets WHERE id = $1', [assetId]);
        if (idExists.rows.length > 0) {
          summary.duplicate++;
          summary.errors.push({ row: rowNum, assetId, error: `Asset ID "${assetId}" already exists in database` });
          continue;
        }

        const qty = parseInt(quantity) || 1;
        const cost = parseFloat(purchaseCost) || 0;

        const insertQuery = `
          INSERT INTO assets (
            id, name, category, type, brand, model, serial_number, total_quantity, available_quantity,
            assigned_quantity, unit, purchase_date, cost, supplier, warranty_expiry, location, status,
            department, associate_department, depreciation_life_years
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        `;
        const values = [
          assetId,
          name,
          category,
          subtype,
          brand || '',
          model || '',
          serialNumber || null,
          qty,
          qty,
          0,
          unit || 'pcs',
          purchaseDate || null,
          cost,
          supplier || '',
          warrantyExpiry || null,
          location || '',
          status || 'Available',
          department || '',
          associateDepartment || null,
          lifespan
        ];

        await client.query(insertQuery, values);
        summary.success++;
        batchAssetIds.add(assetId);
      }

      const actor = req.headers['x-user-email'] || 'Admin';
      await client.query(
        `INSERT INTO system_logs (actor, action, detail)
         VALUES ($1, $2, $3)`,
        [
          actor,
          'Asset Bulk Import',
          `Imported assets. Total: ${summary.total}, Success: ${summary.success}, Failed: ${summary.failed}, Duplicate: ${summary.duplicate}`
        ]
      );

      notifications.notify('system.bulk_import_completed', `import:assets:${Date.now()}`, {
        kind: 'asset',
        total: summary.total,
        success: summary.success,
        failed: summary.failed,
        duplicate: summary.duplicate,
        actor
      });

      await client.query('COMMIT');
      res.json(summary);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Asset import transaction failed:', err);
      res.status(500).json({ error: 'Import failed unexpectedly: ' + err.message });
    } finally {
      client.release();
    }
  });
}

module.exports = { register };
