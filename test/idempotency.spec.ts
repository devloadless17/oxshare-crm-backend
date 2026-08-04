import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import { eq } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { idempotencyKeys, users } from '../src/database/schema';
import {
  IDEMPOTENCY_HEADER,
  IdempotencyInterceptor,
} from '../src/common/security/idempotency.interceptor';
import { ConflictError, ValidationError } from '../src/common/errors/domain-errors';

/**
 * PLATFORM-CONVENTIONS R-5.2 — replayed REQUESTS, not replayed causes.
 *
 * The §6.3 constraints already make a redelivered deal, a repeated payment
 * callback and a re-run accrual no-ops. None of them covered the case a user
 * actually produces: double-clicking "Withdraw". Those are two distinct requests
 * as far as the database is concerned — both valid, both inserting a
 * transaction, both placing a hold — so the client's available balance drops
 * twice for one intended withdrawal.
 *
 * Testcontainers, not a mock: the guarantee IS a UNIQUE index and an
 * ON CONFLICT, and only real Postgres can be raced.
 */

let ctx: MoneyTestContext;
let interceptor: IdempotencyInterceptor;
let actorId: string;

/** Always reports the route as idempotent — the decorator is tested by wiring. */
const reflector = { getAllAndOverride: () => true } as unknown as Reflector;

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  interceptor = new IdempotencyInterceptor(reflector, ctx.db);

  const [user] = await ctx.db
    .insert(users)
    .values({ email: 'idem@test.local', passwordHash: 'x', firstName: 'I', lastName: 'K' })
    .returning();
  actorId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb();
  await stopMoneyTestDb(ctx);
});

/** A request as the interceptor sees it. */
function contextFor(key: string | undefined, body: unknown) {
  const headers: Record<string, string> = key ? { [IDEMPOTENCY_HEADER]: key } : {};
  const res = {
    statusCode: 201,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  const req = {
    method: 'POST',
    path: '/payments/withdrawals',
    route: { path: '/payments/withdrawals' },
    body,
    user: { id: actorId },
    get: (name: string) => headers[name.toLowerCase()],
  };
  return {
    ctx: {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext,
    res,
  };
}

/** A handler that records how many times it actually ran. */
function handlerCounting(counter: { runs: number }, result: unknown, delayMs = 0): CallHandler {
  return {
    handle: () => {
      counter.runs++;
      return delayMs > 0 ? timer(delayMs).pipe(map(() => result)) : of(result);
    },
  };
}

// `async` matters: the interceptor rejects a missing header by THROWING from
// intercept() itself, before any observable exists. Without the async wrapper
// that throw is synchronous and `expect(...).rejects` never sees it.
const run = async (key: string | undefined, body: unknown, handler: CallHandler) => {
  const { ctx: execCtx } = contextFor(key, body);
  return firstValueFrom(interceptor.intercept(execCtx, handler) as never);
};

describe('R-5.2 idempotent money requests', () => {
  it('runs the handler once and replays the stored answer on a retry', async () => {
    const counter = { runs: 0 };
    const body = { amount: '100.00', currency: 'USD' };
    const handler = handlerCounting(counter, { id: 'tx-1', amount: '100.00' });

    const first = await run('key-replay', body, handler);
    const second = await run('key-replay', body, handler);

    expect(counter.runs).toBe(1); // THE assertion: the second click did nothing
    expect(second).toEqual(first);
  });

  it('is the double-click case, verbatim: fifty concurrent clicks, one effect', async () => {
    // A real double-click races. If the interceptor did check-then-insert rather
    // than letting the UNIQUE index arbitrate, several of these would slip
    // through together — which is exactly the §6.3 warning about check-then-insert.
    const counter = { runs: 0 };
    const body = { amount: '250.00', currency: 'USD' };
    // A slow handler widens the window every duplicate has to race through.
    const handler = handlerCounting(counter, { id: 'tx-race' }, 40);

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => run('key-race', body, handler)),
    );

    // THE guarantee, and the only one that is scheduling-independent: however
    // the 50 interleave, the money moves once.
    expect(counter.runs).toBe(1);

    // Exactly one key row exists — the UNIQUE index, doing the arbitration.
    const rows = await ctx.db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, 'key-race'));
    expect(rows).toHaveLength(1);

    /*
     * Every loser is either refused (409, the first request is still running) or
     * given the identical stored answer (it had finished by then). Which of the
     * two depends on timing, so asserting a specific split — "49 rejected" —
     * tests the scheduler rather than the code, and duly flaked once in a full
     * suite run. What must ALWAYS hold is that no loser gets a different answer
     * and none of them causes a second effect.
     */
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of fulfilled) {
      expect(r.value).toEqual({ id: 'tx-race' });
    }
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect(r.reason).toBeInstanceOf(ConflictError);
    }
  });

  it('refuses the same key with a DIFFERENT body', async () => {
    // Replaying the first response here would tell the caller their second,
    // different withdrawal had succeeded. It had not — it never ran.
    const counter = { runs: 0 };
    const handler = handlerCounting(counter, { id: 'tx-2' });

    await run('key-reuse', { amount: '10.00' }, handler);
    await expect(run('key-reuse', { amount: '9999.00' }, handler)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(counter.runs).toBe(1);
  });

  it('refuses a request with no key at all', async () => {
    // Accepting it would protect only the callers who remembered the header,
    // which is the same as not protecting the endpoint.
    const counter = { runs: 0 };
    await expect(
      run(undefined, { amount: '1.00' }, handlerCounting(counter, {})),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(counter.runs).toBe(0);
  });

  it('scopes keys per actor, so two users may choose the same one', async () => {
    const [other] = await ctx.db
      .insert(users)
      .values({ email: 'idem2@test.local', passwordHash: 'x', firstName: 'O', lastName: 'K' })
      .returning();

    const counter = { runs: 0 };
    const handler = handlerCounting(counter, { id: 'tx-3' });
    const body = { amount: '5.00' };

    await run('shared-key', body, handler);

    const previous = actorId;
    actorId = other.id;
    try {
      await run('shared-key', body, handler);
    } finally {
      actorId = previous;
    }

    // Both ran: they are different people making different withdrawals that
    // happen to share a client-chosen string.
    expect(counter.runs).toBe(2);
  });

  it('lets a different operation reuse a key it already used elsewhere', async () => {
    // The scope is (key, endpoint, actor). A client that numbers its keys
    // per-screen must not have one screen block another.
    const counter = { runs: 0 };
    const handler = handlerCounting(counter, { ok: true });
    const body = { amount: '7.00' };

    await run('cross-endpoint', body, handler);

    const { ctx: execCtx } = contextFor('cross-endpoint', body);
    const req = execCtx.switchToHttp().getRequest<{ route: { path: string }; path: string }>();
    req.route.path = '/payments/deposits';
    req.path = '/payments/deposits';

    await firstValueFrom(interceptor.intercept(execCtx, handler) as never);
    expect(counter.runs).toBe(2);
  });
});
