import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { MoneyLimits } from '../src/config/money-limits';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { SYSTEM_ACTOR } from '../src/common/security/actor';
import { auditStubAs } from './audit-stub';
import { AuditLogStore } from '../src/store/audit-log.store';
import { emailStubAs } from './email-stub';
import { notificationsStubAs } from './notifications-stub';
import { transferExecutorStubAs, transfersStubAs } from './transfer-chain-stub';
import { gatewayStubAs } from './gateway-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The withdrawal state machine, and the balance behind it.
 *
 * The half of this that matters most is the DEBIT-ON-REQUEST conversion. The
 * restored service held funds and posted the debit at settlement; this one
 * debits when the client asks and refunds with a compensating entry if it is
 * refused. Several tests here exist purely to pin that the money comes back —
 * a refund that silently does not happen leaves a client short with every state
 * looking correct.
 */
let ctx: MoneyTestContext;
let transactions: TransactionsService;
let wallets: WalletService;

const ADMIN = '00000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  ctx = await startMoneyTestDb();
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
    new AuditLogStore(ctx.db),
  );
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

/** A verified client with a funded USD wallet. */
async function makeFundedClient(email: string, balance = '1000'): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Client', 1, true)
    RETURNING id
  `);
  const userId = rows[0].id;
  await wallets.post({
    userId,
    currency: 'USD',
    amount: balance,
    entryType: 'deposit',
    referenceType: 'transaction',
    referenceId: `seed-${userId}`,
  });
  return userId;
}

async function balanceOf(userId: number): Promise<string> {
  const { rows } = await ctx.db.execute<{ balance: string }>(
    sql`SELECT balance FROM wallets WHERE user_id = ${userId} AND currency = 'USD'`,
  );
  return rows[0].balance;
}

async function ledgerCount(userId: number): Promise<number> {
  const { rows } = await ctx.db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM ledger_entries le
      JOIN wallets w ON w.id = le.wallet_id
     WHERE w.user_id = ${userId}
  `);
  return rows[0].count;
}

function request(userId: number, amount = '100') {
  return transactions.requestWithdrawal({
    userId,
    currency: 'USD',
    amount,
    destination: '+961 3 123 456',
    methodKey: 'whish',
  });
}

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM transfers`);
  await ctx.db.execute(sql`DELETE FROM transactions`);
  await ctx.db.execute(
    sql`TRUNCATE ledger_entries, ib_accruals CASCADE` /* not DELETE: the ledger is append-only by trigger (§6.4). TRUNCATE resets a fixture table without firing row triggers, and no production path truncates. */,
  );
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`UPDATE users SET referred_by_ib_user_id = NULL`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM users`);
});

describe('requesting a withdrawal', () => {
  it('debits the balance immediately', async () => {
    const userId = await makeFundedClient('debit@test.local');

    const row = await request(userId, '250');

    expect(row.state).toBe('pending');
    /*
     * The whole point of the change. The old flow left the balance at 1000 with
     * 250 on hold, so a client could ask for another 1000 and be told yes.
     */
    expect(await balanceOf(userId)).toBe('750.00000000');
  });

  it('refuses a second withdrawal that no longer fits', async () => {
    const userId = await makeFundedClient('twice@test.local', '100');

    await request(userId, '80');

    // 20 left. The refusal happens NOW, while the client is looking at the
    // form — not later, at an admin's desk, against a number they never saw.
    await expect(request(userId, '80')).rejects.toThrow(/insufficient/i);
  });

  it('refuses an unverified client, in the service and not only the guard', async () => {
    const { rows } = await ctx.db.execute<{ id: number }>(sql`
      INSERT INTO users (email, password_hash, first_name, last_name, verification_level)
      VALUES ('unverified@test.local', 'x', 'Test', 'Client', 0)
      RETURNING id
    `);
    await wallets.post({
      userId: rows[0].id,
      currency: 'USD',
      amount: '500',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'seed',
    });

    /*
     * R-4.3: the guard is the cheap early refusal, this is the load-bearing
     * one. A service is reachable from a job or a callback, neither of which
     * passes through a guard.
     */
    await expect(request(rows[0].id)).rejects.toThrow(/verified/i);
  });

  it('leaves nothing behind when the request is refused', async () => {
    const userId = await makeFundedClient('atomic@test.local', '50');

    await expect(request(userId, '100')).rejects.toThrow();

    // No transaction row, no ledger entry, balance untouched. The insert and
    // the debit share one transaction precisely so a refusal at either step
    // leaves neither.
    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM transactions WHERE user_id = ${userId}`,
    );
    expect(rows[0].count).toBe(0);
    expect(await balanceOf(userId)).toBe('50.00000000');
  });
});

/**
 * The two lifecycles, named where they are used.
 *
 * A desk payout is one step (approval records money a human already sent); a
 * provider payout is two (approval authorises, the rail pays, its event settles).
 * Spelling them out at each call site is the point — a bare `true` here would be
 * the least readable boolean in the money path.
 */
const BY_DESK = { awaitsProviderPayout: false } as const;
const BY_PAYOUT_RAIL = { awaitsProviderPayout: true } as const;

describe('approve and settle — the PROVIDER lifecycle', () => {
  /*
   * Two steps because something genuinely happens between them: the row is
   * submitted to the payout rail, and the provider's event is what says the money
   * left. See `TransactionsService.approve`.
   */
  it('moves no money — the debit already happened', async () => {
    const userId = await makeFundedClient('settle@test.local');
    const row = await request(userId, '300');
    const afterRequest = await balanceOf(userId);

    const approved = await transactions.approve(row.id, ADMIN, BY_PAYOUT_RAIL);
    // AUTHORISED, not paid — and `settledAt` is null, which is what makes an
    // approved-but-never-submitted row visible to the reconciler.
    expect(approved.state).toBe('approved');
    expect(approved.settledAt).toBeNull();
    expect(await balanceOf(userId)).toBe(afterRequest);

    const settled = await transactions.settle(row.id, ADMIN, 'PROVIDER-REF-1');
    expect(settled.state).toBe('success');
    expect(settled.providerRef).toBe('PROVIDER-REF-1');
    // Still one ledger entry for the withdrawal, plus the seeding deposit.
    expect(await balanceOf(userId)).toBe('700.00000000');
    expect(await ledgerCount(userId)).toBe(2);
  });

  it('refuses to settle something that was never approved', async () => {
    const userId = await makeFundedClient('unapproved@test.local');
    const row = await request(userId);

    await expect(transactions.settle(row.id, ADMIN, 'REF')).rejects.toThrow(/approved/i);
  });

  it('refuses to approve twice', async () => {
    const userId = await makeFundedClient('double-approve@test.local');
    const row = await request(userId);
    await transactions.approve(row.id, ADMIN, BY_PAYOUT_RAIL);

    // The conditional UPDATE ... WHERE state = 'pending' is what stops a
    // double-clicked button, not a pre-read.
    await expect(transactions.approve(row.id, ADMIN, BY_PAYOUT_RAIL)).rejects.toThrow(/pending/i);
  });
});

describe('approve — the DESK lifecycle', () => {
  /*
   * One step, because the operator approving is the one sending the money. A
   * second `settle` click would be a human confirming to the system what the
   * system had just told them to do — which produced a queue of `approved` rows
   * already paid in the real world and never marked.
   */
  it('records the payout immediately, and still moves no money', async () => {
    const userId = await makeFundedClient('desk@test.local');
    const row = await request(userId, '300');
    const afterRequest = await balanceOf(userId);

    const approved = await transactions.approve(row.id, ADMIN, BY_DESK);

    expect(approved.state).toBe('success');
    expect(approved.settledAt).not.toBeNull();
    // The debit happened at request time; approval records, it does not perform.
    expect(await balanceOf(userId)).toBe(afterRequest);
    expect(await ledgerCount(userId)).toBe(2);
  });

  it('cannot then be settled — there is nothing left to settle', async () => {
    const userId = await makeFundedClient('desk-settle@test.local');
    const row = await request(userId);
    await transactions.approve(row.id, ADMIN, BY_DESK);

    await expect(transactions.settle(row.id, ADMIN, 'REF')).rejects.toThrow(/approved/i);
  });

  /*
   * ⚠️ The mistake this pairing exists to make impossible.
   *
   * Approving a rail-backed withdrawal down the DESK path would mark it paid
   * without ever submitting it for payout — and because the balance is debited at
   * request time, nothing looks wrong until the client asks where their money is.
   * Which lifecycle applies is decided by `RivalWithdrawalsService.willPayOut`,
   * whose conditions are pinned to the claim that does the submitting.
   */
  it('leaves a desk-approved row where the payout rail will never claim it', async () => {
    const userId = await makeFundedClient('never-claimed@test.local');
    const row = await request(userId);

    const approved = await transactions.approve(row.id, ADMIN, BY_DESK);

    // The rail claims `approved` rows only, so `success` is out of its reach —
    // which is correct here, because a human has already paid it.
    expect(approved.state).not.toBe('approved');
  });
});

describe('rejection refunds with a compensating entry', () => {
  it('returns the money', async () => {
    const userId = await makeFundedClient('refund@test.local');
    const row = await request(userId, '400');
    expect(await balanceOf(userId)).toBe('600.00000000');

    await transactions.reject(row.id, ADMIN, 'Beneficiary details do not match');

    expect(await balanceOf(userId)).toBe('1000.00000000');
  });

  it('writes a NEW row rather than editing the debit — §6.4', async () => {
    const userId = await makeFundedClient('compensating@test.local');
    const row = await request(userId, '400');

    await transactions.reject(row.id, ADMIN, 'Nope');

    const { rows } = await ctx.db.execute<{
      amount: string;
      entry_type: string;
      reference_id: string;
    }>(sql`
      SELECT le.amount, le.entry_type, le.reference_id FROM ledger_entries le
        JOIN wallets w ON w.id = le.wallet_id
       WHERE w.user_id = ${userId} AND le.entry_type <> 'deposit'
       ORDER BY le.created_at
    `);

    // The debit stands, untouched, with the credit beside it. Both are readable
    // as what happened rather than as a withdrawal that was quietly unwritten.
    expect(rows).toHaveLength(2);
    expect(rows[0].amount).toBe('-400.00000000');
    expect(rows[0].entry_type).toBe('withdrawal');
    expect(rows[1].amount).toBe('400.00000000');
    /*
     * `adjustment`, not `deposit`: no money entered the platform. A report
     * summing deposits would otherwise count every refused withdrawal as one.
     */
    expect(rows[1].entry_type).toBe('adjustment');
    // The suffix is what stops the unique index absorbing the refund as a
    // replay of the debit — without it the client is never paid back and
    // `post()` reports success.
    expect(rows[1].reference_id).toBe(`${row.id}:refund`);
  });

  it('refuses to reject a settled withdrawal', async () => {
    const userId = await makeFundedClient('too-late@test.local');
    const row = await request(userId);
    await transactions.approve(row.id, ADMIN, BY_PAYOUT_RAIL);
    await transactions.settle(row.id, ADMIN, 'REF');

    await expect(transactions.reject(row.id, ADMIN, 'Changed my mind')).rejects.toThrow(/pending/i);
    // And the money did not come back.
    expect(await balanceOf(userId)).toBe('900.00000000');
  });

  it('cannot refund twice', async () => {
    const userId = await makeFundedClient('double-refund@test.local');
    const row = await request(userId, '100');
    await transactions.reject(row.id, ADMIN, 'First');

    await expect(transactions.reject(row.id, ADMIN, 'Second')).rejects.toThrow();
    expect(await balanceOf(userId)).toBe('1000.00000000');
  });

  it('lets the client withdraw again after a refund', async () => {
    const userId = await makeFundedClient('retry@test.local', '100');
    const first = await request(userId, '100');
    await transactions.reject(first.id, ADMIN, 'Try again');

    // The full balance is back and spendable — the refund is a real credit,
    // not a state flag.
    const second = await request(userId, '100');
    expect(second.state).toBe('pending');
    expect(await balanceOf(userId)).toBe('0.00000000');
  });
});

describe('provider failure after approval', () => {
  it('refunds, exactly as a rejection does', async () => {
    const userId = await makeFundedClient('failed@test.local');
    const row = await request(userId, '200');
    // Only the rail lifecycle can fail after approval: a desk payout is already
    // `success`, and unwinding one is a rejection, not a provider failure.
    await transactions.approve(row.id, ADMIN, BY_PAYOUT_RAIL);

    const failed = await transactions.markFailed(row.id, 'Provider timeout', SYSTEM_ACTOR);

    expect(failed.state).toBe('failure');
    expect(await balanceOf(userId)).toBe('1000.00000000');
  });

  it('refuses to fail a withdrawal that was never approved', async () => {
    const userId = await makeFundedClient('never-approved@test.local');
    const row = await request(userId);

    await expect(transactions.markFailed(row.id, 'x', SYSTEM_ACTOR)).rejects.toThrow(/approved/i);
  });
});

describe('limits', () => {
  it('refuses an amount below the minimum', async () => {
    const userId = await makeFundedClient('tiny@test.local');

    // Below this a withdrawal costs more in provider fees than it moves.
    await expect(request(userId, '1')).rejects.toThrow(/minimum/i);
  });

  it('refuses more decimal places than the currency holds — D-77', async () => {
    /*
     * The dust bug, at the door.
     *
     * Storage is NUMERIC(28,8) and the payout rail sends 2 places, so this used
     * to be ACCEPTED: 50.123456789 was debited as 50.12345679 and paid as 50.12,
     * and the 0.00345679 difference was never refunded and never recorded. Under
     * a cent each time, entirely silent, and it scales with volume.
     *
     * The bound is the operator's `currencies.decimals`, not a hardcoded 2 —
     * so a currency legitimately carrying more places is not blocked by a
     * constant nobody chose.
     */
    const userId = await makeFundedClient('dust@test.local');

    await expect(request(userId, '50.123456789')).rejects.toThrow(/2 decimal places/i);
    await expect(request(userId, '50.001')).rejects.toThrow(/2 decimal places/i);
  });

  it('a currency configured to 8 places is STILL bounded by what the rail can send', async () => {
    /*
     * THE hole the first version of this rule left open, and the reason the
     * bound is the smaller of two numbers rather than one.
     *
     * `currencies.decimals` is operator data — the admin screen accepts 0 to 8 —
     * while Rival settles at 2 (RIVAL_MONEY_SCALE). Validating against the
     * currency alone closed this for USD, which declares 2, and did nothing at
     * all for a currency somebody configured to more: the CRM would accept
     * 100.12345678, debit every place of it, and ask Rival for 100.12, keeping
     * the difference exactly as before. The fix would have LOOKED applied while
     * doing nothing, which is worse than not having it.
     *
     * So: declare 8, and the whish rail must still refuse anything past 2.
     */
    await ctx.db.execute(sql`UPDATE currencies SET decimals = 8 WHERE code = 'USD'`);
    try {
      const userId = await makeFundedClient('rail-bound@test.local');

      await expect(request(userId, '50.12345678')).rejects.toThrow(/2 decimal places/i);
      // And the message names the RAIL, because that is what the client has to
      // act on — the currency would have allowed it.
      await expect(request(userId, '50.12345678')).rejects.toThrow(/50\.12/);
      // Two places still go through: the bound is the rail's, not zero.
      await expect(request(userId, '50.12')).resolves.toBeDefined();
    } finally {
      await ctx.db.execute(sql`UPDATE currencies SET decimals = 2 WHERE code = 'USD'`);
    }
  });

  it('the refusal NAMES the largest amount that would work, rounded down', async () => {
    /*
     * A client's balance can legitimately carry sub-cent value — commission and
     * rebates are percentages stored at the full NUMERIC(28,8) scale — so
     * "withdraw everything" can produce an amount this rule refuses. Without the
     * figure, the refusal is a dead end on the action the client most wants.
     *
     * Rounded DOWN, always: naming a number larger than they hold would replace
     * one refusal with another.
     */
    const userId = await makeFundedClient('dust-message@test.local');

    await expect(request(userId, '50.126789')).rejects.toThrow(/50\.12 USD/);
    await expect(request(userId, '50.999999')).rejects.toThrow(/50\.99 USD/);
  });

  it('still accepts everything expressible in the currency', async () => {
    // The guard must not become "round numbers only" — cents are money.
    const userId = await makeFundedClient('cents@test.local');

    await expect(request(userId, '50.12')).resolves.toBeDefined();
    await expect(request(userId, '50.1')).resolves.toBeDefined();
    await expect(request(userId, '50')).resolves.toBeDefined();
    // Trailing zeros are the SAME number, not extra precision — refusing them
    // would reject a value most UI number formatters produce.
    await expect(request(userId, '50.10000000')).resolves.toBeDefined();
  });

  it('caps a rolling 24 hours, not just one request', async () => {
    const userId = await makeFundedClient('daycap@test.local', '250000');

    /*
     * A per-request limit alone is trivially defeated by making N requests, so
     * it caps the paperwork rather than the exposure. Counted over everything
     * not rejected — a pending withdrawal is money already on its way out.
     */
    await request(userId, '50000');
    await request(userId, '50000');
    await expect(request(userId, '50000')).rejects.toThrow(/24-hour/i);
  });

  it('does not count a REJECTED withdrawal against the daily cap', async () => {
    const userId = await makeFundedClient('rejected-cap@test.local', '250000');
    const first = await request(userId, '50000');
    await transactions.reject(first.id, ADMIN, 'Not this one');

    // It never left, so it should not consume the client's allowance.
    await request(userId, '50000');
    await request(userId, '50000');
    await expect(request(userId, '10')).rejects.toThrow(/24-hour/i);
  });
});

describe('a ZERO amount is refused at the door, not by the ledger', () => {
  /**
   * The guard read `if (!amount.isPositive()) throw` and never fired for zero.
   *
   * decimal.js reads the SIGN and gives ZERO a sign of 1, so `isPositive()` is
   * TRUE for "0" and "0.00000000". The request ran past its own validation and
   * was stopped at the very end by the ledger — *"A ledger entry must move a
   * non-zero amount"* — a sentence naming a table the client never heard of,
   * arriving after everything the method did first.
   *
   * The end state was always safe, which is why it survived: the money never
   * moved. What was wrong is WHERE the refusal came from and what it said.
   *
   * This repo had already diagnosed the trap and written it down three times —
   * `ib-wallet.service.ts:137`, `commission.ts:627`, `commission.ts:761` — and
   * the idiom stayed live in the payments guards regardless, because **a
   * comment beside a fix does not travel: the next reader copies the code.**
   *
   * Both spellings of zero are driven. "0.00000000" is the one the API actually
   * receives, since money crosses every boundary here as a fixed-scale string,
   * and a guard that handles "0" and not "0.00000000" would look correct in
   * every test written by hand.
   */
  for (const zero of ['0', '0.00', '0.00000000']) {
    it(`refuses ${zero} naming the AMOUNT, not the ledger`, async () => {
      const userId = await makeFundedClient(`zero-${zero}@oxshare.test`, '500');

      await expect(request(userId, zero)).rejects.toThrow(/amount must be positive/i);
      // The control: it must not be the ledger's sentence. Without this the
      // test passes against the OLD code, which also threw — just from the
      // wrong place, with the wrong words, after doing the work.
      await expect(request(userId, zero)).rejects.not.toThrow(/ledger/i);
      expect(await ledgerCount(userId), 'a refused request must write nothing').toBe(1);
    });
  }

  it('still refuses a NEGATIVE, which the old spelling did catch', async () => {
    const userId = await makeFundedClient('zero-neg@oxshare.test', '500');
    await expect(request(userId, '-10')).rejects.toThrow(/amount must be positive/i);
  });

  it('does not use the POSITIVITY guard to reject a small-but-positive amount', async () => {
    /*
     * The off-by-one control, and it has to be stated carefully.
     *
     * `0.00000001` IS refused — by the R-5.1 minimum, which is a different and
     * entirely correct refusal. So asserting `resolves` here would be wrong and
     * asserting `rejects` would pass against a positivity guard that had eaten
     * every small amount. What must be true is that the refusal is NOT the
     * positivity one: a positive amount, however small, has to get past the
     * door this section is about and be judged on its size instead.
     *
     * Distinguishing two refusals that both throw is the same discipline the
     * zero cases above need, one step further on.
     */
    const userId = await makeFundedClient('zero-tiny@oxshare.test', '500');
    await expect(request(userId, '0.00000001')).rejects.not.toThrow(/must be positive/i);
  });
});

describe('two operators at the same withdrawal, at the same moment', () => {
  /**
   * CLASS 6 — the two-operator race, on the money path where it costs most.
   *
   * There is already a SEQUENTIAL double-approve case above, and it is not the
   * same test. A sequential second call fails against a check-then-act
   * implementation too, because the first call has finished writing by the time
   * the second reads. **It is the CONCURRENT pair that distinguishes a
   * conditional `UPDATE ... WHERE state = 'pending'` from a read-then-write**,
   * and nothing in this repo drove one at the desk.
   *
   * The guard was correct — `transition()` is a single conditional UPDATE with a
   * rowcount check, exactly what ARCHITECTURE §6 rule 3 requires. It was simply
   * never attempted, which is the same shape as the append-only ledger that was
   * silently unprotected for a month while a test named for it passed.
   *
   * What a failure here would mean in the product: two reviewers click Approve
   * within the same instant and the client is PAID TWICE, or the ledger records
   * one payout and the rail is asked for two.
   */
  it('pays exactly ONCE — one approval wins and the other is refused', async () => {
    const userId = await makeFundedClient('race-approve@oxshare.test', '1000');
    const row = await request(userId, '100');
    const balanceAfterRequest = await balanceOf(userId);
    const ledgerAfterRequest = await ledgerCount(userId);

    const results = await Promise.allSettled([
      transactions.approve(row.id, ADMIN, BY_PAYOUT_RAIL),
      transactions.approve(row.id, ADMIN, BY_PAYOUT_RAIL),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled, 'exactly one approval must win').toHaveLength(1);
    expect(rejected, 'the loser must be REFUSED, not silently ignored').toHaveLength(1);

    /*
     * And the refusal must name the state rather than being any error at all —
     * a deadlock or a constraint violation would also produce one rejection,
     * and would not mean the guard worked.
     */
    const reason = rejected[0].reason as Error;
    expect(reason.message).toMatch(/pending/i);

    /*
     * The money, which is the actual claim. Approving via the rail moves the
     * transaction on without a second debit — the funds were already held at
     * request time — so what must be true is that the SECOND approval added
     * nothing: no extra ledger row, and the balance where one approval leaves it.
     */
    expect(await ledgerCount(userId), 'a refused approval must write no ledger row').toBe(
      ledgerAfterRequest,
    );
    expect(await balanceOf(userId)).toBe(balanceAfterRequest);
  });

  it('an approve and a reject racing each other also settle to ONE outcome', async () => {
    /*
     * The nastier pair: two DIFFERENT transitions from the same state. If both
     * landed, the row would be approved and rejected at once — and the reject
     * path refunds, so the client would keep the money AND be paid.
     */
    const userId = await makeFundedClient('race-mixed@oxshare.test', '1000');
    const row = await request(userId, '100');

    const results = await Promise.allSettled([
      transactions.approve(row.id, ADMIN, BY_PAYOUT_RAIL),
      transactions.reject(row.id, ADMIN, 'Suspected fraud'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

describe('many withdrawal REQUESTS on one wallet at the same moment', () => {
  it('each is accepted or refused for its balance — none dies in a deadlock', async () => {
    /*
     * Found by load test (26 Sep 2026): 30 simultaneous requests against a
     * balance of 100 answered 2 × 201 and 28 × 500 — "deadlock detected", one a
     * second. Each request inserts its `transactions` row first, and that row's
     * foreign key takes a KEY SHARE lock on the wallet; the ledger post then
     * asked for the wallet FOR UPDATE, which conflicts with every other
     * request's KEY SHARE lock. Each waited for the other; Postgres killed one.
     * The money stayed right — each transaction rolled back whole — but a client
     * who clicked Withdraw twice got an error instead of an answer.
     */
    const userId = await makeFundedClient('race-requests@oxshare.test', '100');

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => request(userId, '10')),
    );
    const refusals = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason as Error).message);

    expect(
      refusals.filter((message) => !/insufficient balance/i.test(message)),
      'a request failed for a reason other than its balance',
    ).toEqual([]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect(refusals).toHaveLength(2);
    expect(await balanceOf(userId)).toBe('0.00000000');
    // The seed credit and ten debits — nothing half-written by a killed request.
    expect(await ledgerCount(userId)).toBe(11);
  });
});
