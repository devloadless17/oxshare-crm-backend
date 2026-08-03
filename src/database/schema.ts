import {
  boolean,
  numeric,
  uniqueIndex,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// Drizzle schema for the LIVE domain model, aligned with ARCHITECTURE §5 where
// that section defines the table (users) and with the in-memory stores being
// migrated (src/store/*.store.ts) everywhere else.
//
// The money tables below are governed by ARCHITECTURE §6, which is
// non-negotiable. Read it before touching them. Still deferred: the
// trading/IB tables (deals, trading_accounts, ib_profiles/programs,
// commission_accruals, referral_attributions) — they arrive with the MT5
// bridge and the commission engine.

export const userTypeEnum = pgEnum('user_type', ['individual', 'referral', 'partner']);
export const userStatusEnum = pgEnum('user_status', ['active', 'pending', 'suspended']);
export const kycStatusEnum = pgEnum('kyc_status', [
  'not_started',
  'in_progress',
  'submitted',
  'under_review',
  'approved',
  'rejected',
]);
export const adminRoleEnum = pgEnum('admin_role', ['master_admin', 'sub_admin']);
export const rejectionContextEnum = pgEnum('rejection_context', ['kyc', 'withdrawal']);

// ── users (ARCHITECTURE §5; indexes per "Required indexes") ──────────────────
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    type: userTypeEnum('type').notNull().default('individual'),
    status: userStatusEnum('status').notNull().default('active'),
    verificationLevel: integer('verification_level').notNull().default(0),
    emailVerified: boolean('email_verified').notNull().default(false),
    emailVerificationToken: varchar('email_verification_token', { length: 255 }),
    emailVerificationExpiry: timestamp('email_verification_expiry', { withTimezone: true }),
    refreshToken: text('refresh_token'),
    country: varchar('country', { length: 100 }),
    phone: varchar('phone', { length: 32 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('users_type_idx').on(t.type),
    index('users_status_idx').on(t.status),
    index('users_verification_level_idx').on(t.verificationLevel),
    index('users_created_at_idx').on(t.createdAt),
    index('users_country_idx').on(t.country),
  ],
);

// ── RBAC ─────────────────────────────────────────────────────────────────────
export const roles = pgTable('roles', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  description: text('description'),
  permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const admins = pgTable('admins', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  role: adminRoleEnum('role').notNull().default('sub_admin'),
  permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
  roleId: uuid('role_id').references(() => roles.id, { onDelete: 'restrict' }),
  refreshToken: text('refresh_token'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const adminInvites = pgTable('admin_invites', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  token: varchar('token', { length: 255 }).notNull().unique(),
  role: adminRoleEnum('role').notNull().default('sub_admin'),
  roleId: uuid('role_id').references(() => roles.id, { onDelete: 'set null' }),
  permissions: jsonb('permissions').$type<string[]>(),
  invitedBy: uuid('invited_by').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  accepted: boolean('accepted').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Compliance / KYC ─────────────────────────────────────────────────────────
export const kycSubmissions = pgTable(
  'kyc_submissions',
  {
    userId: uuid('user_id').primaryKey(), // one submission per user (FSD lifecycle)
    status: kycStatusEnum('status').notNull().default('not_started'),
    personalInfo: jsonb('personal_info').$type<Record<string, string>>(),
    document: jsonb('document').$type<Record<string, string>>(),
    selfie: jsonb('selfie').$type<Record<string, string>>(),
    addressProof: jsonb('address_proof').$type<Record<string, string>>(),
    rejectionReason: text('rejection_reason'),
    rejectedFields: jsonb('rejected_fields').$type<string[]>(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('kyc_submissions_status_idx').on(t.status)],
);

export const kycConfigSteps = pgTable('kyc_config_steps', {
  id: text('id').primaryKey(), // human slugs like 'step-personal' from the builder
  stepNumber: integer('step_number').notNull(),
  slug: varchar('slug', { length: 100 }).notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description'),
  icon: varchar('icon', { length: 50 }),
  enabled: boolean('enabled').notNull().default(true),
  fields: jsonb('fields').$type<Record<string, unknown>[]>().notNull().default([]),
});

export const rejectionReasons = pgTable(
  'rejection_reasons',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    context: rejectionContextEnum('context').notNull(),
    label: varchar('label', { length: 500 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('rejection_reasons_context_label_uq').on(t.context, t.label)],
);


// ═══ MONEY (ARCHITECTURE §6 — non-negotiable) ════════════════════════════════
//
// 1. NUMERIC(28,8) everywhere; node-postgres hands these to JS as STRINGS and
//    they must stay strings across every boundary. decimal.js does the math.
// 2. Every ledger write locks the wallet row (SELECT ... FOR UPDATE) inside one
//    transaction — see WalletService.post().
// 3. Idempotency lives in these constraints, never in check-then-insert.
// 4. ledger_entries is APPEND ONLY — enforced by a database trigger in the
//    migration, not by convention. Corrections are compensating rows.

export const currencyEnum = pgEnum('currency', ['USD', 'USDT']);
export const ledgerEntryTypeEnum = pgEnum('ledger_entry_type', [
  'deposit',
  'withdrawal',
  'commission',
  'rebate',
  'payout',
  'adjustment',
]);

export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    currency: currencyEnum('currency').notNull(),
    balance: numeric('balance', { precision: 28, scale: 8 }).notNull().default('0'),
    onHold: numeric('on_hold', { precision: 28, scale: 8 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('wallets_user_currency_uq').on(t.userId, t.currency)],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    // Signed: credits positive, debits negative. Sum per wallet == balance.
    amount: numeric('amount', { precision: 28, scale: 8 }).notNull(),
    // The running balance AFTER this entry (FSD requirement, §6.2).
    balanceAfter: numeric('balance_after', { precision: 28, scale: 8 }).notNull(),
    entryType: ledgerEntryTypeEnum('entry_type').notNull(),
    // What caused this row — every money movement traces back to its cause.
    referenceType: varchar('reference_type', { length: 50 }).notNull(),
    referenceId: varchar('reference_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ledger_entries_wallet_idx').on(t.walletId),
    index('ledger_entries_created_at_idx').on(t.createdAt),
    // Idempotency for replayed causes (deal ingest, payment callbacks, payouts):
    // the same (type, id) can never post twice against the same wallet.
    uniqueIndex('ledger_entries_wallet_reference_uq').on(t.walletId, t.referenceType, t.referenceId),
  ],
);

// ── transactions (CORE-13 state machine · §5 · §8.3/§8.4) ────────────────────
//
// §5 names three states (pending|success|failure) — that is the PROVIDER
// lifecycle. FR-ADM-03 additionally requires an admin to approve or reject a
// withdrawal before any provider is called, so the machine carries two more:
//
//   pending ──approve──> approved ──settle──> success
//      │                    │
//      └──reject──> rejected└──provider fails──> failure
//
// Money movement per state: request holds the funds (no ledger entry — a hold
// is not a balance change); reject/failure release the hold; success posts the
// debit through WalletService and clears the hold. Logged as DECISIONS D-38.
export const transactionDirectionEnum = pgEnum('transaction_direction', ['deposit', 'withdrawal']);
export const transactionStateEnum = pgEnum('transaction_state', [
  'pending',
  'approved',
  'success',
  'failure',
  'rejected',
]);

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    direction: transactionDirectionEnum('direction').notNull(),
    amount: numeric('amount', { precision: 28, scale: 8 }).notNull(),
    currency: currencyEnum('currency').notNull(),
    state: transactionStateEnum('state').notNull().default('pending'),
    provider: varchar('provider', { length: 50 }).notNull(),
    /** Provider's own reference. §6.3: UNIQUE(provider, provider_ref) is the
     *  idempotency guarantee for replayed payment callbacks. */
    providerRef: varchar('provider_ref', { length: 255 }),
    /** Withdrawal destination (bank/wallet address) as the client supplied it. */
    destination: varchar('destination', { length: 255 }),
    rejectionReason: text('rejection_reason'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transactions_user_idx').on(t.userId),
    index('transactions_state_idx').on(t.state),
    index('transactions_created_at_idx').on(t.createdAt),
    uniqueIndex('transactions_provider_ref_uq').on(t.provider, t.providerRef),
  ],
);

// ── ib_programs (IB-06 · ADM-10 · §5) ────────────────────────────────────────
//
// This table is the answer to the "open" commission decisions. §12.2 (L1/L2
// split), §12.3 (ladder and rates), §12.6 (settlement window) and §12.8
// (rebate timing) are not numbers to hardcode once someone emails them — the
// feature list makes them ADMIN-CONFIGURED (ADM-10 "Commission plans CRUD,
// including L1/L2 shares"; IB-16 "commission method configured in program
// catalogue"). The client sets them in the admin UI, per program, and can
// change them without a deploy.
//
// commissionMethod also settles D-11 by declaration rather than assumption:
// instead of guessing what MT5's `spread` means, each program states how its
// commission is computed and the engine implements the declared method.
export const commissionModeEnum = pgEnum('commission_mode', ['commission', 'rebate', 'hybrid']);
export const commissionMethodEnum = pgEnum('commission_method', [
  'spread_share', // commissionValue = % of the deal spread (IB-16 default)
  'per_lot',      // commissionValue = money per traded lot
  'fixed_per_deal',
]);

export const ibPrograms = pgTable(
  'ib_programs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 120 }).notNull().unique(),
    description: text('description'),
    /** Ladder position — lower is the entry tier (IB-06). */
    position: integer('position').notNull().default(1),
    mode: commissionModeEnum('mode').notNull().default('commission'),
    method: commissionMethodEnum('method').notNull().default('spread_share'),
    /** Money or percentage depending on `method` — a string either way (§6.1). */
    commissionValue: numeric('commission_value', { precision: 28, scale: 8 }).notNull().default('0'),
    /** Client rebate, used when mode is rebate|hybrid. */
    rebateValue: numeric('rebate_value', { precision: 28, scale: 8 }).notNull().default('0'),
    /** Split of the commission pool. Percentages, exact — never floats. */
    l1Share: numeric('l1_share', { precision: 5, scale: 2 }).notNull().default('0'),
    l2Share: numeric('l2_share', { precision: 5, scale: 2 }).notNull().default('0'),
    /** §12.6 — per program, so the client sets it instead of us guessing. */
    settlementWindowHours: integer('settlement_window_hours').notNull().default(24),
    /**
     * §12.8 rebate timing. FALSE (rebate waits for the same settlement window
     * as commission) is the ARCHITECTURE recommendation: crediting on close
     * pays out on trades that may need reversing, and Phase 1 has no clawback.
     * Configurable, but the admin UI warns before enabling it.
     */
    rebateOnClose: boolean('rebate_on_close').notNull().default(false),
    /** Whether an IB may select this program (§5 `selectable`). */
    selectable: boolean('selectable').notNull().default(true),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ib_programs_position_idx').on(t.position)],
);

// ── Audit log — APPEND ONLY (D-21). No UPDATE, no DELETE, ever. ──────────────
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').notNull(),
    actorEmail: varchar('actor_email', { length: 255 }).notNull(),
    action: varchar('action', { length: 100 }).notNull(),
    subjectType: varchar('subject_type', { length: 100 }).notNull(),
    subjectId: varchar('subject_id', { length: 255 }).notNull(),
    details: jsonb('details').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_created_at_idx').on(t.createdAt),
    index('audit_log_action_idx').on(t.action),
  ],
);
