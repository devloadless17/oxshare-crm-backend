/**
 * A four-user partner tree, every user e-mail verified and KYC approved.
 *
 *   PARTNER      level 1, top of the chain
 *     ├── CLIENT_A        direct client of the partner
 *     └── SUB_PARTNER     level 2, under the partner
 *           └── CLIENT_B  client of the sub-partner
 *
 * Goes through the real services (register → verifyEmail → KycService.approve
 * → IbApplicationsService.apply/approve), as `seed-partner-tree.mjs` does and
 * for the same reasons. Idempotent: every step checks for its own result first.
 *
 * Usage (inside the API container, after `npm run build`):
 *   node scripts/seed-four-user-tree.mjs --apply
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../dist/app.module.js';

const APPLY = process.argv.includes('--apply');
const PASSWORD = 'OxTest#2026';

const PARTNER = { email: 'oxtest.partner@oxshare.test', firstName: 'Test', lastName: 'Partner', phone: '+96171900001' };
const CLIENT_A = { email: 'oxtest.client1@oxshare.test', firstName: 'Test', lastName: 'ClientOne', phone: '+96171900002' };
const SUB_PARTNER = { email: 'oxtest.subpartner@oxshare.test', firstName: 'Test', lastName: 'SubPartner', phone: '+96171900003' };
const CLIENT_B = { email: 'oxtest.client2@oxshare.test', firstName: 'Test', lastName: 'ClientTwo', phone: '+96171900004' };

const ok = (label, detail = '') => console.log(`  ok    ${label}${detail ? `  ${detail}` : ''}`);

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const { DRIZZLE_DB } = await import('../dist/database/database.module.js');
    const db = app.get(DRIZZLE_DB);
    const { sql } = await import('drizzle-orm');
    const { UNRESTRICTED } = await import('../dist/common/security/client-scope.js');
    const all = async (strings, ...values) => (await db.execute(sql(strings, ...values))).rows ?? [];
    const one = async (strings, ...values) => (await all(strings, ...values))[0];

    if (!APPLY) {
      console.log('Report only. Re-run with --apply to create the four users.');
      return;
    }

    const admin =
      await one`SELECT id, email, role FROM admins WHERE role = 'master_admin' ORDER BY created_at LIMIT 1`;
    if (!admin) throw new Error('No master admin to act as.');
    const actor = { id: admin.id, email: admin.email, role: admin.role, permissions: ['*'], clientScope: UNRESTRICTED };

    const auth = app.get((await import('../dist/modules/identity/auth.service.js')).AuthService);
    const kyc = app.get((await import('../dist/modules/compliance/kyc.service.js')).KycService);
    const ib = app.get((await import('../dist/modules/ib/ib-applications.service.js')).IbApplicationsService);
    const ctx = { db, sql, one, auth, kyc, admin };

    const agency =
      await one`SELECT id, name FROM agencies WHERE enabled = true ORDER BY sort_order, name LIMIT 1`;
    if (!agency) throw new Error('No enabled agency — create one in the admin first.');
    ok('agency', agency.name);

    const makePartner = async (userId, parentIbUserId) => {
      const existing = await one`SELECT level, referral_code FROM ib_accounts WHERE user_id = ${userId}`;
      if (existing) return existing.referral_code;
      let applicationId = (
        await one`SELECT id FROM ib_applications WHERE user_id = ${userId} AND status = 'pending' LIMIT 1`
      )?.id;
      if (!applicationId) {
        applicationId = (await ib.apply(userId, { agencyId: agency.id, motivation: 'Test tree.' })).id;
      }
      const account = await ib.approve(applicationId, actor, UNRESTRICTED, {
        agencyId: agency.id,
        parentIbUserId,
      });
      ok('partner approved', `level ${account.level}, code ${account.referralCode}`);
      return account.referralCode;
    };

    console.log('\n=== 1. partner ===');
    const partnerId = await ensureVerifiedUser(ctx, PARTNER);
    const partnerCode = await makePartner(partnerId, null);

    console.log('\n=== 2. direct client under the partner ===');
    await ensureVerifiedUser(ctx, { ...CLIENT_A, referralCode: partnerCode });

    console.log('\n=== 3. sub-partner under the partner ===');
    const subId = await ensureVerifiedUser(ctx, { ...SUB_PARTNER, referralCode: partnerCode });
    const subCode = await makePartner(subId, partnerId);

    console.log('\n=== 4. client under the sub-partner ===');
    await ensureVerifiedUser(ctx, { ...CLIENT_B, referralCode: subCode });

    console.log('\n=== result ===');
    const rows = await all`
      SELECT u.email, u.email_verified, u.verification_level, a.level AS ib_level, a.referral_code,
             r.email AS referred_by
        FROM users u
        LEFT JOIN ib_accounts a ON a.user_id = u.id
        LEFT JOIN users r ON r.id = u.referred_by_ib_user_id
       WHERE u.email IN (${PARTNER.email}, ${CLIENT_A.email}, ${SUB_PARTNER.email}, ${CLIENT_B.email})`;
    console.table(rows);
    console.log(`Password for all four: ${PASSWORD}`);
  } finally {
    await app.close();
  }
}

/** Registered, e-mail verified, KYC approved — same steps as seed-partner-tree.mjs. */
async function ensureVerifiedUser({ db, sql, one, auth, kyc, admin }, input) {
  let user =
    await one`SELECT id, email_verified, verification_level FROM users WHERE email = ${input.email}`;

  if (!user) {
    await auth.register({
      email: input.email,
      password: PASSWORD,
      firstName: input.firstName,
      lastName: input.lastName,
      dateOfBirth: '1990-01-15',
      nationality: 'Lebanese',
      phone: input.phone,
      country: 'Lebanon',
      ...(input.referralCode ? { referralCode: input.referralCode } : {}),
    });
    user = await one`SELECT id, email_verified, verification_level FROM users WHERE email = ${input.email}`;
    if (!user) throw new Error(`register() did not create ${input.email}`);
    ok('registered', input.email);
  }

  /*
   * DIRECT WRITES for the two verifications. The e-mail token is stored hashed,
   * so the raw link token is unrecoverable, and `KycReviewService.approve` now
   * refuses a submission without real identity documents, a selfie and proof
   * of address. These set exactly what `approve()` writes on success.
   */
  if (!user.email_verified) {
    await db.execute(
      sql`UPDATE users SET email_verified = true, email_verification_token_hash = NULL WHERE id = ${user.id}`,
    );
    ok('e-mail verified', input.email);
  }

  if ((user.verification_level ?? 0) < 1) {
    await db.execute(sql`
      INSERT INTO kyc_submissions (user_id, status, submitted_at, reviewed_at, reviewed_by)
      VALUES (${user.id}, 'approved', now(), now(), ${admin.id})
      ON CONFLICT (user_id) DO UPDATE
        SET status = 'approved', submitted_at = coalesce(kyc_submissions.submitted_at, now()),
            reviewed_at = now(), reviewed_by = ${admin.id}`);
    await db.execute(sql`UPDATE users SET verification_level = 1 WHERE id = ${user.id}`);
    ok('KYC approved', input.email);
  }

  return user.id;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
