import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { commissionAccruals, ledgerEntries, wallets } from '../../database/schema';
import { LEDGER_REFERENCE } from '../../database/ledger-reference';
import { money } from './money';
import { ALERT_KINDS, raiseAlert } from '../../common/logging/alerts';

export interface WalletDiscrepancy {
  walletId: string;
  userId: string;
  currency: string;
  balance: string;
  ledgerSum: string;
  /** balance − ledgerSum. Signed, so the direction of the error is visible. */
  difference: string;
}

export interface ReconciliationReport {
  checkedAt: string;
  walletsChecked: number;
  walletDiscrepancies: WalletDiscrepancy[];
  /** Confirmed accruals with no corresponding ledger entry — commission owed but never credited. */
  unpaidConfirmedAccruals: { accrualId: string; ibUserId: string; amount: string }[];
  balanced: boolean;
}

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
    const [walletDiscrepancies, unpaidConfirmedAccruals, walletsChecked] = await Promise.all([
      this.findWalletDiscrepancies(),
      this.findUnpaidConfirmedAccruals(),
      this.countWallets(),
    ]);

    const report: ReconciliationReport = {
      checkedAt: new Date().toISOString(),
      walletsChecked,
      walletDiscrepancies,
      unpaidConfirmedAccruals,
      balanced: walletDiscrepancies.length === 0 && unpaidConfirmedAccruals.length === 0,
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
      user_id: string;
      currency: string;
      balance: string;
      ledger_sum: string;
      difference: string;
    }>(sql`
      SELECT w.id,
             w.user_id,
             w.currency,
             w.balance::text                                   AS balance,
             COALESCE(SUM(le.amount), 0)::text                 AS ledger_sum,
             (w.balance - COALESCE(SUM(le.amount), 0))::text   AS difference
        FROM ${wallets} w
        LEFT JOIN ${ledgerEntries} le ON le.wallet_id = w.id
       GROUP BY w.id, w.user_id, w.currency, w.balance
      HAVING w.balance <> COALESCE(SUM(le.amount), 0)
    `);

    // `.rows`, not the result object: drizzle 0.45's node-postgres driver returns
    // a pg QueryResult, which is not itself iterable.
    return rows.rows.map((row) => ({
      walletId: row.id,
      userId: row.user_id,
      currency: row.currency,
      balance: money(row.balance),
      ledgerSum: money(row.ledger_sum),
      difference: money(row.difference),
    }));
  }

  /**
   * Confirmed accruals with no ledger entry naming them.
   *
   * The confirm step writes the ledger entry with
   * `reference_type = LEDGER_REFERENCE.accrual` and `reference_id = accrual.id`,
   * so the absence of that row means the promotion committed the status change
   * and not the credit. The wallet check cannot see this: a credit that never
   * happened leaves the wallet entirely self-consistent, just smaller than it
   * should be.
   *
   * The type comes from the shared constant, never a literal. This query used
   * to look for `'commission_accrual'` while the writer wrote `'accrual'`, so
   * every confirmed accrual read as uncredited and the job reported
   * `balanced: false` on every run from the first accrual onwards.
   */
  private async findUnpaidConfirmedAccruals(): Promise<
    { accrualId: string; ibUserId: string; amount: string }[]
  > {
    const rows = await this.db.execute<{ id: string; ib_user_id: string; amount: string }>(sql`
      SELECT ca.id, ca.ib_user_id, ca.amount::text AS amount
        FROM ${commissionAccruals} ca
       WHERE ca.status = 'confirmed'
         AND NOT EXISTS (
           SELECT 1 FROM ${ledgerEntries} le
            WHERE le.reference_type = ${LEDGER_REFERENCE.accrual}
              AND le.reference_id = ca.id::text
         )
    `);

    return rows.rows.map((row) => ({
      accrualId: row.id,
      ibUserId: row.ib_user_id,
      amount: money(row.amount),
    }));
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
      this.logger.log(
        `Reconciliation OK — ${report.walletsChecked} wallet(s) balance to the cent against ` +
          'their ledgers, and every confirmed accrual has been credited.',
      );
      return;
    }

    for (const d of report.walletDiscrepancies) {
      raiseAlert(
        this.logger,
        ALERT_KINDS.RECONCILIATION_MISMATCH,
        'page',
        `Wallet ${d.walletId} balance disagrees with its ledger by ${d.difference}`,
        { walletId: d.walletId, currency: d.currency, difference: d.difference },
      );
      this.logger.error(
        `RECONCILIATION MISMATCH wallet ${d.walletId} (user ${d.userId}, ${d.currency}): ` +
          `balance ${d.balance} but ledger sums to ${d.ledgerSum} — difference ${d.difference}. ` +
          'The ledger is the truth (§6.2). Do NOT edit the balance: diagnose the cause, then ' +
          'correct with a compensating entry (§6.4).',
      );
    }

    for (const a of report.unpaidConfirmedAccruals) {
      raiseAlert(
        this.logger,
        ALERT_KINDS.UNPAID_CONFIRMED_ACCRUAL,
        'page',
        `Accrual ${a.accrualId} is confirmed but never credited`,
        { accrualId: a.accrualId, amount: a.amount },
      );
      this.logger.error(
        `RECONCILIATION MISMATCH accrual ${a.accrualId}: confirmed for IB ${a.ibUserId} at ` +
          `${a.amount} but no ledger entry credits it. This is commission earned and not paid.`,
      );
    }

    this.logger.error(
      `Reconciliation FAILED: ${report.walletDiscrepancies.length} wallet discrepancy(ies), ` +
        `${report.unpaidConfirmedAccruals.length} unpaid confirmed accrual(s).`,
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
