/**
 * "This deposit settled — accrue whatever partners are owed for it."
 *
 * ## Why a port rather than an import
 *
 * Exactly the reasoning `wallet-provisioning.port.ts` records, one module over.
 *
 * `TransactionsService` (payments) is where a deposit credits a wallet, and it
 * is the only honest place to notice that revenue happened. `CommissionService`
 * lives in `IbModule`. Having payments import `IbModule` would create
 * payments → ib, while ib already needs the wallet/payments side to pay
 * commissions out — a cycle, resolvable only with `forwardRef`, which
 * `wallet.module.ts` explicitly rejected: "a cycle is cheap to add and
 * expensive to notice".
 *
 * Providing `CommissionService` from the @Global `StoreModule` is worse and
 * fails the layering lint rule for good reason: `store/`, `common/`, `config/`
 * and `database/` are depended UPON and never the reverse. That rule's message
 * names the fix — "invert with an interface" — which is this file.
 *
 * So payments depends on this DECLARATION in `common/`, and `IbModule` binds
 * the implementation. The edge runs module → common, like every other shared
 * piece.
 */
/**
 * The accrual was REFUSED — something WAS owed, and the amount did not survive
 * the §12.4 plausibility check.
 *
 * ## Its own class, because the two failure modes need different humans
 *
 * A caller must not mark the event done on either. But a database failure is
 * transient and fixes itself on the next run, while this one will fail
 * identically forever until somebody changes a setting — overwhelmingly a rate
 * configured in the wrong unit. A queue that logs them the same way sends an
 * engineer to look at the database while the actual fix is one field on the
 * levels screen.
 *
 * Declared HERE rather than beside `CommissionService` so the queue in
 * `TradingModule` can catch it without importing `IbModule` — which is the
 * whole reason this file exists. See the note at the top.
 */
export class CommissionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommissionRefusedError';
  }
}

export interface CommissionAccrualPort {
  /**
   * Accrue partner commissions for one settled deposit. Returns rows CREATED.
   *
   * ## Idempotent, and NEVER throws
   *
   * Both halves are load-bearing, and both mirror `WalletProvisioningPort`'s
   * no-throw contract for the same class of reason.
   *
   * IDEMPOTENT because this is called from a path that is itself retried: a
   * replayed provider callback must not pay a partner twice. The guarantee is
   * the `ib_accruals_source_earner_uq` constraint, never a check-then-insert.
   *
   * NEVER THROWS because a deposit that has already credited the client's
   * wallet must not be rolled back — or reported as failed — because a
   * COMMISSION could not be computed. The client's money landing is the
   * important half; a missing accrual is recoverable by re-running the
   * pipeline, and an implementation logs and returns 0 rather than propagating.
   */
  /**
   * "This trade closed — accrue whatever partners are owed for it."
   *
   * The ONLY event that pays a revenue share, because it is the only one that
   * carries revenue: `brokerRevenue` is what the house kept on the trade. A
   * deposit is the client's own money and pays nothing — see `calculate`.
   *
   * Same no-throw contract as the deposit hook below: by the time this runs the
   * position is already closed and the client's balance already settled, so a
   * commission failure must not roll that back or report the close as failed.
   */
  accrueForClosedPosition(position: {
    positionId: string;
    clientUserId: string;
    /** What the broker earned on this trade — its commission plus swap. */
    brokerRevenue: string;
    /** Lots traded, for `per_lot` levels. */
    lots: string;
    currency: string;
  }): Promise<number>;

  accrueForSettledDeposit(deposit: {
    transactionId: string;
    clientUserId: string;
    amount: string;
    currency: string;
  }): Promise<number>;

  /**
   * "This MT5 deal was ingested — accrue whatever partners are owed for it."
   *
   * The live feed's entry point, and the only one that actually fires today:
   * `positions` is written by nothing, and a deposit is not revenue.
   *
   * ## ⚠️ This one THROWS, unlike the two above
   *
   * The no-throw contract on the other two protects a user-facing write that
   * has already completed — a client's deposit, a closed trade — where failing
   * the caller would be strictly worse than losing the accrual.
   *
   * This hook has no such caller. It is driven by a retrying queue, and there
   * swallowing an error is the harmful choice: the queue marks the deal done,
   * and a transient database blip becomes a partner permanently unpaid for a
   * trade that really happened. So a failure propagates, the deal stays
   * unmarked, and the next run tries again.
   *
   * Returning 0 still means "nothing was owed" — an unreferred client, a chain
   * that resolves to nobody, a deal carrying no broker revenue. Those are
   * finished, not failed, and the queue is right to mark them done.
   *
   * IDEMPOTENT on the same guarantee as the others: one accrual per earner per
   * `mt5_deals` row, held by `ib_accruals_source_earner_uq`. Every deal is
   * delivered at least twice by design, so this is exercised constantly.
   */
  accrueForDeal(deal: {
    /** `mt5_deals.id` — the row, not MT5's ticket. */
    dealRowId: string;
    /** MT5's ticket, for logging. */
    ticket: string;
    clientUserId: string;
    /** What the broker earned on this deal — its commission plus swap. */
    brokerRevenue: string;
    /** Lots, for `per_lot` levels. */
    lots: string;
    currency: string;
  }): Promise<number>;
}

/**
 * Injection token.
 *
 * A `Symbol` rather than the interface name: an interface is erased at compile
 * time and cannot be a Nest token, and a string token would collide silently
 * with any other module that picked the same words.
 */
export const COMMISSION_ACCRUAL = Symbol('COMMISSION_ACCRUAL');
