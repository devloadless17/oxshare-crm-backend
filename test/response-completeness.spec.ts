import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { eq } from 'drizzle-orm';
import {
  admins,
  kycSubmissions,
  roles,
  transactions,
  users,
  wallets,
} from '../src/database/schema';
import {
  KycListResponseDto,
  KycSubmissionDto,
  WalletListResponseDto,
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
let clientId: string;

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
  ctx = await startHttpTestApp();
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
      phone: '+961 3 000 111',
      country: 'Lebanon',
      emailVerified: true,
    })
    .returning();
  clientId = client.id;

  await db.insert(kycSubmissions).values({
    userId: clientId,
    status: 'submitted',
    submittedAt: new Date(),
    personalInfo: {
      firstName: 'Completeness',
      lastName: 'Target',
      email: 'completeness-target@oxshare-e2e.test',
      phone: '+961 3 000 111',
      dateOfBirth: '1988-02-02',
      nationality: 'Lebanon',
      country: 'Lebanon',
    },
    document: { docType: 'passport', fileName: 'doc.png' },
    selfie: { fileName: 'selfie.png' },
    addressProof: { docType: 'utility_bill', fileName: 'proof.png' },
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
