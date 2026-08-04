import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { refreshTokens } from '../../database/schema';

export type AuthSurface = 'admin' | 'portal';

/** What a presented refresh token turned out to be. */
export type RefreshVerdict =
  | { outcome: 'ok'; familyId: string; subjectId: string }
  | { outcome: 'unknown' }
  | { outcome: 'revoked' }
  | { outcome: 'expired' }
  /** The one that matters: an already-rotated token came back. */
  | { outcome: 'reused'; familyId: string; subjectId: string; revokedCount: number };

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
    subjectId: string;
    /** The `jti` already embedded in the signed token. */
    jti: string;
    token: string;
    expiresAt: Date;
  }): Promise<{ familyId: string }> {
    const familyId = randomUUID();
    await this.db.insert(refreshTokens).values({
      id: params.jti,
      familyId,
      surface: params.surface,
      subjectId: params.subjectId,
      tokenHash: this.hash(params.token),
      expiresAt: params.expiresAt,
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
      // REUSE. Burn the whole family down, including whatever the holder of the
      // newest token has.
      const revokedCount = await this.revokeFamily(row.familyId);
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
   * Marks the presented token used and records its replacement in the same
   * family.
   *
   * The UPDATE is conditional on `used_at IS NULL` and its rowcount is checked —
   * the §8.7 pattern. Two refreshes racing with the same token would otherwise
   * both read "unused", both rotate, and produce two live children of a token
   * that is meant to have exactly one. The loser is told it lost rather than
   * being handed a second valid session.
   */
  async rotate(params: {
    surface: AuthSurface;
    jti: string;
    familyId: string;
    subjectId: string;
    /** The `jti` embedded in the replacement token. */
    jtiNext: string;
    nextToken: string;
    expiresAt: Date;
  }): Promise<{ jti: string } | null> {
    const claimed = await this.db
      .update(refreshTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(refreshTokens.id, params.jti), isNull(refreshTokens.usedAt)))
      .returning({ id: refreshTokens.id });

    if (claimed.length === 0) return null;

    await this.db.insert(refreshTokens).values({
      id: params.jtiNext,
      familyId: params.familyId,
      surface: params.surface,
      subjectId: params.subjectId,
      tokenHash: this.hash(params.nextToken),
      expiresAt: params.expiresAt,
    });
    return { jti: params.jtiNext };
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
   * Ends every login for one principal, everywhere.
   *
   * This is what suspension and a password change must call: revoking only the
   * family that happens to be presenting a token leaves every other device the
   * account is signed in on still working.
   */
  async revokeAllForSubject(surface: AuthSurface, subjectId: string): Promise<number> {
    const revoked = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.surface, surface),
          eq(refreshTokens.subjectId, subjectId),
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
}
