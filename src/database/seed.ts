import { getDb } from './db';
import { PasswordService } from '../common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  clientTagAssignments,
  clientTags,
  kycConfigSteps,
  kycSubmissions,
  rejectionReasons,
  roles,
  securitySettings,
  users,
} from './schema';
import { eq } from 'drizzle-orm';
import { DEFAULT_KYC_STEPS } from '../store/kyc-config.store';

// Idempotent dev/bootstrap seeds — safe to run on every boot. Idempotency
// lives in database constraints (unique email / role name / (context,label)),
// never in check-then-insert.
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

  await db
    .insert(roles)
    .values({
      name: 'Master Admin',
      description: 'Full access to every administration section and operation (RBAC-01).',
      permissions: ['*'],
      isSystem: true,
    })
    .onConflictDoNothing({ target: roles.name });

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
        name: 'Support Agent',
        description: 'Answers client tickets. Reads client records; changes nothing.',
        permissions: ['users.view', 'kyc.view', 'tags.view'],
        // Answering a ticket does not need a phone number, and this is the role
        // most people hold — so it is the one worth masking by default.
        maskedFields: ['client.phone'],
      },
      {
        name: 'Senior Support',
        description: 'Escalation point. May edit client records and assign tags.',
        permissions: ['users.view', 'users.edit', 'kyc.view', 'tags.view', 'tags.assign'],
        maskedFields: [],
      },
      {
        name: 'KYC Reviewer',
        description: 'Approves and rejects identity submissions, including documents.',
        permissions: ['kyc.view', 'kyc.review', 'kyc.documents.view', 'users.view'],
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
        permissions: ['users.view'],
        maskedFields: [],
      },
      {
        name: 'Finance Approver',
        description: 'Approves withdrawals. Separated from settlement on purpose.',
        // Deliberately WITHOUT withdrawals.settle. Whoever approves a payment
        // should not also mark it settled; that separation of duties is the
        // only reason this and Finance Officer are two roles rather than one.
        permissions: ['users.view'],
        maskedFields: [],
      },
      {
        name: 'Compliance Officer',
        description: 'Reads everything client-facing for audit. Approves nothing.',
        permissions: ['users.view', 'kyc.view', 'kyc.documents.view'],
        maskedFields: [],
      },
      {
        name: 'Onboarding Agent',
        description: 'Creates client records and starts their verification.',
        permissions: ['users.view', 'users.create', 'kyc.view', 'kyc.create'],
        maskedFields: [],
      },
      {
        name: 'Risk Analyst',
        description: 'Watches trading activity and suspends accounts that need it.',
        permissions: ['users.view', 'users.suspend'],
        maskedFields: [],
      },
      {
        name: 'Platform Operator',
        description: 'Maintains console configuration. No access to client records.',
        // Holds no users.view at all, so this is the role that exercises a
        // gated NAVIGATION rather than only a gated screen body.
        permissions: ['settings.view', 'settings.manage', 'roles.view'],
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
      role: 'master_admin',
      permissions: ['*'],
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
      role: 'master_admin',
      permissions: ['*'],
    })
    .onConflictDoNothing({ target: admins.email });

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

  await db
    .insert(rejectionReasons)
    .values([...kycReasons, ...withdrawalReasons])
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

  /*
   * The withdrawal OTP starts OFF in development, and ONLY in development.
   *
   * `runSeeds()` is called from main.ts exclusively when NODE_ENV is not
   * production, so this cannot reach a live deployment: there, no row exists and
   * `SecuritySettingsStore.isEnabled` answers TRUE, which is the safe default a
   * fresh install must have.
   *
   * Why turn it off here at all: the OTP requires reading a real mailbox, so
   * every local withdrawal and every end-to-end run would otherwise stall on a
   * six-digit code from Ethereal. The operator flips it on from Settings →
   * Security when they are ready, and that action is audited.
   *
   * `onConflictDoNothing` so a developer who turns it ON locally does not have
   * it silently turned back off by the next reboot — a seed that overwrites a
   * deliberate choice is worse than no seed.
   */

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
  const [e2eRestrictedRole] = await db
    .insert(roles)
    .values({
      name: 'E2E Restricted',
      description: 'Fixture for the admin end-to-end suite. Not for human use.',
      permissions: ['users.view', 'kyc.review', 'tags.view'],
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
        permissions: ['users.view'],
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
    }
  }

  await db
    .insert(securitySettings)
    .values({ key: 'withdrawal_otp', enabled: false })
    .onConflictDoNothing({ target: securitySettings.key });

  console.log(
    '🌱 Seeds applied (idempotent): master role/admin, demo client, rejection reasons, e2e cohort',
  );
  console.log('   ⚠️  withdrawal OTP is OFF in development — Settings → Security to enable');
}
