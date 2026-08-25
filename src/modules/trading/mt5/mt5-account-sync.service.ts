import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
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

    /*
     * ── THE SNAPSHOT IS NOT ONLY A BALANCE ────────────────────────────────
     *
     * The bridge sends `group` and `leverage` on every snapshot, this DTO
     * documents both, and `trading_accounts` has a column for each — and they
     * were written ONLY at account creation and never again. A broker moving an
     * account to a different group, or changing its leverage in the manager
     * terminal, was invisible here for ever: the console kept rendering the
     * value from the day the account was opened, with nothing marking it as old.
     *
     * That is the same failure the balance mirror was built to end, on the two
     * fields sitting beside it. Data that is sent, accepted, and has somewhere
     * to go should not be dropped on the floor.
     *
     * ONLY WHEN PRESENT. Both are optional on the wire — a snapshot read through
     * a path that did not ask for them omits them — and writing `null` over a
     * known group because this particular read was silent would be worse than
     * the staleness it replaces. Absent means "no news", not "no group".
     *
     * Under the SAME staleness guard, deliberately: all three fields come from
     * one read at one instant, so if a fresher read has already landed then its
     * group and leverage are fresher too. Letting these through while the
     * balance was rejected would mix two reads into one row.
     */
    const updated = await this.db
      .update(tradingAccounts)
      .set({
        balance: snapshot.balance,
        balanceSyncedAt: readAt,
        ...(snapshot.credit !== undefined ? { credit: snapshot.credit } : {}),
        ...(snapshot.group !== undefined ? { mt5Group: snapshot.group } : {}),
        ...(snapshot.leverage !== undefined ? { leverage: snapshot.leverage } : {}),
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
   * Every MT5 login this CRM actually holds — the bridge's working set.
   *
   * ## Why the bridge needs to be told
   *
   * The bridge enumerates the broker's WHOLE BOOK every balance round, because
   * it has no other way to know which accounts exist. On this deployment that
   * already reads accounts the CRM has never heard of — the `unknown-login;
   * ignored` lines in its log are snapshots read from MT5, pushed over HTTP, and
   * discarded after two queries.
   *
   * At a broker's real scale that stops being waste and becomes the wall: a
   * hundred million logins enumerated every five minutes, to reconcile the two
   * hundred thousand the CRM owns. The fix is not a faster enumeration — it is
   * not doing it. The CRM knows exactly which logins matter, and it is the only
   * component that does.
   *
   * ## Unpaginated, and bounded by the thing that actually bounds it
   *
   * One response, because the size is set by the CRM's OWN account count rather
   * than the broker's: 100k clients holding two accounts each is ~200k logins,
   * a couple of megabytes, read once every few minutes by one machine on a
   * private network. Paging it would add a cursor, a consistency question across
   * pages, and a partial-set failure mode, to save nothing at the size this can
   * reach.
   *
   * Ordered, so the bridge's reconciliation watermark walks a stable sequence
   * rather than whatever order Postgres felt like returning.
   */
  async knownLogins(): Promise<{ logins: string[] }> {
    const rows = await this.db
      .select({ login: tradingAccounts.login })
      .from(tradingAccounts)
      .where(isNotNull(tradingAccounts.login))
      .orderBy(tradingAccounts.login);

    return {
      logins: rows.map((row) => row.login).filter((login): login is string => login !== null),
    };
  }

  /**
   * Apply MANY snapshots in ONE statement — the sweep's delivery shape.
   *
   * ## Why this exists
   *
   * The sweep sent one HTTP request per account. That is the shape that does not
   * scale: at ~16/s a 300-second round cannot push more than ~4,800 accounts
   * before the next one starts, whatever the rate limit says. Deals were fixed
   * the same way; this is the other half, and without it the balance mirror is
   * the first thing to fall behind on a large estate.
   *
   * ## One UPDATE, with the guard still PER ROW
   *
   * The staleness rule is the whole correctness property here, and batching must
   * not weaken it: each snapshot carries its own MT5 read time, and each row is
   * applied only if that read is newer than what the account already holds. So
   * the guard lives in the WHERE of a single `UPDATE … FROM (VALUES …)`, which
   * is exactly the per-row comparison the single-snapshot path makes — evaluated
   * by the database, once, for every row at once.
   *
   * `COALESCE(v.x, t.x)` keeps the "absent means no news" rule: a snapshot that
   * omits `group` leaves the stored group alone rather than blanking it.
   *
   * ## Deduplicated, freshest-wins, before the statement
   *
   * Postgres refuses to update the same row twice in one statement. A sweep can
   * legitimately carry two reads of one account — a mid-round retry, a login
   * that appears in both the changed set and the reconciliation slice — so the
   * batch keeps the NEWEST read per login. Dropping the older one is not a
   * compromise: it is what the guard would have done anyway, one statement later.
   */
  async ingestSnapshotBatch(
    snapshots: Mt5AccountSnapshotDto[],
  ): Promise<{ results: (SnapshotIngestResult & { login: string })[] }> {
    if (snapshots.length === 0) return { results: [] };

    /* Freshest read per login — see the note above on why duplicates are ordinary. */
    const freshest = new Map<string, Mt5AccountSnapshotDto>();
    for (const snapshot of snapshots) {
      const held = freshest.get(snapshot.login);
      if (!held || new Date(snapshot.readAt) > new Date(held.readAt)) {
        freshest.set(snapshot.login, snapshot);
      }
    }

    const rows = [...freshest.values()];
    const values = sql.join(
      rows.map(
        (r) =>
          sql`(${r.login}, ${r.balance}::numeric, ${new Date(r.readAt).toISOString()}::timestamptz, ${
            r.credit ?? null
          }::numeric, ${r.group ?? null}::varchar, ${r.leverage ?? null}::integer)`,
      ),
      sql`, `,
    );

    const applied = await this.db.execute<{ login: string }>(sql`
      UPDATE trading_accounts AS t
         SET balance           = v.balance,
             balance_synced_at = v.read_at,
             credit            = COALESCE(v.credit, t.credit),
             mt5_group         = COALESCE(v.grp, t.mt5_group),
             leverage          = COALESCE(v.lev, t.leverage),
             updated_at        = now()
        FROM (VALUES ${values}) AS v(login, balance, read_at, credit, grp, lev)
       WHERE t.login = v.login
         AND (t.balance_synced_at IS NULL OR t.balance_synced_at < v.read_at)
      RETURNING t.login
    `);

    const written = new Set(applied.rows.map((row) => row.login));

    /*
     * The two reasons a row was not written are different news and are told
     * apart with ONE read for the whole batch — the same distinction the
     * single-snapshot path makes with one read per snapshot.
     *
     * An unknown login is ordinary: the bridge sweeps every account on the
     * broker's server, including ones this CRM never opened.
     */
    const missing = rows.filter((r) => !written.has(r.login)).map((r) => r.login);
    const known = new Set<string>();
    if (missing.length > 0) {
      const found = await this.db
        .select({ login: tradingAccounts.login })
        .from(tradingAccounts)
        .where(inArray(tradingAccounts.login, missing));
      for (const row of found) if (row.login) known.add(row.login);
    }

    const results = rows.map((r) => {
      if (written.has(r.login)) return { login: r.login, applied: true };
      return {
        login: r.login,
        applied: false,
        reason: known.has(r.login) ? ('stale' as const) : ('unknown-login' as const),
      };
    });

    const unknown = results.filter((r) => r.reason === 'unknown-login').length;
    this.logger.log(
      `Applied ${written.size} of ${rows.length} snapshot(s) in one batch` +
        (unknown > 0 ? `; ${unknown} named no account here` : ''),
    );

    return { results };
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
