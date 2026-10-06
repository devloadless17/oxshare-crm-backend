import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { kycConfigSteps, rejectionReasons } from '../src/database/schema';
import {
  DEFAULT_REJECTION_REASONS,
  ensurePlatformDefaults,
} from '../src/database/platform-defaults';
import { DEFAULT_KYC_STEPS, KycConfigStore } from '../src/store/kyc-config.store';

/*
 * A fresh production database started with an EMPTY KYC form (reported 6 Oct 2026): the defaults
 * lived only in the development seed, so a new client saw no step and could never be verified.
 */
describe('what every database starts with', () => {
  let ctx: MoneyTestContext;
  const count = async (table: typeof kycConfigSteps | typeof rejectionReasons) =>
    (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(table))[0].n;

  beforeAll(async () => {
    ctx = await startMoneyTestDb();
  });
  afterAll(async () => {
    await stopMoneyTestDb(ctx);
  });

  it('gives a fresh database the KYC form a client can fill in, and the rejection reasons', async () => {
    expect(await count(kycConfigSteps)).toBe(0);
    expect(await ensurePlatformDefaults(ctx.db)).toBe(true);

    const form = await new KycConfigStore(ctx.db).getSteps();
    expect(form).toHaveLength(DEFAULT_KYC_STEPS.length);
    expect(form.filter((s) => s.enabled).length).toBeGreaterThan(0);
    // The client's identity is asked: a form of empty steps is the defect.
    expect(form[0].fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(['firstName', 'lastName']),
    );

    expect(await count(rejectionReasons)).toBe(DEFAULT_REJECTION_REASONS.length);
    const contexts = await ctx.db
      .selectDistinct({ c: rejectionReasons.context })
      .from(rejectionReasons);
    expect(contexts.map((r) => r.c).sort()).toEqual(['deposit', 'kyc', 'partner', 'withdrawal']);
  });

  it('writes nothing on a later boot, and never brings back a reason the broker deleted', async () => {
    const [gone] = await ctx.db.select().from(rejectionReasons).limit(1);
    await ctx.db.delete(rejectionReasons).where(eq(rejectionReasons.id, gone.id));

    expect(await ensurePlatformDefaults(ctx.db)).toBe(false);
    expect(await count(rejectionReasons)).toBe(DEFAULT_REJECTION_REASONS.length - 1);
    expect(await count(kycConfigSteps)).toBe(DEFAULT_KYC_STEPS.length);
  });

  it('writes once when two instances boot together (a blue-green release)', async () => {
    await ctx.db.delete(kycConfigSteps);
    await ctx.db.delete(rejectionReasons);
    const results = await Promise.all([
      ensurePlatformDefaults(ctx.db),
      ensurePlatformDefaults(ctx.db),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await count(kycConfigSteps)).toBe(DEFAULT_KYC_STEPS.length);
    expect(await count(rejectionReasons)).toBe(DEFAULT_REJECTION_REASONS.length);
  });
});
