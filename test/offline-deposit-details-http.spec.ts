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
import { currencies, paymentMethods, transactions, users } from '../src/database/schema';

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
