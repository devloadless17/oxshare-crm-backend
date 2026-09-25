import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
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
  unique,
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
/**
 * ⚠️ `pending` IS UNREACHABLE, AND WAS BEFORE THIS NOTE EXISTED.
 *
 * Verified 11 Sep 2026: registration writes `active`, `setClientStatus` is typed
 * `'active' | 'suspended'`, and no migration ever backfilled it. There is no way
 * into this state and no way out of it. One seeded fixture held it — which is
 * how it looked populated in dev and empty in production.
 *
 * The consequence was operator-facing and quiet: the client list offered a
 * "Pending" filter that could never have members, and an empty result reads as
 * "no clients are pending" rather than "no client can be pending". The filter
 * option is removed.
 *
 * The VALUE stays. Postgres cannot drop an enum value under a live table, and
 * keeping it costs nothing — while removing it would be a risky migration for
 * tidiness. If a real pending state is ever wanted (registration writes it,
 * verification promotes to active), the transitions are what need building and
 * this value is already here.
 *
 * Note the DTO's own sentence — "'pending' here means the account itself is not
 * yet active, and says nothing about documents" — has to work hard to say what
 * it MEANS and still cannot say what PUTS a client there. That gap is what
 * identified it.
 */
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
export const rejectionContextEnum = pgEnum('rejection_context', [
  'kyc',
  'withdrawal',
  'partner',
  // Offline deposits: a receipt that does not match, is unreadable, or names an
  // amount the desk never received. Added in 0127, alone in its file — a new
  // enum value cannot be USED in the transaction that adds it.
  'deposit',
]);

// ── users (ARCHITECTURE §5; indexes per "Required indexes") ──────────────────
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /**
     * The client's PORTAL ID — the human number, from 1,000,000 up (0133).
     *
     * What staff and the client see and search by; the UUID above stays the
     * key every foreign key points at, and the one URLs and API routes use. A
     * sequential number is guessable, so it must never become an access key —
     * it names a client to a person, not to the system.
     *
     * Drawn from `users_portal_id_seq` by a column DEFAULT, so no insert path
     * has to remember it. Clients imported from the old platform set it
     * explicitly to their original number (1 … ~200,000), below the range the
     * sequence owns; the importer must refuse anything ≥ 1,000,000. Gaps are
     * expected — a failed registration still consumes its number.
     */
    portalId: integer('portal_id')
      .notNull()
      .default(sql`nextval('users_portal_id_seq')`),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    type: userTypeEnum('type').notNull().default('individual'),
    status: userStatusEnum('status').notNull().default('active'),
    verificationLevel: integer('verification_level').notNull().default(0),
    emailVerified: boolean('email_verified').notNull().default(false),
    /*
     * Email verification — a SHA-256 HASH of the emailed token, never the token.
     *
     * ## Why a hash, when this used to be plaintext
     *
     * `passwordResetTokenHash` below has always been hashed, for a reason that
     * applies here word for word: a database dump, a leaked backup or a
     * read-only SQL injection would otherwise hand an attacker a working link
     * for every user with one outstanding. This column was the last plaintext
     * single-use credential in the schema — the 6 Aug note on `verifyEmail`
     * called it out as exactly that and only shortened its life. Hashing ends
     * it. The token is a v4 UUID, so a fast digest is the right primitive: there
     * is no guessable secret for a slow KDF to protect, and this lookup is
     * unauthenticated and triggerable at will.
     *
     * ## It SURVIVES consumption, paired with `emailVerificationConsumedAt`
     *
     * The row used to be wiped the moment a link worked, which made "this token
     * was used successfully a minute ago" and "this token never existed" the
     * same state — so a refresh, a Back button, or a corporate mail scanner
     * prefetching the link produced a red "Verification Failed" on an account
     * that was verified (UX-01). Keeping the hash is what lets the second POST
     * answer `already_verified` instead of lying.
     *
     * Retaining it costs nothing a cleared column bought: a hash is not a usable
     * credential, which is the whole point of the paragraph above.
     */
    emailVerificationTokenHash: varchar('email_verification_token_hash', {
      length: 64,
    }),
    emailVerificationExpiry: timestamp('email_verification_expiry', {
      withTimezone: true,
    }),
    /*
     * When the token above was successfully redeemed. NULL means outstanding.
     *
     * Written in the SAME statement as `email_verified` and never apart from it
     * (`UsersStore.consumeEmailVerification`), so the two cannot disagree — a
     * conditional `WHERE ... consumed_at IS NULL` with a rowcount check, the
     * §6.3 idempotency idiom, rather than a read-then-write that two concurrent
     * clicks would both win.
     *
     * ⚠️ EVERY writer of a new `emailVerificationTokenHash` must clear this in
     * the same update, or a fresh link would be born looking already-redeemed.
     * There are two (`AuthService.resendVerification`,
     * `AdminClientsService.changeEmail`) plus `register`, which INSERTs and so
     * gets NULL for free. This is not left to prose: `UsersStore.update`
     * REFUSES a patch that sets a new hash without saying what happens to this,
     * so a third writer cannot forget.
     */
    emailVerificationConsumedAt: timestamp('email_verification_consumed_at', {
      withTimezone: true,
    }),
    /*
     * ── THE 6-DIGIT CODE, mailed beside the link (0138) ─────────────────────
     *
     * The client types it on the screen they registered from and is signed
     * straight in. Four columns, and every one of them is part of why a code
     * that short is safe:
     *
     *   hash        HMAC-SHA256 under a server secret, bound to the user id.
     *               Not the plain SHA-256 the link uses: a code has a million
     *               values, so a digest alone would fall to a dump in seconds.
     *   expires_at  15 minutes. A code is for the screen in front of you.
     *   attempts    5 wrong answers burn it — counted in the same statement
     *               that reads the hash (`takeEmailCodeAttempt`), so parallel
     *               guesses cannot spend more than the budget.
     *   sent_at     the resend cooldown, enforced in the UPDATE that issues a
     *               new one, so two quick requests cannot both mail.
     *
     * Deliberately NOT on the `User` object (`toUser` strips them): nothing can
     * serialise a field it never holds. Only the store's code methods touch
     * them, and `UsersStore.update` clears them whenever the address or its
     * verification changes — a code mailed to one address must never confirm
     * another.
     */
    emailVerificationCodeHash: varchar('email_verification_code_hash', { length: 64 }),
    emailVerificationCodeExpiresAt: timestamp('email_verification_code_expires_at', {
      withTimezone: true,
    }),
    emailVerificationCodeAttempts: integer('email_verification_code_attempts').notNull().default(0),
    emailVerificationCodeSentAt: timestamp('email_verification_code_sent_at', {
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
    /*
     * THE CLIENT PROFILE lives in these columns and NOWHERE ELSE (0139) — see
     * `common/profile/client-profile.ts` for the rules every writer obeys.
     *
     * `country` is the country of RESIDENCE, as the name `countries-list` gives
     * it (the KYC select's own list). `phone` is E.164 (`+96170123456`).
     * `date_of_birth` is a DATE, not text: the KYC blob used to hold whatever
     * string parsed, including a timestamp, and a column that cannot hold
     * "2026-02-31" is the cheapest validation there is.
     *
     * Until 0139, date of birth, nationality and address lived only in
     * `kyc_submissions.personal_info`, while name, phone and country lived here
     * AND there — two copies that nothing kept equal, so a client could hold one
     * name on their account and another on their verification. The KYC personal
     * step now reads and writes these columns, and `personal_info` keeps only
     * answers to fields a broker invented.
     */
    country: varchar('country', { length: 100 }),
    phone: varchar('phone', { length: 32 }),
    dateOfBirth: date('date_of_birth', { mode: 'string' }),
    nationality: varchar('nationality', { length: 100 }),
    address: varchar('address', { length: 200 }),
    city: varchar('city', { length: 100 }),
    postalCode: varchar('postal_code', { length: 12 }),
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
    uniqueIndex('users_portal_id_uq').on(t.portalId),
    index('users_type_idx').on(t.type),
    index('users_status_idx').on(t.status),
    index('users_verification_level_idx').on(t.verificationLevel),
    index('users_created_at_idx').on(t.createdAt),
    index('users_country_idx').on(t.country),
    /* "Which clients did this partner introduce?" — asked per partner by every
       commission calculation the engine will eventually run. */
    index('users_referred_by_idx').on(t.referredByIbUserId),
    /*
     * The verification lookup, which is a by-token seek over the whole table.
     *
     * It had no index while the column was plaintext, and got away with it
     * because it was rare. It is no longer rare in the same way: the hash now
     * OUTLIVES redemption, so every repeat click, refresh and mail-scanner
     * prefetch is another seek — and §5 sizes this table at ~219,000 rows.
     *
     * UNIQUE, and that is a correctness constraint rather than a performance
     * one. `findByVerificationTokenHash` takes `.limit(1)`: if two rows ever
     * held the same hash, it would return an ARBITRARY one of them and verify
     * the wrong account — silently, on the control that gates KYC and therefore
     * withdrawals. Tokens are `randomUUID`, so this cannot happen by chance;
     * the constraint is here so that if it ever does, it is an INSERT failure
     * somebody has to look at rather than a client verified into a stranger's
     * account. §6.3: idempotency lives in database constraints.
     *
     * Nulls do not collide in Postgres, so the many rows with no outstanding
     * token are unaffected.
     */
    uniqueIndex('users_email_verification_token_hash_idx').on(t.emailVerificationTokenHash),
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
  /**
   * D-60 — sees the intake pool: clients with NO tag assignments yet.
   *
   * "Untriaged" is a DERIVED state (has no tags), never a tag — materialising
   * it was tried and reverted (migrations 0055–0057): stored derived state
   * needed three guards to stay true, and still allowed an orphan class
   * (remove a client's last tag and nobody scoped could see them). Under the
   * derived model every client is ALWAYS either in a territory or in intake.
   *
   * Only meaningful for a SCOPED admin — an unrestricted admin sees everything
   * regardless. Honoured as an OR-branch in `clientScopePredicate`.
   */
  seesUntriaged: boolean('sees_untriaged').notNull().default(true),
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

  /*
   * The instant that invalidates every access token issued before it.
   *
   * Mirrors `users.password_changed_at`, and the admin surface needed it more.
   * Revoking refresh families on a password change only stops those sessions
   * RENEWING — each keeps working on its already-issued access token for up to
   * fifteen more minutes. On the console that approves withdrawals, fifteen
   * minutes of continued access is exactly what somebody changing their
   * password under duress is trying to prevent.
   *
   * NULL means no cutoff, which is what every account predating this column
   * has. Adding it must not sign anybody out.
   */
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),

  /*
   * The administrator's profile photo — the STORED FILENAME, not a URL.
   *
   * Same shape and same reasoning as `users.avatar_filename`: `<uuid>.<ext>`
   * under ./uploads/avatars, written by StoredFilesService, with the extension
   * taken from the file's own magic bytes rather than from the multipart
   * Content-Type. That header is a claim by the uploader, and an HTML document
   * declared `image/png` is how a stored file becomes stored XSS.
   *
   * A filename rather than a URL because the URL is a function of how the API is
   * deployed — the §8.5 move to private S3 changes how bytes are served and must
   * not require rewriting a column.
   *
   * Shared bucket with client avatars deliberately. The files are the same kind
   * of thing with the same validation, and a second bucket would be a second
   * place to get the magic-byte check wrong.
   */
  avatarFilename: varchar('avatar_filename', { length: 128 }),
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
  /** D-60 — intake grant chosen at invite time, for the same window reason. */
  seesUntriaged: boolean('sees_untriaged').notNull().default(true),
  invitedBy: uuid('invited_by').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  accepted: boolean('accepted').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Machine credentials for the admin API — a key belongs to the PLATFORM, not
 * to a person.
 *
 * ── Why not "acts as the admin who created it" ─────────────────────────────
 *
 * That is the shape most systems reach for and it fails twice. The key
 * silently GAINS power when its creator is promoted, and it dies — or worse,
 * keeps a departed employee's authority — when they leave. An integration that
 * pulls a nightly client report should not be a person, so it holds its own
 * permission list, chosen at creation from the same catalog roles use.
 *
 * ── The secret is stored as a SHA-256 hash, and that is deliberate ─────────
 *
 * Not argon2id, which `admins.password_hash` uses. The reasoning differs
 * because the threat does: a password is low-entropy and human-chosen, so it
 * needs a slow hash to survive an offline crack. This key is 32 bytes of
 * `randomBytes` — brute-forcing it is not on the table — and it is presented on
 * EVERY request, where a deliberately slow hash would be a self-inflicted
 * denial of service. Fast hash, high entropy; the pairing is the point.
 *
 * The plaintext is shown once at creation and never stored, so a database dump
 * yields nothing usable. `prefix` exists precisely because of that: it is the
 * non-secret first characters, enough for an operator to tell two keys apart on
 * screen and to match a leaked key against a row without the system ever
 * holding a credential it could leak itself.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** What this key is for, in an operator's words. Shown in the list. */
    name: varchar('name', { length: 100 }).notNull(),
    /**
     * SHA-256 of the presented secret, hex. UNIQUE so a lookup is one indexed
     * equality — the alternative, scanning rows and comparing, would put an
     * O(n) hash loop on the hot path of every authenticated request.
     */
    secretHash: varchar('secret_hash', { length: 64 }).notNull().unique(),
    /**
     * The non-secret leading characters (`oxs_live_a1b2c3`), for display.
     * Never enough to authenticate with — see the table comment.
     */
    prefix: varchar('prefix', { length: 24 }).notNull(),
    /**
     * What this key may do, from `config/permissions.json` — the same catalog
     * roles draw from, so a key can never hold a power no role could grant.
     *
     * Deliberately NOT nullable and NOT defaulted to `['*']`: a key created
     * with no permissions can do nothing, which is the safe direction for a
     * field somebody might forget to fill in.
     */
    permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
    /**
     * Who created it. `set null` rather than `cascade`: deleting an
     * administrator must not silently delete the still-live credentials they
     * issued, and an orphaned key with a null creator is a thing an operator
     * can see and revoke.
     */
    createdBy: uuid('created_by').references(() => admins.id, { onDelete: 'set null' }),
    /**
     * The creator's TERRITORY, snapshot at creation (migration 0059). A key
     * authenticates with this scope, not with unrestricted sight — otherwise a
     * tag-scoped admin could mint a key that reads the whole client base and
     * launder their scope away. An empty/NULL list means unrestricted, so a key
     * from an unrestricted admin still sees the whole book (the reporting-job
     * case). A column, never a live join to the creator: the key must not
     * change territory when its creator does, nor break when they are deleted —
     * exactly the reasoning behind `admin_invites.scoped_tag_ids`.
     */
    scopedTagIds: jsonb('scoped_tag_ids').$type<string[]>(),
    /** The creator's intake grant, snapshot with the territory above (D-60). */
    seesUntriaged: boolean('sees_untriaged').notNull().default(true),
    /**
     * NULL means no expiry. Stated rather than defaulted to a date, because a
     * key that silently stops working at 3am is worse than one an operator
     * chose to make permanent.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /**
     * Set on revocation instead of deleting the row — the audit trail points at
     * this id, and a deleted row makes every entry referencing it unreadable.
     * Revocation is checked on every request, so it takes effect immediately.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * Best-effort, for spotting keys nobody uses any more.
     *
     * Written on a throttled schedule rather than on every request: an UPDATE
     * per authenticated call would put a write on the hot path of a read-only
     * integration, and "last used within the hour" answers the question an
     * operator is actually asking.
     */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The authentication path: hash → row. Partial, because a revoked key is
    // never a hit and there is no reason to carry dead rows in the hot index.
    index('api_keys_active_idx')
      .on(table.secretHash)
      .where(sql`${table.revokedAt} IS NULL`),
    index('api_keys_created_at_idx').on(table.createdAt),
  ],
);

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
    /**
     * Answers for steps that are NOT one of the four canonical ones, keyed by
     * slug: `{ "compliance-questions": { "sourceOfFunds": "salary" } }`.
     *
     * ## Why a map beside four columns rather than instead of them
     *
     * `personal_info`, `document`, `selfie` and `address_proof` are read by
     * NAME all over the system — `personalInfo.phone` and `.country` are
     * promoted onto the client record, `document.frontFilePath` gates
     * submission, the reviewer's card is built from them. Folding those into a
     * generic map would be a rewrite of every read path to buy nothing: those
     * four slugs are not going anywhere.
     *
     * What this buys is the fifth step. A broker could always ADD one — the
     * builder offers it and the API accepts any slug — and until now
     * `KycService.saveStep` had nowhere to put the answers and refused them with
     * `Unknown step`, so a custom step rendered, accepted what the client typed,
     * and failed the moment they pressed Continue.
     *
     * NOT NULL with a `{}` default, so every existing row reads as "no custom
     * answers" rather than null — one fewer branch in every consumer, and the
     * distinction between "no custom steps" and "custom steps, none answered"
     * is not one anything needs to make.
     */
    stepData: jsonb('step_data')
      .$type<Record<string, Record<string, string | { filePath: string; fileName: string }>>>()
      .notNull()
      .default({}),
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
    /** Archived alongside the four columns — see `kyc_submissions.step_data`. */
    stepData: jsonb('step_data')
      .$type<Record<string, Record<string, string | { filePath: string; fileName: string }>>>()
      .notNull()
      .default({}),
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
 * ── The singleton settings rows ──────────────────────────────────────────────
 *
 * `smtp_settings` and `trading_settings` are each ONE ROW, forever, enforced by
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
 * SEPARATE tables rather than one, for the reason the SMTP feature exists: that
 * row holds a CREDENTIAL and the others do not. Keeping it alone means the
 * encrypted column, its permission-guarded write and its never-returned
 * response shape are properties of a TABLE rather than of particular columns
 * within one — so a setting added elsewhere cannot inherit or erode them.
 *
 * A third table, `general_settings`, held a brand name, support contacts and a
 * maintenance notice. It was removed along with its tab: nothing outside its
 * own settings screen ever read it — not the portal header it claimed to feed,
 * not one email template — so every field was an operator editing a value with
 * no effect. See migration 0051.
 */
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
 * ── The terms a client may open an account on ────────────────────────────────
 *
 * A THIRD singleton, in the same shape as the two above, holding the numbers
 * that bound self-service account opening: the leverage ladder, how many
 * accounts of each kind one client may open, and the largest demo balance they
 * may ask for.
 *
 * ## Why these moved out of the environment
 *
 * All four started as constants and env vars — `MT5_CLIENT_LEVERAGES` and a
 * `MAX_DEMO_FUNDING` hardcoded in two files. Every one of them is a COMMERCIAL
 * decision: which leverages to advertise is a regulatory question, how many demo
 * accounts a client may spin up is an abuse question, and the maximum practice
 * balance is a "what do we let people rehearse with" question. None is a
 * deployment detail, and all of them are answered by whoever runs the brokerage
 * rather than by whoever last edited a `.env` on the server.
 *
 * ## Why the leverage ladder is one text column
 *
 * It is an ORDERED LIST the operator types, `50,100,200,500`, and the order is
 * the order the client sees. `integer[]` would model it more precisely and buy
 * nothing: nothing queries into it, and the CSV is exactly what the operator
 * typed, which is what should come back when they reopen the form.
 */
export const tradingSettings = pgTable(
  'trading_settings',
  {
    id: boolean('id')
      .primaryKey()
      .$default(() => true),
    /*
     * `leverages` was here — a CSV of the ladder. It is the `leverages` TABLE
     * now (migration 0067): an operator needs to withdraw a rung without
     * touching the accounts standing on it, and a delimited string has nowhere
     * to put `enabled`.
     */
    /*
     * Per client, per environment. A cap of ZERO is meaningful and is not the
     * same as self-service being off: it stops new accounts of that kind while
     * leaving the ones a client already has alone. "Unlimited" is deliberately
     * absent — an uncapped demo endpoint is a free account generator on the
     * broker's own server.
     */
    maxLiveAccounts: integer('max_live_accounts').notNull().default(5),
    maxDemoAccounts: integer('max_demo_accounts').notNull().default(5),
    /*
     * The largest opening balance a demo account may be given, as a decimal
     * string like every other money column here. Practice money, but it is
     * credited on the broker's server and it shows up in their reporting.
     */
    maxDemoDeposit: numeric('max_demo_deposit', { precision: 28, scale: 8 })
      .notNull()
      .default('1000000'),
    /**
     * ── HISTORICAL SINCE 0113. NOTHING READS THIS. ─────────────────────────
     *
     * It capped how deep the commission ladder could go, defaulting to 2
     * (Feature List Rev 9, IB-17). The IB Levels page is the only thing that
     * decides that now: add a rung and it pays, remove it and it stops — which
     * is what the operator asked for, and removes a second screen standing
     * between them and a third level.
     *
     * KEPT rather than dropped so a deployment's previous ceiling stays
     * legible. This is the third time this particular number has moved (0105
     * added it, 0107 reshaped it, 0113 retired it), and the column is the only
     * record of what a broker had configured before.
     */
    ibMaxLevels: integer('ib_max_levels').notNull().default(2),
    /**
     * How often commission is PAID — the maturation delay and the payout
     * period, as ONE number (0113).
     *
     * Two clocks used to sit between a closed trade and money in a partner's
     * wallet, both environment variables and neither on any screen: the hold
     * window (`IB_COMMISSION_HOLD_HOURS`, 24h) and the job's cron (hourly).
     * Either alone leaves the other as the real delay — a one-minute run
     * against a 24h hold still pays nothing for a day — so this drives both.
     *
     * ⚠️ THE HOLD WINDOW IS A SAFETY FEATURE AND A SHORT INTERVAL REMOVES IT.
     * 24h existed so a bad deposit is caught by the desk's daily rhythm BEFORE
     * the commission on it is spendable. At 60s a partner is paid before anyone
     * could review the trade, and a reversal then claws back a balance they may
     * already have moved. Right for testing; a real decision in production,
     * which is why the admin form says so beside the control.
     *
     * Floored at 60 by CHECK: below that a run has not finished draining before
     * its next tick, and stacked runs contend for the same rows to reach the
     * outcome one of them would have reached alone.
     */
    ibCommissionIntervalSeconds: integer('ib_commission_interval_seconds').notNull().default(3600),
    /**
     * The most one TRADE may cost in total, as a % of the broker's revenue on
     * it — every commission leg in the chain plus the client's rebate (0106).
     *
     * ## Why a per-programme ceiling cannot do this job
     *
     * `ib_programs_share_fits` already refuses a single programme whose tiers
     * plus rebate exceed 100. That bounds ONE partner's terms, and the earners
     * on a trade may hold different programmes, so it cannot see the other legs
     * and cannot bound the total. This one can, which is why it is here and not
     * on the catalogue: a constraint cannot live inside the thing it bounds.
     *
     * That is also what distinguishes it from the four IB settings 0104 removed
     * from this table. Each of those DUPLICATED an answer the Commission
     * Programmes page already gave. This CONSTRAINS that page, the same test
     * `ibMaxLevels` passes.
     *
     * ## It REFUSES; it does not scale
     *
     * `ib_max_revenue_share_pct` (0103) summed every leg and scaled them all
     * pro rata to fit. That paid immediately and told nobody their rate card
     * was wrong — a partner quietly received less than their programme
     * promised, on every trade, with no line anywhere saying so. Over the
     * ceiling now defers the deal on the 0092 backoff with the reason on the
     * row, and it pays in FULL once the programmes are corrected.
     *
     * ## Why the default is 100 and not something prudent
     *
     * 100 moves nobody's economics on the day it lands while still catching the
     * case with no legitimate reading — paying out more of a trade than it
     * earned. Seeding 60 would have silently deferred every chain above it on a
     * platform that had been paying them, which is a migration changing what
     * partners are paid. A broker protecting margin sets this deliberately.
     */
    ibMaxTotalPayoutPct: numeric('ib_max_total_payout_pct', { precision: 12, scale: 4 })
      .notNull()
      .default('100'),
    /**
     * The most ONE TRADE may pay out per standard lot, across every leg — 0111.
     *
     * The percentage ceiling above cannot bound a per-lot payout, because a
     * per-lot payout is not a share of revenue: paying $12 a lot on a trade
     * whose spread earned $8 is the model working, not a fault. Priced across
     * volume it is profitable; priced per trade it is sometimes a deliberate
     * loss.
     *
     * What the ceiling was always FOR still applies, though — it is the
     * unit-error backstop, the thing that refuses a "1000" typed where "10.00"
     * was meant rather than paying it. This is that backstop expressed in the
     * units per-lot terms are quoted in.
     *
     * Refuses rather than scales, exactly as its percentage sibling does: the
     * deal defers on the 0092 backoff with the reason on the row, and pays in
     * full once the terms are corrected. A partner must never quietly receive
     * less than their programme promised.
     */
    ibMaxPayoutPerLot: numeric('ib_max_payout_per_lot', { precision: 28, scale: 8 })
      .notNull()
      .default('50'),
    /*
     * ── THE IB BLOCK IS GONE FROM THIS TABLE (0104) ───────────────────────
     *
     * `ib_accrual_start`, `ib_commission_hold_hours`, `ib_revenue_basis` and
     * `ib_max_revenue_share_pct` (0103) all sat here. Each was moved onto this
     * row at some point on the reasoning that a commercial decision belongs
     * where an operator can see it — which was right about the decision and
     * wrong about the SCREEN.
     *
     * Commission is configured on the Commission Programmes page. Four controls
     * on the Trading settings form that also change what every partner earns
     * are a second place to look when a payout surprises somebody, and a second
     * place for two answers to disagree — the same fault 0102 removed from the
     * catalogue itself when `ib_levels` sat beside `ib_programs`.
     *
     * What each one is now:
     *
     *   ib_accrual_start          → `IB_ACCRUAL_START` (env), where it began.
     *                               THE AGED-BACKLOG GUARD IS UNCHANGED: unset,
     *                               a >48h backlog still HOLDS the run rather
     *                               than paying months of history at once.
     *   ib_commission_hold_hours  → `IB_COMMISSION_HOLD_HOURS` (env).
     *   ib_revenue_basis          → a constant: `DEFAULT_REVENUE_BASIS`, the
     *                               commission + swap the platform has always
     *                               paid on, so nobody's money moved.
     *   ib_max_revenue_share_pct  → nothing. See 0103.
     *
     * `ib_max_levels` arrived AFTER them (0105) and is a different kind of
     * thing — a bound on what the Commission Programmes page will accept, not
     * a rule about what anybody is paid. See the column below.
     */
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('trading_settings_singleton', sql`${t.id}`),
    /*
     * `trading_settings_hold_hours_ck` and `trading_settings_revenue_basis_ck`
     * went in 0104 with the columns they bounded.
     */
    check('trading_settings_ib_max_levels_ck', sql`${t.ibMaxLevels} BETWEEN 1 AND 10`),
    /*
     * `> 0` rather than `>= 0`: a ceiling of zero refuses every chain on the
     * platform, which is a way to stop paying partners entirely by typing a
     * number into a settings form. Turning the programme off is what the
     * `enabled` flag is for, and it says so.
     */
    check(
      'trading_settings_ib_max_total_payout_ck',
      sql`${t.ibMaxTotalPayoutPct} > 0 AND ${t.ibMaxTotalPayoutPct} <= 100`,
    ),
  ],
);

/*
 * The Rival connection — one row, forever, same singleton trick as above.
 *
 * Rival is Loadless's own payments platform; the CRM is one of its "companies"
 * and holds a `tsk_…` API key. Whish is integrated once inside Rival, so no
 * Whish credential exists anywhere in this schema.
 *
 * Two ciphertexts with one deliberate asymmetry:
 *
 *  - `apiKeyCiphertext` — OUR credential at Rival. Write-only: sealed on save,
 *    opened only by `RivalConfigService` on the way to an outbound call, in no
 *    response DTO ever.
 *  - `webhookKeyCiphertext` — the credential Rival presents TO US on webhook
 *    deliveries. SEALED, NOT HASHED, and that is a decision: it keys the
 *    HMAC-SHA256 on inbound signatures, and verifying an HMAC needs the
 *    plaintext. An argon2 hash — the treatment login secrets get — would make
 *    verification impossible. AES-256-GCM at rest is the strongest storage
 *    that leaves the key usable. It is minted HERE (shown to the operator
 *    exactly once, then pasted into Rival's dashboard), never chosen by hand.
 */
export const rivalSettings = pgTable(
  'rival_settings',
  {
    id: boolean('id')
      .primaryKey()
      .$default(() => true),
    baseUrl: varchar('base_url', { length: 2048 }),
    apiKeyCiphertext: text('api_key_ciphertext'),
    webhookKeyCiphertext: text('webhook_key_ciphertext'),
    /**
     * sha256(key)[:8] — enough for a log line to distinguish "wrong key pasted
     * into Rival" from "corrupt signature", useless for recovering the key.
     */
    webhookKeyFingerprint: varchar('webhook_key_fingerprint', { length: 8 }),
    enabled: boolean('enabled').notNull().default(false),
    /**
     * Liveness, not ordering: bumped on every verified inbound event so the
     * settings screen can answer "is the pipe alive". Event ordering is carried
     * by the transaction state machine's conditional updates, never by this.
     */
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('rival_settings_singleton', sql`${t.id}`)],
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

/**
 * RBAC-08 — the networks an administrator session may be used from.
 *
 * RESTORED. This table, its guard, its CIDR matcher and its tests were deleted
 * on 7 Aug as unwanted scope; the root CLAUDE.md records the opposite, that the
 * tech lead confirmed on 2 Aug that RBAC-08 is in scope and the committed total
 * is 41, and the deletion was never confirmed by them. The scope decision on
 * record wins (D-51).
 *
 * The deleting commit's engineering argument is kept and is right as far as it
 * goes: an application-level allowlist does not survive an application bug, and
 * the edge — a load balancer or WAF rule — is the stronger place for it. This
 * does not replace that; it is defence in depth, and the gap that commit named
 * (`/uploads/kyc/:file`, which serves passports and proof of address and sits
 * outside `/admin`) is covered this time rather than left as a note.
 */
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
 * ── The leverage ladder a client may open an account on ──────────────────────
 *
 * A TABLE, not the `trading_settings.leverages` CSV it replaces.
 *
 * That column held `50,100,200,500` and its own note argued the CSV was enough:
 * "nothing queries into it, and the CSV is exactly what the operator typed".
 * Both halves stopped being true. An operator withdrawing 500:1 for a
 * regulatory change had no way to say so except deleting it from the string —
 * which says nothing about the accounts already open on it — and a ladder with
 * no `enabled` cannot distinguish "we never offered this" from "we stopped".
 *
 * The same argument `currencies` and `ib_levels` already won: these are
 * operator data with their own lifecycle, and a delimited string is a table
 * that cannot be queried, ordered or audited per row.
 *
 * ## `ratio` is the key, and it is an INTEGER
 *
 * 500 means 500:1. The ratio is what MT5 is told, what a client picks and what
 * `trading_accounts.leverage` stores, so it is the natural identity — a surrogate
 * id would leave the number that actually matters unconstrained, and nothing
 * would stop two rows both claiming 500.
 *
 * ## A DISABLED rung keeps the accounts standing on it
 *
 * Exactly `currencies.enabled` and `ib_levels.enabled`: it stops the leverage
 * being OFFERED without touching accounts already opened on it. Deleting the
 * row is refused while any account references it, for the same reason a
 * currency holding wallets cannot be deleted.
 *
 * `trading_accounts.leverage` deliberately carries NO foreign key onto this.
 * MetaTrader is the system of record for what an account is actually running
 * at, and it may report a ratio this ladder never offered — a group default, a
 * value set by hand on the server, or one withdrawn years ago. A foreign key
 * would make the bridge's own truth unwritable.
 */
export const leverages = pgTable(
  'leverages',
  {
    /** `500` means 500:1 — the number MT5 is told and the client picks. */
    ratio: integer('ratio').primaryKey(),
    /**
     * What the client reads, when the ratio alone is not what the broker wants
     * to say. Null renders as `1:500`, which is what every screen did before
     * this table existed.
     */
    label: varchar('label', { length: 40 }),
    /** A disabled rung is not offered. Accounts already on it are untouched. */
    enabled: boolean('enabled').notNull().default(true),
    /** The operator's own order, which is the order a client sees. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /* The hot read: "what may a client choose", asked on every account-opening
       form and by the self-service group resolver. */
    index('leverages_enabled_sort_idx').on(t.enabled, t.sortOrder),
  ],
);

/*
 * ── external_links · what the operator points clients AT ─────────────────────
 *
 * One row per link the client portal shows in its sidebar: an economic
 * calendar, the broker's help centre, a Telegram channel, a market-analysis
 * blog. A title, an optional line of description, and the destination.
 *
 * A TABLE rather than a settings field or an env var, for the reason
 * `platform_links` is one: these change constantly, they change for marketing
 * reasons, and the person changing them does not ship releases.
 *
 * Unlike `platform_links` the SET is not fixed either. There is no product
 * decision naming the links the way `PLATFORM_KEYS` names the three terminals,
 * so this carries a surrogate id and rows come and go, where that table has a
 * fixed key per platform and only the url is operator data.
 *
 * `url` is NOT NULL, which is the opposite call from `platform_links.url`, and
 * the difference is what the row means. There, a null url is a platform nobody
 * has configured yet and the portal says exactly that. Here, a link with no
 * destination is not an unconfigured anything — it is a menu entry that goes
 * nowhere, which is the thing that table's own comment refuses to render.
 * Taking one off the menu is `enabled = false`.
 *
 * The URL becomes an `href` in every client's browser, so the service refuses
 * anything that is not http(s) — see `assertSafeExternalUrl`. That check is not
 * decoration: `javascript:` here would be stored XSS against every client who
 * opens the portal, written by an admin account or by whatever compromised one.
 */
export const externalLinks = pgTable(
  'external_links',
  {
    /*
     * A SURROGATE key, unlike every other catalogue in this file.
     *
     * `currencies` is keyed on the code, `leverages` on the ratio and
     * `platform_links` on the platform — in each case the natural key is the
     * value the rest of the system stores and compares. A link has no such
     * value: two entries may legitimately share a title, and the URL is the
     * field an operator edits most often, so keying on either would turn a
     * routine correction into a delete-and-recreate.
     */
    id: uuid('id').defaultRandom().primaryKey(),
    /** What the client reads in the sidebar. Sized for a menu entry, not prose. */
    title: varchar('title', { length: 80 }).notNull(),
    /*
     * NULLABLE, and null is a real answer rather than an unfinished one:
     * "Economic calendar" needs no gloss. The admin table gives it a column and
     * the portal hangs it off the menu entry as a tooltip, so an absent one
     * costs nothing on either side.
     */
    description: varchar('description', { length: 300 }),
    /*
     * Sized for a real URL rather than 255, for the reason `platform_links.url`
     * gives: campaign and locale parameters routinely pass 255, and a column
     * that truncates one produces a link that 404s.
     */
    url: varchar('url', { length: 2048 }).notNull(),
    /*
     * A disabled link is off the client's menu and still on the operator's
     * screen. Taking a dead link down is done in a hurry, and if the only way
     * were DELETE then the title, the description and the position would go
     * with it — so the fix for a supplier's five-minute outage would be
     * retyping the row.
     */
    enabled: boolean('enabled').notNull().default(true),
    /** The operator's own order, which is the order the sidebar renders. */
    sortOrder: integer('sort_order').notNull().default(0),
    /** The admin who last changed it. Null only for a row a migration seeded. */
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /* The hot read: the portal's sidebar asks "what is on the menu, in order"
       on every page it draws. */
    index('external_links_enabled_sort_idx').on(t.enabled, t.sortOrder),
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

/*
 * A pgEnum despite the currency and notification-kind precedents above and
 * below arguing against them: those value sets grow as DATA (an operator adds
 * a currency, a feature adds a kind). `real` vs `demo` is a closed pair whose
 * meanings are hard-wired into the offering resolution and the agency rules —
 * a third value would need code before it needed a row, so the migration a
 * pgEnum costs buys actual integrity here.
 */
export const productTypeEnum = pgEnum('product_type', ['real', 'demo']);

/**
 * WHAT A PRODUCT PAYS PARTNERS — the rate card a product is sold on (0140).
 *
 * ## Why the money moved off the ladder and onto the product
 *
 * Until 0140 every rung of `ib_levels` carried an ABSOLUTE amount per lot, and
 * one ladder therefore described one product. The moment the broker sells two
 * products on different terms — "$10 a lot on Standard, $6 on ECN" — a rung has
 * no single number to hold, and the alternative (a ladder per product) writes
 * the tree's shape once per product, which is the duplication `agencies`
 * already refused for the same reason.
 *
 * So the ABSOLUTE figures live here, one row per named arrangement, and a
 * product points at the one it is sold on. A rung then holds a PERCENTAGE of
 * whatever the product says: level 1 takes 70% of the product's commission,
 * level 2 takes 30%, and the same two numbers price every product in the
 * catalogue. Different types of commission and rebate, assigned to products as
 * a type — which is what was asked for.
 *
 * ## Two amounts, and they are different pools
 *
 * `commission_per_lot` is what the PARTNERS' side of a trade is worth. Each
 * rung in the chain above the client takes its own percentage of it — see
 * `calculate` for the arithmetic and for why the shares are independent rather
 * than carved out of each other.
 *
 * `rebate_per_lot` is what returns to the TRADING CLIENT, before the
 * introducer's level applies its own percentage. It is a separate figure
 * because it is a separate promise: "$3 back per lot" is quoted to a client
 * and "$10 a lot" to a partner, and neither is a slice of the other.
 *
 * ## A disabled type pays nobody
 *
 * The same rule as a disabled level or a disabled product: switching a rate
 * card off stops it paying and keeps every row that references it, so accruals
 * priced on it stay explicable. Deleting is `restrict`ed from both directions —
 * `trading_products.commission_type_id` and `ib_accruals.commission_type_id`.
 */
export const ibCommissionTypes = pgTable(
  'ib_commission_types',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** What an operator picks in the product form. "Standard", "Gold terms". */
    name: varchar('name', { length: 80 }).notNull().unique(),
    /** What was agreed, in the desk's words. Nothing computes with it. */
    description: text('description'),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * Money per standard lot for the PARTNERS, before the ladder's shares.
     * NUMERIC(28,8) because it is money (§6.1); a string at every boundary.
     */
    commissionPerLot: numeric('commission_per_lot', { precision: 28, scale: 8 })
      .notNull()
      .default('0'),
    /** Money per standard lot for the CLIENT, before the introducer's share. */
    rebatePerLot: numeric('rebate_per_lot', { precision: 28, scale: 8 }).notNull().default('0'),
    /** The order the picker lists them in. Ties broken by name. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * Non-negative, and bounded far above any real rate card. The upper bound
     * is a TYPO guard — a "1000" typed where "10.00" was meant — in the same
     * spirit as `ib_max_payout_per_lot`, which is the ceiling that actually
     * decides at accrual time. NOT NULL on the column means the
     * CHECK-evaluates-to-NULL trap 0111 hit cannot apply here.
     */
    check(
      'ib_commission_types_commission_range',
      sql`${t.commissionPerLot} >= 0 AND ${t.commissionPerLot} <= 10000`,
    ),
    check(
      'ib_commission_types_rebate_range',
      sql`${t.rebatePerLot} >= 0 AND ${t.rebatePerLot} <= 10000`,
    ),
  ],
);

/*
 * ── What the broker SELLS, and who is allowed to sell it ─────────────────────
 *
 * Four tables for what used to be one comma-separated environment variable. The
 * shape follows MT5's, and the direction of containment is not a preference:
 *
 *     Agency (وكالة)   name, description
 *       └─ Products     "Standard", "ECN"
 *            └─ Groups  demo\Standard-USD · real\Standard-USD · real\Standard-EUR
 *                 └─ Accounts
 *
 * A GROUP is the MT5 object — `MTConGroup`, a path like `real\Standard-USD` —
 * and it is a LEAF. An account points at exactly one group, and a group fixes
 * one currency and one environment, so a group cannot contain anything. The
 * moment "Standard" is sold in EUR as well as USD that is two groups and still
 * one product. Product → groups, one to many, never the reverse.
 *
 * A PRODUCT is the sellable thing: what the portal calls an account type and
 * what a client recognises.
 *
 * An AGENCY is the package a partner is appointed under. A partner is approved
 * against one agency, and their clients may open that agency's products and
 * nothing else.
 *
 * ## Why the agency carries the products rather than the partner
 *
 * The first design hung products off each partner individually. That is the
 * same information written once per partner: every new currency variant means
 * re-touching every partner, and an applicant on the portal is shown an empty
 * form rather than what they are applying for. An agency is the reusable noun
 * both problems were asking for.
 *
 * ## Why the partner link is here and not on the group
 *
 * Brokers who let MT5 compute rebates cut a group per partner, with the markup
 * in `MTConGroup.Commissions` — there the partner link MUST be to a group.
 * This system computes commission itself, from `ib_program_tiers.rate` into
 * `ib_accruals`, so the group carries nothing partner-specific and the link is
 * commercial: what this partner may sell. If commission ever moves to MT5-side
 * tables, this decision has to be revisited — two partners selling "Standard"
 * would then genuinely need two groups.
 */
export const tradingProducts = pgTable(
  'trading_products',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** What the client sees. "Standard", "ECN", "Raw Spread". */
    name: varchar('name', { length: 80 }).notNull().unique(),
    /** Shown to a client choosing, and to an applicant reading an agency. */
    description: text('description'),
    /**
     * A disabled product stops being OFFERED and keeps its accounts trading.
     *
     * The same rule as a disabled currency or a disabled IB level: retiring a
     * product must never reach into accounts that are already open, because the
     * client did nothing and their positions are real.
     */
    enabled: boolean('enabled').notNull().default(true),
    /*
     * There is deliberately NO `is_public` column.
     *
     * A draft had one, to make a product agency-exclusive — invisible to clients
     * who walked in off the website. The rule is simpler than that: a client
     * under an introducing broker sees exactly their agency's products, and a
     * client under nobody sees ALL of them. `enabled` is the only thing that
     * takes a product out of circulation.
     *
     * Worth knowing before adding the flag back: it would create a fourth state
     * ("exists, enabled, and yet nobody unattached can see it") that an operator
     * looking at an empty portal has no way to diagnose from this table.
     */
    /**
     * `real` or `demo`, and the rules hang off it:
     *
     * - At most ONE demo product exists (the partial unique index below), and
     *   it is offered to EVERY client for demo accounts, agency or no agency.
     * - Agencies carry real products only; the demo product cannot be assigned.
     * - A product's groups must match: live groups on real products, demo
     *   groups on the demo product.
     * - The type is IMMUTABLE after creation — flipping real→demo would strand
     *   agency links, demo→real would silently withdraw the global demo offer.
     *   Migration 0088 was the one legitimate bulk conversion.
     */
    type: productTypeEnum('type').notNull().default('real'),
    /**
     * WHAT THIS PRODUCT PAYS PARTNERS — the rate card it is sold on (0140).
     *
     * See `ibCommissionTypes`. Each rung of `ib_levels` takes a percentage of
     * the figures on that row, so one ladder prices every product and a
     * product's terms are read off one row rather than resolved from a tree.
     *
     * NULLABLE, and null means this product pays NO partner commission — a
     * configured state, not a missing one. A trade on it accrues nothing and
     * `calculate` says so. An account linked to no product AT ALL is the
     * missing case, and that one is REFUSED and retried rather than paid
     * nothing — the money may be owed, and what is missing is a link somebody
     * can restore.
     *
     * `restrict`: a type that products still sell on cannot be deleted. The
     * service names the products in its refusal.
     *
     * `spread_markup_per_lot` stood here until 0140: a commercial record that
     * drove nothing, and the `spread` revenue basis that would have read it.
     * Both went with the percentage-of-revenue model, because a partner's pay
     * is a share of the product's commission type now and never of what the
     * broker earned on the trade.
     */
    commissionTypeId: uuid('commission_type_id').references(() => ibCommissionTypes.id, {
      onDelete: 'restrict',
    }),
    /** The order a client sees them in. Ties broken by name. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /* Max one demo product, enforced where a race cannot slip past it. The
       service's readable refusal is the message; this is the guarantee. */
    uniqueIndex('trading_products_single_demo_uq')
      .on(t.type)
      .where(sql`${t.type} = 'demo'`),
    /* "Which products are sold on this type?" — asked before a type may be
       deleted or disabled, to name them in the refusal. */
    index('trading_products_commission_type_idx').on(t.commissionTypeId),
  ],
);

export const tradingProductGroups = pgTable(
  'trading_product_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => tradingProducts.id, { onDelete: 'cascade' }),
    environment: tradingEnvironmentEnum('environment').notNull(),
    /**
     * The MT5 group path. Sized to match `trading_accounts.mt5_group`.
     *
     * Validated against what the server actually reports when an operator picks
     * it — the bridge lists real groups, so a typo is caught on the settings
     * screen rather than at a client's first account open.
     */
    mt5Group: varchar('mt5_group', { length: 100 }).notNull(),
    /**
     * Cached from MT5 at assignment, and NOT the authority.
     *
     * The group's currency lives on the server and can be changed there without
     * telling us. This column exists so the picker can order and label without
     * a bridge round trip; anything a client is shown re-reads it live.
     */
    currency: varchar('currency', { length: 10 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * ONE product per group, platform-wide.
     *
     * Two products claiming the same group would make "which product is this
     * account under" unanswerable from the account — and that question is what
     * decides whose commission it pays.
     */
    unique('trading_product_groups_group_unique').on(t.mt5Group),
    /* One group per product per environment per currency: offering a client two
       rows that both say "Standard · USD · demo" is a choice with no meaning. */
    unique('trading_product_groups_slot_unique').on(t.productId, t.environment, t.currency),
    index('trading_product_groups_product_idx').on(t.productId),
  ],
);

export const agencies = pgTable('agencies', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** وكالة — the package a partner is appointed under. */
  name: varchar('name', { length: 80 }).notNull().unique(),
  /** Read by an applicant deciding which one to request. Worth writing well. */
  description: text('description'),
  /**
   * A disabled agency stops accepting APPLICATIONS and keeps its partners.
   *
   * Same reasoning as the product above, one level up: closing a programme to
   * new partners is routine, and expelling the partners already in it is not
   * the same act.
   */
  enabled: boolean('enabled').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  /*
   * ── `defaultProgramId` IS GONE (0112) ────────────────────────────────────
   *
   * It named the commission programme partners of this agency were appointed
   * on, so a broker running Gold and Standard agencies did not have to remember
   * which terms went with which on every approval.
   *
   * Terms come from a partner's LEVEL in the tree now, and a level is derived
   * from where they sit rather than chosen — so there is nothing for an agency
   * to default. An agency still bounds what a partner may SELL through
   * `agency_products`; it no longer has an opinion about what they are paid.
   */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agencyProducts = pgTable(
  'agency_products',
  {
    agencyId: uuid('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    /*
     * `restrict`, deliberately asymmetric with the cascade above. Deleting an
     * AGENCY is a decision about a programme and takes its own rows with it;
     * deleting a PRODUCT an agency still sells is a mistake, and the partners
     * beneath it would silently lose what they were appointed to sell.
     */
    productId: uuid('product_id')
      .notNull()
      .references(() => tradingProducts.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.agencyId, t.productId] }),
    index('agency_products_product_idx').on(t.productId),
  ],
);

/** A trading account an operator has suspended stops accepting transfers. */
export const tradingAccountStatusEnum = pgEnum('trading_account_status', [
  'active',
  'suspended',
  'closed',
]);

/**
 * A way a client can put money in.
 *
 * Rows, not a hardcoded list. The deleted deposit page carried a two-element
 * `METHODS` array in the component, so adding one was a deploy and the operator
 * could not turn one off when a provider went down.
 *
 * ## `enabled` is the ONE decision this table records
 *
 * Every other column IDENTIFIES the method — its key, what to call it, what it
 * settles in, what mark to show beside it. The operator's actual choice is
 * whether clients are offered it at all, and that is a boolean they flip from
 * the admin console the moment a provider goes down.
 *
 * ## `kind` is GONE, and is not to come back as a column
 *
 * Dropped in migration 0043. It claimed to say how a method behaved — manual,
 * gateway, crypto — but that is a fact about the CODE, not about the row: it is
 * whether a gateway implementation exists for that key. Every reader had already
 * stopped trusting it (`PaymentMethodsService.effectiveKind` overrode the stored
 * value on each read, because the seeded Whish row said `manual` while the Whish
 * gateway existed), and a column every reader overrides is a second copy of an
 * answer, kept only long enough to disagree.
 *
 * `PaymentGateways.isImplemented(key)` is the answer now. The rule the old enum
 * carried survives it, and still applies: a SCREEN must not branch on
 * `key === 'whish'` — the API tells the portal what happened by returning a
 * `paymentUrl` or not, so adding a provider stays a case in one switch.
 */
export const paymentMethods = pgTable(
  'payment_methods',
  {
    /** A stable machine key — 'whish'. Never renamed. */
    key: varchar('key', { length: 40 }).primaryKey(),
    name: varchar('name', { length: 80 }).notNull(),
    currency: varchar('currency', { length: 10 })
      .notNull()
      .references(() => currencies.code, { onDelete: 'restrict' }),
    /** Sized for a real URL, like `platform_links.url` and for the same reason. */
    logoUrl: varchar('logo_url', { length: 2048 }),
    /*
     * ── `pay_to`, `instructions`, `min_amount` and `max_amount` are GONE ─────
     *
     * Dropped in migration 0042. The admin surface is now key, name, logo and an
     * enable/disable toggle, so nothing wrote to them.
     *
     * WHAT WENT WITH THEM, stated because it is a real capability and not a
     * tidy-up: `pay_to` was the account number and `instructions` the transfer
     * notes a MANUAL method showed the client. Without them a manual deposit
     * gives a reference and no destination — which is fine while the platform
     * runs the GATEWAY flow, where the client is redirected and never sees an
     * account number, and is not fine the day a bank transfer is offered again.
     *
     * If manual deposits return, so do these columns — and with them the rule
     * they used to carry: a manual method with no destination is NOT OFFERED.
     * That rule existed because "inventing an IBAN is the same failure as the
     * fake $0.00 balances, with a worse outcome: the money leaves and does not
     * arrive."
     *
     * The bounds are no loss. `PaymentMethodsService.withEffectiveBounds`
     * reports the platform-wide floor and ceiling on every method, which is what
     * makes the limits identical across them, and `requestDeposit` enforces it.
     */
    /*
     * OFFLINE: the client pays outside the system and uploads a receipt.
     *
     * The flag, not a hardcoded key, is what makes an offline method ordinary
     * configuration — `deposits.ts` in the portal states the rule after `kind`
     * was dropped in 0043: a screen that branches on a method KEY needs editing
     * every time a method is added. Adding OMT beside a bank transfer is a row
     * in this table.
     *
     * Three things read it: the portal shows the receipt control, the JSON
     * `POST /payments/deposits` REFUSES the method (so no proofless row can be
     * filed through the gateway door), and the multipart offline route requires
     * it. A gateway method with this flag set would be refused on both doors,
     * which is the correct answer to a contradictory configuration.
     */
    requiresProof: boolean('requires_proof').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('payment_methods_enabled_sort_idx').on(t.enabled, t.sortOrder)],
);

/**
 * The rails a client may be PAID OUT through — migration 0062.
 *
 * ## Why this is not `payment_methods`
 *
 * A deposit method and a withdrawal method look alike and are not the same
 * thing. `payment_methods` describes how money comes IN: it carries a currency,
 * it is what `requestDeposit` reads to choose gateway-versus-manual, and its
 * rows are wired to Rival's provider keys. Paying OUT asks a different question
 * — what destination the client must supply, and whether the desk will send to
 * that rail today — and the two answers move independently. A shared table with
 * a `direction` column would mean enabling a deposit rail silently enables a
 * payout rail, which is a mistake discovered when money leaves.
 *
 * ## No admin surface, deliberately
 *
 * Seeded (Whish Money) and edited with SQL. The set is one row and changes at
 * the pace of commercial agreements rather than operations, and a CRUD screen
 * for a single row is a screen that exists to be wrong. `enabled` takes a rail
 * out of service without deleting history — which the RESTRICT on
 * `transactions.withdrawal_method_key` also enforces.
 */
export const withdrawalPaymentMethods = pgTable(
  'withdrawal_payment_methods',
  {
    /** A stable machine key — 'whish'. Never renamed; it is written onto rows. */
    key: varchar('key', { length: 40 }).primaryKey(),
    name: varchar('name', { length: 80 }).notNull(),
    /**
     * Sized for a real URL, like `payment_methods.logo_url`.
     *
     * NULL is legitimate: the portal renders a generic wallet mark for it, so a
     * rail is never blocked on artwork. The seed leaves it null rather than
     * pointing at a file nobody has uploaded — a broken image reads as a bug,
     * while the fallback reads as a method without a logo.
     */
    logoUrl: varchar('logo_url', { length: 2048 }),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('withdrawal_payment_methods_enabled_sort_idx').on(t.enabled, t.sortOrder)],
);

/**
 * WHAT a wallet is FOR — `wallets.kind`.
 *
 * `main` is the client's money: what a deposit credits, what a withdrawal is
 * paid from, and what moves to a trading account. Every wallet that existed
 * before this column is one.
 *
 * `commission` holds a PARTNER's earnings and nothing else. Only the commission
 * confirm loop credits it, and the only way out is
 * `IbWalletService.transferToMain` — which lands in the `main` wallet of the
 * same currency, where the ordinary withdrawal and transfer rails already work.
 *
 * ## Why a second wallet rather than a filter over the ledger
 *
 * "What have I earned as a partner" was answerable before this: sum the
 * `commission`/`rebate`/`payout` entries in the main wallet. What was NOT
 * answerable is "what have I earned and not yet moved", because the moment a
 * commission credit landed in the main wallet it was indistinguishable from a
 * deposit — one balance, two meanings, and a partner reconciling their earnings
 * against their own records had to subtract their own deposits by hand.
 *
 * Separating the BALANCE is what makes the second question a read. It also
 * makes the first one survive a transfer out: the earnings total keeps summing
 * commission entries, which the transfer does not write, so moving money to the
 * main wallet lowers the commission balance and leaves lifetime earnings alone.
 *
 * ## What this deliberately does NOT do
 *
 * A commission wallet cannot be deposited to, withdrawn from, or transferred to
 * a trading account. Those rails all resolve `kind: 'main'` and there is no
 * parameter to make them do otherwise — the partner moves the money across
 * first. One extra step, in exchange for every existing money path continuing
 * to mean exactly what it meant before this column existed.
 */
export const walletKindEnum = pgEnum('wallet_kind', ['main', 'commission']);

/**
 * Money the platform holds for a client.
 *
 * One per client per currency PER KIND, opened for every ENABLED currency at
 * registration (`main` only — a commission wallet is opened lazily, the first
 * time a partner is actually paid). `available = balance − on_hold` is what a
 * client may actually move; `wallets_hold_within_balance` makes a hold
 * exceeding the balance a constraint violation rather than a state the
 * arithmetic has to survive.
 */
export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /**
     * The human handle — 12 lowercase Crockford base32 characters (no i/l/o/u),
     * minted by the `wallet_number()` DB function (migration 0090) as a column
     * DEFAULT so every INSERT gets one, including the set-based
     * `openForAllClients` backfill no application generator could reach.
     *
     * DISPLAY ONLY. The uuid stays the key everywhere money depends on one:
     * every FK, and the `ledger_entries_wallet_reference_uq` idempotency
     * guarantee, key on `id`. Nothing may join or dedupe on this column.
     */
    walletNumber: varchar('wallet_number', { length: 12 })
      .notNull()
      .default(sql`wallet_number()`),
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
    /**
     * What this wallet is FOR — see `walletKindEnum`.
     *
     * Defaulted to `main` so every existing row is one and the backfill is the
     * default rather than a migration script. It also means a caller that does
     * not know about this column keeps writing main wallets, which is what the
     * whole system did before — a new kind must be asked for explicitly, never
     * arrived at by omission.
     */
    kind: walletKindEnum('kind').notNull().default('main'),
    /**
     * What this wallet is CALLED: "USD Wallet", "Commission Wallet".
     *
     * GENERATED by the database from `currency` and `kind` (migration 0132), not
     * written by any caller. Three separate paths insert wallets — two in
     * `WalletService` and the set-based `openForAllClients` backfill that no
     * application generator can reach — so a plain column would need all three
     * to remember, and the one that forgot would produce a nameless wallet
     * nobody notices until it is on a client's screen. It is the same reasoning
     * that makes `wallet_number` a column DEFAULT.
     *
     * READ ONLY from Drizzle's point of view: Postgres refuses an INSERT or
     * UPDATE that names a generated column, so this is never in a `.values()`
     * or a `.set()`. The type carries that — it is selectable and nothing else.
     *
     * The stored text is ENGLISH and canonical: what an operator greps for and
     * what a CSV export carries. The apps translate for display, because
     * freezing one language into the database makes the column wrong for every
     * other reader (Arabic is a supported locale, FSD §10).
     */
    name: varchar('name', { length: 60 })
      .generatedAlwaysAs(
        sql`CASE "kind" WHEN 'commission' THEN 'Commission Wallet' ELSE "currency" || ' Wallet' END`,
      )
      .notNull(),
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
     * One wallet per user per currency PER KIND, in the DATABASE.
     *
     * "Open a wallet if they have none" is a read-then-insert, and two
     * concurrent registrations — or one retried request — otherwise leave a
     * client with two USD wallets and a balance split across them, which reads
     * on screen as money going missing. The insert expects this conflict and
     * treats it as success.
     *
     * `kind` joined the key rather than replacing anything: a partner
     * legitimately holds a main USD wallet AND a commission USD wallet, so the
     * old two-column key would have refused the second one. Every upsert that
     * targets this index had to grow the third column with it — a conflict
     * target that does not match a unique index is not a compile error, it is
     * a runtime `ON CONFLICT` failure on a money path.
     */
    uniqueIndex('wallets_user_currency_kind_uq').on(t.userId, t.currency, t.kind),
    /*
     * The real collision guarantee for `wallet_number` — the generator's retry
     * loop is best-effort; this is what makes two wallets sharing a number
     * impossible rather than unlikely.
     */
    uniqueIndex('wallets_wallet_number_uq').on(t.walletNumber),
    check('wallets_wallet_number_format', sql`${t.walletNumber} ~ '^[0-9a-hjkmnp-tv-z]{12}$'`),
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
    /**
     * What the CLIENT calls this account, in the portal.
     *
     * Chosen when the account is opened and editable afterwards. The same value
     * is pushed to MT5 as the account holder's name so the terminal and the
     * portal agree — but THIS column is the one the portal reads, because a
     * screen that had to ask the bridge for a label would go blank whenever MT5
     * was unreachable, and a name is not worth that coupling.
     *
     * NULLABLE, which is the honest default rather than a convenience: every
     * account opened before this column existed has no name, and inventing one
     * ("Account 5001234") would be indistinguishable from a name a client
     * actually chose. The portal falls back to the login — what it showed
     * before, and what every statement already carries.
     */
    name: varchar('name', { length: 128 }),
    mt5Group: varchar('mt5_group', { length: 100 }),
    /**
     * The product this account was opened UNDER, snapshotted at creation (0080).
     *
     * Not derived. `TradingService` used to answer "which product is this" by
     * joining `mt5_group` against `trading_product_groups` at read time, and
     * that join reports the catalogue as it stands NOW rather than as it stood
     * when the client chose. Detaching a group from a product, re-pointing it at
     * a different one, or renaming it on the MT5 server each rewrites the answer
     * for every account already in it — silently, with no trace on the rows
     * themselves. This column is what makes the client's own choice survive an
     * operator editing the catalogue afterwards.
     *
     * NULLABLE, and NULL is a real state rather than a gap. An operator may open
     * an account directly into any MT5 group, including one the catalogue does
     * not sell, so an account can legitimately have no product. The read-time
     * join is kept as a FALLBACK for rows opened before 0080 — see
     * `PRODUCT_JOIN_ON` — because dropping it would regress every existing
     * account's card to "no product".
     *
     * ON DELETE SET NULL, the other direction of the rule `trading_products`
     * already states: retiring a product must never reach into accounts that are
     * already open. A deleted product leaves its accounts trading and
     * product-less; it must not be undeletable, and must not cascade.
     */
    productId: uuid('product_id').references(() => tradingProducts.id, { onDelete: 'set null' }),
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
     * A MIRROR of MT5's cash balance. MT5 is the authority; nothing here
     * computes it (0081).
     *
     * ── The reversal this column was waiting for ───────────────────────────
     *
     * It used to be a CRM-OWNED number, and this comment used to say that was
     * temporary: "WHEN THE BRIDGE LANDS: this becomes a mirror of MT5's balance,
     * written only by the sync … What it must NOT do is stay a CRM-owned number
     * that MT5 also has an opinion about — two numbers for one balance is the
     * state the original design existed to prevent." The bridge landed and this
     * is that change.
     *
     * ── Why arithmetic here could never have stayed right ──────────────────
     *
     * `TransfersService` computed `balance ± amount` itself. That is exact for
     * an account that does nothing else, and every real trading account does
     * something else: swap is charged overnight, commission on every fill, and
     * profit and loss move the balance on every close. None of it passes through
     * the CRM, so none of it is visible to code doing its own addition — and the
     * copy drifted while still looking authoritative.
     *
     * ── The only writers ───────────────────────────────────────────────────
     *
     * All three are the MT5 boundary, and each stamps `balanceSyncedAt`:
     *
     *   1. the balance operation's own response, so a transfer is correct
     *      immediately rather than at the next sweep;
     *   2. the account snapshot the bridge pushes from its sweep, which is how
     *      trading, swap and dealer operations reach us at all;
     *   3. the live read behind the account detail screen.
     *
     * Anything that adds to this column reintroduces the bug. A transfer records
     * its intent in `ledger_entries` and `transfers`; what the account HOLDS
     * afterwards is MT5's answer, not ours.
     *
     * ── Still no equity, margin or open positions ──────────────────────────
     *
     * Unchanged and non-negotiable. Those are computed from live prices against
     * open trades and move on every tick, so a stored copy is stale the moment
     * it is written — "a fabricated figure beside a real MT5 login is the most
     * expensive kind of wrong number on a trading product". Balance is
     * mirrorable precisely because it only changes on a discrete event.
     */
    balance: numeric('balance', { precision: 28, scale: 8 }).notNull().default('0'),
    /**
     * MT5's CREDIT — bonus the broker granted, mirrored like the balance.
     *
     * Discrete, which is the whole reason it is stored at all. Credit moves when
     * a dealer grants or removes it, exactly as balance moves on a discrete
     * event — unlike equity and margin, which are recomputed from live prices on
     * every tick and are therefore absent from this table by design.
     *
     * It was reaching the CRM already and being discarded: the bridge reads it,
     * `/accounts/:id/live` returns it, and `floating` is literally defined as
     * equity minus balance minus CREDIT. So a client's tradeable position could
     * not be shown on a list without a live MT5 call per row — which is the read
     * this whole mirror exists to avoid.
     *
     * NOT added to any sum. It is not the client's money to withdraw, and a
     * balance figure that quietly included bonus credit would overstate what a
     * withdrawal can pay out. Same rule as `trading_products.spread_markup_per_lot`:
     * recorded, and reading it as spendable is the mistake to guard against.
     */
    credit: numeric('credit', { precision: 28, scale: 8 }).notNull().default('0'),
    /**
     * When MT5 last CONFIRMED the balance above (0081).
     *
     * NULL means never: the figure is the CRM's last word rather than the
     * server's. True for every account opened before the bridge existed, and for
     * any account whose `login` is still NULL — there is nothing to ask MT5
     * about.
     *
     * Not decoration. A mirrored number with no age is indistinguishable from a
     * live one, and that difference is the entire reason for mirroring: the
     * console renders "confirmed 90 seconds ago" differently from "never
     * confirmed", and an operator deciding whether to act on a figure needs to
     * know which they are looking at. `mt5_groups.last_seen_at` carries the same
     * rule for the same reason.
     */
    balanceSyncedAt: timestamp('balance_synced_at', { withTimezone: true }),
    /**
     * ⚠️ DEAD. Nothing has ever written this column, and nothing reads it now.
     *
     * It was on the client DTO, where it rendered "TYPE —" on every account of
     * every client, and on the admin holdings projection and the trading-account
     * CSV, where it was a `Tier` header above a column of blanks. All three are
     * gone: `product_id` above is the real answer to "what kind of account is
     * this", so a second, permanently-empty field beside it teaches an operator
     * that our data is missing rather than that the field is meaningless.
     *
     * NOT dropped. A migration to remove it buys nothing — there is no data in
     * it and no query touches it — and DROP COLUMN is the one direction that
     * cannot be undone. Left inert and labelled, so the next person to find it
     * does not wire it up thinking it was an oversight.
     *
     * Do NOT give it a writer. There is no concept in this domain that `product`
     * does not already carry; a tier would be a second name for the same thing
     * and the two would eventually disagree.
     */
    tier: varchar('tier', { length: 50 }),
    leverage: integer('leverage'),
    status: tradingAccountStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('trading_accounts_user_idx').on(t.userId),
    /* "Every account on this product" — what an operator asks before retiring
       one, and what the FK's SET NULL sweeps on a delete. */
    index('trading_accounts_product_idx').on(t.productId),
    uniqueIndex('trading_accounts_login_uq')
      .on(t.login)
      .where(sql`${t.login} IS NOT NULL`),
    /*
     * ONE name per client, and the client is the scope.
     *
     * The name is how somebody tells their own accounts apart — that is the
     * entire job it does — so two accounts called "Swing trading" under one
     * client is the state that makes it useless. Not globally unique: two
     * different clients naming an account the same thing is not a collision,
     * because neither ever sees the other's.
     *
     * CASE-INSENSITIVE, because "Swing trading" and "swing trading" are the same
     * name to the person reading a list of them, and a rule that lets one
     * through delivers exactly the confusion it exists to prevent.
     *
     * PARTIAL on `name IS NOT NULL`, matching the login index directly above and
     * for the same reason: every account opened before 0076 has no name, NULL
     * means unnamed rather than named-nothing, and Postgres would treat multiple
     * NULLs as distinct anyway. Stating it keeps the intent readable.
     *
     * The service checks this before calling MT5 as well, and that is not
     * redundant. The check is what produces a message a client can act on; this
     * is what makes it TRUE under a double submit, where a check-then-insert
     * races itself.
     */
    uniqueIndex('trading_accounts_user_name_uq')
      .on(t.userId, sql`lower(${t.name})`)
      .where(sql`${t.name} IS NOT NULL`),
    /*
     * NO non-negative check, and its absence is deliberate (0082).
     *
     * One existed while `balance` was a CRM-owned number that only
     * `TransfersService` moved. Since 0081 the column MIRRORS MT5, and MT5 has
     * no such rule: an account stopped out through a gap, or one whose overnight
     * swap exceeded its cash, carries a real debit. The CHECK turned those into
     * a failed sync and a console showing the last non-negative figure for ever.
     *
     * `wallets_balance_non_negative` stays, and the difference is authorship
     * rather than taste: a wallet is a ledger the CRM owns, where a negative
     * balance means the money rules leaked. Constrain what you own; mirror what
     * you do not.
     */
  ],
);

/**
 * Closed deals ingested from MT5, one row per MT5 ticket.
 *
 * ── The ticket is the idempotency key, and it is the PRIMARY one ────────────
 *
 * ARCHITECTURE §3.1 delivers every deal TWICE by design: the bridge pushes it
 * live and a sweep re-reads a rolling 24-hour window every five minutes, because
 * "push alone loses deals under network partition, and a lost deal is an unpaid
 * partner". So the second delivery is not an error to be logged — it is the
 * guarantee working, and it must be a no-op.
 *
 * `mt5_deal_id` is therefore UNIQUE and the ingestion writes with
 * `onConflictDoNothing`. Nothing here dedupes in application code, because a
 * check-then-insert races itself the moment push and sweep land together.
 *
 * ── Why the numbers are stored and not computed ────────────────────────────
 *
 * Profit, commission and swap are what the partner commission engine is paid
 * on. They arrive as decimal STRINGS from the bridge — converted once, at the
 * MT5 boundary, from the doubles the Manager API deals in — and land in NUMERIC
 * columns unchanged. Nothing in this codebase recomputes them from price and
 * volume: the broker's server is the authority on what a deal earned.
 *
 * ── `login`, not a user id ─────────────────────────────────────────────────
 *
 * A deal names an MT5 login, and the mapping to a client lives in
 * `trading_accounts.login`. Resolved at read time rather than stored, because a
 * deal that arrives before its account has been linked would otherwise be
 * orphaned forever — and that ordering is normal during onboarding.
 */
export const mt5Deals = pgTable(
  'mt5_deals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** MT5's ticket. The natural key, and what makes re-delivery a no-op. */
    mt5DealId: varchar('mt5_deal_id', { length: 50 }).notNull(),
    /** The MT5 login this deal belongs to — joined to trading_accounts.login. */
    login: varchar('login', { length: 50 }).notNull(),
    mt5OrderId: varchar('mt5_order_id', { length: 50 }),
    mt5PositionId: varchar('mt5_position_id', { length: 50 }),
    symbol: varchar('symbol', { length: 50 }).notNull(),
    /**
     * MT5's own numeric action and entry, stored raw.
     *
     * Not translated into an enum here. MT5 adds values across server builds,
     * and an enum that does not know the newest one turns an unrecognised deal
     * into a failed insert — losing exactly the deal somebody needs to explain.
     */
    action: integer('action').notNull(),
    entry: integer('entry').notNull(),
    volume: numeric('volume', { precision: 28, scale: 8 }).notNull(),
    price: numeric('price', { precision: 28, scale: 8 }).notNull(),
    profit: numeric('profit', { precision: 28, scale: 8 }).notNull(),
    commission: numeric('commission', { precision: 28, scale: 8 }).notNull(),
    swap: numeric('swap', { precision: 28, scale: 8 }).notNull(),
    comment: text('comment'),
    /** When MT5 says it happened — NOT when we ingested it. */
    dealtAt: timestamp('dealt_at', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
    /** 'push' or 'sweep' — which path won the race. Useful when one is broken. */
    source: varchar('source', { length: 20 }).notNull().default('push'),
    /**
     * When the commission engine finished with this deal — NULL means it has
     * not looked at it yet.
     *
     * ── A marker column rather than a LEFT JOIN, and the reason is the deals
     * that accrue NOTHING ──────────────────────────────────────────────────
     *
     * "Which deals still need accruing" cannot be answered by the absence of an
     * `ib_accruals` row, because most deals legitimately produce none: a client
     * nobody referred earns nobody anything, and a balance operation is not a
     * trade. Those rows would come back on every single run, forever, and the
     * work queue would grow without bound while looking like it was draining.
     *
     * So this records that the engine DECIDED, not that it paid. Set for a deal
     * that accrued and for one that correctly accrued nothing — the two are the
     * same to a queue, and separating them is what `ib_accruals` is for.
     *
     * ── Deliberately NOT set for an orphan ────────────────────────────────
     *
     * A deal whose login matches no `trading_accounts` row is left NULL, so it
     * is retried. That ordering is normal during onboarding, and it is the
     * mechanism behind the promise in `Mt5DealsService`: a deal ingested before
     * its account was linked accrues as soon as the link exists, with no
     * backfill and no replay.
     */
    commissionProcessedAt: timestamp('commission_processed_at', { withTimezone: true }),
    /**
     * How many times the engine tried this deal and failed (0092).
     *
     * A failure is not a reason to consider a deal finished — the money is
     * still owed — so a refused deal must come back. What it must NOT do is
     * come back on the very next run, forever, from the FRONT of an
     * oldest-first queue: one batch's worth of permanently-refusing deals and
     * no payable deal is ever reached again.
     *
     * This is the count the backoff is computed from, and the number that
     * distinguishes "a database blip a minute ago" from "a rate nobody has
     * fixed in three days".
     */
    commissionAttempts: integer('commission_attempts').notNull().default(0),
    /**
     * Not before this instant — NULL means eligible now.
     *
     * Deliberately not a "give up" flag. A refusal is a settings mistake with a
     * human fix, and the deal pays in full once that fix lands; capping the
     * retries would turn a wrong rate into permanently lost commission. The
     * backoff only ever makes a stuck deal CHEAP, never abandoned.
     */
    commissionRetryAfter: timestamp('commission_retry_after', { withTimezone: true }),
    /**
     * Why it last failed, so a stuck row can be diagnosed from the row.
     *
     * The log line that named the reason has usually rotated away by the time
     * anybody asks why a partner is short — and "which deals are stuck, and on
     * what" is a question the deals table should be able to answer by itself.
     */
    commissionLastError: text('commission_last_error'),
  },
  (t) => [
    uniqueIndex('mt5_deals_deal_id_uq').on(t.mt5DealId),
    // The commission engine reads by login over a period; the sweep re-checks
    // by time. Both are covered without a scan.
    index('mt5_deals_login_dealt_idx').on(t.login, t.dealtAt),
    index('mt5_deals_dealt_idx').on(t.dealtAt),
    /*
     * The accrual queue's own index, and PARTIAL on purpose.
     *
     * The unprocessed set is small and drains continuously; the processed set
     * grows without bound for the life of the broker. A full index on
     * `commission_processed_at` would be almost entirely rows the queue query
     * can never return, and would keep growing while the thing it exists to
     * make fast stays the same size.
     *
     * `dealt_at` alone, and 0092 deliberately left it that way. Leading with
     * `commission_retry_after` looks right and is not: the gate is `IS NULL OR
     * <= now()`, and two ranges of one index is a bitmap scan and a SORT, where
     * this gives an ordered scan that stops at `limit` — the whole reason a
     * bounded oldest-first batch is cheap. The retry gate is a row filter.
     */
    index('mt5_deals_unaccrued_idx')
      .on(t.dealtAt)
      .where(sql`${t.commissionProcessedAt} IS NULL`),
    /*
     * The POSITION lookup, which runs on every closing deal the engine accrues.
     *
     * `unconsumedLegs` asks "every deal on this position that no accrual has
     * taken yet" — filtered by `mt5_position_id` AND `login`, because a position
     * id is unique per SERVER and a cross-account match would pay one client's
     * partner out of another client's trade. Without this the planner reaches
     * for `mt5_deals_login_dealt_idx` and scans every deal that login ever made,
     * discarding all but the handful on the position.
     *
     * Harmless on a small table and quietly quadratic on the real one: deals
     * accumulate for ever (there is no retention on this table, deliberately —
     * it is the audit record), an active account reaches tens of thousands of
     * rows, and this runs once per closing deal. The cost grows with account
     * AGE, so it is invisible in testing and arrives months after launch.
     *
     * Login first: it is the higher-cardinality column here and the one both
     * callers always supply.
     */
    index('mt5_deals_login_position_idx').on(t.login, t.mt5PositionId),
  ],
);

/**
 * The MT5 group catalogue, mirrored — what `GET /groups` reported, last time we asked.
 *
 * ## This is a MIRROR, and the server is still the authority
 *
 * Nothing here decides anything. A group exists because MT5 says so, and the
 * only writer is the sync job. The table exists for two things the live call
 * cannot do, and neither is caching for speed:
 *
 *   1. **Answer when the bridge cannot.** Every group picker used to be a live
 *      round trip — `GET /groups` costs ~4.9s by `mt5-bridge.client.ts`'s own
 *      measurement — so an unreachable MT5 turned a settings screen into an
 *      error rather than a slightly stale list. A stale list an operator can
 *      see, clearly labelled, beats a blank one.
 *
 *   2. **Notice a change.** A live read shows what is true NOW and cannot tell
 *      you it used to be different. A group renamed, deleted, or moved to
 *      another currency underneath a product that is still selling it is
 *      invisible to a call that only ever reads the present — and it is the
 *      failure that opens a client's account into a group that does not exist.
 *      Detecting it requires having written down what was there before, which
 *      is this table.
 *
 * ## A vanished group is MARKED, never deleted
 *
 * `removedAt` is stamped when a sync stops seeing a group the previous one
 * reported. Deleting the row instead would destroy the only evidence that a
 * group backing live accounts ever existed, at exactly the moment somebody
 * needs to explain those accounts — and a group that reappears (a manager
 * account's permissions were changed, which is the common cause) would come
 * back as a brand-new row with no history.
 *
 * ## `currency` is NOT a foreign key to `currencies`
 *
 * Deliberately, and this is the one place that rule bends. Every other currency
 * column in this schema references the table because it denominates money the
 * CRM owns. This one records what an EXTERNAL system reported. A group priced
 * in a currency the CRM has not configured is drift worth seeing in a row, and
 * a foreign key would turn it into a failed sync — losing the whole catalogue
 * to protect a column nobody computes with.
 */
export const mt5Groups = pgTable(
  'mt5_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** The group path exactly as the server spells it, e.g. `real\Standard`. */
    name: varchar('name', { length: 100 }).notNull(),
    /** The group's account currency, as MT5 reports it. */
    currency: varchar('currency', { length: 10 }).notNull(),
    /**
     * The group's default leverage.
     *
     * NULLABLE because MT5 exposes this only as `DemoLeverage`, which is the
     * value the server applies when a create names none. On a live group that
     * is still the default it uses — see `Mt5Client.GetGroupsAsync` — but a
     * zero there means "unset" rather than "1:0", and storing the zero would
     * make an unset group indistinguishable from one with no leverage at all.
     */
    leverageDefault: integer('leverage_default'),
    /** First time any sync saw this group. Never rewritten. */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** The most recent sync that saw it. This is what makes staleness readable. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Set when a sync stopped seeing a group an earlier one reported; cleared if
     * it comes back. NULL means the server reported it on the last successful run.
     */
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => [
    /*
     * CASE-INSENSITIVE, because MT5 is.
     *
     * The server answers `real\Standard` and `Real\Standard` as the same group,
     * and `catalogue.service.ts` already compares group names with
     * `toLowerCase()` for exactly that reason. A plain unique index would let a
     * server that changed its casing between two syncs insert a second row for
     * one group — and then "is this group still there" has two answers.
     */
    uniqueIndex('mt5_groups_name_uq').on(sql`lower(${t.name})`),
    /* "Which groups are live right now" — the picker's own query. */
    index('mt5_groups_present_idx')
      .on(t.name)
      .where(sql`${t.removedAt} IS NULL`),
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
    /**
     * The `withdrawal_payment_methods.key` this went out through — migration 0062.
     *
     * A SEPARATE column from `methodKey` above, which points at a different
     * table and belongs to deposits. One column cannot carry two foreign keys,
     * and widening either reference to tolerate both tables would remove the
     * only thing that makes it meaningful.
     *
     * Nullable: withdrawals written before 0062 have no method to name, and
     * backfilling them would invent a fact about money that already moved.
     * Those rows carry `provider`, which is what the admin list falls back to.
     */
    withdrawalMethodKey: varchar('withdrawal_method_key', { length: 40 }).references(
      () => withdrawalPaymentMethods.key,
      { onDelete: 'restrict' },
    ),
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
    /*
     * The client's RECEIPT for an offline deposit — the bare `<uuid>.jpg`,
     * stored in `DEPOSIT_PROOF_BUCKET` and served from
     * `GET /v1/uploads/deposit-proofs/<file>`.
     *
     * A column rather than a table because exactly one proof exists and it is
     * written WITH the row: an offline method cannot be filed without it, and
     * there is no replace. Everything else about the object — size, sha256,
     * sniffed type, uploader — is already one row away in `stored_objects`, and
     * copying it here would be two answers to one question.
     *
     * NULL on every gateway deposit and every withdrawal. It is the evidence an
     * operator approves against; it is not what authorises the credit, which is
     * why a proofless row can still be settled by somebody who has seen the
     * money arrive.
     */
    proofFilename: varchar('proof_filename', { length: 255 }),
    rejectionReason: text('rejection_reason'),
    /** The admin who decided. No FK — same reasoning as `audit_log.actor_id`. */
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /*
     * ── The Rival columns (migration 0050) ─────────────────────────────────
     *
     * Deposits and withdrawals route through Rival, Loadless's own payments
     * platform — the CRM is a Rival "company", not a Whish merchant. These
     * columns hold Rival's identifiers; `provider_ref` deliberately keeps OUR
     * OX-reference, because the portal's status endpoint matches on it and it
     * doubles as the idempotencyKey a retried create converges on.
     *
     * `rivalExternalId` is the ONLY reliable join key for inbound deposit
     * events: the webhook's `reference` is "whish:<externalId>" and its
     * `transaction.id` is null on pending/failed.
     *
     * `rivalSubmittedAt` is the withdrawal double-create CLAIM. Rival's
     * withdrawal create has no idempotency key, so the claim is taken with a
     * conditional UPDATE before calling out; the reconciler clears an orphaned
     * claim or adopts an unrecorded creation by matching our `crm:<txId>` note.
     *
     * `rivalNeedsAttention` marks rows only a human may resolve — money PAID
     * at Rival against a terminally-failed row, a reversal of settled funds,
     * disagreeing terminal states. No event path ever clears it.
     */
    rivalExternalId: varchar('rival_external_id', { length: 40 }),
    rivalWithdrawalId: varchar('rival_withdrawal_id', { length: 64 }),
    rivalSubmittedAt: timestamp('rival_submitted_at', { withTimezone: true }),
    rivalNeedsAttention: boolean('rival_needs_attention').notNull().default(false),
    /*
     * WHY the row needs a human, in words — written whenever
     * `rival_needs_attention` flips true, cleared when a retry succeeds. The
     * flag alone put an operator in front of a row saying "needs attention"
     * with the reason living only in a log line they cannot see; on a payout
     * queue that reads as "the system is broken", not "the platform refused
     * this submission because X".
     */
    rivalAttentionReason: text('rival_attention_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transactions_user_idx').on(t.userId),
    index('transactions_state_idx').on(t.state),
    index('transactions_created_at_idx').on(t.createdAt),
    uniqueIndex('transactions_provider_ref_uq').on(t.provider, t.providerRef),
    // §6.3 for inbound Rival events: one CRM row per Rival payment/withdrawal,
    // so a replayed or misrouted event can never touch a second row. Partial —
    // manual methods and pre-Rival history carry no Rival identifier.
    uniqueIndex('transactions_rival_external_id_uq')
      .on(t.rivalExternalId)
      .where(sql`${t.rivalExternalId} IS NOT NULL`),
    uniqueIndex('transactions_rival_withdrawal_id_uq')
      .on(t.rivalWithdrawalId)
      .where(sql`${t.rivalWithdrawalId} IS NOT NULL`),
    // The poller's two scans, partial so they index only in-flight rows.
    index('transactions_rival_pending_idx')
      .on(t.state)
      .where(sql`${t.rivalExternalId} IS NOT NULL AND ${t.state} = 'pending'`),
    index('transactions_rival_approved_idx')
      .on(t.state)
      .where(sql`${t.state} = 'approved' AND ${t.rivalSubmittedAt} IS NOT NULL`),
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
    /*
     * ── THE RESUME BACKOFF (0123) ──────────────────────────────────────────
     *
     * `TransferResumeScheduler` drains pending transfers OLDEST FIRST with a
     * LIMIT. Without a backoff a transfer that can never be resumed keeps its
     * place at the head of that queue for ever, and newer pending transfers are
     * never examined at all — not slowly, never. Ten such rows starve the rail.
     *
     * The commission engine met the identical shape and calls it "the worst
     * shape a money job can have" (0092): correct, silent, and worse the busier
     * the platform is. These three columns are that mechanism, copied rather
     * than reinvented — a minute, two, four, up to an hour, then hourly for
     * ever.
     *
     * ⚠️ THE BACKOFF NEVER FAILS A TRANSFER, and that distinction is the whole
     * design. Age is not evidence that money did not move: a transfer pending
     * since yesterday may have credited MT5 on its first attempt and lost only
     * the response, so auto-failing it would release the hold and hand the
     * client their money twice. This changes HOW OFTEN a stuck row is retried
     * and nothing else. A person still decides its end state.
     */
    resumeAttempts: integer('resume_attempts').notNull().default(0),
    resumeAfter: timestamp('resume_after', { withTimezone: true }),
    resumeLastError: text('resume_last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transfers_user_idx').on(t.userId),
    index('transfers_state_idx').on(t.state),
    index('transfers_created_at_idx').on(t.createdAt),
    index('transfers_trading_account_idx').on(t.tradingAccountId),
  ],
);

/**
 * A partner moving earnings from their COMMISSION wallet to their MAIN one.
 *
 * ## Its own table, and not a row in `transfers`
 *
 * `transfers` is wallet ⇄ MT5 trading account. Every column it carries beyond
 * the amount exists because that movement CROSSES A BOUNDARY into a server this
 * platform does not own: `state`, `failure_reason`, `settled_at`, the resume
 * scheduler, and a `trading_account_id` that is NOT NULL. Putting a
 * wallet-to-wallet move in there would mean making that column nullable and
 * teaching every reader that a transfer might have no account — for a movement
 * that has none of the failure modes the column set was built for.
 *
 * This one is entirely inside one database. Both legs are `WalletService.post`
 * calls in a single transaction against two rows of the same table, so it
 * commits or it does not exist. There is no pending state to model, nothing to
 * resume, and no reason a settled one can later fail — which is why this table
 * has no `state` column and its absence is the honest shape rather than a
 * simplification.
 *
 * ## Both wallet ids, stored
 *
 * Not `userId + currency`, from which they could be re-derived: a wallet is a
 * durable row with its own ledger, and recording WHICH rows moved is what lets
 * this be reconciled against `ledger_entries` without repeating the lookup
 * logic — and without that lookup silently resolving differently if the wallet
 * rules ever change.
 */
export const ibWalletTransfers = pgTable(
  'ib_wallet_transfers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The COMMISSION wallet debited. */
    fromWalletId: uuid('from_wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    /** The MAIN wallet credited, same currency and same owner. */
    toWalletId: uuid('to_wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    /** Always positive — the direction is in the column names, not the sign. */
    amount: numeric('amount', { precision: 28, scale: 8 }).notNull(),
    currency: varchar('currency', { length: 10 })
      .notNull()
      .references(() => currencies.code, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ib_wallet_transfers_user_idx').on(t.userId),
    index('ib_wallet_transfers_created_at_idx').on(t.createdAt),
    /*
     * A transfer moves money and can never be zero or negative. The API refuses
     * both first; this is the backstop that makes a bug in that check a failed
     * INSERT rather than a partner's balance moving the wrong way — a negative
     * amount here would be a withdrawal FROM the main wallet dressed as a
     * commission payout.
     */
    check('ib_wallet_transfers_amount_positive', sql`${t.amount} > 0`),
    /* The two legs must be different wallets. Equal ids would post a debit and
       a credit to the same row for the same reference — the second of which the
       ledger's idempotency index absorbs as a replay, leaving a transfer row
       claiming a movement that only happened once, as a debit. */
    check('ib_wallet_transfers_distinct_wallets', sql`${t.fromWalletId} <> ${t.toWalletId}`),
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
    /*
     * The two INVESTIGATION reads — 0124. An incident starts from a person, not
     * from a category: "what did this administrator do" and "what has been done
     * to this client". `subject_id` is composite with `created_at DESC` because
     * one subject is read newest first; the actor's email is searched with a
     * leading wildcard, which no b-tree can serve, so it carries a pg_trgm GIN
     * index declared in the migration (Drizzle has no expression-index form).
     *
     * A third lives only in its migration for the same reason: 0134's
     * `audit_log_client_id_idx`, on `auditRowClientId()` — the client a row is
     * about, wherever the row keeps it — which the Portal ID search reads.
     */
    index('audit_log_subject_id_created_at_idx').on(t.subjectId, t.createdAt.desc()),
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

/*
 * ── `ib_levels` IS GONE (0102), AND SO ARE `ib_payout_model` / `max_direct_partners` (0055) ──
 *
 * There were two catalogues of terms in this schema and the FSD describes one.
 *
 * FR-IB-06 asks for "an administrable catalogue of named IB programs (a tier
 * ladder), each defining a name, ordering position, commission and rebate
 * values, and a mode", and adds that a programme replaces "any per-partner
 * bespoke plan". FR-IB-17 says the per-level split is "configured per the
 * agreed program ladder". One catalogue, named, assigned per partner, carrying
 * the depths.
 *
 * `ib_levels` was a SECOND one, keyed on the rung a partner stood on, and it
 * had already lost the argument: 0084 moved every rate onto programmes and left
 * the ladder holding a `rate_value` that decided nothing, a name, and an
 * `enabled` flag whose only remaining job was to bound the hierarchy.
 *
 * A rung-keyed rate cannot express what the FSD asks for anyway. Every level-1
 * partner is paid identically under it, there is nowhere at all to put a client
 * rebate, and a partner who introduced a client THEMSELVES was paid their rung's
 * override rather than the introducer rate — so recruiting a sub-partner quietly
 * cut what you earned on your own business.
 *
 * `ib_payout_model` went in 0055: the enum offered `revenue_share` and
 * `per_lot`, so one `rate_value` meant 70% under one and $70 per lot under the
 * other. A partner's commission is cut from what the BROKER EARNED on a closed
 * position, which is a percentage by definition. `max_direct_partners` went with
 * it — a cap defaulted to unlimited and never once set.
 */

/**
 * A named IB programme — the terms a partner is paid on. FR-IB-06.
 *
 * The header row. What it PAYS lives in `ib_program_tiers`, one row per depth,
 * because that is the half whose LENGTH varies and a fixed pair of columns
 * cannot hold a ladder whose height is a commercial decision.
 *
 * ## Ordering position, and why it is not decoration
 *
 * FR-IB-06 names it, and one behaviour depends on it: approval places a new
 * partner on the first ENABLED programme by `sortOrder`. An operator who builds
 * Bronze / Silver / Gold decides which of them a new partner lands on by
 * ordering them, and there is no second setting to keep in step.
 */
export const ibProgramModeEnum = pgEnum('ib_program_mode', [
  /** Only the partner is paid. */
  'commission_only',
  /** Only the trading client is paid, and no partner earns. */
  'rebate_only',
  /** Both legs pay. */
  'hybrid',
]);

/**
 * The bases a programme may price on — the same three `common/revenue-basis.ts`
 * has always named, now with a database type behind them (0106).
 *
 * A pgEnum rather than a `varchar` + CHECK because this value reaches the money
 * path: `brokerRevenueFor` switches on it, and a typo that a CHECK would let
 * through as "some other string" has no branch to land in.
 */
/**
 * How a payout leg is priced — migration 0111.
 *
 * `percent` takes a share of the broker's revenue on the trade. `per_lot` pays a
 * flat amount per standard lot and does not care what that trade earned, which
 * is how most retail IB terms are actually quoted.
 *
 * ⚠️ `per_lot` is OUTSIDE the Phase 1 FSD: FR-IB-05 says the rebate is
 * "dynamic, not a fixed per-lot figure" and FR-IB-16 calls the method
 * spread-based. It exists on an explicit business decision — see 0111.
 */
/**
 * How a commission or rebate leg is priced.
 *
 *   `percent`          a share of BROKER REVENUE — see `revenueBasis`.
 *   `per_lot`          money for each standard lot, indifferent to what the
 *                      trade earned.
 *   `share_of_parent`  a percentage of the rate on the level DIRECTLY ABOVE —
 *                      0114, and what "the sub-partner takes 30% of the main
 *                      partner's $10" actually means.
 *
 * The third is a mode rather than a fourth `revenueBasis` because it is not a
 * share of anything the broker earned: it is derived from another level's
 * configuration and exists whether or not the trade made money. `per_lot` set
 * the precedent by being priced from volume rather than revenue.
 */
export const ibPayoutModeEnum = pgEnum('ib_payout_mode', ['percent', 'per_lot', 'share_of_parent']);

export const ibRevenueBasisEnum = pgEnum('ib_revenue_basis', [
  /** MT5's charged commission + swap. The default, and what has always shipped. */
  'commission_swap',
  /** lots × the product's `spread_markup_per_lot`. See the column's warning. */
  'spread',
  /** Both, summed. */
  'commission_swap_spread',
]);

/**
 * The commission ladder — 0112, re-priced in 0140.
 *
 * A partner's terms come from their LEVEL in the partner tree: level 1
 * introduces clients directly, level 2 was recruited by a level 1, and so on.
 * Each level carries one commission share and one rebate share, and both are
 * PERCENTAGES of the product's commission type (`ib_commission_types`).
 *
 * ## What 0140 changed, and what it kept
 *
 * Until 0140 a rung held an ABSOLUTE amount per lot, so the ladder described
 * one product. The amounts moved to the product's commission type, and a rung
 * now says what fraction of that type its partners take — one ladder pricing
 * every product. See `ibCommissionTypes` for the reasoning.
 *
 * The chain walk is UNCHANGED, so both rules the business stated still hold by
 * construction: a sub-partner earns nothing from their parent's own clients
 * (they never appear in that chain), and a parent does earn from clients
 * introduced beneath them. And the rate is still keyed on the earner's own
 * POSITION rather than on the trade's depth — a level 1 partner takes their
 * level 1 share on everything that reaches them, however deep.
 *
 * ## The shares are INDEPENDENT, not carved out of each other (0114's rule)
 *
 * On a sub-partner's client's trade, level 2 takes its share of the product's
 * commission AND level 1 takes its own share in full. The deeper the tree, the
 * more one lot costs the broker — chosen deliberately in 0114 over splitting
 * one figure, because recruiting must not reduce what the main partner earns.
 * A ladder of 100% / 30% reproduces the old "$10 to the main partner, $3 to
 * the sub" exactly on a $10 type; a ladder of 70% / 30% makes the product's
 * figure a hard pool instead. Both are expressible; neither is imposed.
 *
 * ⚠️ This reverses 0102 and deviates from FR-IB-06, which commits to a named
 * programme catalogue. Done on an explicit instruction; see migration 0112.
 */
export const ibLevels = pgTable(
  'ib_levels',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /**
     * The rung, and the whole identity of the row.
     *
     * UNIQUE because a level IS its number — two rows claiming level 2 is a rate
     * card with no defined answer.
     */
    level: integer('level').notNull().unique(),
    name: varchar('name', { length: 80 }).notNull(),
    /** What this tier is FOR, in the desk's words. Nothing computes with it. */
    description: text('description'),
    /**
     * Disabling stops a level paying without deleting the terms that explain
     * accruals already written against it.
     */
    enabled: boolean('enabled').notNull().default(true),

    /**
     * The PARTNER's share of the product's `commission_per_lot`, as a
     * percentage. 12,4 leaves a 2.5% share and a 33.3333% one both intact,
     * and it is a decimal STRING in and out (§6.1) because it multiplies money.
     */
    commissionShare: numeric('commission_share', { precision: 12, scale: 4 })
      .notNull()
      .default('0'),
    /**
     * The CLIENT's share of the product's `rebate_per_lot`, as a percentage —
     * read from the INTRODUCER's rung only, because there is one trading client
     * per trade and they stand in exactly one relationship.
     */
    rebateShare: numeric('rebate_share', { precision: 12, scale: 4 }).notNull().default('0'),

    /*
     * `commission_mode`, `commission_rate`, `commission_amount_per_lot`,
     * `rebate_mode`, `rebate_rate`, `rebate_amount_per_lot` and
     * `revenue_basis` stood here until 0140. The two rate columns were RENAMED
     * into the shares above; the rest were dropped with the modes they served.
     * `ib_payout_mode` and `ib_revenue_basis` survive as enum types because the
     * historical `ib_programs` tables still use them.
     */

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * A share is a fraction of ONE figure on the product, so it cannot exceed
     * the whole of it. NOT NULL on the columns keeps the CHECK-evaluates-to-NULL
     * trap (0111) away from these two.
     */
    check(
      'ib_levels_commission_share_range',
      sql`${t.commissionShare} >= 0 AND ${t.commissionShare} <= 100`,
    ),
    check('ib_levels_rebate_share_range', sql`${t.rebateShare} >= 0 AND ${t.rebateShare} <= 100`),
    /*
     * The STRUCTURAL bound, wider than the policy one. `ib_max_levels` decides
     * how deep a broker actually pays and is a settings change; this only bounds
     * what the column can hold, so raising the policy never needs a migration.
     */
    check('ib_levels_level_range', sql`${t.level} BETWEEN 1 AND 10`),
    /*
     * There is deliberately NO cross-rung sum here. The shares of the rungs in a
     * chain are paid independently (see the header), so their sum is the
     * broker's cost per lot at full depth rather than a fraction that must fit
     * inside 100. What bounds that cost is `ib_max_payout_per_lot`, enforced by
     * `checkPlausible` at accrual time where the lot count is known.
     */
  ],
);

export const ibPrograms = pgTable('ib_programs', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** What an operator picks in a list, and what a partner is told they are on. */
  name: varchar('name', { length: 80 }).notNull().unique(),
  /** FR-IB-06's "ordering position". Lowest first; the first enabled one is the default. */
  sortOrder: integer('sort_order').notNull().default(0),
  mode: ibProgramModeEnum('mode').notNull().default('commission_only'),
  /**
   * What goes back to the TRADING CLIENT, as a % of the same broker revenue.
   *
   * A percentage, not an amount per lot: FR-IB-05 calls for a rebate that is
   * "configurable per program (dynamic, not a fixed per-lot figure)", and
   * per-lot pricing was removed from this system once already (0055) because
   * one column carrying two units is the number nobody can read.
   *
   * On the HEADER rather than in the tiers, because there is exactly one
   * trading client per trade and they stand in exactly one relationship — with
   * their introducer. A rebate per depth would be several different answers to
   * a question that has one.
   */
  rebateRate: numeric('rebate_rate', { precision: 12, scale: 4 }).notNull().default('0'),
  /**
   * Which of `rebateRate` / `rebateAmountPerLot` actually pays — 0111.
   *
   * A CHECK keeps the pair unambiguous: `percent` forbids the amount, `per_lot`
   * requires it. So a reader never has to guess which number is live, and a
   * programme cannot be saved half-switched.
   */
  rebateMode: ibPayoutModeEnum('rebate_mode').notNull().default('percent'),
  /**
   * Money per standard lot returned to the trading CLIENT.
   *
   * NUMERIC(28,8) like every other amount (§6.1), deliberately not the (12,4)
   * that holds a percentage — this is money, and a rebate rounded at four
   * decimals is a rebate that disagrees with the ledger it is paid into.
   */
  rebateAmountPerLot: numeric('rebate_amount_per_lot', { precision: 28, scale: 8 }),
  /**
   * FR-IB-16 — "configure the exact commission and rebate mathematics ...
   * through the IB program catalogue, so that the economics applied at runtime
   * match the agreed, documented method" (0106).
   *
   * It was `trading_settings.ib_revenue_basis` (0101), then a constant when
   * 0104 cleared the IB block off that form. Neither is what the requirement
   * asks for: it names the CATALOGUE as the place, and a constant in a source
   * file is not configured at all.
   *
   * ## Per programme, and that is not a rounding of the requirement
   *
   * The base a rate applies to is half of what a partner agreed to — "30% of
   * the spread markup" and "30% of commission and swap" are different
   * contracts. A platform-wide switch re-prices every partner at once, which is
   * the thing nobody can sign.
   *
   * The broker's revenue on one trade is therefore computed PER EARNER, from
   * their own programme's basis. Two partners in a chain may be paid on
   * different bases, and each is paid what their own contract says.
   *
   * ## ⚠️ Selecting `spread` is IRREVERSIBLE for the deals it touches
   *
   * A product whose `spread_markup_per_lot` is still 0 yields zero revenue, and
   * a zero-revenue deal is MARKED DONE rather than retried — MT5's amounts are
   * final when reported. Switching a programme to `spread` before the markups
   * are populated pays nothing on every deal that follows, permanently, and
   * switching back recovers none of it. Nothing can detect it either: a zero
   * markup is also a legitimate raw-spread product.
   *
   * `commission_swap` is the default for exactly that reason — it is what every
   * deployment already computes on, so this column changed nobody's money on
   * the day it landed.
   */
  revenueBasis: ibRevenueBasisEnum('revenue_basis').notNull().default('commission_swap'),
  /**
   * FR-IB-06's "flagged as selectable" — and it means BOTH halves of that.
   *
   * A disabled programme cannot be assigned to a new partner AND stops paying.
   * A switch that leaves the money flowing is decorative, and an operator who
   * turns terms off means it.
   */
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What a programme pays at each DEPTH — FR-IB-06's "tier ladder", and FR-IB-17's
 * "per-level split ... configured per the agreed program ladder".
 *
 * ## Depth is measured from the CLIENT, not from the broker
 *
 * `depth = 1` is the partner who introduced the trading client; `depth = 2` is
 * that partner's parent, and so on upward. A row here answers "what does the
 * holder of this programme earn when the trade belongs to a client N hops below
 * them" — a property of the TERMS, true wherever in a chain the holder happens
 * to stand.
 *
 * That portability is what the rung-keyed ladder could not say, and the reason
 * this is keyed on depth rather than on a level number.
 *
 * ## The ROW COUNT is how far this programme's earnings reach
 *
 * Three rows means the holder is paid on their own clients, their sub-partners'
 * and their sub-sub-partners', and nothing beyond. One row means their own
 * clients only. There is no separate depth setting that could disagree with the
 * rates, and no constant in a source file: FR-IB-16 asks for the agreed method
 * to be CONFIGURED, and a number a developer edits is not a configuration.
 *
 * `MAX_CHAIN_DEPTH` in the engine is a CYCLE GUARD and nothing else — a
 * self-referencing foreign key cannot be stopped from forming a loop, so the
 * walk needs a stop even when every programme is well formed.
 *
 * ## Each earner reads their OWN programme
 *
 * Two partners in one chain may hold different programmes reaching different
 * depths, and both are honoured: the depth-2 earner is paid by THEIR tier 2,
 * not by the introducer's. Terms are an agreement between the broker and one
 * partner, and letting somebody else's contract decide your rate would make a
 * programme unquotable.
 */
export const ibProgramTiers = pgTable(
  'ib_program_tiers',
  {
    programId: uuid('program_id')
      .notNull()
      /*
       * CASCADE, unlike almost every other reference in this schema.
       *
       * A tier is not a record of something that happened — it is a line of a
       * rate card, meaningless without the card. Deleting the card and leaving
       * its lines behind is the only outcome worse than either.
       *
       * The programme itself is NOT cascaded into: `ib_accounts.program_id` is
       * `restrict`, so a programme partners stand on cannot be deleted at all,
       * and this cascade is only ever reached for one nobody is on.
       */
      .references(() => ibPrograms.id, { onDelete: 'cascade' }),
    /** 1 is the introducer. Bounded to 10 by a CHECK — see `MAX_CHAIN_DEPTH`. */
    depth: integer('depth').notNull(),
    /**
     * The holder's share of the broker's revenue at this depth, as a %.
     *
     * NUMERIC, never a float. §6.1 applies to anything that TOUCHES an amount,
     * not only to amounts themselves: a rate held as a float reintroduces the
     * error the decimal columns exist to prevent, one multiplication later.
     *
     * 12,4 leaves a 2.5% share and a 33.3333% one both intact.
     */
    rate: numeric('rate', { precision: 12, scale: 4 }).notNull().default('0'),
    /**
     * Which column pays at this depth — 0111.
     *
     * `ib_program_tiers_payout_shape` requires exactly the column the mode reads
     * and forbids the other, which is what replaced the old unconditional
     * `rate > 0`: a per-lot tier legitimately carries no rate at all.
     */
    payoutMode: ibPayoutModeEnum('payout_mode').notNull().default('percent'),
    /**
     * Money per standard lot at this depth, independent of what the trade
     * earned. NUMERIC(28,8) — money, not a rate.
     */
    amountPerLot: numeric('amount_per_lot', { precision: 28, scale: 8 }),
  },
  (t) => [
    /*
     * (programme, depth) IS the identity. No surrogate id: a programme paying
     * two different rates at depth 2 is not a row anybody could interpret, and
     * a unique index sitting beside a uuid key is the same rule stated twice.
     */
    primaryKey({ columns: [t.programId, t.depth] }),
    /*
     * `rate > 0`. A tier that pays nothing is not a configured zero, it is a
     * row that should not exist — the ROW COUNT is this programme's reach, so a
     * zero-rate tier at depth 3 claims a reach the programme does not have and
     * makes the depth-4 tier below it unreachable for no stated reason.
     */
    check('ib_program_tiers_rate_positive', sql`${t.rate} > 0`),
    /*
     * Contiguous from 1 is enforced in the SERVICE, not here: a CHECK cannot
     * see the other rows of its own table, and a trigger would put one rule in
     * two places. What a CHECK CAN see is this row, so it carries the bound.
     */
    check('ib_program_tiers_depth_range', sql`${t.depth} BETWEEN 1 AND 10`),
  ],
);

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
    /**
     * The agency (وكالة) being applied for.
     *
     * NULLABLE, and null means "applied before agencies existed". Backfilling
     * the old rows with a guess would put words in an applicant's mouth about
     * the one thing this row records — what they asked for.
     *
     * `restrict` on delete: an agency with applications against it, decided or
     * not, is part of a record somebody may have to justify later.
     */
    agencyId: uuid('agency_id').references(() => agencies.id, { onDelete: 'restrict' }),
    /** Why they want it, in their words. Free text; the reviewer reads it. */
    motivation: text('motivation'),
    /*
     * `expected_volume` was here — self-reported free text, asked on the
     * application form and shown as a column on the review queue.
     *
     * Dropped, not deprecated. It was a number the applicant TYPED, stored as
     * text because it was never measured, and no decision was ever taken from
     * it: the portal stopped asking when the application form was cut back to
     * one choice and one button, so every row written since carries NULL. A
     * column that is null for new rows and unverifiable for old ones is worse
     * than no column — it invites a reviewer to weigh a claim nobody checked.
     */
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
     * `level` IS GONE (0102), and with it the renumber-cascade this column used
     * to need.
     *
     * It named the rung a partner stood on in `ib_levels`, and by 0084 that was
     * the only thing it did — the rate had already moved to their programme.
     * What remains of "where does this partner sit" is `parentIbUserId`, which
     * is the real structure: a partner's DEPTH is a fact about the trade being
     * paid on (how many hops above the client they are), not a number stored
     * against them. Storing both let the two disagree, and one of them was
     * always the one the money used.
     */
    /**
     * The agency this partner was appointed under, and so what they may sell.
     *
     * Their clients are offered this agency's products and nothing else; a
     * client under no partner is offered every enabled product. That is the
     * whole resolution rule, and it lives on this one column.
     *
     * NULLABLE because partners approved before agencies existed have none.
     * Such a partner's clients fall back to the full catalogue rather than to
     * an empty list — the alternative silently stops their clients opening
     * accounts, which is a punishment for an operator's unfinished migration.
     */
    agencyId: uuid('agency_id').references(() => agencies.id, { onDelete: 'restrict' }),
    /**
     * HISTORICAL since 0112 — the programme this partner used to be paid on.
     *
     * Terms come from their LEVEL in the tree now, derived from where they sit
     * rather than assigned, so nothing writes this any more. It is kept and
     * made nullable rather than dropped: it is the only thing that explains how
     * accruals written before the change were priced.
     */
    programId: uuid('program_id').references(() => ibPrograms.id, { onDelete: 'restrict' }),
    /**
     * The partner's rung in the tree, and therefore which `ibLevels` row pays
     * them — 0112.
     *
     * STORED rather than derived. It could be computed by walking
     * `parentIbUserId` to the root, but that is a recursive query per earner per
     * deal on the money path, and the answer only changes when somebody is
     * appointed — which is exactly when it is cheap to write.
     *
     * This column existed before 0102 and went with the old ladder. It is back
     * because terms are chosen by it again.
     */
    level: integer('level').notNull().default(1),
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
    /* The hot read: "who sits under this partner?" — asked on every approval to
       place a new partner, on every sub-tree earnings roll-up (FR-IB-17), and
       once per hop by the commission engine's chain walk. */
    index('ib_accounts_parent_idx').on(t.parentIbUserId),
    /* "Who stands on this rung?" — asked before a level may be disabled or
       deleted, to report its partner count beside it, and to ORDER the partner
       list by level (R-2.5). Replaces the programme index below in every one of
       those roles; that one is kept only while `program_id` still explains
       historical accruals. */
    index('ib_accounts_level_user_idx').on(t.level.desc(), t.userId.desc()),
    /* HISTORICAL (0112). Nothing decides pay from this any more — see the
       column comment — but a lookup by it is how a pre-0112 accrual is
       explained. */
    index('ib_accounts_program_idx').on(t.programId),
    /* "Which partners are on this agency?" — asked before an operator is
       allowed to delete or disable one. */
    index('ib_accounts_agency_idx').on(t.agencyId),
  ],
);

/**
 * What a partner has earned, one row per earner per revenue event.
 *
 * ## Why an accruals table rather than crediting the wallet directly
 *
 * A commission is EARNED at one moment and PAYABLE at another. Crediting the
 * wallet the instant a deposit lands would make every commission irreversible
 * before the revenue it is a share of has settled — and a deposit later
 * reversed would leave a partner holding money that can only be recovered by a
 * compensating entry with no record of what it compensates.
 *
 * So: `pending` on accrual, `confirmed` once credited, `reversed` when the
 * underlying revenue is undone. The ROW is the record; the wallet credit is a
 * consequence of it, and `ledgerEntryId` ties the two so neither can be
 * reconciled without the other.
 *
 * This is the table migration 0028 deleted as `commission_accruals`. It is NOT
 * a restore: that one keyed off `deals` and `ib_programs`, both gone with the
 * MT5 bridge. This one keys off whatever moved the money — `sourceType` /
 * `sourceId` — and takes its rate from `ib_levels`.
 */
/**
 * WHO an accrual is owed to.
 *
 * A rebate is produced by the same trade as the commission beside it, matures
 * through the same settlement window, and must be exactly as idempotent — so it
 * is a row here with a different beneficiary at confirmation, rather than a
 * second table carrying its own copy of all three properties.
 *
 * On a `rebate` row `ibUserId` is the partner whose programme PRODUCED it — the
 * attribution — and `clientUserId` is who gets paid.
 */
export const ibAccrualKindEnum = pgEnum('ib_accrual_kind', ['commission', 'rebate']);

export const ibAccrualStatusEnum = pgEnum('ib_accrual_status', [
  'pending',
  'confirmed',
  'reversed',
]);

/**
 * ONE PAYOUT RUN's worth of accruals, credited to one wallet as one entry.
 *
 * ## Why this table exists (0116)
 *
 * Commission confirms every minute since 0113. Keyed per accrual, that wrote
 * one ledger row per closed trade per earner — 252 rows across four wallets in
 * a day of testing — and a client's wallet history became an unreadable column
 * of two-dollar credits. At real volume it is thousands a day, on the one
 * screen a client uses to account for their own balance.
 *
 * ## ⚠️ `ib_accruals` STILL HOLDS ONE ROW PER TRADE
 *
 * This changes how money is WRITTEN, not what is KNOWN. The per-trade rows are
 * the audit trail — which trade paid what, at which rate, on which rung — and
 * they are what makes an individual dealer-cancelled trade reversible. Merging
 * those too would buy a tidier ledger by destroying the record that explains it.
 *
 * A reversal is unaffected: `reverseAccrual` posts a compensating `adjustment`
 * rather than editing the credit, because `ledger_entries` is append-only. A
 * small negative row beside a large positive one is exactly how a ledger
 * records a partial correction.
 */
export const ibAccrualBatches = pgTable(
  'ib_accrual_batches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /*
     * The WALLET, not the user, is the grouping key. A partner who is also a
     * client earns commission into their commission wallet and rebates into
     * their main one, and those must never merge into one credit.
     */
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id, { onDelete: 'restrict' }),
    kind: ibAccrualKindEnum('kind').notNull(),
    currency: varchar('currency', { length: 10 })
      .notNull()
      .references(() => currencies.code, { onDelete: 'restrict' }),
    /** The sum credited. A decimal string end to end (§6.1) — never a float. */
    amount: numeric('amount', { precision: 28, scale: 8 }).notNull(),
    /*
     * How many accruals this covers. STORED rather than counted on read: it is
     * what the client's transaction line says ("Commission · 40 trades"), and a
     * COUNT over a growing table to render a label is a query nobody should pay.
     */
    accrualCount: integer('accrual_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ib_accrual_batches_wallet_idx').on(t.walletId, t.createdAt)],
);

export const ibAccruals = pgTable(
  'ib_accruals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** The partner who earned it. */
    ibUserId: uuid('ib_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The client whose activity generated it — who this is owed BECAUSE of. */
    clientUserId: uuid('client_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /**
     * What moved the money. `'transaction'` today; a deal feed adds its own.
     *
     * A varchar rather than an enum because the set grows with every new revenue
     * source, and adding a string is not a migration where an enum value is.
     * Paired with `sourceId` it is the idempotency key — see the unique index.
     */
    sourceType: varchar('source_type', { length: 50 }).notNull(),
    sourceId: uuid('source_id').notNull(),
    /**
     * How far above the client this partner sat: 1 is the introducer, 2 their
     * parent. STORED, because the chain can be reassigned later and an accrual
     * must stay explainable against the hierarchy as it was when earned.
     */
    depth: integer('depth').notNull(),
    /**
     * The programme that paid it — FR-IB-06's terms, named on the row.
     *
     * Replaces `level` (0102), which recorded the rung a partner stood on back
     * when a rung decided a rate. It had not decided one since 0084, so the
     * column preserved an answer to a question nobody could still ask, while
     * WHICH TERMS PAID THIS was recoverable only by reading the partner's
     * current programme — the one thing that may have changed since.
     *
     * `restrict` on delete, and it is what makes the accrual self-explanatory:
     * with `programId`, `depth` and `rateValue` on the row, a disputed payout is
     * settled from the row alone. Without it, `rateValue` is a number with no
     * stated source.
     *
     * NULLABLE only because 0102 backfilled rows accrued before this column
     * existed, and could recover the programme for a partner who still holds
     * one. Everything written since is NOT NULL in practice; a NULL here means
     * "accrued before the column existed", never "paid by no terms".
     */
    programId: uuid('program_id').references(() => ibPrograms.id, { onDelete: 'restrict' }),
    /**
     * Which LEVEL's terms produced this accrual — 0112.
     *
     * A row carries exactly one of this and `programId`: whichever priced it.
     * Together they keep the guarantee this table has always made — that the
     * arithmetic behind a credited amount is reproducible from the row alone.
     */
    levelId: uuid('level_id').references(() => ibLevels.id, { onDelete: 'restrict' }),
    /**
     * WHICH COMMISSION TYPE's amounts this is a share of — 0140.
     *
     * The other half of the terms: `level_id` says which percentage applied,
     * this says which product rate card it was a percentage OF. With both, and
     * `rate_value` and `base_amount` on the row, a disputed payout is still
     * settled from the row alone after either card has been edited.
     *
     * NULLABLE for rows written before 0140, which were priced on a level's
     * own per-lot amount and had no type to name. `restrict` on delete, like
     * `level_id`: a card that has ever paid anybody cannot be removed.
     */
    commissionTypeId: uuid('commission_type_id').references(() => ibCommissionTypes.id, {
      onDelete: 'restrict',
    }),
    /** The rate applied, so the arithmetic is reproducible from the row alone. */
    rateValue: numeric('rate_value', { precision: 12, scale: 4 }).notNull(),
    /** The revenue base this is a share of. */
    baseAmount: numeric('base_amount', { precision: 28, scale: 8 }).notNull(),
    /** §6.1: NUMERIC(28,8), never a float, and a string at every boundary. */
    amount: numeric('amount', { precision: 28, scale: 8 }).notNull(),
    currency: varchar('currency', { length: 10 })
      .notNull()
      .references(() => currencies.code, { onDelete: 'restrict' }),
    kind: ibAccrualKindEnum('kind').notNull().default('commission'),
    status: ibAccrualStatusEnum('status').notNull().default('pending'),
    /**
     * The ledger entry that paid it, once confirmed.
     *
     * NULL while pending. Set inside the SAME transaction as the credit, so an
     * accrual marked confirmed with no entry — or the reverse — is a state this
     * system cannot reach.
     */
    ledgerEntryId: uuid('ledger_entry_id').references(() => ledgerEntries.id, {
      onDelete: 'restrict',
    }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /*
     * The payout run this was paid in (0116). NULL for a PENDING accrual, and
     * NULL for every accrual confirmed BEFORE 0116 — those were each paid on
     * their own and belong to no batch. Both shapes stay readable for ever;
     * settled ledger rows are never rewritten to make a report tidier.
     */
    batchId: uuid('batch_id').references(() => ibAccrualBatches.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * ⚠️ THE IDEMPOTENCY GUARANTEE (§6.3).
     *
     * One accrual per earner per source event. A replayed webhook, a retried job
     * or a double-submitted approval all resolve to the same row — the insert is
     * `ON CONFLICT DO NOTHING`, never a check-then-insert, because every
     * check-then-insert loses under concurrency.
     *
     * `depth` is deliberately NOT in the key: one partner cannot legitimately
     * earn twice from one event, and including it would let a cycle in the tree
     * pay somebody at both depth 1 and depth 2 for the same deposit.
     */
    /*
     * `kind` is part of the key, and leaving it out was the trap.
     *
     * One deal produces a commission row and a rebate row that share a source
     * and a partner. Without `kind` the second collides with the first and the
     * insert's `onConflictDoNothing` drops it — which looks identical to a
     * rebate that is configured, calculated, and simply never paid.
     */
    uniqueIndex('ib_accruals_source_earner_uq').on(t.sourceType, t.sourceId, t.ibUserId, t.kind),
    /* "What has this partner earned?" — the overview's own query. */
    index('ib_accruals_ib_user_idx').on(t.ibUserId, t.createdAt),
    /* The confirm job: everything still pending, oldest first. */
    index('ib_accruals_status_idx').on(t.status, t.createdAt),
    /* The drill-down from one wallet line to the trades behind it — the
       whole reason the per-trade rows are kept (0116). */
    index('ib_accruals_batch_idx').on(t.batchId),
    /* "Has this rate card ever paid anybody?" — asked before a type may be
       deleted, so the refusal can say so rather than surfacing a constraint. */
    index('ib_accruals_commission_type_idx').on(t.commissionTypeId),
    /* A commission is a share of revenue and can never be negative — a clawback
       is a REVERSAL of the row, not a negative accrual. */
    check('ib_accruals_amount_positive', sql`${t.amount} > 0`),
    /*
     * 1..10, widened from 1..2 in 0102.
     *
     * The old bound was the two-level cap written into the database, and it
     * would have turned FR-IB-17's multi-level distribution into a failed
     * INSERT at depth 3 — the worst place to discover a ceiling, because the
     * statement carries every legitimate earner on the same trade down with it.
     *
     * 10 matches `MAX_CHAIN_DEPTH` and `ib_program_tiers_depth_range`, and like
     * both of those it is a CYCLE GUARD rather than a policy: how far earnings
     * actually travel is the tier count on the earner's programme.
     */
    check('ib_accruals_depth_range', sql`${t.depth} >= 1 AND ${t.depth} <= 10`),
  ],
);

/**
 * A trade on a trading account — open, or closed with a result.
 *
 * ## ⚠️ THIS TABLE IS DELIBERATELY EMPTY, and will stay empty until a bridge fills it
 *
 * Nothing writes to it. There is no MT5 bridge (ARCHITECTURE open decision #1),
 * so no ingestion path exists and no row can appear by any route the application
 * offers. It is created NOW so the shape is agreed and the portal can render
 * against a real query returning zero rows, rather than against a placeholder
 * that would have to be rewritten the day the feed lands.
 *
 * That distinction matters more than it looks, and this codebase has paid for it
 * twice: a screen that renders a HARDCODED empty state is indistinguishable from
 * one whose query genuinely found nothing, and the accounts page once told a
 * client with three live accounts they had none. A real table means "no open
 * positions" is an answer the database gave, not one the frontend assumed.
 *
 * WHEN THE BRIDGE LANDS it owns the INSERT and the UPDATE, and it owes this
 * table the same idempotency `transactions` has — `UNIQUE(trading_account_id,
 * ticket)` below is what makes a redelivered tick or a replayed sync a no-op
 * rather than a duplicated trade.
 *
 * ## Why the money columns are nullable
 *
 * `closePrice`, `closedAt` and `profit` are NULL while a position is open,
 * because they do not exist yet — a floating P/L is a computation against a live
 * price, not a stored fact. Defaulting them to zero would make an open trade
 * look like a closed one that broke even, which is the most expensive possible
 * misreading on a trading screen.
 *
 * `profit` is the REALISED result and is only written at close. Unrealised P/L
 * is deliberately absent from this table: it changes on every tick and belongs
 * to whatever is streaming prices, never to a row somebody might read an hour
 * later and believe.
 */
export const positionSideEnum = pgEnum('position_side', ['buy', 'sell']);
export const positionStatusEnum = pgEnum('position_status', ['open', 'closed']);

export const positions = pgTable(
  'positions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /*
     * Denormalised alongside `tradingAccountId`, on purpose. Every read of this
     * table is "this client's positions", and routing it through a join to
     * `trading_accounts` on the hot path buys nothing — while the account
     * reference keeps the row attributable to the specific login it was traded
     * on.
     */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tradingAccountId: uuid('trading_account_id')
      .notNull()
      .references(() => tradingAccounts.id, { onDelete: 'restrict' }),
    /**
     * The broker's own identifier for this trade.
     *
     * A STRING, like `trading_accounts.login`, because leading zeros are
     * significant to the bridge and a numeric type would eat them.
     */
    ticket: varchar('ticket', { length: 50 }).notNull(),
    /** e.g. 'EURUSD', 'XAUUSD'. Whatever the terminal calls the instrument. */
    symbol: varchar('symbol', { length: 40 }).notNull(),
    side: positionSideEnum('side').notNull(),
    /**
     * Lots. NUMERIC rather than a float — 0.01 is a valid size and the smallest
     * increment most brokers allow, so binary floating point is wrong here for
     * exactly the reason it is wrong for money.
     */
    volume: numeric('volume', { precision: 18, scale: 4 }).notNull(),
    /*
     * Prices carry more decimals than money: a JPY pair quotes to 3 places and
     * most others to 5, so 28,10 leaves room without forcing a rounding
     * decision the bridge has not made.
     */
    openPrice: numeric('open_price', { precision: 28, scale: 10 }).notNull(),
    /** NULL while open — see the table note on why this is not defaulted. */
    closePrice: numeric('close_price', { precision: 28, scale: 10 }),
    stopLoss: numeric('stop_loss', { precision: 28, scale: 10 }),
    takeProfit: numeric('take_profit', { precision: 28, scale: 10 }),
    /**
     * The REALISED result, written only at close. Signed: a loss is negative.
     *
     * §6.1 scale, because this figure settles against the account balance and
     * must round-trip identically to every other monetary value in the system.
     */
    profit: numeric('profit', { precision: 28, scale: 8 }),
    /** Broker charges, kept separate so `profit` stays comparable across accounts. */
    swap: numeric('swap', { precision: 28, scale: 8 }),
    commission: numeric('commission', { precision: 28, scale: 8 }),
    currency: varchar('currency', { length: 10 })
      .notNull()
      .references(() => currencies.code, { onDelete: 'restrict' }),
    status: positionStatusEnum('status').notNull().default('open'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * ⚠️ The idempotency guarantee this table will need on its first day.
     *
     * A sync that redelivers a trade, or a bridge restarted mid-batch, must
     * update the existing row rather than insert a second copy of the same
     * trade. Scoped to the ACCOUNT rather than global, because a ticket number
     * is only unique within the server that issued it.
     */
    uniqueIndex('positions_account_ticket_uq').on(t.tradingAccountId, t.ticket),
    /* "This client's open positions, newest first" — the dashboard's own query.
       Partial, because the open set is small and hot while the closed history
       grows without bound. */
    index('positions_user_open_idx')
      .on(t.userId, t.openedAt)
      .where(sql`${t.status} = 'open'`),
    /* The closed history, for the same client. */
    index('positions_user_closed_idx').on(t.userId, t.closedAt),
    index('positions_account_idx').on(t.tradingAccountId),
    /*
     * A closed position has BOTH a close price and a close time, or it is not
     * closed. Enforced here because the two are written by the same event and a
     * row carrying one without the other is a trade nobody can reconcile.
     */
    check(
      'positions_closed_has_close_data',
      sql`(${t.status} = 'open' AND ${t.closedAt} IS NULL) OR (${t.status} = 'closed' AND ${t.closedAt} IS NOT NULL AND ${t.closePrice} IS NOT NULL)`,
    ),
    check('positions_volume_positive', sql`${t.volume} > 0`),
  ],
);

/* ────────────────────────────── Notifications ──────────────────────────────
 *
 * The in-app feed behind the bell in both frontends. One table for both
 * audiences: the row shape (kind + params + read marker) is identical whether
 * the recipient is a client or an admin, and two tables would mean two stores,
 * two paging implementations and two unread indexes for one enum's worth of
 * difference.
 *
 * No stored title/body/href: copy is i18n'd in each frontend from `kind` +
 * `params`, and deep links are derived there too — the backend never encodes a
 * portal route, for the same reason `redirectUrl()` in transactions.service.ts
 * is the only place that knows one. Money values inside `params` are STRINGS
 * (§6.1), always.
 *
 * These rows are UX, not records — the audit log and the ledger are the
 * records. A daily prune (NotificationsService) drops them by age, read or not,
 * because this table collects fan-out multiples of every event and would
 * otherwise out-grow audit_log: client rows after 90 days, admin rows after a
 * year — the admin feed's History is where a desk goes back through its work.
 *
 * The two audiences differ in kind since 0140. A CLIENT row is an outcome
 * ("your withdrawal was paid") and is done once seen. An ADMIN row is a TASK
 * — something the reader must handle — and names the item it is about, so it
 * can be scope-checked when read and resolved the moment anybody handles it.
 */

export const notificationRecipientKindEnum = pgEnum('notification_recipient_kind', [
  'client',
  'admin',
]);

/**
 * The items an admin task can be about — the closed set
 * `notifications_subject_kind_ck` enforces (migration 0140). A KYC task's
 * subject id is the CLIENT's id, because `kyc_submissions` is keyed on it.
 */
export const NOTIFICATION_SUBJECT_KINDS = [
  'transaction',
  'kyc',
  'ib_application',
  'transfer',
  'ib_accrual',
] as const;
export type NotificationSubjectKind = (typeof NOTIFICATION_SUBJECT_KINDS)[number];

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    recipientKind: notificationRecipientKindEnum('recipient_kind').notNull(),
    /*
     * Bare uuid, NO foreign key — the audit_log.actor_id precedent: it points
     * at `users` or `admins` depending on recipient_kind, and Postgres cannot
     * express a polymorphic reference. Neither principal table deletes rows
     * (clients are never deleted, admins are suspended), so orphaning is not a
     * live risk.
     */
    recipientId: uuid('recipient_id').notNull(),
    /*
     * Catalogue slug, e.g. 'withdrawal.approved'. varchar rather than a
     * pgEnum: adding an event to the catalogue must not need a migration.
     */
    kind: varchar('kind', { length: 100 }).notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    /*
     * The replay guard for at-least-once callers (webhook-driven deposit
     * settlement, the hourly commission confirm loop). Nullable: paths that
     * cannot replay (a conditional state transition already absorbed the
     * retry) omit it. Idempotency lives in the partial unique index below,
     * never in a check-then-insert (§6.3).
     */
    dedupeKey: varchar('dedupe_key', { length: 255 }),
    readAt: timestamp('read_at', { withTimezone: true }),
    /*
     * MILLISECOND precision, deliberately — the keyset cursor round-trips this
     * value through a JS Date, which is millisecond-truncated. At Postgres'
     * default microsecond precision, a row sharing the boundary row's
     * millisecond but not its microsecond compares strictly LESS than the
     * minted cursor and silently vanishes from every page — the id tiebreak
     * can never engage because post-truncation equality never happens. Storing
     * at the precision the cursor can carry makes the comparison exact.
     */
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /*
     * ── An ADMIN row is a task about one item (migration 0140) ──────────────
     *
     * `subject_user_id` is the client the task concerns — what the feed's
     * READ-time scope check runs against, so a re-tagged client's tasks leave
     * the desk that lost them immediately. `subject_kind` + `subject_id` name
     * the item (a transaction, a KYC submission keyed by its client, an IB
     * application, a transfer, a commission accrual), which is what the item
     * tables' triggers resolve by. All three are required on admin rows
     * (`notifications_admin_subject_ck`) and absent on client rows.
     *
     * No foreign keys, for the recipient's reason above: clients are never
     * deleted, and a bell row must not add a failure mode to anyone's write.
     */
    subjectUserId: uuid('subject_user_id'),
    subjectKind: varchar('subject_kind', { length: 24 }).$type<NotificationSubjectKind>(),
    subjectId: uuid('subject_id'),
    /*
     * Set by the item tables' triggers the moment somebody handles the item —
     * for EVERY admin's row about it at once. Never written by application
     * code: a path that forgot would be the "it keeps showing" bug again.
     * `resolution` is the item state that ended the task ('approved',
     * 'rejected', 'success', 'reversed', 'resolved' …); `resolved_by` is the
     * admin, only when the ending UPDATE itself recorded one.
     */
    resolvedAt: timestamp('resolved_at', { withTimezone: true, precision: 3 }),
    resolution: varchar('resolution', { length: 24 }),
    resolvedBy: uuid('resolved_by'),
  },
  (t) => [
    check(
      'notifications_admin_subject_ck',
      sql`${t.recipientKind} <> 'admin' OR (${t.subjectUserId} IS NOT NULL AND ${t.subjectKind} IS NOT NULL AND ${t.subjectId} IS NOT NULL)`,
    ),
    check(
      'notifications_subject_kind_ck',
      sql`${t.subjectKind} IS NULL OR ${t.subjectKind} IN ('transaction', 'kyc', 'ib_application', 'transfer', 'ib_accrual')`,
    ),
    uniqueIndex('notifications_recipient_dedupe_uq')
      .on(t.recipientKind, t.recipientId, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    /* The admin Inbox: still somebody's work — unread AND unresolved. */
    index('notifications_admin_inbox_idx')
      .on(t.recipientId, t.createdAt.desc(), t.id.desc())
      .where(sql`${t.recipientKind} = 'admin' AND ${t.readAt} IS NULL AND ${t.resolvedAt} IS NULL`),
    /* What the resolution triggers look up: the open rows about one item. */
    index('notifications_subject_open_idx')
      .on(t.subjectKind, t.subjectId)
      .where(sql`${t.resolvedAt} IS NULL`),
    /* Keyset paging: both ORDER BY keys in the same direction, same rule
       audit-log.store.ts records. */
    index('notifications_recipient_created_idx').on(
      t.recipientKind,
      t.recipientId,
      t.createdAt,
      t.id,
    ),
    /* The 60-second unread-count poll, as an index-only scan of a small set. */
    index('notifications_recipient_unread_idx')
      .on(t.recipientKind, t.recipientId)
      .where(sql`${t.readAt} IS NULL`),
  ],
);

/**
 * Every file this system stores — the upload registry (migration 0064).
 *
 * Read that migration's header first; it carries the reasoning. In short: file
 * references live as free-text values inside JSONB blobs and on owning rows, and
 * nothing recorded the act of uploading at all. "Who uploaded this document, when,
 * how big was it" had no answer, and on a system holding identity documents for a
 * regulated broker that question gets asked under pressure.
 *
 * **Additive, not a replacement.** `kyc_submissions.document -> 'frontFilePath'`,
 * `users.avatar_filename` and `payment_methods.logo_url` are untouched. A row here
 * is evidence about an OBJECT; those columns are the claim about which object a
 * submission or a profile is made of. `scripts/r2-reconcile.mjs` cross-checks the
 * two, in both directions.
 */
export const storedObjects = pgTable(
  'stored_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'kyc' | 'avatars' | 'payment-logos' — also the key prefix and the disk dir. */
    bucket: varchar('bucket', { length: 32 }).notNull(),
    /** The provider key, e.g. `kyc/9f2c….jpg`. Never a URL — the bucket is private. */
    storageKey: varchar('storage_key', { length: 512 }).notNull(),
    /**
     * 'r2' | 'disk', per object rather than per deployment.
     *
     * Both are live at once: files uploaded before the R2 move are still on local
     * disk and still served, with no backfill migration. This is what tells the
     * reconciliation sweep which store to look in.
     */
    provider: varchar('provider', { length: 16 }).notNull(),
    /** The SNIFFED type from the file's own magic bytes, never the declared one. */
    contentType: varchar('content_type', { length: 128 }).notNull(),
    /** `mode: 'number'` — a file size, not money. No NUMERIC/decimal.js rule applies. */
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    /**
     * Lowercase hex SHA-256, sent to R2 as an integrity checksum on write.
     *
     * Indexed for DETECTION ("has this exact file been uploaded before" is a
     * fraud-review question), never for deduplication — sharing one object between
     * two owners would mean deleting one client's document deletes another's.
     */
    sha256: char('sha256', { length: 64 }).notNull(),
    /** Display only. Never used to build a path or an extension. */
    originalName: varchar('original_name', { length: 255 }),
    /**
     * The client the object is ABOUT; null for brand marks belonging to nobody.
     * `restrict` matches `kyc_submissions` — deleting a client must fail loudly
     * rather than silently discard the record of what they uploaded.
     */
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'restrict' }),
    uploadedById: uuid('uploaded_by_id').notNull(),
    /** 'client' | 'admin' — the same shape as `audit_log.actor_kind`. */
    uploadedByKind: varchar('uploaded_by_kind', { length: 16 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft. The row outlives the bytes — see the migration header. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    /* Idempotency in a constraint, never check-then-insert (§6.3). */
    uniqueIndex('stored_objects_bucket_key_uq').on(t.bucket, t.storageKey),
    /* The quota query. Partial: a replaced document must not still count. */
    index('stored_objects_owner_live_idx')
      .on(t.ownerUserId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('stored_objects_created_at_idx').on(t.createdAt.desc()),
    index('stored_objects_sha256_idx').on(t.sha256),
    /* "Which client owns this filename" — the ILIKE-over-JSONB scan this replaces. */
    index('stored_objects_key_idx').on(t.storageKey),
  ],
);

/*
 * ── job_leases — ONE INSTANCE RUNS EACH SCHEDULED JOB ────────────────────────
 *
 * `@Cron` fires on EVERY instance. That is fine for correctness here — every
 * money job on this platform is idempotent by construction, and each one says so
 * in its own docblock: the accrual is guarded by `ib_accruals_source_earner_uq`,
 * the confirm credit by `ledger_entries_wallet_reference_uq`, a transfer resume
 * by the transfer id being the bridge's idempotency key. Two instances racing
 * produce one outcome.
 *
 * What it is not is AFFORDABLE. Four replicas mean four drains of the same
 * commission queue, contending on the same rows, doing four times the database
 * work for one result — and the drain budgets make each run long enough to
 * overlap the next. Correct and wasteful is what stops a platform scaling
 * horizontally, which is the only way it reaches the size this one is planned
 * for.
 *
 * ── A LEASE, not an advisory lock ───────────────────────────────────────────
 *
 * `pg_try_advisory_lock` is session-scoped, and with a connection pool the
 * unlock can land on a different pooled connection than the lock — leaking the
 * lock until that connection recycles. A row with an expiry has no such
 * coupling: it is visible, debuggable in one SELECT, and self-healing. An
 * instance that dies mid-job simply stops renewing, and the lease expires.
 *
 * `expires_at` is therefore a CRASH BACKSTOP rather than the normal path. A job
 * that finishes releases immediately; the expiry only matters when nothing ever
 * releases, and it must exceed the job's own time budget or a second instance
 * would start while the first is still working.
 */
export const jobLeases = pgTable('job_leases', {
  /** The job's `@Cron` name — `ib.confirmAccruals`, `wallet.reconcile`. */
  name: varchar('name', { length: 100 }).primaryKey(),
  /**
   * Which instance holds it. Host and process, for the operator staring at a
   * lease that has not moved: "who is stuck" is the first question, and a
   * boolean cannot answer it.
   */
  holder: varchar('holder', { length: 160 }).notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * When another instance may take it, whatever the holder is doing.
   *
   * Released early on a clean finish by setting this to `now()`, so the next
   * tick is not blocked by a job that already ended.
   */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
