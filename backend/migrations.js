const db = require('./db');

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

    console.log('Database migrations completed successfully.');
  } catch (err) {
    console.error('Database migration failed:', err);
    throw err;
  }
};

module.exports = { runMigrations };
