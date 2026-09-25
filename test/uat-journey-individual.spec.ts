import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { uploadKycFile } from './support/kyc-upload';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { emailRecorder } from './email-recorder';
import { EmailService } from '../src/modules/email/email.service';
import { Mt5BridgeClient } from '../src/modules/trading/mt5/mt5-bridge.client';
import { RivalWithdrawalsService } from '../src/modules/payments/rival/rival-withdrawals.service';
import { PasswordService } from '../src/common/security/password.service';
import { admins, kycConfigSteps, roles, users } from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * FSD §14, JOURNEY 1 — walked, not assembled from the parts.
 *
 * > "An individual registering directly, completing manual KYC to verification
 * >  level 1, depositing (via Whish or USDT), trading on an MT5 account, and
 * >  withdrawing under email-OTP protection."
 *
 * ## Why this file exists when 2,500 tests already pass
 *
 * Every step below is covered somewhere: `auth-registration-oracle` proves
 * registration, `kyc-http` proves the queue, `money.spec` proves the ledger.
 * None of them proves that a PERSON can get from the sign-up form to money in
 * their bank, because each starts from a fixture built for its own step — a
 * client who is already verified, a wallet that already has a balance, a
 * withdrawal that already exists.
 *
 * §14 is the acceptance gate and it is written as journeys for that reason: the
 * defects it is meant to catch live in the JOINS. The one that proves the point
 * shipped here — `creditDeposit` had no route in front of it for weeks, so a
 * client could file a manual deposit and it sat pending for ever. Money could
 * leave the platform and could not enter it. Every unit test passed.
 *
 * ## Two deviations from the sentence above, both deliberate and both recorded
 *
 * **The email OTP is GONE**, removed at the operator's request along with the
 * two-step withdrawal form — `payments.controller.ts` records the decision and
 * why the switch could not merely be left off. What still stands in front of a
 * withdrawal is asserted here instead: KYC level 1, CSRF, the idempotency key,
 * the balance, and the §12.4 caps.
 *
 * **The deposit arrives by the admin credit route, not the Whish rail.** The
 * gateway leg needs a live Rival platform key; it is walked against a stubbed
 * provider in `rival-deposit-flow.spec.ts`, which is the only form of that test
 * that does not require one. `POST /admin/wallets/credit` is the other real way
 * money enters, it writes a genuine deposit row through `creditDeposit`, and it
 * is the route whose absence stranded the first end-to-end run.
 *
 * MT5 account creation is stubbed: the bridge is another team's service with
 * its own contract tests, and `docs/` is explicit that bridge-side behaviour is
 * raised with them rather than asserted here.
 */

const MASTER = { email: 'uat-j1-master@oxshare.com', password: 'admin-password-123' };
const CLIENT = {
  email: 'uat-j1-individual@oxshare-e2e.test',
  password: 'ClientPass123!',
};

let ctx: HttpTestContext;
let mail: ReturnType<typeof emailRecorder>;
let clientId: string;
let tradingAccountId: string;
let withdrawalId: string;

/** A fresh key per money call — the routes refuse 400 without one. */
const idem = () => ({ headers: { 'idempotency-key': randomUUID() } });

beforeAll(async () => {
  mail = emailRecorder();
  ctx = await startHttpTestApp({
    overrides: [
      { token: EmailService, value: mail.service },
      {
        token: Mt5BridgeClient,
        /*
         * `isConfigured` is a GETTER on the real client, so it is a plain value
         * here. Written as `() => true` it is still truthy and the guard still
         * passes — which is how a stub can be wrong and look right.
         *
         * `balance` is the leg that moves money on MT5, and the transfer
         * executor calls it INLINE so the common case finishes while the client
         * is still on the screen. Omitting it does not fail loudly: the
         * executor treats the error as indeterminate, leaves the transfer
         * pending, and the money stays HELD — which reads as a wallet that did
         * not move rather than as a missing stub.
         */
        value: {
          isConfigured: true,
          createAccount: () =>
            Promise.resolve({
              login: 5090001,
              group: 'real\\Standard',
              leverage: 100,
              currency: 'USD',
              masterPassword: 'Master!1',
              investorPassword: 'Investor!1',
            }),
          balance: () => Promise.resolve({ dealId: '900001', replayed: false }),
          getAccount: () =>
            Promise.resolve({
              login: 5090001,
              balance: '400.00',
              equity: '400.00',
              currency: 'USD',
            }),
        },
      },
      {
        // `willPayOut` false keeps the no-rail transition: approve settles in
        // one step, exactly as it does on a deployment with no payout rail.
        token: RivalWithdrawalsService,
        value: {
          submitApproved: () => Promise.resolve(),
          cancelApproved: () => Promise.resolve(),
          willPayOut: () => Promise.resolve(false),
        },
      },
    ],
  });

  const db = ctx.db.db;

  /*
   * The onboarding step configuration, as the bootstrap seed writes it.
   *
   * `submit()` reads the required profile fields from here (FR-IND-03), so
   * without it the journey runs against a service whose configuration is empty
   * — a state the real application cannot be in, and one that answers 500 on
   * the first submit. The REAL defaults, not a hand-written subset, for the
   * reason `kyc-http.spec.ts` gives: otherwise this stops testing shipped rules.
   */
  await db.insert(kycConfigSteps).values(
    DEFAULT_KYC_STEPS.map((step) => ({
      id: step.id,
      stepNumber: step.stepNumber,
      slug: step.slug,
      title: step.title,
      description: step.description,
      icon: step.icon,
      enabled: step.enabled,
      fields: step.fields as unknown as Record<string, unknown>[],
    })),
  );

  const passwords = new PasswordService();
  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'UAT J1 Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'UAT Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

const PORTAL_ORIGIN = process.env['PORTAL_URL'] ?? 'http://localhost:3000';

describe('§14 J1 — step 1: an individual registers directly', () => {
  it('accepts the registration and does not sign them in', async () => {
    const res = await anonymous(ctx).post('/v1/auth/register').set('Origin', PORTAL_ORIGIN).send({
      firstName: 'Individual',
      lastName: 'Applicant',
      email: CLIENT.email,
      password: CLIENT.password,
      country: 'LB',
      phone: '+96170111222',
    });

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);

    const [row] = await ctx.db.db.select().from(users).where(eq(users.email, CLIENT.email));
    expect(row, 'the registration did not create a user').toBeDefined();
    clientId = row.id;
    // A fresh account is UNVERIFIED. The journey's first real gate.
    expect(row.emailVerified).toBe(false);
  });

  it('refuses the sign-in until the address is verified, and says which problem it is', async () => {
    const res = await anonymous(ctx)
      .post('/v1/auth/login')
      .set('Origin', PORTAL_ORIGIN)
      .send(CLIENT);
    // 403 EMAIL_NOT_VERIFIED, not a generic 401: "wrong password" and "check
    // your inbox" are different screens and only the second gets a resend.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/EMAIL_NOT_VERIFIED|verify/i);
  });

  it('emailed a verification link, and the link works', async () => {
    // The LATEST: the refused sign-in above may have mailed a fresh link.
    const sent = mail.latest('sendVerificationEmail', CLIENT.email);
    expect(sent, 'no verification email was sent').toBeDefined();
    const token = sent?.args[1] as string;
    expect(token, 'the verification email carried no token').toBeTruthy();

    const res = await anonymous(ctx)
      .post('/v1/auth/verify-email')
      .set('Origin', PORTAL_ORIGIN)
      .send({ token });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
  });

  it('signs in once verified', async () => {
    const session = await actingAs(ctx, 'portal', CLIENT);
    const me = await session.get('/v1/auth/me');
    expect(me.status).toBe(200);
  });
});

describe('§14 J1 — step 2: manual KYC to verification level 1', () => {
  let client: Session;

  beforeAll(async () => {
    client = await actingAs(ctx, 'portal', CLIENT);
  });

  it('refuses to submit an empty application rather than queueing a blank one', async () => {
    // The reviewer's queue is the thing being protected: a submission with no
    // profile is work that cannot be actioned, filed as work that can.
    const res = await client.post('/v1/kyc/submit');
    expect(res.status).toBe(400);
  });

  it('accepts the four steps a manual application is made of', async () => {
    const personal = await client.post('/v1/kyc/step', {
      step: 'personal',
      data: {
        firstName: 'Individual',
        lastName: 'Applicant',
        dateOfBirth: '1990-04-12',
        phone: '+96170111222',
        nationality: 'Lebanon',
        country: 'Lebanon',
      },
    });
    expect(personal.status, JSON.stringify(personal.body)).toBeLessThan(400);

    // The documents arrive as a client's do — uploaded, each page naming its
    // document. `/kyc/step` no longer takes a file path: see
    // test/support/kyc-upload.ts for why that was a hole rather than a shortcut.
    for (const [field, docType] of [
      ['doc_front', 'passport'],
      ['selfie', undefined],
      ['address_proof', 'utility_bill'],
    ] as const) {
      const res = await uploadKycFile(client, field, docType);
      expect(res.status, `${field}: ${JSON.stringify(res.body)}`).toBeLessThan(400);
    }
  });

  it('submits, and the application is then out of the client’s hands', async () => {
    const submitted = await client.post('/v1/kyc/submit');
    expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(400);

    // The half that matters for evidence integrity: a client must not be able
    // to swap the documents a reviewer has open.
    const edit = await client.post('/v1/kyc/step', {
      step: 'personal',
      data: { firstName: 'Renamed' },
    });
    expect(edit.status).toBe(403);
  });

  it('appears in the reviewer’s queue', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get('/v1/admin/kyc?status=needs_review&limit=100');
    expect(res.status).toBe(200);
    const items = (res.body as { items: { userId: string }[] }).items;
    expect(items.some((r) => r.userId === clientId)).toBe(true);
  });

  it('approving it raises the client to verification level 1 and emails them', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.patch(`/v1/admin/kyc/${clientId}/approve`, {});
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);

    const status = await (await actingAs(ctx, 'portal', CLIENT)).get('/v1/kyc/status');
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.body)).toMatch(/approved/i);

    const [row] = await ctx.db.db.select().from(users).where(eq(users.id, clientId));
    // "Verification level 1" is the FSD's phrase and a real column, not a
    // synonym for the submission's status.
    expect(Number(row.verificationLevel)).toBeGreaterThanOrEqual(1);

    // §14 J4 asks for decisions "with reasons and email notifications". This is
    // the notification half, asserted on the journey that produces it.
    expect(await mail.waitFor('sendKycDecisionEmail', CLIENT.email)).toBeDefined();
  });
});

describe('§14 J1 — step 3: money arrives', () => {
  it('credits the wallet through a real deposit row, not an adjustment', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.post(
      '/v1/admin/wallets/credit',
      {
        userId: clientId,
        amount: '1000.00000000',
        currency: 'USD',
        reason: 'UAT journey 1 — funding the individual’s first deposit.',
      },
      idem(),
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);

    const client = await actingAs(ctx, 'portal', CLIENT);
    const wallet = await client.get('/v1/wallet');
    expect(wallet.status).toBe(200);
    expect(JSON.stringify(wallet.body)).toContain('1000');

    // It must be visible to the CLIENT as a deposit. An operator crediting an
    // account and the client's statement showing nothing is the failure this
    // route was built to close.
    const history = await client.get('/v1/payments/transactions?limit=50');
    expect(history.status).toBe(200);
    expect(JSON.stringify(history.body)).toMatch(/deposit/i);
  });

  it('a replayed credit lands once, because the key is a database constraint', async () => {
    // §6.3: idempotency in constraints, never check-then-insert. A double-
    // submitted form is the ordinary cause and it must not mint a second $1,000.
    const admin = await actingAs(ctx, 'admin', MASTER);
    const key = { headers: { 'idempotency-key': randomUUID() } };
    const body = {
      userId: clientId,
      amount: '10.00000000',
      currency: 'USD',
      reason: 'UAT journey 1 — the replay case.',
    };
    const first = await admin.post('/v1/admin/wallets/credit', body, key);
    expect(first.status).toBeLessThan(400);
    const second = await admin.post('/v1/admin/wallets/credit', body, key);
    expect(second.status).toBeLessThan(400);

    const { rows } = await ctx.db.db.execute<{ balance: string }>(sql`
      SELECT balance FROM wallets WHERE user_id = ${clientId} AND currency = 'USD'
    `);
    expect(rows[0].balance).toBe('1010.00000000');
  });
});

describe('§14 J1 — step 4: trading on an MT5 account', () => {
  it('refuses to open a live account SELF-SERVICE when no group is offered', async () => {
    /*
     * Not an obstacle to route around — it is the control, and worth walking.
     * `self-service-groups.ts` resolves the MT5 group from the catalogue this
     * client is actually offered, because `group` arrives from a browser and an
     * unvalidated one would let a client name another agency's group, whose
     * commission would then be paid to somebody who introduced nobody.
     *
     * No catalogue is configured on a fresh platform, so the honest answer is
     * "not available yet, contact support" rather than an account on a guessed
     * group. The broker opens it instead, below.
     */
    const client = await actingAs(ctx, 'portal', CLIENT);
    const res = await client.post(
      '/v1/trading/accounts',
      { environment: 'live', name: 'UAT live', leverage: 100 },
      idem(),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/not available yet/i);
  });

  it('the broker opens the live account for them, through the bridge', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.post(
      '/v1/admin/trading-accounts',
      { userId: clientId, group: 'real\\Standard', environment: 'live', leverage: 100 },
      idem(),
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
    tradingAccountId = (res.body as { id: string }).id;
    expect(tradingAccountId, 'the account was created without an id').toBeTruthy();
  });

  it('moves money from the wallet onto the account, and the wallet falls by exactly that', async () => {
    const client = await actingAs(ctx, 'portal', CLIENT);
    const before = await ctx.db.db.execute<{ balance: string }>(sql`
      SELECT balance FROM wallets WHERE user_id = ${clientId} AND currency = 'USD'
    `);

    const res = await client.post(
      '/v1/payments/transfers',
      {
        tradingAccountId,
        direction: 'wallet_to_account',
        amount: '400.00',
        currency: 'USD',
      },
      idem(),
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);

    const after = await ctx.db.db.execute<{ balance: string }>(sql`
      SELECT balance FROM wallets WHERE user_id = ${clientId} AND currency = 'USD'
    `);
    // To the cent, in decimal arithmetic — the amount that left the wallet is
    // the amount that was asked for, not a float's nearest neighbour.
    expect(Number(before.rows[0].balance) - Number(after.rows[0].balance)).toBeCloseTo(400, 8);
  });
});

describe('§14 J1 — step 5: withdrawing', () => {
  it('refuses a withdrawal larger than the balance', async () => {
    const client = await actingAs(ctx, 'portal', CLIENT);
    const res = await client.post(
      '/v1/payments/withdrawals',
      {
        amount: '99999.00',
        currency: 'USD',
        destination: '+96170111222',
        methodKey: 'whish',
      },
      idem(),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a withdrawal with no idempotency key', async () => {
    // Not a formality: a double-clicked button is two genuinely distinct
    // requests, and without the key both place a hold.
    const client = await actingAs(ctx, 'portal', CLIENT);
    const res = await client.post('/v1/payments/withdrawals', {
      amount: '50.00',
      currency: 'USD',
      destination: '+96170111222',
      methodKey: 'whish',
    });
    expect(res.status).toBe(400);
  });

  it('accepts the request and DEBITS immediately, which is the safer of the two designs', async () => {
    const client = await actingAs(ctx, 'portal', CLIENT);
    const res = await client.post(
      '/v1/payments/withdrawals',
      {
        amount: '100.00',
        currency: 'USD',
        destination: '+96170111222',
        methodKey: 'whish',
      },
      idem(),
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
    withdrawalId = (res.body as { id: string }).id;

    const { rows } = await ctx.db.db.execute<{ balance: string; held: string }>(sql`
      SELECT balance, on_hold AS held FROM wallets WHERE user_id = ${clientId} AND currency = 'USD'
    `);
    /*
     * The wallet is DEBITED at request time — not held — and the money is gone
     * from the spendable balance before any operator has looked at it.
     *
     * Worth pinning rather than assuming, because the obvious design is a hold
     * and this is deliberately not that. `wallets.post` locks the row and
     * refuses an overdraft, so the debit IS the balance check and it is the only
     * one that cannot be raced: a check before the insert is a read-then-write,
     * and two withdrawals submitted together would both pass it. A rejection
     * later posts a compensating credit (§6.4), which is why the ledger can stay
     * append-only through a reversal.
     *
     * 1010 credited − 400 moved to MT5 − 100 requested.
     */
    expect(Number(rows[0].balance)).toBeCloseTo(510, 8);
    expect(Number(rows[0].held)).toBeCloseTo(0, 8);
  });

  it('an operator approves and settles it, and the client is told', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const approved = await admin.patch(`/v1/admin/withdrawals/${withdrawalId}/approve`, {}, idem());
    expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(400);

    const state = (approved.body as { state?: string }).state;
    if (state !== 'success') {
      const settled = await admin.patch(
        `/v1/admin/withdrawals/${withdrawalId}/settle`,
        { providerRef: `uat-j1-${randomUUID()}` },
        idem(),
      );
      expect(settled.status, JSON.stringify(settled.body)).toBeLessThan(400);
    }

    const { rows } = await ctx.db.db.execute<{ state: string }>(sql`
      SELECT state FROM transactions WHERE id = ${withdrawalId}
    `);
    expect(rows[0].state).toBe('success');
    expect(await mail.waitFor('sendWithdrawalDecisionEmail', CLIENT.email)).toBeDefined();
  });

  it('the money has LEFT: the hold is released and the balance is lower', async () => {
    const { rows } = await ctx.db.db.execute<{ balance: string; held: string }>(sql`
      SELECT balance, on_hold AS held FROM wallets WHERE user_id = ${clientId} AND currency = 'USD'
    `);
    // Unchanged by the settlement, and that is the point: the debit happened at
    // REQUEST time, so approving and settling move the transaction's state
    // without moving money a second time. A settlement that debited again is
    // the defect this case would catch.
    expect(Number(rows[0].balance)).toBeCloseTo(510, 8);
    expect(Number(rows[0].held)).toBeCloseTo(0, 8);
  });
});

describe('§14 J1 — the acceptance condition: the money path balances to the cent', () => {
  it('reconciles every wallet against its own ledger', async () => {
    /*
     * §14: "the money-path reconciliation balances to the cent". Run at the END
     * of the journey rather than on a fixture, because the point is that the
     * journey itself left the books balanced — registration, a credit, a
     * replayed credit, a transfer out to MT5, a hold, a release and a payout.
     */
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get('/v1/admin/reconciliation');
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const report = res.body as { discrepancies?: unknown[]; walletsChecked?: number };
    // The non-vacuity floor: a reconciliation that checked nothing balances.
    expect(report.walletsChecked ?? 0).toBeGreaterThan(0);
    expect(report.discrepancies ?? [], JSON.stringify(report.discrepancies)).toHaveLength(0);
  });
});
