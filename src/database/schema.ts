import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  pgEnum,
} from 'drizzle-orm/pg-core';

// Enums
export const roleEnum = pgEnum('role', ['CLIENT', 'ADMIN', 'SUPER_ADMIN']);
export const userStatusEnum = pgEnum('user_status', [
  'PENDING_VERIFICATION',
  'ACTIVE',
  'SUSPENDED',
]);
export const tokenTypeEnum = pgEnum('token_type', [
  'EMAIL_VERIFY',
  'PASSWORD_RESET',
]);
export const kycStatusEnum = pgEnum('kyc_status', [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CHANGES_REQUESTED',
]);
export const fieldTypeEnum = pgEnum('field_type', [
  'text',
  'number',
  'select',
  'file',
  'date',
  'checkbox',
]);

// 1. Users Table
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  firstName: varchar('first_name', { length: 100 }),
  lastName: varchar('last_name', { length: 100 }),
  role: roleEnum('role').default('CLIENT').notNull(),
  status: userStatusEnum('status').default('PENDING_VERIFICATION').notNull(),
  isEmailVerified: boolean('is_email_verified').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 2. Verification Tokens Table (for Email verification & Password Reset)
export const verificationTokens = pgTable('verification_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  token: varchar('token', { length: 255 }).notNull().unique(),
  type: tokenTypeEnum('type').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 3. Dynamic Admin-Configured KYC Fields Table
export const kycFields = pgTable('kyc_fields', {
  id: uuid('id').defaultRandom().primaryKey(),
  fieldName: varchar('field_name', { length: 100 }).notNull().unique(),
  label: varchar('label', { length: 255 }).notNull(),
  fieldType: fieldTypeEnum('field_type').notNull(),
  options: jsonb('options').$type<string[]>(), // For 'select' inputs
  isRequired: boolean('is_required').default(true).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 4. KYC Submissions Table
export const kycSubmissions = pgTable('kyc_submissions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  status: kycStatusEnum('status').default('PENDING').notNull(),
  rejectionReason: text('rejection_reason'),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 5. KYC Submitted Values Table
export const kycFieldValues = pgTable('kyc_field_values', {
  id: uuid('id').defaultRandom().primaryKey(),
  submissionId: uuid('submission_id')
    .references(() => kycSubmissions.id, { onDelete: 'cascade' })
    .notNull(),
  fieldId: uuid('field_id')
    .references(() => kycFields.id, { onDelete: 'cascade' })
    .notNull(),
  valueText: text('value_text'),
  fileUrl: text('file_url'),
  fileName: varchar('file_name', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
