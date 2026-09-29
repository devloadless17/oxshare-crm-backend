import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import {
  ibAccruals,
  ibCommissionTypes,
  mt5Deals,
  tradingAccounts,
  tradingProducts,
} from '../../../database/schema';
import { LEDGER_REFERENCE } from '../../../database/ledger-reference';
import { ALERT_KINDS, raiseAlert } from '../../../common/logging/alerts';
import { accrualBeneficiary } from '../../../common/accrual-beneficiary';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../../common/provisioning/notification-dispatch.port';
import {
  COMMISSION_ACCRUAL,
  CommissionRefusedError,
  type CommissionAccrualPort,
  type ProductCommissionTerms,
} from '../../../common/provisioning/commission-accrual.port';
import {
  CLOSING_ENTRIES,
  TRADE_ACTIONS,
  dealActionLabel,
  isCancelledAction,
  isClosingEntry,
  isTradeAction,
} from './deal-codes';

/**
 * The longest a failed deal waits before it is tried again.
 *
 * An hour, because the two failures this backs off have opposite shapes and the
 * cap is set for the worse one. A transient failure is fixed by the next run
 * and never reaches the cap; a REFUSAL is a settings mistake that fails
 * identically until a human edits a rate, so its retries are pure cost — and an
 * hour is short enough that the fix takes effect while the operator is still at
 * the screen, and long enough that a thousand stuck deals cannot crowd out the
 * payable ones.
 */
const RETRY_CAP_MINUTES = 60;

/**
 * The exponent is clamped before it is raised, not after.
 *
 * `power(2, attempts)` on a deal that has failed daily for two months is a
 * number no integer holds, and the cast that follows it raises rather than
 * saturating — which would turn a stuck deal into a FAILING one, on the single
 * write whose job is to stop a stuck deal from causing damage.
 */
const RETRY_EXPONENT_CEILING = 20;

/**
 * How old an unprocessed deal has to be before it counts as BACKLOG rather than
 * ordinary queue.
 *
 * Two days, because the sweep runs 24 hours behind the push feed and a deal
 * legitimately arriving late must not look like history. Anything older than
 * this predates the decision to switch the engine on, and paying for it is a
 * commercial choice rather than a consequence of deployment.
 */
const BACKLOG_AGE_MS = 48 * 60 * 60 * 1000;

/** What the backlog decision says, resolved once per run. */
type AccrualWindow =
  /** Pay for everything, deliberately. */
  | { mode: 'all' }
  /** Pay from this instant on; older deals are decided and accrue nothing. */
  | { mode: 'from'; at: Date }
  /** Nobody has chosen. Refuse an aged backlog rather than pay it. */
  | { mode: 'unset' };

/**
 * Interpret the backlog decision. PURE — the caller supplies the raw value.
 *
 * The SETTING wins and the environment is the fallback, exactly as `holdHours`
 * resolves the settlement window: `trading_settings.ib_accrual_start` is the
 * answer once a row exists, and `IB_ACCRUAL_START` answers only when none does.
 *
 * ## Why this stopped being environment-only
 *
 * It is a COMMERCIAL decision — how much history to pay partners for — and it
 * lived where only a deploy could reach it, invisible to everybody running the
 * platform. That is the same objection `ibCommissionHoldHours` was moved for.
 *
 * The stronger one is the audit. This decision is IRREVERSIBLE: money paid for
 * a trade nobody meant to pay for comes back by conversation, not by redeploy.
 * An environment variable records no actor, no timestamp and no reason; a
 * settings write records all three. Friction is not a substitute for
 * accountability.
 */
export function accrualWindow(raw: string | null | undefined): AccrualWindow {
  /*
   * EXPLICIT, with no default reading `process.env`.
   *
   * It used to default to the environment variable, and that made the fallback
   * unavoidable: a caller resolving "the operator saved UNDECIDED" has nothing
   * to pass but `undefined`, which re-triggered the default and handed the
   * decision straight back to the variable it had just overridden. The caller
   * decides where the value comes from; this only interprets it.
   */
  if (raw === undefined || raw === null || raw.trim() === '') return { mode: 'unset' };
  if (raw.trim() === 'all') return { mode: 'all' };

  const at = new Date(raw.trim());
  /*
   * A value that survived validation but does not parse here would silently
   * become "pay nothing, forever". Treated as UNSET so the engine refuses and
   * says so, rather than quietly deciding every deal is out of scope.
   */
  return Number.isNaN(at.getTime()) ? { mode: 'unset' } : { mode: 'from', at };
}

/** What one drain of the queue did. Every deal lands in exactly one bucket. */
export interface DealAccrualRun {
  /** Rows the query returned — the size of the batch, not of the backlog. */
  examined: number;
  /** Deals that produced at least one accrual row. */
  accrued: number;
  /** `ib_accruals` rows created across the batch. */
  accrualRows: number;
  /** Deals correctly worth nothing: not a trade, no revenue, nobody referred. */
  nothingOwed: number;
  /**
   * Closing deals declined because the account trades PRACTICE money.
   *
   * Marked done rather than left queued — a demo trade is worth nothing now and
   * always will be, so leaving it NULL would re-examine it forever.
   *
   * Its own tally rather than part of `nothingOwed`: this number climbing while
   * live accruals stay flat is how a bridge mislabelling live accounts as demo
   * becomes visible, and folding it into "owed nobody" would hide exactly that.
   */
  demo: number;
  /**
   * Open legs CONSUMED by the closes in this batch.
   *
   * Not "deals waiting on their close" — those are filtered out in SQL and the
   * loop never sees one. This counts the opening rows whose revenue was folded
   * into a close and marked done alongside it, which is the number that says
   * whether the entry charge is actually reaching partners.
   */
  legsConsumed: number;
  /**
   * Deals waiting on an account link — the whole BACKLOG, not this batch.
   *
   * A backlog rather than a batch count because these are no longer queued at
   * all: they are held out in SQL, so a batch never contains one and a count of
   * "orphans seen this run" would be permanently zero. The number an operator
   * needs is how many are waiting, which is a question about the table.
   */
  orphaned: number;
  /**
   * Deals held back by a retry delay right now — again the whole backlog.
   *
   * A processing backlog drains itself and a rising DEFERRED backlog does not:
   * every one of these is a deal the engine tried and could not accrue, and a
   * refusal fails identically until somebody changes a setting.
   */
  deferred: number;
  /** Deals the engine refused or could not process IN THIS BATCH. */
  failed: number;
  /**
   * Deals decided as out of scope because they predate `IB_ACCRUAL_START`.
   *
   * Marked done rather than left queued: the operator has said these are not
   * owed, and a deal left NULL would be re-examined on every run forever while
   * inflating a backlog nobody intends to pay.
   */
  predating: number;
  /**
   * True when the run did NOTHING because nobody has chosen what to do with an
   * aged backlog.
   *
   * Not an error and not a failure — a refusal. It appears exactly once per
   * deployment, before any commission has ever been paid.
   */
  awaitingBacklogDecision: boolean;
}

/**
 * Turns ingested MT5 deals into commission accruals — the seam ARCHITECTURE
 * §3.1 assumed and nothing implemented.
 *
 * ## What this closes
 *
 * `Mt5DealsService` stored deals and stopped. `CommissionService` accrued on
 * `PositionsService.close`, which no controller and no service ever called. So
 * `mt5_deals` had exactly one writer and no readers, `positions` had no writer
 * at all, and the hourly confirm job ran against a table nothing filled. Every
 * stage reported success — the webhook answered 200, ingestion logged the
 * ticket, the confirm job logged "0 credited" — and no partner could have
 * earned anything, on any trade, by any route. This is the missing link, and it
 * is the only path in the system that currently produces revenue-based pay.
 *
 * ## A drained QUEUE, not a hook on ingestion
 *
 * Accruing inside `Mt5DealsService.ingest` would put ladder resolution and
 * several writes inside the request the bridge is waiting on, and the bridge
 * retries anything that is not a 2xx — so a slow commission path would turn
 * into re-delivered deals, which is load added exactly when the system is
 * already struggling.
 *
 * More decisively, it could not be correct. A deal for a login the CRM has not
 * linked yet accrues NOTHING at ingest time and must be reconsidered later;
 * that ordering is normal during onboarding. A hook would have to drop it. A
 * queue simply leaves `commission_processed_at` NULL and finds it again once
 * the account exists — which is the promise `Mt5DealsService`'s docblock has
 * been making all along.
 *
 * ## Every deal, not just closing ones
 *
 * The broker charges commission when a position OPENS as well as when it
 * closes. Accruing only on closing deals silently pays every partner less than
 * they earned, by the entry half of every round turn — and nothing in the
 * system would report a discrepancy, because both halves look like successful
 * runs. So each deal is assessed on its own revenue and the round turn adds up
 * on its own.
 *
 * Non-trade deals — balance operations, credits, corrections — carry no
 * commission or swap of their own and are marked done without accruing. They
 * are excluded by `isTradeAction` rather than by their zero amounts, because
 * "this is not a trade" and "this trade earned nothing" are different facts and
 * only the first is safe to assume from an action code.
 *
 * ## ⚠️ A dealer-CANCELLED trade is not clawed back, and that is deliberate
 *
 * `isTradeAction` excludes DEAL_BUY_CANCELED and DEAL_SELL_CANCELED, so a
 * cancellation accrues nothing — but it does not reverse an accrual already
 * written against the deal it cancels. If the accrual is still `pending` the
 * money has not moved and a desk can void it; once `confirmPending` has
 * credited it, undoing it needs a compensating entry.
 *
 * Not automated here, on the reasoning `ib_accruals` already records: "a
 * clawback is a REVERSAL of the row, not a negative accrual", and the table's
 * own `amount > 0` check enforces that. A reversal moves money out of a
 * partner's wallet, which is a decision with a person behind it — not something
 * a feed should do because a code arrived. Worth building deliberately if
 * cancellations turn out to be common on this broker's server.
 */
@Injectable()
export class DealCommissionService {
  private readonly logger = new Logger(DealCommissionService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    /*
     * The port, not `CommissionService` — `IbModule` is @Global and binds it.
     * Importing IbModule here would create trading → ib while ib already needs
     * the wallet side to pay commissions out; see the port's own note.
     */
    @Inject(COMMISSION_ACCRUAL) private readonly commissions: CommissionAccrualPort,
    /*
     * The bell for clawback tasks — `reportClawback`. OPTIONAL for the reason
     * `AuthService` records: the specs construct this service positionally with
     * two arguments, and a clawback task is the one thing here that needs it.
     * `NotificationsModule` is @Global and binds the token in the application.
     */
    @Optional()
    @Inject(NOTIFICATION_DISPATCH)
    private readonly notifications?: NotificationDispatchPort,
    /*
     * `AppSettingsStore` used to be injected here, for the backlog decision and
     * the revenue basis. Both left this form in 0104 — the first is
     * `IB_ACCRUAL_START` again, the second is a constant — so this service
     * reads no settings at all.
     */
  ) {}

  /**
   * Accrue for one batch of unprocessed deals, oldest first.
   *
   * ## Bounded, and oldest-first, for the same reason
   *
   * A backlog is drained a batch at a time so one run cannot hold a connection
   * for minutes after an outage, and in deal order so the oldest money is
   * always the next money paid. Whatever this run does not reach stays NULL and
   * is the head of the next run's batch — there is no cursor to lose.
   *
   * ## Safe to run concurrently with itself
   *
   * Two instances racing over the same deal both call an accrual guarded by
   * `ib_accruals_source_earner_uq`, so the second creates no rows and reports
   * zero. Marking a deal processed twice writes the same value twice. Neither
   * needs a lock, which is what keeps this deployable on more than one node
   * without a leader election.
   */
  async accruePending(limit = 200): Promise<DealAccrualRun> {
    /*
     * The SETTING first, the environment only when no row exists. Once an
     * operator saves the form the table is the single answer — a variable that
     * keeps overriding a saved setting is the bug this move removes.
     */
    /*
     * `IB_ACCRUAL_START` is the ONLY answer again (0104).
     *
     * It was a settings column for a while, on the reasoning that a commercial
     * decision belongs where an operator can see it. It went back to the
     * environment at the operator's request, with the rest of the IB block on
     * the Trading settings form: commission is configured on the Commission
     * Programmes page, and a second screen that also decides what partners are
     * paid is the "two catalogues" problem 0102 removed.
     *
     * ⚠️ THE GUARD IS UNCHANGED, and it is what makes this safe. An AGED
     * backlog with no value set still STOPS the run — nothing paid, nothing
     * discarded — rather than paying months of ingested history at once. See
     * `accrualWindow` and the holding branch below.
     */
    const window = accrualWindow(process.env['IB_ACCRUAL_START']);

    /*
     * ── WHAT A PARTNER IS PAID ON ──────────────────────────────────────────
     *
     * The traded PRODUCT's commission type, since 0140 — money per lot on the
     * rate card the product is sold on, split by each rung's share. What the
     * broker earned on the trade no longer enters the arithmetic at all; the
     * `revenue_basis` that chose between MT5's charges and the spread markup
     * went with the percentage-of-revenue model it qualified.
     */
    /*
     * ── NOBODY HAS SAID WHAT TO DO WITH THE BACKLOG, SO NOTHING IS PAID ────
     *
     * `mt5_deals` has been filled by ingestion since long before anything read
     * it. Draining it on the first run pays partners for every historical trade
     * at once — months of real money, from a job whose entire design is to be
     * safe to re-run. The engine is not wrong to do it; the point is that it is
     * a commercial decision and no deployment has ever been asked to make it.
     *
     * So an AGED backlog with no `IB_ACCRUAL_START` stops the run. Not the
     * whole job forever — the moment somebody sets a date, or `all`, this never
     * fires again. It can only happen before any commission has been paid,
     * which is the one moment where doing nothing costs nothing.
     *
     * Deliberately NOT defaulted to "today". A default is a decision nobody
     * made, and this one is not reversible by a code change: money paid to a
     * partner for a trade nobody meant to pay for comes back by conversation,
     * not by deploy.
     */
    if (window.mode === 'unset' && (await this.hasAgedBacklog())) {
      return {
        examined: 0,
        accrued: 0,
        accrualRows: 0,
        nothingOwed: 0,
        demo: 0,
        legsConsumed: 0,
        orphaned: await this.stuckCounts().then((c) => c.orphaned),
        deferred: 0,
        failed: 0,
        predating: 0,
        awaitingBacklogDecision: true,
      };
    }

    const batch = await this.db
      .select({
        id: mt5Deals.id,
        ticket: mt5Deals.mt5DealId,
        login: mt5Deals.login,
        action: mt5Deals.action,
        /* Which end of the position this deal is — see `isClosingEntry`. */
        entry: mt5Deals.entry,
        /* Nullable: not every deal MT5 reports carries one. */
        positionId: mt5Deals.mt5PositionId,
        volume: mt5Deals.volume,
        commission: mt5Deals.commission,
        swap: mt5Deals.swap,
        /* Needed to decide whether a deal predates `IB_ACCRUAL_START`. */
        dealtAt: mt5Deals.dealtAt,
        userId: tradingAccounts.userId,
        /*
         * The ACCOUNT's currency, because that is what MT5 denominates a deal
         * in. The deal itself carries none — the server does not repeat it on
         * every row — and defaulting to the platform currency would silently
         * accrue a EUR account's commission as USD, at par.
         */
        currency: tradingAccounts.currency,
        /*
         * PRACTICE MONEY OR REAL MONEY. The deal carries no such flag — the
         * account is the only thing that knows, which is why this is selected
         * rather than inferred from the deal.
         *
         * Nullable here only because the join above is LEFT: an unlinked login
         * has no account and therefore no environment. That case is decided
         * before this column is ever read.
         */
        environment: tradingAccounts.environment,
        /*
         * The PRODUCT the account is sold on, and the commission TYPE that
         * product pays partners on (0140). Both LEFT-joined, and the two nulls
         * mean different things: a null `productId` is an account linked to no
         * product — nothing says what its trades pay, so the trade is REFUSED
         * and retried — while a null `commissionTypeId` on a real product is a
         * product configured to pay no partner commission, which is done.
         */
        productId: tradingAccounts.productId,
        commissionTypeId: tradingProducts.commissionTypeId,
        commissionTypeName: ibCommissionTypes.name,
        commissionTypeEnabled: ibCommissionTypes.enabled,
        commissionPerLot: ibCommissionTypes.commissionPerLot,
        rebatePerLot: ibCommissionTypes.rebatePerLot,
      })
      .from(mt5Deals)
      /*
       * LEFT rather than INNER even though an orphaned TRADE is now excluded
       * below, because the exclusion is narrower than the join would be.
       *
       * A non-trade deal on an unlinked login — a dealer moving a balance on an
       * account the CRM has not claimed yet — still has to be RETURNED and
       * marked done. An inner join would hold it back on a rule written about
       * deals that could pay somebody, and strand it in exactly the way that
       * rule exists to prevent. The orphan filter says which of the two this
       * is; the join must not decide it first.
       */
      .leftJoin(tradingAccounts, eq(tradingAccounts.login, mt5Deals.login))
      /*
       * LEFT for the same reason as the join above it, one step further out: an
       * account with no product must still be RETURNED so the loop can decide
       * what that costs — a refusal that defers the deal on the existing
       * backoff, because nothing says what the trade pays. An inner join would
       * silently strand every such deal instead, which is the failure the
       * orphan note above describes and the one this module works hardest to
       * avoid. The type is one hop further, LEFT for the same reason.
       */
      .leftJoin(tradingProducts, eq(tradingProducts.id, tradingAccounts.productId))
      .leftJoin(ibCommissionTypes, eq(ibCommissionTypes.id, tradingProducts.commissionTypeId))
      /*
       * ── OPEN LEGS ARE EXCLUDED HERE, NOT SKIPPED IN THE LOOP ──────────────
       *
       * They must stay UNPROCESSED — their revenue is paid by the close that
       * consumes them — but skipping them inside the loop left them at the
       * FRONT of an oldest-first queue for as long as their position ran.
       *
       * That starves the whole job. A broker holding `limit` positions open at
       * once fills every batch with legs that can never be completed here, and
       * no closing deal is ever reached again: commission stops for everybody,
       * with nothing to show for it but one ordinary log line. The failure gets
       * WORSE the busier the platform is, which is the worst shape a money job
       * can have.
       *
       * Filtering in SQL means an open leg is not queued at all. It is still
       * found — `unconsumedLegs` looks it up by position id when its close
       * arrives — so nothing is lost and nothing is scanned twice.
       *
       * Non-trade deals are still fetched: a balance or credit row is DONE
       * rather than pending, and the loop below is what marks it so. Leaving
       * them out would strand them in the same way, for the same reason.
       */
      .where(
        and(
          isNull(mt5Deals.commissionProcessedAt),
          /*
           * ── A DEAL THE ENGINE REFUSED IS NOT DUE YET ────────────────────
           *
           * Third door onto the same failure. A refusal is a settings mistake,
           * so it fails IDENTICALLY on every run until a human changes a rate —
           * and an unmarked deal is at the front of an oldest-first queue. One
           * batch's worth of refusals and nothing payable is ever reached, for
           * as long as the mistake stands.
           *
           * A refused deal is still OWED, so this delays rather than abandons:
           * the backoff makes a permanently-stuck deal cost one batch an hour
           * instead of the whole queue forever, and the moment the rate is
           * fixed it pays in full with no backfill.
           */
          or(isNull(mt5Deals.commissionRetryAfter), lte(mt5Deals.commissionRetryAfter, new Date())),
          or(
            /*
             * Not a trade — a balance, credit or correction. Fetched whatever
             * its login, because the loop's whole job for one of these is to
             * mark it DONE. Holding them out on the orphan rule below would
             * strand them exactly the way it is written to prevent.
             */
            notInArray(mt5Deals.action, [...TRADE_ACTIONS]),
            and(
              inArray(mt5Deals.entry, [...CLOSING_ENTRIES]),
              /*
               * ── AN ORPHAN IS EXCLUDED HERE, NOT SKIPPED IN THE LOOP ──────
               *
               * Second door onto the failure the open-leg filter above closed.
               * A deal whose login no `trading_accounts` row claims must stay
               * unprocessed — it accrues the moment the account is linked —
               * but skipping it in the loop left it at the FRONT of the queue
               * for as long as it went unlinked, which for a manager's own
               * login or a broker-side test account is FOREVER. The scheduler's
               * own docblock concedes as much.
               *
               * Filtering in SQL means an orphan is not queued at all, and the
               * join is what puts it back: link the account and the next run
               * returns it, with no backfill and no replay. Same mechanism as
               * the open leg, which re-enters when its close arrives.
               *
               * It is still COUNTED — `stuckCounts` reports the backlog, and
               * that number is what reaches an operator.
               *
               * The CLIENT, not the row (0166): the MT5 sync records accounts
               * no client owns yet, and their trades are orphans exactly as
               * before — until the account is assigned, when they accrue.
               */
              isNotNull(tradingAccounts.userId),
            ),
          ),
        ),
      )
      .orderBy(asc(mt5Deals.dealtAt), asc(mt5Deals.id))
      .limit(limit);

    const run: DealAccrualRun = {
      examined: batch.length,
      accrued: 0,
      accrualRows: 0,
      nothingOwed: 0,
      demo: 0,
      legsConsumed: 0,
      orphaned: 0,
      deferred: 0,
      failed: 0,
      predating: 0,
      awaitingBacklogDecision: false,
    };

    for (const deal of batch) {
      /*
       * Not a trade — a deposit, a credit, a correction. Nothing was earned and
       * nothing ever will be, so this is DONE rather than skipped.
       */
      if (!isTradeAction(deal.action)) {
        /*
         * ── A CANCELLATION IS THE ONE NON-TRADE THAT OWES SOMEBODY A LOOK ───
         *
         * Everything else in this branch is a row that never earned anything.
         * A cancellation is different in kind: it says a trade that DID earn
         * something never happened. Marking it done and moving on — which is
         * all this branch used to do — leaves a partner holding money for a
         * trade the dealer struck out, and nothing anywhere says so.
         *
         * It still accrues nothing and is still marked done. What is added is
         * that somebody is TOLD. See the alert's own note on why this does not
         * reverse anything by itself.
         */
        if (isCancelledAction(deal.action)) {
          await this.reportClawback(deal);
        }
        await this.markProcessed([deal.id]);
        run.nothingOwed += 1;
        continue;
      }

      /*
       * Out of scope by the operator's own decision. DONE rather than skipped:
       * leaving it NULL would re-examine it on every run forever and keep
       * inflating a backlog nobody intends to pay.
       */
      if (window.mode === 'from' && deal.dealtAt < window.at) {
        await this.markProcessed([deal.id]);
        run.predating += 1;
        continue;
      }

      /*
       * Defensive only: the query no longer returns an orphaned TRADE, so this
       * should never fire. Kept for the same reason as the open-leg guard
       * below — the alternative on a money path is a crash the day somebody
       * widens that WHERE clause, or worse, an accrual against a `userId` that
       * does not exist.
       *
       * Left unmarked either way. The account may be linked minutes from now,
       * and this deal must accrue when it is — see the column's own note.
       */
      if (!deal.userId || !deal.currency) continue;

      /*
       * ── A DEMO TRADE PAYS NOBODY ─────────────────────────────────────────
       *
       * ⚠️ THIS WAS A LIVE BUG AND IT PAID REAL MONEY FOR PRACTICE TRADES.
       *
       * Nothing in this pipeline had ever read `trading_accounts.environment`.
       * A demo account trades practice money against a demo product, and every
       * closing deal it produced was queued, priced and accrued exactly like a
       * live one — so a partner above that client earned commission, the client
       * earned a rebate, and `confirmPending` credited both into REAL wallets
       * as withdrawable balance. The house received nothing on any of it,
       * because there was nothing to receive: no client funded the account.
       *
       * It is a demo account's whole PURPOSE to be traded freely, so the
       * exposure is unbounded and self-serve — a client with an introducer can
       * open a demo account, trade it all day and mint commission out of
       * nothing. Worse, the accrual looked completely ordinary: correct chain,
       * correct arithmetic, a `nothingOwed`/`accrued` tally that read healthy.
       *
       * Every OTHER money path in this system already refuses demo, with this
       * same `!== 'live'` test: `TransfersService` on a wallet→account
       * transfer, `TransactionsService` on a deposit that declares a
       * destination, `AdminMoneyService` on a manual credit or debit. Commission
       * was the one path that never asked, and it is the one where the money is
       * created rather than moved.
       *
       * `!== 'live'` rather than `=== 'demo'`, matching those three: the enum
       * may grow, and a value nobody has considered yet must not default to
       * paying out.
       *
       * AFTER the orphan guard above, and that order is load-bearing. The join
       * onto `trading_accounts` is a LEFT one, so an unlinked login arrives
       * here with a NULL environment — which `!== 'live'` is perfectly happy to
       * treat as demo. Marking that done would discard a real trade's
       * commission permanently over an account somebody is about to link, which
       * is the exact failure the orphan column's own note warns about. Past
       * that guard, `environment` is non-null by construction.
       *
       * MARKED DONE rather than left queued, exactly like `predating` above. A
       * demo deal is not a deal that cannot be priced yet — it is one that is
       * correctly worth nothing and always will be. Leaving it NULL would
       * re-examine it on every run forever and build a backlog nobody intends
       * to pay, which is the failure this loop's own notes keep returning to.
       *
       * Counted in its own tally and not folded into `nothingOwed`, because
       * "practice trades we declined to pay" and "real trades that happened to
       * owe nobody" answer different questions, and an operator whose demo
       * count climbs while live accruals sit flat is looking at a bridge
       * mislabelling live accounts as demo.
       */
      if (deal.environment !== 'live') {
        await this.markProcessed([deal.id]);
        run.demo += 1;
        continue;
      }

      /*
       * ── COMMISSION IS EARNED ON A CLOSED POSITION, NEVER ON AN OPEN ONE ──
       *
       * Defensive only: the query above no longer returns an open leg, so this
       * should never fire. It is kept because the alternative to a redundant
       * guard on a money path is a silent accrual on an open position the day
       * somebody widens that WHERE clause.
       *
       * FR-IB-04: "compute commission on the closing of a deal — never on its
       * opening. Commission accrues only once the deal is closed."
       *
       * This used to accrue on ANY trade deal that carried revenue, which pays
       * the moment a position opens — MT5 charges its commission on the opening
       * deal as often as not. A partner was therefore paid on a position the
       * client might still be holding, and a dealer-cancelled open had already
       * produced money.
       *
       * The opener is left UNPROCESSED rather than marked done, because its
       * revenue is real and is paid by the close that consumes it below.
       */
      if (!isClosingEntry(deal.entry)) continue;

      /*
       * The revenue of the WHOLE position, not of this row.
       *
       * MT5 splits a round turn's charges across its legs however the broker
       * configured it — all on the open, all on the close, or half each — so
       * paying only the closing row's own commission would silently pay nothing
       * on the most common configuration there is.
       *
       * Summed over the position's deals that no other accrual has consumed,
       * which is what makes a PARTIAL close correct: the first close takes the
       * opener plus itself, the second takes only itself, and no leg is counted
       * twice or lost. Every row summed here is marked processed together with
       * this one.
       */
      const legs = await this.unconsumedLegs(deal);
      /*
       * Floored at zero because `legs` can come back EMPTY, which is not an
       * error: two closes of one position land in the same batch on a partial
       * close, and the first consumed both. The second then finds nothing left
       * to take, falls through the zero-revenue branch below, and is reported
       * as owing nothing — correct, and already paid with its sibling. Without
       * the floor it would subtract one from a count of legs that DID reach a
       * partner, which is the one thing this number exists to report.
       */
      run.legsConsumed += Math.max(0, legs.length - 1);

      /*
       * ── WHAT THIS TRADE PAYS: the product's commission type (0140) ────────
       *
       * The engine prices every leg from the traded product's rate card and
       * the trade's volume; what the broker earned on the trade no longer
       * enters the arithmetic. What is decided HERE is only which of the three
       * states the card is in — see `RevenueEvent.terms` in the engine for why
       * an account with no product is REFUSED (and defers on the backoff via
       * the catch below) while a product with no type is done.
       */
      const terms: ProductCommissionTerms | null | undefined =
        deal.productId === null
          ? undefined
          : deal.commissionTypeId === null
            ? null
            : {
                id: deal.commissionTypeId,
                name: deal.commissionTypeName ?? '',
                enabled: deal.commissionTypeEnabled ?? false,
                commissionPerLot: deal.commissionPerLot ?? '0',
                rebatePerLot: deal.rebatePerLot ?? '0',
              };
      /*
       * ── ZERO REVENUE DOES NOT MEAN NOBODY IS OWED ANYTHING ───────────────
       *
       * This used to short-circuit on a trade that earned the broker nothing.
       * That was a LIVE BUG on a raw-spread group — no commission, no swap, an
       * ordinary setup — where every deal was marked done having paid nobody.
       * Nothing reads the broker's revenue any more: a partner is owed the
       * product's per-lot terms on volume, whatever the trade earned, and
       * `calculate` is the only thing that decides whether that is zero.
       */
      try {
        const rows = await this.commissions.accrueForDeal({
          dealRowId: deal.id,
          ticket: deal.ticket,
          clientUserId: deal.userId,
          lots: deal.volume,
          terms,
          currency: deal.currency,
        });

        /*
         * Marked only AFTER the accrual returns. The reverse order loses the
         * commission on any failure between the two — and a crash between them
         * costs nothing, because the accrual is idempotent and the deal is
         * simply reconsidered.
         */
        await this.markProcessed(legs.map((leg) => leg.id));

        if (rows > 0) {
          run.accrued += 1;
          run.accrualRows += rows;
        } else {
          run.nothingOwed += 1;
        }
      } catch (error) {
        /*
         * Deliberately NOT marked, so a later run retries it.
         *
         * `accrueForDeal` throws only on a refused accrual or a database
         * failure, and neither is a reason to consider this deal finished. A
         * refusal is a settings mistake a human fixes — the ceiling alert names
         * it — and until then the deals accumulate un-accrued, which is exactly
         * what should happen: the money is still owed and still recorded.
         *
         * LATER, not next. Retrying immediately is what made a settings mistake
         * stop commission for everybody: the deal fails identically every run
         * and holds the front of an oldest-first queue while it does. The
         * backoff is the whole difference between "this deal is stuck" and
         * "this deal is stuck AND nothing behind it can be paid".
         */
        run.failed += 1;
        await this.deferRetry(deal.id, error);

        /*
         * The two failures need different people. A refusal is a SETTINGS
         * problem that will fail identically on every future run until somebody
         * changes a rate; anything else is transient and the next run probably
         * fixes it by itself. Logging them the same way sends an engineer to
         * read the database while the actual fix is one field on a screen — and
         * the ceiling alert has already fired for the first case.
         */
        if (error instanceof CommissionRefusedError) {
          this.logger.error(
            `Deal ${deal.ticket} was REFUSED and stays queued; retrying will keep failing until ` +
              `the commission configuration is corrected. ${error.message}`,
          );
        } else {
          this.logger.error(
            `Deal ${deal.ticket} could not be accrued and stays queued; the next run retries it: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    /*
     * Counted AFTER the loop, so a deal this run deferred is already included
     * and a link made mid-run is already reflected. Both numbers are backlogs
     * rather than batch tallies — see the field docs — and they come from one
     * query because the scheduler needs them on every run, including the quiet
     * ones where nothing was queued at all.
     */
    const stuck = await this.stuckCounts();
    run.orphaned = stuck.orphaned;
    run.deferred = stuck.deferred;

    return run;
  }

  /**
   * Is there unprocessed work old enough to be HISTORY rather than queue?
   *
   * Only trade deals count. A balance operation accrues nothing whenever it is
   * assessed, so a pile of old deposits is not a commercial decision waiting to
   * be made and must not hold the engine shut.
   */
  private async hasAgedBacklog(): Promise<boolean> {
    const [row] = await this.db
      .select({ id: mt5Deals.id })
      .from(mt5Deals)
      .where(
        and(
          isNull(mt5Deals.commissionProcessedAt),
          inArray(mt5Deals.action, [...TRADE_ACTIONS]),
          lte(mt5Deals.dealtAt, new Date(Date.now() - BACKLOG_AGE_MS)),
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  /** How many deals are waiting, for the log line that makes a backlog visible. */
  async backlog(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(mt5Deals)
      .where(isNull(mt5Deals.commissionProcessedAt));

    return row?.count ?? 0;
  }

  /**
   * How many of those are waiting on an account link rather than on this job.
   *
   * Separated because the two backlogs mean opposite things. A processing
   * backlog is this service falling behind and drains itself; an orphan backlog
   * is deals for logins nobody has linked, which will sit there forever until a
   * human connects the account — and it is the number that has to reach an
   * operator rather than a queue.
   */
  async orphanBacklog(): Promise<number> {
    return (await this.stuckCounts()).orphaned;
  }

  /**
   * The two backlogs that do NOT drain themselves, in one query.
   *
   * Both are now held out of the batch rather than retried into a jam, which is
   * what makes them invisible to `examined` — so this is the only thing left
   * that can report them, and it runs on every drain rather than only on runs
   * that happened to see one.
   *
   * One query rather than two because the scheduler needs both every minute and
   * they are the same scan: the unprocessed set, joined to the accounts that
   * claim it. Written as FILTERed counts so a deal that is BOTH orphaned and
   * previously attempted is counted honestly in each, rather than assigned to
   * whichever query ran first.
   */
  private async stuckCounts(): Promise<{ orphaned: number; deferred: number }> {
    const [row] = await this.db
      .select({
        orphaned: sql<number>`count(*) FILTER (WHERE ${tradingAccounts.userId} IS NULL)::int`,
        deferred: sql<number>`count(*) FILTER (WHERE ${mt5Deals.commissionAttempts} > 0)::int`,
      })
      .from(mt5Deals)
      .leftJoin(tradingAccounts, eq(tradingAccounts.login, mt5Deals.login))
      .where(isNull(mt5Deals.commissionProcessedAt));

    return { orphaned: row?.orphaned ?? 0, deferred: row?.deferred ?? 0 };
  }

  /**
   * Push one failed deal to the back of the queue, for a while.
   *
   * ## Exponential, and capped rather than exhausted
   *
   * A minute, then two, four, eight — up to an hour, and an hour forever after
   * that. The early retries are for the transient half (a database blip, a
   * lock timeout) where the next run genuinely does fix it. The cap is for the
   * other half: a refusal fails identically until a human edits a rate, and
   * there is no number of attempts after which the right answer is to stop.
   *
   * So this never gives up. The deal is still owed, and abandoning it would
   * turn a mistyped rate into permanently lost commission — the failure mode
   * §12.4's refusal exists to avoid. What the cap buys is that a hundred
   * permanently-stuck deals cost ONE batch an hour instead of every batch
   * forever.
   *
   * ## It writes rather than throws
   *
   * Called from inside the catch that already handled the accrual failure. If
   * this write fails too the run's own catch takes it and the deal is simply
   * retried next minute — the old behaviour, which is degraded rather than
   * wrong.
   */
  private async deferRetry(dealRowId: string, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);

    await this.db
      .update(mt5Deals)
      .set({
        commissionAttempts: sql`${mt5Deals.commissionAttempts} + 1`,
        /*
         * Computed from the STORED count, not from one this run read earlier:
         * two instances may have failed the same deal, and the backoff should
         * reflect how often it has actually failed rather than how often this
         * process watched it fail.
         */
        commissionRetryAfter: sql`now() + (least(power(2, least(${mt5Deals.commissionAttempts}, ${RETRY_EXPONENT_CEILING}))::int, ${RETRY_CAP_MINUTES}) || ' minutes')::interval`,
        /* Truncated: this is a diagnosis, not a transcript. */
        commissionLastError: reason.slice(0, 500),
      })
      .where(eq(mt5Deals.id, dealRowId));
  }

  /**
   * A dealer cancelled a trade. Did that trade already pay somebody?
   *
   * Reads only, and raises the alarm when the answer is yes. It does NOT
   * reverse: a reversal takes money out of a partner's wallet, which needs a
   * person — `CommissionService.reverseAccrual` is what they call, and this is
   * how they learn there is something to call it about.
   *
   * ## Silence is the correct answer most of the time
   *
   * A cancellation whose position never accrued — cancelled before the close,
   * or on an account with no introducer — is ordinary and must produce no
   * alert. An alarm that fires on every cancellation is one that gets muted,
   * taking the real cases with it.
   *
   * ## Why this can never block the queue
   *
   * It is wrapped, and a failure is logged rather than thrown. This runs inside
   * the branch that marks a deal DONE, and the deal is genuinely done — it
   * accrues nothing whatever happens here. Letting a failed lookup escape would
   * leave a cancellation unprocessed at the FRONT of an oldest-first queue,
   * which is precisely the stall that three separate doors in this file exist
   * to prevent. A missed alert is recoverable; a stalled engine is not.
   */
  private async reportClawback(deal: {
    id: string;
    ticket: string | number | bigint;
    login: string;
    action: number;
    positionId: string | null;
  }): Promise<void> {
    try {
      /*
       * No position id, nothing to trace it back to. MT5 does not always carry
       * one, and without it there is no honest way to say which trade this
       * cancels — a guess here would tell a desk to claw back the wrong money.
       */
      if (!deal.positionId) return;

      /*
       * Scoped by LOGIN as well as position id, for the same reason
       * `unconsumedLegs` is: a position id is unique per SERVER, not per
       * account, so a cross-account match would report one client's partner
       * over another client's cancelled trade.
       *
       * `sourceType` is the deal feed's, because that is the only path that
       * writes accruals today — `LIVE_REVENUE_FEED` names it and the position
       * path is written by nothing. If that ever inverts, this needs the other
       * id space too, and the constant is where it would be noticed.
       */
      const affected = await this.db
        .select({
          id: ibAccruals.id,
          status: ibAccruals.status,
          amount: ibAccruals.amount,
          currency: ibAccruals.currency,
          kind: ibAccruals.kind,
          ibUserId: ibAccruals.ibUserId,
          clientUserId: ibAccruals.clientUserId,
        })
        .from(ibAccruals)
        .innerJoin(mt5Deals, eq(mt5Deals.id, ibAccruals.sourceId))
        .where(
          and(
            eq(ibAccruals.sourceType, LEDGER_REFERENCE.deal),
            eq(mt5Deals.mt5PositionId, deal.positionId),
            eq(mt5Deals.login, deal.login),
          ),
        );

      /* The ordinary case: cancelled before it ever paid anybody. */
      const live = affected.filter((a) => a.status !== 'reversed');
      if (live.length === 0) return;

      const paid = live.filter((a) => a.status === 'confirmed').length;

      raiseAlert(
        this.logger,
        ALERT_KINDS.COMMISSION_CLAWBACK_REQUIRED,
        'notify',
        `MT5 ${dealActionLabel(deal.action)} deal ${String(deal.ticket)} cancels position ` +
          `${deal.positionId} on login ${deal.login}, which has ${live.length} accrual(s) ` +
          `standing — ${paid} already CREDITED to a wallet. Nothing has been reversed: review ` +
          'them and POST /admin/ib/accruals/:id/reverse for each that should come back. A ' +
          'still-pending accrual reverses for free; a credited one posts a compensating entry.',
        {
          login: deal.login,
          positionId: deal.positionId,
          accruals: live.length,
          credited: paid,
        },
      );

      /*
       * And a TASK per accrual on the bell of whoever can reverse it — the page
       * above reaches only an alert channel, and with no sink registered that
       * is nobody. One per accrual because the reversal is per accrual, and so
       * is the decision: a desk may reverse the credited one and let a pending
       * one lapse. Each clears for every admin when THAT accrual is reversed
       * (migration 0140's trigger). The client is the accrual's beneficiary —
       * the same rule the commission screens scope by — so nobody is asked to
       * reverse an accrual they cannot open.
       */
      for (const accrual of live) {
        void this.notifications?.notifyAdmins({
          kind: 'admin.commission.clawback',
          params: {
            accrualId: accrual.id,
            amount: accrual.amount,
            currency: accrual.currency,
            credited: accrual.status === 'confirmed',
            dealTicket: String(deal.ticket),
          },
          dedupeKey: `admin.commission.clawback:${accrual.id}`,
          subject: { id: accrual.id, clientId: accrualBeneficiary(accrual) },
        });
      }
    } catch (error) {
      this.logger.error(
        `Could not check deal ${String(deal.ticket)} for accruals to claw back: ` +
          `${error instanceof Error ? error.message : String(error)}. The cancellation is still ` +
          'marked processed — it accrues nothing either way.',
      );
    }
  }

  /**
   * Every deal whose revenue this accrual has taken — the closing row and the
   * legs it consumed.
   *
   * A SET rather than one id, because a closing deal pays for its opener too.
   * Marking only the closing row would leave the opener unprocessed forever,
   * re-examined on every run and re-consumed by the next close on the same
   * position — which is a double payment, not a wasted read.
   */
  private async markProcessed(dealRowIds: string[]): Promise<void> {
    if (dealRowIds.length === 0) return;

    await this.db
      .update(mt5Deals)
      .set({ commissionProcessedAt: new Date() })
      .where(inArray(mt5Deals.id, dealRowIds));
  }

  /**
   * The closing deal, plus every leg of its position no accrual has taken yet.
   *
   * `commission_processed_at IS NULL` is the "not yet consumed" marker, and it
   * is the same column the batch query reads — so a leg cannot be counted by
   * two closes, and a leg that arrives late (the sweep runs 24 hours behind the
   * push feed) is still picked up by whichever close comes after it.
   *
   * A deal with NO position id falls back to itself. That is not a guess: MT5
   * does not always populate it, and the alternative — refusing to pay — would
   * lose real commission over a field the broker's server chose not to send.
   */
  private async unconsumedLegs(deal: {
    id: string;
    login: string;
    positionId: string | null;
    commission: string;
    swap: string;
  }): Promise<{ id: string; commission: string; swap: string }[]> {
    if (!deal.positionId) {
      return [{ id: deal.id, commission: deal.commission, swap: deal.swap }];
    }

    return this.db
      .select({ id: mt5Deals.id, commission: mt5Deals.commission, swap: mt5Deals.swap })
      .from(mt5Deals)
      .where(
        and(
          eq(mt5Deals.mt5PositionId, deal.positionId),
          eq(mt5Deals.login, deal.login),
          isNull(mt5Deals.commissionProcessedAt),
        ),
      );
  }
}
