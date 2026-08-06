import { getDb } from './db';
import { PasswordService } from '../common/security/password.service';
import {
  admins,
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
  await db
    .insert(securitySettings)
    .values({ key: 'withdrawal_otp', enabled: false })
    .onConflictDoNothing({ target: securitySettings.key });

  console.log('🌱 Seeds applied (idempotent): master role/admin, demo client, rejection reasons');
  console.log('   ⚠️  withdrawal OTP is OFF in development — Settings → Security to enable');
}
