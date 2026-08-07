import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  uniqueIndex,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
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
/*
 * 'withdrawal' outlived the withdrawal flow the teardown removed, deliberately:
 * the label is still present in the database and rows referencing it may exist,
 * and dropping a value from a PG enum means rewriting the type. It comes back
 * with the money rebuild.
 */
export const rejectionContextEnum = pgEnum('rejection_context', ['kyc', 'withdrawal', 'partner']);

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
     * The client's profile photo - the STORED FILENAME, not a URL.
     *
     * `<uuid>.<ext>` under ./uploads/avatars, written by StoredFilesService.
     * A filename rather than a URL because the URL is a function of how the
     * API is deployed: the §8.5 move to private S3 changes how the bytes are
     * served and must not require rewriting a column. `GET /uploads/avatars/
     * :file` composes the URL at read time.
     *
     * Never the client-supplied filename. The extension comes from the file's
     * own magic bytes, which is what stops an HTML document declared
     * `image/png` from being stored as something a browser will execute.
     */
    avatarFilename: varchar('avatar_filename', { length: 128 }),
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
    /**
     * The partner who introduced this client, captured at registration.
     *
     * ## A column, not the `referral_attributions` table it replaces
     *
     * Attribution is ONE partner per client and permanent — §6.3 lists
     * `UNIQUE(client_user_id)` for exactly this — so a separate table is a join
     * to reach a single fact about the client. The uniqueness that table
     * enforced with an index is enforced here by there being one column.
     *
     * ## Permanent, and that is the point
     *
     * Written once at registration and never rewritten. A partner is paid on
     * the activity of the clients attributed to them, so a mutable column is a
     * route for one partner's earnings to move to another; nothing in the
     * partner-management surface offers to change it.
     *
     * NULL means the client arrived directly. That is the common case and not a
     * gap: a mistyped or retired referral code must never cost a signup, so
     * `AuthService` logs an unresolvable code and leaves this null.
     *
     * The foreign key lands in migration 0032, not here — `ib_accounts` is
     * declared far below this table and `.references()` would be a forward
     * reference at module scope.
     */
    referredByIbUserId: uuid('referred_by_ib_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('users_type_idx').on(t.type),
    index('users_status_idx').on(t.status),
    index('users_verification_level_idx').on(t.verificationLevel),
    index('users_created_at_idx').on(t.createdAt),
    index('users_country_idx').on(t.country),
    /* "Which clients did this partner introduce?" — asked per partner by every
       commission calculation the engine will eventually run. */
    index('users_referred_by_idx').on(t.referredByIbUserId),
  ],
);

// ── RBAC ─────────────────────────────────────────────────────────────────────
export const roles = pgTable('roles', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  description: text('description'),
  permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
  /*
   * RBAC-03 — the client fields holders of this role may NOT see.
   *
   * On the ROLE because masking is a property of the job, not the person:
   * "support agents do not see phone numbers" is the same kind of statement as
   * "support agents cannot approve withdrawals", and it belongs beside it. It
   * also resolves LIVE, exactly as `permissions` does, so adding a key here
   * blinds every holder on their next request with no re-login — which is the
   * behaviour you want the moment a field turns out to be more sensitive than
   * anyone realised.
   *
   * A DENY-list, and that choice is forced by migration safety: `[]` is
   * precisely today's behaviour, so this column cannot blind anybody on deploy.
   * An allow-list would default to "see nothing" and blank every admin screen
   * the moment the migration ran, and un-blanking them would need a data
   * migration inventing values for rows that never expressed an opinion.
   *
   * The cost, stated rather than discovered: a NEW client field is visible to
   * everyone until somebody adds it to `config/client-fields.json`. That is
   * what the catalog-coverage test exists to catch.
   *
   * Keys are path-qualified (`client.email`, `kyc.personalInfo.phone`) because
   * a flat `country` is ambiguous between `users.country` and the country
   * inside a KYC submission's JSON — and a masking system that hides one while
   * leaking the other is not a masking system.
   */
  maskedFields: jsonb('masked_fields').$type<string[]>().notNull().default([]),
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
  /*
   * A per-person OVERRIDE of the role's mask. NULL means "inherit the role".
   *
   * Deliberately NOT the `role_id` XOR `permissions` shape used directly above,
   * and the difference is the point. That exclusivity is right for permissions,
   * but applying it to masking would mean un-masking a single field for a
   * single person requires detaching them from their role entirely — after
   * which they silently stop receiving role permission updates, which is a
   * security regression performed in the name of a UI convenience.
   *
   * With null-inherit, "Sarah is a support agent but handles escalations, so
   * she may see phone numbers" is one field on one row and nothing else moves.
   *
   * NULL and `[]` are different on purpose: null is "no opinion, follow the
   * role", `[]` is "explicitly mask nothing for this person". A column that
   * defaulted to `[]` could not express the first, which is the common case.
   */
  maskedFields: jsonb('masked_fields').$type<string[]>(),
  /*
   * Password recovery, INITIATED BY ANOTHER MASTER ADMIN — never self-service.
   * See DECISIONS D-44.
   *
   * There was no recovery at all: an admin who forgot their password was locked
   * out until somebody edited this table by hand, which is untraceable and needs
   * production database access.
   *
   * Self-service by email was rejected deliberately. It would make an admin's
   * mailbox the root of trust for an account that approves payouts, so a
   * compromised inbox becomes a compromised payout queue. Requiring a second
   * human who already holds the highest privilege keeps email out of the trust
   * path entirely.
   *
   * The token is stored as a SHA-256 HASH and never verbatim — the same
   * treatment `users.password_reset_token_hash` and `admin_invites.token_hash`
   * already get, so a database dump yields no working links. 64 chars is a hex
   * digest exactly.
   */
  passwordResetTokenHash: varchar('password_reset_token_hash', { length: 64 }),
  passwordResetExpiry: timestamp('password_reset_expiry', { withTimezone: true }),
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
  /** Carried to `admins.masked_fields` on acceptance. NULL = inherit the role. */
  maskedFields: jsonb('masked_fields').$type<string[]>(),
  /*
   * The client-tag territory this administrator will hold, chosen at INVITE
   * time and copied to `admin_client_tag_scopes` when they accept.
   *
   * It has to be settable here, and that is a security requirement rather than
   * a convenience. An EMPTY scope means unrestricted (see
   * `adminClientTagScopes`), so if territory could only be assigned after
   * acceptance, every newly-accepted sub-admin would see EVERY CLIENT IN THE
   * SYSTEM for the window between them clicking the emailed link and a master
   * admin remembering to configure them. Nobody would ever observe that window
   * — it opens and closes silently, in a mailbox we do not watch.
   *
   * NULL means the inviter made no restriction, which the invite screen states
   * in words rather than leaving to inference.
   */
  scopedTagIds: jsonb('scoped_tag_ids').$type<string[]>(),
  invitedBy: uuid('invited_by').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  accepted: boolean('accepted').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Client tagging & segmentation (ADM-14, DECISIONS D-15) ───────────────────

/**
 * Arbitrary client labels. The "country tag" half of ADM-14 is `users.country`,
 * which already exists and is indexed; this is the "general tags/labels" half.
 *
 * A tag stopped being merely descriptive the moment `admin_client_tag_scopes`
 * arrived: a tag now decides WHICH ADMINS CAN SEE A CLIENT. Treat every write
 * here as privilege-adjacent — which is why `tags.assign` is a permission of
 * its own, separate from `tags.manage`.
 */
export const clientTags = pgTable(
  'client_tags',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /*
     * The stable machine name. The API filters by SLUG, not by id, so a saved
     * segment link (`/clients?tag=high-risk`) survives someone renaming the
     * label — and a URL an operator pasted into a ticket last month still means
     * what it meant.
     */
    slug: varchar('slug', { length: 64 }).notNull(),
    label: varchar('label', { length: 100 }).notNull(),
    /** Chip colour token for the admin UI. Presentation, hence nullable. */
    color: varchar('color', { length: 32 }),
    description: text('description'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('client_tags_slug_uq').on(t.slug)],
);

export const clientTagAssignments = pgTable(
  'client_tag_assignments',
  {
    // `restrict`, matching every other FK to `users` here: a client with
    // history is never deleted out from under the rows that reference them.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // `cascade`, unlike the scope table below. A tag is a label; deleting it
    // should take its assignments with it. Deleting a tag that is somebody's
    // TERRITORY is a different question, and `admin_client_tag_scopes` answers
    // it with `restrict`.
    tagId: uuid('tag_id')
      .notNull()
      .references(() => clientTags.id, { onDelete: 'cascade' }),
    assignedBy: uuid('assigned_by'),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * THE idempotency constraint (ARCHITECTURE §6.3): assigning a tag twice is
     * `ON CONFLICT DO NOTHING`, never check-then-insert, never a 409. Two
     * admins tagging the same client at the same instant is an ordinary event.
     *
     * It also serves the scope predicate and the client profile, both of which
     * ask "which tags does THIS client carry".
     */
    primaryKey({ columns: [t.userId, t.tagId] }),
    // The other direction — "which clients carry this tag" — which is the
    // segment query behind `?tag=` and behind every scoped admin's client list.
    index('client_tag_assignments_tag_idx').on(t.tagId, t.userId),
  ],
);

/**
 * Row-level client visibility: the tags whose clients this administrator may
 * see. Feature B of the RBAC-03 work.
 *
 * PER-ADMIN, not per-role, and deliberately asymmetric with `masked_fields`
 * above. A role is a job description ("KYC reviewer"); a scope is a territory
 * ("the Levant desk"). Two people routinely share the first and differ on the
 * second, so folding territory into the role would force one role per desk and
 * multiply the catalog for no gain. `resolvePermissions`' role-wins semantics
 * are also simply wrong here — neither union nor intersection is the obvious
 * answer for two overlapping territories.
 *
 * AN EMPTY SCOPE MEANS UNRESTRICTED. Same reasoning as RBAC-08's empty
 * allowlist (DECISIONS D-10): the deploy that creates this table must not
 * blind every existing sub-admin before anyone has had a chance to configure a
 * territory. Master admins are unrestricted regardless of what is stored.
 */
export const adminClientTagScopes = pgTable(
  'admin_client_tag_scopes',
  {
    adminId: uuid('admin_id')
      .notNull()
      .references(() => admins.id, { onDelete: 'cascade' }),
    /*
     * RESTRICT, and this one is load-bearing rather than stylistic.
     *
     * With CASCADE, deleting a tag would delete the last scope row of every
     * admin restricted to it — and because an empty scope means UNRESTRICTED,
     * those admins would be promoted to seeing every client in the system. That
     * is privilege escalation performed by a DELETE on a label, with no audit
     * trail that looks anything like a permission change.
     *
     * RESTRICT makes "you cannot delete a tag that is somebody's territory" a
     * rule the database enforces rather than one a service has to remember.
     */
    tagId: uuid('tag_id')
      .notNull()
      .references(() => clientTags.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.adminId, t.tagId] })],
);

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
 * ── The two singleton settings rows ──────────────────────────────────────────
 *
 * `general_settings` and `smtp_settings` are each ONE ROW, forever, enforced by
 * `id boolean PRIMARY KEY DEFAULT true CHECK (id)` — the only value that
 * satisfies both the check and the uniqueness of a primary key is `true`, so a
 * second row is a constraint violation rather than a convention somebody has to
 * remember. `.$default(() => true)` keeps the column out of every insert in
 * application code, which is what makes the upsert below a one-liner.
 *
 * TYPED COLUMNS, not the key-value bag `security_settings` deliberately is not.
 * That table's own comment refuses to widen `key + enabled` into a general
 * config store because "one table meaning two things forces every reader to know
 * which". The same reasoning says an SMTP port is an integer, a from-address is
 * a string, and neither belongs in a `text` column beside a boolean.
 *
 * TWO tables rather than one, for the reason the whole feature exists: the SMTP
 * row holds a CREDENTIAL and the general row does not. Separating them means the
 * encrypted column, its master-admin write guard, and its never-returned
 * response shape are properties of a table rather than of particular columns
 * within a table — so a future setting added to `general_settings` cannot
 * accidentally inherit or erode them.
 */
export const generalSettings = pgTable(
  'general_settings',
  {
    id: boolean('id')
      .primaryKey()
      .$default(() => true),
    /** Shown in the portal header and used as the sender name fallback. */
    brandName: varchar('brand_name', { length: 120 }).notNull().default('OxShare'),
    /** Where a client is told to write. Not a sender — a destination. */
    supportEmail: varchar('support_email', { length: 320 }),
    /*
     * Sized to match `platform_links.url` and for the same reason: these are real
     * URLs that carry parameters, and a column that truncates one produces a link
     * that 404s.
     */
    supportUrl: varchar('support_url', { length: 2048 }),
    /** Free text shown to clients during planned downtime. Null = nothing shown. */
    maintenanceNotice: text('maintenance_notice'),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('general_settings_singleton', sql`${t.id}`)],
);

export const smtpSettings = pgTable(
  'smtp_settings',
  {
    id: boolean('id')
      .primaryKey()
      .$default(() => true),
    host: varchar('host', { length: 255 }).notNull(),
    port: integer('port').notNull().default(587),
    /*
     * NULLABLE, and null is a real configuration rather than an unfinished one:
     * an SMTP relay reached over a private network commonly takes no credentials
     * at all, and `email.service.ts` already passes `auth: undefined` when the
     * user is empty. A NOT NULL here would force a placeholder that reads as a
     * configured account.
     */
    username: varchar('username', { length: 255 }),
    /*
     * AES-256-GCM ciphertext from `common/security/secret-box.ts`, never the
     * password. Stored as `text` because the encoding is `v1.<iv>.<tag>.<ct>` and
     * pinning a length here would be a guess about a format that is versioned
     * precisely so it can change.
     *
     * This column is the reason the table is master-admin-write and why no
     * response DTO in the codebase may include it: whoever controls the SMTP
     * server receives every password-reset and admin-invite link this system
     * sends, which is a full path to an administrator account on a system that
     * approves withdrawals.
     */
    passwordCiphertext: text('password_ciphertext'),
    /** The `From:` header, e.g. `"OxShare" <no-reply@oxshare.com>`. */
    fromAddress: varchar('from_address', { length: 320 }).notNull(),
    /*
     * Implicit TLS on connect (SMTPS, normally port 465) as opposed to STARTTLS
     * upgrading a plaintext connection (normally 587).
     *
     * Stored rather than derived from `port === 465`, which is what the code did
     * before and is wrong on every relay that listens for SMTPS on another port.
     * A guess that is right most of the time produces a connection failure the
     * operator cannot fix from the screen that configures it.
     */
    secure: boolean('secure').notNull().default(false),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('smtp_settings_singleton', sql`${t.id}`)],
);

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

/*
 * `admin_ip_allowlist` was HERE, and is dropped in migration 0034.
 *
 * RBAC-08: a table of CIDR rules that `IpAllowlistGuard` enforced across the
 * whole admin surface, plus an independent check on `/uploads/kyc/:file`
 * because that route sits outside `/admin`. Removed on request, whole.
 *
 * Admin routes are gated on authentication and permissions only now. A network
 * restriction, if wanted again, belongs at the edge — a load balancer or WAF
 * rule — rather than as an application guard reading a table.
 */

// ═══ MONEY (ARCHITECTURE §6 — non-negotiable) ════════════════════════════════
//
// 1. NUMERIC(28,8) everywhere; node-postgres hands these to JS as STRINGS and
//    they must stay strings across every boundary. decimal.js does the math.
// 2. Every ledger write locks the wallet row (SELECT ... FOR UPDATE) inside one
//    transaction — see WalletService.post().
// 3. Idempotency lives in these constraints, never in check-then-insert.
// 4. ledger_entries is APPEND ONLY — enforced by a database trigger in the
//    migration, not by convention. Corrections are compensating rows.

/**
 * The currencies this platform supports — operator data, not a code constant.
 *
 * This was `pgEnum('currency', ['USD','USDT'])`, which meant the set of money
 * the platform could hold was a DEPLOY. An operator adding EUR needed a
 * migration, a release and someone who writes SQL; in practice that means the
 * set never changes and the product cannot follow the business. It is a table
 * now, and `wallets`, `transactions` and `commission_accruals` reference it.
 *
 * ## `code` is the primary key, deliberately
 *
 * Not a surrogate uuid. The code IS the identity — 'USD' means one thing
 * everywhere, it is what MT5, the payment providers and every human use, and a
 * uuid would mean every money row needs a join before a person debugging a
 * balance can read it. The FK column is `varchar(10)`, which is what the enum
 * columns already stored on disk, so the migration converts them in place
 * rather than rewriting the money tables.
 *
 * ## Why rows are disabled rather than deleted
 *
 * A currency with wallets behind it can never be removed — the balances are
 * real and the ledger is append-only. `enabled` stops NEW wallets and new
 * deposits while leaving every existing row readable, which is the only safe
 * meaning "remove this currency" can have on a money system. The FKs are
 * ON DELETE RESTRICT so the database refuses the unsafe reading even if an
 * endpoint one day forgets to.
 *
 * `decimals` is DISPLAY only. Storage stays NUMERIC(28,8) for every currency
 * (§6.1) — rounding to 2 for USD in the database would destroy the eighth
 * decimal of a USDT balance the moment somebody reused the column.
 */
export const currencies = pgTable(
  'currencies',
  {
    /** ISO-4217 where one exists ('USD'), the ticker where none does ('USDT'). */
    code: varchar('code', { length: 10 }).primaryKey(),
    name: varchar('name', { length: 80 }).notNull(),
    /** '$', 'USDT'. Display only; `code` is what anything logical compares. */
    symbol: varchar('symbol', { length: 8 }).notNull(),
    /** Decimal places to SHOW. Storage is always NUMERIC(28,8) — see above. */
    decimals: integer('decimals').notNull().default(2),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * The one currency a brand-new client's first wallet is opened in.
     *
     * At most one row may be true, enforced by `currencies_one_default_uq`
     * below — a partial unique index over a constant, which is how Postgres
     * expresses "at most one row satisfying this predicate". Registration reads
     * it, so a platform with none opens no wallet; the migration seeds USD.
     */
    isDefault: boolean('is_default').notNull().default(false),
    /** Presentation order, so the operator controls it rather than the alphabet. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('currencies_enabled_sort_idx').on(t.enabled, t.sortOrder),
    uniqueIndex('currencies_one_default_uq')
      .on(sql`(1)`)
      .where(sql`${t.isDefault}`),
  ],
);

/*
 * ── The money surface, rebuilt (migration 0033) ──────────────────────────────
 *
 * `wallets`, `ledger_entries`, `transactions`, `transfers` and
 * `trading_accounts` were dropped in 0028 and are back here. The commission
 * tables (`deals`, `ib_programs`, `ib_profiles`, `commission_accruals`) are NOT
 * — the engine never processed a real deal and returns with the MT5 bridge.
 * `referral_attributions` is not coming back at all: it became
 * `users.referred_by_ib_user_id` in 0032, for the reason recorded there.
 *
 * THE GUARANTEE THAT LEFT IN 0028 IS RESTORED HERE. `ledger_entries` carries
 * `ledger_entries_wallet_reference_uq` again — the unique constraint
 * `WalletService.post()` uses with ON CONFLICT to make a replayed deposit a
 * no-op rather than a second credit. The teardown note said the rebuild must
 * reintroduce it before a payment provider is connected; this is that.
 */

/**
 * What caused a ledger entry.
 *
 * `transfer` is its own type rather than reusing deposit/withdrawal: those mean
 * money crossing the platform BOUNDARY through a provider, and counting an
 * internal wallet↔account move as either would overstate both total deposits
 * and total withdrawals in every report that sums by type.
 */
export const ledgerEntryTypeEnum = pgEnum('ledger_entry_type', [
  'deposit',
  'withdrawal',
  'commission',
  'rebate',
  'payout',
  'adjustment',
  'transfer',
]);

/*
 * ── transactions (CORE-13 state machine · §5 · §8.3/§8.4) ────────────────────
 *
 * §5 names three states (pending|success|failure) — that is the PROVIDER
 * lifecycle. FR-ADM-03 additionally requires an admin to approve or reject a
 * withdrawal before any provider is called, so the machine carries two more:
 *
 *   pending ──approve──> approved ──settle──> success
 *      │                    │
 *      └──reject──> rejected└──provider fails──> failure
 *
 * ## Money movement per state — CHANGED from the deleted version
 *
 * The old machine HELD funds on request (`on_hold`, no ledger entry) and posted
 * the debit at settlement. This one DEBITS ON REQUEST and refunds with a
 * compensating credit if the withdrawal is refused:
 *
 *   request  →  post(−amount)                       state=pending
 *   approve  →  nothing                             state=approved
 *   settle   →  nothing                             state=success
 *   reject   →  post(+amount) as an `adjustment`    state=rejected
 *   fail     →  post(+amount) as an `adjustment`    state=failure
 *
 * The balance therefore always reflects committed funds: a client cannot
 * request two withdrawals totalling more than they hold and discover the second
 * fails at approval time, after being told it was submitted. The refund is a
 * COMPENSATING ENTRY (§6.4) — never an UPDATE or DELETE on a ledger row — and
 * its reference id is suffixed so it cannot collide with the original debit
 * under the wallet/reference unique index.
 *
 * `on_hold` survives on `wallets` because TRANSFERS still use it: the
 * wallet→account leg holds while the (future) bridge confirms.
 */
export const transactionDirectionEnum = pgEnum('transaction_direction', ['deposit', 'withdrawal']);
export const transactionStateEnum = pgEnum('transaction_state', [
  'pending',
  'approved',
  'success',
  'failure',
  'rejected',
]);

/*
 * ── transfers · wallet <-> trading account ───────────────────────────────────
 *
 * The deleted version of this table was shaped by refusing to paper over the
 * fact that MT5 owns trading-account balances and the CRM does not. There is
 * still no bridge, so for now the CRM owns BOTH sides — see the note on
 * `trading_accounts.balance`, which records that this reverses a deliberate
 * decision and must be reversed back when the bridge lands.
 *
 * The two-leg asymmetry is kept even so, because it is what makes the table
 * correct the day the bridge arrives:
 *
 *   wallet_to_account  the wallet leg is real and immediate — funds are HELD on
 *                      request and debited on settlement.
 *   account_to_wallet  nothing is credited on request. Money the CRM has not
 *                      received is money the CRM must not show.
 *
 * ## Why not reuse `transactions`
 *
 * A transaction moves money between the client and the OUTSIDE world through a
 * provider, and carries provider, provider_ref, destination and an admin
 * approval step to prove it. A transfer is internal, has no provider, needs no
 * approval, and its counterparty is a trading account. Overloading one table
 * would mean a `provider` column null for half the rows, an approval state
 * machine half the rows skip, and `transactions_provider_ref_uq` — the §6.3
 * idempotency guarantee — becoming nullable-tolerant on a money table.
 */
export const transferDirectionEnum = pgEnum('transfer_direction', [
  'wallet_to_account',
  'account_to_wallet',
]);

/**
 * pending → settled, or pending → failed. No approval state.
 *
 * `failed` releases the hold on a wallet_to_account transfer and credits
 * nothing on an account_to_wallet one — in both cases returning to exactly the
 * position before the request, which is what makes a failed transfer safe to
 * retry.
 */
export const transferStateEnum = pgEnum('transfer_state', ['pending', 'settled', 'failed']);

export const tradingEnvironmentEnum = pgEnum('trading_environment', ['live', 'demo']);

/** A trading account an operator has suspended stops accepting transfers. */
export const tradingAccountStatusEnum = pgEnum('trading_account_status', [
  'active',
  'suspended',
  'closed',
]);

/**
 * How a payment method behaves, which decides the deposit flow.
 *
 * The type rather than the key: a screen that branches on `key === 'whish'` has
 * to be edited every time an operator adds a method, which is the thing making
 * these rows data instead of code was meant to avoid.
 *
 *   manual   show instructions and a pay-to, take a client-supplied reference,
 *            and wait for an admin to confirm the money arrived.
 *   gateway  redirect to a provider and settle on its callback.
 *   crypto   show an address and confirm on-chain.
 *
 * Only `manual` is implemented. Whish is a manual method today because its
 * sandbox credentials are open decision #5 in ARCHITECTURE.md and nobody has
 * them; the `PaymentProvider` seam exists so `gateway` slots in behind the same
 * deposit screen without redesigning it.
 */
export const paymentMethodKindEnum = pgEnum('payment_method_kind', ['manual', 'gateway', 'crypto']);

/**
 * A way a client can put money in.
 *
 * Rows, not a hardcoded list. The deleted deposit page carried a two-element
 * `METHODS` array in the component, so adding one was a deploy and the operator
 * could not turn one off when a provider went down.
 *
 * `instructions` and `pay_to` are NULLABLE and seeded null on purpose. The
 * deleted deposit page recorded why: "Inventing an IBAN is the same failure as
 * the fake $0.00 balances, with a worse outcome: the money leaves and does not
 * arrive." An operator fills in the real account details; until they do, the
 * method is not offered.
 */
export const paymentMethods = pgTable(
  'payment_methods',
  {
    /** A stable machine key — 'whish', 'usdt_trc20'. Never renamed. */
    key: varchar('key', { length: 40 }).primaryKey(),
    name: varchar('name', { length: 80 }).notNull(),
    kind: paymentMethodKindEnum('kind').notNull(),
    currency: varchar('currency', { length: 10 })
      .notNull()
      .references(() => currencies.code, { onDelete: 'restrict' }),
    /** Sized for a real URL, like `platform_links.url` and for the same reason. */
    logoUrl: varchar('logo_url', { length: 2048 }),
    /** What the client must do, in the operator's words. Shown verbatim. */
    instructions: text('instructions'),
    /** The Whish number, IBAN or wallet address the client sends to. */
    payTo: varchar('pay_to', { length: 255 }),
    /**
     * Per-method bounds, both nullable.
     *
     * NULL means "no bound beyond the platform's own", not zero — a method with
     * a 0 minimum and a 0 maximum would accept nothing at all, and that is the
     * value a NOT NULL DEFAULT '0' would have handed every existing row.
     */
    minAmount: numeric('min_amount', { precision: 28, scale: 8 }),
    maxAmount: numeric('max_amount', { precision: 28, scale: 8 }),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('payment_methods_enabled_sort_idx').on(t.enabled, t.sortOrder)],
);

/**
 * Money the platform holds for a client.
 *
 * One per client per currency, opened for every ENABLED currency at
 * registration. `available = balance − on_hold` is what a client may actually
 * move; `wallets_hold_within_balance` makes a hold exceeding the balance a
 * constraint violation rather than a state the arithmetic has to survive.
 */
export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /*
     * RESTRICT, not CASCADE: deleting a currency that holds balances would take
     * the balances with it. The operator disables instead — see `currencies`.
     */
    currency: varchar('currency', { length: 10 })
      .notNull()
      .references(() => currencies.code, { onDelete: 'restrict' }),
    /** §6.1: NUMERIC(28,8), never a float, and a string at every boundary. */
    balance: numeric('balance', { precision: 28, scale: 8 }).notNull().default('0'),
    /**
     * Reserved against a pending transfer. NOT a balance change, so it writes
     * no ledger entry — the debit posts when the movement settles.
     */
    onHold: numeric('on_hold', { precision: 28, scale: 8 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * One wallet per user per currency, in the DATABASE.
     *
     * "Open a wallet if they have none" is a read-then-insert, and two
     * concurrent registrations — or one retried request — otherwise leave a
     * client with two USD wallets and a balance split across them, which reads
     * on screen as money going missing. The insert expects this conflict and
     * treats it as success.
     */
    uniqueIndex('wallets_user_currency_uq').on(t.userId, t.currency),
    index('wallets_user_idx').on(t.userId),
    check('wallets_balance_non_negative', sql`${t.balance} >= 0`),
    check('wallets_on_hold_non_negative', sql`${t.onHold} >= 0`),
    /*
     * A hold may not exceed the balance it is held against.
     *
     * The deleted `releaseWithin` clamped `on_hold` at zero in application code
     * with a comment saying never let it go negative. This says the same thing
     * to the database, and adds the other half: `available = balance − on_hold`
     * is the number every money decision reads, and a hold larger than the
     * balance makes it negative — a state from which every subsequent
     * calculation is wrong in a way no single query looks wrong.
     */
    check('wallets_hold_within_balance', sql`${t.onHold} <= ${t.balance}`),
  ],
);

/**
 * Every movement, append-only.
 *
 * §6.4: corrections are compensating entries. No UPDATE, no DELETE — migration
 * 0033 revokes those grants from the application role rather than leaving the
 * rule as a comment, which is what ARCHITECTURE asks for in as many words
 * ("Enforce it — revoke those grants").
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    /** Signed: credits positive, debits negative. Sum per wallet == balance. */
    amount: numeric('amount', { precision: 28, scale: 8 }).notNull(),
    /** The running balance AFTER this entry (FSD requirement, §6.2). */
    balanceAfter: numeric('balance_after', { precision: 28, scale: 8 }).notNull(),
    entryType: ledgerEntryTypeEnum('entry_type').notNull(),
    /** What caused this row — every movement traces back to its cause. */
    referenceType: varchar('reference_type', { length: 50 }).notNull(),
    referenceId: varchar('reference_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ledger_entries_wallet_idx').on(t.walletId),
    index('ledger_entries_created_at_idx').on(t.createdAt),
    /*
     * ⚠️ THE IDEMPOTENCY GUARANTEE. Losing this is how a replayed deposit or a
     * retried provider webhook credits a client twice — the exact consequence
     * migration 0028 recorded when it dropped this table, and the reason the
     * teardown note demanded it come back before any provider is connected.
     *
     * `WalletService.post()` inserts with ON CONFLICT on these three columns and
     * returns the ORIGINAL entry when it fires, leaving the balance untouched.
     * A service-level "have I seen this reference?" is not a substitute: that is
     * a check-then-insert, and every check-then-insert loses under concurrency
     * (§6.3).
     */
    uniqueIndex('ledger_entries_wallet_reference_uq').on(
      t.walletId,
      t.referenceType,
      t.referenceId,
    ),
  ],
);

/** A trading account. See the balance column for what the CRM owns and why. */
export const tradingAccounts = pgTable(
  'trading_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /**
     * The MT5 login, once there is an MT5 to issue one.
     *
     * NULLABLE and renamed from `mt5_login`: there is no bridge, so a CRM-side
     * account has no login until one is assigned. Unique WHERE NOT NULL, so two
     * unassigned accounts do not collide on it.
     *
     * A string, not a number — leading zeros are significant to the bridge.
     */
    login: varchar('login', { length: 50 }),
    mt5Group: varchar('mt5_group', { length: 100 }),
    environment: tradingEnvironmentEnum('environment').notNull().default('live'),
    /**
     * The account's own currency, which need not be the wallet's.
     *
     * A transfer between a USD wallet and a USD account is a move; between
     * different currencies it is a conversion, and there is no FX rate source
     * here. `TransfersService` refuses a mismatch rather than inventing a rate.
     */
    currency: varchar('currency', { length: 10 })
      .notNull()
      .references(() => currencies.code, { onDelete: 'restrict' }),
    /**
     * ⚠️ THIS COLUMN REVERSES A DELIBERATE DECISION, and must be reversed back.
     *
     * The deleted `trading_accounts` had NO balance, and its DTO said why: "No
     * balance, equity, margin or open positions. Those live in MT5, not in this
     * database … a fabricated figure beside a real MT5 login is the most
     * expensive kind of wrong number on a trading product."
     *
     * That was right, and it depended on MT5 existing. It does not — there is
     * no bridge service (ARCHITECTURE open decision #1), so nothing else can
     * hold this number and a transfer would have nowhere to land. The CRM owns
     * it in the meantime.
     *
     * WHEN THE BRIDGE LANDS: this becomes a mirror of MT5's balance, written
     * only by the sync, or it is removed and the terminal is the only source.
     * What it must NOT do is stay a CRM-owned number that MT5 also has an
     * opinion about — two numbers for one balance is the state the original
     * design existed to prevent.
     */
    balance: numeric('balance', { precision: 28, scale: 8 }).notNull().default('0'),
    tier: varchar('tier', { length: 50 }),
    leverage: integer('leverage'),
    status: tradingAccountStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('trading_accounts_user_idx').on(t.userId),
    uniqueIndex('trading_accounts_login_uq')
      .on(t.login)
      .where(sql`${t.login} IS NOT NULL`),
    check('trading_accounts_balance_non_negative', sql`${t.balance} >= 0`),
  ],
);

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
    currency: varchar('currency', { length: 10 })
      .notNull()
      .references(() => currencies.code, { onDelete: 'restrict' }),
    state: transactionStateEnum('state').notNull().default('pending'),
    /** The `payment_methods.key` this went through, for a deposit. */
    methodKey: varchar('method_key', { length: 40 }).references(() => paymentMethods.key, {
      onDelete: 'restrict',
    }),
    provider: varchar('provider', { length: 50 }).notNull(),
    /**
     * The provider's own reference — or, for a manual method, the one the
     * client transcribed from their transfer.
     *
     * §6.3: `UNIQUE(provider, provider_ref)` is the idempotency guarantee for
     * replayed payment callbacks.
     */
    providerRef: varchar('provider_ref', { length: 255 }),
    /** Withdrawal destination (bank/wallet address) as the client supplied it. */
    destination: varchar('destination', { length: 255 }),
    /**
     * Set when the client asked to fund a TRADING ACCOUNT rather than the wallet.
     *
     * The money still lands in the wallet first — the wallet is the CRM's ledger
     * and every balance the platform owns passes through it, so a deposit that
     * skipped it would be money with no ledger row. This records the client's
     * INTENT, and on confirmation the deposit chains a `transfers` row to move
     * it on. One ledger, one truth, and the two-step is visible in the data
     * rather than hidden behind a single ambiguous "deposit".
     *
     * A REAL foreign key this time; the deleted column was a bare uuid.
     */
    destinationTradingAccountId: uuid('destination_trading_account_id').references(
      () => tradingAccounts.id,
      { onDelete: 'restrict' },
    ),
    rejectionReason: text('rejection_reason'),
    /** The admin who decided. No FK — same reasoning as `audit_log.actor_id`. */
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

export const transfers = pgTable(
  'transfers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    tradingAccountId: uuid('trading_account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'restrict' }),
    direction: transferDirectionEnum('direction').notNull(),
    amount: numeric('amount', { precision: 28, scale: 8 }).notNull(),
    currency: varchar('currency', { length: 10 })
      .notNull()
      .references(() => currencies.code, { onDelete: 'restrict' }),
    state: transferStateEnum('state').notNull().default('pending'),
    /** Why it was refused. Null unless `state = 'failed'`. */
    failureReason: text('failure_reason'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transfers_user_idx').on(t.userId),
    index('transfers_state_idx').on(t.state),
    index('transfers_created_at_idx').on(t.createdAt),
    index('transfers_trading_account_idx').on(t.tradingAccountId),
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

// ═══ IB / PARTNERS ═══════════════════════════════════════════════════════════
//
// The introducing-broker programme. Rebuilt from zero after the commission
// engine was removed — see migration 0028 for what left and why.

/**
 * How a level is paid. Checked against several forex-CRM vendors: brokers run
 * fixed per-lot rebates OR revenue-share percentages, and many run both across
 * different programmes. A schema that assumed one of them would need a
 * migration on a table partners reference the first time the business changed
 * its mind, so the choice is a column from day one.
 *
 *   revenue_share  `rateValue` is a PERCENTAGE of the commission pool. The
 *                  enabled levels must total <= 100 between them.
 *   per_lot        `rateValue` is an AMOUNT per standard lot, in the platform's
 *                  default currency. Levels do not compete for a pool, so there
 *                  is no cross-level ceiling — the total is whatever the
 *                  operator configured, and a per-lot ladder that costs more
 *                  than the spread earns is a commercial mistake this table
 *                  cannot detect.
 *
 * CPA (a one-off payment per funded client) is deliberately ABSENT. It is a
 * third model, it is real, and it is not a per-level rate — it is a per-client
 * event with its own qualification rules. Adding it as a third enum value would
 * make `rateValue` mean three things and none of them clearly.
 */
export const ibPayoutModelEnum = pgEnum('ib_payout_model', ['revenue_share', 'per_lot']);

/**
 * The payout ladder: how many levels deep earnings travel, and what each takes.
 * ## What a "level" means here
 *
 * An IB hierarchy is a chain. A LEVEL 1 partner deals with the broker directly;
 * a LEVEL 2 partner was recruited by an L1, and so on. When a client an L2
 * introduced generates revenue, the L2 earns, and the L1 above them earns a
 * smaller override on top. Earnings flow UPWARD.
 *
 * So the number of rows in this table is the DEPTH OF THE PAYOUT CHAIN, not a
 * cap on how many partners may exist. Two rows — the default this ships with —
 * means a client's activity pays their direct partner and that partner's
 * parent, and stops there. A third row would extend the chain one hop further,
 * not permit a third partner.
 *
 * That distinction is the reason this is a table of levels rather than a column
 * on the partner: "how far do earnings travel" is one platform-wide decision,
 * and putting it on each partner would let two partners in one chain disagree
 * about it.
 *
 * ## `rateValue` is NUMERIC, never a float
 *
 * It multiplies money. §6.1 applies to anything that TOUCHES an amount, not
 * only to amounts themselves: a rate held as a float reintroduces the error the
 * decimal columns exist to prevent, one multiplication later.
 *
 * Under `revenue_share` the enabled levels must not exceed 100 between them —
 * the service enforces that, because a database CHECK cannot see the other
 * rows. Under `per_lot` there is no such ceiling; see the enum above.
 *
 * ## Nothing consumes these rates yet, and that is deliberate
 *
 * The commission engine was removed with the MT5 bridge, so no deal arrives to
 * be paid on. This table is the CONFIGURATION the engine will read, and it is
 * built now because the approval flow already needs the hierarchy half of it —
 * `maxDirectPartners` is enforced the day partners exist. What must NOT happen
 * is a screen reporting earnings computed from these numbers before an engine
 * exists to compute them; that was the "commission plans" screen this replaced.
 *
 * ## `level` is the primary key
 *
 * Not a surrogate uuid. The level number IS the identity — "level 2" means one
 * thing platform-wide — and an ordering that lives in a separate column can
 * disagree with the key. It also makes `ib_accounts.level` a plain integer FK
 * that a person reading a row can interpret without a join.
 */
export const ibLevels = pgTable('ib_levels', {
  /** 1 is the partner closest to the broker; higher numbers sit further down. */
  level: integer('level').primaryKey(),
  name: varchar('name', { length: 80 }).notNull(),
  payoutModel: ibPayoutModelEnum('payout_model').notNull().default('revenue_share'),
  /**
   * The rate, whose UNIT depends on `payoutModel` — a percentage for
   * revenue_share, an amount per lot for per_lot.
   *
   * One column rather than two nullable ones, because a level has exactly one
   * rate and a pair where one is always null invites reading the wrong one.
   * The model is what disambiguates, and it is NOT NULL.
   *
   * 12,4 rather than 5,2: it has to hold a percentage like 30.00 AND a per-lot
   * amount, and per-lot rates are quoted in cents at the low end. Four decimals
   * so a $2.5000 rebate and a 2.5% share both survive without rounding.
   */
  rateValue: numeric('rate_value', { precision: 12, scale: 4 }).notNull().default('0'),
  /**
   * How many partners this level may recruit directly. NULL means unlimited.
   *
   * Checked at approval, when a parent is assigned. Nullable rather than a
   * sentinel like 0 or -1, because "no limit" is genuinely the absence of a
   * limit and a magic number invites an off-by-one at every read.
   */
  maxDirectPartners: integer('max_direct_partners'),
  /**
   * A disabled level stops NEW partners being placed at it and takes no share.
   * Existing partners at that level keep their placement — the same reasoning
   * as a disabled currency, and for the same reason: the alternative is
   * silently re-levelling people who did nothing wrong.
   */
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/*
 * ── IB applications and accounts ─────────────────────────────────────────────
 *
 * Two tables, not one with a status column.
 *
 * The application is a REQUEST; the account is the GRANT. Collapsing them means
 * every read of "is this person a partner" has to also ask "and was their
 * application approved", and the day somebody forgets the second half a
 * rejected applicant is a partner. Here the question is `SELECT FROM
 * ib_accounts` and there is no second half.
 *
 * It also makes re-application honest. A rejected applicant may apply again;
 * that is a new row with its own reason and reviewer, and the old refusal stays
 * readable instead of being overwritten by the next attempt.
 */
export const ibApplicationStatusEnum = pgEnum('ib_application_status', [
  'pending',
  'approved',
  'rejected',
]);

export const ibApplications = pgTable(
  'ib_applications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Why they want it, in their words. Free text; the reviewer reads it. */
    motivation: text('motivation'),
    /** Self-reported, unverified, and labelled as such on both screens. */
    expectedVolume: varchar('expected_volume', { length: 120 }),
    website: varchar('website', { length: 2048 }),
    status: ibApplicationStatusEnum('status').notNull().default('pending'),
    /**
     * Composed the same way a KYC refusal is: a configured reason, optionally
     * suffixed with the reviewer's note. Stored composed, because that is the
     * sentence the client was shown and re-deriving it later from parts that
     * may have been edited would show them a different one.
     */
    rejectionReason: text('rejection_reason'),
    /** The admin who decided. No FK to admin_users — see `audit_log.actor_id`. */
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * At most one PENDING application per user, in the database rather than in
     * a service check.
     *
     * A partial unique index, because the constraint is only on `pending`: a
     * user may have any number of rejected applications behind them. Doing this
     * with a read-then-insert loses to a double-submit — two clicks, two
     * requests, both read zero, both insert — and the reviewer then sees the
     * same person twice in the queue.
     */
    uniqueIndex('ib_applications_one_pending_uq')
      .on(t.userId)
      .where(sql`${t.status} = 'pending'`),
    index('ib_applications_status_submitted_idx').on(t.status, t.submittedAt),
  ],
);

/**
 * A partner. One row per person, created only on approval.
 *
 * ## `parentIbUserId` is a REAL foreign key this time
 *
 * The deleted `ib_profiles.parent_ib_id` was a bare uuid with no constraint, so
 * a parent could point at a row that had never existed or had gone. The chain
 * this column describes is walked per commission calculation; a dangling link
 * in it is a payout that silently stops halfway up.
 *
 * Postgres will not stop a CYCLE, though — a self-referencing FK only checks
 * that the target exists. `wouldCreateCycle` in the service is what does, and
 * it must run on every reassignment.
 */
export const ibAccounts = pgTable(
  'ib_accounts',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'restrict' }),
    /*
     * `onUpdate: 'cascade'`, and that is load-bearing rather than incidental.
     *
     * Reordering the ladder RENUMBERS these primary keys — level 2 becomes
     * level 1 — and this column is checked immediately, not deferred. Without
     * cascade there is no order that works: the level cannot move while a
     * partner references it, and the partner cannot move to a level that does
     * not exist yet. With it, Postgres carries the placements across in the
     * same statement, so a partner stays on the rung they were put on.
     *
     * `onDelete` stays `restrict`. Renumbering a level is a reshuffle; deleting
     * one out from under somebody standing on it is data loss, and those
     * deserve opposite answers.
     */
    level: integer('level')
      .notNull()
      .references(() => ibLevels.level, { onDelete: 'restrict', onUpdate: 'cascade' }),
    /** NULL means they deal with the broker directly — the top of a chain. */
    parentIbUserId: uuid('parent_ib_user_id'),
    /**
     * What a client types at registration to be attributed to this partner.
     *
     * Unique platform-wide and never reissued: attribution is permanent per
     * client, so a code that came back around would credit somebody else's
     * introductions to whoever holds it now.
     */
    referralCode: varchar('referral_code', { length: 50 }).notNull().unique(),
    /**
     * A suspended partner keeps their code and their tree — clients attributed
     * to them stay attributed — and stops earning. Deleting the row instead
     * would orphan every client beneath them.
     */
    active: boolean('active').notNull().default(true),
    /** The application this grant came from, so the decision stays traceable. */
    applicationId: uuid('application_id').references(() => ibApplications.id, {
      onDelete: 'restrict',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * The self-reference, declared here rather than inline on the column.
     * `.references(() => ibAccounts.userId)` on the column itself is a circular
     * reference at module scope — the table is not bound yet. Inside the config
     * callback it is, so this is where a self-FK goes.
     */
    foreignKey({
      columns: [t.parentIbUserId],
      foreignColumns: [t.userId],
      name: 'ib_accounts_parent_fk',
    }).onDelete('restrict'),
    /* The hot read: "how many partners does this parent already hold?", asked
       on every approval to enforce `ibLevels.maxDirectPartners`. */
    index('ib_accounts_parent_idx').on(t.parentIbUserId),
    index('ib_accounts_level_idx').on(t.level),
  ],
);
