import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { KycService } from '../src/modules/compliance/kyc.service';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { TransfersService } from '../src/modules/payments/transfers.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { MoneyLimits } from '../src/config/money-limits';
import { KycStore } from '../src/store/kyc.store';
import { UsersStore } from '../src/store/users.store';
import { KycConfigStore } from '../src/store/kyc-config.store';
import { StoredObjectsStore } from '../src/store/stored-objects.store';
import { auditStubAs } from './audit-stub';
import type { EmailService } from '../src/modules/email/email.service';
import { emailStubAs } from './email-stub';
import { notificationsStubAs } from './notifications-stub';
import { storedFilesStub } from './storage-stub';
import { transferExecutorStubAs, transfersStubAs } from './transfer-chain-stub';
import { gatewayStubAs } from './gateway-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * THE KYC GATE ON THE MONEY PATH — cited by two files, and until now absent.
 *
 * `kyc.service.ts:626` says taking the level back from an already-approved
 * client "is exactly what `test/kyc-gates-money.spec.ts` pins", and
 * `kyc-service.spec.ts:130` says the atomicity of that write "is proven against
 * real Postgres in test/kyc-gates-money.spec.ts". **Neither was true.** The file
 * did not exist. Two comments asserted a guarantee that nothing checked — the
 * same shape as the append-only ledger trigger, and on the same kind of path.
 *
 * ## The defect it exists to catch is one this project has already shipped
 *
 * `approve()` raises `verificationLevel` to 1 and, before the fix that
 * `kyc.service.ts:648` records, nothing lowered it. An admin who approved by
 * mistake and then rejected left the client REJECTED and still VERIFIED — the
 * status said no while the money path said yes. That is not a cosmetic
 * mismatch: level 1 is what `requestWithdrawal` checks, so the client kept the
 * ability to take money out of an account whose verification had been refused.
 *
 * ## Why it asserts the REFUSAL and not the column
 *
 * `verificationLevel = 0` is a fact about a row. "The withdrawal is refused" is
 * the property anybody actually cares about, and the two can come apart — a
 * later change that reads a different column, caches the level, or checks it
 * before the rejection commits would leave the column correct and the gate
 * open. So the money path is driven for real, through the real
 * `TransactionsService` against real Postgres.
 *
 * **And it asserts WHICH refusal.** `requestWithdrawal` validates the currency,
 * the method and the destination BEFORE it reads the user, so a broken fixture
 * fails earlier for an unrelated reason — and a test asserting only "it threw"
 * would pass on that, proving nothing about KYC at all. Every case below pins
 * the message.
 */

const KYC_REFUSAL = /verified account \(KYC level 1\)/i;

let ctx: MoneyTestContext;
let kyc: KycService;
let transactions: TransactionsService;
let transfers: TransfersService;
let wallets: WalletService;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const db = ctx.db;

  wallets = new WalletService(ctx.db);
  const currencies = new CurrenciesService(ctx.db, auditStubAs());
  transactions = new TransactionsService(
    wallets,
    ctx.db,
    new MoneyLimits(new ConfigService()),
    new PaymentMethodsService(
      ctx.db,
      currencies,
      auditStubAs(),
      gatewayStubAs(),
      new MoneyLimits(new ConfigService()),
    ),
    currencies,
    gatewayStubAs(),
    new ConfigService(),
    emailStubAs(),
    notificationsStubAs(),
    transfersStubAs(),
    transferExecutorStubAs(),
  );

  /*
   * THE SECOND DOOR. `verificationLevel` is read in TWO places — withdrawals at
   * transactions.service.ts:724 and wallet→trading-account transfers at
   * transfers.service.ts:108 — and a file that drives only one of them stays
   * green when the other is removed. Proved by mutation rather than argued:
   * deleting the transfer gate leaves every withdrawal assertion here passing,
   * so a change that "moved the KYC check into a guard" could take one door out
   * and this file would not notice. Two independent reads of one field are
   * exactly the pair that drifts. Found by `crm-6a`.
   */
  transfers = new TransfersService(wallets, currencies, ctx.db, notificationsStubAs());

  /*
   * The REAL stores against the REAL database. The point of this file is the
   * atomicity of a transaction, which a stubbed store cannot have — that is
   * exactly what `kyc-service.spec.ts` defers here.
   */
  /*
   * The shared email stub carries no `sendKycDecisionEmail`, and `approve`
   * calls it after the transaction commits — so the generic stub fails the case
   * AFTER the thing under test has already succeeded, which reads as the
   * decision path being broken. Same shape as the local stub in
   * `kyc-service.spec.ts:87`.
   */
  const kycEmail = {
    sendKycDecisionEmail: vi.fn().mockResolvedValue(undefined),
  } as unknown as EmailService;

  kyc = new KycService(
    kycEmail,
    storedFilesStub(),
    new KycStore(db, new StoredObjectsStore(db)),
    new UsersStore(db),
    new KycConfigStore(db),
    db,
    notificationsStubAs(),
  );
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO admins (email, password_hash, name, role, permissions)
    VALUES ('gate-reviewer@oxshare.com', 'x', 'Gate Reviewer', 'master_admin', '["*"]'::jsonb)
    RETURNING id
  `);
  ADMIN_ID = rows[0].id;
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

/*
 * A REAL admin row. `kyc_submissions.reviewed_by` carries a foreign key to
 * `admins`, so a made-up uuid fails the whole transaction inside `approve` —
 * which is a fixture problem that presents as the decision path being broken.
 */
let ADMIN_ID = '';

/** A client with a funded wallet and a KYC submission waiting for a decision. */
async function makeClientAwaitingReview(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Gate', 'Subject', 0, true)
    RETURNING id
  `);
  const userId = rows[0].id;
  await wallets.post({
    userId,
    currency: 'USD',
    amount: '1000',
    entryType: 'deposit',
    referenceType: 'transaction',
    referenceId: `seed-${userId}`,
  });
  await ctx.db.execute(sql`
    INSERT INTO kyc_submissions (user_id, status, submitted_at)
    VALUES (${userId}, 'submitted', now())
  `);
  return userId;
}

const withdraw = (userId: string) =>
  transactions.requestWithdrawal({
    userId,
    currency: 'USD',
    amount: '100',
    destination: '+961 3 123 456',
    methodKey: 'whish',
  });

async function levelOf(userId: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ verification_level: number }>(
    sql`SELECT verification_level FROM users WHERE id = ${userId}`,
  );
  return Number(rows[0].verification_level);
}

async function statusOf(userId: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ status: string }>(
    sql`SELECT status FROM kyc_submissions WHERE user_id = ${userId}`,
  );
  return rows[0].status;
}

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM transactions`);
});

describe('the KYC gate on withdrawals', () => {
  it('REFUSES a withdrawal for an unverified client, naming KYC', async () => {
    const userId = await makeClientAwaitingReview('gate-unverified@oxshare.com');
    expect(await levelOf(userId)).toBe(0);

    await expect(withdraw(userId)).rejects.toThrow(KYC_REFUSAL);
  });

  it('lets an APPROVED client through — the positive control', async () => {
    /*
     * Without this the case above passes against a fixture that never reaches
     * the KYC check at all: a bad currency, a disabled method or a malformed
     * destination all throw earlier. This is what proves the gate is the thing
     * being tested, and it is why the message is asserted rather than the fact
     * of a throw.
     */
    const userId = await makeClientAwaitingReview('gate-approved@oxshare.com');
    await kyc.approve(userId, ADMIN_ID);

    expect(await levelOf(userId)).toBe(1);
    await expect(withdraw(userId)).resolves.toBeDefined();
  });
});

describe('the KYC gate on wallet-to-account transfers — the SECOND door', () => {
  /*
   * `transfers.request` reads the same field as `requestWithdrawal` and refuses
   * with its own message. The gate fires BEFORE the trading account is looked
   * up, so a level-0 client is refused without one — which is why the negative
   * case needs no account fixture.
   *
   * The positive control therefore asserts the refusal CHANGES rather than
   * disappears: at level 1 the request gets past the KYC line and fails later,
   * on the account that does not exist. That is weaker than the withdrawal
   * positive control, which actually succeeds, and it is stated rather than
   * hidden — without it, "level 0 throws" would be satisfied by a gate that
   * refuses everybody.
   */
  const transfer = (userId: string) =>
    transfers.request({
      userId,
      tradingAccountId: '00000000-0000-4000-8000-0000000000ff',
      direction: 'wallet_to_account',
      amount: '10',
      currency: 'USD',
    });

  it('REFUSES a transfer for an unverified client, naming KYC', async () => {
    const userId = await makeClientAwaitingReview('gate-transfer-unverified@oxshare.com');
    await expect(transfer(userId)).rejects.toThrow(/verified account \(KYC level 1\)/i);
  });

  it('lets an APPROVED client past the KYC line — it fails later, elsewhere', async () => {
    const userId = await makeClientAwaitingReview('gate-transfer-approved@oxshare.com');
    await kyc.approve(userId, ADMIN_ID);
    expect(await levelOf(userId)).toBe(1);

    await expect(
      transfer(userId),
      'an approved client is still being refused by the KYC gate on transfers',
    ).rejects.not.toThrow(/verified account \(KYC level 1\)/i);
  });

  it('closes again when a mistaken approval is rejected', async () => {
    const userId = await makeClientAwaitingReview('gate-transfer-mistake@oxshare.com');
    await kyc.approve(userId, ADMIN_ID);
    await kyc.reject(userId, ADMIN_ID, 'Approved in error.', []);

    await expect(
      transfer(userId),
      'the withdrawal door closed on rejection and this one stayed open',
    ).rejects.toThrow(/verified account \(KYC level 1\)/i);
  });
});

describe('a rejection AFTER a mistaken approval', () => {
  it('takes the level back, so the money path closes again', async () => {
    /*
     * The shipped defect this file is named for. approve() raised the level and
     * nothing lowered it, so a client who was approved by mistake and then
     * rejected was REJECTED and still VERIFIED — status saying no, money path
     * saying yes.
     */
    const userId = await makeClientAwaitingReview('gate-mistake@oxshare.com');

    await kyc.approve(userId, ADMIN_ID);
    expect(await levelOf(userId)).toBe(1);
    await expect(withdraw(userId)).resolves.toBeDefined();

    await kyc.reject(userId, ADMIN_ID, 'Approved in error.', []);

    expect(await statusOf(userId)).toBe('rejected');
    expect(await levelOf(userId), 'a rejected client is still verified').toBe(0);
    await expect(
      withdraw(userId),
      'the status says rejected and the money path still says yes',
    ).rejects.toThrow(KYC_REFUSAL);
  });

  it('lands the status and the level TOGETHER — atomicity, on real Postgres', async () => {
    /*
     * What `kyc-service.spec.ts:130` defers here. Those are unit tests over
     * stubbed stores with a transparent transaction stub, so they can prove the
     * calls happen and cannot prove they commit together.
     *
     * The observable half of atomicity without fault injection: a REFUSED
     * transition must move NOTHING. `reject` writes the status through a
     * conditional `UPDATE … WHERE status IN (…)` and only then lowers the
     * level — so an implementation that lowered the level outside that guard,
     * or before the rowcount check, would strip verification from a client
     * whose rejection was refused. That client would be unable to withdraw,
     * with an approved submission on file and nothing anywhere explaining it.
     */
    const userId = await makeClientAwaitingReview('gate-atomic@oxshare.com');
    await kyc.approve(userId, ADMIN_ID);
    await kyc.reject(userId, ADMIN_ID, 'First rejection.', []);
    expect(await levelOf(userId)).toBe(0);

    // Put it back to approved, then attempt a transition the guard refuses.
    await ctx.db.execute(
      sql`UPDATE kyc_submissions SET status = 'approved' WHERE user_id = ${userId}`,
    );
    await ctx.db.execute(sql`UPDATE users SET verification_level = 1 WHERE id = ${userId}`);
    await ctx.db.execute(
      sql`UPDATE kyc_submissions SET status = 'not_started' WHERE user_id = ${userId}`,
    );

    await expect(kyc.reject(userId, ADMIN_ID, 'Never submitted.', [])).rejects.toThrow();

    expect(await statusOf(userId), 'a refused rejection moved the status').toBe('not_started');
    expect(
      await levelOf(userId),
      'a REFUSED rejection stripped the level anyway — the two writes are not atomic',
    ).toBe(1);
  });

  it('refuses to reject a submission that was never submitted', async () => {
    // The other half of the sentence in kyc.service.ts:626 — "what it will NOT
    // do is reject a submission that was never submitted."
    const userId = await makeClientAwaitingReview('gate-notstarted@oxshare.com');
    await ctx.db.execute(
      sql`UPDATE kyc_submissions SET status = 'not_started' WHERE user_id = ${userId}`,
    );

    await expect(kyc.reject(userId, ADMIN_ID, 'Nothing to reject.', [])).rejects.toThrow(
      /only a submitted kyc can be rejected/i,
    );
  });
});
