import { getDb } from './db';
import { PasswordService } from '../common/security/password.service';
import { admins, kycConfigSteps, rejectionReasons, roles, users } from './schema';
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

  console.log('🌱 Seeds applied (idempotent): master role/admin, demo client, rejection reasons');
}
