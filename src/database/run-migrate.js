const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ DATABASE_URL is missing in .env!');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function migrateAndSeed() {
  console.log('⚡ CONNECTING TO NEON POSTGRESQL & CREATING RBAC TABLES...');

  await pool.query(`
    DO $$ BEGIN
        CREATE TYPE role AS ENUM ('CLIENT', 'ADMIN', 'SUPER_ADMIN');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE TYPE user_status AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE TYPE token_type AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE TYPE kyc_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    DO $$ BEGIN
        CREATE TYPE field_type AS ENUM ('text', 'number', 'select', 'file', 'date', 'checkbox');
    EXCEPTION WHEN duplicate_object THEN null; END $$;

    -- 1. Dynamic Roles Table
    CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL UNIQUE,
      description TEXT,
      permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_system BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );

    -- 2. Users Table
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      first_name VARCHAR(100),
      last_name VARCHAR(100),
      role role NOT NULL DEFAULT 'CLIENT',
      status user_status NOT NULL DEFAULT 'PENDING_VERIFICATION',
      is_email_verified BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );

    -- Alter users table to add role_id if not present
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES roles(id) ON DELETE SET NULL;
  `);

  console.log('✅ TABLES & COLUMNS UPDATED SUCCESSFULLY IN NEON POSTGRESQL!');

  // Seed default Roles
  const allPermissions = [
    'kyc.view', 'kyc.create', 'kyc.edit', 'kyc.delete', 'kyc.review',
    'users.view', 'users.create', 'users.edit', 'users.suspend',
    'roles.view', 'roles.manage',
    'trading.view', 'trading.edit',
    'withdrawals.view', 'withdrawals.approve'
  ];

  const superAdminRole = await pool.query(`
    INSERT INTO roles (name, description, permissions, is_system)
    VALUES ('Super Admin', 'Full access to all system modules and management settings', $1, true)
    ON CONFLICT (name) DO UPDATE SET permissions = $1
    RETURNING id;
  `, [JSON.stringify(allPermissions)]);

  await pool.query(`
    INSERT INTO roles (name, description, permissions, is_system)
    VALUES ('Compliance Manager', 'Manage KYC dynamic fields, verification queue, and user status', $1, true)
    ON CONFLICT (name) DO NOTHING;
  `, [JSON.stringify(['kyc.view', 'kyc.create', 'kyc.edit', 'kyc.delete', 'kyc.review', 'users.view'])]);

  const adminPasswordHash = await bcrypt.hash('admin123', 10);
  await pool.query(
    `
    INSERT INTO users (email, password_hash, first_name, last_name, role, role_id, status, is_email_verified)
    VALUES ('admin@bbcorp.com', $1, 'Master', 'Admin', 'SUPER_ADMIN', $2, 'ACTIVE', true)
    ON CONFLICT (email) DO UPDATE SET password_hash = $1, role_id = $2, status = 'ACTIVE';
  `,
    [adminPasswordHash, superAdminRole.rows[0]?.id],
  );

  console.log('🎉 SEEDING COMPLETE! DEFAULT ROLES & SUPER ADMIN (admin@bbcorp.com / admin123) READY!');
  await pool.end();
}

migrateAndSeed().catch((err) => {
  console.error('❌ MIGRATION FAILED:', err);
  process.exit(1);
});
