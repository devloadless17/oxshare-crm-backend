import { WalletsStore } from '../src/store/wallets.store';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { AuthService } from '../src/modules/identity/auth.service';
import { IbStore } from '../src/store/ib.store';
import { UsersStore } from '../src/store/users.store';
import { PasswordService } from '../src/common/security/password.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { WalletProvisioningService } from '../src/modules/wallet/wallet-provisioning.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { auditStubAs } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Attribution: which partner introduced a client.
 *
 * The rule that matters most here is the one about FAILURE. A referral link is
 * marketing collateral — shortened, truncated by chat apps, retyped off a
 * screenshot, shared months after a partner was suspended — so an unusable code
 * must cost the attribution and never the signup. Half these tests are about
 * that, because it is the half a refactor is most likely to "fix" into a throw.
 */
let ctx: MoneyTestContext;
let auth: AuthService;
let users: UsersStore;
let ib: IbStore;

const sendVerificationEmail = vi.fn().mockResolvedValue(undefined);
const sendAccountExistsEmail = vi.fn().mockResolvedValue(undefined);

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  users = new UsersStore(ctx.db);
  ib = new IbStore(ctx.db);

  /*
   * Only the collaborators `register()` actually reaches are real. The rest are
   * positional placeholders — the constructor's own comment explains why the
   * argument list is append-only, and this is the suite it is protecting.
   */
  auth = new AuthService(
    {} as never, // jwt
    {} as never, // config
    { sendVerificationEmail, sendAccountExistsEmail } as never,
    users,
    {} as never, // csrf
    {} as never, // refreshTokens
    new PasswordService(),
    {} as never, // loginAttempts
    {} as never, // files
    ib,
    // Real, because registration opening a wallet is part of what this suite
    // now covers — see the last describe block.
    new WalletProvisioningService(
      new WalletService(ctx.db),
      new CurrenciesService(ctx.db, auditStubAs()),
      new WalletsStore(ctx.db),
    ),
  );
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

/** A partner holding `code`, returned as their user id. */
async function makePartner(email: string, code: string, active = true): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level)
    VALUES (${email}, 'x', 'Test', 'Partner', 1)
    RETURNING id
  `);
  const userId = rows[0].id;
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, active, program_id)
      VALUES (${userId}, ${code}, ${active}, (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))
  `);
  return userId;
}

/**
 * Register, and hand back the new client's id — LOOKED UP, not returned.
 *
 * ⚠️ THIS USED TO READ `result.userId`, AND THAT FIELD WAS THE MEMBERSHIP
 * ORACLE. `register()` answered `{ message, userId }` for a fresh address and
 * `{ message }` for a taken one — same status, same sentence, and the presence
 * of one key telling an attacker whether an address holds an account. The field
 * is gone (see `RegistrationResponseDto`), so the two responses are now
 * identical and there is nothing here to read.
 *
 * Worth recording rather than quietly rewriting: the field was NOT unused. This
 * helper consumed it, and consumed it precisely to detect "the address was
 * already taken" — the exact condition it leaked. A defence with one internal
 * consumer that depends on the leak is how a leak survives review.
 *
 * Looking the row up by email is also a STRONGER control than the old check: it
 * proves the account exists in the database rather than trusting what the
 * endpoint said about it.
 */
async function registerClient(email: string, referralCode?: string): Promise<string> {
  await auth.register(registration(email, referralCode));
  const created = await users.findByEmail(email);
  if (!created) {
    throw new Error(
      `Expected a new account for ${email}; none exists, so the address was already ` +
        'taken or registration failed. The response cannot tell you which, by design.',
    );
  }
  return created.id;
}

function registration(email: string, referralCode?: string) {
  return {
    firstName: 'New',
    lastName: 'Client',
    email,
    password: 'StrongPass123!',
    ...(referralCode === undefined ? {} : { referralCode }),
  };
}

beforeEach(async () => {
  sendVerificationEmail.mockClear();
  await ctx.db.execute(
    sql`TRUNCATE ledger_entries, ib_accruals CASCADE` /* not DELETE: the ledger is append-only by trigger (§6.4). TRUNCATE resets a fixture table without firing row triggers, and no production path truncates. */,
  );
  await ctx.db.execute(sql`DELETE FROM wallets`);
  // Children first: `users.referred_by_ib_user_id` is a restrict FK onto
  // ib_accounts, which is itself a restrict FK onto users.
  await ctx.db.execute(sql`UPDATE users SET referred_by_ib_user_id = NULL`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM users`);
});

describe('a code that resolves', () => {
  it('attributes the client to the partner who owns it', async () => {
    const partnerId = await makePartner('owner@test.local', 'ABCD2345');

    const clientId = await registerClient('referred@test.local', 'ABCD2345');

    const client = await users.findById(clientId);
    expect(client?.referredByIbUserId).toBe(partnerId);
  });

  it('accepts a code typed in lower case', async () => {
    const partnerId = await makePartner('case@test.local', 'ABCD2345');

    // Codes are issued upper-case, but this one arrives off a screenshot.
    const clientId = await registerClient('lower@test.local', 'abcd2345');

    const client = await users.findById(clientId);
    expect(client?.referredByIbUserId).toBe(partnerId);
  });

  it('accepts a code with surrounding whitespace', async () => {
    const partnerId = await makePartner('space@test.local', 'ABCD2345');

    const clientId = await registerClient('padded@test.local', '  ABCD2345 ');

    const client = await users.findById(clientId);
    expect(client?.referredByIbUserId).toBe(partnerId);
  });

  it('survives the DEBRIS a referral link picks up on its way to a client', async () => {
    /*
     * THE DEFECT THIS EXISTS FOR, reported from production.
     *
     * A client followed a partner's link and typed a backslash on the end of
     * the address by mistake. The code arrived as `ABCD2345\`, `trim()` had
     * nothing to trim, the lookup missed, and the registration SUCCEEDED with
     * no partner attached. `t11@gmail.com` carries no referred_by_ib_user_id
     * to this day; `t12@gmail.com`, through the same link intact, is correct.
     *
     * Nobody found out from the system. An unattributed client looks exactly
     * like one who arrived on their own, so the partner simply never gets paid
     * for an introduction they made.
     *
     * Each of these is a real way a link reaches a person: retyped from the
     * address bar, copied with its trailing slash, quoted by a chat client,
     * wrapped in a zero-width character by an email client.
     */
    const partnerId = await makePartner('debris@test.local', 'ABCD2345');
    /*
     * A code OUTSIDE the mint alphabet, because stored codes are not restricted
     * to it — `E2EPARTL1` and `E2EPARTL2` both hold an `L` in this system
     * today. The first version of the normaliser stripped by the mint alphabet
     * and would have broken every one of them; this pins the weaker, true rule.
     */
    const legacyPartnerId = await makePartner('legacy@test.local', 'PROTOL01');

    const mangled = [
      'ABCD2345\\',
      'ABCD2345/',
      '"ABCD2345"',
      ' abcd2345 ',
      'ABCD-2345',
      'ABCD2345\u200b',
    ];

    for (const [i, code] of mangled.entries()) {
      const clientId = await registerClient(`debris-${i}@test.local`, code);
      const client = await users.findById(clientId);
      expect(
        client?.referredByIbUserId,
        `\`${code}\` lost the attribution — the partner is not credited and nothing says so`,
      ).toBe(partnerId);
    }

    // The legacy-shaped code survives the same debris, letters and all.
    const legacyClientId = await registerClient('legacy-client@test.local', ' protol01/ ');
    const legacyClient = await users.findById(legacyClientId);
    expect(
      legacyClient?.referredByIbUserId,
      'a stored code outside the MINT alphabet was mangled by the normaliser',
    ).toBe(legacyPartnerId);
  });

  it('attributes to a SUSPENDED partner', async () => {
    const partnerId = await makePartner('suspended@test.local', 'SUSP2345', false);

    /*
     * Suspension stops a partner EARNING; it does not unmake an introduction,
     * and they keep their code and their tree precisely so the clients beneath
     * them stay put. A reactivated partner must not find the clients they
     * introduced while suspended were quietly attributed to nobody.
     */
    const clientId = await registerClient('during@test.local', 'SUSP2345');

    const client = await users.findById(clientId);
    expect(client?.referredByIbUserId).toBe(partnerId);
  });
});

describe('a code that does not resolve', () => {
  it('registers the client anyway, unattributed', async () => {
    // The signup is the thing we cannot get back. The attribution is not.
    const clientId = await registerClient('unknown@test.local', 'NOSUCH99');

    const client = await users.findById(clientId);
    expect(client?.referredByIbUserId).toBeUndefined();
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it('registers when the code is empty or blank', async () => {
    await expect(registerClient('blank@test.local', '   ')).resolves.toBeTruthy();
    await expect(registerClient('empty@test.local', '')).resolves.toBeTruthy();
  });

  it('registers with no code at all', async () => {
    const clientId = await registerClient('direct@test.local');

    // The common case: a client who found the platform on their own.
    const client = await users.findById(clientId);
    expect(client?.referredByIbUserId).toBeUndefined();
  });
});

describe('the attribution, once written', () => {
  it('survives being read back through the store', async () => {
    const partnerId = await makePartner('read@test.local', 'READ2345');
    const clientId = await registerClient('client@test.local', 'READ2345');

    const client = await users.findById(clientId);
    expect(client?.referredByIbUserId).toBe(partnerId);
  });

  it('refuses to let the partner be deleted out from under it', async () => {
    const partnerId = await makePartner('protected@test.local', 'PROT2345');
    await registerClient('beneath@test.local', 'PROT2345');

    // RESTRICT, like every other reference to a person in this schema.
    await expect(
      ctx.db.execute(sql`DELETE FROM ib_accounts WHERE user_id = ${partnerId}`),
    ).rejects.toThrow();
  });
});

describe('registration opens wallets', () => {
  it('opens one per enabled currency', async () => {
    const clientId = await registerClient('wallets@test.local');

    const { rows } = await ctx.db.execute<{ currency: string; balance: string }>(
      sql`SELECT currency, balance FROM wallets WHERE user_id = ${clientId} ORDER BY currency`,
    );

    /*
     * The chosen shape: every enabled currency at REGISTRATION, not the default
     * one now and the rest at KYC approval. A client sees the full set of
     * balances the platform offers from their first sign-in, rather than
     * watching /wallet grow rows at a moment they associate with identity
     * checks.
     */
    expect(rows.map((r) => r.currency)).toEqual(['USD', 'USDT']);
    expect(rows.every((r) => r.balance === '0.00000000')).toBe(true);
  });

  it('still registers when no currency is enabled', async () => {
    await ctx.db.execute(sql`UPDATE currencies SET enabled = false`);

    // A misconfigured platform costs the client their wallets, never their
    // account — the address would be taken and unrecoverable.
    const clientId = await registerClient('no-currency@test.local');
    expect(clientId).toBeTruthy();

    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM wallets WHERE user_id = ${clientId}`,
    );
    expect(rows[0].count).toBe(0);

    await ctx.db.execute(sql`UPDATE currencies SET enabled = true`);
  });
});
