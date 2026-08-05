import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { kycSubmissions, users } from '../src/database/schema';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { KycService } from '../src/modules/compliance/kyc.service';
import { KycStore } from '../src/store/kyc.store';
import { KycConfigStore } from '../src/store/kyc-config.store';
import { UsersStore } from '../src/store/users.store';
import { MoneyLimits } from '../src/config/money-limits';
import type { EmailService } from '../src/modules/email/email.service';
import { AuthorizationError } from '../src/common/errors/domain-errors';

/** `reviewed_by` is a uuid column, so the reviewer needs a real one. */
const ADMIN_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_ADMIN_ID = '99999999-8888-7777-6666-555555555555';

/**
 * KYC gates the money path — the acceptance criterion, proven end to end.
 *
 * FR-CORE-15 is explicit: "Key funded features shall remain blocked until the
 * account reaches Level 1." That sentence spans two modules — compliance sets
 * the level, payments reads it — and neither module's own tests can prove it,
 * because each one is right in isolation. This runs the real services against
 * real Postgres and follows a single client across the whole transition.
 *
 * It also pins the defect this slice found: `reject()` used to leave
 * `verificationLevel` at 1, so an admin who approved by mistake and then
 * rejected left the client REJECTED and still able to withdraw. The status said
 * no while the money path said yes.
 */

let ctx: MoneyTestContext;
let wallets: WalletService;
let txService: TransactionsService;
let kyc: KycService;

const emailStub = {
  sendKycDecisionEmail: () => Promise.resolve(),
} as unknown as EmailService;

/** Emails are captured rather than sent; delivery is not what this proves. */
function limits(): MoneyLimits {
  return new MoneyLimits({ get: () => undefined } as never);
}

async function makeUnverifiedClient(email: string): Promise<string> {
  const [row] = await ctx.db
    .insert(users)
    .values({
      email,
      passwordHash: 'x',
      firstName: 'Kay',
      lastName: 'Why-See',
      verificationLevel: 0,
      emailVerified: true,
    })
    .returning();
  return row.id;
}

/** A submission with all three mandated documents plus the profile step. */
async function submitCompleteKyc(userId: string): Promise<void> {
  await ctx.db.insert(kycSubmissions).values({
    userId,
    status: 'submitted',
    submittedAt: new Date(),
    personalInfo: { firstName: 'Kay', lastName: 'Why-See', dateOfBirth: '1990-01-01' },
    document: { docType: 'passport', frontFilePath: '/uploads/kyc/front.png' },
    selfie: { filePath: '/uploads/kyc/selfie.png' },
    addressProof: { docType: 'utility_bill', filePath: '/uploads/kyc/address.png' },
  });
}

const withdraw = (userId: string) =>
  txService.requestWithdrawal({
    userId,
    amount: '25.00000000',
    currency: 'USD',
    provider: 'whish',
    destination: 'whish-account-1',
  });

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);
  txService = new TransactionsService(wallets, ctx.db, limits());
  // The real config store against the real (seeded) database — `submit()` reads
  // the configured profile fields from it. This suite only calls approve/reject,
  // which do not touch it, but constructing the service honestly is what keeps
  // it a test of the real wiring rather than of a convenient subset.
  kyc = new KycService(
    emailStub,
    new KycStore(ctx.db),
    new UsersStore(ctx.db),
    new KycConfigStore(ctx.db),
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
  await closeDb();
});

describe('a funded feature is blocked until level 1, and blocked again after rejection', () => {
  it('follows one client across the whole transition', async () => {
    const userId = await makeUnverifiedClient('kyc-gate@oxshare.com');
    // Funded, so nothing below can pass or fail for lack of money.
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '500.00000000',
      entryType: 'deposit',
      referenceType: 'deposit',
      referenceId: `seed-${userId}`,
    });

    // ── Level 0: refused. This is the gate FR-CORE-15 requires.
    await expect(withdraw(userId)).rejects.toThrow(AuthorizationError);

    // ── Submitting is not approval. A client cannot verify themselves by
    //    uploading documents; an administrator has to review them.
    await submitCompleteKyc(userId);
    await expect(withdraw(userId)).rejects.toThrow(AuthorizationError);

    // ── Approved by an admin → level 1 → the feature unlocks.
    await kyc.approve(userId, ADMIN_ID);
    const [afterApproval] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(afterApproval.verificationLevel).toBe(1);

    const withdrawal = await withdraw(userId);
    expect(withdrawal.state).toBe('pending');

    // ── Rejected after approval → the level is taken back and the gate closes.
    //    REGRESSION: reject() did not touch verificationLevel, so a client
    //    rejected after a mistaken approval kept withdrawing.
    await kyc.reject(userId, ADMIN_ID, 'Approved in error', []);
    const [afterRejection] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(afterRejection.verificationLevel).toBe(0);

    await expect(withdraw(userId)).rejects.toThrow(AuthorizationError);
  });

  it('refuses to approve a submission the client never submitted', async () => {
    // Approval is a decision about evidence. `in_progress` holds none, and
    // approving it would unlock withdrawals on the strength of nothing.
    const userId = await makeUnverifiedClient('kyc-halfway@oxshare.com');
    await ctx.db.insert(kycSubmissions).values({ userId, status: 'in_progress' });

    await expect(kyc.approve(userId, ADMIN_ID)).rejects.toThrow(/submitted/i);

    const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(user.verificationLevel).toBe(0);
  });

  it('leaves the level alone when a second approval is refused', async () => {
    // Approving twice is a no-op, not a second promotion — and must not be a
    // route to re-verifying someone who was rejected in between.
    const userId = await makeUnverifiedClient('kyc-twice@oxshare.com');
    await submitCompleteKyc(userId);

    await kyc.approve(userId, ADMIN_ID);
    await expect(kyc.approve(userId, OTHER_ADMIN_ID)).rejects.toThrow(/already approved/i);

    const [user] = await ctx.db.select().from(users).where(eq(users.id, userId));
    expect(user.verificationLevel).toBe(1);
  });
});
