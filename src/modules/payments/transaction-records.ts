import { and, eq } from 'drizzle-orm';
import { paymentProviders, transactions } from '../../database/schema';
import { LEDGER_REFERENCE } from '../../database/ledger-reference';
import { toDecimal } from '../wallet/money';
import { Executor, WalletService } from '../wallet/wallet.service';
import type { Db } from '../../database/db';
import { NotFoundError } from '../../common/errors/domain-errors';

/**
 * `transactions.provider` for money an ADMIN placed by hand.
 *
 * A named constant because three places have to agree on the exact string: the
 * admin service that writes it, and both frontends, which show "Manual credit"
 * instead of a payment-method name when they see it. A literal repeated in
 * three repos is a typo away from a transaction that renders as an unknown
 * source on the client's own statement.
 *
 * It carries the `manual_` prefix every non-gateway row uses, so a
 * reconciliation that groups on the prefix keeps working, and `_admin` where a
 * method key would be — there is no method.
 */
export const MANUAL_ADMIN_PROVIDER = 'manual_admin';

export type { WithinTransaction } from './core/payments-ledger.port';

/**
 * The row-level operations every transaction command shares: the lookup, the
 * §8.7 conditional transition, the compensating refund and the environment
 * stamp. Deposits and withdrawals both build on these, so they live once.
 */
export class TransactionRecords {
  constructor(
    private readonly db: Db,
    private readonly wallets: WalletService,
  ) {}

  /**
   * The environment a provider runs in right now — recorded on every new
   * transaction (0168), so a sandbox payment can never pass for real money in
   * an export or a reconciliation. A provider with no row reads as `live`.
   */
  async environmentOf(providerCode: string, executor: Executor = this.db) {
    const [row] = await executor
      .select({ environment: paymentProviders.environment })
      .from(paymentProviders)
      .where(eq(paymentProviders.code, providerCode))
      .limit(1);
    return row?.environment ?? 'live';
  }

  async getById(id: string) {
    const [tx] = await this.db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
    if (!tx) throw new NotFoundError('Transaction not found.');
    return tx;
  }

  /**
   * A person reconciled a payment only a person could — clear its attention
   * flag, in one transaction with whatever the caller records beside it.
   *
   * CONDITIONAL on the flag, so a double click or two operators racing resolve
   * it once and the loser learns it was already done. Clearing the flag is what
   * ends the matching admin tasks for everyone — the `transactions` trigger
   * (migration 0140) — so this is the finish line an anomaly never had: no
   * event path ever cleared it for a deposit.
   */
  async resolveAttention(id: string, withinTx: (tx: Executor) => Promise<void>): Promise<boolean> {
    return this.db.transaction(async (dbTx) => {
      const [cleared] = await dbTx
        .update(transactions)
        .set({ needsAttention: false, attentionReason: null })
        .where(and(eq(transactions.id, id), eq(transactions.needsAttention, true)))
        .returning({ id: transactions.id });
      if (!cleared) return false;
      await withinTx(dbTx);
      return true;
    });
  }

  /**
   * Every state transition that moves money uses the §8.7 conditional update:
   * UPDATE ... WHERE id = ? AND state = <expected>, then check the rowcount.
   * A zero rowcount means someone else already transitioned it — abort rather
   * than act twice. This is what stops a double-clicked button paying twice.
   */
  async transition(id: string, from: string, patch: Record<string, unknown>, executor?: Executor) {
    const [row] = await (executor ?? this.db)
      .update(transactions)
      .set(patch)
      .where(and(eq(transactions.id, id), eq(transactions.state, from as 'pending')))
      .returning();
    return row;
  }

  /**
   * Give back the money a refused withdrawal debited on request.
   *
   * ## A COMPENSATING ENTRY, never an edit — §6.4
   *
   * "No UPDATE, no DELETE on ledger_entries. If a balance is wrong, write a new
   * offsetting row." The original debit stays exactly as it was posted, and
   * this credit sits beside it; the pair reads as what actually happened rather
   * than as a withdrawal that was quietly unwritten.
   *
   * ## The `:refund` suffix is load-bearing
   *
   * `ledger_entries_wallet_reference_uq` is on (wallet, reference_type,
   * reference_id). Without the suffix this credit carries the SAME reference as
   * the debit it reverses, so the unique index absorbs it as a replay, ON
   * CONFLICT returns the original debit, and the client is silently never
   * refunded — with `post()` reporting success.
   *
   * With the suffix it is idempotent in its own right: rejecting twice cannot
   * refund twice, which matters because `transition` already refuses the second
   * attempt but a retry that raced it would otherwise get through.
   */
  async refund(row: typeof transactions.$inferSelect, executor: Executor): Promise<void> {
    await this.wallets.post(
      {
        userId: row.userId,
        currency: row.currency,
        amount: toDecimal(row.amount),
        // `adjustment`, not `deposit`: no money entered the platform. A report
        // summing deposits would otherwise count every refused withdrawal as
        // one.
        entryType: 'adjustment',
        referenceType: LEDGER_REFERENCE.transaction,
        referenceId: `${row.id}:refund`,
      },
      executor,
    );
  }
}
