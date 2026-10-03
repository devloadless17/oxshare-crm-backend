import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { and, desc, eq, gt, isNull, lt } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db, Executor } from '../../database/db';
import { refreshTokens } from '../../database/schema';
import { ALERT_KINDS, raiseAlert } from '../logging/alerts';

export type AuthSurface = 'admin' | 'portal';

/** What the request looked like, for the session list to show back. */
export interface DeviceFingerprint {
  userAgent?: string | null;
  ip?: string | null;
}

/**
 * One SESSION, as a client understands the word.
 *
 * A session is a refresh-token FAMILY, not a row. One login starts a family and
 * every rotation appends a member to it, so a client signed in for a month on
 * one laptop has ~2,900 rows and exactly one session. Listing rows would show
 * them a wall of identical entries and no way to end "the one on the old
 * phone"; listing families shows them what they actually did.
 */
export interface SessionSummary {
  /** The family id. This is what DELETE /auth/sessions/:id revokes. */
  id: string;
  /** When the login happened — the oldest member of the family. */
  createdAt: Date;
  /** The newest member's creation: the last time this session was refreshed. */
  lastActiveAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}

/** What a presented refresh token turned out to be. */
export type RefreshVerdict =
  | { outcome: 'ok'; familyId: string; subjectId: string }
  | { outcome: 'unknown' }
  | { outcome: 'revoked' }
  | { outcome: 'expired' }
  /**
   * An already-rotated token came back, but everything about it says the
   * caller never received the replacement — see `RETRY_GRACE_MS`. Not theft:
   * rotate `successorJti` and hand out a working session.
   */
  | { outcome: 'retried'; familyId: string; subjectId: string; successorJti: string }
  /** The one that matters: an already-rotated token came back. */
  | { outcome: 'reused'; familyId: string; subjectId: string; revokedCount: number };

/**
 * How long after a rotation a replay of the CONSUMED token is read as a retry
 * rather than as theft.
 *
 * The problem it solves: rotation happens server-side, then the response is
 * lost — a dropped connection, a closed tab, a mobile network handoff, a proxy
 * timeout. The client still holds the old token, because it never received the
 * new one, and its retry was being answered by destroying the entire session
 * and paging somebody with a credential-theft alert.
 *
 * Thirty seconds is wide enough for a retry on a slow mobile network and for two
 * tabs whose requests cross in flight. It is not the load-bearing part of the
 * rule, though — the successor test below is. See `verify()`.
 */
const RETRY_GRACE_MS = 30_000;

/**
 * Refresh-token families, and what to do when one is replayed.
 *
 * PLATFORM-CONVENTIONS R-3.3. Rotation alone — mint a new token, invalidate the
 * presented one — leaves a question unanswered: what happens when the OLD token
 * shows up again?
 *
 * It shows up for exactly one reason: somebody kept a copy. Previously the
 * answer was "the stored hash no longer matches, so this request fails", and the
 * attacker simply used the newer token they had also captured. Nothing recorded
 * that a credential had leaked, and nothing stopped them.
 *
 * Here, replaying any already-used member revokes the entire family — every
 * descendant of that login, including the one the attacker currently holds. The
 * legitimate user is logged out once and logs back in. The attacker is locked
 * out for good, and the event is logged as the security signal it is.
 */
@Injectable()
export class RefreshTokensService {
  private readonly logger = new Logger(RefreshTokensService.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * SHA-256, not bcrypt.
   *
   * bcrypt's cost exists to slow down guessing a low-entropy secret. A signed
   * JWT is not guessable, so that work bought nothing and was paid on every
   * single refresh. The hash is here so a database leak does not hand over live
   * sessions — and for that, SHA-256 is sufficient.
   */
  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Starts a new family. Called on login, and on any other fresh session.
   *
   * Returns the `jti` to embed in the token, so the token can find its own row.
   */
  async record(params: {
    surface: AuthSurface;
    subjectId: string | number;
    /** The `jti` already embedded in the signed token. */
    jti: string;
    token: string;
    expiresAt: Date;
    /** Who and where — see the columns' comment in schema.ts. */
    device?: DeviceFingerprint;
    /**
     * The family id, when the caller has already minted it.
     *
     * The access token carries this as its `fam` claim so revocation can reach
     * it (see `familyIsRevoked`), which means the caller has to know the id
     * BEFORE it signs anything. Optional so the surfaces that do not put `fam`
     * in their tokens keep the old behaviour of having one generated here.
     */
    familyId?: string;
    /** Join the caller's transaction � a Google first sign-in links and starts the session in one. */
    executor?: Executor;
  }): Promise<{ familyId: string }> {
    const familyId = params.familyId ?? randomUUID();
    await (params.executor ?? this.db).insert(refreshTokens).values({
      id: params.jti,
      familyId,
      surface: params.surface,
      subjectId: String(params.subjectId),
      tokenHash: this.hash(params.token),
      expiresAt: params.expiresAt,
      userAgent: params.device?.userAgent ?? null,
      ip: params.device?.ip ?? null,
    });
    return { familyId };
  }

  /**
   * Judges a presented token WITHOUT rotating it.
   *
   * Split from rotation so the caller can decide what a bad verdict means — the
   * reuse case in particular is a security event, not just a failed request.
   */
  async verify(params: {
    surface: AuthSurface;
    jti: string;
    token: string;
  }): Promise<RefreshVerdict> {
    const [row] = await this.db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.id, params.jti), eq(refreshTokens.surface, params.surface)))
      .limit(1);

    // No row: a token from before this table existed, or one whose family was
    // swept after expiry. Either way it is not a session.
    if (!row) return { outcome: 'unknown' };

    // The hash must match even though the id did. Without this check, anyone who
    // learned a jti — it is not secret, it rides in a readable JWT payload —
    // could present a forged token and be told the family was fine.
    if (row.tokenHash !== this.hash(params.token)) return { outcome: 'unknown' };

    if (row.revokedAt) return { outcome: 'revoked' };
    if (row.expiresAt.getTime() <= Date.now()) return { outcome: 'expired' };

    if (row.usedAt) {
      /*
       * Before concluding theft: is this a RETRY of a rotation whose response
       * never arrived?
       *
       * Two conditions, and the second is the one that carries the weight:
       *
       *  1. It is recent (`RETRY_GRACE_MS`). A token replayed hours later is not
       *     a retry of anything.
       *
       *  2. **The successor was never used.** This is the signature that
       *     separates the two cases, and it does so in the attacker's direction
       *     rather than ours. A lost response means nobody ever received the
       *     replacement, so it sits unused. An attacker replaying a captured
       *     token while the legitimate user carries on means the user HAS used
       *     the replacement — so `usedAt` is set on it, this test fails, and the
       *     family is destroyed exactly as before.
       *
       * The narrow case this admits is an attacker who captures a token and
       * replays it inside thirty seconds, before the legitimate client has made
       * its next request. That is a real narrowing of reuse detection and it is
       * the price of not destroying a session every time a mobile connection
       * drops mid-refresh. It is bounded by the successor test: the moment the
       * real client refreshes again, the chain has two live branches, one of
       * them gets replayed, and the family dies.
       */
      const chain = await this.chainStateOf(row.familyId, { id: row.id, usedAt: row.usedAt });
      const withinGrace = Date.now() - row.usedAt.getTime() <= RETRY_GRACE_MS;
      if (withinGrace && chain.liveJti && !chain.consumedAfterPresented) {
        this.logger.log(
          `Refresh token retried on the ${params.surface} surface for subject ` +
            `${row.subjectId}: the rotation at ${row.usedAt.toISOString()} evidently did not ` +
            'reach the client, whose replacement is still unused. Rotating the successor ' +
            'instead of destroying the session.',
        );
        return {
          outcome: 'retried',
          familyId: row.familyId,
          subjectId: row.subjectId,
          successorJti: chain.liveJti,
        };
      }

      // REUSE. Burn the whole family down, including whatever the holder of the
      // newest token has.
      const revokedCount = await this.revokeFamily(row.familyId);
      raiseAlert(
        this.logger,
        ALERT_KINDS.REFRESH_TOKEN_REUSE,
        'page',
        `A rotated refresh token was replayed on the ${params.surface} surface — a credential has left the browser it was issued to`,
        { surface: params.surface, subjectId: row.subjectId, revokedCount },
      );
      this.logger.warn(
        `Refresh token REUSE detected on the ${params.surface} surface for subject ` +
          `${row.subjectId}: a token rotated at ${row.usedAt.toISOString()} was presented again. ` +
          `Revoked ${revokedCount} token(s) in family ${row.familyId}. Every session descended ` +
          'from that login is now dead; the holder must authenticate again.',
      );
      return {
        outcome: 'reused',
        familyId: row.familyId,
        subjectId: row.subjectId,
        revokedCount,
      };
    }

    return { outcome: 'ok', familyId: row.familyId, subjectId: row.subjectId };
  }

  /**
   * The family's newest still-usable row, and whether anything was consumed
   * after `presented` — the two facts the retry test needs.
   *
   * ## Why it is asked this way
   *
   * Two earlier shapes were wrong, and both were wrong invisibly:
   *
   *  - **"the row created after this one"** — `created_at` defaults to `now()`,
   *    which Postgres resolves to the TRANSACTION timestamp, so rows written
   *    close together share a value and `>` finds nothing. The grace window
   *    simply never applied.
   *  - **"the family has any live row"** — always true of a healthy family, so
   *    it graced genuine theft as readily as a retry, which is strictly worse
   *    than not having built it.
   *
   * The exact question is whether the presented token is the LAST one that was
   * consumed. A family is a chain: every rotation consumes one row and appends
   * its replacement, so at any moment the first n-1 rows are used and the last
   * is live.
   *
   *  - A retry presents the row that was consumed most recently — nothing came
   *    after it, because the client never received the replacement it would have
   *    gone on to use.
   *  - A replay of a captured token presents a row from further back, and the
   *    legitimate client has consumed rows after it.
   *
   * `used_at` is written by an explicit `new Date()` rather than by `now()`, so
   * unlike `created_at` it carries real per-statement ordering.
   */
  private async chainStateOf(
    familyId: string,
    presented: { id: string; usedAt: Date },
  ): Promise<{ liveJti: string | null; consumedAfterPresented: boolean }> {
    const rows = await this.db
      .select({
        id: refreshTokens.id,
        usedAt: refreshTokens.usedAt,
        revokedAt: refreshTokens.revokedAt,
        expiresAt: refreshTokens.expiresAt,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, familyId));

    const now = Date.now();
    const live = rows.find(
      (r) => !r.usedAt && !r.revokedAt && r.expiresAt.getTime() > now && r.id !== presented.id,
    );
    /*
     * >= and not >, deliberately. Two consumptions stamped in the SAME
     * millisecond compare equal, and with a strict comparison a replay of the
     * older token read as "nothing consumed after me" — graced toward the
     * live successor, which hands an attacker a session for the price of
     * landing in the right millisecond. When order cannot be told, fail
     * CLOSED: a genuine retry has no OTHER consumed row at its own timestamp,
     * because the client that never received a response never rotated again.
     */
    const consumedAfterPresented = rows.some(
      (r) => r.id !== presented.id && r.usedAt !== null && r.usedAt >= presented.usedAt,
    );

    return { liveJti: live?.id ?? null, consumedAfterPresented };
  }

  /**
   * Marks the presented token used and records its replacement in the same
   * family.
   *
   * The UPDATE is conditional on `used_at IS NULL` and its rowcount is checked —
   * the §8.7 pattern. Two refreshes racing with the same token would otherwise
   * both read "unused", both rotate, and produce two live children of a token
   * that is meant to have exactly one. The loser is told it lost rather than
   * being handed a second valid session.
   *
   * **Both statements run in ONE transaction.** They did not, and the gap was a
   * silent session killer: a crash, a connection reset or a pool eviction
   * between the claim and the insert left the family with its current member
   * consumed and no replacement — which `familyIsRevoked()` reads as a dead
   * session, with nothing anywhere recording why. Rare, unreproducible, and
   * indistinguishable from a revocation when it happened.
   */
  async rotate(params: {
    surface: AuthSurface;
    jti: string;
    familyId: string;
    subjectId: string | number;
    /** The `jti` embedded in the replacement token. */
    jtiNext: string;
    nextToken: string;
    expiresAt: Date;
    /**
     * Carried forward on every rotation, not just recorded at login.
     *
     * A session's row is replaced roughly every fifteen minutes for thirty
     * days. Writing the fingerprint only on the login row would mean the
     * session list showed where a client signed in a month ago rather than
     * where the session is being used NOW — and "used from a new country an
     * hour ago" is the entire signal this feature exists to surface.
     */
    device?: DeviceFingerprint;
  }): Promise<{ jti: string } | null> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx
        .update(refreshTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(refreshTokens.id, params.jti), isNull(refreshTokens.usedAt)))
        .returning({ id: refreshTokens.id });

      if (claimed.length === 0) return null;

      await tx.insert(refreshTokens).values({
        id: params.jtiNext,
        familyId: params.familyId,
        surface: params.surface,
        subjectId: String(params.subjectId),
        tokenHash: this.hash(params.nextToken),
        expiresAt: params.expiresAt,
        userAgent: params.device?.userAgent ?? null,
        ip: params.device?.ip ?? null,
      });
      return { jti: params.jtiNext };
    });
  }

  /** Ends one login. Used by the reuse response and by logout. */
  async revokeFamily(familyId: string): Promise<number> {
    const revoked = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return revoked.length;
  }

  /**
   * Has this login been ended? Asked of the ACCESS token, on every request.
   *
   * Revocation used to reach only the refresh family, which made "sign out that
   * device" a promise the system kept fifteen minutes late: the family died, and
   * the access token minted from it went on authenticating every request until
   * it expired on its own. For an account that moves money, the fifteen minutes
   * after you notice a session you do not recognise are the fifteen that matter.
   * The same gap made a password change fail to cut an attacker off.
   *
   * A family is dead when it has no live row left. Asking it that way — rather
   * than "is some row revoked" — is what makes rotation safe: every rotation
   * revokes the row it consumed and inserts its successor under the same family,
   * so a living session always has exactly one unrevoked row, and a revoked one
   * has none.
   *
   * One indexed lookup per authenticated request, and only for tokens carrying a
   * `fam` claim. That is a real cost, paid deliberately: the alternative is a
   * revocation control that does not revoke.
   */
  async familyIsRevoked(surface: AuthSurface, familyId: string): Promise<boolean> {
    const [live] = await this.db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.surface, surface),
          eq(refreshTokens.familyId, familyId),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .limit(1);
    return live === undefined;
  }

  /**
   * Ends every login for one principal, everywhere.
   *
   * This is what suspension and a password change must call: revoking only the
   * family that happens to be presenting a token leaves every other device the
   * account is signed in on still working.
   */
  async revokeAllForSubject(surface: AuthSurface, subjectId: string | number): Promise<number> {
    const revoked = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.surface, surface),
          eq(refreshTokens.subjectId, String(subjectId)),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning({ id: refreshTokens.id });
    return revoked.length;
  }

  /**
   * Deletes rows past expiry.
   *
   * Kept until then rather than until first use: a token's row IS the record
   * that it was already rotated, and deleting it early would turn a detectable
   * replay back into a plain "unknown token".
   */
  async sweepExpired(): Promise<number> {
    const deleted = await this.db
      .delete(refreshTokens)
      .where(lt(refreshTokens.expiresAt, new Date()))
      .returning({ id: refreshTokens.id });
    return deleted.length;
  }

  /**
   * The family a presented token belongs to, without judging it.
   *
   * Used to mark "this device" in the session list. Deliberately does NOT
   * verify the token hash or the revocation state: the caller has already been
   * authenticated by `JwtAuthGuard` against the ACCESS token, and this only
   * decides which row in a list the client is already entitled to see gets a
   * label. A wrong answer here mislabels a row; it grants nothing.
   */
  async familyIdForJti(surface: AuthSurface, jti: string): Promise<string | null> {
    const [row] = await this.db
      .select({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.id, jti), eq(refreshTokens.surface, surface)))
      .limit(1);
    return row?.familyId ?? null;
  }

  /**
   * Every live session for one principal, one row per LOGIN.
   *
   * Aggregated in SQL rather than by reading families into memory: a month-old
   * session is thousands of rows, and this endpoint is reachable by any signed-in
   * client. Grouping in the database keeps the response proportional to the
   * number of logins rather than to how long they have been signed in.
   *
   * Revoked and expired families are excluded — the question is "who is signed
   * in", and a session that has already ended is not something the client can
   * act on. It would also make the list grow forever and bury the live rows.
   *
   * `userAgent` / `ip` come from `max(created_at)`'s row via DISTINCT ON, so the
   * fingerprint shown is the most RECENT one for that session rather than the
   * one captured at login a month ago.
   */
  async listSessions(surface: AuthSurface, subjectId: string | number): Promise<SessionSummary[]> {
    const now = new Date();
    const rows = await this.db
      .select()
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.surface, surface),
          eq(refreshTokens.subjectId, String(subjectId)),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, now),
        ),
      )
      .orderBy(refreshTokens.familyId, desc(refreshTokens.createdAt));

    const byFamily = new Map<string, SessionSummary>();
    for (const row of rows) {
      const seen = byFamily.get(row.familyId);
      if (!seen) {
        // First row of this family in the ordering, so it is the NEWEST — its
        // fingerprint and expiry are the current ones.
        byFamily.set(row.familyId, {
          id: row.familyId,
          createdAt: row.createdAt,
          lastActiveAt: row.createdAt,
          expiresAt: row.expiresAt,
          userAgent: row.userAgent,
          ip: row.ip,
        });
        continue;
      }
      // Older members only move the login time backwards. Nothing else about
      // them is current.
      if (row.createdAt < seen.createdAt) seen.createdAt = row.createdAt;
    }

    return [...byFamily.values()].sort(
      (a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime(),
    );
  }

  /**
   * Ends one session, if it belongs to the caller.
   *
   * The ownership predicate is in the WHERE clause rather than a preceding
   * SELECT, so there is no window between checking and revoking and no way for
   * a caller to end somebody else's session by guessing a family id. A family
   * that is not theirs matches nothing and reports 0 — which the caller cannot
   * distinguish from an id that does not exist, and that is the right answer to
   * give them.
   */
  async revokeFamilyForSubject(
    surface: AuthSurface,
    subjectId: string | number,
    familyId: string,
  ): Promise<number> {
    const revoked = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.familyId, familyId),
          eq(refreshTokens.surface, surface),
          eq(refreshTokens.subjectId, String(subjectId)),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning({ id: refreshTokens.id });
    return revoked.length;
  }
}
