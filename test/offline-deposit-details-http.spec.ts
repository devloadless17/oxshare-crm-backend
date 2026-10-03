import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { KYC_TEST_PNG } from './support/kyc-upload';
import { PasswordService } from '../src/common/security/password.service';
import {
  currencies,
  paymentMethods,
  transactions,
  users,
  withdrawalPaymentMethods,
} from '../src/database/schema';

/**
 * The offline deposit form, end to end through HTTP (0163).
 *
 * The service specs call `requestDeposit` with an object already in hand. This
 * proves the part only the real route can: that `details[<fieldId>]` multipart
 * parts reach it as one object — multer folds them, and the global
 * ValidationPipe (`forbidNonWhitelisted`) lets the declared `details` through —
 * and that a refusal comes back keyed by the field, where the portal shows it.
 */
const CLIENT = { email: 'details-http@oxshare-e2e.test', password: 'client-password-123' };
const METHOD = 'omt_details_http';
const PHONE = 'f_phone00001';

let ctx: HttpTestContext;
let client: Session;

function file(details: Record<string, string>) {
  const req = client
    .post('/v1/payments/deposits/offline', undefined)
    .set('Idempotency-Key', randomUUID())
    .field('amount', '100')
    .field('currency', 'USD')
    .field('method', METHOD);
  for (const [id, value] of Object.entries(details)) req.field(`details[${id}]`, value);
  return req.attach('file', KYC_TEST_PNG, { filename: 'receipt.png', contentType: 'image/png' });
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  await ctx.db.db
    .insert(currencies)
    .values({ code: 'USD', name: 'US Dollar', symbol: '$', enabled: true, isDefault: true })
    .onConflictDoNothing();
  await ctx.db.db.insert(paymentMethods).values({
    key: METHOD,
    name: 'OMT',
    internalLabel: 'OMT – details http',
    currency: 'USD',
    requiresProof: true,
    providerCode: 'manual',
    channelCode: 'offline',
    proofFields: [
      {
        id: PHONE,
        label: 'Phone number you sent from',
        type: 'phone',
        required: true,
        enabled: true,
      },
    ],
  });
  await ctx.db.db.insert(users).values({
    email: CLIENT.email,
    passwordHash: await new PasswordService().hash(CLIENT.password),
    emailVerified: true,
    firstName: 'Rami',
    lastName: 'Khoury',
    verificationLevel: 1,
  });
  client = await actingAs(ctx, 'portal', CLIENT);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the offline deposit form carries the details (0163)', () => {
  it('delivers details[<id>] parts to the deposit, the phone as E.164', async () => {
    const res = await file({ [PHONE]: '+961 70 123 456' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [row] = await ctx.db.db
      .select({ proofDetails: transactions.proofDetails })
      .from(transactions)
      .where(eq(transactions.id, (res.body as { id: string }).id));
    expect(row?.proofDetails).toEqual([
      { fieldId: PHONE, label: 'Phone number you sent from', type: 'phone', value: '+96170123456' },
    ]);
  });

  it('refuses a missing required detail under its own key, and leaves no live receipt', async () => {
    const before = await ctx.db.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM stored_objects WHERE bucket = 'deposit-proofs' AND deleted_at IS NULL`,
    );
    const res = await file({});
    expect(res.status).toBe(400);
    expect((res.body as { fields?: Record<string, string> }).fields).toEqual({
      [`details.${PHONE}`]: 'Phone number you sent from is required.',
    });
    const after = await ctx.db.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM stored_objects WHERE bucket = 'deposit-proofs' AND deleted_at IS NULL`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

/*
 * Arabic (0179): the client reads the method's name and each question in both
 * languages, the filed answer keeps the Arabic label it was asked with, and the
 * history names the method in Arabic from a LIVE lookup.
 */
describe('the Arabic twins reach the client', () => {
  const AR_METHOD = 'omt_details_http_ar';
  const CODE = 'f_code000001';

  beforeAll(async () => {
    await ctx.db.db.insert(paymentMethods).values({
      key: AR_METHOD,
      name: 'OMT Arabic',
      nameAr: 'أو إم تي',
      internalLabel: 'OMT – details http ar',
      currency: 'USD',
      requiresProof: true,
      providerCode: 'manual',
      channelCode: 'offline',
      proofFields: [
        {
          id: CODE,
          label: 'Transfer code',
          labelAr: 'رمز التحويل',
          hint: 'On your slip',
          hintAr: 'على الإيصال',
          type: 'text',
          required: true,
          enabled: true,
        },
        { id: PHONE, label: 'Phone', type: 'phone', required: false, enabled: true },
      ],
    });
  });

  it('serves nameAr and each field’s labelAr/hintAr on GET /payments/methods', async () => {
    const res = await client.get('/v1/payments/methods');
    expect(res.status).toBe(200);
    const method = (res.body as { key: string }[]).find((m) => m.key === AR_METHOD);
    expect(method).toMatchObject({
      name: 'OMT Arabic',
      nameAr: 'أو إم تي',
      proofFields: [
        { id: CODE, label: 'Transfer code', labelAr: 'رمز التحويل', hintAr: 'على الإيصال' },
        { id: PHONE, label: 'Phone', labelAr: null, hintAr: null },
      ],
    });
    // Untranslated is null, never absent or ''.
    const plain = (res.body as { key: string; nameAr: unknown }[]).find((m) => m.key === METHOD);
    expect(plain?.nameAr).toBeNull();
  });

  it('copies the Arabic label onto the answer, and the history names the method live', async () => {
    const filed = await client
      .post('/v1/payments/deposits/offline', undefined)
      .set('Idempotency-Key', randomUUID())
      .field('amount', '100')
      .field('currency', 'USD')
      .field('method', AR_METHOD)
      .field(`details[${CODE}]`, 'AB12')
      .attach('file', KYC_TEST_PNG, { filename: 'receipt.png', contentType: 'image/png' });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    const id = (filed.body as { id: string }).id;

    const history = await client.get('/v1/payments/transactions');
    expect(history.status).toBe(200);
    const row = (history.body as { items: Record<string, unknown>[] }).items.find(
      (item) => item.id === id,
    );
    expect(row).toMatchObject({
      methodName: 'OMT Arabic',
      methodNameAr: 'أو إم تي',
      proofDetails: [
        { fieldId: CODE, label: 'Transfer code', labelAr: 'رمز التحويل', value: 'AB12' },
      ],
    });

    // A rename of the Arabic reaches the old row at once — it is a join, not a copy.
    await ctx.db.db
      .update(paymentMethods)
      .set({ nameAr: null })
      .where(eq(paymentMethods.key, AR_METHOD));
    const after = await client.get('/v1/payments/transactions');
    const again = (after.body as { items: Record<string, unknown>[] }).items.find(
      (item) => item.id === id,
    );
    expect(again?.methodNameAr).toBeNull();
  });
});

it('serves a withdrawal method nameAr on GET /payments/withdrawal-methods', async () => {
  await ctx.db.db.insert(withdrawalPaymentMethods).values({
    key: 'desk_ar_http',
    name: 'Cash at the desk',
    nameAr: 'نقدًا في المكتب',
    internalLabel: 'Desk cash ar http',
    providerCode: 'manual',
    channelCode: 'desk',
  });
  const res = await client.get('/v1/payments/withdrawal-methods');
  expect(res.status).toBe(200);
  const method = (res.body as { key: string }[]).find((m) => m.key === 'desk_ar_http');
  expect(method).toMatchObject({ name: 'Cash at the desk', nameAr: 'نقدًا في المكتب' });
});
