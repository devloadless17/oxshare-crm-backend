import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { uploadStandardKycDocuments } from './support/kyc-upload';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
} from './http-setup';
import { emailRecorder } from './email-recorder';
import { EmailService } from '../src/modules/email/email.service';
import { Mt5BridgeClient } from '../src/modules/trading/mt5/mt5-bridge.client';
import { PayoutEngine } from '../src/modules/payments/core/payout-engine.service';
import { DealCommissionService } from '../src/modules/trading/mt5/deal-commission.service';
import { CommissionService } from '../src/modules/ib/commission.service';
import { PasswordService } from '../src/common/security/password.service';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';
import { admins, kycConfigSteps, roles, users } from '../src/database/schema';
import { SIGN_UP_DETAILS } from './support/registration';

/**
 * FSD §14, JOURNEYS 2 AND 3 — walked as one platform, because they are one.
 *
 * > J2: "A client signing up through an IB referral link, being attributed to
 * >      that IB, depositing, trading, and generating spread-based commission
 * >      that distributes up the multi-level IB chain and (where the program
 * >      mode requires) a rebate that credits the client wallet."
 * > J3: "An IB being assigned to a named program, accruing commission across
 * >      closed deals, confirming after the settlement window, and requesting
 * >      and receiving a payout."
 *
 * ## Why they share a file
 *
 * J3's partner is J2's partner and J3's accruals are the ones J2 produced.
 * Splitting them would mean building the second platform by hand and asserting
 * a payout against accruals no journey created — which is the fixture-shaped
 * testing these journeys exist to get past.
 *
 * ## What is real here and what is stood in for
 *
 * The referral link, the attribution, the deal feed, the accrual engine, the
 * settlement window, the confirmation and the payout are all the shipped code
 * paths, reached over HTTP wherever a route exists.
 *
 * Two seams are driven directly, and neither is a shortcut past a rule:
 *
 *  - `DealCommissionService.accruePending()` and `CommissionService
 *    .confirmPending()` are normally woken by a self-rescheduling timer. A test
 *    that waited for the timer would be a slow test that still asserted the
 *    same thing; calling them is what the timer does.
 *  - The accruals are AGED in SQL before the second confirm run. Only the clock
 *    moves — the window itself is read from the live setting, and the case
 *    before it proves the window actually withholds.
 *
 * `ib-end-to-end.spec.ts` is the sibling that proves the ENGINE across seven
 * partners and four programme modes. This proves the JOURNEY: that one person
 * can follow a link and one partner can be paid for it.
 */

const MASTER = { email: 'uat-j2-master@oxshare.com', password: 'admin-password-123' };
const PARTNER = { email: 'uat-j2-partner@oxshare-e2e.test', password: 'PartnerPass123!' };
const REFERRED = { email: 'uat-j2-referred@oxshare-e2e.test', password: 'ClientPass123!' };

/** Matches `vitest.config.mts` — the webhook fails closed without it. */
const BRIDGE_SECRET = 'test-only-bridge-secret-never-used-outside-vitest';
const LOGIN = '5091001';
/** An hour, the minimum the settings DTO accepts (`@Min(60)`) with room to spare. */
const HOLD_SECONDS = 3600;

let ctx: HttpTestContext;
let mail: ReturnType<typeof emailRecorder>;
let partnerId: number;
let referredId: number;
let referralCode: string;
let tradingAccountId: string;
let agencyId: string;

const idem = () => ({ headers: { 'idempotency-key': randomUUID() } });
const PORTAL_ORIGIN = process.env['PORTAL_URL'] ?? 'http://localhost:3000';

/** Register, verify from the emailed token, and sign in — J1's opening, reused. */
async function onboard(
  credentials: { email: string; password: string },
  extra: Record<string, unknown> = {},
): Promise<number> {
  const res = await anonymous(ctx)
    .post('/v1/auth/register')
    .set('Origin', PORTAL_ORIGIN)
    .send({
      firstName: 'Journey',
      lastName: 'Person',
      email: credentials.email,
      password: credentials.password,
      ...SIGN_UP_DETAILS,
      country: 'Lebanon',
      ...extra,
    });
  if (res.status >= 400) {
    throw new Error(
      `register(${credentials.email}) failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  const sent = mail.find('sendVerificationEmail', credentials.email);
  if (!sent) throw new Error(`no verification email for ${credentials.email}`);
  await anonymous(ctx)
    .post('/v1/auth/verify-email')
    .set('Origin', PORTAL_ORIGIN)
    .send({ token: sent.args[1] as string })
    .expect((r) => {
      if (r.status >= 400) throw new Error(`verify failed: ${JSON.stringify(r.body)}`);
    });

  const [row] = await ctx.db.db.select().from(users).where(eq(users.email, credentials.email));
  return row.id;
}

/** Take a client to verification level 1, the gate on every money route. */
async function verifyKyc(
  credentials: { email: string; password: string },
  userId: number,
  phone: string,
) {
  const client = await actingAs(ctx, 'portal', credentials);
  await client.post('/v1/kyc/step', {
    step: 'personal',
    data: {
      firstName: 'Journey',
      lastName: 'Person',
      dateOfBirth: '1990-04-12',
      phone,
      nationality: 'Lebanese',
      country: 'Lebanon',
      // Required to verify, by the platform (the identity core, 26 Sep 2026).
      address: 'Hamra Street 12',
      city: 'Beirut',
    },
  });
  // Uploaded, as a client's are — see test/support/kyc-upload.ts.
  await uploadStandardKycDocuments(client);
  const submitted = await client.post('/v1/kyc/submit');
  if (submitted.status >= 400) throw new Error(`submit: ${JSON.stringify(submitted.body)}`);

  const admin = await actingAs(ctx, 'admin', MASTER);
  const approved = await admin.patch(`/v1/admin/kyc/${userId}/approve`, {});
  if (approved.status >= 400) throw new Error(`approve: ${JSON.stringify(approved.body)}`);
}

/** One deal, over the bridge webhook — the real ingestion path. */
async function postDeal(deal: {
  dealId: string;
  entry: number;
  commission: string;
  positionId: string;
  volume?: string;
}) {
  return await request(ctx.server)
    .post('/v1/webhooks/mt5/deals')
    .set('X-Bridge-Secret', BRIDGE_SECRET)
    .send({
      dealId: deal.dealId,
      login: LOGIN,
      positionId: deal.positionId,
      symbol: 'EURUSD',
      action: 0,
      entry: deal.entry,
      volume: deal.volume ?? '2.00000000',
      price: '1.08542000',
      profit: '0.00000000',
      commission: deal.commission,
      swap: '0.00000000',
      dealtAt: new Date().toISOString(),
    });
}

beforeAll(async () => {
  mail = emailRecorder();
  ctx = await startHttpTestApp({
    overrides: [
      { token: EmailService, value: mail.service },
      {
        token: Mt5BridgeClient,
        value: {
          isConfigured: true,
          createAccount: () =>
            Promise.resolve({
              login: Number(LOGIN),
              group: 'real\\Standard',
              leverage: 100,
              currency: 'USD',
              masterPassword: 'Master!1',
              investorPassword: 'Investor!1',
            }),
          balance: () => Promise.resolve({ dealId: '900002', replayed: false }),
          getAccount: () =>
            Promise.resolve({
              login: Number(LOGIN),
              balance: '500.00',
              equity: '500.00',
              currency: 'USD',
            }),
        },
      },
      {
        token: PayoutEngine,
        value: {
          // The desk pays — the no-rail behaviour these journeys depend on.
          decide: () => Promise.resolve({ kind: 'desk' }),
          plan: () =>
            Promise.resolve({
              payer: 'desk',
              provider: null,
              reason: null,
              gross: null,
              fee: null,
              net: null,
            }),
          submitApproved: () => Promise.resolve(),
          resubmit: () => Promise.resolve(),
          cancelApproved: () => Promise.resolve(),
          reconcile: () => Promise.resolve(),
          onNotice: () => Promise.resolve('ignored'),
        },
      },
    ],
  });

  const db = ctx.db.db;
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
    .values({ name: 'UAT J2 Master', permissions: ALL_PERMISSIONS, isSystem: true })
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

  /*
   * THE NAMED PROGRAMME — J3's first clause. Rung 1 carries BOTH terms, so one
   * closed round turn proves the two halves J2 asks for: commission up the
   * chain, and a rebate crediting the CLIENT's wallet.
   *
   * ⚠️ PRICED PER LOT, and the FSD's wording is out of date here rather than
   * this fixture. §14 says "spread-based commission", and rungs were a
   * percentage of a revenue figure when it was written. Migration 0117 made
   * per-lot the ONLY shape a rung can have — `ib_levels_commission_shape` now
   * refuses anything else — because a percentage of broker revenue and a figure
   * per lot are different contracts and the broker agreed to the second. The
   * journey is walked as the system is built, and the divergence is recorded
   * here rather than asserted away.
   */
  await db.execute(sql`
    INSERT INTO ib_levels (level, name, commission_share, rebate_share, enabled)
    VALUES (1, 'UAT Standard', 100, 100, true)
    ON CONFLICT (level) DO UPDATE
      SET name = 'UAT Standard', commission_share = 100, rebate_share = 100, enabled = true
  `);

  /*
   * The PRODUCT the account below is opened on, sold on a COMMISSION TYPE of
   * 1.50 a lot to the partner and 0.50 a lot back to the client (0140). The
   * admin opens the account in `real\Standard`, and the group is what links the
   * account to the product — so the group has to be on the catalogue before
   * step 3, or the trade in step 4 belongs to no product and is refused.
   */
  const { rows: uatTypes } = await db.execute<{ id: string }>(sql`
    INSERT INTO ib_commission_types (name, commission_per_lot, rebate_per_lot)
    VALUES ('UAT Standard', 1.50000000, 0.50000000)
    ON CONFLICT (name) DO UPDATE
      SET commission_per_lot = 1.50000000, rebate_per_lot = 0.50000000, enabled = true
    RETURNING id
  `);
  const { rows: uatProducts } = await db.execute<{ id: string }>(sql`
    INSERT INTO trading_products (name, enabled, type, sort_order, commission_type_id)
    VALUES ('UAT Standard', true, 'real', 900, ${uatTypes[0].id})
    ON CONFLICT (name) DO UPDATE SET commission_type_id = ${uatTypes[0].id}
    RETURNING id
  `);
  /* BOUND, not inlined: a backslash inside the query text is eaten on the
     way to the server, and `realStandard` matches no account's group. */
  /*
   * The group is made THIS product's alone. A group may back several products
   * since 0142, and the admin open path refuses an ambiguous group rather than
   * guessing its commission type — so any other attachment would stop step 3.
   */
  await db.execute(sql`
    DELETE FROM trading_product_groups WHERE lower(mt5_group) = lower(${'real\\Standard'})
  `);
  await db.execute(sql`
    INSERT INTO trading_product_groups (product_id, environment, mt5_group, currency)
    VALUES (${uatProducts[0].id}, 'live', ${'real\\Standard'}, 'USD')
  `);
}, 240_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('§14 J2 — step 1: a partner exists and has a referral link', () => {
  it('refuses an application from somebody who is not verified', async () => {
    /*
     * A real gate, walked rather than routed around. A partner is paid money
     * and is the person a client's attribution points at, so "who is this"
     * has to be answered before they can be one — and the refusal has to come
     * from the server, not from the portal declining to show the form.
     */
    partnerId = await onboard(PARTNER);
    const partner = await actingAs(ctx, 'portal', PARTNER);
    const res = await partner.post('/v1/ib/apply', {
      motivation: 'UAT journey 2 — introducing clients.',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/verified/i);
  });

  it('refuses an application that names no programme', async () => {
    /*
     * The other half of the same idea: an agency decides the terms a partner is
     * approved onto, so an application naming none is one nobody can action
     * without inventing the contract. Refused at the edge rather than defaulted.
     */
    await verifyKyc(PARTNER, partnerId, '+96170111333');
    const partner = await actingAs(ctx, 'portal', PARTNER);
    const res = await partner.post('/v1/ib/apply', {
      motivation: 'UAT journey 2 — introducing clients.',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/programme|program/i);
  });

  it('accepts it once they are verified and have chosen a programme', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const created = await admin.post('/v1/admin/agencies', {
      name: 'UAT Agency',
      description: 'The programme this journey’s partner is approved onto.',
      enabled: true,
      sortOrder: 0,
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(400);

    const partner = await actingAs(ctx, 'portal', PARTNER);
    const offered = await partner.get('/v1/ib/agencies');
    expect(offered.status).toBe(200);
    const agencies = offered.body as { id: string; name: string }[];
    agencyId = agencies.find((a) => a.name === 'UAT Agency')?.id ?? '';
    expect(agencyId, 'the agency the desk created is not offered to applicants').toBeTruthy();

    const res = await partner.post('/v1/ib/apply', {
      agencyId,
      motivation: 'UAT journey 2 — introducing clients.',
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
  });

  it('the desk approves the application, and the partner is told', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const list = await admin.get('/v1/admin/ib/applications?status=pending&limit=50');
    expect(list.status).toBe(200);
    /*
     * A row is `{ application, user }`, not a flattened record. The queue names
     * the applicant — the screen has to show who is asking — so the application
     * and the person it is about arrive as two objects rather than one merged
     * shape whose `id` would be ambiguous.
     */
    const rows = (list.body as { rows: { application: { id: string; userId: number } }[] }).rows;
    const mine = rows.find((r) => r.application.userId === partnerId);
    expect(
      mine,
      `the application is not in the pending queue: ${JSON.stringify(list.body)}`,
    ).toBeDefined();

    const approved = await admin.patch(
      `/v1/admin/ib/applications/${mine!.application.id}/approve`,
      {},
    );
    expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(400);
    expect(await mail.waitFor('sendPartnerDecisionEmail', PARTNER.email)).toBeDefined();
  });

  it('approval mints the referral code the link is built from', async () => {
    const { rows } = await ctx.db.db.execute<{ referral_code: string; level: number }>(sql`
      SELECT referral_code, level FROM ib_accounts WHERE user_id = ${partnerId}
    `);
    expect(rows.length, 'approval created no partner account').toBe(1);
    referralCode = rows[0].referral_code;
    expect(referralCode, 'the partner has no referral code').toBeTruthy();
    // "Assigned to a named program" — J3's first clause, as a real rung.
    expect(Number(rows[0].level)).toBeGreaterThanOrEqual(1);
  });
});

describe('§14 J2 — step 2: a client signs up through the link and is attributed', () => {
  it('registers with the referral code and is attributed to that partner', async () => {
    referredId = await onboard(REFERRED, { referralCode });

    const [row] = await ctx.db.db.select().from(users).where(eq(users.id, referredId));
    expect(row.referredByIbUserId, 'the referral was not attributed').toBe(partnerId);
  });

  it('an UNKNOWN code is REFUSED, naming it — never attributed to somebody, never silently to nobody', async () => {
    /*
     * The failure worth pinning has two halves. A mistyped or retired code must
     * not fall back to a default partner — that pays commission to somebody who
     * introduced nobody, silently, for as long as the wrong link is published.
     *
     * And since the owner's reversal (referral-attribution.spec.ts carries the
     * full argument) it must not register the client unattributed either: that
     * account looks correct to everyone, the partner never appears, and
     * attribution is permanent. So the registration is refused, loudly, with
     * the code named so the client can check the link — and no account exists.
     */
    const res = await anonymous(ctx)
      .post('/v1/auth/register')
      .set('Origin', PORTAL_ORIGIN)
      .send({
        firstName: 'Journey',
        lastName: 'Stranger',
        email: 'uat-j2-stranger@oxshare-e2e.test',
        password: 'StrangerPass123!',
        ...SIGN_UP_DETAILS,
        country: 'Lebanon',
        referralCode: 'NOSUCHCODE',
      });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/NOSUCHCODE/);

    const rows = await ctx.db.db
      .select()
      .from(users)
      .where(eq(users.email, 'uat-j2-stranger@oxshare-e2e.test'));
    expect(rows).toHaveLength(0);
  });
});

describe('§14 J2 — step 3: the referred client deposits and trades', () => {
  it('is verified, funded, and given a live account', async () => {
    await verifyKyc(REFERRED, referredId, '+96170111444');

    const admin = await actingAs(ctx, 'admin', MASTER);
    const credited = await admin.post(
      '/v1/admin/wallets/credit',
      {
        userId: referredId,
        amount: '1000.00000000',
        currency: 'USD',
        reason: 'UAT journey 2 — the referred client’s deposit.',
      },
      idem(),
    );
    expect(credited.status, JSON.stringify(credited.body)).toBeLessThan(400);

    const opened = await admin.post(
      '/v1/admin/trading-accounts',
      { userId: referredId, group: 'real\\Standard', environment: 'live', leverage: 100 },
      idem(),
    );
    expect(opened.status, JSON.stringify(opened.body)).toBeLessThan(400);
    tradingAccountId = (opened.body as { id: string }).id;

    const client = await actingAs(ctx, 'portal', REFERRED);
    const moved = await client.post(
      '/v1/payments/transfers',
      { tradingAccountId, direction: 'wallet_to_account', amount: '500.00', currency: 'USD' },
      idem(),
    );
    expect(moved.status, JSON.stringify(moved.body)).toBeLessThan(400);
  });

  it('the bridge delivers a closed round turn, and a replay changes nothing', async () => {
    const opening = await postDeal({
      dealId: 'UATJ2-OPEN',
      entry: 0,
      commission: '-4.00000000',
      positionId: 'UATJ2-P1',
    });
    expect(opening.status, JSON.stringify(opening.body)).toBe(200);

    const closing = await postDeal({
      dealId: 'UATJ2-CLOSE',
      entry: 1,
      commission: '-6.00000000',
      positionId: 'UATJ2-P1',
    });
    expect(closing.status, JSON.stringify(closing.body)).toBe(200);

    /*
     * Every deal is delivered TWICE by design — the push and the 24-hour sweep.
     * `ingested: false` is the expected answer to the second, and it is a
     * database constraint saying so rather than a check-then-insert.
     */
    const replay = await postDeal({
      dealId: 'UATJ2-CLOSE',
      entry: 1,
      commission: '-6.00000000',
      positionId: 'UATJ2-P1',
    });
    expect(replay.status).toBe(200);
    expect((replay.body as { ingested: boolean }).ingested).toBe(false);
  });
});

describe('§14 J2 — step 4: the round turn pays the chain and rebates the client', () => {
  it('accrues commission for the partner and a rebate for the client', async () => {
    const deals = ctx.app.get(DealCommissionService);
    const run = await deals.accruePending();
    expect(run, 'the accrual pass returned nothing').toBeDefined();

    const { rows } = await ctx.db.db.execute<{
      ib_user_id: number;
      client_user_id: number;
      kind: string;
      amount: string;
      status: string;
    }>(sql`
      SELECT ib_user_id, client_user_id, kind, amount, status
      FROM ib_accruals ORDER BY kind
    `);

    // The non-vacuity floor: a pass that accrued nothing would satisfy every
    // "every row is…" assertion below.
    expect(rows.length, 'the closed round turn produced no accrual at all').toBeGreaterThan(0);

    const commission = rows.find((r) => r.kind === 'commission');
    const rebate = rows.find((r) => r.kind === 'rebate');

    /*
     * TWO LOTS on the round turn, at 1.50 per lot to the partner and 0.50 per
     * lot back to the client:
     *   partner 3.00, client 1.00 — to the cent, in decimal arithmetic.
     *
     * The two figures are deliberately different, so a rebate credited to the
     * partner or a commission credited to the client cannot pass by matching a
     * total.
     */
    expect(commission, 'the partner earned nothing on their client’s trade').toBeDefined();
    expect(commission?.ib_user_id).toBe(partnerId);
    expect(commission?.client_user_id).toBe(referredId);
    expect(commission?.amount).toBe('3.00000000');

    expect(rebate, 'the programme rebates and the client received nothing').toBeDefined();
    expect(rebate?.client_user_id).toBe(referredId);
    expect(rebate?.amount).toBe('1.00000000');

    // Both start PENDING. Nothing is paid before the settlement window.
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
  });

  it('a second accrual pass over the same deals pays nobody twice', async () => {
    // UNIQUE(deal_id, ib_user_id, level) is the §6.3 guarantee, and this is the
    // ordinary cause: the drain runs on a timer and a slow pass overlaps itself.
    const before = await ctx.db.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM ib_accruals`,
    );
    await ctx.app.get(DealCommissionService).accruePending();
    const after = await ctx.db.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM ib_accruals`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('§14 J3 — step 5: confirming after the settlement window', () => {
  it('withholds everything while the window is still open', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const set = await admin.put('/v1/admin/settings/trading', {
      maxLiveAccounts: 5,
      maxDemoAccounts: 5,
      maxDemoDeposit: '1000000.00',
      ibCommissionIntervalSeconds: HOLD_SECONDS,
    });
    expect(set.status, JSON.stringify(set.body)).toBeLessThan(400);

    const result = await ctx.app.get(CommissionService).confirmPending();
    /*
     * "Nothing was paid" has two very different causes and the service reports
     * them apart on purpose: nobody earned anything, or everything earned is
     * still maturing. This asserts the second — the window WITHHOLDS, which is
     * what makes the next case evidence rather than a coincidence of timing.
     */
    expect(result.confirmed).toBe(0);
    expect(result.held).toBeGreaterThan(0);
  });

  it('confirms once the window has passed, and credits the partner', async () => {
    /*
     * Only the CLOCK moves. The window itself is still read from the live
     * setting above; ageing the rows is how a one-hour window is crossed inside
     * a test that must not take an hour.
     */
    await ctx.db.db.execute(sql`
      UPDATE ib_accruals SET created_at = now() - interval '2 hours'
    `);

    const result = await ctx.app.get(CommissionService).confirmPending();
    expect(result.confirmed, 'the matured accruals were not confirmed').toBeGreaterThan(0);
    expect(result.failed).toBe(0);

    const { rows } = await ctx.db.db.execute<{ status: string }>(sql`
      SELECT status FROM ib_accruals
    `);
    expect(rows.every((r) => r.status === 'confirmed')).toBe(true);
  });

  it('the money is IN the partner’s wallet, not merely recorded as owed', async () => {
    const { rows } = await ctx.db.db.execute<{ kind: string; balance: string }>(sql`
      SELECT kind, balance FROM wallets WHERE user_id = ${partnerId} AND currency = 'USD'
    `);
    const total = rows.reduce((sum, r) => sum + Number(r.balance), 0);
    expect(total, 'the confirmed commission never reached a wallet').toBeCloseTo(3, 8);
  });

  it('the client’s REBATE reached the client’s own wallet', async () => {
    // J2's last clause. A rebate credited to the partner would be the same
    // number in the wrong account, and no total would notice.
    const { rows } = await ctx.db.db.execute<{ balance: string }>(sql`
      SELECT balance FROM wallets
      WHERE user_id = ${referredId} AND currency = 'USD' AND kind = 'main'
    `);
    // 1000 credited − 500 to MT5 + 1.00 rebate.
    expect(Number(rows[0].balance)).toBeCloseTo(501, 8);
  });
});

describe('§14 J3 — step 6: the partner requests and receives a payout', () => {
  it('moves earnings into the wallet they can withdraw from, ONCE per key', async () => {
    const partner = await actingAs(ctx, 'portal', PARTNER);
    const overview = await partner.get('/v1/ib/overview');
    expect(overview.status).toBe(200);

    /*
     * Posted TWICE with the SAME key — R-5.2, and the reason this route now
     * carries `@Idempotent()`.
     *
     * Both legs of a transfer commit in one transaction, so it cannot
     * half-happen. What nothing stopped was the same transfer happening twice: a
     * double-clicked "Move to wallet", or a client retrying after a response was
     * lost in transit. Both ledger rows would be correct and permanent — the
     * ledger is append-only, so undoing one is a compensating entry a human
     * writes, against a partner who has already seen the balance.
     *
     * Asserted on the BALANCE, not on the status code. An interceptor that
     * answers 200 twice while letting both writes through satisfies every status
     * assertion, and is precisely the defect worth catching.
     */
    const key = idem();
    const body = { amount: '3.00', currency: 'USD' };

    const res = await partner.post('/v1/ib/wallet/transfer', body, key);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);

    const replay = await partner.post('/v1/ib/wallet/transfer', body, key);
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(400);

    const { rows } = await ctx.db.db.execute<{ balance: string }>(sql`
      SELECT balance FROM wallets
      WHERE user_id = ${partnerId} AND currency = 'USD' AND kind = 'main'
    `);
    // THREE, not six: the replay was absorbed.
    expect(Number(rows[0].balance)).toBeCloseTo(3, 8);
  });

  it('refuses to move more than has been earned', async () => {
    const partner = await actingAs(ctx, 'portal', PARTNER);
    const res = await partner.post(
      '/v1/ib/wallet/transfer',
      { amount: '1000.00', currency: 'USD' },
      idem(),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('§14 J2/J3 — the acceptance condition: the money path balances to the cent', () => {
  it('reconciles every wallet on the platform this journey built', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get('/v1/admin/reconciliation');
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const report = res.body as { discrepancies?: unknown[]; walletsChecked?: number };
    expect(report.walletsChecked ?? 0).toBeGreaterThan(0);
    expect(report.discrepancies ?? [], JSON.stringify(report.discrepancies)).toHaveLength(0);
  });
});
