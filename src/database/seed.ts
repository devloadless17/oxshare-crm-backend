import { getDb } from './db';
import { PasswordService } from '../common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  agencies,
  clientTagAssignments,
  clientTags,
  ibAccounts,
  kycConfigSteps,
  kycSubmissions,
  mt5Deals,
  transfers,
  rejectionReasons,
  roles,
  tradingAccounts,
  users,
  wallets,
} from './schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DEFAULT_KYC_STEPS } from '../store/kyc-config.store';
import { ClientIdentityStore } from '../store/client-identity.store';
import permissionsCatalog from '../config/permissions.json';

// Idempotent dev/bootstrap seeds — safe to run on every boot. Idempotency
// lives in database constraints (unique email / role name / (context,label)),
// never in check-then-insert.
/**
 * Every key in `config/permissions.json`, read from the same file the API
 * serves — never a second hand-written list. A seed carrying its own would
 * drift from the catalog the moment a key was added, and the drift would look
 * like a role that mysteriously lacks a permission.
 */
const ALL_PERMISSIONS: string[] = Object.values(
  permissionsCatalog as Record<string, { permissions: { key: string }[] }>,
).flatMap((module) => module.permissions.map((entry) => entry.key));

/**
 * Whether to seed the END-TO-END FIXTURES — roughly a dozen `e2e-*` accounts,
 * the `@oxshare-e2e.test` client cohort, their tags and their purpose-made
 * roles. On by default, because the Playwright suites in both frontends sign in
 * as those identities and a silent absence would fail them somewhere far from
 * the cause.
 *
 * `SEED_E2E_FIXTURES=false` turns them off, and the reason it exists is a
 * developer's own database: a person eyeballing the client list to check
 * scoping, masking or a tag filter cannot do it over two hundred fixtures that
 * reappear on every boot. Wiping the tables does not help — this file puts them
 * straight back.
 *
 * It does NOT gate `admin@oxshare.com` or `client@oxshare.com`. Those are the
 * demo accounts a developer signs in as; they are the point of seeding at all.
 */
function seedE2eFixtures(): boolean {
  /*
   * Read INSIDE the function, never at module scope.
   *
   * A module-level `const` is evaluated when this file is first imported, which
   * is while main.ts is building its import graph — BEFORE `ConfigModule` runs
   * dotenv and puts `.env` into `process.env`. So it read `undefined`, took the
   * default, and seeded the fixtures however the variable was set. That cost a
   * restart to notice and would have read as "the flag does not work".
   */
  return process.env.SEED_E2E_FIXTURES !== 'false';
}

export async function runSeeds(): Promise<void> {
  const db = getDb();

  // argon2id, the same as a real signup (R-3.4) — a fresh install should carry
  // no legacy hashes at all. Constructed directly rather than injected: seeds
  // run at bootstrap, outside the request lifecycle, and this service has no
  // dependencies of its own.
  const passwords = new PasswordService();
  const [adminHash, clientHash] = await Promise.all([
    passwords.hash('admin123'),
    passwords.hash('client123'),
  ]);

  /*
   * There is no 'Master Admin' role any more. `Administrator` below replaces it,
   * and the difference is worth stating precisely, because the two look similar
   * from a distance and failed in opposite directions.
   *
   * `Master Admin` carried `['*']` and was HIDDEN from the roles screen and from
   * every assignment control, which made "full access" a thing the console could
   * neither show nor hand out. The wildcard also meant a permission added later
   * was held retroactively by whoever carried it, with nobody having granted it.
   *
   * `Administrator` is a SYSTEM role — `isSystem: true` — but the flag now means
   * only "the backend keeps this role level with `config/permissions.json`", and
   * `permission-drift.ts` matches on it. It is listed, badged and assignable
   * like any other role; what the API refuses is editing and deleting it. So
   * full access is visible, grantable, and always complete, which is the whole
   * of what `Master Admin` was reaching for and none of how it got there.
   */

  /*
   * Ten ordinary roles, so /roles has something to be a list OF.
   *
   * The screen was built against one system role and one test fixture, which is
   * the population at which every list looks fine: no scrolling, no reason to
   * prefer a count over chips, no way to tell a sorted list from an unsorted
   * one. Ten is past the point where the card's max-height engages.
   *
   * ── Every key below is from config/permissions.json ──────────────────────
   *
   * Not invented. A seeded role granting `reports.export` — a plausible string
   * the backend does not define — renders as a role that grants nothing, and
   * `assertPermissionKeysExist` would not catch it: that checks the frontend's
   * ROUTE table, not seed data.
   *
   * The sets are realistic rather than arbitrary. These screens are read as
   * "what can a support agent see", and a role called "Role 7" answers nothing
   * — so each is a job someone actually does, and two of them differ only in
   * the way that matters (see Finance below).
   *
   * `isSystem` is deliberately omitted: these are exactly the custom roles the
   * page lists, and marking one system would hide it.
   *
   * `onConflictDoNothing` on the name, because seeds run at every bootstrap —
   * an operator who edits a seeded role must not have that undone on restart.
   */
  await db
    .insert(roles)
    .values([
      {
        /*
         * Every key in the catalog, listed OUT rather than wildcarded.
         *
         * `['*']` used to mean "everything", including every permission added
         * after the grant was made — so a key introduced later was held
         * retroactively by whoever carried it. Listing them means this role
         * grants exactly what existed when it was seeded.
         *
         * A SYSTEM role, and this is the flag `permission-drift.ts` matches on.
         * It means one thing: the backend keeps this role's permissions level
         * with `config/permissions.json` on every boot. So the explicit list
         * above is a starting point rather than a ceiling — a key added to the
         * catalog later lands here without a migration, which is what three
         * hand-written backfills (0068, 0075, 0085) existed to do by hand.
         *
         * ⚠️ `isSystem` must be set HERE as well as in the migration that
         * flipped the existing row. The migration repairs databases that already
         * exist; this is the only thing a FRESH one runs, and without it a new
         * install would seed an ordinary role that the top-up never finds —
         * silently reintroducing the exact drift this closes.
         *
         * It is still visible and assignable in the console. What the API
         * refuses is editing and deleting it, plus the write that would leave
         * nobody holding `roles.edit` or `admins.edit` — see assertNotLastManager.
         */
        name: 'Administrator',
        description: 'Every permission in the catalog.',
        permissions: ALL_PERMISSIONS,
        maskedFields: [],
        isSystem: true,
      },
      {
        name: 'Support Agent',
        description: 'Answers client tickets. Reads client records; changes nothing.',
        permissions: ['clients.view', 'kyc.view', 'tags.view'],
        // Answering a ticket does not need a phone number, and this is the role
        // most people hold — so it is the one worth masking by default.
        maskedFields: ['client.phone'],
      },
      {
        name: 'Senior Support',
        description: 'Escalation point. May edit client records and assign tags.',
        permissions: ['clients.view', 'kyc.view', 'tags.view', 'clients.tag'],
        maskedFields: [],
      },
      {
        name: 'KYC Reviewer',
        description: 'Approves and rejects identity submissions, including documents.',
        permissions: ['kyc.view', 'kyc.review', 'kyc.documents.view', 'clients.view'],
        maskedFields: [],
      },
      {
        name: 'KYC Administrator',
        description: 'Owns the KYC workflow itself — its steps, fields and requirements.',
        permissions: ['kyc.view', 'kyc.review', 'kyc.edit', 'kyc.create', 'kyc.documents.view'],
        maskedFields: [],
      },
      {
        name: 'Finance Officer',
        description: 'Settles approved withdrawals and reconciles them against the ledger.',
        permissions: ['clients.view'],
        maskedFields: [],
      },
      {
        name: 'Finance Approver',
        description: 'Approves withdrawals. Separated from settlement on purpose.',
        // Deliberately WITHOUT withdrawals.settle. Whoever approves a payment
        // should not also mark it settled; that separation of duties is the
        // only reason this and Finance Officer are two roles rather than one.
        permissions: ['clients.view'],
        maskedFields: [],
      },
      {
        name: 'Compliance Officer',
        description: 'Reads everything client-facing for audit. Approves nothing.',
        permissions: ['clients.view', 'kyc.view', 'kyc.documents.view'],
        maskedFields: [],
      },
      {
        name: 'Onboarding Agent',
        description: 'Creates client records and starts their verification.',
        permissions: ['clients.view', 'admins.create', 'kyc.view', 'kyc.create'],
        maskedFields: [],
      },
      {
        name: 'Risk Analyst',
        description: 'Watches trading activity and suspends accounts that need it.',
        permissions: ['clients.view', 'clients.suspend'],
        maskedFields: [],
      },
      {
        name: 'Platform Operator',
        description: 'Maintains console configuration. No access to client records.',
        // Holds no users.view at all, so this is the role that exercises a
        // gated NAVIGATION rather than only a gated screen body.
        permissions: ['settings.view', 'settings.edit', 'currencies.view', 'roles.view'],
        maskedFields: [],
      },
    ])
    .onConflictDoNothing({ target: roles.name });

  await db
    .insert(admins)
    .values({
      email: 'admin@oxshare.com',
      passwordHash: adminHash,
      name: 'Master Admin',
      // `role` is left at its default: the column is dead after migration 0044 and
      // nothing reads it. Access comes from the Administrator role assigned below.
      permissions: ALL_PERMISSIONS,
    })
    .onConflictDoNothing({ target: admins.email });

  if (seedE2eFixtures()) {
    /*
     * The admin the END-TO-END SUITE owns, for the same reason the e2e client
     * below exists: a test fixture must not share an identity with a person.
     *
     * `admin@oxshare.com` is the account a developer is signed into while working,
     * and the admin suite signs in, refreshes and rotates tokens on every run.
     * Sharing it means two parties rotating one refresh family — which is exactly
     * what reuse detection punishes — and test logins eating a rate limit a human
     * is also trying to use.
     *
     * Master-level on purpose: the suite walks the whole console, and a fixture
     * that 403s halfway would test the fixture rather than the app. Permission
     * SPLITS are asserted against purpose-made roles inside the specs instead.
     *
     * Same protection as the rest of this file — `runSeeds()` is called from
     * main.ts only when NODE_ENV is not production, so this cannot reach a live
     * deployment.
     */
    await db
      .insert(admins)
      .values({
        email: 'e2e-admin@oxshare.com',
        passwordHash: adminHash,
        name: 'E2E Admin',
        // `role` is left at its default: the column is dead after migration 0044 and
        // nothing reads it. Access comes from the Administrator role assigned below.
        permissions: ALL_PERMISSIONS,
      })
      .onConflictDoNothing({ target: admins.email });
  }

  /*
   * The attach the two comments above promise — made HERE, because it used to
   * live only in migration 0045, which on a FRESH database runs before these
   * rows exist. A new environment therefore seeded both accounts with a
   * full-access snapshot and `roleId` NULL: access resolved (the snapshot
   * fallback), but editing the Administrator role silently did not touch the
   * seeded admins, contradicting the comments beside the inserts.
   *
   * `WHERE roleId IS NULL` keeps it one-shot: an operator who later moves
   * either account onto a narrower role must not be re-widened on the next
   * boot — the same fingerprint discipline the permission-backfill migrations
   * follow.
   */
  const [administratorRole] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, 'Administrator'))
    .limit(1);
  if (administratorRole) {
    await db
      .update(admins)
      .set({ roleId: administratorRole.id })
      .where(
        and(
          inArray(admins.email, ['admin@oxshare.com', 'e2e-admin@oxshare.com']),
          isNull(admins.roleId),
        ),
      );
  }

  await db
    .insert(users)
    .values({
      email: 'client@oxshare.com',
      passwordHash: clientHash,
      firstName: 'John',
      lastName: 'Doe',
      type: 'individual',
      status: 'active',
      emailVerified: true,
      country: 'United Arab Emirates',
      phone: '+971501234567',
    })
    .onConflictDoNothing({ target: users.email });

  if (seedE2eFixtures()) {
    /*
     * A client the END-TO-END SUITE owns, so it never shares one with a person.
     *
     * The e2e specs used `client@oxshare.com` — the account a developer is
     * typically signed in as while working. Two consequences, both observed:
     * repeated test logins burned the 5-per-minute login limit and answered a
     * developer's own sign-in with 429, and two parties rotating refresh tokens
     * for one identity is exactly the shape reuse detection is built to punish.
     *
     * Same password as the demo client on purpose — this is a fixture, not a
     * secret, and `runSeeds()` is called from main.ts only when NODE_ENV is not
     * production, so neither account can reach a live deployment.
     */
    await db
      .insert(users)
      .values({
        email: 'e2e@oxshare.com',
        passwordHash: clientHash,
        firstName: 'Eve',
        lastName: 'Endtoend',
        type: 'individual',
        status: 'active',
        emailVerified: true,
        // Level 1, so the suite can exercise the verified states — the sidebar
        // badge, the terminal KYC screen — without first driving an admin
        // approval through the UI on every run.
        verificationLevel: 1,
        country: 'United Arab Emirates',
        phone: '+971500000000',
        dateOfBirth: '1990-01-01',
        nationality: 'Lebanese',
      })
      .onConflictDoNothing({ target: users.email });

    /*
     * A second e2e client, VERIFIED but with no KYC submission at all.
     *
     * The approved one above cannot exercise the onboarding wizard — there is
     * nothing left for it to do — and a spec that submitted would leave the
     * fixture in `submitted`, where `resetKyc` refuses, so the second run would
     * find a different world than the first. A separate never-submitted client is
     * what makes the wizard spec repeatable: it stops short of submitting, so the
     * row stays `in_progress`, which `saveStep` accepts indefinitely.
     */
    await db
      .insert(users)
      .values({
        email: 'e2e-kyc@oxshare.com',
        passwordHash: clientHash,
        firstName: 'Kaya',
        lastName: 'Onboarding',
        type: 'individual',
        status: 'active',
        emailVerified: true,
        verificationLevel: 0,
        country: 'United Arab Emirates',
        phone: '+971500000001',
      })
      .onConflictDoNothing({ target: users.email });

    /*
     * A THIRD e2e client, whose only job is to be signed out.
     *
     * `logout` revokes EVERY family for a user, not just the one presenting a
     * token (R-3.3 — signing out on one device must not leave the others live).
     * That is correct, and it means a spec that drives a real sign-out on a shared
     * fixture destroys the cached session every LATER spec replays. The symptom is
     * a run where one logout test fails and eleven unrelated ones fail after it,
     * each looking like its own auth bug.
     *
     * The portal's own suite hit exactly that, which is why the logout spec was
     * `fixme`d rather than fixed for a while. So logout gets an identity nobody
     * else signs in as — the same reasoning behind the admin suite's
     * `e2e-suspend-target`, and behind `e2e@oxshare.com` not being a person's
     * account.
     *
     * Approved and verified, so it can reach every private page before ending its
     * session there.
     */
    await db
      .insert(users)
      .values({
        email: 'e2e-logout@oxshare.com',
        passwordHash: clientHash,
        firstName: 'Leo',
        lastName: 'Signout',
        type: 'individual',
        status: 'active',
        emailVerified: true,
        verificationLevel: 1,
        country: 'United Arab Emirates',
        phone: '+971500000002',
      })
      .onConflictDoNothing({ target: users.email });

    /*
     * And an APPROVED submission for it, so `/kyc` reaches the terminal screen
     * directly rather than bouncing through a step on the way.
     *
     * Carries no document paths deliberately. A path pointing at a file the seed
     * does not create is how the demo client ended up 404ing three documents for
     * days — the row claimed evidence that had never existed on disk. An absent
     * document is honest; a dangling reference is a lie the review screen repeats.
     */
    /*
     * Two more portal identities, each for ONE destructive journey:
     *  - `e2e-reuse@`   — the reuse-detection spec deliberately replays a spent
     *                     refresh token, which revokes the whole family.
     *  - `e2e-suspend@` — the admin suite suspends it to prove a live portal
     *                     session dies on its next navigation; reactivated by
     *                     the spec, and re-asserted active here every boot so a
     *                     crashed run cannot leave it locked.
     */
    for (const extra of [
      {
        email: 'e2e-reuse@oxshare.com',
        firstName: 'Rea',
        lastName: 'Replay',
        phone: '+971500000003',
      },
      {
        email: 'e2e-suspend@oxshare.com',
        firstName: 'Sue',
        lastName: 'Spended',
        phone: '+971500000004',
      },
    ]) {
      await db
        .insert(users)
        .values({
          ...extra,
          passwordHash: clientHash,
          type: 'individual',
          status: 'active',
          emailVerified: true,
          verificationLevel: 1,
          country: 'United Arab Emirates',
        })
        .onConflictDoNothing({ target: users.email });
    }
    await db
      .update(users)
      .set({ status: 'active' })
      .where(eq(users.email, 'e2e-suspend@oxshare.com'));

    const [e2eClient] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'e2e@oxshare.com'))
      .limit(1);

    if (e2eClient) {
      await db
        .insert(kycSubmissions)
        .values({
          userId: e2eClient.id,
          status: 'approved',
          submittedAt: new Date(),
          reviewedAt: new Date(),
          // The identity is the PROFILE's (above) — `personal_info` holds only
          // answers to fields a broker invented, and this client gave none (0139).
          personalInfo: {},
          document: { docType: 'passport' },
          addressProof: { docType: 'utility_bill' },
        })
        .onConflictDoNothing({ target: kycSubmissions.userId });
    }

    /*
     * ── Partner-programme fixtures, for the portal e2e suite ──────────────────
     *
     * A two-rung chain the suite can stand clients under without driving a
     * partner application through approval on every run:
     *
     *   e2e-partner-l1@  level 1, root — code E2EPARTL1. Carries the agency, so
     *                    an applicant introduced by them INHERITS it and the
     *                    apply panel's "selected for you" card renders.
     *   e2e-partner-l2@  level 2 under l1 — code E2EPARTL2. The deepest enabled
     *                    rung on the committed ladder, so a client registered
     *                    under THIS code is chain_full and must be locked out of
     *                    the programme everywhere the portal offers it.
     *   e2e-partner-applicant@  verified + KYC 1, introduced by l1, no
     *                    application — drives the inherited-agency apply flow.
     *                    The spec keeps it repeatable by having the admin REJECT
     *                    what it submits (rejected → "Apply again" is a loop;
     *                    approval is deliberately irreversible and would make
     *                    run two a different world).
     *   e2e-partner-fresh@      same shape — the one identity the spec DOES
     *                    approve, once, to prove approval nests a recruited
     *                    partner beneath their introducer; later runs assert the
     *                    standing outcome instead.
     *
     * The ACCOUNTS are seeded rather than approved into existence because there
     * is deliberately no demote operation — a fixture that becomes a partner on
     * run one is a different world on run two. The live approve path is what
     * `e2e-partner-fresh@` exists for.
     */
    await db
      .insert(agencies)
      .values({ name: 'E2E Agency', enabled: true })
      .onConflictDoNothing({ target: agencies.name });
    // Re-asserted enabled every boot, like `e2e-suspend@`'s active flag: a
    // crashed run (or a curious operator) must not leave the fixture closed and
    // every later apply refusing "not open for applications".
    await db.update(agencies).set({ enabled: true }).where(eq(agencies.name, 'E2E Agency'));
    const [e2eAgency] = await db
      .select({ id: agencies.id })
      .from(agencies)
      .where(eq(agencies.name, 'E2E Agency'))
      .limit(1);

    const partnerFixtures = [
      {
        email: 'e2e-partner-l1@oxshare.com',
        firstName: 'Petra',
        lastName: 'Upline',
        phone: '+971500000005',
      },
      {
        email: 'e2e-partner-l2@oxshare.com',
        firstName: 'Selim',
        lastName: 'Downline',
        phone: '+971500000006',
      },
      {
        email: 'e2e-partner-applicant@oxshare.com',
        firstName: 'Aida',
        lastName: 'Applicant',
        phone: '+971500000007',
      },
      {
        email: 'e2e-partner-fresh@oxshare.com',
        firstName: 'Nadim',
        lastName: 'Nested',
        phone: '+971500000008',
      },
    ] as const;
    for (const fixture of partnerFixtures) {
      await db
        .insert(users)
        .values({
          ...fixture,
          passwordHash: clientHash,
          type: 'individual',
          status: 'active',
          emailVerified: true,
          verificationLevel: 1,
          country: 'United Arab Emirates',
        })
        .onConflictDoNothing({ target: users.email });
    }
    const fixtureRows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(
        inArray(
          users.email,
          partnerFixtures.map((f) => f.email),
        ),
      );
    const fixtureId = (email: string) => fixtureRows.find((r) => r.email === email)?.id;
    const partnerL1 = fixtureId('e2e-partner-l1@oxshare.com');
    const partnerL2 = fixtureId('e2e-partner-l2@oxshare.com');

    if (partnerL1 && partnerL2 && e2eAgency) {
      await db
        .insert(ibAccounts)
        .values({
          userId: partnerL1,
          level: 1,
          referralCode: 'E2EPARTL1',
          agencyId: e2eAgency.id,
          active: true,
        })
        .onConflictDoNothing({ target: ibAccounts.userId });
      await db
        .insert(ibAccounts)
        .values({
          userId: partnerL2,
          level: 2,
          parentIbUserId: partnerL1,
          referralCode: 'E2EPARTL2',
          agencyId: e2eAgency.id,
          active: true,
        })
        .onConflictDoNothing({ target: ibAccounts.userId });
      /*
       * Attribution AFTER the l1 account exists (the column's FK points at
       * ib_accounts), and re-asserted every boot so rows inserted by an older
       * seed pick it up. The applicant and fresh identities sit under L1 — one
       * rung of room — while l2's own introducer is l1, matching the account.
       */
      const introduced = fixtureRows
        .filter((r) => r.email !== 'e2e-partner-l1@oxshare.com')
        .map((r) => r.id);
      await db
        .update(users)
        .set({ referredByIbUserId: partnerL1 })
        .where(inArray(users.id, introduced));
    }
  }

  const kycReasons = [
    'Identity document is blurry or unreadable',
    'Identity document is expired',
    'Selfie does not match the identity document',
    'Proof of address is older than 3 months',
    'Proof of address does not match the declared address',
    'Personal information does not match the documents',
    'Document appears altered or tampered with',
  ].map((label) => ({ context: 'kyc' as const, label }));

  const withdrawalReasons = [
    'Beneficiary details do not match the account holder',
    'Insufficient verified balance',
    'Account verification (KYC) incomplete',
    'Suspicious activity — additional verification required',
  ].map((label) => ({ context: 'withdrawal' as const, label }));

  /*
   * Seeded here rather than in a migration, and that placement is forced.
   *
   * `rejection_context` gained 'partner' in migration 0030, and Postgres will
   * not let a new enum label be USED until the transaction that added it
   * commits. Drizzle's migrator runs every pending migration inside ONE
   * transaction, so an INSERT with context 'partner' fails even from a LATER
   * migration file — splitting it out is not enough. Seeds run after migration
   * has committed, which is the only place this insert is legal on a fresh
   * database.
   *
   * `use-reject-options.ts` falls back to `[]` rather than blocking a decision,
   * so an unseeded context does not break the review screen — it silently turns
   * every refusal into free text and the reasons stop being comparable across
   * reviewers. That is the failure this avoids, not a crash.
   */
  const partnerReasons = [
    'Insufficient trading or introducing experience',
    /*
     * Was 'Expected volume does not meet the programme minimum', which named a
     * field that no longer exists — `expected_volume` went with migration 0063,
     * so a reviewer choosing this reason could no longer point at the figure it
     * refers to, and the applicant could not know what they had claimed.
     *
     * Seeds are ON CONFLICT DO NOTHING, so a database that already holds the
     * old label keeps it. Editing it out of the catalogue is an operator's
     * decision, not a migration's.
     */
    'Introducing volume does not meet the programme minimum',
    'Unable to verify the website or business details provided',
    'Application is incomplete or unclear',
    'Does not meet the eligibility criteria for this programme',
  ].map((label) => ({ context: 'partner' as const, label }));

  /*
   * OFFLINE DEPOSITS. Every one of these describes something the desk can see in
   * the receipt or the bank statement, because that is all a deposit reviewer
   * has — they are refusing a CLAIM about money, not a document's quality.
   *
   * None of them promises a refund, deliberately: nothing was debited, so there
   * is nothing to give back. A client who really did send the money needs
   * support, and the email says so.
   *
   * Seeded here rather than in migration 0127, which adds the enum value: a new
   * enum value cannot be USED in the transaction that adds it, and the runner
   * wraps each migration file in one. The seed runs afterwards on its own
   * connection.
   */
  const depositReasons = [
    'The receipt is unreadable — please send a clearer photo',
    'The amount on the receipt does not match the amount requested',
    'No payment matching this receipt has reached our account',
    'The receipt is for a different transfer we have already credited',
    'The receipt does not show who sent the payment',
  ].map((label) => ({ context: 'deposit' as const, label }));

  await db
    .insert(rejectionReasons)
    .values([...kycReasons, ...withdrawalReasons, ...partnerReasons, ...depositReasons])
    .onConflictDoNothing();

  // Default KYC onboarding steps — only when the config table is empty, so a
  // builder-customized flow is never overwritten by a reboot.
  const [existingStep] = await db.select().from(kycConfigSteps).limit(1);
  if (!existingStep) {
    await db.insert(kycConfigSteps).values(
      DEFAULT_KYC_STEPS.map((s) => ({
        id: s.id,
        stepNumber: s.stepNumber,
        slug: s.slug,
        title: s.title,
        description: s.description,
        icon: s.icon,
        enabled: s.enabled,
        fields: s.fields as unknown as Record<string, unknown>[],
      })),
    );
  }

  // The `withdrawal_otp` security switch is no longer seeded: the OTP was
  // removed (D-67) and so was the screen that toggled it.

  if (seedE2eFixtures()) {
    /*
     * ── The ADMIN end-to-end cohort ─────────────────────────────────────────
     *
     * A fixed, deterministic set of clients on the `@oxshare-e2e.test` domain,
     * for the Playwright suite in `oxshare-crm-admin`.
     *
     * SEEDED, NOT CREATED AT RUNTIME, and that is forced rather than chosen:
     * `POST /auth/register` is capped at 10 per hour per IP and there is no admin
     * endpoint that creates a client at all, so a suite that minted its own
     * fixtures would rate-limit itself on the second run.
     *
     * The DOMAIN is the mechanism that makes a shared development database
     * workable. Every list assertion first types `oxshare-e2e.test` into the
     * search box, so it is about a set the suite owns entirely — a developer who
     * registers forty clients tomorrow cannot break a single assertion. Nothing
     * is ever deleted: half these tables refuse it, and a
     * `DELETE ... WHERE email LIKE` on a shared database is one typo away from
     * destroying somebody's afternoon.
     *
     * The SHAPE is chosen so every filter has both a match and a non-match:
     * 3 types x 3 statuses x 2 levels x 3 countries. A filter that silently
     * ignores its parameter — which is exactly what `?country=` did before this
     * work — then produces a COUNT CHANGE the spec can catch, rather than a
     * vacuous pass. The names run alpha..zulu so a sort assertion is "first is
     * Alpha, last is Zulu", decidable without knowing the total.
     */
    const E2E_DOMAIN = 'oxshare-e2e.test';
    const e2eClients = [
      {
        local: 'alpha',
        firstName: 'Alpha',
        lastName: 'Aardvark',
        type: 'individual',
        status: 'active',
        /*
         * ⚠️ LEVEL 0, AND IT WAS 1 UNTIL 11 Sep 2026. Alpha is the only client in
         * this cohort carrying a KYC SUBMISSION (below, left `submitted` so the
         * review queue has a row nobody decides). Level 1 has exactly ONE source
         * in this product — approval — and alpha has never been approved:
         * `GET /admin/kyc/:id/history` returns zero attempts for them.
         *
         * So the fixture encoded a client who is money-verified while their KYC
         * sits unreviewed. `transactions.service.ts` refuses withdrawals on
         * `verificationLevel < 1`, so seeded alpha could withdraw with their
         * submission still in the queue — which is the exact defect
         * `kyc.service.ts` records fixing: "the status said no while the money
         * path said yes", reproduced deliberately in fixture data.
         *
         * THE FILTER COVERAGE THIS COHORT EXISTS FOR IS UNAFFECTED. The shape
         * above requires two levels with a match each; charlie and zulu are both
         * level 1 and carry no submission, so `?level=1` keeps two matches and
         * nothing can disagree about them — a row that does not exist cannot
         * contradict one that does.
         *
         * `seed-consistency.spec.ts` pins the invariant so the next fixture
         * cannot drift back: no client may hold level >= 1 while carrying an
         * UNDECIDED submission.
         */
        level: 0,
        country: 'Lebanon',
        profile: { phone: '+96170000001', dateOfBirth: '1991-01-01', nationality: 'Lebanese' },
      },
      {
        local: 'bravo',
        firstName: 'Bravo',
        lastName: 'Baker',
        type: 'referral',
        status: 'active',
        level: 0,
        country: 'United Arab Emirates',
      },
      {
        local: 'charlie',
        firstName: 'Charlie',
        lastName: 'Croft',
        type: 'partner',
        status: 'active',
        level: 1,
        country: 'Cyprus',
      },
      {
        local: 'delta',
        firstName: 'Delta',
        lastName: 'Dunn',
        type: 'individual',
        /*
         * ⚠️ SUSPENDED, AND IT WAS `pending` UNTIL 11 Sep 2026 — a state NO code
         * path can produce or exit. Registration writes `active`,
         * `setClientStatus` is typed `'active' | 'suspended'`, and no migration
         * ever backfilled it, so delta was stuck there permanently and was the
         * only row in the product holding it.
         *
         * THE SWAP IS NOT COSMETIC. The cohort's comment above claims
         * "3 types x 3 statuses" coverage, and there was not ONE suspended
         * fixture — so `?status=suspended` had never had a match, and a spec
         * asserting that filter worked would have passed vacuously. Two REACHABLE
         * statuses with a match each is what the comment always claimed.
         */
        status: 'suspended',
        level: 0,
        country: 'Lebanon',
      },
      {
        local: 'zulu',
        firstName: 'Zulu',
        lastName: 'Zimmer',
        type: 'individual',
        status: 'active',
        level: 1,
        country: 'United Arab Emirates',
      },
      /*
       * The ONLY row any spec writes to. Suspension is destructive and its own
       * spec toggles it, so it must not be a client another assertion reads —
       * a shared mutable fixture is how a suite starts failing in an order that
       * depends on which test ran first.
       */
      {
        local: 'suspend-target',
        firstName: 'Sierra',
        lastName: 'Target',
        type: 'individual',
        status: 'active',
        level: 0,
        country: 'Cyprus',
      },
    ] as const;

    for (const client of e2eClients) {
      await db
        .insert(users)
        .values({
          email: `${client.local}@${E2E_DOMAIN}`,
          passwordHash: clientHash,
          firstName: client.firstName,
          lastName: client.lastName,
          type: client.type,
          status: client.status,
          emailVerified: true,
          verificationLevel: client.level,
          country: client.country,
          ...('profile' in client ? client.profile : {}),
        })
        .onConflictDoNothing({ target: users.email });
    }

    /*
     * ── The REVIEW POOL: one pending-KYC client per spec that needs one ──────
     *
     * SEEDED, for the reason the cohort above already states and this repo
     * already learned: `POST /auth/register` is capped at 10 an hour per IP.
     *
     * `mintClientWithPendingKyc` was added after that note and registers a client
     * at runtime, once per spec that needs a reviewable submission — ELEVEN of
     * them across the admin suite. So the suite cannot finish a single run inside
     * its own budget, let alone a second: the later mints answer 429, the helper
     * skips, and a skipped Playwright test reports as PASSING. Eighteen tests
     * vanished from one green run that way, including the entire payout rail.
     *
     * `verify-email` (10 per 15 minutes) is exhausted by the same path.
     *
     * ONE CLIENT PER LABEL, never a shared one. These fixtures are DECIDED by the
     * specs that use them — claimed, approved, rejected — so two specs sharing a
     * row would fail in an order that depends on which ran first, which is the
     * trap the `suspend-target` note above already records.
     *
     * ⚠️ RE-ASSERTED on every boot, not `onConflictDoNothing`. That is the
     * difference between this and alpha's submission, and it is deliberate: these
     * rows exist to BE decided, so a run that approves one must find it pending
     * again next time. Alpha's is left alone because no spec decides it and a
     * human's decision there should stick.
     */
    await reassertReviewPool(db);

    await seedTradingFixtures(db);

    /*
     * Two tags the suite owns, prefixed so they read as suite-owned in the tag
     * picker and sort together away from an operator's real segments.
     *
     * `alpha` is assigned to one client and `beta` to none, which is what lets a
     * scoping spec prove BOTH directions: a scoped admin sees the tagged client
     * and does not see the untagged one.
     */
    const [e2eTagAlpha] = await db
      .insert(clientTags)
      .values({ slug: 'e2e-alpha', label: 'E2E Alpha', color: '#0369a1' })
      .onConflictDoNothing({ target: clientTags.slug })
      .returning();

    await db
      .insert(clientTags)
      .values({ slug: 'e2e-beta', label: 'E2E Beta', color: '#b45309' })
      .onConflictDoNothing({ target: clientTags.slug });

    const alphaTagId =
      e2eTagAlpha?.id ??
      (await db.select().from(clientTags).where(eq(clientTags.slug, 'e2e-alpha')).limit(1))[0]?.id;

    const [alphaClient] = await db
      .select()
      .from(users)
      .where(eq(users.email, `alpha@${E2E_DOMAIN}`))
      .limit(1);

    if (alphaTagId && alphaClient) {
      await db
        .insert(clientTagAssignments)
        .values({ userId: alphaClient.id, tagId: alphaTagId })
        // The composite primary key IS the idempotency constraint (§6.3), so a
        // reboot re-running the seeds is a no-op rather than a duplicate-key error.
        .onConflictDoNothing();
      /*
       * A SUBMITTED (undecided) KYC row for alpha — the fixture the masking
       * specs read through the review screen (`kyc.user.*` and
       * `kyc.personalInfo.*` must both be absent for a masked reviewer). Never
       * decided by any spec: approval is terminal, and `onConflictDoNothing`
       * keeps a human decision.
       *
       * The name, phone, date of birth and nationality are alpha's PROFILE
       * (0139) and reach `personalInfo` through the review's merged view. The
       * one key stored here is `email`, and it is a deliberate PROBE rather
       * than data: no KYC form asks for it, so it stands for an answer the
       * catalogue does not name, which a masked reviewer must lose as well
       * (`kyc.personalInfo.email`, and `kyc.stepData` for unnamed keys).
       */
      await db
        .insert(kycSubmissions)
        .values({
          userId: alphaClient.id,
          status: 'submitted',
          submittedAt: new Date(),
          personalInfo: { email: `alpha@${E2E_DOMAIN}` },
          document: { docType: 'passport' },
          addressProof: { docType: 'utility_bill' },
        })
        .onConflictDoNothing({ target: kycSubmissions.userId });
    }

    /*
     * ── The RESTRICTED end-to-end admin ─────────────────────────────────────
     *
     * The identity that makes FR-RBAC-03 assertable at all. Gating cannot be
     * proved from the master's session — a spec that tried would pass while
     * demonstrating nothing.
     *
     * SEEDED rather than created through the invite flow, and that is forced:
     * there is no `DELETE /admin/users`, so an accepted invite is a PERMANENT
     * administrator row. A suite that accepted one per run would add an account
     * to the directory every time anybody ran it, and after a fortnight the
     * screen under test would be mostly test data.
     *
     * Its grant set is chosen so one identity can prove every branch:
     *
     *   /dashboard    ✅ any admin — proves the fixture is a working admin
     *   /clients      ✅ users.view — a positive case, so gating is not just "deny"
     *   /kyc          ✅ kyc.review — a second positive, different module
     *   /roles        ❌ roles.view — a denial
     *   /settings     ❌ roles.manage — a denial on a manage-level key
     *   /kyc/builder  ❌ kyc.edit — a NESTED route whose parent is allowed
     *   /audit-log    ❌ masterOnly — which no grant can satisfy
     *
     * And free, without a second fixture: `users.view` WITHOUT `users.suspend`
     * means the client list renders no Actions column and PATCH .../status 403s —
     * per-action gating inside a permitted route, which is a stronger statement
     * than per-route gating.
     *
     * The role also carries a MASK and the admin a SCOPE, so the two RBAC-03
     * dimensions are exercised by the same identity.
     */
    /*
     * A READ-ONLY compliance reviewer: `kyc.view` + `clients.view`, no
     * `kyc.review`. Exists so the suite can prove the review screen draws no
     * decision control for somebody who may not decide, and that the API
     * refuses them. Unscoped and unmasked — one variable at a time.
     */
    const [kycViewerRole] = await db
      .insert(roles)
      .values({
        name: 'E2E KYC Viewer',
        description: 'Fixture for the admin end-to-end suite. Not for human use.',
        permissions: ['kyc.view', 'clients.view'],
        maskedFields: [],
      })
      .onConflictDoNothing({ target: roles.name })
      .returning();
    const kycViewerRoleId =
      kycViewerRole?.id ??
      (await db.select().from(roles).where(eq(roles.name, 'E2E KYC Viewer')).limit(1))[0]?.id;
    if (kycViewerRoleId) {
      await db
        .insert(admins)
        .values({
          email: 'e2e-kyc-viewer@oxshare.com',
          passwordHash: adminHash,
          name: 'E2E KYC Viewer',
          role: 'sub_admin',
          roleId: kycViewerRoleId,
          permissions: ['kyc.view', 'clients.view'],
        })
        .onConflictDoNothing({ target: admins.email });
    }

    const [e2eRestrictedRole] = await db
      .insert(roles)
      .values({
        name: 'E2E Restricted',
        description: 'Fixture for the admin end-to-end suite. Not for human use.',
        permissions: ['clients.view', 'kyc.review', 'tags.view'],
        // Hidden from this identity, so a masking spec has something to assert
        // is absent from the response BODY, not merely from the screen.
        maskedFields: ['client.email'],
      })
      .onConflictDoNothing({ target: roles.name })
      .returning();

    const restrictedRoleId =
      e2eRestrictedRole?.id ??
      (await db.select().from(roles).where(eq(roles.name, 'E2E Restricted')).limit(1))[0]?.id;

    if (restrictedRoleId) {
      const [restrictedAdmin] = await db
        .insert(admins)
        .values({
          email: 'e2e-restricted@oxshare.com',
          passwordHash: adminHash,
          name: 'E2E Restricted',
          role: 'sub_admin',
          roleId: restrictedRoleId,
          permissions: ['clients.view'],
        })
        .onConflictDoNothing({ target: admins.email })
        .returning();

      const restrictedId =
        restrictedAdmin?.id ??
        (
          await db
            .select()
            .from(admins)
            .where(eq(admins.email, 'e2e-restricted@oxshare.com'))
            .limit(1)
        )[0]?.id;

      // Scoped to the alpha tag only, so exactly one seeded client is visible and
      // the rest are not — both directions provable from one fixture.
      if (restrictedId && alphaTagId) {
        await db
          .insert(adminClientTagScopes)
          .values({ adminId: restrictedId, tagId: alphaTagId, createdBy: restrictedId })
          .onConflictDoNothing();
        /*
         * The intake grant is TRUE BY DEFAULT (migration 0058) — restriction is
         * the explicit act. This fixture IS the explicit act: its purpose is to
         * prove both directions of visibility, so it must NOT see the untagged
         * pool. Re-asserted every boot, because the e2e suite depends on it the
         * way it depends on the alpha scope above.
         */
        await db
          .update(admins)
          .set({ seesUntriaged: false })
          .where(eq(admins.email, 'e2e-restricted@oxshare.com'));
      }
    }
  }

  /*
   * THE IDENTITY RECORD FOLLOWS WHAT THE SEEDS WROTE (0152).
   *
   * The seeds write KYC rows and verification levels directly, as fixtures do.
   * Everything the application writes reaches the client's record inside its
   * own transaction; this is the same routine for what the seeds wrote, run
   * only where the record is out of step, so a second boot adds nothing.
   */
  await adoptIdentityDrift(db);

  console.log(
    `🌱 Seeds applied (idempotent): master role/admin, demo client, rejection reasons${
      seedE2eFixtures() ? ', e2e cohort' : ' — e2e fixtures SKIPPED (SEED_E2E_FIXTURES=false)'
    }`,
  );
}

/**
 * The labels the admin suite leases a pending KYC submission by.
 *
 * Exported because a lease site that names a label NOT in here is a different
 * mistake from one whose fixture was decided — "you need to add a label" rather
 * than "a previous run consumed it" — and the helper cannot tell them apart
 * without seeing the list.
 */
export const REVIEW_POOL_LABELS = [
  'desk',
  'needs-attention',
  'claim',
  'decided',
  'rt',
  'rt-in',
  'auth',
  'dbl',
  'rej',
  'ui',
  'settle',
] as const;

export const E2E_POOL_DOMAIN = 'oxshare-e2e.test';

/**
 * A domain of its own for the UNBOUNDED fixtures.
 *
 * `createFreshE2eClient` mints a new client on every call and nothing ever
 * removes them, so they accumulate for as long as the database lives — 135 of
 * them here after a few days of runs. They used to share `E2E_POOL_DOMAIN` with
 * the seeded cohort, and the admin suite finds that cohort by searching for the
 * domain and reading page one, newest first. So every fresh fixture pushed
 * `Alpha Aardvark` further down, and once enough had built up the cohort slid
 * off the page entirely: 38 specs failed at once, all of them reading as a
 * broken client search on a search that was working perfectly.
 *
 * This is the SECOND time that has happened. `searchOwnClients` in the admin
 * suite records the first — the portal's registration specs shared the domain
 * and were moved off it — and raising the page size to 100 bought time rather
 * than fixing it. Unbounded fixtures and a cohort lookup cannot share a domain;
 * one of them has to move, and it is not the cohort.
 */
export const E2E_FRESH_DOMAIN = 'oxshare-e2e-fresh.test';

/**
 * Put every pooled fixture back to PENDING, UNCLAIMED and UNDECIDED.
 *
 * Extracted from `runSeeds` so it can run per E2E RUN rather than only per
 * boot. The boot-only version was correct and insufficient: these rows exist to
 * be decided, so one strict run consumes them and the next fails on fixtures a
 * previous run approved. The remedy was "restart the backend", which is exactly
 * the friction that teaches people to unset E2E_STRICT — and unsetting it turns
 * every skip back into a silent pass, which is the failure the flag exists to
 * prevent.
 *
 * ⚠️ It resets the WHOLE DECISION, not the column the queue filters on. A row
 * put back to `submitted` while still carrying `reviewedBy` is pending AND
 * claimed — a state no submission reaches on its own — and the claim specs
 * assert on exactly that pair, so they would pass against a row they did not
 * create and fail in ways that look like a claim bug.
 *
 * Scoped to `@oxshare-e2e.test` by construction: every address it touches is
 * built from a label in `REVIEW_POOL_LABELS`, so it cannot reach a real client
 * even if it were somehow invoked against a populated database.
 */
export async function reassertReviewPool(db: ReturnType<typeof getDb>): Promise<number> {
  const clientHash = await new PasswordService().hash('client123');
  const E2E_DOMAIN = E2E_POOL_DOMAIN;
  const REVIEW_POOL = REVIEW_POOL_LABELS;

  for (const label of REVIEW_POOL) {
    const email = `e2e-pool-${label}@${E2E_DOMAIN}`;
    const [pooled] = await db
      .insert(users)
      .values({
        email,
        passwordHash: clientHash,
        firstName: 'Pool',
        lastName: label,
        type: 'individual',
        status: 'active',
        emailVerified: true,
        verificationLevel: 0,
        ...POOL_PROFILE,
      })
      .onConflictDoUpdate({
        target: users.email,
        /*
         * Re-verified and re-activated: a spec that suspends one must not leave
         * the next run unable to sign in as it.
         *
         * ⚠️ AND THE VERIFICATION LEVEL, WHICH THIS OMITTED UNTIL 11 Sep 2026.
         *
         * The submission below is re-asserted to `submitted` on every boot,
         * because these rows exist to BE decided and a run that approves one
         * must find it pending again. The LEVEL was not, so an approval left it
         * at 1 permanently: next boot the submission went back to `submitted`
         * and the client stayed money-verified. That is the alpha contradiction
         * — verified while undecided — except GENERATED by the reset itself,
         * recurring after every run that approves a pool client rather than
         * sitting in one hand-written fixture.
         *
         * Found by querying the dev database rather than trusting the seed:
         * `e2e-pool-decided`, `e2e-pool-rt` and `e2e-pool-settle` were all
         * level 1 with a `submitted` submission. Three rows, in the pool whose
         * entire contract is "found pending again next time".
         *
         * The level IS part of being pending. `transactions.service.ts` refuses
         * a withdrawal on `verificationLevel < 1`, so a pool client left at 1
         * can move money with their verification in the queue — and any spec
         * using them to exercise that gate passes for the wrong reason.
         */
        /*
         * The PROFILE too (0139): it is what the submission below shows a
         * reviewer, so a spec that corrects a pool client's identity must find
         * the original again next run — the same "pending again" contract.
         */
        set: {
          emailVerified: true,
          status: 'active',
          verificationLevel: 0,
          firstName: 'Pool',
          lastName: label,
          ...POOL_PROFILE,
        },
      })
      .returning();

    const evidence = fixtureEvidence(`pool-${label}`);
    await db
      .insert(kycSubmissions)
      .values({
        userId: pooled.id,
        status: 'submitted',
        submittedAt: new Date(),
        // Identity is the profile's (above); no broker-invented answers here.
        personalInfo: {},
        ...evidence,
      })
      .onConflictDoUpdate({
        target: kycSubmissions.userId,
        set: {
          status: 'submitted',
          submittedAt: new Date(),
          reviewedAt: null,
          reviewedBy: null,
          rejectionReason: null,
          // The items returned with it, as a resubmission clears them — left
          // behind, a pending fixture carried a previous run's returned pages.
          rejectedFields: null,
          // A re-verification request is part of the decision being reset.
          reverificationRequestedAt: null,
          // And the evidence: approval re-asks the judge, which reads pages.
          ...evidence,
        },
      });
  }

  // The reset evidence and levels, on each client's record (0152).
  await adoptIdentityDrift(db);
  return REVIEW_POOL.length;
}

/**
 * Bring the identity record (0151) in step for every client these fixtures just
 * wrote the KYC rows of — the record's own repair, which adopts each client
 * `identity_drift` names. Silent, because a fixture writing the KYC rows is
 * expected here, unlike at boot; LOUD on a client it cannot adopt, because a
 * fixture the record disagrees with is a broken fixture.
 */
export async function adoptIdentityDrift(db: ReturnType<typeof getDb>): Promise<void> {
  const { failed } = await new ClientIdentityStore(db).repairDrift();
  if (failed.length > 0) {
    throw new Error(
      `identity_adopt failed for ${failed.length} fixture client(s): ${failed
        .map(({ userId, message }) => `${userId}: ${message}`)
        .join('; ')}`,
    );
  }
}

/**
 * A fixture's documents, each page ON FILE as far as the record goes.
 *
 * Approval re-asks the one judge (26 Sep 2026), and the judge reads a page by
 * its stored path — these fixtures carried a file NAME only, so every approval
 * of one was refused as "photo page missing". The paths are placeholders: no
 * object is written (dev storage is the real R2 bucket, and a fixture per run
 * would fill it), so opening one answers the route's ordinary 404. Each is
 * unique to its fixture, never another client's file.
 */
function fixtureEvidence(tag: string) {
  const page = (name: string) => `uploads/kyc/e2e-fixture-${tag}-${name}.png`;
  return {
    document: {
      docType: 'passport',
      fileName: `${tag}-passport.png`,
      frontFilePath: page('passport'),
      frontFileName: `${tag}-passport.png`,
    },
    selfie: { fileName: `${tag}-selfie.png`, filePath: page('selfie') },
    addressProof: {
      docType: 'utility_bill',
      fileName: `${tag}-bill.png`,
      filePath: page('bill'),
    },
  };
}

/** Every pool client's profile — a real, complete identity a reviewer can check. */
const POOL_PROFILE = {
  phone: '+96170000900',
  dateOfBirth: '1990-06-15',
  nationality: 'Lebanese',
  country: 'Lebanon',
  address: 'Hamra Street, Building 12',
  city: 'Beirut',
  postalCode: '1103',
} as const;

/**
 * A BRAND-NEW client with a pending KYC submission, unique to this call.
 *
 * The pool is the wrong fixture for a MONEY spec, and that distinction cost
 * four failures to find. A pooled client is REUSED, so it accumulates a wallet,
 * a ledger and claimed idempotency keys across runs — and the money specs assert
 * absolute balances. `withdrawals-desk` credits 100 under a key derived from the
 * client id, which is stable for a pooled client, so on every run after the
 * first the credit is a correctly-deduped REPLAY: no money is added and the
 * wallet still holds whatever the last run left. The spec then reads 90.00000000
 * where it expected 100.00000000 and blames the credit.
 *
 * Their own docblocks already said so — "a fresh client, because money history
 * is append-only: a seeded fixture would accumulate this run's rows into every
 * later assertion" — which stopped being true when leasing replaced registering,
 * silently, because nothing re-read the sentence.
 *
 * ## Why this is seeded rather than registered
 *
 * Registration is what the pool exists to avoid: `POST /auth/register` is capped
 * at 10/hour per IP and the suite needs more fixtures than that. Seeding the row
 * directly costs no budget at all, so freshness and the rate limit stop being a
 * trade-off — which is why this is better than both "lease and live with the
 * history" and "go back to registering".
 *
 * The KYC submission is left PENDING so a caller can approve it exactly as the
 * pooled path does; the two return the same shape and are interchangeable apart
 * from the history.
 */
export async function createFreshE2eClient(
  db: ReturnType<typeof getDb>,
): Promise<{ id: number; email: string; password: string }> {
  const password = 'client123';
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `e2e-fresh-${stamp}@${E2E_FRESH_DOMAIN}`;

  const [client] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await new PasswordService().hash(password),
      firstName: 'Fresh',
      // Unique, and a NAME: letters as on an ID (0139) — the stamp's digits are
      // spelled as letters, or approval's re-check refuses the surname.
      lastName: stamp.replace(/\d/g, (digit) => 'abcdefghij'.charAt(Number(digit))),
      type: 'individual',
      status: 'active',
      emailVerified: true,
      verificationLevel: 0,
      ...POOL_PROFILE,
      phone: '+96170000901',
    })
    .returning();

  await db.insert(kycSubmissions).values({
    userId: client.id,
    status: 'submitted',
    submittedAt: new Date(),
    // Identity is the profile's (above); no broker-invented answers here.
    personalInfo: {},
    ...fixtureEvidence(`fresh-${stamp}`),
  });
  // Its presented evidence, frozen on its record (0152).
  await db.execute(sql`SELECT identity_adopt(${client.id}::integer)`);

  return { id: client.id, email, password };
}

/**
 * THE TRADING SURFACE — the fixtures without which four whole tables are empty.
 *
 * ## Why this exists
 *
 * Measured on this dev database while closing Domain 6:
 *
 *     users 253 · wallets 364 · ledger_entries 392 · transactions 375
 *     trading_accounts 0 · mt5_deals 0 · transfers 0 · ib_accruals 0
 *
 * Four zeroes, and they are the entire trading and partner surface. The
 * consequence was not theoretical:
 *
 *  - **Domain 6's §14 legs could not be walked at all.** Every rail path needs
 *    an MT5 account, so criterion 5 was recorded as NOT CLAIMED — an
 *    environmental gap rather than unfinished work, but a gap.
 *  - **A resume-path defect hid behind it.** `makeAccount` in the transfer specs
 *    set no MT5 login, because nothing in this database ever had one — and the
 *    executor fails a transfer whose account has none, so every account in that
 *    file was invisible to the executor and the path was untested rather than
 *    under-tested.
 *  - **Domain 7 is a cross-domain SOAK**, and a soak that cannot produce the
 *    conditions it is soaking for measures the fixtures rather than the product.
 *    It would pass, and the pass would mean nothing.
 *
 * ## Idempotent, and keyed on values that identify the row
 *
 * Seeds re-run on every boot. Each insert is guarded by the natural key the
 * table already enforces — the MT5 login for an account, the deal ticket for a
 * deal — so a restart adds nothing and a wiped database is rebuilt exactly.
 *
 * ## Attached to the E2E CLIENT, never to a real one
 *
 * Every row here hangs off `e2e@oxshare.com`. If this ever runs against a
 * populated database it touches one seeded identity and nothing else — the same
 * containment `reassertReviewPool` relies on.
 *
 * ## ⚠️ TERMINAL transfers only — never a PENDING one, and the reason is sharp
 *
 * A seeded stuck transfer would not merely make log noise. `TransferResume-
 * Scheduler` raises `ALERT_KINDS.TRANSFER_STUCK` at severity **`page`** once a
 * pending transfer passes `TRANSFER_STALE_MS`, and the alarm counts the BACKLOG
 * rather than the batch — so the 0123 backoff, which bounds how often a row is
 * RETRIED, does not bound how often it is RAISED.
 *
 * A permanently-unresumable fixture would therefore page on every tick, in
 * every dev environment, from fifteen minutes after first boot, for ever. **An
 * alarm that is always firing is an alarm nobody reads, and it would take the
 * real ones with it** — the same failure as a flag that is always true, which
 * this codebase has already deleted once.
 *
 * So the stuck path is NOT a fixture. It belongs in `test/transfer-resume.spec.ts`,
 * which creates its own stuck rows, proves the starvation fix behaviourally, and
 * disappears with the container. **A fixture that never settles is a permanent
 * incident; a spec that creates one is a test.**
 *
 * Settled and failed rows give the soak what it actually needs from transfers:
 * something to list, page, sort and reconcile against.
 *
 * Ruled by the session that owns the scheduler rather than decided here.
 */
async function seedTradingFixtures(db: ReturnType<typeof getDb>): Promise<void> {
  const [client] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'e2e@oxshare.com'))
    .limit(1);

  // No e2e client means an install that has not reached that seed yet. Nothing
  // to hang fixtures off, and inventing an owner would be worse than skipping.
  if (!client) return;

  /*
   * Two accounts, LIVE and DEMO, because several behaviours differ by
   * environment — a demo account may be topped up by its owner and a live one
   * may not, and a fixture set with only one of them cannot show that.
   *
   * The logins are real-shaped numeric strings: `trading_accounts.login` is what
   * `mt5_deals.login` joins on, and the executor refuses an account without one.
   */
  const ACCOUNTS = [
    { login: '5000001', environment: 'live' as const, balance: '2500.00000000' },
    { login: '5000002', environment: 'demo' as const, balance: '10000.00000000' },
  ];

  for (const account of ACCOUNTS) {
    const [existing] = await db
      .select({ id: tradingAccounts.id })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.login, account.login))
      .limit(1);
    if (existing) continue;

    await db.insert(tradingAccounts).values({
      userId: client.id,
      login: account.login,
      environment: account.environment,
      currency: 'USD',
      balance: account.balance,
      status: 'active',
      mt5Group: 'demo\\standard',
      leverage: 100,
      name: `E2E ${account.environment}`,
    });
  }

  /*
   * Deals of BOTH kinds, which is the point rather than a detail.
   *
   * A TRADE (action 0/1) is what the commission engine accrues on. A BALANCE
   * deal (action 2) is money moved on the account with no position behind it —
   * a dealer credit or correction — and it is what
   * `GET /trading/balance-movements` exists to show a client, because it has no
   * wallet leg and no ledger entry anywhere in the CRM.
   *
   * Seeding only trades would leave that read returning `[]` for ever, which is
   * exactly the empty pass Domain 6 refused to accept as evidence.
   *
   * The balance deals are signed in BOTH directions: a credit and a debit. A
   * debit is the case with no other client-visible record in the product, and a
   * screen that renders amounts unsigned would show it as a credit.
   */
  const DEALS = [
    {
      ticket: '900001',
      login: '5000001',
      action: 0,
      entry: 1,
      profit: '125.40000000',
      comment: null,
    },
    {
      ticket: '900002',
      login: '5000001',
      action: 1,
      entry: 1,
      profit: '-38.20000000',
      comment: null,
    },
    {
      ticket: '900003',
      login: '5000001',
      action: 2,
      entry: 0,
      profit: '500.00000000',
      comment: 'Welcome bonus',
    },
    {
      ticket: '900004',
      login: '5000001',
      action: 2,
      entry: 0,
      profit: '-75.00000000',
      comment: 'Correction',
    },
    {
      ticket: '900005',
      login: '5000002',
      action: 2,
      entry: 0,
      profit: '10000.00000000',
      comment: 'Demo funding',
    },
  ];

  for (const deal of DEALS) {
    const [existing] = await db
      .select({ id: mt5Deals.id })
      .from(mt5Deals)
      .where(eq(mt5Deals.mt5DealId, deal.ticket))
      .limit(1);
    if (existing) continue;

    await db.insert(mt5Deals).values({
      mt5DealId: deal.ticket,
      login: deal.login,
      symbol: deal.action === 2 ? 'BALANCE' : 'EURUSD',
      action: deal.action,
      entry: deal.entry,
      volume: deal.action === 2 ? '0.00000000' : '1.00000000',
      price: deal.action === 2 ? '0.00000000' : '1.08500000',
      profit: deal.profit,
      commission: '0.00000000',
      swap: '0.00000000',
      comment: deal.comment,
      // Spread across recent days so a 30-day window contains them and a
      // narrower one does not — a window filter with every row on one
      // timestamp cannot be shown to work.
      dealtAt: new Date(Date.now() - DEALS.indexOf(deal) * 36 * 60 * 60 * 1000),
      source: 'sweep',
    });
  }

  /*
   * Transfers in TERMINAL states only — see the note above. One settled and one
   * failed, in both directions, so a list, a filter and a state badge all have
   * something real to render.
   *
   * Keyed on the wallet+account+amount triple rather than an id, since the id is
   * generated: re-running must not add a second copy.
   */
  const [wallet] = await db
    .select({ id: wallets.id, currency: wallets.currency })
    .from(wallets)
    .where(eq(wallets.userId, client.id))
    .limit(1);

  const [liveAccount] = await db
    .select({ id: tradingAccounts.id })
    .from(tradingAccounts)
    .where(eq(tradingAccounts.login, '5000001'))
    .limit(1);

  if (!wallet || !liveAccount) return;

  const TRANSFERS = [
    {
      direction: 'wallet_to_account' as const,
      amount: '250.00000000',
      state: 'settled' as const,
      failureReason: null,
    },
    {
      direction: 'account_to_wallet' as const,
      amount: '100.00000000',
      state: 'settled' as const,
      failureReason: null,
    },
    {
      direction: 'wallet_to_account' as const,
      amount: '75.00000000',
      state: 'failed' as const,
      failureReason: 'MT5 refused the deposit: insufficient margin',
    },
  ];

  for (const transfer of TRANSFERS) {
    const [existing] = await db
      .select({ id: transfers.id })
      .from(transfers)
      .where(
        and(
          eq(transfers.tradingAccountId, liveAccount.id),
          eq(transfers.amount, transfer.amount),
          eq(transfers.direction, transfer.direction),
        ),
      )
      .limit(1);
    if (existing) continue;

    await db.insert(transfers).values({
      userId: client.id,
      walletId: wallet.id,
      tradingAccountId: liveAccount.id,
      direction: transfer.direction,
      amount: transfer.amount,
      currency: wallet.currency,
      state: transfer.state,
      failureReason: transfer.failureReason,
      settledAt: transfer.state === 'settled' ? new Date() : null,
    });
  }
}
