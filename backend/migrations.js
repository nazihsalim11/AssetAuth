const db = require('./db');
const permissionModel = require('./permissionModel');
const { DEFAULT_PO_TERMS } = require('./poDefaults');

const runMigrations = async () => {
  console.log('Running database migrations...');
  try {
    // 1. Alter users table to add employee/department fields
    await db.directQuery(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50) UNIQUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(100);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS designation VARCHAR(100);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Active';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_required BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE;
    `);

    // Backfill empty employee IDs to NULL to prevent unique constraint failures on empty strings
    await db.directQuery(`
      UPDATE users SET employee_id = NULL WHERE employee_id = '';
    `);

    // Ensure case-insensitive uniqueness constraint/index on employee_id
    await db.directQuery(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_employee_id_lower_idx ON users (LOWER(employee_id));
    `);

    // Ensure case-insensitive uniqueness constraint/index on username
    await db.directQuery(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username));
    `);

    // 2. Alter assets table to add quantity and specification fields
    await db.directQuery(`
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS total_quantity INT NOT NULL DEFAULT 1;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS available_quantity INT NOT NULL DEFAULT 1;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS assigned_quantity INT NOT NULL DEFAULT 0;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS brand VARCHAR(100);
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS model VARCHAR(100);
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS unit VARCHAR(50) DEFAULT 'pcs';
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS supplier VARCHAR(255);
    `);

    // 3. Create asset_assignments table
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS asset_assignments (
        id SERIAL PRIMARY KEY,
        asset_id VARCHAR(50) REFERENCES assets(id) ON DELETE CASCADE,
        employee_name VARCHAR(255) NOT NULL,
        user_id INT REFERENCES users(id) ON DELETE SET NULL,
        quantity INT NOT NULL DEFAULT 1,
        department VARCHAR(100),
        date DATE NOT NULL DEFAULT CURRENT_DATE,
        notes TEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'Assigned',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. Create tickets table
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        ticket_id VARCHAR(50) UNIQUE NOT NULL,
        subject VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        department VARCHAR(100) NOT NULL,
        priority VARCHAR(50) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'Open',
        created_by INT REFERENCES users(id) ON DELETE CASCADE,
        created_by_name VARCHAR(255) NOT NULL,
        assigned_to INT REFERENCES users(id) ON DELETE SET NULL,
        assigned_to_name VARCHAR(255),
        sla_deadline TIMESTAMP WITH TIME ZONE NOT NULL,
        resolved_at TIMESTAMP WITH TIME ZONE,
        closed_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'Software';
    `);

    // 5. Create ticket_timeline table
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS ticket_timeline (
        id SERIAL PRIMARY KEY,
        ticket_id INT REFERENCES tickets(id) ON DELETE CASCADE,
        actor_name VARCHAR(255) NOT NULL,
        action VARCHAR(100) NOT NULL,
        detail TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 6. Create ticket_comments table
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS ticket_comments (
        id SERIAL PRIMARY KEY,
        ticket_id INT REFERENCES tickets(id) ON DELETE CASCADE,
        author_name VARCHAR(255) NOT NULL,
        author_id INT REFERENCES users(id) ON DELETE SET NULL,
        comment_text TEXT NOT NULL,
        is_internal BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 7. Create ticket_attachments table
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS ticket_attachments (
        id SERIAL PRIMARY KEY,
        ticket_id INT REFERENCES tickets(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        file_url VARCHAR(255) NOT NULL,
        file_type VARCHAR(100),
        file_size VARCHAR(50),
        uploaded_by VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 7b. Notification system.
    //
    // notifications gains user_id: NULL keeps the old broadcast behaviour, a value
    // targets one stakeholder. event_key identifies the thing that happened, so the
    // same event can never be recorded twice for the same person on the same channel.
    await db.directQuery(`
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE;
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS event_key TEXT;
      CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications (user_id);
      CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON notifications (created_at DESC);
    `);

    // Delivery log: one row per (event, channel, recipient). This is both the audit
    // trail and the deduplication key.
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id SERIAL PRIMARY KEY,
        event_key TEXT NOT NULL,
        event_type VARCHAR(60) NOT NULL,
        channel VARCHAR(20) NOT NULL,
        recipient_user_id INT REFERENCES users(id) ON DELETE SET NULL,
        recipient_name VARCHAR(255),
        recipient_address VARCHAR(255),
        subject VARCHAR(255),
        body TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'Pending',
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        sent_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // COALESCE so broadcast rows (recipient_user_id IS NULL) still dedupe: NULL is
    // never equal to NULL in a unique index, which would let duplicates through.
    await db.directQuery(`
      CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_dedupe_idx
        ON notification_deliveries (event_key, channel, COALESCE(recipient_user_id, 0));
      CREATE INDEX IF NOT EXISTS notification_deliveries_status_idx ON notification_deliveries (status);
      CREATE INDEX IF NOT EXISTS notification_deliveries_created_idx ON notification_deliveries (created_at DESC);
    `);

    // The Email Alerts Inbox is a shared, un-scoped log: it has no per-user column, so
    // mirroring one row per recipient made a single event read as N identical entries
    // (e.g. a ticket that notifies 15 admins showed 15 times). event_key tags each
    // mirrored alert with the event it belongs to; a partial unique index then collapses
    // an event to a single inbox row. NULLs (report/PO emails, which have no event) are
    // exempt, so those sources keep inserting freely under their own ids.
    await db.directQuery(`
      ALTER TABLE emails ADD COLUMN IF NOT EXISTS event_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS emails_event_key_idx
        ON emails (event_key) WHERE event_key IS NOT NULL;
    `);

    // Global channel switches. Single row, id = 1.
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS notification_settings (
        id INT PRIMARY KEY DEFAULT 1,
        in_app_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        sms_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        warranty_reminder_days INT NOT NULL DEFAULT 60,
        amc_reminder_days INT NOT NULL DEFAULT 60,
        sla_warning_hours INT NOT NULL DEFAULT 4,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT notification_settings_singleton CHECK (id = 1)
      );
      INSERT INTO notification_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    `);

    // Escalation state, set by the SLA job when a deadline passes on an open ticket.
    await db.directQuery(`
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMP WITH TIME ZONE;
    `);

    // 7c. Unified helpdesk: ticket type. Defaulting to 'Incident' means every existing
    //     ticket gets a sensible value without a backfill, and old clients that omit
    //     the field keep working.
    await db.directQuery(`
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_type VARCHAR(30) NOT NULL DEFAULT 'Incident';
      CREATE INDEX IF NOT EXISTS tickets_department_idx ON tickets (department);
      CREATE INDEX IF NOT EXISTS tickets_created_by_idx ON tickets (created_by);
    `);

    // 7d. Knowledge Base.
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS kb_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        department VARCHAR(50),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS kb_articles (
        id SERIAL PRIMARY KEY,
        slug VARCHAR(160) UNIQUE NOT NULL,
        title VARCHAR(255) NOT NULL,
        summary TEXT,
        body TEXT NOT NULL,
        category_id INT REFERENCES kb_categories(id) ON DELETE SET NULL,
        is_faq BOOLEAN NOT NULL DEFAULT FALSE,
        is_published BOOLEAN NOT NULL DEFAULT FALSE,
        author_id INT REFERENCES users(id) ON DELETE SET NULL,
        author_name VARCHAR(255),
        view_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Weighted full-text index. A generated column keeps it in step with the row
    // automatically; to_tsvector with a literal regconfig is IMMUTABLE, which is what
    // GENERATED ALWAYS requires. Title matches outrank body matches.
    await db.directQuery(`
      ALTER TABLE kb_articles ADD COLUMN IF NOT EXISTS search_vector tsvector
        GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(body, '')), 'C')
        ) STORED;
      CREATE INDEX IF NOT EXISTS kb_articles_search_idx ON kb_articles USING GIN (search_vector);
      CREATE INDEX IF NOT EXISTS kb_articles_published_idx ON kb_articles (is_published);
    `);

    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS kb_article_attachments (
        id SERIAL PRIMARY KEY,
        article_id INT REFERENCES kb_articles(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(255) NOT NULL,
        file_type VARCHAR(100),
        file_size VARCHAR(50),
        uploaded_by VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Symmetric "related articles" edges. The CHECK stops an article relating to
    // itself; the primary key stops duplicate edges.
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS kb_related_articles (
        article_id INT NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
        related_article_id INT NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
        PRIMARY KEY (article_id, related_article_id),
        CONSTRAINT kb_related_not_self CHECK (article_id <> related_article_id)
      );
    `);

    // 7e. AMC contracts get a Purchase Order number as their business identifier.
    //     Added nullable, backfilled from the contract id, then constrained — a bare
    //     NOT NULL would fail against existing rows.
    await db.directQuery(`
      ALTER TABLE amcs ADD COLUMN IF NOT EXISTS po_number VARCHAR(60);
    `);
    await db.directQuery(`
      UPDATE amcs SET po_number = 'PO-' || id WHERE po_number IS NULL OR po_number = '';
    `);
    await db.directQuery(`
      CREATE UNIQUE INDEX IF NOT EXISTS amcs_po_number_lower_idx ON amcs (LOWER(po_number));
      ALTER TABLE amcs ALTER COLUMN po_number SET NOT NULL;
    `);

    // 7f. Purchase Orders. invoice_id / amc_id are nullable so the module stands on
    //     its own today while supporting the PO -> Invoice -> Asset links later.
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id SERIAL PRIMARY KEY,
        po_number VARCHAR(60) NOT NULL,
        vendor VARCHAR(255) NOT NULL,
        issue_date DATE NOT NULL,
        expected_delivery_date DATE,
        status VARCHAR(30) NOT NULL DEFAULT 'Draft',
        amount DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
        currency VARCHAR(8) NOT NULL DEFAULT 'INR',
        notes TEXT,
        invoice_id VARCHAR(50) REFERENCES invoices(id) ON DELETE SET NULL,
        amc_id VARCHAR(50) REFERENCES amcs(id) ON DELETE SET NULL,
        created_by INT REFERENCES users(id) ON DELETE SET NULL,
        created_by_name VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_po_number_lower_idx ON purchase_orders (LOWER(po_number));
      CREATE INDEX IF NOT EXISTS purchase_orders_vendor_idx ON purchase_orders (vendor);
      CREATE INDEX IF NOT EXISTS purchase_orders_status_idx ON purchase_orders (status);
    `);

    // Multiple attachments per PO. file_path is a storage object path, resolved to a
    // signed URL on demand, exactly like ticket and KB attachments.
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS purchase_order_attachments (
        id SERIAL PRIMARY KEY,
        purchase_order_id INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        file_name VARCHAR(255) NOT NULL,
        file_path VARCHAR(255) NOT NULL,
        file_type VARCHAR(100),
        file_size VARCHAR(50),
        uploaded_by VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS po_attachments_po_idx ON purchase_order_attachments (purchase_order_id);
    `);

    // Assets already reference invoices and AMCs; add the direct PO link so an asset
    // can be traced back to the order that bought it.
    await db.directQuery(`
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS purchase_order_id INT REFERENCES purchase_orders(id) ON DELETE SET NULL;
    `);

    // Seed the three helpdesk categories once, so the KB is not empty on first run.
    await db.directQuery(`
      INSERT INTO kb_categories (name, description, department) VALUES
        ('IT Support', 'Hardware, software, access and connectivity', 'IT'),
        ('Administration', 'Facilities, procurement and office services', 'Administration'),
        ('Human Resources', 'Payroll, leave, onboarding and policy', 'HR')
      ON CONFLICT (name) DO NOTHING;
    `);

    // 8. Update seeded users to have departments and metadata
    await db.directQuery(`
      UPDATE users SET department = 'IT', designation = 'IT Administrator', status = 'Active', employee_id = 'EMP-IT01' WHERE username = 'itadmin' AND department IS NULL;
      UPDATE users SET department = 'Operations', designation = 'Facility Lead', status = 'Active', employee_id = 'EMP-FC01' WHERE username = 'facilityadmin' AND department IS NULL;
      UPDATE users SET department = 'Finance', designation = 'Finance Manager', status = 'Active', employee_id = 'EMP-FN01' WHERE username = 'finance' AND department IS NULL;
      UPDATE users SET department = 'HR', designation = 'HR Generalist', status = 'Active', employee_id = 'EMP-HR01' WHERE username = 'employee' AND department IS NULL;
      UPDATE users SET department = 'Audit', designation = 'Internal Auditor', status = 'Active', employee_id = 'EMP-AU01' WHERE username = 'auditor' AND department IS NULL;
      UPDATE users SET department = 'Management', designation = 'Operations Lead', status = 'Active', employee_id = 'EMP-AD01' WHERE username = 'admin' AND department IS NULL;
    `);

    // 8b. Import jobs — lets long imports run in the background and gives the
    //     client an idempotency key so retrying a timed-out import cannot
    //     re-insert the same employees.
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS import_jobs (
        id UUID PRIMARY KEY,
        import_key TEXT UNIQUE NOT NULL,
        type VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'running',
        total INT NOT NULL DEFAULT 0,
        processed INT NOT NULL DEFAULT 0,
        summary JSONB,
        error TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // A job left 'running' by a crash or restart can never complete; fail it so a
    // fresh import with the same key is not blocked forever.
    await db.directQuery(`
      UPDATE import_jobs
      SET status = 'failed', error = 'Server restarted while the import was running', updated_at = NOW()
      WHERE status = 'running';
    `);

    // 9. Repair assignments that predate the user_id column.
    //    Resolve them against the user directory by custodian name so that
    //    genuinely-linkable rows survive the orphan sweep in step 10.
    const repaired = await db.directQuery(`
      UPDATE asset_assignments aa
      SET user_id = u.id
      FROM users u
      WHERE aa.user_id IS NULL
        AND LOWER(TRIM(aa.employee_name)) = LOWER(TRIM(u.name));
    `);
    if (repaired.rowCount > 0) {
      console.log(`Re-linked ${repaired.rowCount} assignment(s) to their employee record.`);
    }

    // Backfill any users that don't have auth_id
    const unlinkedUsers = await db.directQuery("SELECT * FROM users WHERE auth_id IS NULL");
    if (unlinkedUsers.rows.length > 0) {
      console.log(`Backfilling auth.users for ${unlinkedUsers.rows.length} unlinked users...`);
      const { randomUUID } = require('crypto');
      for (const u of unlinkedUsers.rows) {
        const authId = randomUUID();
        const rawUserMetadata = JSON.stringify({ name: u.name, role: u.role, username: u.username });
        
        // Check if user already exists in auth.users by email
        const authExists = await db.directQuery("SELECT id FROM auth.users WHERE LOWER(email) = LOWER($1)", [u.email]);
        let finalAuthId = authId;
        if (authExists.rows.length > 0) {
          finalAuthId = authExists.rows[0].id;
        } else {
          // Insert auth record
          const authQuery = `
            INSERT INTO auth.users (
              id, instance_id, email, encrypted_password, aud, role, 
              is_sso_user, is_anonymous, email_confirmed_at, 
              raw_app_meta_data, raw_user_meta_data, created_at, updated_at
            ) VALUES ($1, '00000000-0000-0000-0000-000000000000', $2, $3, 'authenticated', 'authenticated', 
                      false, false, NOW(), 
                      '{"provider":"email","providers":["email"]}'::jsonb, $4::jsonb, NOW(), NOW())
          `;
          await db.directQuery(authQuery, [authId, u.email, u.password_hash, rawUserMetadata]);
        }

        // Update public profile
        await db.directQuery("UPDATE users SET auth_id = $1 WHERE id = $2", [finalAuthId, u.id]);
      }
      console.log('Backfill completed.');
    }
    // 10. Sweep orphaned custodian assignments, then enforce the constraints that
    //     stop new ones ever appearing. ON DELETE CASCADE on both foreign keys means
    //     deleting an employee or an asset now removes its assignments automatically.
    const orphans = await db.directQuery(`
      DELETE FROM asset_assignments
      WHERE asset_id IS NULL
         OR asset_id NOT IN (SELECT id FROM assets)
         OR user_id IS NULL
         OR user_id NOT IN (SELECT id FROM users);
    `);
    if (orphans.rowCount > 0) {
      console.log(`Removed ${orphans.rowCount} orphaned assignment(s).`);
    }

    await db.directQuery(`
      ALTER TABLE asset_assignments DROP CONSTRAINT IF EXISTS asset_assignments_user_id_fkey;
      ALTER TABLE asset_assignments ALTER COLUMN user_id SET NOT NULL;
      ALTER TABLE asset_assignments ADD CONSTRAINT asset_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

      ALTER TABLE asset_assignments DROP CONSTRAINT IF EXISTS asset_assignments_asset_id_fkey;
      ALTER TABLE asset_assignments ALTER COLUMN asset_id SET NOT NULL;
      ALTER TABLE asset_assignments ADD CONSTRAINT asset_assignments_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;
    `);

    // 11. Backfill assignments from the legacy assets.assigned_employee column.
    //     Runs only on an empty table, and joins the user directory so user_id is
    //     never NULL — the previous version inserted NULLs that step 10 then deleted,
    //     and which violate the NOT NULL constraint added above.
    const assignCheck = await db.directQuery('SELECT COUNT(*) FROM asset_assignments');
    if (parseInt(assignCheck.rows[0].count, 10) === 0) {
      const candidates = await db.directQuery(`
        SELECT COUNT(*) FROM assets
        WHERE status = 'Assigned' AND assigned_employee IS NOT NULL AND assigned_employee <> ''
      `);
      if (parseInt(candidates.rows[0].count, 10) > 0) {
        console.log('Backfilling active assignments from assets table...');
        const inserted = await db.directQuery(`
          INSERT INTO asset_assignments (asset_id, employee_name, user_id, quantity, department, status, date)
          SELECT a.id, u.name, u.id, 1, a.department, 'Assigned', COALESCE(a.purchase_date, CURRENT_DATE)
          FROM assets a
          JOIN users u ON LOWER(TRIM(a.assigned_employee)) = LOWER(TRIM(u.name))
          WHERE a.status = 'Assigned' AND a.assigned_employee IS NOT NULL AND a.assigned_employee <> ''
          ON CONFLICT DO NOTHING;
        `);
        const skipped = parseInt(candidates.rows[0].count, 10) - inserted.rowCount;
        console.log(`Backfilled ${inserted.rowCount} assignment(s).`);
        if (skipped > 0) {
          console.warn(`Skipped ${skipped} asset(s) whose custodian does not match any user in the directory.`);
        }

        // Recompute quantities from the assignments that actually landed.
        await db.directQuery(`
          UPDATE assets a
          SET
            assigned_quantity = COALESCE(s.qty, 0),
            available_quantity = GREATEST(0, a.total_quantity - COALESCE(s.qty, 0))
          FROM (
            SELECT asset_id, SUM(quantity) AS qty
            FROM asset_assignments WHERE status = 'Assigned' GROUP BY asset_id
          ) s
          WHERE a.id = s.asset_id;
        `);
      }
    }

    // 7g. Role permissions. Previously a frontend-only matrix in localStorage that was
    //     never sent to the server; now the authoritative source. One JSONB row per
    //     role holds its permission flags, so adding a permission key later needs no
    //     schema change. Seeded once with the historical defaults.
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role VARCHAR(50) PRIMARY KEY,
        permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await db.directQuery(`
      INSERT INTO role_permissions (role, permissions) VALUES
        ('IT Admin',       '{"view":true,"write":true,"allocate":true,"delete":true,"finance":false,"viewReports":true,"viewAMC":true,"viewFinance":false,"viewDocuments":true}'::jsonb),
        ('Facility Admin', '{"view":true,"write":true,"allocate":true,"delete":true,"finance":false,"viewReports":true,"viewAMC":true,"viewFinance":false,"viewDocuments":true}'::jsonb),
        ('Finance Team',   '{"view":true,"write":false,"allocate":false,"delete":false,"finance":true,"viewReports":true,"viewAMC":true,"viewFinance":true,"viewDocuments":true}'::jsonb),
        ('Auditor',        '{"view":true,"write":false,"allocate":false,"delete":false,"finance":false,"viewReports":true,"viewAMC":true,"viewFinance":true,"viewDocuments":true}'::jsonb),
        ('Employee',       '{"view":true,"write":false,"allocate":false,"delete":false,"finance":false,"viewReports":false,"viewAMC":false,"viewFinance":false,"viewDocuments":false}'::jsonb)
      ON CONFLICT (role) DO NOTHING;
    `);

    // 7h. Document IDs were generated on the client from the array length
    //     (DOC-${length+1}) — collision-prone and not authoritative. A sequence makes
    //     the database issue them. Start it above the highest existing DOC-NNN so no
    //     id is reused.
    await db.directQuery(`CREATE SEQUENCE IF NOT EXISTS documents_doc_seq;`);
    // Advance the sequence past the highest existing DOC-NNN, but never rewind it —
    // rewinding to the current max would reissue an id whose row was later deleted.
    await db.directQuery(`
      SELECT setval('documents_doc_seq', GREATEST(
        (SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '\\D', '', 'g'), ''))::int, 0) FROM documents WHERE id ~ '^DOC-'),
        (SELECT last_value FROM documents_doc_seq),
        1
      ));
    `);

    // Timestamps are now derived from created_at and formatted in the viewer's
    // timezone. The legacy display-string columns are no longer written:
    //   notifications.time     always held the literal 'Just now'
    //   system_logs.timestamp  held new Date().toLocaleString() in the SERVER's timezone
    // They are only relaxed to NULL here, not dropped, so existing rows keep their
    // values and this migration stays reversible.
    await db.directQuery(`
      ALTER TABLE notifications ALTER COLUMN time DROP NOT NULL;
      ALTER TABLE system_logs ALTER COLUMN timestamp DROP NOT NULL;
    `);

    // Per-event notification preferences.
    //
    // Nothing is seeded, and nothing defaults to "off": an event type with no row
    // here behaves exactly as it did before this table existed — every globally
    // enabled channel fires, to the built-in audience. Existing deployments keep
    // their current behaviour until an admin changes something.
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(60) NOT NULL,
        channel VARCHAR(20) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        -- Severity floor for the whole event; only ticket events carry a priority.
        min_priority VARCHAR(20),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT notification_preferences_channel_chk CHECK (channel IN ('in_app', 'email', 'sms')),
        CONSTRAINT notification_preferences_priority_chk CHECK (min_priority IS NULL OR min_priority IN ('Low', 'Medium', 'Critical')),
        CONSTRAINT notification_preferences_unique UNIQUE (event_type, channel)
      );
    `);

    // Who hears about each event. No rows for an event means "use the built-in
    // audience" — treating an empty table as "tell nobody" would silence every
    // notification in the system the moment this migration ran.
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS notification_recipients (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(60) NOT NULL,
        role VARCHAR(50),
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT notification_recipients_target_chk CHECK (role IS NOT NULL OR user_id IS NOT NULL)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS notification_recipients_role_idx
        ON notification_recipients (event_type, role) WHERE user_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS notification_recipients_user_idx
        ON notification_recipients (event_type, user_id) WHERE role IS NULL;
      CREATE INDEX IF NOT EXISTS notification_recipients_event_idx ON notification_recipients (event_type);
    `);

    // ---- Roles & granular permission matrix ----
    //
    // Add the three requested roles that were missing. ADD VALUE IF NOT EXISTS is
    // idempotent and, on PostgreSQL 12+, safe outside an explicit transaction, which
    // is how directQuery runs each statement.
    await db.directQuery(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Admin Team';`);
    await db.directQuery(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'HR Team';`);
    await db.directQuery(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'Manager';`);

    // The permission model changed shape: from nine flat asset flags to a nested
    // module -> verb matrix. Convert any old-format row and seed any missing role,
    // from the single source of truth in permissionModel. A row is "new format" once
    // it has a top-level 'dashboard' object; anything else is old or absent and gets
    // replaced with that role's default matrix. Custom edits to the old nine flags do
    // not survive, because they have no meaning under the new module keys.
    const defaults = permissionModel.buildDefaultMatrix();
    const existing = await db.query('SELECT role, permissions FROM role_permissions');
    const byRole = Object.fromEntries(existing.rows.map((r) => [r.role, r.permissions]));

    for (const role of permissionModel.ROLES) {
      const current = byRole[role.key];
      const isNewFormat = current && typeof current === 'object' && current.dashboard && typeof current.dashboard === 'object';
      if (isNewFormat) continue;
      await db.directQuery(
        `INSERT INTO role_permissions (role, permissions, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (role) DO UPDATE SET permissions = EXCLUDED.permissions, updated_at = NOW()`,
        [role.key, JSON.stringify(defaults[role.key])]
      );
    }

    // 7i. Automated Purchase Order generation.
    //
    //   - vendors: the vendor master. Selecting one auto-fills a PO; the chosen values
    //     are then snapshotted onto the PO itself (below) so later vendor edits never
    //     rewrite an order that was already issued.
    //   - purchase_orders gains the fields a formatted PO document needs, plus
    //     server-computed totals and the amount-in-words. terms_content /
    //     terms_version freeze the master Terms & Conditions used at generation time,
    //     so an existing PO keeps its wording even after the master template changes.
    //   - purchase_order_items: the line items the totals are derived from.
    //   - po_settings: a single row holding company letterhead, authorised signature,
    //     and the configurable PO-number rule (prefix / format / padding / running
    //     sequence with optional yearly reset).
    //   - po_terms: the append-only, centrally-managed master Terms & Conditions.
    //     Editing inserts a new version rather than overwriting, which is what lets a
    //     PO reference the exact version it was built from.
    //   - purchase_order_documents: every generated PDF, versioned, for history.

    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS vendors (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        address TEXT,
        gst_vat VARCHAR(60),
        contact_person VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(60),
        default_payment_terms VARCHAR(255),
        default_currency VARCHAR(8) NOT NULL DEFAULT 'INR',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS vendors_name_lower_idx ON vendors (LOWER(name));
    `);

    await db.directQuery(`
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vendor_id INT REFERENCES vendors(id) ON DELETE SET NULL;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vendor_address TEXT;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vendor_gst VARCHAR(60);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vendor_contact_person VARCHAR(255);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vendor_email VARCHAR(255);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS vendor_phone VARCHAR(60);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS quotation_ref VARCHAR(120);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivery_schedule VARCHAR(255);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(255);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS contact_person VARCHAR(255);
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS delivery_location TEXT;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS subtotal DECIMAL(14, 2) NOT NULL DEFAULT 0.00;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS tax_total DECIMAL(14, 2) NOT NULL DEFAULT 0.00;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS discount_type VARCHAR(10) NOT NULL DEFAULT 'amount';
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS discount_value DECIMAL(14, 2) NOT NULL DEFAULT 0.00;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(14, 2) NOT NULL DEFAULT 0.00;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS amount_in_words TEXT;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS terms_version INT;
      ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS terms_content TEXT;
    `);

    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id SERIAL PRIMARY KEY,
        purchase_order_id INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        line_no INT NOT NULL DEFAULT 1,
        description TEXT NOT NULL,
        hsn_code VARCHAR(40),
        quantity DECIMAL(14, 2) NOT NULL DEFAULT 1,
        unit VARCHAR(30) NOT NULL DEFAULT 'pcs',
        unit_price DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
        tax_percent DECIMAL(6, 2) NOT NULL DEFAULT 0.00,
        line_total DECIMAL(14, 2) NOT NULL DEFAULT 0.00
      );
      CREATE INDEX IF NOT EXISTS po_items_po_idx ON purchase_order_items (purchase_order_id);
    `);

    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS po_settings (
        id INT PRIMARY KEY DEFAULT 1,
        company_name VARCHAR(255) NOT NULL DEFAULT 'NPS Enterprise',
        company_address TEXT,
        company_gst VARCHAR(60),
        company_email VARCHAR(255),
        company_phone VARCHAR(60),
        company_website VARCHAR(255),
        logo_data_url TEXT,
        signature_data_url TEXT,
        signature_name VARCHAR(255),
        signature_designation VARCHAR(255),
        number_prefix VARCHAR(30) NOT NULL DEFAULT 'PO',
        number_format VARCHAR(80) NOT NULL DEFAULT 'PO/{YYYY}/{SEQ}',
        number_padding INT NOT NULL DEFAULT 6,
        next_sequence INT NOT NULL DEFAULT 1,
        reset_sequence_yearly BOOLEAN NOT NULL DEFAULT TRUE,
        sequence_year INT,
        default_currency VARCHAR(8) NOT NULL DEFAULT 'INR',
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT po_settings_singleton CHECK (id = 1)
      );
      INSERT INTO po_settings (id, company_address, company_email, sequence_year)
        VALUES (1, '', '', EXTRACT(YEAR FROM CURRENT_DATE)::int)
        ON CONFLICT (id) DO NOTHING;
    `);

    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS po_terms (
        id SERIAL PRIMARY KEY,
        version INT NOT NULL,
        content TEXT NOT NULL,
        updated_by VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS po_terms_version_idx ON po_terms (version);
    `);

    // Seed the first master Terms & Conditions version, once.
    const termsCount = await db.directQuery('SELECT COUNT(*)::int AS c FROM po_terms');
    if (termsCount.rows[0].c === 0) {
      await db.directQuery(
        `INSERT INTO po_terms (version, content, updated_by) VALUES (1, $1, 'System')`,
        [DEFAULT_PO_TERMS]
      );
    }

    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS purchase_order_documents (
        id SERIAL PRIMARY KEY,
        purchase_order_id INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        version INT NOT NULL,
        po_number VARCHAR(60),
        file_path VARCHAR(255) NOT NULL,
        file_name VARCHAR(255),
        generated_by VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS po_documents_po_idx ON purchase_order_documents (purchase_order_id);
    `);

    // 12. SLA Management.
    //
    //   - business_calendars: working days/hours + a fixed UTC offset that the SLA
    //     engine walks to turn "resolution in 480 minutes" into a real deadline that
    //     only counts business time. is_24x7 short-circuits the walk.
    //   - calendar_holidays: dates the engine treats like weekends.
    //   - sla_policies: the configurable matching rules. Any of priority/category/
    //     department/asset_type/branch may be NULL ("any"); the most specific matching
    //     policy wins (see slaEngine.matchPolicy). Times are stored in minutes.
    //   - sla_escalation_levels: ordered levels per policy, each firing on an elapsed
    //     percentage, remaining minutes, or a breach, and notifying a configured target.
    //   - tickets gains per-ticket SLA tracking so deadlines survive later policy edits.
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS business_calendars (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        description TEXT,
        is_24x7 BOOLEAN NOT NULL DEFAULT FALSE,
        utc_offset_minutes INT NOT NULL DEFAULT 330,
        work_start VARCHAR(5) NOT NULL DEFAULT '09:00',
        work_end VARCHAR(5) NOT NULL DEFAULT '18:00',
        working_days INT[] NOT NULL DEFAULT '{1,2,3,4,5}',
        branch VARCHAR(120),
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS business_calendars_name_lower_idx ON business_calendars (LOWER(name));
    `);

    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS calendar_holidays (
        id SERIAL PRIMARY KEY,
        calendar_id INT NOT NULL REFERENCES business_calendars(id) ON DELETE CASCADE,
        holiday_date DATE NOT NULL,
        name VARCHAR(160),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS calendar_holidays_unique_idx ON calendar_holidays (calendar_id, holiday_date);
    `);

    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS sla_policies (
        id SERIAL PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        description TEXT,
        priority VARCHAR(50),
        category VARCHAR(100),
        department VARCHAR(100),
        asset_type VARCHAR(100),
        branch VARCHAR(120),
        first_response_minutes INT NOT NULL DEFAULT 240,
        resolution_minutes INT NOT NULL DEFAULT 1440,
        calendar_id INT REFERENCES business_calendars(id) ON DELETE SET NULL,
        auto_assign_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        auto_assign_strategy VARCHAR(30) NOT NULL DEFAULT 'least_loaded',
        priority_rank INT NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        archived BOOLEAN NOT NULL DEFAULT FALSE,
        created_by VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS sla_policies_active_idx ON sla_policies (active, archived);
    `);

    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS sla_escalation_levels (
        id SERIAL PRIMARY KEY,
        policy_id INT NOT NULL REFERENCES sla_policies(id) ON DELETE CASCADE,
        level INT NOT NULL,
        trigger_type VARCHAR(30) NOT NULL DEFAULT 'resolution_percent',
        threshold NUMERIC(8,2) NOT NULL DEFAULT 0,
        notify_target VARCHAR(30) NOT NULL DEFAULT 'assignee',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS sla_escalation_levels_unique_idx ON sla_escalation_levels (policy_id, level);
    `);

    await db.directQuery(`
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_policy_id INT REFERENCES sla_policies(id) ON DELETE SET NULL;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS first_response_due TIMESTAMP WITH TIME ZONE;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_due TIMESTAMP WITH TIME ZONE;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMP WITH TIME ZONE;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS response_breached BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_breached BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalation_level INT NOT NULL DEFAULT 0;
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS branch VARCHAR(120);
      ALTER TABLE tickets ADD COLUMN IF NOT EXISTS asset_type VARCHAR(100);
    `);

    // Backfill resolution_due from the legacy sla_deadline so existing tickets show a
    // deadline in the new tracking panel without a rebuild.
    await db.directQuery(`
      UPDATE tickets SET resolution_due = sla_deadline WHERE resolution_due IS NULL AND sla_deadline IS NOT NULL;
    `);

    // Seed a default business calendar and a starter set of policies, once. These
    // reproduce the previous hardcoded behaviour (Critical 10h, default 24h, Low 48h)
    // but now as editable, database-driven rows measured against business hours.
    const calCount = await db.directQuery('SELECT COUNT(*)::int AS c FROM business_calendars');
    if (calCount.rows[0].c === 0) {
      const cal = await db.directQuery(`
        INSERT INTO business_calendars (name, description, is_24x7, is_default, work_start, work_end)
        VALUES ('Standard Business Hours', 'Mon–Fri, 09:00–18:00 (IST). The default calendar for all SLA policies.', FALSE, TRUE, '09:00', '18:00')
        RETURNING id
      `);
      const calId = cal.rows[0].id;
      await db.directQuery(`
        INSERT INTO business_calendars (name, description, is_24x7, is_default, work_start, work_end)
        VALUES ('24x7', 'Round-the-clock cover for critical infrastructure. SLA timers never pause.', TRUE, FALSE, '00:00', '23:59')
      `);

      const policyCount = await db.directQuery('SELECT COUNT(*)::int AS c FROM sla_policies');
      if (policyCount.rows[0].c === 0) {
        // (name, priority, first_response_minutes, resolution_minutes, priority_rank)
        const seeds = [
          ['Critical Priority', 'Critical', 30, 600, 30],
          ['High Priority', 'High', 60, 720, 20],
          ['Medium Priority', 'Medium', 120, 1440, 10],
          ['Low Priority', 'Low', 240, 2880, 5],
          ['Default', null, 240, 1440, 0]
        ];
        for (const [name, priority, fr, res, rank] of seeds) {
          const p = await db.directQuery(
            `INSERT INTO sla_policies (name, priority, first_response_minutes, resolution_minutes, calendar_id, priority_rank, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, 'System') RETURNING id`,
            [name, priority, fr, res, calId, rank]
          );
          const policyId = p.rows[0].id;
          // A sensible four-level escalation ladder for every seeded policy.
          await db.directQuery(
            `INSERT INTO sla_escalation_levels (policy_id, level, trigger_type, threshold, notify_target) VALUES
               ($1, 1, 'resolution_percent', 50, 'assignee'),
               ($1, 2, 'resolution_percent', 75, 'team_lead'),
               ($1, 3, 'resolution_percent', 90, 'department_manager'),
               ($1, 4, 'resolution_breach', 0, 'super_admin')`,
            [policyId]
          );
        }
      }
    }

    // 13. Scheduled reports: a report key + saved filters + a delivery cadence and
    //     recipient list. The daily job (reports.runDueScheduledReports) generates each
    //     due report and emails it, then advances next_run.
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS scheduled_reports (
        id SERIAL PRIMARY KEY,
        report_key VARCHAR(60) NOT NULL,
        name VARCHAR(160),
        filters JSONB NOT NULL DEFAULT '{}'::jsonb,
        frequency VARCHAR(20) NOT NULL DEFAULT 'weekly',
        recipients TEXT[] NOT NULL DEFAULT '{}',
        format VARCHAR(10) NOT NULL DEFAULT 'csv',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        last_run TIMESTAMP WITH TIME ZONE,
        next_run TIMESTAMP WITH TIME ZONE,
        created_by VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS scheduled_reports_due_idx ON scheduled_reports (active, next_run);
    `);

    // 14. Asset master data + optional lifecycle fields.
    //   - associate_department: a secondary owning department, captured in both the
    //     manual registration form and the bulk importer.
    //   - depreciation_life_years becomes nullable so Useful Lifespan is optional.
    await db.directQuery(`
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS associate_department VARCHAR(100);
      ALTER TABLE assets ALTER COLUMN depreciation_life_years DROP NOT NULL;
    `);

    // asset_subtypes is the master list of valid Item Types (Asset Tag Subtypes)
    // per Asset Category. It replaces the old hard-coded IT->Laptop / Office->Chair
    // assumption: the UI reads it to build category-dependent dropdowns and the bulk
    // importer validates against it. Admins can add rows without them being wiped.
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS asset_subtypes (
        id SERIAL PRIMARY KEY,
        category asset_category NOT NULL,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS asset_subtypes_cat_name_idx
        ON asset_subtypes (category, LOWER(name));
    `);

    // Seed the default catalogue. ON CONFLICT DO NOTHING makes re-runs a no-op and
    // preserves any admin-added rows.
    await db.directQuery(`
      INSERT INTO asset_subtypes (category, name) VALUES
        ('IT','Laptop'),('IT','Desktop'),('IT','Monitor'),('IT','Printer'),
        ('IT','Keyboard'),('IT','Mouse'),('IT','Server'),('IT','Switch'),
        ('IT','Router'),('IT','UPS'),('IT','Storage'),('IT','Mobile'),
        ('IT','Tablet'),('IT','Scanner'),('IT','Projector'),('IT','Docking Station'),
        ('IT','Network Attached Storage'),('IT','Firewall'),
        ('Office','Chair'),('Office','Desk'),('Office','Table'),('Office','Cabinet'),
        ('Office','Sofa'),('Office','Whiteboard'),('Office','Projector Screen'),
        ('Office','AC'),('Office','Fan'),('Office','CCTV'),
        ('Office','Fire Extinguisher'),('Office','Water Dispenser'),('Office','Locker')
      ON CONFLICT DO NOTHING;
    `);

    console.log('Database migrations completed successfully.');
  } catch (err) {
    console.error('Database migration failed:', err);
    throw err;
  }
};

module.exports = { runMigrations };
