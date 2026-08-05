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
    emailVerificationToken: varchar('email_verification_token', {
      length: 255,
    }),
    emailVerificationExpiry: timestamp('email_verification_expiry', {
      withTimezone: true,
    }),
    /*
     * When the password last changed - the cutoff that kills outstanding
     * ACCESS tokens.
     *
     * Revoking refresh-token families ends a session's ability to RENEW, which
     * is most of what "sign out every other device" means. It does not touch an
     * access token that has already been issued: those are stateless and valid
     * for their full fifteen minutes, so a client who changes their password
     * because they believe somebody is in their account leaves that somebody
     * with up to fifteen more minutes of access.
     *
     * For an ordinary logout that window is a fair trade for not hitting the
     * database on every request. For a password change it is not: the whole
     * reason to change a password under duress is to end access NOW.
     *
     * `jwt.strategy.ts` compares this against the token's `iat` on every
     * request. It costs nothing extra - the strategy already loads the user to
     * check for suspension.
     *
     * NULLABLE, and read as "no cutoff": every account that existed before this
     * column did has never changed its password through a path that records
     * one, and must not be logged out by the migration that added it.
     */
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    /*
     * `refresh_token` is GONE — superseded by the `refresh_tokens` table below.
     *
     * It held a single token per user, which is why rotation could only ever
     * answer "matches" or "does not match": a replayed token simply failed, so
     * an attacker used the newer one they had also captured and nothing recorded
     * that a credential had leaked. Token FAMILIES (R-3.3) replaced it, and this
     * column stayed behind — still written on password reset, read by nothing,
     * and looking to any reader like the live session store.
     */
    /*
     * Password reset — a SHA-256 HASH of the token, never the token.
     *
     * The emailed token is a bearer credential that can take over an account.
     * Storing it verbatim would mean a database dump, a leaked backup or a
     * read-only SQL injection hands an attacker a working reset link for every
     * user with one outstanding. Hashing costs nothing here — the token is
     * high-entropy random, so a fast hash is sufficient and bcrypt/argon2 would
     * only add latency to a lookup.
     */
    passwordResetTokenHash: varchar('password_reset_token_hash', { length: 64 }),
    passwordResetExpiry: timestamp('password_reset_expiry', { withTimezone: true }),
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
  /*
   * An admin can be SUSPENDED — R-3.3's revocation story, which stopped at the
   * portal.
   *
   * `users` has had this from the start and `jwt.strategy.ts` enforces it on
   * every request. Admins had nothing: `AdminAuthenticator` checked only that
   * the row existed, so the sole way to cut off a compromised or departing
   * administrator — an account that can approve AND settle payouts — was to
   * DELETE it. That destroys the subject every audit row points at, and it is
   * not reversible, so "suspend pending investigation" had no expression at all.
   *
   * Same enum as users deliberately: two spellings of "suspended" across two
   * tables is the kind of divergence that ends with one of them not being
   * checked.
   */
  status: userStatusEnum('status').notNull().default('active'),
  // `refresh_token` removed here for the same reason as on `users` — superseded
  // by the refresh_tokens family table, written by nothing, read by nothing.
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const adminInvites = pgTable('admin_invites', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  /*
   * A SHA-256 HASH of the invite token, never the token — matching how password
   * reset has always stored its own (see `users.password_reset_token_hash`).
   *
   * This column held the token verbatim, which made a database dump, a leaked
   * backup or a read-only SQL injection into a set of working links that CREATE
   * ADMIN ACCOUNTS on a system that approves payouts. Reset tokens were hashed
   * precisely because they can take over one account; an invite is strictly
   * worse and was the one credential still stored in the clear.
   *
   * 64 chars because that is a hex SHA-256, and narrowing the column is what
   * makes storing a raw uuid here fail loudly rather than silently fit.
   */
  tokenHash: varchar('token_hash', { length: 64 }).unique(),
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
    /*
     * One submission per user (FSD lifecycle), and now actually tied to one.
     *
     * This was a bare `uuid` primary key with no reference, while every money
     * table in this file uses `.references(… onDelete: 'restrict')`. So an
     * orphan submission — a row whose user does not exist — was possible, and
     * `getByUserId` handles it by returning `user: undefined`, which renders in
     * the admin queue as a submission with no name.
     *
     * `restrict` rather than `cascade`, matching the money tables: a client's
     * identity documents are the evidence behind their verification, and a
     * `DELETE FROM users` should fail loudly rather than silently take the
     * compliance record with it. Deleting a client is a deliberate act with a
     * retention policy attached (PLATFORM-CONVENTIONS 12.9), not a side effect.
     */
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: kycStatusEnum('status').notNull().default('not_started'),
    personalInfo: jsonb('personal_info').$type<Record<string, string>>(),
    document: jsonb('document').$type<Record<string, string>>(),
    selfie: jsonb('selfie').$type<Record<string, string>>(),
    addressProof: jsonb('address_proof').$type<Record<string, string>>(),
    rejectionReason: text('rejection_reason'),
    rejectedFields: jsonb('rejected_fields').$type<string[]>(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /*
     * `set null` rather than `restrict`: an admin who leaves the company should
     * be removable, and their departure must not be blocked by — or silently
     * delete — the verifications they signed off. The authoritative "who
     * approved this" is the append-only admin action log (D-21); this column is
     * the convenience copy, so losing it is acceptable where losing the audit
     * row would not be.
     */
    reviewedBy: uuid('reviewed_by').references(() => admins.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('kyc_submissions_status_idx').on(t.status),
    /*
     * The review queue orders by `submitted_at DESC` on EVERY request
     * (`kyc.store.ts` findPageWithUsers), unconditionally and for every filter
     * tab. Without this the database sorts the whole table per page view; at
     * the FSD §11 figure of ~219,000 clients that is the first query on this
     * path to fall over.
     *
     * DESC to match the query's direction, and NULLS LAST because a submission
     * that was never submitted has no date and belongs at the bottom rather
     * than at the top of the newest-first queue.
     */
    index('kyc_submissions_submitted_at_idx').on(t.submittedAt.desc().nullsLast()),
  ],
);

/**
 * Every decided KYC attempt, kept.
 *
 * ## The problem this solves
 *
 * `kyc_submissions` is keyed on `user_id`, so there is exactly one row per
 * client, forever, and every write is an in-place UPDATE. Take the ordinary
 * case — a client is rejected for an expired passport and re-submits:
 *
 *  1. `attachFile` OVERWRITES `document.frontFilePath` with the new upload. The
 *     old path is gone from the database, and the file it named becomes
 *     unreferenced: unservable, un-auditable, and impossible to clean up.
 *  2. `submit()` CLEARS `rejection_reason` and `rejected_fields`, deliberately,
 *     so stale rejection text does not follow a fresh submission into the queue
 *     (D-27.4).
 *  3. `approve()` OVERWRITES `reviewed_by` and `reviewed_at`.
 *
 * After approval the record reads: approved, by admin B, at 14:32, one passport
 * photo, no reason ever recorded. There is no way to answer "was this client
 * ever rejected, and why", "how many attempts did this take", or "what did the
 * document we refused actually look like".
 *
 * For a regulated broker, "we verified this person" is a claim that must be
 * evidenced years later. The system could evidence the current state only.
 *
 * ## Why a separate table rather than re-keying `kyc_submissions`
 *
 * Re-keying would touch every query, every read path, both frontends' generated
 * types and the FK just added — a large change to the live money-adjacent path
 * for a benefit that is entirely about the PAST. This table is append-only in
 * practice and additive in code: the live row keeps its shape, and a snapshot is
 * written at the moment a decision is made, which is the moment the evidence
 * would otherwise start being overwritten.
 *
 * `attempt_no` is per user and dense from 1, so "how many attempts" is a
 * `max(attempt_no)` rather than a count that a future deletion could skew. The
 * unique constraint is what makes two concurrent archives of the same attempt
 * impossible rather than merely unlikely.
 */
export const kycSubmissionAttempts = pgTable(
  'kyc_submission_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    attemptNo: integer('attempt_no').notNull(),
    /** The status this attempt ENDED in — `approved` or `rejected`. */
    status: kycStatusEnum('status').notNull(),
    personalInfo: jsonb('personal_info').$type<Record<string, string>>(),
    document: jsonb('document').$type<Record<string, string>>(),
    selfie: jsonb('selfie').$type<Record<string, string>>(),
    addressProof: jsonb('address_proof').$type<Record<string, string>>(),
    rejectionReason: text('rejection_reason'),
    rejectedFields: jsonb('rejected_fields').$type<string[]>(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => admins.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Read as "this client's history, oldest first" — the only query shape.
    index('kyc_attempts_user_idx').on(t.userId, t.attemptNo),
    uniqueIndex('kyc_attempts_user_attempt_uq').on(t.userId, t.attemptNo),
  ],
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

/*
 * ── RBAC-08 · admin IP allowlist ─────────────────────────────────────────────
 *
 * "List the IP to be whitelisted." The ADMIN surface only — the client portal is
 * public by nature and an allowlist there would lock out the customers it exists
 * to serve.
 *
 * AN EMPTY TABLE MEANS THE FEATURE IS OFF, and that is load-bearing rather than
 * lazy: the deploy that creates this table must not lock every administrator out
 * before anyone can add a rule (DECISIONS D-10 — "ship with an empty list and an
 * admin UI to manage it"). Enforcement begins with the first row, added by
 * someone who can still reach the screen.
 *
 * Rules are CIDR. An office is a range, not an address, and a whitelist that
 * only held single addresses gets worked around or switched off. See
 * common/security/ip-range.ts for the matcher and why it fails closed.
 */
/*
 * ── Operator-controlled security switches ────────────────────────────────────
 *
 * One row per switch, so adding the next one is an INSERT rather than a
 * migration. Deliberately NOT a general-purpose key-value bag for arbitrary
 * application config: everything here turns a SECURITY CONTROL on or off, and
 * that is a category which earns master-admin-only writes, an audit row per
 * change, and an alert for as long as a control is off.
 *
 * WHY THIS EXISTS AT ALL. The withdrawal OTP has to be switchable — it is
 * unusable in automated testing and the operator wants it off until they go
 * live. The risk in that is obvious and worth writing down: a switch that
 * disables a money control is exactly the kind that gets turned off "for an
 * afternoon" and found two quarters later. So the switch is real, and every
 * property around it exists to make leaving it off VISIBLE:
 *
 *   - `enabled` defaults to TRUE, so a fresh deploy is protected and turning it
 *     off is an act somebody performed.
 *   - `updatedBy` / `updatedAt` are not decoration; "who turned this off" is the
 *     first question afterwards.
 *   - the service raises an alert on every read that finds it off, so it shows
 *     up in monitoring rather than only in a settings screen nobody opens.
 */
/*
 * Where a client downloads the trading terminal - one row per platform.
 *
 * A TABLE rather than environment variables, because the operator changes these
 * without a deploy: a new MT5 build, a TestFlight link that rotates, an Android
 * APK moving to the Play Store. Env vars would mean a release for a URL change,
 * and the person who needs to change it does not ship releases.
 *
 * Separate from `security_settings` deliberately. That table is `key + enabled`
 * - booleans only - and widening it to carry strings would make one table mean
 * two things and force every reader to know which. It is also master-admin-only
 * for reasons that do not apply here: a download link is not a control standing
 * between a stolen session and a balance.
 *
 * The URL is NULLABLE and that is the honest default. An unconfigured platform
 * has no link, and the portal says "not available yet" rather than rendering a
 * button that goes nowhere - the same rule as `BackendPending` on a screen with
 * no endpoint.
 */
export const platformLinks = pgTable('platform_links', {
  /** 'desktop' | 'ios' | 'android'. A stable machine key, never renamed. */
  key: varchar('key', { length: 32 }).primaryKey(),
  /*
   * Sized for a real URL rather than 255. App Store and Play Store links carry
   * campaign and locale parameters and routinely pass 255 characters; a column
   * that truncates one produces a link that 404s, which is worse than no link.
   */
  url: varchar('url', { length: 2048 }),
  /** The admin who last changed it. Null for the seeded, unconfigured rows. */
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const securitySettings = pgTable('security_settings', {
  /** A stable machine key, e.g. `withdrawal_otp`. Never renamed. */
  key: varchar('key', { length: 64 }).primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  /** The admin who last changed it. Null only for the seeded initial row. */
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/*
 * Failed sign-ins, per ACCOUNT — PLATFORM-CONVENTIONS R-3.5.
 *
 * `@nestjs/throttler` keys on the IP, which bounds one attacker on one address
 * and does nothing about the attack that actually matters here: a distributed
 * credential-stuffing run against ONE admin account, from as many addresses as
 * the attacker cares to rent. The per-route limits were real protection against
 * the wrong threat.
 *
 * Two decisions worth not undoing:
 *
 *  1. **Keyed on the identifier the caller SUPPLIED, not on a user id.** Rows
 *     are written for addresses that do not exist, and they must be: counting
 *     only real accounts would make "did this lock out?" a membership oracle,
 *     which is the same leak the timing fix in password.service.ts closes.
 *  2. **The lock EXPIRES on its own.** A lockout needing an administrator to
 *     clear it is a denial-of-service an attacker can trigger for free against
 *     any address they can name — including every admin's. Fifteen minutes is
 *     R-3.5's figure and it self-heals, so there is no unlock queue to build and
 *     no support path to abuse.
 */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** 'admin' | 'portal' — the two surfaces are separate accounts (R-3.1). */
    surface: varchar('surface', { length: 16 }).notNull(),
    /** Lower-cased email as supplied. Not a foreign key, deliberately — see (1). */
    identifier: varchar('identifier', { length: 255 }).notNull(),
    failures: integer('failures').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per identifier per surface, enforced by the DATABASE: two racing
    // failed logins must not create two counters that each stay under the limit.
    uniqueIndex('login_attempts_surface_identifier_idx').on(table.surface, table.identifier),
    index('login_attempts_locked_until_idx').on(table.lockedUntil),
  ],
);

export const adminIpAllowlist = pgTable(
  'admin_ip_allowlist',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Canonical CIDR — a bare address is stored as `/32`. */
    cidr: varchar('cidr', { length: 43 }).notNull(),
    /** Why this rule exists. A list of bare ranges becomes unmaintainable fast. */
    label: varchar('label', { length: 200 }).notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Canonicalised before insert, so `10.0.0.5/24` and `10.0.0.0/24` cannot both
    // exist and leave someone believing they removed a rule still in force.
    uniqueIndex('admin_ip_allowlist_cidr_uq').on(t.cidr),
  ],
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
    balanceAfter: numeric('balance_after', {
      precision: 28,
      scale: 8,
    }).notNull(),
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
    uniqueIndex('ledger_entries_wallet_reference_uq').on(
      t.walletId,
      t.referenceType,
      t.referenceId,
    ),
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
  'per_lot', // commissionValue = money per traded lot
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
    commissionValue: numeric('commission_value', { precision: 28, scale: 8 })
      .notNull()
      .default('0'),
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

// ═══ IB / TRADING (§5 · §8.6) ════════════════════════════════════════════════
//
// The UNIQUE constraints here ARE the idempotency design (§6.3) — not hints,
// not optimisations. Deal ingest, commission accrual and referral attribution
// each rely on one, with ON CONFLICT DO NOTHING rather than check-then-insert.

export const ibStatusEnum = pgEnum('ib_status', ['pending', 'approved', 'rejected', 'suspended']);
export const accrualStatusEnum = pgEnum('accrual_status', ['accrued', 'confirmed']);
export const tradingEnvironmentEnum = pgEnum('trading_environment', ['live', 'demo']);

export const tradingAccounts = pgTable(
  'trading_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** §6.3: the MT5 login is unique — one CRM account per trading account. */
    mt5Login: varchar('mt5_login', { length: 50 }).notNull().unique(),
    mt5Group: varchar('mt5_group', { length: 100 }),
    environment: tradingEnvironmentEnum('environment').notNull().default('live'),
    tier: varchar('tier', { length: 50 }),
    leverage: integer('leverage'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('trading_accounts_user_idx').on(t.userId)],
);

export const deals = pgTable(
  'deals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** §6.3 THE deal-ingest idempotency key. Re-delivery is a no-op. */
    mt5Ticket: varchar('mt5_ticket', { length: 50 }).notNull().unique(),
    tradingAccountId: uuid('trading_account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'restrict' }),
    symbol: varchar('symbol', { length: 30 }).notNull(),
    volume: numeric('volume', { precision: 28, scale: 8 }).notNull(),
    /** Spread as delivered by the bridge; its unit is declared per program. */
    spread: numeric('spread', { precision: 28, scale: 8 }).notNull(),
    profit: numeric('profit', { precision: 28, scale: 8 }).notNull().default('0'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('deals_closed_at_idx').on(t.closedAt)],
);

export const ibProfiles = pgTable(
  'ib_profiles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),
    /**
     * The ENTIRE hierarchy. One nullable self-reference, walked at most twice.
     * §8.6: no closure table, no recursive CTE — resolution stops at L2.
     */
    parentIbId: uuid('parent_ib_id'),
    programId: uuid('program_id').references(() => ibPrograms.id, {
      onDelete: 'restrict',
    }),
    status: ibStatusEnum('status').notNull().default('pending'),
    referralCode: varchar('referral_code', { length: 50 }).unique(),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ib_profiles_parent_idx').on(t.parentIbId),
    index('ib_profiles_status_idx').on(t.status),
  ],
);

export const referralAttributions = pgTable('referral_attributions', {
  /** §6.3 UNIQUE(client_user_id): attribution is permanent — one IB per client,
   *  forever. There is deliberately no "change my IB" flow. */
  clientUserId: uuid('client_user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'restrict' }),
  ibUserId: uuid('ib_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const commissionAccruals = pgTable(
  'commission_accruals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id, { onDelete: 'restrict' }),
    ibUserId: uuid('ib_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** 1 or 2 — the constraint admits any level, the resolver stops at 2. */
    level: integer('level').notNull(),
    programId: uuid('program_id').references(() => ibPrograms.id, {
      onDelete: 'restrict',
    }),
    amount: numeric('amount', { precision: 28, scale: 8 }).notNull(),
    currency: currencyEnum('currency').notNull().default('USD'),
    status: accrualStatusEnum('status').notNull().default('accrued'),
    /** closed_at + the program's settlement window (§8.6 confirm job). */
    availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** §6.3 THE accrual idempotency guarantee. Re-running accrual is a no-op. */
    uniqueIndex('commission_accruals_deal_ib_level_uq').on(t.dealId, t.ibUserId, t.level),
    index('commission_accruals_status_available_idx').on(t.status, t.availableAt),
    // Every IB earnings query (IB-11/IB-12) reads by ib_user_id. None exists
    // yet, which is exactly when adding the index costs nothing.
    index('commission_accruals_ib_user_idx').on(t.ibUserId),
  ],
);

// ── Audit log — APPEND ONLY (D-21). No UPDATE, no DELETE, ever. ──────────────
/** Who — or what — performed an audited action. See `audit_log.actor_kind`. */
export const auditActorKindEnum = pgEnum('audit_actor_kind', [
  'admin',
  'client',
  'system',
  'provider',
]);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorId: uuid('actor_id').notNull(),
    actorEmail: varchar('actor_email', { length: 255 }).notNull(),
    /**
     * WHAT KIND of principal acted.
     *
     * The table assumed an admin: `actorEmail` is resolved from `AdminsStore`
     * and falls back to the string `'unknown'`. That fallback is the problem —
     * it is indistinguishable from a deleted admin, and it is what a client or
     * a system actor already produces.
     *
     * The codebase had already worked around the gap twice. `UploadsController`
     * invented `kind: 'admin' | 'client'` and encoded it in the ACTION NAME
     * (`kyc.document.view` vs `kyc.document.view.own`) for want of a column, so
     * "every read of this document" is currently two queries rather than one.
     * A workaround appearing twice is the signal that the column is missing.
     *
     * `system` and `provider` are here for the actors that already exist or
     * shortly will: the reconciliation scheduler acts with no human behind it,
     * and ARCHITECTURE's later-phase KYC provider decides verifications by
     * webhook. Recording those as an admin with an `'unknown'` email would be a
     * false statement in the one record that must not contain any.
     *
     * Defaulted to `admin` because every existing row is one, so the backfill is
     * the default rather than a migration script.
     */
    actorKind: auditActorKindEnum('actor_kind').notNull().default('admin'),
    action: varchar('action', { length: 100 }).notNull(),
    subjectType: varchar('subject_type', { length: 100 }).notNull(),
    subjectId: varchar('subject_id', { length: 255 }).notNull(),
    details: jsonb('details').$type<Record<string, unknown>>(),
    /**
     * Where the action came from.
     *
     * On a money system "who approved this withdrawal" is only half an answer.
     * Nullable because it is genuinely unknown for anything not driven by a
     * request — a scheduled confirm job, a migration, a console — and recording
     * a placeholder there would be worse than a null, because it reads as an
     * answer. 45 chars holds a full IPv6 address.
     */
    ipAddress: varchar('ip_address', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_created_at_idx').on(t.createdAt),
    index('audit_log_action_idx').on(t.action),
    // findAll() filters on all three. subject_type became the important one when
    // KYC document reads started being audited (R-6.6) — those are now the
    // highest-volume row type here.
    index('audit_log_subject_type_idx').on(t.subjectType),
    index('audit_log_actor_idx').on(t.actorId),
  ],
);

/*
 * ── Idempotency keys (PLATFORM-CONVENTIONS R-5.2) ────────────────────────────
 *
 * ARCHITECTURE §6.3 puts idempotency in database constraints, and the existing
 * ones cover replayed CAUSES: UNIQUE(mt5_ticket) for a redelivered deal,
 * UNIQUE(provider, provider_ref) for a repeated payment callback,
 * UNIQUE(deal_id, ib_user_id, level) for a re-run accrual.
 *
 * Nothing covered a replayed REQUEST. A double-clicked withdrawal button sends
 * two requests that are genuinely distinct causes: both pass validation, both
 * create a transaction row, and both place a hold — so the client's available
 * balance drops twice for one intended withdrawal, and an admin sees two
 * requests to approve. No constraint could have caught it, because nothing
 * about the second request is a duplicate as far as the database is concerned.
 *
 * The caller supplies the identity instead: a client-generated `Idempotency-Key`
 * header. The UNIQUE index below is what makes the replay a no-op — the same
 * check-then-insert warning from §6.3 applies here, so the INSERT itself is the
 * lock, never a preceding SELECT.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** The caller's key. Scoped per actor and endpoint, never global. */
    key: varchar('key', { length: 255 }).notNull(),
    /** `POST /payments/withdrawals` — so one key may be reused across endpoints. */
    endpoint: varchar('endpoint', { length: 255 }).notNull(),
    /** Whose key it is. Two users may pick the same key without colliding. */
    actorId: uuid('actor_id').notNull(),
    /**
     * SHA-256 of the request body.
     *
     * Reusing a key with a DIFFERENT body is a client bug, and returning the
     * first response for it would be silently wrong — the caller would believe
     * the second, different request had succeeded. That case is a 422, which is
     * only detectable because the fingerprint is stored.
     */
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    /**
     * The stored response, replayed verbatim on a retry.
     *
     * NULL while the first request is still in flight: a concurrent duplicate
     * gets 409 rather than a half-written answer.
     */
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** THE guarantee. Everything else in this table is bookkeeping. */
    uniqueIndex('idempotency_keys_scope_uq').on(t.key, t.endpoint, t.actorId),
    /** Supports the retention sweep — these rows are not kept forever. */
    index('idempotency_keys_created_at_idx').on(t.createdAt),
  ],
);

/*
 * ── Refresh token families (PLATFORM-CONVENTIONS R-3.3) ──────────────────────
 *
 * Rotation was already right: each refresh mints a new token and invalidates the
 * one presented. What was missing is what happens when the OLD one shows up
 * again.
 *
 * A rotated token is presented for exactly one reason — somebody kept a copy.
 * Either the legitimate client raced itself, or the token was stolen and the
 * thief is using it. Both look identical, and the previous behaviour treated
 * both the same way: the stored hash no longer matched, so the request simply
 * failed. The attacker just tried again with the newer token they had also
 * captured, and nothing anywhere recorded that a credential had leaked.
 *
 * A family fixes that. Every refresh descends from one login, and replaying any
 * already-used member revokes the WHOLE family — every descendant, including the
 * one currently in the attacker's hands. The victim is logged out once and logs
 * back in; the attacker is locked out permanently and the event is recorded.
 *
 * This replaces the single bcrypt hash that lived on `users.refresh_token` /
 * `admins.refresh_token`: one column cannot express "used", "revoked", or
 * "descended from".
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    /** The `jti` carried inside the JWT — how a presented token finds its row. */
    id: uuid('id').primaryKey(),
    /** Every token minted from one login shares this. Revocation is per family. */
    familyId: uuid('family_id').notNull(),
    /** 'admin' | 'portal'. The two surfaces are separate (R-3.1) and so are their tokens. */
    surface: varchar('surface', { length: 16 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    /**
     * SHA-256, not bcrypt.
     *
     * bcrypt's cost exists to slow down guessing a LOW-entropy secret. A signed
     * JWT is not guessable, so the work bought nothing and was paid on every
     * refresh. The hash is here so a database leak does not hand over live
     * sessions, and SHA-256 does that.
     */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** Set at rotation. A token presented with this set is a REPLAY. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** Set by logout, by suspension, or by the reuse response killing the family. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /*
     * Who and where, so a client can recognise their own sessions.
     *
     * GET /auth/sessions exists to answer one question: "is one of these not
     * me". Without these columns the honest answer it could give was "there
     * are three sessions and they expire in 29 days", which nobody can act on.
     * A browser, an address and a last-active time are what make an unfamiliar
     * row recognisable as unfamiliar.
     *
     * Both are NULLABLE and both are copied forward on rotation. Nullable
     * because rows written before this migration have neither, and because a
     * request can genuinely arrive with no User-Agent -- the API must never
     * refuse to refresh a session over a missing display string.
     */
    userAgent: varchar('user_agent', { length: 400 }),
    /*
     * Sized for IPv6 plus a scope, and stored whole.
     *
     * Truncating it -- the usual privacy instinct -- would defeat the feature:
     * "someone in your country" is not a signal anyone can act on, and this is
     * the client's own data shown back to the client, not third-party tracking.
     */
    ip: varchar('ip', { length: 64 }),
  },
  (t) => [
    index('refresh_tokens_family_idx').on(t.familyId),
    index('refresh_tokens_subject_idx').on(t.surface, t.subjectId),
    /** Supports the sweep of expired rows. */
    index('refresh_tokens_expires_at_idx').on(t.expiresAt),
  ],
);
