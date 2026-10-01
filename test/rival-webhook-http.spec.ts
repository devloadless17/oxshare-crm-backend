import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { legacyRoute } from './support/payment-route';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { sealSecret } from '../src/common/security/secret-box';
import { CLIENT_SAFE_PROVIDER_REFUSAL } from '../src/modules/payments/core/payout-engine.service';
import { signRivalBody } from '../src/modules/payments/providers/rival/rival-signature';
import { RivalConfigService } from '../src/modules/payments/providers/rival/rival-config.service';
import {
  currencies,
  ledgerEntries,
  paymentMethods,
  paymentProviders,
  transactions,
  users,
  wallets,
} from '../src/database/schema';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The Rival webhook through the WHOLE real chain — adapter, global guards,
 * raw-body capture, verification, replay nonce, event application, and (in
 * the crown-jewel case) the wallet credit itself against real Postgres, with
 * a fake Rival answering the authoritative status read.
 *
 * Every response code here is a CONTROL SIGNAL to Rival's retry loop (4xx
 * kills an event forever, 5xx/429 schedules a retry), so each row of the
 * mapping gets its own assertion — a wrong code is not a cosmetic bug, it is
 * an event lost or a delivery stormed.
 *
 * The replay-nonce cases run against the REAL compose Redis: the guarantee is
 * one atomic `SET NX PX`, and a faked Redis would prove only that the fake
 * was called.
 */

const WEBHOOK = '/v1/payments/rival/webhook';
const WEBHOOK_KEY = 'whk_http_spec_key_with_plenty_of_entropy_123456';
const ENC_KEY = process.env['APP_ENCRYPTION_KEY'];

let ctx: HttpTestContext;
/** A fake Rival: answers the client's authoritative reads. */
let fakeRival: Server;
let fakeRivalUrl: string;
/** What the fake answers for GET /integrations/whish/payments/:id. */
let fakeStatus: 'PENDING' | 'PAID' | 'FAILED' = 'PAID';
/** Rival's REST record of each payout, by id — what the doorbell re-reads. */
const fakeWithdrawals = new Map<string, Record<string, unknown>>();

function signedPost(body: string, at = Math.floor(Date.now() / 1000), key = WEBHOOK_KEY) {
  const { signature } = signRivalBody(body, key, at);
  return request(ctx.server)
    .post(WEBHOOK)
    .set('Content-Type', 'application/json')
    .set('Authorization', `Bearer ${key}`)
    .set('x-crm-signature', signature)
    .set('x-crm-timestamp', String(at))
    .send(body);
}

function depositEvent(externalId: string, kind: string): string {
  return JSON.stringify({
    event: `transaction.${kind}`,
    reference: `whish:${externalId}`,
    sentAt: new Date().toISOString(),
    transaction: { id: null, status: 'COMPLETED', amount: '150.00', currency: 'USD' },
  });
}

/*
 * ⚠️ THE "not configured" CASE HAS TO BE MADE TRUE, not assumed.
 *
 * `RivalConfigService.resolve()` falls back to the ENVIRONMENT when no
 * settings row exists — deliberately, as the development floor. So on a
 * machine whose `.env` carries real RIVAL_BASE_URL/RIVAL_API_KEY, Rival IS
 * configured, the first case's request reached signature verification, and it
 * answered 401 where the test expects 503.
 *
 * That made this file fail for every developer holding live credentials and
 * pass in CI, which has none — the shape that teaches people to ignore a red
 * suite. The variables are removed before the app boots (ConfigService reads
 * them at that moment) and restored afterwards. Every later case configures
 * Rival through the settings ROW, which takes precedence over the environment
 * anyway, so nothing else in this file changes.
 */
const RIVAL_ENV_KEYS = ['RIVAL_BASE_URL', 'RIVAL_API_KEY', 'RIVAL_WEBHOOK_KEY'];

beforeAll(async () => {
  fakeRival = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    // Rival's REST record of a payout — what the doorbell re-reads (0173).
    if (req.method === 'GET' && req.url?.startsWith('/company/withdrawals/')) {
      const id = req.url.split('/').pop();
      const found = fakeWithdrawals.get(id ?? '');
      if (!found) {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, statusCode: 404, error: { code: 'NOT_FOUND' } }));
        return;
      }
      res.end(
        JSON.stringify({
          success: true,
          statusCode: 200,
          data: {
            id,
            amount: '25.00',
            currency: 'USD',
            netAmount: '25.00',
            totalAmount: '25.00',
            externalReference: null,
            notes: null,
            processedAt: null,
            createdAt: new Date().toISOString(),
            ...found,
          },
        }),
      );
      return;
    }
    if (req.url?.startsWith('/integrations/whish/payments/')) {
      res.end(
        JSON.stringify({
          success: true,
          statusCode: 200,
          data: {
            id: 'rp-1',
            externalId: req.url.split('/').pop(),
            status: fakeStatus,
            amount: '150.00',
            currency: 'USD',
            collectUrl: 'https://pay.example.test/x',
            needsAttention: false,
            settlementError: null,
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, statusCode: 404, error: { code: 'NOT_FOUND' } }));
  });
  await new Promise<void>((resolve) => fakeRival.listen(0, '127.0.0.1', resolve));
  fakeRivalUrl = `http://localhost:${(fakeRival.address() as AddressInfo).port}`;

  ctx = await startHttpTestApp();
}, 120_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
  await new Promise<void>((resolve) => {
    fakeRival.close(() => resolve());
  });
});

/** Writes the settings row and makes it live immediately (the config caches). */
async function configureRival(overrides: { webhookKey?: string | null } = {}): Promise<void> {
  const webhookKey = overrides.webhookKey === undefined ? WEBHOOK_KEY : overrides.webhookKey;
  await ctx.db.db
    .update(paymentProviders)
    .set({
      enabled: true,
      config: {
        baseUrl: fakeRivalUrl,
        ...(webhookKey === null ? {} : { webhookKeyFingerprint: 'abcd1234' }),
      },
      secrets: {
        apiKey: sealSecret('tsk_http_spec', ENC_KEY),
        ...(webhookKey === null ? {} : { webhookKey: sealSecret(webhookKey, ENC_KEY) }),
      },
    })
    .where(eq(paymentProviders.code, 'rival'));
  ctx.app.get(RivalConfigService).invalidate();
}

describe('before any configuration exists', () => {
  /*
   * The ENVIRONMENT is silenced for this case, and only this case.
   *
   * `resolve()` falls back to RIVAL_BASE_URL/RIVAL_API_KEY when no settings
   * row exists — the deliberate development floor. So on a machine whose
   * `.env` holds real credentials Rival IS configured, the request reached
   * signature verification, and this answered 401 where it expects 503. It
   * failed for every developer with live credentials and passed in CI, which
   * has none: the shape that teaches people to ignore a red suite.
   *
   * Deleting the variables before boot does not work — ConfigModule re-reads
   * the `.env` FILE — so the lookup itself is stubbed. That stubs the
   * ENVIRONMENT, not the code under test: `resolve()`, the guard and the
   * handler all run for real, and the assertion is still that an unconfigured
   * deployment answers a RETRYABLE status rather than a permanent 4xx that
   * would make Rival drop a payout event delivered mid-setup.
   */
  beforeAll(() => {
    const config = ctx.app.get(ConfigService);
    const real = config.get.bind(config);
    vi.spyOn(config, 'get').mockImplementation((key: string) =>
      RIVAL_ENV_KEYS.includes(key) ? undefined : real(key),
    );
    ctx.app.get(RivalConfigService).invalidate();
  });

  afterAll(() => {
    vi.restoreAllMocks();
    ctx.app.get(RivalConfigService).invalidate();
  });

  it('answers 503 — retryable, so an event delivered mid-setup survives', async () => {
    const res = await signedPost(depositEvent('111', 'completed'));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ received: false, outcome: 'not-configured' });
  });
});

describe('verification through the real chain', () => {
  beforeAll(async () => {
    await configureRival();
  });

  it('passes the global CsrfGuard with NO Origin header — the @NoOriginCheck pin', async () => {
    // Every request in this file omits Origin, as Rival's server does. Without
    // the decorator this would be a 403 — permanent to Rival, event lost.
    const res = await signedPost(depositEvent('112', 'pending'));
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('ignored');
  });

  it('401s a wrong bearer, a tampered body, and a stale timestamp — all permanent', async () => {
    const body = depositEvent('113', 'completed');

    const wrongKey = await signedPost(body, undefined, 'whk_a_completely_different_key_0000000');
    expect(wrongKey.status).toBe(401);

    const { signature } = signRivalBody(body, WEBHOOK_KEY, Math.floor(Date.now() / 1000));
    const tampered = await request(ctx.server)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${WEBHOOK_KEY}`)
      .set('x-crm-signature', signature)
      .send(body.replace('150.00', '999.00'));
    expect(tampered.status).toBe(401);

    const stale = await signedPost(body, Math.floor(Date.now() / 1000) - 3600);
    expect(stale.status).toBe(401);
  });

  it('verifies over the EXACT raw bytes — a re-serialised equivalent body fails', async () => {
    // The same JSON VALUE in two byte forms: key order flipped by hand, so
    // this cannot degrade into comparing a string with itself.
    const original = '{"event":"transaction.pending","reference":"whish:114"}';
    const reordered = '{"reference":"whish:114","event":"transaction.pending"}';
    expect(JSON.parse(reordered)).toEqual(JSON.parse(original));

    const at = Math.floor(Date.now() / 1000);
    const { signature } = signRivalBody(original, WEBHOOK_KEY, at);
    const res = await request(ctx.server)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${WEBHOOK_KEY}`)
      .set('x-crm-signature', signature)
      .set('x-crm-timestamp', String(at))
      .send(reordered);
    expect(res.status).toBe(401);

    // And the ORIGINAL bytes under the same signature pass — proving the 401
    // above was the bytes, not the headers.
    const ok = await request(ctx.server)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('Authorization', `Bearer ${WEBHOOK_KEY}`)
      .set('x-crm-signature', signature)
      .set('x-crm-timestamp', String(at))
      .send(original);
    expect(ok.status).toBe(200);
  });

  it('refuses a REPLAYED delivery — the nonce is real Redis, atomic, single-use', async () => {
    const body = depositEvent('115', 'pending');
    const at = Math.floor(Date.now() / 1000);

    const first = await signedPost(body, at);
    expect(first.status).toBe(200);

    const replay = await signedPost(body, at);
    expect(replay.status).toBe(401);
    expect(replay.body.outcome).toBe('replayed');

    // A RETRY is not a replay: Rival re-signs each attempt with a fresh
    // timestamp, so a legitimate second attempt carries a new signature.
    const retry = await signedPost(body, at + 1);
    expect(retry.status).toBe(200);
  });

  it('400s a signed but malformed body — permanent, not a real event', async () => {
    const res = await signedPost('this is not json');
    expect(res.status).toBe(400);

    const wrongShape = await signedPost(JSON.stringify({ hello: 'world' }));
    expect(wrongShape.status).toBe(400);
  });

  it('413s an oversize body before doing any crypto on it', async () => {
    const huge = JSON.stringify({ event: 'transaction.pending', reference: 'x'.repeat(70_000) });
    const res = await signedPost(huge);
    expect([413, 401]).toContain(res.status); // body-parser may refuse first; either way ≥400 permanent
    expect(res.status).not.toBe(200);
  });

  it('503s a verified event whose reference matches no row — the create/webhook race', async () => {
    const res = await signedPost(depositEvent('999999', 'completed'));
    expect(res.status).toBe(503);
    expect(res.body.outcome).toBe('unknown-reference');
  });

  it('200-ignores unknown event names and foreign sources — forward compatibility', async () => {
    const unknownEvent = await signedPost(
      JSON.stringify({ event: 'transaction.something_new', reference: 'whish:1' }),
    );
    expect(unknownEvent.status).toBe(200);

    const foreignSource = await signedPost(
      JSON.stringify({ event: 'transaction.completed', reference: 'omt:552' }),
    );
    expect(foreignSource.status).toBe(200);
    expect(foreignSource.body.outcome).toBe('not-ours');
  });

  it('200-acknowledges a withdrawal event for an id the CRM never submitted', async () => {
    /*
     * 'not-ours' answers 200, deliberately — the asymmetry with the deposit
     * race is real: a CRM-submitted withdrawal has its id recorded minutes
     * before Rival's HUMAN operator can decide it, so an unmatched id is a
     * withdrawal genuinely created outside the CRM (dashboard, another
     * system), and a 503 would make Rival retry it six times for nothing.
     * The reconciler's notes-match covers the theoretical gap.
     * (The full withdrawal lifecycle over events is rival-withdrawal-flow.)
     */
    const res = await signedPost(
      JSON.stringify({ event: 'withdrawal.completed', reference: 'withdrawal:abc' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('not-ours');
  });
});

describe('a rejected payout event: Rival’s REST record decides, and its note stays on the desk', () => {
  /*
   * Found live: Rival's WEBHOOK payload names the operator note `adminNote`
   * while its REST API returns `adminNotes` for the same field. Since 0173 the
   * webhook is a doorbell — the payout is re-read through REST — so the
   * spelling the webhook uses no longer matters: the words come from Rival's
   * own record. And since 0172 they never reach the client: the stored
   * rejection reason is a fixed sentence, the note is the desk's alone.
   */
  const USER_ID = 1000201;

  it('refunds on Rival’s REJECTED record; the client reads a fixed sentence, the desk the note', async () => {
    await configureRival();
    await ctx.db.db.insert(users).values({
      id: USER_ID,
      email: 'rival-adminnote-client@spec.test',
      passwordHash: 'x',
      firstName: 'Note',
      lastName: 'Case',
      emailVerified: true,
    });
    const [wallet] = await ctx.db.db
      .insert(wallets)
      .values({ userId: USER_ID, currency: 'USD', balance: '0.00000000' })
      .returning();
    const [tx] = await ctx.db.db
      .insert(transactions)
      .values({
        userId: USER_ID,
        walletId: wallet.id,
        direction: 'withdrawal',
        amount: '25.00000000',
        currency: 'USD',
        state: 'approved',
        methodKey: 'whish',
        provider: 'whish',
        ...legacyRoute('whish', 'withdrawal'),
        destination: '+961 3 123 456',
        providerPayoutId: 'rw-adminnote-1',
        providerSubmittedAt: new Date(),
      })
      .returning();

    fakeWithdrawals.set('rw-adminnote-1', {
      status: 'REJECTED',
      adminNotes: 'Recipient account frozen at Whish',
    });
    const res = await signedPost(
      JSON.stringify({
        event: 'withdrawal.rejected',
        reference: 'withdrawal:rw-adminnote-1',
        withdrawal: { id: 'rw-adminnote-1', adminNote: 'Recipient account frozen at Whish' },
      }),
    );
    expect(res.status).toBe(200);

    const [after] = await ctx.db.db.select().from(transactions).where(eq(transactions.id, tx.id));
    expect(after.state).toBe('failure');
    expect(after.rejectionReason).toBe(CLIENT_SAFE_PROVIDER_REFUSAL);
    expect(after.providerNote).toBe('Recipient account frozen at Whish');
  });
});

describe('the crown jewel: a signed completed event credits the wallet, exactly once', () => {
  const USER_ID = 1000202;
  const EXTERNAL_ID = '777001';

  beforeAll(async () => {
    await configureRival();
    await ctx.db.db
      .insert(currencies)
      .values({ code: 'USD', name: 'US Dollar', symbol: '$', enabled: true, isDefault: true })
      .onConflictDoNothing();
    await ctx.db.db
      .insert(paymentMethods)
      .values({
        key: 'whish',
        name: 'Whish',
        internalLabel: 'Whish',
        currency: 'USD',
        enabled: true,
        providerCode: 'rival',
        channelCode: 'whish',
      })
      .onConflictDoNothing();
    await ctx.db.db.insert(users).values({
      id: USER_ID,
      email: 'rival-webhook-client@spec.test',
      passwordHash: 'x',
      firstName: 'Web',
      lastName: 'Hook',
      emailVerified: true,
    });
    const [wallet] = await ctx.db.db
      .insert(wallets)
      .values({ userId: USER_ID, currency: 'USD' })
      .returning();
    await ctx.db.db.insert(transactions).values({
      userId: USER_ID,
      walletId: wallet.id,
      direction: 'deposit',
      amount: '150.00000000',
      currency: 'USD',
      state: 'pending',
      methodKey: 'whish',
      provider: 'whish',
      ...legacyRoute('whish', 'deposit'),
      providerRef: 'OX-HTTPSPEC1',
      providerPaymentId: EXTERNAL_ID,
    });
  });

  it('credits on the webhook, ignores the duplicate, and the ledger holds one row', async () => {
    fakeStatus = 'PAID';

    const first = await signedPost(depositEvent(EXTERNAL_ID, 'completed'));
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe('applied');

    const replayedEvent = await signedPost(depositEvent(EXTERNAL_ID, 'completed'));
    expect(replayedEvent.status).toBe(200);
    expect(replayedEvent.body.outcome).toBe('duplicate');

    const [wallet] = await ctx.db.db.select().from(wallets).where(eq(wallets.userId, USER_ID));
    expect(wallet.balance).toBe('150.00000000');

    const entries = await ctx.db.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, wallet.id));
    expect(entries).toHaveLength(1);

    const [tx] = await ctx.db.db
      .select()
      .from(transactions)
      .where(eq(transactions.providerPaymentId, EXTERNAL_ID));
    expect(tx.state).toBe('success');
  });

  it('a late failed event against the settled row is stale — never un-succeeds', async () => {
    const res = await signedPost(depositEvent(EXTERNAL_ID, 'failed'));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('stale');

    const [tx] = await ctx.db.db
      .select()
      .from(transactions)
      .where(eq(transactions.providerPaymentId, EXTERNAL_ID));
    expect(tx.state).toBe('success');
  });
});
