const db = require('./db');

const createBaseTables = async () => {
  console.log('Creating base PostgreSQL tables...');
  try {
    // 1. Create Enums and Tables
    await db.directQuery(`
      CREATE OR REPLACE FUNCTION create_enums() RETURNS void AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
          CREATE TYPE user_role AS ENUM ('Super Admin', 'IT Admin', 'Facility Admin', 'Finance Team', 'Employee', 'Auditor', 'Admin Team', 'HR Team', 'Manager');
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
        workos_user_id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        role user_role NOT NULL DEFAULT 'Employee',
        email VARCHAR(255) UNIQUE NOT NULL,
        employee_id VARCHAR(50) UNIQUE,
        phone_number VARCHAR(50),
        department VARCHAR(100),
        designation VARCHAR(100),
        location VARCHAR(100),
        manager_id VARCHAR(255) REFERENCES users(workos_user_id),
        status VARCHAR(50) DEFAULT 'Active',
        notification_preferences JSONB DEFAULT '{"email": true, "push": true}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
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
        timestamp VARCHAR(100),
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
        time VARCHAR(50),
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

    console.log('Base tables created successfully.');
  } catch (err) {
    console.error('Base table creation encountered an error:', err);
    throw err;
  }
};

const seedData = async () => {
  console.log('Seeding PostgreSQL database records...');
  try {
    // No user is pre-seeded. The Super Admin profile is provisioned automatically on
    // the first WorkOS sign-in by BOOTSTRAP_ADMIN_EMAIL (see src/routes/auth.js
    // provisionAndIssueToken), linked to the real WorkOS user id — so there is no fake
    // placeholder id to relink or clean up later.
    console.log('Database records seeded successfully.');
  } catch (err) {
    console.error('Seeding encountered an error:', err);
  } finally {
    await db.directPool.end();
  }
};

module.exports = {
  createBaseTables,
  seedData,
};
