import { OfferedCountriesStore } from '../src/store/offered-countries.store';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { KycReviewService } from '../src/modules/compliance/kyc-review.service';
import { ClientProfileService } from '../src/modules/profile/client-profile.service';
import { KycIdentityReview } from '../src/modules/compliance/kyc-identity-review';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { TransfersService } from '../src/modules/payments/transfers.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { KycStore } from '../src/store/kyc.store';
import { UsersStore } from '../src/store/users.store';
import { AdminsStore } from '../src/store/admins.store';
import { KycConfigStore } from '../src/store/kyc-config.store';
import { auditStubAs } from './audit-stub';
import { AuditLogStore } from '../src/store/audit-log.store';
import type { EmailService } from '../src/modules/email/email.service';
import { emailStubAs } from './email-stub';
import { notificationsStubAs } from './notifications-stub';
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
let kyc: KycReviewService;
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
    new PaymentMethodsService(ctx.db, currencies, auditStubAs(), gatewayStubAs()),
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

  kyc = new KycReviewService(
    kycEmail,
    new KycStore(db),
    new UsersStore(db),
    new KycConfigStore(db),
    db,
    notificationsStubAs(),
    // Appended LAST, matching the constructor: resolves the holder's name when a
    // decision is refused because another reviewer is holding the submission.
    new AdminsStore(db),
    // The one write path for the client's identity (0139), on the real tables.
    new ClientProfileService(
      db,
      new UsersStore(db),
      new AuditLogStore(db),
      // The review's state, through the port the KYC layer provides.
      new KycIdentityReview(new KycStore(db)),
      new OfferedCountriesStore(db),
    ),
  );
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO admins (email, password_hash, name, role, permissions)
    VALUES ('gate-reviewer@oxshare.com', 'x', 'Gate Reviewer', 'master_admin', '["*"]'::jsonb)
    RETURNING id
  `);
  ADMIN_ID = rows[0].id;

  const second = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO admins (email, password_hash, name, role, permissions)
    VALUES ('gate-colleague@oxshare.com', 'x', 'Gate Colleague', 'master_admin', '["*"]'::jsonb)
    RETURNING id
  `);
  OTHER_ADMIN_ID = second.rows[0].id;
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
/** A SECOND real reviewer — the claim guard is about two people, not one. */
let OTHER_ADMIN_ID = '';

/** A client with a funded wallet and a KYC submission waiting for a decision. */
async function makeClientAwaitingReview(email: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
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

const withdraw = (userId: number) =>
  transactions.requestWithdrawal({
    userId,
    currency: 'USD',
    amount: '100',
    destination: '+961 3 123 456',
    methodKey: 'whish',
  });

async function levelOf(userId: number): Promise<number> {
  const { rows } = await ctx.db.execute<{ verification_level: number }>(
    sql`SELECT verification_level FROM users WHERE id = ${userId}`,
  );
  return Number(rows[0].verification_level);
}

async function statusOf(userId: number): Promise<string> {
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
  const transfer = (userId: number) =>
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

describe('a claim actually reserves the submission', () => {
  /*
   * ## The defect
   *
   * `approve` transitioned out of `under_review` without asking WHO held it, so
   * a reviewer could decide a submission a colleague had open — silently,
   * taking the claim with them. The colleague's screen still showed a
   * submission they believed was theirs, and `reviewed_by` named somebody else.
   *
   * ## Why this file rather than the unit suite
   *
   * The unit suite pins the refusal and its message. It cannot pin the part
   * that matters, because the guard is a WHERE clause: the service read is only
   * there to produce a sentence, and two reviewers who both read before either
   * writes both pass it. Only a real database can be asked to pick a winner.
   */
  it('refuses a decision by anyone but the holder', async () => {
    const userId = await makeClientAwaitingReview('claim-guard@oxshare.com');
    await kyc.claim(userId, ADMIN_ID);

    await expect(kyc.approve(userId, OTHER_ADMIN_ID)).rejects.toThrow(/Gate Reviewer/);

    // Nothing moved: not the status, and — the part that would be silent — not
    // the money gate behind it.
    expect(await statusOf(userId)).toBe('under_review');
    expect(await levelOf(userId)).toBe(0);
  });

  it('lets the holder decide, and records THEM as the reviewer', async () => {
    const userId = await makeClientAwaitingReview('claim-holder@oxshare.com');
    await kyc.claim(userId, ADMIN_ID);

    await kyc.approve(userId, ADMIN_ID);

    expect(await statusOf(userId)).toBe('approved');
    const { rows } = await ctx.db.execute<{ reviewed_by: string }>(
      sql`SELECT reviewed_by FROM kyc_submissions WHERE user_id = ${userId}`,
    );
    expect(rows[0].reviewed_by).toBe(ADMIN_ID);
  });

  /**
   * ⚠️ A CLAIM RESERVES; A COMPLETED DECISION DOES NOT.
   *
   * The first version of the claim guard put `reviewed_by IS NULL OR = me` in
   * the WHERE with no reference to status — and every DECIDED row carries a
   * reviewer. So the moment admin A approved, `reviewed_by` was A for good and
   * no other admin could ever reject it: the guard silently removed the
   * correction path that `reject`'s deliberately wider `from` list exists to
   * provide.
   *
   * It is exactly the failure this guard was written to prevent, pointed the
   * other way — a control that looks right and quietly takes a capability away —
   * so it is pinned here rather than left to the adversarial suite that caught
   * it.
   */
  it('still lets a DIFFERENT admin reject a submission someone else approved', async () => {
    const userId = await makeClientAwaitingReview('claim-correction@oxshare.com');

    await kyc.approve(userId, ADMIN_ID);
    expect(await levelOf(userId)).toBe(1);

    await kyc.reject(userId, OTHER_ADMIN_ID, 'Approved in error — document was expired.');

    expect(await statusOf(userId)).toBe('rejected');
    // The half that would be a real defect: a client left verified by an
    // approval the desk has since reversed.
    expect(await levelOf(userId)).toBe(0);
  });

  /**
   * TWO REVIEWERS, ONE PASSPORT, AT THE SAME INSTANT.
   *
   * Both calls read an unclaimed `submitted` row, so both pass every check in
   * the service. Exactly one may win, and the loser must leave nothing behind —
   * the danger is not a failed request, it is two archived attempts or a
   * verification level raised twice for one decision.
   *
   * ⚠️ **This case passes with the claim guard REMOVED, and that is not a flaw
   * in it.** What decides this race is the `from` status in the WHERE, which
   * predates the guard: the winner writes `approved`, and the loser's
   * `['submitted', 'under_review']` then matches nothing. The claim guard
   * answers a different question — a submission somebody has *claimed and left
   * open*, where the status is still `under_review` and the status check alone
   * would wave the second reviewer through.
   *
   * Both cases are worth pinning, and worth telling apart: a reader who thinks
   * this one proves the claim guard will delete the guard and see green.
   */
  it('lets exactly ONE of two simultaneous approvals through', async () => {
    const userId = await makeClientAwaitingReview('claim-race@oxshare.com');

    const results = await Promise.allSettled([
      kyc.approve(userId, ADMIN_ID),
      kyc.approve(userId, OTHER_ADMIN_ID),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await statusOf(userId)).toBe('approved');
    // Raised ONCE. A level of 1 is right; the failure this guards is a second
    // decision landing on top of the first.
    expect(await levelOf(userId)).toBe(1);

    const { rows } = await ctx.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM kyc_submission_attempts WHERE user_id = ${userId}`,
    );
    expect(Number(rows[0].n)).toBe(1);
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
    // Staged by hand: since 0153 a client is verified only by a decision, so
    // this needs the record's escape.
    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('oxshare.identity_maintenance', 'on', true)`);
      await tx.execute(sql`UPDATE users SET verification_level = 1 WHERE id = ${userId}`);
    });
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
