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
}

/**
 * Injection token.
 *
 * A `Symbol` rather than the interface name: an interface is erased at compile
 * time and cannot be a Nest token, and a string token would collide silently
 * with any other module that picked the same words.
 */
export const COMMISSION_ACCRUAL = Symbol('COMMISSION_ACCRUAL');
