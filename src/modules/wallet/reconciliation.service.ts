import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
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
  /** Transfers ↔ MT5 deals over the last week (a sample; the count is exact). */
  transferMismatches: TransferMt5Mismatch[];
  transferMismatchCount: number;
  /**
   * Deposits the client aimed at a trading account that settled into the wallet but never moved
   * on (audit R1-4): the money waits in the wallet while the client looks for it on MT5.
   */
  strandedDeposits: StrandedDeposit[];
  strandedDepositCount: number;
  balanced: boolean;
}

/**
 * A transfer and MT5 disagree (audit R3-1, 16 Oct 2026): a settled transfer with no MT5 deal, or
 * an MT5 deal the CRM tagged `CRM transfer <id>` whose transfer is not settled — the second is
 * money the client holds twice (or lost).
 */
export interface TransferMt5Mismatch {
  kind: 'settled_without_deal' | 'deal_without_settled_transfer';
  transferId: string | null;
  transferState: string | null;
  dealId: string | null;
  login: string | null;
  /** Signed, as MT5 holds it: + into the account, − out of it. */
  amount: string;
  at: string;
}

/** A deposit aimed at a trading account whose money never left the wallet (audit R1-4). */
export interface StrandedDeposit {
  transactionId: string;
  userId: number;
  login: string | null;
  amount: string;
  currency: string;
  settledAt: string;
}

/** How far back the transfer ↔ MT5 check looks, and how long a deal may take to arrive. */
const TRANSFER_WINDOW = sql`interval '7 days'`;
const DEAL_GRACE = sql`interval '15 minutes'`;

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

  /** The last check this instance completed: the scheduled job's, or one asked for. */
  private last?: ReconciliationReport;
  /** The check in flight, if any: a second caller waits for it instead of starting another. */
  private running?: Promise<ReconciliationReport>;

  /**
   * The last completed check, for the screen.
   *
   * A check reads EVERY ledger entry, so it costs the size of the ledger: 2.5 s
   * at 3M entries, and it grows without bound. Run on every page view, the
   * screen got slower every day and would one day not answer at all. The job
   * already runs the check every hour; the screen shows that result, with the
   * time it was made, and runs a fresh one only when somebody asks (`run`).
   *
   * Kept in memory, so an instance that has not checked yet (just started) runs
   * one. Who owns each wallet is read again on every call: a report is about
   * money, and the names beside it must be today's.
   */
  async latest(): Promise<ReconciliationReport> {
    if (!this.last) return this.run();
    return {
      ...this.last,
      walletDiscrepancies: await this.withOwners(this.last.walletDiscrepancies),
    };
  }

  /** Check now. Concurrent callers share one check. */
  run(): Promise<ReconciliationReport> {
    this.running ??= this.check().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** The owners as they are now — never the names a check happened to read an hour ago. */
  private async withOwners(discrepancies: WalletDiscrepancy[]): Promise<WalletDiscrepancy[]> {
    if (discrepancies.length === 0) return discrepancies;
    const owners = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(users)
      .where(inArray(users.id, [...new Set(discrepancies.map((d) => d.userId))]));
    const byId = new Map(owners.map((owner) => [owner.id, owner]));
    return discrepancies.map((d) => {
      const owner = byId.get(d.userId);
      return {
        ...d,
        userPortalId: owner?.id ?? null,
        userFirstName: owner?.firstName ?? null,
        userLastName: owner?.lastName ?? null,
        userEmail: owner?.email ?? null,
      };
    });
  }

  private async check(): Promise<ReconciliationReport> {
    const [summary, walletDiscrepancies, walletsChecked, transferMismatches, strandedDeposits] =
      await Promise.all([
        this.summariseDiscrepancies(),
        this.findWalletDiscrepancies(),
        this.countWallets(),
        this.findTransferMismatches(),
        this.findStrandedDeposits(),
      ]);

    const report: ReconciliationReport = {
      checkedAt: new Date().toISOString(),
      walletsChecked,
      walletDiscrepancies,
      discrepancyCount: summary.count,
      totalDifference: summary.total,
      transferMismatches: transferMismatches.slice(0, SAMPLE_LIMIT),
      transferMismatchCount: transferMismatches.length,
      strandedDeposits: strandedDeposits.slice(0, SAMPLE_LIMIT),
      strandedDepositCount: strandedDeposits.length,
      /*
       * Decided by the COUNT, never by the sample's length. The sample is
       * capped, so `walletDiscrepancies.length === 0` would read as balanced
       * only by coincidence — and on a database with more than `SAMPLE_LIMIT`
       * mismatches it would be right for the wrong reason, which is the kind of
       * agreement that stops being true later.
       */
      balanced:
        summary.count === 0 && transferMismatches.length === 0 && strandedDeposits.length === 0,
    };

    this.last = report;
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
  /**
   * Every transfer of the last week against MT5's own record of it. The executor tags each deal
   * `CRM transfer <id>`, which MT5 cuts to 31 characters (the id's first 18), so a deal is matched
   * by that prefix, the account's login and the signed amount. Deals still arriving (the bridge's
   * push, or its 5-minute sweep) get a grace period.
   */
  private async findTransferMismatches(): Promise<TransferMt5Mismatch[]> {
    const { rows } = await this.db.execute<{
      kind: TransferMt5Mismatch['kind'];
      transfer_id: string | null;
      transfer_state: string | null;
      deal_id: string | null;
      login: string | null;
      amount: string;
      at: string;
    }>(sql`
      WITH recent AS (
        SELECT t.id, t.state, ta.login, t.settled_at, t.created_at,
               CASE WHEN t.direction = 'wallet_to_account' THEN t.amount ELSE -t.amount END AS signed,
               'CRM transfer ' || left(t.id::text, 18) AS tag
          FROM transfers t
          JOIN trading_accounts ta ON ta.id = t.trading_account_id
         WHERE t.created_at > now() - ${TRANSFER_WINDOW} - interval '1 day'
      ),
      deals AS (
        SELECT d.mt5_deal_id, d.login, d.profit, d.comment, d.dealt_at
          FROM mt5_deals d
         WHERE d.comment LIKE 'CRM transfer %'
           AND d.dealt_at > now() - ${TRANSFER_WINDOW}
           AND d.dealt_at < now() - ${DEAL_GRACE}
      )
      SELECT 'settled_without_deal' AS kind, r.id::text AS transfer_id, r.state::text AS transfer_state,
             NULL::text AS deal_id, r.login, r.signed::text AS amount, r.settled_at::text AS at
        FROM recent r
       WHERE r.state = 'settled'
         AND r.settled_at > now() - ${TRANSFER_WINDOW}
         AND r.settled_at < now() - ${DEAL_GRACE}
         AND NOT EXISTS (SELECT 1 FROM mt5_deals d
                          WHERE d.comment = r.tag AND d.login = r.login AND d.profit = r.signed)
      UNION ALL
      SELECT 'deal_without_settled_transfer', r.id::text, r.state::text, d.mt5_deal_id, d.login,
             d.profit::text, d.dealt_at::text
        FROM deals d
        LEFT JOIN recent r ON r.tag = d.comment AND r.login = d.login AND r.signed = d.profit
       WHERE r.id IS NULL OR r.state <> 'settled'
       ORDER BY at DESC`);
    return rows.map((row) => ({
      kind: row.kind,
      transferId: row.transfer_id,
      transferState: row.transfer_state,
      dealId: row.deal_id,
      login: row.login,
      amount: money(row.amount),
      at: row.at,
    }));
  }

  /** Settled deposits aimed at an account, a quarter-hour old, that no transfer took on. */
  private async findStrandedDeposits(): Promise<StrandedDeposit[]> {
    const { rows } = await this.db.execute<{
      id: string;
      user_id: number;
      login: string | null;
      amount: string;
      currency: string;
      settled_at: string;
    }>(sql`
      SELECT t.id::text, t.user_id, ta.login, t.amount::text, t.currency, t.settled_at::text
        FROM transactions t
        LEFT JOIN trading_accounts ta ON ta.id = t.destination_trading_account_id
       WHERE t.direction = 'deposit'
         AND t.state = 'success'
         AND t.destination_trading_account_id IS NOT NULL
         AND t.settled_at > now() - interval '30 days'
         AND t.settled_at < now() - ${DEAL_GRACE}
         AND NOT EXISTS (SELECT 1 FROM transfers tr WHERE tr.source_transaction_id = t.id)
       ORDER BY t.settled_at DESC`);
    return rows.map((row) => ({
      transactionId: row.id,
      userId: row.user_id,
      login: row.login,
      amount: money(row.amount),
      currency: row.currency,
      settledAt: row.settled_at,
    }));
  }

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
    if (report.strandedDepositCount > 0) {
      raiseAlert(
        this.logger,
        ALERT_KINDS.RECONCILIATION_MISMATCH,
        'page',
        `${report.strandedDepositCount} deposit(s) aimed at a trading account never moved on from the wallet`,
        { strandedDepositCount: report.strandedDepositCount },
      );
    }
    if (report.transferMismatchCount > 0) {
      raiseAlert(
        this.logger,
        ALERT_KINDS.RECONCILIATION_MISMATCH,
        'page',
        `${report.transferMismatchCount} transfer(s) disagree with MT5 over the last week`,
        { transferMismatchCount: report.transferMismatchCount },
      );
      for (const m of report.transferMismatches) {
        this.logger.warn(
          `  ${m.kind}: transfer ${m.transferId ?? '-'} (${m.transferState ?? '-'}) deal ${m.dealId ?? '-'} login ${m.login ?? '-'} amount ${m.amount}`,
        );
      }
    }
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

    // Only the transfers disagreed: their alert above is the whole story.
    if (report.discrepancyCount === 0) return;

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
