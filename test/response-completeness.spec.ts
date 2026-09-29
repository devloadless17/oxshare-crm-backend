import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { eq } from 'drizzle-orm';
import { IbPartnerDetailDto } from '../src/modules/ib/dto/ib-application.dto';
import { CreatedMt5AccountDto } from '../src/modules/trading/mt5/dto/mt5-account.dto';
import { Mt5BridgeClient } from '../src/modules/trading/mt5/mt5-bridge.client';
import { RivalWithdrawalsService } from '../src/modules/payments/rival/rival-withdrawals.service';
import {
  admins,
  ibAccounts,
  kycSubmissions,
  roles,
  tradingAccounts,
  transactions,
  users,
  wallets,
} from '../src/database/schema';
import {
  AdminTransactionListResponseDto,
  AdminTransactionRowDto,
  ClientAccountDto,
  KycListResponseDto,
  KycSubmissionDto,
  TradingAccountListResponseDto,
  TradingAccountRowDto,
  WalletListResponseDto,
  WithdrawalListResponseDto,
  WithdrawalRowDto,
} from '../src/modules/admin/dto/responses.dto';

/**
 * A RESPONSE MAY NOT RETURN A KEY ITS SHAPE DOES NOT DECLARE.
 *
 * ## Why this is a security property and not a documentation one
 *
 * Masking is done by walking a route's declared DTO and removing the fields
 * marked `@ClientField`. So a field the DTO omits is a field the mask cannot
 * see — it is returned, and nothing can hide it. `ClientRowDto` omitted `phone`
 * while the API had always returned it, and deleting the old path-based mask
 * would have turned that into a live leak on the client list.
 *
 * There are two guarantees behind masking and they have very different reach:
 *
 *   catalogue → mark      UNIVERSAL. `mask-equivalence.spec.ts` builds an object
 *                         carrying every maskable path for every resource and
 *                         requires the shape mask to remove all of them. No
 *                         fixture, no HTTP.
 *   response → declared   FIXTURE-BOUND. It needs a populated response, so it
 *                         reaches only the surfaces something has seeded.
 *
 * The second is the one that caught `phone`, and 21 admin responses reach a
 * person-carrying shape. This file exists to move that number, one surface at a
 * time, starting with the ones the exposures were actually found on.
 *
 * ## Read as a MASTER, deliberately
 *
 * A masked reader passes this trivially by having FEWER keys. Only an unmasked
 * one sees everything the endpoint can emit, which is the set that has to be
 * declared.
 *
 * ## The base rate is not low
 *
 * Every shape this check has been pointed at so far has been under-declared:
 * `ClientRowDto.phone` on the first surface, and `KycSubmissionDto`'s own
 * `createdAt`/`updatedAt` the first time it was extended. Treat a new surface
 * as probably-failing rather than probably-fine.
 */

const MASTER = { email: 'completeness-master@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
let clientId: number;

const SWAGGER_PROPERTY_LIST = 'swagger/apiModelPropertiesArray';

/** The property names a DTO declares, as Swagger recorded them. */
function declaredOn(shape: unknown): Set<string> {
  const names = Reflect.getMetadata(
    SWAGGER_PROPERTY_LIST,
    (shape as { prototype: object }).prototype,
  ) as string[] | undefined;
  return new Set((names ?? []).map((name) => name.replace(/^:/, '')));
}

/** Keys present on `row` that `shape` never mentions. */
function undeclared(shape: unknown, row: Record<string, unknown>): string[] {
  const declared = declaredOn(shape);
  return Object.keys(row).filter((key) => !declared.has(key));
}

const report = (name: string, keys: string[]) =>
  `These keys are RETURNED and not declared on ${name}. Both frontends are missing ` +
  `them, and the response interceptor cannot mask what the shape does not ` +
  `mention:\n${keys.map((k) => `  ${k}`).join('\n')}`;

beforeAll(async () => {
  ctx = await startHttpTestApp({
    /*
     * The two routes that cross to a service we do not own. What is being
     * asserted is the shape OUR code returns — the real controller, service,
     * DTO and mask interceptor all run; only the far end is canned. Without
     * this the two routes are untestable here, and an untestable route
     * becomes a skipped test, which reports as passing.
     */
    overrides: [
      {
        token: Mt5BridgeClient,
        value: {
          isConfigured: () => true,
          createAccount: () =>
            Promise.resolve({
              login: 5099002,
              group: 'real\\Standard',
              leverage: 100,
              currency: 'USD',
              masterPassword: 'Master!1',
              investorPassword: 'Investor!1',
            }),
        },
      },
      {
        /*
         * All THREE methods the rest of the code calls, not just the one this
         * file drives. `willPayOut` stays FALSE so the no-rail behaviour the
         * transition cases depend on is unchanged — approve settles in one
         * step, exactly as it does without this stub.
         */
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
  const passwords = new PasswordService();

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Completeness Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Completeness Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  const [client] = await db
    .insert(users)
    .values({
      email: 'completeness-target@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Completeness',
      lastName: 'Target',
      phone: '+9613000111',
      country: 'Lebanon',
      // Every profile field filled (0139), so a response that carries one the
      // DTO does not declare cannot pass by the field being empty.
      dateOfBirth: '1988-02-02',
      nationality: 'Lebanese',
      address: 'Completeness Street 1',
      city: 'Beirut',
      postalCode: '1103',
      emailVerified: true,
    })
    .returning();
  clientId = client.id;

  await db.insert(kycSubmissions).values({
    userId: clientId,
    status: 'submitted',
    submittedAt: new Date(),
    // The identity is the profile's; only a broker's own answers live here.
    personalInfo: { customField_1: 'Completeness answer' },
    document: { docType: 'passport', frontFilePath: 'uploads/kyc/doc.png' },
    selfie: { filePath: 'uploads/kyc/selfie.png' },
    addressProof: { docType: 'utility_bill', filePath: 'uploads/kyc/proof.png' },
  });

  // A wallet, so the holdings desk has a row to return rather than an empty
  // page — against which every "is this key declared" question is vacuous.
  await db
    .insert(wallets)
    .values({ userId: clientId, currency: 'USD', balance: '250.00000000', onHold: '0' });
}, 120_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('every admin response declares the keys it returns', () => {
  it('the KYC QUEUE row', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/kyc?status=submitted&limit=25').expect(200);

    const body = res.body as { items: Record<string, unknown>[] };
    expect(body.items.length, 'no submission in the queue — nothing was checked').toBeGreaterThan(
      0,
    );

    const envelope = undeclared(KycListResponseDto, res.body as Record<string, unknown>);
    expect(envelope, report('KycListResponseDto', envelope)).toEqual([]);

    const rows = [...new Set(body.items.flatMap((r) => Object.keys(r)))];
    const declared = declaredOn(KycSubmissionDto);
    const missing = rows.filter((key) => !declared.has(key));
    expect(missing, report('KycSubmissionDto (queue row)', missing)).toEqual([]);
  });

  it('the WALLET desk row', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/wallets?limit=25').expect(200);

    const body = res.body as { items: Record<string, unknown>[] };
    expect(body.items.length, 'no wallet returned — nothing was checked').toBeGreaterThan(0);

    const envelope = undeclared(WalletListResponseDto, res.body as Record<string, unknown>);
    expect(envelope, report('WalletListResponseDto', envelope)).toEqual([]);
  });

  it('the KYC CLAIM and RELEASE responses', async () => {
    /*
     * Two of the eight transition routes exposure 7 lived on — a decision that
     * returned the whole submission, unmasked, beside a read that masked it
     * correctly. They were fixed by marking the fields, which the universal
     * check now covers; what was never checked is whether their responses
     * declare everything they project.
     *
     * Chosen first of the eight because the pair is REVERSIBLE: claiming and
     * releasing leaves the submission exactly as found, so this adds no
     * ordering coupling to the file and needs no fixture of its own.
     */
    const session = await actingAs(ctx, 'admin', MASTER);

    const claimed = await session.patch(`/v1/admin/kyc/${clientId}/claim`).expect(200);
    const onClaim = undeclared(KycSubmissionDto, claimed.body as Record<string, unknown>);
    expect(onClaim, report('KycSubmissionDto (claim response)', onClaim)).toEqual([]);

    const released = await session.patch(`/v1/admin/kyc/${clientId}/release`).expect(200);
    const onRelease = undeclared(KycSubmissionDto, released.body as Record<string, unknown>);
    expect(onRelease, report('KycSubmissionDto (release response)', onRelease)).toEqual([]);

    // Left as found, so nothing downstream depends on the order this ran in.
    expect((released.body as { status: string }).status).toBe('submitted');
  });

  it('the KYC APPROVE response', async () => {
    /*
     * Runs LAST of the transitions and is one-way: approval is terminal for
     * this fixture, so nothing after it may assume a pending submission. That
     * is why the reversible pair above is a separate case rather than part of
     * this one.
     */
    const session = await actingAs(ctx, 'admin', MASTER);
    const approved = await session.patch(`/v1/admin/kyc/${clientId}/approve`).expect(200);

    const keys = undeclared(KycSubmissionDto, approved.body as Record<string, unknown>);
    expect(keys, report('KycSubmissionDto (approve response)', keys)).toEqual([]);
  });
});

/*
 * THE WITHDRAWAL TRANSITIONS.
 *
 * These declared `WithdrawalRowDto` and returned the transaction ROW — 24 keys
 * against 18 declared, so both frontends typed the response as a desk row,
 * `user` included, and would have read undefined from a field TypeScript
 * promised. Not a masking leak: the transitions send no `user` object at all,
 * so there was never a client field on them to hide. It is the other half, and
 * the same one `phone` was — a response the shape did not admit to. The ten
 * missing keys are declared now; these keep them declared.
 */
describe('the withdrawal transitions declare the keys they return', () => {
  const WITHDRAWALS = '/v1/admin/withdrawals';

  /** A fresh pending payout on the fixture's wallet. `wallets_user_currency_kind_uq`
   *  means a second wallet is not an option, so every case shares this one. */
  const mintPendingWithdrawal = async (tag: string): Promise<string> => {
    const db = ctx.db.db;
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, clientId)).limit(1);
    expect(wallet, 'the fixture has no wallet to attach a payout to').toBeDefined();

    const [row] = await db
      .insert(transactions)
      .values({
        userId: clientId,
        walletId: wallet.id,
        direction: 'withdrawal',
        amount: '25.00000000',
        currency: 'USD',
        state: 'pending',
        provider: 'manual_test',
        destination: `completeness-${tag}`,
      })
      .returning();
    return row.id;
  };

  /*
   * SETTLE and CANCEL are only reachable from `approved`, and this environment
   * has no payout rail — so `approve` settles immediately and returns
   * `success`, the same fact `withdrawals-desk.spec.ts` guards with "no payout
   * rail is enabled, so approval already settled". Driving them needs the state
   * set directly.
   *
   * That is a real weakening, named rather than hidden: it proves the SHAPE of a
   * settle response, not that a transition ever produced that row. The shape is
   * what this file checks, and the alternative — skipping when no rail is
   * configured — is the vacuous pass the suite exists to stop reporting green.
   * A rail-backed path is what would let this comment be deleted; the review
   * pool does not help, it seeds pending KYC rather than payouts.
   */
  const forceApproved = async (id: string): Promise<void> => {
    await ctx.db.db
      .update(transactions)
      .set({ state: 'approved', settledAt: null })
      .where(eq(transactions.id, id));
  };

  it('the APPROVE response', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const id = await mintPendingWithdrawal('approve');

    const res = await session
      .patch(`${WITHDRAWALS}/${id}/approve`, undefined, {
        headers: { 'idempotency-key': `completeness-approve-${id}` },
      })
      .expect(200);

    const keys = undeclared(WithdrawalRowDto, res.body as Record<string, unknown>);
    expect(keys, report('WithdrawalRowDto (approve response)', keys)).toEqual([]);
  });

  it('the REJECT response', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const id = await mintPendingWithdrawal('reject');

    const res = await session
      .patch(
        `${WITHDRAWALS}/${id}/reject`,
        { reason: 'completeness check' },
        { headers: { 'idempotency-key': `completeness-reject-${id}` } },
      )
      .expect(200);

    const keys = undeclared(WithdrawalRowDto, res.body as Record<string, unknown>);
    expect(keys, report('WithdrawalRowDto (reject response)', keys)).toEqual([]);
  });

  it('the SETTLE response', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const id = await mintPendingWithdrawal('settle');
    await forceApproved(id);

    const res = await session
      .patch(
        `${WITHDRAWALS}/${id}/settle`,
        { providerRef: `completeness-ref-${id}` },
        { headers: { 'idempotency-key': `completeness-settle-${id}` } },
      )
      .expect(200);

    const keys = undeclared(WithdrawalRowDto, res.body as Record<string, unknown>);
    expect(keys, report('WithdrawalRowDto (settle response)', keys)).toEqual([]);
  });

  it('the CANCEL response', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const id = await mintPendingWithdrawal('cancel');
    await forceApproved(id);

    const res = await session
      .patch(
        `${WITHDRAWALS}/${id}/cancel`,
        { reason: 'completeness check' },
        { headers: { 'idempotency-key': `completeness-cancel-${id}` } },
      )
      .expect(200);

    const keys = undeclared(WithdrawalRowDto, res.body as Record<string, unknown>);
    expect(keys, report('WithdrawalRowDto (cancel response)', keys)).toEqual([]);
  });
});

/*
 * THE REMAINING LIST AND EDIT SURFACES.
 *
 * Every shape this check has been pointed at has been under-declared, so these
 * are written expecting to fail rather than to confirm. Each mints what it
 * needs: the desk and financial lists are empty until something is on them, and
 * "is every key declared" against an empty page is vacuously true.
 */
describe('the remaining person-carrying responses declare the keys they return', () => {
  const rowsOf = (body: unknown): Record<string, unknown>[] =>
    (body as { items?: Record<string, unknown>[] }).items ?? [];

  const mintWithdrawal = async (tag: string): Promise<string> => {
    const db = ctx.db.db;
    const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, clientId)).limit(1);
    const [row] = await db
      .insert(transactions)
      .values({
        userId: clientId,
        walletId: wallet.id,
        direction: 'withdrawal',
        amount: '15.00000000',
        currency: 'USD',
        state: 'pending',
        provider: 'manual_test',
        destination: `remaining-${tag}`,
      })
      .returning();
    return row.id;
  };

  it('the WITHDRAWAL desk list, envelope and rows', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    await mintWithdrawal('desk');

    const res = await session.get('/v1/admin/withdrawals?state=pending&limit=25').expect(200);

    const envelope = undeclared(WithdrawalListResponseDto, res.body as Record<string, unknown>);
    expect(envelope, report('WithdrawalListResponseDto', envelope)).toEqual([]);

    const rows = rowsOf(res.body);
    expect(rows.length, 'no payout on the desk — the assertion would be vacuous').toBeGreaterThan(
      0,
    );
    const onRow = [...new Set(rows.flatMap((r) => undeclared(WithdrawalRowDto, r)))];
    expect(onRow, report('WithdrawalRowDto (desk row)', onRow)).toEqual([]);
  });

  it('the FINANCIAL list, envelope and rows', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    await mintWithdrawal('financial');

    const res = await session.get('/v1/admin/transactions?limit=25').expect(200);

    const envelope = undeclared(
      AdminTransactionListResponseDto,
      res.body as Record<string, unknown>,
    );
    expect(envelope, report('AdminTransactionListResponseDto', envelope)).toEqual([]);

    const rows = rowsOf(res.body);
    expect(rows.length, 'no transactions — the assertion would be vacuous').toBeGreaterThan(0);
    const onRow = [...new Set(rows.flatMap((r) => undeclared(AdminTransactionRowDto, r)))];
    expect(onRow, report('AdminTransactionRowDto', onRow)).toEqual([]);
  });

  it('the TRADING ACCOUNT list, envelope and rows', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    await ctx.db.db.insert(tradingAccounts).values({
      userId: clientId,
      login: '5099001',
      name: 'Completeness Target',
      mt5Group: 'real\\Standard',
      environment: 'live',
      currency: 'USD',
      balance: '100.00000000',
    });

    const res = await session.get('/v1/admin/trading-accounts?limit=25').expect(200);

    const envelope = undeclared(TradingAccountListResponseDto, res.body as Record<string, unknown>);
    expect(envelope, report('TradingAccountListResponseDto', envelope)).toEqual([]);

    const rows = rowsOf(res.body);
    expect(rows.length, 'no trading account — the assertion would be vacuous').toBeGreaterThan(0);
    const onRow = [...new Set(rows.flatMap((r) => undeclared(TradingAccountRowDto, r)))];
    expect(onRow, report('TradingAccountRowDto', onRow)).toEqual([]);
  });

  it('the client PROFILE EDIT response', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    // The PHONE: this client's KYC is submitted, and from then on the phone is
    // the one field the desk may still change — the name is being checked
    // against their documents (`deskLocks`), and a rename answers 409.
    const res = await session
      .patch(`/v1/admin/clients/${clientId}`, { phone: '+961 3 000 222' })
      .expect(200);

    const keys = undeclared(ClientAccountDto, res.body as Record<string, unknown>);
    expect(keys, report('ClientAccountDto (profile edit)', keys)).toEqual([]);
  });

  it('the client EMAIL CHANGE response', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session
      .patch(`/v1/admin/clients/${clientId}/email`, {
        email: 'completeness-target-changed@oxshare-e2e.test',
      })
      .expect(200);

    const keys = undeclared(ClientAccountDto, res.body as Record<string, unknown>);
    expect(keys, report('ClientAccountDto (email change)', keys)).toEqual([]);
  });

  it('the KYC REJECT response', async () => {
    /*
     * Its own client: the fixture's submission is APPROVED by the transition
     * case above and approval is terminal, so rejecting it would either fail or
     * make the order of these two load-bearing.
     */
    const db = ctx.db.db;
    const [target] = await db
      .insert(users)
      .values({
        email: 'completeness-reject@oxshare-e2e.test',
        passwordHash: 'x',
        firstName: 'Reject',
        lastName: 'Target',
        emailVerified: true,
      })
      .returning();
    await db.insert(kycSubmissions).values({
      userId: target.id,
      status: 'submitted',
      submittedAt: new Date(),
      personalInfo: { firstName: 'Reject', lastName: 'Target' },
      document: { docType: 'passport', frontFilePath: 'uploads/kyc/doc.png' },
      addressProof: { docType: 'utility_bill', filePath: 'uploads/kyc/proof.png' },
    });

    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session
      .patch(`/v1/admin/kyc/${target.id}/reject`, { reason: 'completeness check' })
      .expect(200);

    const keys = undeclared(KycSubmissionDto, res.body as Record<string, unknown>);
    expect(keys, report('KycSubmissionDto (reject response)', keys)).toEqual([]);
  });

  it('the IB PARTNER detail response', async () => {
    /*
     * The partner detail returns the parent partner AND every direct
     * sub-partner — the shape exposure 8 was found on, where an array of people
     * was the thing that leaked. Its own client, so the fixture's client stays
     * an ordinary one for every case above.
     */
    const db = ctx.db.db;
    const [partner] = await db
      .insert(users)
      .values({
        email: 'completeness-partner@oxshare-e2e.test',
        passwordHash: 'x',
        firstName: 'Partner',
        lastName: 'Target',
        emailVerified: true,
      })
      .returning();
    await db
      .insert(ibAccounts)
      .values({ userId: partner.id, level: 1, referralCode: 'COMPLETENESS1', active: true });

    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/ib/partners/${partner.id}`).expect(200);

    const keys = undeclared(IbPartnerDetailDto, res.body as Record<string, unknown>);
    expect(keys, report('IbPartnerDetailDto', keys)).toEqual([]);
  });

  it('the TRADING ACCOUNT CREATE response', async () => {
    /*
     * Exposure 9's route: it returns `credentialsSentTo`, which IS the client's
     * email under a name no heuristic matches, and it was found by hand. The
     * bridge is stubbed — MT5 being reachable is not what this proves.
     */
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session
      .post('/v1/admin/trading-accounts', {
        userId: clientId,
        group: 'real\\Standard',
        environment: 'live',
      })
      .expect(201);

    const keys = undeclared(CreatedMt5AccountDto, res.body as Record<string, unknown>);
    expect(keys, report('CreatedMt5AccountDto', keys)).toEqual([]);
  });

  it('the RIVAL RESUBMIT response', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const id = await mintWithdrawal('rival');
    await ctx.db.db.update(transactions).set({ state: 'approved' }).where(eq(transactions.id, id));

    const res = await session
      .post(`/v1/admin/withdrawals/${id}/rival-submit`, undefined, {
        headers: { 'idempotency-key': `completeness-rival-${id}` },
      })
      .expect(201);

    const keys = undeclared(WithdrawalRowDto, res.body as Record<string, unknown>);
    expect(keys, report('WithdrawalRowDto (rival resubmit)', keys)).toEqual([]);
  });
});
