import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { legacyRoute } from './support/payment-route';
import { recordKycEvidence } from './support/kyc-evidence';
import { emailRecorder } from './email-recorder';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { EmailService } from '../src/modules/email/email.service';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';
import { CLIENT_SAFE_PROVIDER_REFUSAL } from '../src/modules/payments/core/payout-engine.service';
import {
  admins,
  kycConfigSteps,
  kycSubmissionAttempts,
  kycSubmissions,
  roles,
  transactions,
  users,
  wallets,
} from '../src/database/schema';

/**
 * A REASON AN OPERATOR WRITES, IN ARABIC TOO (3 Oct 2026).
 *
 * Every refusal a client reads — a KYC rejection or re-verification, a refused
 * withdrawal or deposit, a hand credit's reason — is stored as a COPY with the
 * decision, and since 0179 its Arabic is stored beside it: the reviewer's own
 * Arabic when they wrote one, else the configured reason's Arabic AS IT READ
 * THEN. Reads serve the stored Arabic first, then the catalogue's, then the
 * Arabic of a sentence the system wrote; the bell, the status screen, the
 * history and the email all say the same thing.
 */

const ADMIN = { email: 'arabic-reasons-admin@oxshare.com', password: 'admin-password-123' };
const PASSWORD = 'client-password-123';
const KYC_CLIENT = 'arabic-reasons-kyc@oxshare-e2e.test';
const CATALOGUE_CLIENT = 'arabic-reasons-catalogue@oxshare-e2e.test';
const MONEY_CLIENT = 'arabic-reasons-money@oxshare-e2e.test';

let ctx: HttpTestContext;
let mail: ReturnType<typeof emailRecorder>;
const ids = new Map<string, number>();

const idem = () => ({ headers: { 'idempotency-key': randomUUID() } });

async function bell(email: string, kind: string) {
  const client = await actingAs(ctx, 'portal', { email, password: PASSWORD });
  const feed = await client.get('/v1/notifications');
  expect(feed.status).toBe(200);
  return (feed.body.items as { kind: string; params: Record<string, unknown> }[]).filter(
    (item) => item.kind === kind,
  );
}

async function walletOf(userId: number) {
  const [wallet] = await ctx.db.db.select().from(wallets).where(eq(wallets.userId, userId));
  return wallet;
}

beforeAll(async () => {
  mail = emailRecorder();
  ctx = await startHttpTestApp({ overrides: [{ token: EmailService, value: mail.service }] });
  const db = ctx.db.db;
  const passwords = new PasswordService();

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

  const [role] = await db
    .insert(roles)
    .values({ name: 'Arabic Reasons Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'Arabic Reasons Master',
    role: 'master_admin',
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  for (const email of [KYC_CLIENT, CATALOGUE_CLIENT, MONEY_CLIENT]) {
    const [client] = await db
      .insert(users)
      .values({
        email,
        passwordHash: await passwords.hash(PASSWORD),
        firstName: 'Rana',
        lastName: 'Khalil',
        dateOfBirth: '1990-04-12',
        nationality: 'Lebanese',
        phone: '+96170123456',
        country: 'Lebanon',
        address: 'Hamra Street 12',
        city: 'Beirut',
        emailVerified: true,
        locale: 'ar',
      })
      .returning();
    ids.set(email, client.id);
  }
  for (const email of [KYC_CLIENT, CATALOGUE_CLIENT]) {
    const userId = ids.get(email)!;
    await db.insert(kycSubmissions).values({
      userId,
      status: 'submitted',
      submittedAt: new Date(),
      personalInfo: {},
    });
    await recordKycEvidence(db, userId, {
      document: { docType: 'passport', frontFilePath: `/uploads/kyc/${userId}-passport.png` },
      selfie: { filePath: `/uploads/kyc/${userId}-selfie.png` },
      addressProof: { docType: 'utility_bill', filePath: `/uploads/kyc/${userId}-bill.png` },
    });
  }
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a KYC rejection written with the reviewer’s own Arabic', () => {
  const REASON = 'The photo of your passport is too dark to read.';
  const REASON_AR = 'صورة جواز سفرك داكنة جداً ولا يمكن قراءتها.';

  it('stores it beside the English — on the submission, the attempt and the decision log', async () => {
    const admin = await actingAs(ctx, 'admin', ADMIN);
    const userId = ids.get(KYC_CLIENT)!;
    const res = await admin.patch(`/v1/admin/kyc/${userId}/reject`, {
      reason: REASON,
      reasonAr: `  ${REASON_AR}  `,
      rejectedFields: ['doc_front'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ rejectionReason: REASON, rejectionReasonAr: REASON_AR });

    const [submission] = await ctx.db.db
      .select()
      .from(kycSubmissions)
      .where(eq(kycSubmissions.userId, userId));
    expect(submission.rejectionReasonAr).toBe(REASON_AR);
    const [attempt] = await ctx.db.db
      .select()
      .from(kycSubmissionAttempts)
      .where(eq(kycSubmissionAttempts.userId, userId));
    expect(attempt.rejectionReasonAr).toBe(REASON_AR);
    const { rows } = await ctx.db.db.execute<{ reason: string; reason_ar: string }>(
      sql`SELECT reason, reason_ar FROM client_verifications WHERE user_id = ${userId}::integer`,
    );
    expect(rows).toEqual([{ reason: REASON, reason_ar: REASON_AR }]);
  });

  it('serves it to the client on the status, the bell and in the Arabic email', async () => {
    const client = await actingAs(ctx, 'portal', { email: KYC_CLIENT, password: PASSWORD });
    const status = await client.get('/v1/kyc/status');
    expect(status.body).toMatchObject({ rejectionReason: REASON, rejectionReasonAr: REASON_AR });

    const [rejected] = await bell(KYC_CLIENT, 'kyc.rejected');
    expect(rejected.params).toMatchObject({ reason: REASON, reasonAr: REASON_AR });

    const sent = await mail.waitFor('sendKycDecisionEmail', KYC_CLIENT);
    // (email, first name, decision, reason, items — named in Arabic —, locale, reasonAr)
    expect(sent?.args[3]).toBe(REASON);
    expect(sent?.args[4]).toEqual(['جواز السفر']);
    expect(sent?.args[5]).toBe('ar');
    expect(sent?.args[6]).toBe(REASON_AR);
  });

  it('keeps the Arabic in the audit record', async () => {
    let details: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 40 && !details; attempt += 1) {
      const { rows } = await ctx.db.db.execute<{ details: Record<string, unknown> }>(
        sql`SELECT details FROM audit_log WHERE action = 'kyc.reject'
             AND subject_id = ${String(ids.get(KYC_CLIENT))}`,
      );
      details = rows[0]?.details;
      if (!details) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(details).toMatchObject({ reason: REASON, reasonAr: REASON_AR });
  });
});

describe('a KYC rejection from the catalogue', () => {
  it('copies the configured Arabic at the decision, so a later edit does not change it', async () => {
    const admin = await actingAs(ctx, 'admin', ADMIN);
    const created = await admin.post('/v1/admin/rejection-reasons', {
      context: 'kyc',
      label: 'Arabic reasons: selfie unclear',
      labelAr: 'الصورة الشخصية غير واضحة',
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const reasonId = (created.body as { id: string }).id;

    const userId = ids.get(CATALOGUE_CLIENT)!;
    const res = await admin.patch(`/v1/admin/kyc/${userId}/reject`, {
      reasonId,
      reason: 'Please retake it in daylight.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The label in Arabic, the note as typed — no Arabic was written for it.
    const expected = 'الصورة الشخصية غير واضحة — Please retake it in daylight.';
    expect(res.body).toMatchObject({
      rejectionReason: 'Arabic reasons: selfie unclear — Please retake it in daylight.',
      rejectionReasonAr: expected,
    });

    // The catalogue is reworded afterwards; what the client was told is not.
    const edited = await admin.put(`/v1/admin/rejection-reasons/${reasonId}`, {
      label: 'Arabic reasons: selfie unclear',
      labelAr: 'نص عربي جديد',
    });
    expect(edited.status).toBe(200);
    const client = await actingAs(ctx, 'portal', { email: CATALOGUE_CLIENT, password: PASSWORD });
    const status = await client.get('/v1/kyc/status');
    expect(status.body.rejectionReasonAr).toBe(expected);
  });
});

describe('money reasons', () => {
  it('a hand credit carries the operator’s Arabic to the bell and the email', async () => {
    const admin = await actingAs(ctx, 'admin', ADMIN);
    const userId = ids.get(MONEY_CLIENT)!;
    const res = await admin.post(
      '/v1/admin/wallets/credit',
      {
        userId,
        amount: '500.00000000',
        currency: 'USD',
        reason: 'Goodwill for the delayed transfer.',
        reasonAr: 'تعويض عن التحويل المتأخر.',
      },
      idem(),
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);

    const sent = await mail.waitFor('sendWalletCreditEmail', MONEY_CLIENT);
    expect(sent?.args[4]).toBe('Goodwill for the delayed transfer.');
    expect(sent?.args[6]).toBe('تعويض عن التحويل المتأخر.');

    let credited: { params: Record<string, unknown> }[] = [];
    for (let attempt = 0; attempt < 40 && credited.length === 0; attempt += 1) {
      credited = await bell(MONEY_CLIENT, 'wallet.credited');
      if (credited.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(credited[0]?.params).toMatchObject({
      reason: 'Goodwill for the delayed transfer.',
      reasonAr: 'تعويض عن التحويل المتأخر.',
    });
  });

  it('a refused withdrawal stores the catalogue label’s Arabic and the reviewer’s Arabic note', async () => {
    const admin = await actingAs(ctx, 'admin', ADMIN);
    const userId = ids.get(MONEY_CLIENT)!;
    const created = await admin.post('/v1/admin/rejection-reasons', {
      context: 'withdrawal',
      label: 'Arabic reasons: beneficiary mismatch',
      labelAr: 'المستفيد لا يطابق صاحب الحساب',
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);

    const wallet = await walletOf(userId);
    const [pending] = await ctx.db.db
      .insert(transactions)
      .values({
        userId,
        walletId: wallet.id,
        direction: 'withdrawal',
        amount: '20.00000000',
        currency: 'USD',
        state: 'pending',
        provider: 'manual_test',
        ...legacyRoute('manual_test', 'withdrawal'),
        destination: 'arabic-reasons',
      })
      .returning();

    const res = await admin.patch(
      `/v1/admin/withdrawals/${pending.id}/reject`,
      {
        reasonId: (created.body as { id: string }).id,
        reason: 'The name on the account is different.',
        reasonAr: 'الاسم على الحساب مختلف.',
      },
      idem(),
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
    const expected = 'المستفيد لا يطابق صاحب الحساب — الاسم على الحساب مختلف.';
    expect(res.body).toMatchObject({ rejectionReasonAr: expected });

    const client = await actingAs(ctx, 'portal', { email: MONEY_CLIENT, password: PASSWORD });
    const history = await client.get('/v1/payments/transactions?direction=withdrawal');
    expect(history.status).toBe(200);
    const row = (history.body.items as { id: string; rejectionReasonAr?: string }[]).find(
      (item) => item.id === pending.id,
    );
    expect(row?.rejectionReasonAr).toBe(expected);

    const [rejected] = await bell(MONEY_CLIENT, 'withdrawal.rejected');
    expect(rejected.params.reasonAr).toBe(expected);
    const sent = await mail.waitFor('sendWithdrawalDecisionEmail', MONEY_CLIENT);
    expect(sent?.args[7]).toBe(expected);
  });

  it('a refused offline deposit stores the reviewer’s Arabic', async () => {
    const admin = await actingAs(ctx, 'admin', ADMIN);
    const userId = ids.get(MONEY_CLIENT)!;
    const wallet = await walletOf(userId);
    const [pending] = await ctx.db.db
      .insert(transactions)
      .values({
        userId,
        walletId: wallet.id,
        direction: 'deposit',
        amount: '40.00000000',
        currency: 'USD',
        state: 'pending',
        provider: 'manual_bank',
        providerRef: `OX-${randomUUID().slice(0, 6).toUpperCase()}`,
        ...legacyRoute('manual_bank', 'deposit'),
      })
      .returning();

    const res = await admin.patch(
      `/v1/admin/deposits/${pending.id}/reject`,
      { reason: 'No transfer arrived.', reasonAr: 'لم يصل أي تحويل.' },
      idem(),
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
    expect(res.body).toMatchObject({
      rejectionReason: 'No transfer arrived.',
      rejectionReasonAr: 'لم يصل أي تحويل.',
    });
    const [stored] = await ctx.db.db
      .select({ ar: transactions.rejectionReasonAr })
      .from(transactions)
      .where(eq(transactions.id, pending.id));
    expect(stored.ar).toBe('لم يصل أي تحويل.');
  });

  it('a row refused before the column existed still reads in Arabic when the system wrote it', async () => {
    const userId = ids.get(MONEY_CLIENT)!;
    const wallet = await walletOf(userId);
    const [old] = await ctx.db.db
      .insert(transactions)
      .values({
        userId,
        walletId: wallet.id,
        direction: 'withdrawal',
        amount: '5.00000000',
        currency: 'USD',
        state: 'failure',
        provider: 'manual_test',
        ...legacyRoute('manual_test', 'withdrawal'),
        rejectionReason: CLIENT_SAFE_PROVIDER_REFUSAL,
      })
      .returning();
    const client = await actingAs(ctx, 'portal', { email: MONEY_CLIENT, password: PASSWORD });
    const history = await client.get('/v1/payments/transactions?direction=withdrawal');
    const row = (history.body.items as { id: string; rejectionReasonAr?: string }[]).find(
      (item) => item.id === old.id,
    );
    expect(row?.rejectionReasonAr).toBe('تعذّر على مزوّد الدفع إتمام عملية السحب هذه.');
    // A row with nothing to offer carries no key at all.
    const plain = (history.body.items as { rejectionReason: string | null }[]).filter(
      (item) => !item.rejectionReason,
    );
    for (const item of plain) expect(item).not.toHaveProperty('rejectionReasonAr');
  });

  it('a statement line names its method in Arabic beside the English', async () => {
    const client = await actingAs(ctx, 'portal', { email: MONEY_CLIENT, password: PASSWORD });
    const wallet = await walletOf(ids.get(MONEY_CLIENT)!);
    const today = new Date().toISOString().slice(0, 10);
    const res = await client.get(
      `/v1/wallet/statement?walletId=${wallet.id}&from=${today}&to=${today}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const lines = res.body.lines as Record<string, unknown>[];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toHaveProperty('methodNameAr');
  });
});

describe('a product’s description in Arabic', () => {
  it('is written, kept on a PUT that omits it, and cleared by null', async () => {
    const admin = await actingAs(ctx, 'admin', ADMIN);
    const created = await admin.post('/v1/admin/products', {
      name: 'Arabic reasons ECN',
      description: 'Raw spreads, fixed commission.',
      descriptionAr: '  فروق أسعار خام وعمولة ثابتة.  ',
      enabled: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    expect(created.body).toMatchObject({ descriptionAr: 'فروق أسعار خام وعمولة ثابتة.' });
    const id = (created.body as { id: string }).id;

    const kept = await admin.put(`/v1/admin/products/${id}`, {
      name: 'Arabic reasons ECN',
      description: 'Raw spreads.',
      enabled: true,
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body).toMatchObject({
      description: 'Raw spreads.',
      descriptionAr: 'فروق أسعار خام وعمولة ثابتة.',
    });

    const cleared = await admin.put(`/v1/admin/products/${id}`, {
      name: 'Arabic reasons ECN',
      description: 'Raw spreads.',
      descriptionAr: null,
      enabled: true,
    });
    expect(cleared.body).toMatchObject({ descriptionAr: null });

    const listed = await admin.get('/v1/admin/products');
    const found = (listed.body as { id: string; descriptionAr: string | null }[]).find(
      (product) => product.id === id,
    );
    expect(found).toHaveProperty('descriptionAr', null);
  });
});
