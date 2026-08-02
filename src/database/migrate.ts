import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcryptjs';

dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ DATABASE_URL is missing in .env!');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

const db = drizzle(pool, { schema });

async function migrateAndSeed() {
  console.log('⚡ CONNECTING TO NEON POSTGRESQL & CREATING TABLES...');

  // Create tables using raw DDL queries to guarantee instant setup on Neon
  await pool.query(`
    -- Create Enums if they don't exist
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

    -- 1. Users Table
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

    -- 2. Verification Tokens Table
    CREATE TABLE IF NOT EXISTS verification_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(255) NOT NULL UNIQUE,
      type token_type NOT NULL,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );

    -- 3. Dynamic KYC Fields Table
    CREATE TABLE IF NOT EXISTS kyc_fields (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      field_name VARCHAR(100) NOT NULL UNIQUE,
      label VARCHAR(255) NOT NULL,
      field_type field_type NOT NULL,
      options JSONB,
      is_required BOOLEAN NOT NULL DEFAULT true,
      is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );

    -- 4. KYC Submissions Table
    CREATE TABLE IF NOT EXISTS kyc_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status kyc_status NOT NULL DEFAULT 'PENDING',
      rejection_reason TEXT,
      reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );

    -- 5. KYC Field Values Table
    CREATE TABLE IF NOT EXISTS kyc_field_values (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id UUID NOT NULL REFERENCES kyc_submissions(id) ON DELETE CASCADE,
      field_id UUID NOT NULL REFERENCES kyc_fields(id) ON DELETE CASCADE,
      value_text TEXT,
      file_url TEXT,
      file_name VARCHAR(255),
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    );
  `);

  console.log('✅ TABLES CREATED SUCCESSFULLY IN NEON POSTGRESQL!');

  // Seed default Super Admin user
  console.log('🌱 SEEDING DEFAULT SUPER ADMIN & DEFAULT DYNAMIC KYC FIELDS...');

  const adminPasswordHash = await bcrypt.hash('admin123', 10);
  await pool.query(
    `
    INSERT INTO users (email, password_hash, first_name, last_name, role, status, is_email_verified)
    VALUES ('admin@oxshare.com', $1, 'Master', 'Admin', 'SUPER_ADMIN', 'ACTIVE', true)
    ON CONFLICT (email) DO UPDATE SET password_hash = $1, status = 'ACTIVE';
  `,
    [adminPasswordHash],
  );

  // Seed default Dynamic KYC fields (Proof of ID, Proof of Address, Tax ID)
  await pool.query(`
    INSERT INTO kyc_fields (field_name, label, field_type, options, is_required, is_active, sort_order)
    VALUES 
      ('id_document', 'Government Photo ID (Passport / National ID / Driving License)', 'file', null, true, true, 1),
      ('proof_of_address', 'Proof of Address (Utility Bill / Bank Statement)', 'file', null, true, true, 2),
      ('tax_id', 'Tax Identification Number (TIN / SSN)', 'text', null, false, true, 3),
      ('country_residence', 'Country of Residence', 'select', '["United Arab Emirates", "Saudi Arabia", "Kuwait", "Qatar", "Bahrain", "Oman", "Jordan", "Lebanon", "United Kingdom", "Germany"]', true, true, 4)
    ON CONFLICT (field_name) DO NOTHING;
  `);

  console.log('🎉 SEEDING COMPLETE! DEFAULT SUPER ADMIN (admin@oxshare.com / admin123) READY!');
  await pool.end();
}

migrateAndSeed().catch((err) => {
  console.error('❌ MIGRATION FAILED:', err);
  process.exit(1);
});
