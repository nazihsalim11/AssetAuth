const db = require('./db');
const bcrypt = require('bcryptjs');

const seedDatabase = async () => {
  console.log('Starting PostgreSQL database seeding...');

  try {
    // 1. Create Enums and Tables
    await db.directQuery(`
      CREATE OR REPLACE FUNCTION create_enums() RETURNS void AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
          CREATE TYPE user_role AS ENUM ('Super Admin', 'IT Admin', 'Facility Admin', 'Finance Team', 'Employee', 'Auditor');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'asset_category') THEN
          CREATE TYPE asset_category AS ENUM ('IT', 'Office');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'asset_status') THEN
          CREATE TYPE asset_status AS ENUM ('Available', 'Assigned', 'Under Maintenance', 'Disposed');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_status') THEN
          CREATE TYPE invoice_status AS ENUM ('Pending', 'Partially Paid', 'Paid', 'Overdue');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'movement_type') THEN
          CREATE TYPE movement_type AS ENUM ('Allocation', 'Transfer', 'Return', 'Disposal', 'Procurement', 'Status Change');
        END IF;
      END;
      $$ LANGUAGE plpgsql;
      
      SELECT create_enums();
    `);

    // Create users table
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role user_role NOT NULL DEFAULT 'Employee',
        email VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create amcs table
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS amcs (
        id VARCHAR(50) PRIMARY KEY,
        vendor VARCHAR(255) NOT NULL,
        cost DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        service_schedule VARCHAR(100),
        agreement_file VARCHAR(255),
        service_history JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create invoices table
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS invoices (
        id VARCHAR(50) PRIMARY KEY,
        po_reference VARCHAR(100),
        vendor VARCHAR(255) NOT NULL,
        amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
        gst INT DEFAULT 0,
        date DATE NOT NULL,
        payment_status invoice_status NOT NULL DEFAULT 'Pending',
        file_name VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create assets table
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS assets (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        serial_number VARCHAR(100) UNIQUE,
        category asset_category NOT NULL,
        type VARCHAR(100) NOT NULL,
        status asset_status NOT NULL DEFAULT 'Available',
        cost DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
        purchase_date DATE,
        warranty_expiry DATE,
        department VARCHAR(100),
        location VARCHAR(100),
        amc_id VARCHAR(50) REFERENCES amcs(id) ON DELETE SET NULL,
        invoice_id VARCHAR(50) REFERENCES invoices(id) ON DELETE SET NULL,
        assigned_employee VARCHAR(255),
        depreciation_life_years INT NOT NULL DEFAULT 5,
        disposal_date DATE,
        disposal_reason TEXT,
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create movements table
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS movements (
        id SERIAL PRIMARY KEY,
        asset_id VARCHAR(50) REFERENCES assets(id) ON DELETE CASCADE,
        date DATE NOT NULL DEFAULT CURRENT_DATE,
        type movement_type NOT NULL,
        from_loc VARCHAR(255),
        to_loc VARCHAR(255),
        actor VARCHAR(255) NOT NULL,
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create documents table
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS documents (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(100) NOT NULL,
        file_size VARCHAR(50),
        upload_date VARCHAR(50) NOT NULL,
        association VARCHAR(255),
        file_url VARCHAR(255) DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create system_logs table
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id SERIAL PRIMARY KEY,
        timestamp VARCHAR(100) NOT NULL,
        actor VARCHAR(255) NOT NULL,
        action VARCHAR(100) NOT NULL,
        detail TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create notifications table
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS notifications (
        id VARCHAR(50) PRIMARY KEY,
        text TEXT NOT NULL,
        type VARCHAR(50) NOT NULL DEFAULT 'info',
        time VARCHAR(50) NOT NULL,
        read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create emails table (for simulated alerts monitor)
    await db.directQuery(`
      CREATE TABLE IF NOT EXISTS emails (
        id VARCHAR(50) PRIMARY KEY,
        sender VARCHAR(255) NOT NULL,
        date VARCHAR(100) NOT NULL,
        subject VARCHAR(255) NOT NULL,
        body TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('Tables verified/created successfully.');

    // Seed Users
    const userCheck = await db.directQuery('SELECT COUNT(*) FROM users');
    if (parseInt(userCheck.rows[0].count) === 0) {
      console.log('Seeding users table with hashed credentials...');
      const usersToSeed = [
        { username: "admin", pass: "Admin@123", name: "Admin Operations", role: "Super Admin", email: "admin@company.com" },
        { username: "itadmin", pass: "IT@123", name: "IT Operations", role: "IT Admin", email: "itadmin@company.com" },
        { username: "facilityadmin", pass: "Facility@123", name: "Facility Operations", role: "Facility Admin", email: "facilityadmin@company.com" },
        { username: "finance", pass: "Finance@123", name: "Finance Operations", role: "Finance Team", email: "finance@company.com" },
        { username: "employee", pass: "Employee@123", name: "Alice Johnson", role: "Employee", email: "employee@company.com" },
        { username: "auditor", pass: "Auditor@123", name: "Audit Team", role: "Auditor", email: "auditor@company.com" }
      ];

      const { randomUUID } = require('crypto');
      for (const u of usersToSeed) {
        const hash = await bcrypt.hash(u.pass, 10);
        const authId = randomUUID();

        // Insert auth record
        const rawUserMetadata = JSON.stringify({ name: u.name, role: u.role, username: u.username });
        const authQuery = `
          INSERT INTO auth.users (
            id, instance_id, email, encrypted_password, aud, role, 
            is_sso_user, is_anonymous, email_confirmed_at, 
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at
          ) VALUES ($1, '00000000-0000-0000-0000-000000000000', $2, $3, 'authenticated', 'authenticated', 
                    false, false, NOW(), 
                    '{"provider":"email","providers":["email"]}'::jsonb, $4::jsonb, NOW(), NOW())
        `;
        await db.directQuery(authQuery, [authId, u.email, hash, rawUserMetadata]);

        // Insert public profile
        await db.directQuery(
          'INSERT INTO users (username, password_hash, name, role, email, auth_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [u.username, hash, u.name, u.role, u.email, authId]
        );
      }
      console.log('Users seeded.');
    }

    // Seed AMCs
    const amcCheck = await db.directQuery('SELECT COUNT(*) FROM amcs');
    if (parseInt(amcCheck.rows[0].count) === 0) {
      console.log('Seeding amcs table...');
      await db.directQuery(`
        INSERT INTO amcs (id, vendor, cost, start_date, end_date, service_schedule, agreement_file, service_history) VALUES
        ('AMC-101', 'Carrier CoolCare Services', 150, '2026-01-01', '2026-12-31', 'Quarterly', 'carrier_amc_2026.pdf', '[{"date": "2026-02-15", "type": "Routine Filter Cleaning", "notes": "Done by tech John."}, {"date": "2026-05-18", "type": "Gas Recharge", "notes": "Completed successfully."}]'::jsonb),
        ('AMC-102', 'Dell Enterprise Support', 800, '2026-06-01', '2026-11-01', 'Bi-Annual', 'dell_support_agreement.pdf', '[{"date": "2026-06-10", "type": "Firmware Diagnostics", "notes": "No hardware errors found."}]'::jsonb);
      `);
    }

    // Seed Invoices
    const invoiceCheck = await db.directQuery('SELECT COUNT(*) FROM invoices');
    if (parseInt(invoiceCheck.rows[0].count) === 0) {
      console.log('Seeding invoices table...');
      await db.directQuery(`
        INSERT INTO invoices (id, po_reference, vendor, amount, gst, date, payment_status, file_name) VALUES
        ('INV-101', 'PO-2025-001', 'TechDistributors LLC', 1720, 18, '2025-01-10', 'Paid', 'invoice_101_techdist.pdf'),
        ('INV-102', 'PO-2025-042', 'Apple Retail Corp.', 2400, 0, '2025-06-05', 'Paid', 'apple_invoice_MBP.pdf'),
        ('INV-103', 'PO-2024-118', 'Office Space Solutions', 1200, 12, '2024-09-01', 'Paid', 'herman_miller_invoice.pdf'),
        ('INV-104', 'PO-2023-089', 'Tokyo AC Retailers', 850, 10, '2023-05-18', 'Paid', 'carrier_ac_invoice.pdf'),
        ('INV-105', 'PO-2024-902', 'Dell Commercial Sales', 7500, 18, '2024-10-25', 'Partially Paid', 'dell_invoice_R750.pdf'),
        ('INV-106', 'PO-2026-004', 'Office Depot Corp.', 450, 12, '2026-06-01', 'Pending', 'stationery_invoice.pdf'),
        ('INV-107', 'PO-2026-009', 'NetSupply Co.', 3500, 18, '2026-05-10', 'Overdue', 'switch_invoice_netsupply.pdf');
      `);
    }

    // Seed Assets
    const assetCheck = await db.directQuery('SELECT COUNT(*) FROM assets');
    if (parseInt(assetCheck.rows[0].count) === 0) {
      console.log('Seeding assets table...');
      await db.directQuery(`
        INSERT INTO assets (id, name, serial_number, category, type, status, cost, purchase_date, warranty_expiry, department, location, amc_id, invoice_id, assigned_employee, depreciation_life_years, notes) VALUES
        ('AST-001', 'Dell XPS 15 Laptop', 'CN-0V2D6M-89102', 'IT', 'Laptops', 'Assigned', 1500, '2025-01-15', '2027-01-15', 'Engineering', 'New York HQ', NULL, 'INV-101', 'Alice Johnson', 4, 'Developer workstation with 32GB RAM.'),
        ('AST-002', 'MacBook Pro 16"', 'C02F87DKMD6R', 'IT', 'Laptops', 'Assigned', 2400, '2025-06-10', '2026-06-10', 'Engineering', 'London Branch', NULL, 'INV-102', 'Bob Smith', 3, 'M3 Max, 64GB RAM, 1TB SSD.'),
        ('AST-003', 'Herman Miller Aeron Chair', 'HM-AER-98273', 'Office', 'Chairs', 'Available', 1200, '2024-09-05', '2029-09-05', 'HR', 'New York HQ', NULL, 'INV-103', '', 10, 'Ergonomic chair, size B.'),
        ('AST-004', 'Carrier 2-Ton Split AC', 'CR-AC-908273', 'Office', 'AC Units', 'Under Maintenance', 850, '2023-05-20', '2025-05-20', 'Operations', 'Tokyo Office', 'AMC-101', 'INV-104', '', 5, 'Needs compressor servicing.'),
        ('AST-005', 'Dell 24" IPS Monitor', 'CN-0M3892-1209', 'IT', 'Monitors', 'Assigned', 220, '2025-02-12', '2028-02-12', 'HR', 'London Branch', NULL, 'INV-101', 'Charlie Brown', 5, 'Secondary display for HR workspace.'),
        ('AST-006', 'PowerEdge R750 Server', 'Dell-PE-R750-X82', 'IT', 'Servers', 'Available', 7500, '2024-11-01', '2027-11-01', 'Engineering', 'New York HQ', 'AMC-102', 'INV-105', '', 5, 'Rack mount database server.');
      `);
    }

    // Seed Movements
    const movementCheck = await db.directQuery('SELECT COUNT(*) FROM movements');
    if (parseInt(movementCheck.rows[0].count) === 0) {
      console.log('Seeding movements table...');
      await db.directQuery(`
        INSERT INTO movements (asset_id, date, type, from_loc, to_loc, actor, notes) VALUES
        ('AST-001', '2025-01-15', 'Procurement', 'TechDistributors LLC', 'Inventory (New York HQ)', 'Finance Team', 'Purchased under PO-2025-001'),
        ('AST-001', '2025-01-16', 'Allocation', 'Inventory', 'Alice Johnson (HR)', 'IT Admin', 'Developer XPS assigned.'),
        ('AST-002', '2025-06-10', 'Procurement', 'Apple Retail', 'Inventory (London)', 'Finance Team', 'Standard issue MacBook Pro'),
        ('AST-002', '2025-06-12', 'Allocation', 'Inventory', 'Bob Smith (Engineering)', 'IT Admin', 'Engineering laptop assigned.'),
        ('AST-004', '2023-05-20', 'Procurement', 'Tokyo AC Retailers', 'Operations (Tokyo)', 'Finance Team', 'Office cooling infrastructure'),
        ('AST-004', '2025-07-01', 'Status Change', 'Available', 'Under Maintenance', 'Facility Admin', 'Sent for compressor servicing under AMC AMC-101');
      `);
    }

    // Seed Documents
    const documentCheck = await db.directQuery('SELECT COUNT(*) FROM documents');
    if (parseInt(documentCheck.rows[0].count) === 0) {
      console.log('Seeding documents table...');
      await db.directQuery(`
        INSERT INTO documents (id, name, type, file_size, upload_date, association, file_url) VALUES
        ('DOC-001', 'dell_invoice_R750.pdf', 'Invoice', '450 KB', '2024-10-26', 'Invoice INV-105', ''),
        ('DOC-002', 'carrier_amc_2026.pdf', 'AMC Agreement', '1.2 MB', '2026-01-02', 'AMC AMC-101', ''),
        ('DOC-003', 'macbook_warranty_card.pdf', 'Warranty Certificate', '820 KB', '2025-06-11', 'Asset AST-002', '');
      `);
    }

    // Seed Logs
    const logCheck = await db.directQuery('SELECT COUNT(*) FROM system_logs');
    if (parseInt(logCheck.rows[0].count) === 0) {
      console.log('Seeding system_logs table...');
      await db.directQuery(`
        INSERT INTO system_logs (timestamp, actor, action, detail) VALUES
        ('2026-07-06 09:15 AM', 'Super Admin', 'User Login', 'System session initialized.'),
        ('2026-07-06 10:20 AM', 'IT Admin', 'Asset Allocation', 'Assigned Dell XPS 15 (AST-001) to Alice Johnson.'),
        ('2026-07-06 11:45 AM', 'Finance Team', 'Invoice Upload', 'Uploaded NetSupply Invoice INV-107, marked Overdue.');
      `);
    }

    // Seed Emails
    const emailCheck = await db.directQuery('SELECT COUNT(*) FROM emails');
    if (parseInt(emailCheck.rows[0].count) === 0) {
      console.log('Seeding emails table...');
      await db.directQuery(`
        INSERT INTO emails (id, sender, date, subject, body) VALUES
        ('EML-001', 'AssetFlow Monitor', '2026-07-06 08:00 AM', 'ALERT: Overdue Invoice Payments', 'Hi Team,\n\nThis is an automated alert. Invoice INV-107 from vendor NetSupply Co. amounting to $3500.00 is currently marked as OVERDUE. Please review and process the payments immediately.\n\nRegards,\nAssetFlow Finance Bot'),
        ('EML-002', 'AMC Alerts Engine', '2026-07-05 10:30 AM', 'WARNING: Dell Enterprise Support Contract Expiring Soon', 'Attention Facilities/IT Admins,\n\nAMC Contract AMC-102 (Dell Enterprise Support) mapped to Asset AST-006 (PowerEdge R750 Server) is expiring on 2026-11-01 (within 120 days). Please coordinate with the vendor for renewals.\n\nRegards,\nContract Management Engine'),
        ('EML-003', 'Warranty Monitoring', '2026-07-04 09:00 AM', 'NOTIF: Warranty Expiry Warning for MacBook Pro', 'Dear Administrator,\n\nThe warranty of Asset AST-002 (MacBook Pro 16", Serial: C02F87DKMD6R) will expire on 2026-06-10. Please log any pending hardware repairs prior to expiration.\n\nRegards,\nWarranty Engine');
      `);
    }

    // Seed Notifications
    const notificationCheck = await db.directQuery('SELECT COUNT(*) FROM notifications');
    if (parseInt(notificationCheck.rows[0].count) === 0) {
      console.log('Seeding notifications table...');
      await db.directQuery(`
        INSERT INTO notifications (id, text, type, time, read) VALUES
        ('NTF-001', 'Invoice INV-107 from NetSupply Co. is OVERDUE ($3500)', 'error', '2 hours ago', FALSE),
        ('NTF-002', 'AMC Contract AMC-102 expiring soon (Dell Enterprise Support)', 'warning', '1 day ago', FALSE),
        ('NTF-003', 'Asset AST-004 (AC Unit) status set to Under Maintenance', 'info', '5 days ago', TRUE);
      `);
    }

    console.log('Database seeded successfully.');
  } catch (err) {
    console.error('Seeding encountered an error:', err);
  } finally {
    db.directPool.end();
  }
};

seedDatabase();
