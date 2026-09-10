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
  rejectionReasons,
  roles,
  users,
} from './schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { DEFAULT_KYC_STEPS } from '../store/kyc-config.store';
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
        personalInfo: {
          firstName: 'Eve',
          lastName: 'Endtoend',
          dateOfBirth: '1990-01-01',
          nationality: 'Lebanon',
          country: 'United Arab Emirates',
          phone: '+971500000000',
        },
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

  await db
    .insert(rejectionReasons)
    .values([...kycReasons, ...withdrawalReasons, ...partnerReasons])
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
      level: 1,
      country: 'Lebanon',
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
      status: 'pending',
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
      })
      .onConflictDoNothing({ target: users.email });
  }

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
     * A SUBMITTED (undecided) KYC row for alpha, carrying the person's email
     * and phone under `personalInfo.*` — the fixture the masking specs read
     * through the review screen (`kyc.user.*` and `kyc.personalInfo.*` must
     * both be absent for a masked reviewer). Never decided by any spec:
     * approval is terminal, and `onConflictDoNothing` keeps a human decision.
     */
    await db
      .insert(kycSubmissions)
      .values({
        userId: alphaClient.id,
        status: 'submitted',
        submittedAt: new Date(),
        personalInfo: {
          firstName: 'Alpha',
          lastName: 'Aardvark',
          email: `alpha@${E2E_DOMAIN}`,
          phone: '+96170000001',
          dateOfBirth: '1991-01-01',
          nationality: 'Lebanon',
          country: 'Lebanon',
        },
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

  console.log(
    '🌱 Seeds applied (idempotent): master role/admin, demo client, rejection reasons, e2e cohort',
  );
}
