import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { ledgerEntries, users, wallets } from '../../database/schema';
import { money } from './money';
import { ALERT_KINDS, raiseAlert } from '../../common/logging/alerts';

export interface WalletDiscrepancy {
  walletId: string;
  /** The human handle an operator quotes; `walletId` is what queries key on. */
  walletNumber: string;
  userId: number;
  /** The client's Portal ID — the identifier an operator quotes; null only if the user row is gone. */
  userPortalId: number | null;
  userFirstName: string | null;
  userLastName: string | null;
  userEmail: string | null;
  currency: string;
  balance: string;
  ledgerSum: string;
  /** balance − ledgerSum. Signed, so the direction of the error is visible. */
  difference: string;
}

export interface ReconciliationReport {
  checkedAt: string;
  walletsChecked: number;
  /**
   * The WORST discrepancies by absolute difference, capped at `SAMPLE_LIMIT`.
   *
   * A SAMPLE, not the set — see `discrepancyCount` for how many there are. The
   * cap exists because this field used to be every mismatched row: on a
   * database whose wallets were seeded with balances and no ledger, that is
   * thirty thousand objects built, serialised into the report, and logged.
   */
  walletDiscrepancies: WalletDiscrepancy[];
  /** How many wallets disagree in total, whatever the sample above holds. */
  discrepancyCount: number;
  /** Sum of the absolute differences — the size of the problem, not its shape. */
  totalDifference: string;
  balanced: boolean;
}

/**
 * How many mismatched wallets the report carries and the log names.
 *
 * ## Why this is capped at all
 *
 * The hourly job took the server down. `findWalletDiscrepancies` returned every
 * mismatched wallet and `report()` emitted TWO log lines each — a `page` alert
 * and a full diagnostic — so a database with 30,011 unbacked balances produced
 * about sixty thousand synchronous writes to stdout in one tick, every hour.
 * Node's console transport is blocking on a pipe, so that is the event loop
 * held for the duration: requests time out, the socket's LISTEN connection
 * misses its heartbeat, and the process looks hung.
 *
 * ## Why a cap is the right answer rather than a bigger buffer
 *
 * Thirty thousand identical `page`-severity alerts are not thirty thousand
 * pieces of information. They are ONE fact — "the balances and the ledger
 * disagree at scale" — repeated until it buries every other line in the log,
 * including whichever alert somebody actually needed to see. A detector that
 * takes the system down when it detects something is worse than no detector:
 * it fails precisely when it matters, and it trains people to turn it off.
 *
 * Twenty is enough to characterise the problem — the largest differences, the
 * currencies involved, whether it is one client or all of them — and the exact
 * set is always one SQL query away for somebody actually diagnosing it.
 */
const SAMPLE_LIMIT = 20;

/**
 * Reconciliation as a PRODUCTION control, not only a CI test.
 *
 * PLATFORM-CONVENTIONS §12.2. ARCHITECTURE §11's reconciliation test is
 * excellent and passes: it replays a deal fixture through the whole pipeline and
 * asserts every wallet balances to the cent. What it proves is that the CODE was
 * correct at commit time.
 *
 * It cannot detect a production ledger that has drifted — from a manual database
 * fix during an incident, a partially-applied migration, a bug on a path the
 * fixture never exercises, or a restore that landed between two writes. Those
 * are exactly the ways a money system goes wrong in the real world, and every
 * one of them leaves the tests green.
 *
 * So the same assertion runs against live data, on a schedule. Two invariants:
 *
 *  1. For every wallet, the sum of its ledger entries equals its balance. This
 *     is §6.2's guarantee — the ledger is the truth and the balance is a cached
 *     projection of it — checked rather than assumed.
 *  2. Every CONFIRMED accrual has a ledger entry. A confirmed accrual that never
 *     credited is commission an IB has earned and not been paid: invisible in
 *     the wallet check, because a missing credit leaves the wallet perfectly
 *     self-consistent.
 *
 * A mismatch is reported, never repaired. An automatic correction would write a
 * compensating entry for a cause nobody has diagnosed, turning a detectable
 * discrepancy into a permanent one that looks deliberate.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async run(): Promise<ReconciliationReport> {
    const [summary, walletDiscrepancies, walletsChecked] = await Promise.all([
      this.summariseDiscrepancies(),
      this.findWalletDiscrepancies(),
      this.countWallets(),
    ]);

    const report: ReconciliationReport = {
      checkedAt: new Date().toISOString(),
      walletsChecked,
      walletDiscrepancies,
      discrepancyCount: summary.count,
      totalDifference: summary.total,
      /*
       * Decided by the COUNT, never by the sample's length. The sample is
       * capped, so `walletDiscrepancies.length === 0` would read as balanced
       * only by coincidence — and on a database with more than `SAMPLE_LIMIT`
       * mismatches it would be right for the wrong reason, which is the kind of
       * agreement that stops being true later.
       */
      balanced: summary.count === 0,
    };

    this.report(report);
    return report;
  }

  /**
   * Compares every balance against the sum of its own ledger, in ONE query.
   *
   * Done in SQL rather than by looping wallets in application code: at 219,000
   * clients a per-wallet round trip is hundreds of thousands of queries, and a
   * reconciliation that is too slow to run is one that stops being run. NUMERIC
   * arithmetic also stays in Postgres, where it is exact — pulling every balance
   * into JS to add up would be the §6.1 mistake at scale.
   */
  private async findWalletDiscrepancies(): Promise<WalletDiscrepancy[]> {
    const rows = await this.db.execute<{
      id: string;
      wallet_number: string;
      user_id: number;
      user_portal_id: number | null;
      user_first_name: string | null;
      user_last_name: string | null;
      user_email: string | null;
      currency: string;
      balance: string;
      ledger_sum: string;
      difference: string;
    }>(sql`
      SELECT w.id,
             w.wallet_number,
             w.user_id,
             -- WHO the wallet belongs to. This report named clients by uuid
             -- alone, on the one screen whose entire job is to say a specific
             -- client's money does not add up. A LEFT join because the ledger
             -- is append-only: a wallet whose client row has gone must still be
             -- reported, or the discrepancy disappears with the person.
             u.id                                              AS user_portal_id,
             u.first_name                                      AS user_first_name,
             u.last_name                                       AS user_last_name,
             u.email                                           AS user_email,
             w.currency,
             w.balance::text                                   AS balance,
             COALESCE(SUM(le.amount), 0)::text                 AS ledger_sum,
             (w.balance - COALESCE(SUM(le.amount), 0))::text   AS difference
        FROM ${wallets} w
        LEFT JOIN ${ledgerEntries} le ON le.wallet_id = w.id
        LEFT JOIN ${users} u ON u.id = w.user_id
       GROUP BY w.id, w.wallet_number, w.user_id, u.id, u.first_name, u.last_name,
                u.email, w.currency, w.balance
      HAVING w.balance <> COALESCE(SUM(le.amount), 0)
       -- Worst first, and CAPPED at SAMPLE_LIMIT. Without the limit this
       -- materialised every mismatched wallet: thirty thousand rows through the
       -- driver, into objects, into the report, into the log.
       --
       -- Ordered by the ABSOLUTE difference, so the sample holds the biggest
       -- problems rather than whichever rows Postgres grouped first. A signed
       -- sort would fill it with the largest positive drift and hide an equally
       -- large negative one, which is the direction that means money is missing.
       ORDER BY ABS(w.balance - COALESCE(SUM(le.amount), 0)) DESC
       LIMIT ${SAMPLE_LIMIT}
    `);

    // `.rows`, not the result object: drizzle 0.45's node-postgres driver returns
    // a pg QueryResult, which is not itself iterable.
    return rows.rows.map((row) => ({
      walletId: row.id,
      walletNumber: row.wallet_number,
      userId: row.user_id,
      userPortalId: row.user_portal_id,
      userFirstName: row.user_first_name,
      userLastName: row.user_last_name,
      userEmail: row.user_email,
      currency: row.currency,
      balance: money(row.balance),
      ledgerSum: money(row.ledger_sum),
      difference: money(row.difference),
    }));
  }

  /*
   * `findUnpaidConfirmedAccruals()` was HERE and went with the commission
   * engine.
   *
   * It asked whether any confirmed accrual lacked a ledger entry crediting it —
   * a check the wallet sum cannot make, because a credit that never happened
   * leaves the wallet entirely self-consistent and merely smaller than it
   * should be.
   *
   * RESTORE IT with the engine. The bug it was written to catch is worth
   * carrying forward: the query looked for `reference_type = 'commission_accrual'`
   * while the writer wrote `'accrual'`, so every accrual read as uncredited and
   * the job reported `balanced: false` from the first one onwards. That is why
   * `LEDGER_REFERENCE` exists and why neither side may use a literal.
   */

  /**
   * How many wallets disagree, and by how much in total — as two numbers.
   *
   * A separate aggregate rather than `walletDiscrepancies.length`, because that
   * array is now a capped sample and counting it would silently report twenty.
   * Postgres does the counting and the summing, so the answer is exact and no
   * row crosses the driver: the cost is the same GROUP BY the sample query
   * already runs, without materialising thirty thousand rows to discard them.
   *
   * `SUM(ABS(...))` — the magnitude of the drift, not its net. Netting a
   * positive against a negative would report a system with two large opposite
   * errors as nearly balanced, which is the one summary that must not be
   * reassuring.
   */
  private async summariseDiscrepancies(): Promise<{ count: number; total: string }> {
    const rows = await this.db.execute<{ n: number; total: string }>(sql`
      SELECT COUNT(*)::int                        AS n,
             COALESCE(SUM(ABS(diff)), 0)::text    AS total
        FROM (
              SELECT (w.balance - COALESCE(SUM(le.amount), 0)) AS diff
                FROM ${wallets} w
                LEFT JOIN ${ledgerEntries} le ON le.wallet_id = w.id
               GROUP BY w.id, w.balance
              HAVING w.balance <> COALESCE(SUM(le.amount), 0)
             ) AS mismatched
    `);
    const row = rows.rows[0];
    return { count: row?.n ?? 0, total: money(row?.total ?? '0') };
  }

  private async countWallets(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(wallets);
    return row?.n ?? 0;
  }

  /**
   * Logs the outcome at a severity that matches what it means.
   *
   * A discrepancy is an ERROR even though nothing is broken right now: it means
   * the ledger and the balance disagree about how much money exists, and every
   * hour it stays undiagnosed is another hour of writes on top of it. This is
   * the line an alert should fire on (§12.3).
   */
  private report(report: ReconciliationReport): void {
    if (report.balanced) {
      /*
       * Says only what was actually checked.
       *
       * This line used to end "...and every confirmed accrual has been
       * credited", which was true when an accrual check ran beside the balance
       * comparison. That check moved out with the commission engine and nothing
       * verifies it here any more, so the sentence had become a claim about work
       * this job no longer does.
       *
       * It matters more than an ordinary stale comment because of WHERE it is
       * read. This is the one line in the system that tells an operator the
       * money adds up, and an operator who has read "every confirmed accrual has
       * been credited" has been told a partner's unpaid commission would have
       * shown up here. It would not. UNPAID_CONFIRMED_ACCRUAL is a separate
       * alert with a separate owner.
       */
      this.logger.log(
        `Reconciliation OK — ${report.walletsChecked} wallet(s) balance to the cent against ` +
          'their ledgers. (Wallet balances only: unpaid accruals are checked separately.)',
      );
      return;
    }

    /*
     * ONE alert for the whole run, never one per wallet.
     *
     * This used to raise a `page`-severity alert and log a full diagnostic for
     * every mismatched wallet. That is correct at three discrepancies and it is
     * what took the server down at thirty thousand: sixty thousand synchronous
     * writes to a blocking stdout in a single tick, once an hour.
     *
     * It was also the wrong signal even when it survived. Thirty thousand
     * identical pages are one fact repeated until it buries every other line in
     * the log — including whichever alert somebody actually needed. The count
     * and the total say the same thing in one line and are the two numbers that
     * decide what to do next.
     */
    raiseAlert(
      this.logger,
      ALERT_KINDS.RECONCILIATION_MISMATCH,
      'page',
      `${report.discrepancyCount} wallet(s) disagree with their ledgers, ` +
        `totalling ${report.totalDifference} across all currencies`,
      {
        discrepancyCount: report.discrepancyCount,
        totalDifference: report.totalDifference,
        walletsChecked: report.walletsChecked,
      },
    );

    /*
     * The sample, at ONE line each and capped — enough to characterise the
     * problem without reproducing it in the log. `warn`, not `error`: the
     * `page` alert above is the thing that should wake somebody, and repeating
     * the severity twenty times would make the alert harder to find, not easier.
     */
    for (const d of report.walletDiscrepancies) {
      this.logger.warn(
        `  wallet ${d.walletId} (user ${d.userId}, ${d.currency}): balance ${d.balance} ` +
          `vs ledger ${d.ledgerSum} — difference ${d.difference}`,
      );
    }

    const shown = report.walletDiscrepancies.length;
    this.logger.error(
      `Reconciliation FAILED: ${report.discrepancyCount} wallet discrepancy(ies) totalling ` +
        `${report.totalDifference}` +
        (report.discrepancyCount > shown
          ? `. The ${shown} largest are listed above; query wallets against ledger_entries for the full set.`
          : '.') +
        ' The ledger is the truth (§6.2). Do NOT edit the balances: diagnose the cause, then ' +
        'correct with compensating entries (§6.4).',
    );
  }

  /** Single-wallet check, kept for the §11 test and for investigating one account. */
  async reconcileWallet(walletId: string) {
    const [wallet] = await this.db.select().from(wallets).where(eq(wallets.id, walletId)).limit(1);
    const [{ total }] = await this.db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, walletId));

    const balance = money(wallet.balance);
    const ledgerSum = money(total);
    return { walletId, balance, ledgerSum, balanced: balance === ledgerSum };
  }
}
