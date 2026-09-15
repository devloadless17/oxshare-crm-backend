import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
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
import { RivalWithdrawalsService } from '../src/modules/payments/rival/rival-withdrawals.service';
import { PasswordService } from '../src/common/security/password.service';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';
import { admins, kycConfigSteps, roles, users } from '../src/database/schema';

/**
 * FSD §14, JOURNEY 4 — the administrator's day.
 *
 * > "An administrator searching and filtering the client base, reviewing and
 * >  actioning withdrawals and verifications with reasons and email
 * >  notifications, and reviewing the resulting ledger records."
 *
 * ## The four clauses, and why each is walked rather than assumed
 *
 * **Searching and filtering** is the clause that was quietly broken for months
 * and found by the owner rather than by a test: every money screen displayed
 * named clients and offered only a uuid to filter by. The API half is walked
 * here against a fixture holding SEVERAL clients, because a search over one
 * client passes whatever it does.
 *
 * **With reasons** is not decoration. A rejection an operator cannot explain is
 * one the client cannot act on, and both decisions below are asserted to carry
 * the reason all the way to the mail.
 *
 * **Email notifications** are fire-and-forget by design — a mail failure must
 * never fail the decision it describes — so they are polled, not read on the
 * next line.
 *
 * **The resulting ledger records** is the clause that makes the others
 * checkable: a rejected withdrawal posts a COMPENSATING CREDIT rather than
 * deleting the debit, because `ledger_entries` is append-only and a trigger
 * refuses UPDATE and DELETE. Both rows must be there, and the balance must be
 * back where it started.
 */

const MASTER = { email: 'uat-j4-master@oxshare.com', password: 'admin-password-123' };

/**
 * Four clients with DELIBERATELY overlapping names.
 *
 * A search fixture of one client cannot fail. These share a surname, so a
 * filter that returns everything and a filter that returns the right subset
 * look different — which is the only way the assertions below mean anything.
 */
const CLIENTS = [
  { first: 'Alexandra', last: 'Nolan', email: 'uat-j4-alexandra@oxshare-e2e.test' },
  { first: 'Bruce', last: 'Nolan', email: 'uat-j4-bruce@oxshare-e2e.test' },
  { first: 'Carla', last: 'Mansour', email: 'uat-j4-carla@oxshare-e2e.test' },
  { first: 'Dmitri', last: 'Haddad', email: 'uat-j4-dmitri@oxshare-e2e.test' },
] as const;
const PASSWORD = 'ClientPass123!';

let ctx: HttpTestContext;
let mail: ReturnType<typeof emailRecorder>;
let admin: Session;
const ids = new Map<string, string>();
let withdrawalId: string;

const idem = () => ({ headers: { 'idempotency-key': randomUUID() } });
const PORTAL_ORIGIN = process.env['PORTAL_URL'] ?? 'http://localhost:3000';

async function onboard(person: (typeof CLIENTS)[number]): Promise<string> {
  const res = await anonymous(ctx).post('/v1/auth/register').set('Origin', PORTAL_ORIGIN).send({
    firstName: person.first,
    lastName: person.last,
    email: person.email,
    password: PASSWORD,
    country: 'LB',
  });
  if (res.status >= 400) throw new Error(`register: ${JSON.stringify(res.body)}`);

  const sent = mail.find('sendVerificationEmail', person.email);
  if (!sent) throw new Error(`no verification email for ${person.email}`);
  const verified = await anonymous(ctx)
    .post('/v1/auth/verify-email')
    .set('Origin', PORTAL_ORIGIN)
    .send({ token: sent.args[1] as string });
  if (verified.status >= 400) throw new Error(`verify: ${JSON.stringify(verified.body)}`);

  const [row] = await ctx.db.db.select().from(users).where(eq(users.email, person.email));
  return row.id;
}

async function fileKyc(person: (typeof CLIENTS)[number], phone: string) {
  const client = await actingAs(ctx, 'portal', { email: person.email, password: PASSWORD });
  await client.post('/v1/kyc/step', {
    step: 'personal',
    data: {
      firstName: person.first,
      lastName: person.last,
      dateOfBirth: '1990-04-12',
      phone,
      nationality: 'Lebanon',
      country: 'Lebanon',
    },
  });
  await client.post('/v1/kyc/step', {
    step: 'document',
    data: { docType: 'passport', frontFilePath: '/uploads/kyc/j4.png' },
  });
  await client.post('/v1/kyc/step', { step: 'selfie', data: { filePath: '/uploads/kyc/j4s.png' } });
  await client.post('/v1/kyc/step', {
    step: 'address',
    data: { docType: 'utility_bill', filePath: '/uploads/kyc/j4a.png' },
  });
  const submitted = await client.post('/v1/kyc/submit');
  if (submitted.status >= 400) throw new Error(`submit: ${JSON.stringify(submitted.body)}`);
}

beforeAll(async () => {
  mail = emailRecorder();
  ctx = await startHttpTestApp({
    overrides: [
      { token: EmailService, value: mail.service },
      {
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
    .values({ name: 'UAT J4 Master', permissions: ALL_PERMISSIONS, isSystem: true })
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

  let phone = 70200000;
  for (const person of CLIENTS) {
    ids.set(person.email, await onboard(person));
    await fileKyc(person, `+961${phone++}`);
  }

  admin = await actingAs(ctx, 'admin', MASTER);
}, 300_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

interface ClientRow {
  id: string;
  email: string;
}
const rowsOf = (body: unknown) => (body as { items: ClientRow[] }).items;

describe('§14 J4 — step 1: searching and filtering the client base', () => {
  it('the fixture holds several clients, so a filter can be wrong', async () => {
    // The non-vacuity floor for everything below.
    const res = await admin.get('/v1/admin/clients?limit=100&withTotal=true');
    expect(res.status).toBe(200);
    expect(rowsOf(res.body).length).toBeGreaterThanOrEqual(CLIENTS.length);
  });

  it('finds one client by their first name, and excludes the rest', async () => {
    const res = await admin.get('/v1/admin/clients?q=Alexandra&limit=100');
    expect(res.status).toBe(200);
    const found = rowsOf(res.body);
    expect(found.length).toBe(1);
    expect(found[0].email).toBe('uat-j4-alexandra@oxshare-e2e.test');
  });

  it('finds BOTH people who share a surname', async () => {
    // The case a one-client fixture cannot express: a search returning the
    // right SUBSET rather than the right single row.
    const res = await admin.get('/v1/admin/clients?q=Nolan&limit=100');
    expect(res.status).toBe(200);
    const emails = rowsOf(res.body)
      .map((r) => r.email)
      .sort();
    expect(emails).toEqual(['uat-j4-alexandra@oxshare-e2e.test', 'uat-j4-bruce@oxshare-e2e.test']);
  });

  it('finds a client by their EMAIL, which is what the operator has in front of them', async () => {
    const res = await admin.get('/v1/admin/clients?q=uat-j4-carla@oxshare-e2e.test&limit=100');
    expect(res.status).toBe(200);
    expect(rowsOf(res.body).length).toBe(1);
  });

  it('answers with nothing, not everything, when nobody matches', async () => {
    // The failure that reads as a working filter: a predicate dropped by a
    // later edit turns "no such client" into the whole client base.
    const res = await admin.get('/v1/admin/clients?q=nobody-by-this-name&limit=100');
    expect(res.status).toBe(200);
    expect(rowsOf(res.body).length).toBe(0);
  });

  it('filters by KYC status as well as by name, and the two compose', async () => {
    const pending = await admin.get('/v1/admin/clients?kycStatus=submitted&limit=100');
    expect(pending.status).toBe(200);
    expect(rowsOf(pending.body).length).toBeGreaterThanOrEqual(CLIENTS.length);

    const both = await admin.get('/v1/admin/clients?kycStatus=submitted&q=Nolan&limit=100');
    expect(both.status).toBe(200);
    // Two filters that overwrote each other would answer a different question
    // without saying so.
    expect(rowsOf(both.body).length).toBe(2);
  });
});

describe('§14 J4 — step 2: actioning a verification, with a reason', () => {
  it('rejects one application with a reason the client is given', async () => {
    const carla = ids.get('uat-j4-carla@oxshare-e2e.test')!;
    const reason = 'The address document is older than three months. Please upload a recent one.';

    const res = await admin.patch(`/v1/admin/kyc/${carla}/reject`, { reason });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);

    const { rows } = await ctx.db.db.execute<{ status: string; rejection_reason: string }>(sql`
      SELECT status, rejection_reason FROM kyc_submissions WHERE user_id = ${carla}
    `);
    expect(rows[0].status).toBe('rejected');
    // The reason is STORED, not merely mailed: the client sees it when they
    // come back to fix the application, and a reviewer sees it in the history.
    expect(rows[0].rejection_reason).toBe(reason);

    const sent = await mail.waitFor('sendKycDecisionEmail', 'uat-j4-carla@oxshare-e2e.test');
    expect(sent, 'a rejected client was not told').toBeDefined();
    // The reason travels to the mail. A rejection a client cannot act on is a
    // support ticket, and it is the same sentence in both places or it is two.
    expect(JSON.stringify(sent?.args)).toContain('three months');
  });

  it('approves another, and the two decisions are distinguishable on the client rows', async () => {
    const alexandra = ids.get('uat-j4-alexandra@oxshare-e2e.test')!;
    const res = await admin.patch(`/v1/admin/kyc/${alexandra}/approve`, {});
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);

    const approved = await admin.get('/v1/admin/clients?kycStatus=approved&limit=100');
    expect(rowsOf(approved.body).map((r) => r.id)).toContain(alexandra);

    const rejected = await admin.get('/v1/admin/clients?kycStatus=rejected&limit=100');
    expect(rowsOf(rejected.body).map((r) => r.id)).toContain(
      ids.get('uat-j4-carla@oxshare-e2e.test'),
    );
  });
});

describe('§14 J4 — step 3: actioning a withdrawal, with a reason', () => {
  it('a verified client asks to withdraw', async () => {
    const alexandra = ids.get('uat-j4-alexandra@oxshare-e2e.test')!;
    const credited = await admin.post(
      '/v1/admin/wallets/credit',
      {
        userId: alexandra,
        amount: '500.00000000',
        currency: 'USD',
        reason: 'UAT journey 4 — funding the withdrawal this desk will refuse.',
      },
      idem(),
    );
    expect(credited.status, JSON.stringify(credited.body)).toBeLessThan(400);

    const client = await actingAs(ctx, 'portal', {
      email: 'uat-j4-alexandra@oxshare-e2e.test',
      password: PASSWORD,
    });
    const res = await client.post(
      '/v1/payments/withdrawals',
      { amount: '120.00', currency: 'USD', destination: '+96170200001', methodKey: 'whish' },
      idem(),
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
    withdrawalId = (res.body as { id: string }).id;

    const { rows } = await ctx.db.db.execute<{ balance: string }>(sql`
      SELECT balance FROM wallets WHERE user_id = ${alexandra} AND currency = 'USD'
    `);
    // Debited at request time — see the note in the individual journey.
    expect(Number(rows[0].balance)).toBeCloseTo(380, 8);
  });

  it('the desk rejects it with a reason, and the client is told', async () => {
    const reason = 'The destination number is not registered to the account holder.';
    const res = await admin.patch(
      `/v1/admin/withdrawals/${withdrawalId}/reject`,
      { reason },
      idem(),
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);

    const sent = await mail.waitFor(
      'sendWithdrawalDecisionEmail',
      'uat-j4-alexandra@oxshare-e2e.test',
    );
    expect(sent, 'a refused client was not told').toBeDefined();
    expect(JSON.stringify(sent?.args)).toContain('not registered');
  });

  it('the money is BACK, and it came back as a new row rather than an erased one', async () => {
    const alexandra = ids.get('uat-j4-alexandra@oxshare-e2e.test')!;

    const { rows: wallet } = await ctx.db.db.execute<{ balance: string }>(sql`
      SELECT balance FROM wallets WHERE user_id = ${alexandra} AND currency = 'USD'
    `);
    expect(Number(wallet[0].balance)).toBeCloseTo(500, 8);

    /*
     * THE APPEND-ONLY PROOF, and the reason this clause is in §14 at all.
     *
     * `ledger_entries` is append-only and a database trigger refuses UPDATE and
     * DELETE (§6.4), so a refund cannot be an un-posting: the debit stays and a
     * COMPENSATING CREDIT is written beside it. An operator reading this client's
     * history sees that money left and came back, which is what happened — a
     * ledger showing neither row would be a ledger that had been edited.
     */
    const { rows: entries } = await ctx.db.db.execute<{ amount: string; entry_type: string }>(sql`
      SELECT le.amount, le.entry_type
      FROM ledger_entries le
      JOIN wallets w ON w.id = le.wallet_id
      WHERE w.user_id = ${alexandra}
      ORDER BY le.created_at
    `);
    const debit = entries.find((e) => Number(e.amount) < 0);
    expect(debit, 'the withdrawal debit is missing from the ledger').toBeDefined();
    expect(Number(debit?.amount)).toBeCloseTo(-120, 8);

    const refund = entries.filter((e) => Number(e.amount) === 120);
    expect(refund.length, 'the refund was not written as its own entry').toBe(1);
  });
});

describe('§14 J4 — step 4: reviewing the resulting records', () => {
  it('the ledger names the client in words, and can be filtered by that name', async () => {
    /*
     * The clause the owner found broken by opening the screen: every money list
     * displayed named clients and offered a uuid as the only filter. Both
     * halves are asserted, because fixing one without the other is the state
     * `/ledger` was left in — a column speaking in names above a filter
     * demanding an id.
     */
    const res = await admin.get('/v1/admin/ledger?q=Alexandra&limit=100');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const items = (res.body as { items: { userFirstName?: string; userEmail?: string }[] }).items;
    expect(items.length, 'the ledger cannot be narrowed to a named client').toBeGreaterThan(0);
    expect(items.every((e) => e.userFirstName === 'Alexandra')).toBe(true);
    expect(items[0].userEmail).toBe('uat-j4-alexandra@oxshare-e2e.test');
  });

  it('the ledger search excludes the other clients rather than returning everything', async () => {
    /*
     * A SECOND client with movements, created here rather than assumed.
     *
     * Without one the whole ledger IS Alexandra's, and "the filter narrowed it"
     * and "the filter did nothing" are the same number — which is how a filter
     * test passes against a filter that was never applied.
     */
    const bruce = ids.get('uat-j4-bruce@oxshare-e2e.test')!;
    const credited = await admin.post(
      '/v1/admin/wallets/credit',
      {
        userId: bruce,
        amount: '75.00000000',
        currency: 'USD',
        reason: 'UAT journey 4 — a second client, so the ledger filter can be wrong.',
      },
      idem(),
    );
    expect(credited.status, JSON.stringify(credited.body)).toBeLessThan(400);

    const mine = await admin.get('/v1/admin/ledger?q=Alexandra&limit=100');
    const all = await admin.get('/v1/admin/ledger?limit=100');
    const mineCount = (mine.body as { items: unknown[] }).items.length;
    const allCount = (all.body as { items: unknown[] }).items.length;
    expect(allCount).toBeGreaterThan(mineCount);

    // And Bruce shares a SURNAME with Alexandra, so a search on the surname
    // returns both — the subset case, on the money screen this time.
    const nolans = await admin.get('/v1/admin/ledger?q=Nolan&limit=100');
    expect((nolans.body as { items: unknown[] }).items.length).toBe(allCount);
  });

  it('every decision the desk made is on the audit trail, and can be read back per client', async () => {
    const carla = ids.get('uat-j4-carla@oxshare-e2e.test')!;
    const res = await admin.get(`/v1/admin/audit-log?subjectId=${carla}&limit=100`);
    expect(res.status).toBe(200);
    const items = (res.body as { items: { action: string; subjectId: string }[] }).items;
    expect(items.length, 'the rejected client has no audit trail').toBeGreaterThan(0);
    expect(items.every((r) => r.subjectId === carla)).toBe(true);
    expect(items.some((r) => /kyc/i.test(r.action))).toBe(true);
  });

  it('the trail can be narrowed to the administrator who acted', async () => {
    const res = await admin.get('/v1/admin/audit-log?q=uat-j4-master&limit=100');
    expect(res.status).toBe(200);
    const items = (res.body as { items: { actorEmail: string }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((r) => r.actorEmail === MASTER.email)).toBe(true);
  });
});

describe('§14 J4 — the acceptance condition: the money path balances to the cent', () => {
  it('reconciles after a credit, a withdrawal and its refund', async () => {
    const res = await admin.get('/v1/admin/reconciliation');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const report = res.body as { discrepancies?: unknown[]; walletsChecked?: number };
    expect(report.walletsChecked ?? 0).toBeGreaterThan(0);
    expect(report.discrepancies ?? [], JSON.stringify(report.discrepancies)).toHaveLength(0);
  });
});
