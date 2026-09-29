import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { refreshTokens, users } from '../src/database/schema';
import { RefreshTokensService } from '../src/common/security/refresh-tokens.service';

/**
 * The refresh chain under ADVERSARIAL interleavings — the states between the
 * states refresh-reuse.spec.ts pins. Every case here is a sequence a real
 * fleet of tabs (or an attacker standing beside them) can produce, and each
 * assertion is the exact verdict the machinery hands back, so a change to the
 * grace window or the chain walk cannot shift a boundary silently.
 */

let ctx: MoneyTestContext;
let service: RefreshTokensService;
let subjectId: number;

const TTL = 30 * 24 * 60 * 60 * 1000;
const expires = () => new Date(Date.now() + TTL);

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  service = new RefreshTokensService(ctx.db);
  const [user] = await ctx.db
    .insert(users)
    .values({ email: 'adversary@test.local', passwordHash: 'x', firstName: 'A', lastName: 'V' })
    .returning();
  subjectId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb();
  await stopMoneyTestDb(ctx);
});

interface Held {
  jti: string;
  token: string;
  familyId: string;
}

/** The raw token value of every row this suite minted — verify needs it back. */
const mintedTokens = new Map<string, string>();
function tokenOf(jti: string): string {
  const remembered = mintedTokens.get(jti);
  if (!remembered) throw new Error(`no token recorded for ${jti}`);
  return remembered;
}

async function login(): Promise<Held> {
  const jti = randomUUID();
  const token = `token-${randomUUID()}`;
  const { familyId } = await service.record({
    surface: 'portal',
    subjectId,
    jti,
    token,
    expiresAt: expires(),
  });
  mintedTokens.set(jti, token);
  return { jti, token, familyId };
}

/** One rotation the CLIENT RECEIVES — consumes `current`, hands back its child. */
async function rotate(current: Held): Promise<Held> {
  const jtiNext = randomUUID();
  const nextToken = `token-${randomUUID()}`;
  const rotated = await service.rotate({
    surface: 'portal',
    jti: current.jti,
    familyId: current.familyId,
    subjectId,
    jtiNext,
    nextToken,
    expiresAt: expires(),
  });
  expect(rotated, 'a rotation that should have succeeded returned null').not.toBeNull();
  mintedTokens.set(jtiNext, nextToken);
  return { jti: jtiNext, token: nextToken, familyId: current.familyId };
}

/** Backdate a consumed row's used_at — time travel for the grace window. */
async function backdateUse(jti: string, ms: number): Promise<void> {
  const [row] = await ctx.db
    .select({ usedAt: refreshTokens.usedAt })
    .from(refreshTokens)
    .where(eq(refreshTokens.id, jti))
    .limit(1);
  expect(row?.usedAt).toBeTruthy();
  await ctx.db
    .update(refreshTokens)
    .set({ usedAt: new Date(row.usedAt!.getTime() - ms) })
    .where(eq(refreshTokens.id, jti));
}

describe('the retry grace window has HARD boundaries', () => {
  it('graces a replay moments after a lost rotation, and refuses one 31s later', async () => {
    const t0 = await login();
    await rotate(t0); // response lost — the client never received the child

    // Moments later: a retry, and the successor sits unused — graced.
    const graced = await service.verify({ surface: 'portal', jti: t0.jti, token: t0.token });
    expect(graced.outcome).toBe('retried');

    // The same replay 31 seconds after the consumption: outside the window,
    // and the verdict flips to theft — the whole family burns.
    await backdateUse(t0.jti, 31_000);
    const refused = await service.verify({ surface: 'portal', jti: t0.jti, token: t0.token });
    expect(refused.outcome).toBe('reused');

    // Nothing in the family survives a reuse verdict.
    const rows = await ctx.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, t0.familyId));
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('refuses the grace once the client has provably moved on', async () => {
    /*
     * The signature that separates a retry from a theft: a retry presents the
     * LAST consumed token. Here the client demonstrably received the child and
     * used it — so a replay of the parent is somebody else holding a copy.
     */
    const t0 = await login();
    const t1 = await rotate(t0);
    await rotate(t1); // the client moved on: t1 is consumed, t2 is live

    const verdict = await service.verify({ surface: 'portal', jti: t0.jti, token: t0.token });
    expect(verdict.outcome).toBe('reused');
  });
});

describe('the two-generation interleaving — two tabs retrying one lost rotation', () => {
  it('the loser retrying with the JAR token survives; re-presenting the stale one burns', async () => {
    /*
     * The fleet race: a rotation's response is lost, TWO tabs retry with the
     * same stale cookie. Both get the graced verdict naming the same unused
     * successor; one rotation wins, the other returns null and the HTTP layer
     * answers SESSION_SUPERSEDED. What the losing tab does next decides
     * everything:
     *
     *  - The BROWSER path: axios re-posts and the browser attaches the CURRENT
     *    jar cookie — the winner's child. That must succeed, or every lost
     *    race becomes an eviction.
     *  - Re-presenting the ORIGINAL stale token (only code that captured the
     *    cookie value can do this) is indistinguishable from replaying a
     *    stolen token whose successor was consumed — and must burn.
     */
    const t0 = await login();
    await rotate(t0); // lost response; t1 exists, unused

    // Both tabs retry t0; both are graced toward the same successor.
    const a = await service.verify({ surface: 'portal', jti: t0.jti, token: t0.token });
    const b = await service.verify({ surface: 'portal', jti: t0.jti, token: t0.token });
    expect(a.outcome).toBe('retried');
    expect(b.outcome).toBe('retried');
    const successorJti = (a as { successorJti: string }).successorJti;

    // Tab A's rotation of the successor WINS.
    const successorToken = tokenOf(successorJti);
    const winnerChild = await rotate({
      jti: successorJti,
      token: successorToken,
      familyId: t0.familyId,
    });

    // Tab B's rotation of the same successor LOSES — null, never a session.
    const lost = await service.rotate({
      surface: 'portal',
      jti: successorJti,
      familyId: t0.familyId,
      subjectId,
      jtiNext: randomUUID(),
      nextToken: `token-${randomUUID()}`,
      expiresAt: expires(),
    });
    expect(lost, 'the losing rotation must not mint a second child').toBeNull();

    // The browser retry: current jar cookie = the winner's child. It works.
    const jarRetry = await service.verify({
      surface: 'portal',
      jti: winnerChild.jti,
      token: winnerChild.token,
    });
    expect(jarRetry.outcome, 'the honest fleet lost its session to a lost race').toBe('ok');

    // The stale-copy retry: t0 again, now two generations back with a consumed
    // successor. Theft-shaped, and treated as theft.
    const staleRetry = await service.verify({ surface: 'portal', jti: t0.jti, token: t0.token });
    expect(staleRetry.outcome).toBe('reused');
  });
});

describe('a family that transiently holds two live rows', () => {
  it('grants at most ONE graced successor, never a session per live row', async () => {
    /*
     * chainStateOf picks its successor with an unordered scan, and a crash or
     * a raced insert can leave a family with two unconsumed children. The
     * invariant that must hold whatever the pick: a graced retry names ONE
     * successor, and rotating it consumes it — the other live row can never be
     * minted into a parallel session by the same replay.
     */
    const t0 = await login();
    await rotate(t0); // child #1, unused
    // A second live child injected directly — the corrupted-family shape.
    const ghostJti = randomUUID();
    const ghostToken = `token-${randomUUID()}`;
    await service.record({
      surface: 'portal',
      subjectId,
      jti: ghostJti,
      token: ghostToken,
      expiresAt: expires(),
      familyId: t0.familyId,
    });
    mintedTokens.set(ghostJti, ghostToken);

    const verdict = await service.verify({ surface: 'portal', jti: t0.jti, token: t0.token });
    expect(verdict.outcome).toBe('retried');
    const named = (verdict as { successorJti: string }).successorJti;

    // Rotate the named successor; the SAME replay must not now be graced
    // toward the other live row into a second parallel session — the moment
    // anything was consumed after t0, the grace is gone.
    await rotate({ jti: named, token: tokenOf(named), familyId: t0.familyId });
    const second = await service.verify({ surface: 'portal', jti: t0.jti, token: t0.token });
    expect(second.outcome, 'a corrupted family handed out a second session').toBe('reused');
  });
});

describe('two rotations inside one millisecond', () => {
  it('does not re-open the grace for a token two consumptions back', async () => {
    /*
     * consumedAfterPresented compares used_at with STRICT >. Two consumptions
     * stamped in the same millisecond would compare equal — and a replay of
     * the older token would read as "nothing consumed after me" and be graced.
     * Constructed here by pinning both timestamps to one value.
     */
    const t0 = await login();
    const t1 = await rotate(t0);
    await rotate(t1); // t2 live; t0,t1 consumed

    const [t0row] = await ctx.db
      .select({ usedAt: refreshTokens.usedAt })
      .from(refreshTokens)
      .where(eq(refreshTokens.id, t0.jti))
      .limit(1);
    // Same-millisecond world: t1's consumption stamped exactly at t0's.
    await ctx.db
      .update(refreshTokens)
      .set({ usedAt: t0row.usedAt })
      .where(and(eq(refreshTokens.id, t1.jti), eq(refreshTokens.familyId, t0.familyId)));

    const verdict = await service.verify({ surface: 'portal', jti: t0.jti, token: t0.token });
    expect(
      verdict.outcome,
      'a same-millisecond consumption re-opened the retry grace for a stale token',
    ).toBe('reused');
  });
});
