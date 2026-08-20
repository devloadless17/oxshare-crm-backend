import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { tradingAccounts } from '../../../database/schema';
import type { Mt5AccountSnapshotDto } from './dto/mt5-account-snapshot.dto';

export interface SnapshotIngestResult {
  /** False when the row was left alone — see the staleness rule below. */
  applied: boolean;
  /** Why it was skipped, for the caller's log. Absent when applied. */
  reason?: 'unknown-login' | 'stale';
}

/**
 * Writing MT5's account balance into the CRM's mirror.
 *
 * ── Why the CRM has a mirror at all ────────────────────────────────────────
 *
 * The admin trading-account list used to read balances LIVE: one bridge call per
 * account, sequentially, up to twenty-five per page load. The bridge serialises
 * every MT5 call behind a single session lock, so one operator opening that
 * screen queued twenty-five lock acquisitions — and the connection supervisor,
 * which needs the same lock to rebuild a dropped session, starved behind them.
 * The screen that displays the estate was the reason the estate could not
 * reconnect.
 *
 * This protocol cannot push. The Web API connects `PUMP_MODE_NONE` and the
 * bridge's own client says so plainly, so MT5 will never tell us a balance
 * changed; somebody has to ask. Asking on a timer, once, in the background, and
 * delivering the answer here is strictly better than asking on every page load
 * from the request path.
 *
 * ── This endpoint is a MIRROR WRITE, never a money decision ────────────────
 *
 * Nothing here creates a ledger entry, credits a wallet, or reconciles anything.
 * It copies a number MT5 already holds into a column that exists to be read
 * quickly. A snapshot that disagrees with what the CRM expected is not an error
 * to be corrected — MT5 is the authority, and the disagreement IS the news.
 */
@Injectable()
export class Mt5AccountSyncService {
  private readonly logger = new Logger(Mt5AccountSyncService.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * Apply one pushed snapshot.
   *
   * ── Idempotent, and safe when deliveries arrive OUT OF ORDER ────────────
   *
   * The bridge's outbox retries with backoff, so the same snapshot can arrive
   * twice and a newer one can overtake an older one that is still retrying. A
   * plain UPDATE would let a stale read win, and the symptom is the worst kind:
   * a balance that silently goes backwards minutes after a transfer, with every
   * component reporting success.
   *
   * So the write is guarded on `balance_synced_at`: it applies only when this
   * snapshot was READ more recently than whatever produced the value we hold.
   * That is a comparison of MT5 read times, not delivery times, which is why
   * `readAt` is stamped by the bridge at the moment it asked rather than here.
   *
   * `IS NULL` is included so the first snapshot for an account always lands —
   * NULL means MT5 has never confirmed this figure, which every comparison
   * against a timestamp would otherwise answer false.
   *
   * The guard is in the WHERE clause rather than a read-then-compare, because
   * two deliveries for one login can land concurrently and check-then-write
   * races itself. The database decides.
   */
  async ingestSnapshot(snapshot: Mt5AccountSnapshotDto): Promise<SnapshotIngestResult> {
    const readAt = new Date(snapshot.readAt);

    const updated = await this.db
      .update(tradingAccounts)
      .set({
        balance: snapshot.balance,
        balanceSyncedAt: readAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tradingAccounts.login, snapshot.login),
          or(isNull(tradingAccounts.balanceSyncedAt), lt(tradingAccounts.balanceSyncedAt, readAt)),
        ),
      )
      .returning({ id: tradingAccounts.id });

    if (updated.length > 0) return { applied: true };

    /*
     * Nothing updated has two causes and they are not the same news, so they are
     * told apart with one cheap read rather than collapsed into a shrug.
     *
     * An UNKNOWN LOGIN is normal and must NOT be an error: the bridge sweeps
     * every account on the server, including ones opened directly in the manager
     * terminal that this CRM has never heard of. Answering 4xx would make the
     * bridge retry them forever, and the outbox would fill with deliveries that
     * can never succeed.
     *
     * A STALE snapshot is the guard doing its job — a retry of something already
     * applied, or a slow delivery overtaken by a fresher read. Also not an error.
     */
    const [row] = await this.db
      .select({ id: tradingAccounts.id })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.login, snapshot.login))
      .limit(1);

    if (!row) {
      /*
       * Debug, not warn. A broker's server carries accounts this CRM did not
       * open — other desks, test accounts, the manager's own — and at one sweep
       * every five minutes a warning per account per sweep would bury the log in
       * a line that means "working as designed".
       */
      this.logger.debug(`Snapshot for MT5 ${snapshot.login} names no account here; ignored`);
      return { applied: false, reason: 'unknown-login' };
    }

    return { applied: false, reason: 'stale' };
  }

  /**
   * Record what a CRM-INITIATED operation left behind, from its own response.
   *
   * ── Why this is not a webhook ──────────────────────────────────────────
   *
   * A callback for an operation the CRM itself just made would be a second
   * network hop, a second authentication surface and an ordering hazard, all to
   * deliver a number the caller is already holding. When we asked MT5 to move a
   * balance, MT5's answer to that call is the freshest fact in the system — so
   * it is written here, synchronously, and the client sees the new figure
   * immediately rather than at the next sweep.
   *
   * The sweep still covers what this cannot: trading, swap, commission and
   * dealer operations made in the manager terminal, none of which the CRM
   * initiates and none of which it would otherwise ever learn about.
   *
   * Guarded on the same staleness rule as `ingestSnapshot`, because a sweep
   * delivery and a transfer response can land in either order.
   */
  async recordFromOperation(login: string, balance: string, readAt: Date): Promise<void> {
    await this.db
      .update(tradingAccounts)
      .set({ balance, balanceSyncedAt: readAt, updatedAt: new Date() })
      .where(
        and(
          eq(tradingAccounts.login, login),
          or(isNull(tradingAccounts.balanceSyncedAt), lt(tradingAccounts.balanceSyncedAt, readAt)),
        ),
      );
  }

  /** How many accounts MT5 has never confirmed a balance for — a readiness signal. */
  async unconfirmedCount(): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(tradingAccounts)
      .where(
        and(isNull(tradingAccounts.balanceSyncedAt), sql`${tradingAccounts.login} IS NOT NULL`),
      );

    return row?.value ?? 0;
  }
}
