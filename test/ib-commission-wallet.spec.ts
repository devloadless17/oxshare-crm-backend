import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { IbWalletService } from '../src/modules/ib/ib-wallet.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * A partner's earnings live in their OWN wallet, and there is exactly one way
 * out of it.
 *
 * Real Postgres, because every guarantee here is a property of the database:
 * the widened `wallets_user_currency_kind_uq` (a partner holding two USD
 * wallets is a UNIQUE violation without it), the row lock both transfer legs
 * take, and the ledger's replay index. A stubbed database would let all three
 * pass while none of them worked.
 *
 * ## What each test is here to catch
 *
 * Every one of these has a wrong implementation that looks right in review:
 *
 *  - Crediting `main` — which is what the code did before — leaves the LEDGER
 *    able to tell a commission from a deposit while the BALANCE cannot.
 *  - Returning commission wallets from `GET /wallet` puts a balance on the
 *    wallet screen that the deposit and withdraw screens would then offer as a
 *    source, which is the whole thing this separation prevents.
 *  - Typing the transfer's debit as `commission` instead of `transfer` makes
 *    lifetime earnings FALL every time a partner moves their own money. It is
 *    invisible until a partner transfers, and then it reads as the platform
 *    taking their earnings back.
 */
let ctx: MoneyTestContext;
let wallets: WalletService;
let ibWallets: IbWalletService;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);
  ibWallets = new IbWalletService(ctx.db, wallets);
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

async function makeUser(email: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', 'Test', 'Partner')
    RETURNING id
  `);
  return rows[0].id;
}

/** An APPROVED, active partner — what the transfer endpoint requires. */
async function makePartner(email: string, active = true): Promise<number> {
  const userId = await makeUser(email);
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, active, program_id)
      VALUES (${userId}, ${email.slice(0, 8)}, ${active},
            (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))
  `);
  return userId;
}

async function balanceOf(userId: number, kind: string, currency = 'USD'): Promise<string | null> {
  const { rows } = await ctx.db.execute<{ balance: string }>(sql`
    SELECT balance FROM wallets
    WHERE user_id = ${userId} AND currency = ${currency} AND kind = ${kind}
  `);
  return rows[0]?.balance ?? null;
}

/** What `IbOverviewService.earningsFor` sums — spanning BOTH wallet kinds. */
async function lifetimeEarnings(userId: number, currency = 'USD'): Promise<string> {
  const { rows } = await ctx.db.execute<{ total: string }>(sql`
    SELECT COALESCE(SUM(le.amount), 0)::text AS total
    FROM ledger_entries le
    JOIN wallets w ON w.id = le.wallet_id
    WHERE w.user_id = ${userId}
      AND w.currency = ${currency}
      AND le.entry_type IN ('commission', 'rebate', 'payout')
  `);
  return rows[0].total;
}

/** The commission credit the confirm loop makes, without the whole pipeline. */
async function creditCommission(userId: number, amount: string, reference: string) {
  await wallets.post({
    userId,
    currency: 'USD',
    kind: 'commission',
    amount,
    entryType: 'commission',
    referenceType: 'accrual',
    referenceId: reference,
  });
}

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM ib_wallet_transfers`);
  await ctx.db.execute(
    sql`TRUNCATE ledger_entries, ib_accruals CASCADE` /* not DELETE: the ledger is append-only by trigger (§6.4). TRUNCATE resets a fixture table without firing row triggers, and no production path truncates. */,
  );
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM users`);
});

describe('the commission wallet is separate from the spending wallet', () => {
  it('credits commission to the commission wallet and leaves the main wallet alone', async () => {
    const partner = await makePartner('sep-partner@oxshare-e2e.test');
    // The partner also holds ordinary money, so this proves the two do not mix
    // rather than merely that one of them exists.
    await wallets.post({
      userId: partner,
      currency: 'USD',
      amount: '1000',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'dep-1',
    });

    await creditCommission(partner, '70', 'accrual-1');

    expect(await balanceOf(partner, 'main')).toBe('1000.00000000');
    expect(await balanceOf(partner, 'commission')).toBe('70.00000000');
  });

  it('hides the commission wallet from the wallet list, which every money screen reads', async () => {
    const partner = await makePartner('hidden-partner@oxshare-e2e.test');
    await wallets.post({
      userId: partner,
      currency: 'USD',
      amount: '1000',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'dep-2',
    });
    await creditCommission(partner, '70', 'accrual-2');

    // `GET /wallet` — the wallet, deposit and withdraw screens.
    const listed = await wallets.listWallets(partner);
    expect(listed).toHaveLength(1);
    expect(listed[0].kind).toBe('main');
    expect(listed[0].balance).toBe('1000.00000000');

    // `GET /ib/overview` — the partner screen, and the ONLY place it appears.
    const commission = await ibWallets.listCommissionWallets(partner);
    expect(commission).toHaveLength(1);
    expect(commission[0].balance).toBe('70.00000000');
  });

  it('lets one partner hold a main AND a commission wallet in the same currency', async () => {
    /*
     * The widened unique index, asserted directly. Under the old
     * (user_id, currency) key the second wallet is a UNIQUE violation — and the
     * failure would not look like a constraint error to anyone reading a bug
     * report, it would look like commission silently never being paid.
     */
    const partner = await makePartner('twowallets@oxshare-e2e.test');
    await wallets.getOrCreateWallet(partner, 'USD', 'main');
    await wallets.getOrCreateWallet(partner, 'USD', 'commission');

    const { rows } = await ctx.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM wallets WHERE user_id = ${partner} AND currency = 'USD'`,
    );
    expect(rows[0].n).toBe('2');
  });
});

describe('transferring commission into the main wallet', () => {
  it('moves the money and writes both ledger legs against the transfer', async () => {
    const partner = await makePartner('move-partner@oxshare-e2e.test');
    await creditCommission(partner, '250', 'accrual-3');

    const result = await ibWallets.transferToMain(partner, { amount: '100', currency: 'USD' });

    expect(result.amount).toBe('100.00000000');
    expect(result.commissionBalance).toBe('150.00000000');
    expect(result.mainBalance).toBe('100.00000000');

    expect(await balanceOf(partner, 'commission')).toBe('150.00000000');
    expect(await balanceOf(partner, 'main')).toBe('100.00000000');

    /*
     * Two legs, both `transfer`, both pointing at the ib_wallet_transfers row.
     * A single-legged implementation passes every balance assertion above if it
     * debits and credits without the ledger — and then the wallet reconciler,
     * which sums entries per wallet, reports the platform's books as broken.
     */
    const { rows } = await ctx.db.execute<{
      amount: string;
      entry_type: string;
      reference_type: string;
      reference_id: string;
    }>(sql`
      SELECT amount, entry_type, reference_type, reference_id
      FROM ledger_entries
      WHERE reference_type = 'ib_transfer'
      ORDER BY amount
    `);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.amount)).toEqual(['-100.00000000', '100.00000000']);
    expect(rows.every((r) => r.entry_type === 'transfer')).toBe(true);
    expect(rows.every((r) => r.reference_id === result.id)).toBe(true);
  });

  it('leaves LIFETIME EARNINGS unchanged — moving earned money earns nothing', async () => {
    /*
     * ⚠️ The subtle one. Typing the debit leg as `commission` rather than
     * `transfer` balances perfectly and passes every test above; it is only
     * wrong in the figure a partner opens the screen to read. Their lifetime
     * earnings would drop by the amount they moved, which reads as the platform
     * clawing back money they had already been paid.
     */
    const partner = await makePartner('earnings-partner@oxshare-e2e.test');
    await creditCommission(partner, '250', 'accrual-4');
    const before = await lifetimeEarnings(partner);

    await ibWallets.transferToMain(partner, { amount: '250', currency: 'USD' });

    expect(await lifetimeEarnings(partner)).toBe(before);
    expect(await lifetimeEarnings(partner)).toBe('250.00000000');
    // ...and the commission wallet is now genuinely empty, not merely relabelled.
    expect(await balanceOf(partner, 'commission')).toBe('0.00000000');
  });

  it('refuses more than the commission balance, and moves nothing', async () => {
    const partner = await makePartner('over-partner@oxshare-e2e.test');
    await creditCommission(partner, '50', 'accrual-5');

    await expect(
      ibWallets.transferToMain(partner, { amount: '50.00000001', currency: 'USD' }),
    ).rejects.toThrow(/insufficient/i);

    // The refusal must be total. A partial move, or a debit with no credit, is
    // worse than the refusal it replaced.
    expect(await balanceOf(partner, 'commission')).toBe('50.00000000');
    expect(await balanceOf(partner, 'main')).toBeNull();
    const { rows } = await ctx.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ib_wallet_transfers`,
    );
    expect(rows[0].n).toBe('0');
  });

  it('refuses a currency the partner holds no commission wallet in, by that name', async () => {
    /*
     * NOT "insufficient balance". `getOrCreateWallet` on the source would open
     * an empty wallet and produce that message, telling a partner they are short
     * of money in a wallet that has never existed — a different problem with a
     * different answer.
     */
    const partner = await makePartner('nowallet-partner@oxshare-e2e.test');
    await creditCommission(partner, '50', 'accrual-6');

    await expect(
      ibWallets.transferToMain(partner, { amount: '10', currency: 'USDT' }),
    ).rejects.toThrow(/no USDT commission wallet/i);
  });

  it('refuses a client who is not a partner', async () => {
    const client = await makeUser('not-a-partner@oxshare-e2e.test');
    await creditCommission(client, '50', 'accrual-7');

    await expect(
      ibWallets.transferToMain(client, { amount: '10', currency: 'USD' }),
    ).rejects.toThrow(/only a partner/i);
  });

  it('refuses a SUSPENDED partner, and says so rather than blaming the balance', async () => {
    const partner = await makePartner('suspended@oxshare-e2e.test', false);
    await creditCommission(partner, '50', 'accrual-8');

    await expect(
      ibWallets.transferToMain(partner, { amount: '10', currency: 'USD' }),
    ).rejects.toThrow(/suspended/i);
    expect(await balanceOf(partner, 'commission')).toBe('50.00000000');
  });

  it('refuses a zero or negative amount before touching the database', async () => {
    const partner = await makePartner('zero-partner@oxshare-e2e.test');
    await creditCommission(partner, '50', 'accrual-9');

    await expect(
      ibWallets.transferToMain(partner, { amount: '0', currency: 'USD' }),
    ).rejects.toThrow(/greater than zero/i);
    await expect(
      ibWallets.transferToMain(partner, { amount: '-10', currency: 'USD' }),
    ).rejects.toThrow(/greater than zero/i);

    // A negative amount that slipped through would CREDIT the commission wallet
    // out of the main one — a withdrawal dressed as a payout.
    expect(await balanceOf(partner, 'commission')).toBe('50.00000000');
    expect(await balanceOf(partner, 'main')).toBeNull();
  });

  it('keeps eight-decimal precision through a transfer', async () => {
    /*
     * §6.1 on this specific path. A `Number()` anywhere between the request and
     * the ledger collapses these digits, and the assertion is the ugly value for
     * the reason money.test.ts records — `formatMoney('10') === '$10.00'` would
     * prove nothing.
     */
    const partner = await makePartner('precise-partner@oxshare-e2e.test');
    await creditCommission(partner, '0.12345678', 'accrual-10');

    const result = await ibWallets.transferToMain(partner, {
      amount: '0.00000001',
      currency: 'USD',
    });

    expect(result.commissionBalance).toBe('0.12345677');
    expect(result.mainBalance).toBe('0.00000001');
  });
});
