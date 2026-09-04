import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db, Executor } from '../../database/db';
import { ibAccounts, ibAccruals, ibLevels, users } from '../../database/schema';
import { LEDGER_REFERENCE, type LedgerReferenceType } from '../../database/ledger-reference';
import { NotFoundError } from '../../common/errors/domain-errors';
import { money, toDecimal } from '../wallet/money';
import { LIVE_REVENUE_FEED, isLiveRevenueFeed } from './revenue-feed';
import { AppSettingsStore } from '../../store/app-settings.store';
import type { RevenueBasis } from '../../common/revenue-basis';
import { tradingTermsFrom } from '../../common/trading-terms';
import { ALERT_KINDS, raiseAlert } from '../../common/logging/alerts';
import { WalletService } from '../wallet/wallet.service';
import {
  CommissionRefusedError,
  type CommissionAccrualPort,
} from '../../common/provisioning/commission-accrual.port';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../common/provisioning/notification-dispatch.port';
import {
  calculate,
  checkPlausible,
  resolveChain,
  MAX_CHAIN_DEPTH,
  type ChainNode,
  type LevelTerms,
  type RevenueEvent,
} from './commission';

/**
 * The commission pipeline: accrue on revenue, confirm into the wallet.
 *
 *   accrueForDeal     resolve chain → calculate → INSERT accruals (idempotent)
 *   confirmPending    pending accruals → locked wallet credit → mark confirmed
 *
 * A CLOSED TRADE is the only thing that accrues. `accrueForDeposit` survives as
 * a named refusal and nothing else — this docblock described it as the pipeline
 * long after it stopped being one, which is how a dead path keeps looking like
 * the supported one.
 *
 * ## Two steps, not one, and the split is the point
 *
 * A commission is EARNED when a trade closes and PAYABLE once the revenue
 * behind it is beyond reversal. Crediting the partner's wallet in the same
 * breath as the accrual would make every commission irreversible before that —
 * and a reversed trade would leave a partner holding money recoverable only by
 * a compensating entry with no record of what it compensates.
 *
 * So an accrual writes a `pending` row and moves no money. Nothing a partner
 * can spend exists until `confirmPending` runs, a settlement window later.
 *
 * ## Every step is idempotent, deliberately
 *
 * These are called directly today and become queue handlers when BullMQ lands.
 * The logic is identical either way, which is the whole reason it is written
 * this way: at-least-once delivery is safe, and re-running the pipeline over
 * the same trades changes no balance.
 *
 * The guarantees are DATABASE constraints, never check-then-insert:
 *   - `ib_accruals_source_earner_uq` absorbs a replayed accrual.
 *   - `ledger_entries_wallet_reference_uq` absorbs a replayed credit — that is
 *     the §6.3 constraint whose absence migration 0028 called out as the thing
 *     that must return before any payment provider is connected.
 *
 * All decision-making lives in the pure functions in `./commission.ts`. This
 * class only fetches, persists and moves money.
 */
/**
 * A day, and the reasoning is the reversal window rather than the number.
 *
 * Long enough that a bad deposit is caught by the desk's normal daily rhythm
 * before the money becomes spendable; short enough that a partner is not
 * chasing yesterday's commission. Override with IB_COMMISSION_HOLD_HOURS.
 */
const DEFAULT_HOLD_HOURS = 24;

@Injectable()
export class CommissionService implements CommissionAccrualPort {
  private readonly logger = new Logger(CommissionService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly wallets: WalletService,
    /** The partner's "commission credited" bell row, written with the credit. */
    @Inject(NOTIFICATION_DISPATCH) private readonly notifications: NotificationDispatchPort,
    /*
     * The hold window's only source. `AppSettingsStore` used to sit beside it,
     * because the window was a column too — removed in 0104 with the rest of
     * the IB block on the Trading settings form.
     */
    private readonly config: ConfigService,
    /*
     * Back for ONE number (0106): `ib_max_total_payout_pct`, the ceiling on
     * what a single trade may cost across every leg.
     *
     * It left in 0104 with the four IB settings that each DUPLICATED the
     * Commission Programmes page. This one does the opposite — it bounds a
     * total no programme can see, because the earners on one trade may hold
     * different programmes. A per-programme ceiling would be blind to exactly
     * the thing worth bounding.
     */
    private readonly settings: AppSettingsStore,
  ) {}

  /**
   * The configured ceiling, narrowed, as a decimal string.
   *
   * Read per trade rather than cached: an operator lowering it expects the next
   * deal to respect it, and a commission engine holding a stale ceiling for the
   * life of the process is the kind of thing nobody notices until a payout is
   * disputed.
   */
  /**
   * The per-lot ceiling — 0111. Read from settings for the same reason the
   * percentage one is: it is a bound an operator sets, not a constant.
   */
  private async maxPayoutPerLot(): Promise<string> {
    return tradingTermsFrom(await this.settings.getTrading()).ibMaxPayoutPerLot;
  }

  private async maxTotalPayoutPct(): Promise<string> {
    return tradingTermsFrom(await this.settings.getTrading()).ibMaxTotalPayoutPct;
  }

  /**
   * How long an accrual must sit before it becomes spendable.
   *
   * ## This is the promise the class docblock makes and did not keep
   *
   * The two-step design says a commission is payable "once that deposit is
   * settled and BEYOND REVERSAL". Nothing enforced the second half: the
   * confirmation ran hourly over every pending row, so a commission was in the
   * partner's wallet within the hour and a deposit reversed afterwards left
   * them holding money recoverable only by a compensating entry.
   *
   * A window does not make reversal impossible — it makes it CHEAP. Inside the
   * window the accrual is still just a row, and reversing it costs a status
   * change and moves no money. Outside it, the same reversal is a debit against
   * a balance the partner may already have withdrawn.
   *
   * Zero is honoured and means "pay immediately", which is what the system did
   * before this existed. It is a legitimate choice for a broker whose deposits
   * cannot be reversed, and it is not the default.
   */
  /*
   * `maxSharePct` IS GONE, with the "Maximum paid to partners" setting it read.
   *
   * It handed `calculate` a percentage that scaled every leg pro rata when a
   * chain paid out more than that share of the revenue. Removed at the
   * operator's request; the FSD asks for no broker-side ceiling. What still
   * refuses an over-payment is `checkPlausible` below, per trade — see the note
   * where the cap used to sit in `commission.ts`.
   */

  /**
   * How long an accrual is held before it may be confirmed.
   *
   * ## `IB_COMMISSION_HOLD_HOURS` is the ONLY answer (0104)
   *
   * It was a column on `trading_settings` for a while. The column and its form
   * field were removed at the operator's request, along with the rest of the IB
   * block on that screen: commission is configured on the Commission Programmes
   * page, and a second screen deciding what partners are paid is the same
   * "two places" problem 0102 removed from the catalogue.
   *
   * SYNCHRONOUS again, because there is nothing left to await. It read a
   * settings row until 0104; keeping the `Promise` would be a signature that
   * implies I/O this method no longer does — and `require-await` says so.
   */
  private holdHours(): number {
    const raw = this.config.get<string>('IB_COMMISSION_HOLD_HOURS');
    if (raw === undefined || raw.trim() === '') return DEFAULT_HOLD_HOURS;

    const parsed = Number.parseInt(raw.trim(), 10);
    /*
     * A malformed value falls back to the default rather than to zero. The
     * failure mode of a typo must not be "pay every commission instantly" —
     * that is the one outcome nobody would choose deliberately.
     */
    if (!Number.isInteger(parsed) || parsed < 0) {
      this.logger.warn(
        `IB_COMMISSION_HOLD_HOURS is "${raw}", which is not a whole number of hours. ` +
          `Holding for the default ${DEFAULT_HOLD_HOURS}h instead.`,
      );
      return DEFAULT_HOLD_HOURS;
    }
    return parsed;
  }

  /**
   * `CommissionAccrualPort` — the entry point payments calls, and the ONLY one
   * that swallows its errors.
   *
   * The no-throw contract is the whole reason this wrapper exists rather than
   * payments calling `accrueForDeposit` directly: by the time this runs, the
   * client's deposit has already credited their wallet. A commission failure
   * must not roll that back, and must not report the deposit as failed. The
   * accrual is recoverable — the deposit is re-accruable because nothing was
   * written — where a reversed deposit is a support incident.
   */
  async accrueForSettledDeposit(deposit: {
    transactionId: string;
    clientUserId: string;
    amount: string;
    currency: string;
  }): Promise<number> {
    try {
      return await this.accrueForDeposit(deposit);
    } catch (error) {
      this.logger.error(
        `Commission accrual failed for transaction ${deposit.transactionId}; the deposit itself ` +
          `stands and the accrual can be re-run: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
      return 0;
    }
  }

  /**
   * Accrue commissions for one settled client deposit.
   *
   * Safe to run repeatedly. Returns how many accrual rows the call CREATED —
   * zero on a replay, which is what makes a retried job a no-op rather than a
   * double payment.
   *
   * `executor` lets the caller run this inside their own transaction, so the
   * deposit's own state change and the accrual it causes commit together.
   */
  /**
   * Accrue on a CLOSED POSITION — the only thing that earns a partner anything.
   *
   * ## The base is the BROKER's revenue, never the client's money
   *
   * `brokerRevenue` is what the broker took on this trade: its commission and
   * swap. It is not the client's volume, not their profit, and emphatically not
   * their balance or deposit. A partner's revenue share is a share of what the
   * house earned, so the house can never pay out more than it took in.
   *
   * `lots` rides alongside for `per_lot` levels, which are paid on SIZE rather
   * than on money and are therefore not bounded by the revenue — a broker may
   * buy volume at a loss on a single trade, deliberately.
   *
   * ## Nothing is paid on an unprofitable-to-the-broker trade
   *
   * A zero or negative `brokerRevenue` accrues nothing rather than a negative
   * amount: a clawback is a deliberate compensating entry, not a side effect of
   * a quiet trade.
   */
  async accrueForClosedPosition(position: {
    positionId: string;
    clientUserId: string;
    brokerRevenue: string;
    lots: string;
    currency: string;
  }): Promise<number> {
    /*
     * ── ONE FEED PAYS, AND TODAY IT IS NOT THIS ONE ──────────────────────
     *
     * A position accrual and a deal accrual for the same round turn are two
     * different `(source_type, source_id)` pairs, so
     * `ib_accruals_source_earner_uq` cannot see one from the other and the
     * database would happily hold both — one trade, a partner paid twice.
     *
     * Until now the only thing preventing that was `positions` having no
     * writer, which is a countdown rather than a safety: this repo's own notes
     * tell whoever builds the bridge to start filling that table. So the
     * refusal is read from `revenue-feed.ts`, the single place that names the
     * paying feed, and flipping that constant is what moves payment here.
     *
     * LOUD rather than silent. Being called at all means somebody wired a
     * position writer without flipping the feed, and the honest report of that
     * is an error naming the constant — not a quiet 0 that reads exactly like
     * a trade nobody was owed anything on.
     */
    if (!isLiveRevenueFeed(LEDGER_REFERENCE.position)) {
      this.logger.error(
        `Position ${position.positionId} closed and was NOT accrued: the live revenue feed is ` +
          `'${LIVE_REVENUE_FEED}', and paying both feeds would pay one trade twice. If positions ` +
          `are now the feed, set LIVE_REVENUE_FEED in modules/ib/revenue-feed.ts.`,
      );
      return 0;
    }

    /*
     * The NO-THROW half of the port contract, and the reason it wraps rather
     * than being folded into the body below.
     *
     * By the time this runs the position is closed and the client's balance is
     * already settled. A commission failure must not roll that back or report
     * the close as failed — the accrual is recoverable by re-running the
     * pipeline, and the position is not.
     */
    try {
      return await this.accrueForRevenue({
        sourceType: LEDGER_REFERENCE.position,
        sourceId: position.positionId,
        describe: `position ${position.positionId}`,
        clientUserId: position.clientUserId,
        brokerRevenue: position.brokerRevenue,
        lots: position.lots,
        currency: position.currency,
      });
    } catch (error) {
      this.logger.error(
        `Commission accrual failed for position ${position.positionId}; the position is closed ` +
          `and unaffected, and this is re-runnable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /**
   * Accrue partner commissions for ONE ingested MT5 deal. Returns rows created.
   *
   * ## Why the feed pays per deal and not per position
   *
   * A position looks like the natural unit and is the wrong one here; the long
   * form of the argument is on `LEDGER_REFERENCE.deal`. The short form: MT5
   * charges commission on the opening deal as well as the closing one, the
   * sweep's 24-hour window means a closing deal often arrives without its
   * opener, and a partial close is several closing deals against one position.
   * Every one of those makes a position-keyed accrual pay less than was earned,
   * and the failure is silent — the pipeline reports success either way.
   *
   * A deal is what the broker's own server treats as atomic, and it carries its
   * own revenue. Summing the accruals across a round turn gives the same total
   * as pairing them would have, without needing the pair to exist.
   *
   * ## This one THROWS, unlike the two hooks above, and deliberately
   *
   * Those protect a user-facing write that has already happened — a settled
   * deposit, a closed position — where failing the caller would be worse than
   * losing the accrual. This has no such caller. It is driven by a queue whose
   * whole job is to retry, so swallowing an error here would convert "try again
   * in a minute" into "this deal never pays", which is the outcome the queue
   * exists to prevent.
   *
   * `DealCommissionService` is the only caller, and leaves the deal unmarked on
   * a throw so the next run picks it up again.
   */
  async accrueForDeal(deal: {
    /** `mt5_deals.id` — the row, not MT5's ticket. The accrual's source id. */
    dealRowId: string;
    /** MT5's ticket, for the log line only. */
    ticket: string;
    clientUserId: string;
    brokerRevenue: string;
    /**
     * What the broker earned under EACH basis, for FR-IB-16 (0106).
     *
     * Optional: without it every earner is priced on `brokerRevenue`, which is
     * the behaviour that shipped before programmes carried a basis. The deal
     * feed passes it, so a chain mixing programmes prices each partner on the
     * terms they actually agreed to.
     */
    revenueByBasis?: ReadonlyMap<RevenueBasis, string>;
    lots: string;
    currency: string;
  }): Promise<number> {
    /*
     * The other half of the one-feed rule guarded in `accrueForClosedPosition`.
     * Both sides read the same constant, so there is no arrangement of the two
     * in which both pay — which is the property the old comment could not give.
     *
     * It REFUSES rather than returning 0, because the two mean opposite things
     * to the queue that calls this. Returning 0 marks the deal done, and if the
     * feed moved to positions while deals were still queued that would discard
     * every one of them permanently. A refusal leaves them unmarked and names
     * the reason on every run until a human decides what the backlog is owed.
     */
    if (!isLiveRevenueFeed(LEDGER_REFERENCE.deal)) {
      throw new CommissionRefusedError(
        `Deal ${deal.ticket} was not accrued: the live revenue feed is '${LIVE_REVENUE_FEED}', ` +
          'and paying both feeds would pay one trade twice. These deals stay queued.',
      );
    }

    return await this.accrueForRevenue({
      sourceType: LEDGER_REFERENCE.deal,
      sourceId: deal.dealRowId,
      describe: `deal ${deal.ticket}`,
      clientUserId: deal.clientUserId,
      brokerRevenue: deal.brokerRevenue,
      revenueByBasis: deal.revenueByBasis,
      lots: deal.lots,
      currency: deal.currency,
    });
  }

  /**
   * The one implementation behind every revenue event that pays a share.
   *
   * `accrueForClosedPosition` and `accrueForDeal` differ ONLY in what they key
   * the accrual on and in what they do with a failure. Everything between —
   * reading attribution from the client, resolving the chain, applying the
   * ladder, the plausibility check and the idempotent insert — is identical,
   * and was worth having once rather than twice: the two copies would drift on
   * the first change to the ladder, and the direction they drift in is a
   * partner being paid differently depending on which feed found the trade.
   *
   * ## It THROWS on a refusal, and that is the point
   *
   * A refused accrual is not "nothing was owed". It is "something was owed and
   * this system will not guess the amount", and the two must not look the same
   * to a caller — a queue that treats a refusal as a completed item drops the
   * commission permanently at the moment a misconfiguration is worst.
   *
   * Returning 0 is reserved for the cases where zero is the CORRECT answer:
   * the client was never referred, the chain resolves to nobody, or every leg
   * rounded away. Those are done, and re-running them would change nothing.
   */
  private async accrueForRevenue(event: {
    /** Which id space `sourceId` belongs to — the accrual's idempotency key. */
    sourceType: LedgerReferenceType;
    sourceId: string;
    /** How to name this event in a log line, e.g. `deal 90210`. */
    describe: string;
    clientUserId: string;
    /**
     * The broker's own earning on this trade under the DEFAULT basis.
     *
     * Still the figure every leg is priced on when `revenueByBasis` is absent,
     * and still what `checkPlausible` bounds the total against — see the note
     * at that call for why the ceiling has one denominator even when the legs
     * do not.
     */
    brokerRevenue: string;
    /** Per-basis revenue for FR-IB-16 (0106); absent means price everything on `brokerRevenue`. */
    revenueByBasis?: ReadonlyMap<RevenueBasis, string>;
    /** Lots traded, for per_lot levels. */
    lots: string;
    currency: string;
  }): Promise<number> {
    /*
     * Read from the CLIENT rather than taken as a parameter, for the reason the
     * deposit path gives below: attribution is written once at registration and
     * is permanent, so a caller must not be able to name the partner who gets
     * paid.
     */
    const [client] = await this.db
      .select({ referredBy: users.referredByIbUserId })
      .from(users)
      .where(eq(users.id, event.clientUserId))
      .limit(1);

    if (!client?.referredBy) return 0; // Not referred — nobody earns. Not an error.

    const chainNodes = await this.loadChain(this.db, client.referredBy);
    const chain = resolveChain(client.referredBy, (id) => chainNodes.get(id));
    if (chain.length === 0) return 0;

    /*
     * The whole ladder, not a lookup per earner. It is two or three rows —
     * `ib_max_levels` bounds it — so one unfiltered read is cheaper than an IN
     * list, and it means a rung nobody in this chain occupies still appears if
     * a later step needs it.
     */
    const levels = await this.loadLevels(this.db);

    const revenue: RevenueEvent = {
      grossAmount: event.brokerRevenue,
      currency: event.currency,
      source: 'deal',
      lots: event.lots,
    };

    const result = calculate(revenue, chain, levels, event.revenueByBasis);
    if (result.skippedReason) {
      this.logger.warn(
        `Commission partially skipped for ${event.describe}: ${result.skippedReason}`,
      );
    }
    /*
     * ── A LEG WE CANNOT PRICE IS A REFUSAL, NOT AN EMPTY RESULT ────────────
     *
     * This must come BEFORE the zero check below, and that order is the whole
     * point. A partner owed money whose basis has no figure produces no
     * accruals — which is indistinguishable from "nobody was owed anything"
     * once it reaches the queue, and the queue marks that deal DONE. MT5's
     * amounts are final when reported, so nothing recomputes it when somebody
     * links the missing product a minute later: the commission is gone.
     *
     * Refusing defers the deal on the 0092 backoff with the reason on the row,
     * and it pays IN FULL once the configuration is corrected.
     */
    if (result.unpriceable) {
      throw new CommissionRefusedError(
        `${event.describe} cannot be priced for every earner: ${result.unpriceable.join('; ')}. ` +
          'Nothing has been accrued and the deal stays queued.',
      );
    }

    if (result.accruals.length === 0 && !result.rebate) return 0;

    const plausible = checkPlausible(
      revenue,
      result.accruals,
      result.rebate,
      await this.maxTotalPayoutPct(),
      await this.maxPayoutPerLot(),
    );
    if (!plausible.ok) {
      /*
       * §12.4's ceiling, and the ALERT that has always been declared for it.
       *
       * `ALERT_THRESHOLDS` describes this exact situation — "accrual is refused,
       * so deals are accumulating un-accrued until it is fixed" — and nothing
       * raised it, so the condition it names could only ever have been found by
       * reading the log by hand. The overwhelmingly likely cause is a rate
       * configured in the wrong unit, which is a settings mistake a human fixes
       * in a minute once they know.
       */
      raiseAlert(
        this.logger,
        ALERT_KINDS.COMMISSION_CEILING_BREACH,
        'page',
        `Refusing commission for ${event.describe}: ${plausible.reason}`,
        { source: event.sourceType, base: event.brokerRevenue, currency: event.currency },
      );
      throw new CommissionRefusedError(
        `Refusing commission for ${event.describe}: ${plausible.reason}`,
      );
    }

    /*
     * The client's leg is a ROW like any other, and that is the whole reason it
     * is one: it matures through the same settlement window, is confirmed by the
     * same loop, and is made idempotent by the same unique key. A rebate paid
     * straight to the wallet here would be the one payout on this system that
     * skips the window a reversal needs.
     *
     * `depth: 1` always, because a rebate belongs to the DIRECT relationship —
     * the client's own introducer — whatever the chain above it looks like.
     */
    const introducer = chain.find((entry) => entry.depth === 1);
    const rows = [
      ...result.accruals.map((accrual) => ({
        kind: 'commission' as const,
        ibUserId: accrual.ibUserId,
        depth: accrual.depth,
        programId: accrual.programId ?? null,
        levelId: accrual.levelId ?? null,
        rateValue: accrual.rateValue,
        baseAmount: accrual.baseAmount,
        amount: accrual.amount,
      })),
      ...(result.rebate && introducer
        ? [
            {
              kind: 'rebate' as const,
              ibUserId: result.rebate.ibUserId,
              depth: 1,
              programId: result.rebate.programId ?? null,
              levelId: result.rebate.levelId ?? null,
              rateValue: result.rebate.rateValue,
              baseAmount: result.rebate.baseAmount,
              amount: result.rebate.amount,
            },
          ]
        : []),
    ];

    const inserted = await this.db
      .insert(ibAccruals)
      .values(
        rows.map((accrual) => ({
          kind: accrual.kind,
          ibUserId: accrual.ibUserId,
          clientUserId: event.clientUserId,
          /*
           * Keyed on whatever the CALLER considers atomic — a position for the
           * CRM's own trade path, a deal row for the MT5 feed. With the
           * accrual's own unique index over (sourceType, sourceId, ibUserId)
           * this makes re-processing a no-op, which the feed does routinely:
           * every deal is delivered at least twice by design.
           */
          sourceType: event.sourceType,
          sourceId: event.sourceId,
          depth: accrual.depth,
          /*
           * The terms that paid it, recorded ON the row — replacing `level`,
           * which named a rung that stopped deciding rates in 0084 and stopped
           * existing in 0102. With `programId`, `depth` and `rateValue`
           * together, a disputed payout is settled from this row alone rather
           * than from the partner's CURRENT programme, which is the one thing
           * most likely to have changed since.
           */
          programId: accrual.programId ?? null,
          levelId: accrual.levelId ?? null,
          rateValue: accrual.rateValue,
          /*
           * The leg's OWN base (0106), not the trade's default-basis revenue.
           *
           * Since FR-IB-16 there is no single "the revenue" to stamp here: two
           * earners on one trade may price on different bases, so the old
           * `event.brokerRevenue` would have claimed `amount` is `rateValue`%
           * of a figure it is not — an accrual that fails its own arithmetic.
           */
          baseAmount: accrual.baseAmount,
          amount: accrual.amount,
          currency: event.currency,
        })),
      )
      .onConflictDoNothing({
        /*
         * `kind` is in the target because it is in the index. Without it the
         * rebate row conflicts with the commission row beside it — same source,
         * same partner — and is dropped in silence, which is indistinguishable
         * from a rebate that was never configured.
         */
        target: [ibAccruals.sourceType, ibAccruals.sourceId, ibAccruals.ibUserId, ibAccruals.kind],
      })
      .returning({ id: ibAccruals.id });

    return inserted.length;
  }

  /**
   * @deprecated A DEPOSIT IS NOT REVENUE, and this must not be re-enabled as a
   * percentage.
   *
   * It paid a share of the client's own money: on a $1,000 deposit at 70% the
   * partner received $700 of the BROKER's funds while the client kept the right
   * to withdraw all $1,000. Unbounded, and it scaled with deposit volume.
   *
   * Kept — unwired — because CPA is a real model that triggers on a deposit: a
   * FIXED amount per qualified client. Whoever builds that starts here and pays
   * a flat sum, never a percentage.
   *
   * ## It REFUSES at the door, rather than working and finding nothing
   *
   * `calculate` already declines a `deposit` term, so re-wiring this could not
   * have paid a percentage — but it would have resolved the chain, loaded the
   * programmes, produced zero rows and returned 0. Silently. Which is exactly
   * what "this client's partner earns nothing" looks like, so whoever wired it
   * would go looking for the reason, find the deposit branch inside `calculate`,
   * and delete the one thing standing between them and the original bug.
   *
   * Refusing HERE names the reason at the point somebody is holding the wire,
   * and names the model they actually want. The other two feeds refuse the same
   * way and for the same reason; this is the third, and it is not
   * `isLiveRevenueFeed` because a deposit is not a revenue feed at all — that is
   * the whole point. Flipping `LIVE_REVENUE_FEED` must never make this payable.
   *
   * `accrueForSettledDeposit` swallows this, per its no-throw contract, and logs
   * it — so a caller who wires it up gets a loud line and a deposit that still
   * credits, rather than a failed deposit.
   */
  /*
   * `async` with nothing to await, on purpose: the port's contract is a REJECTED
   * PROMISE, and a synchronous throw is a different thing to every caller that
   * handles this with `.catch()` rather than `try`/`await`. The refusal is the
   * whole implementation, so there is nothing left in here to await.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async accrueForDeposit(
    deposit: {
      transactionId: string;
      clientUserId: string;
      amount: string;
      currency: string;
    },
    /**
     * Still on the signature, unused, because it is part of the shape a CPA
     * implementation needs: the accrual must be able to join the caller's
     * transaction so the deposit's state change and the payment it causes
     * commit together. Dropping it would lose that requirement silently.
     */
    _executor?: Executor,
  ): Promise<number> {
    throw new CommissionRefusedError(
      `Transaction ${deposit.transactionId} was not accrued: commission is not earned on a ` +
        'deposit. The money is the client’s, not the broker’s revenue — a percentage of it pays ' +
        'a partner out of the broker’s own funds while the client keeps the right to withdraw ' +
        'every cent, unbounded and scaling with deposit volume. Commission is earned on closed ' +
        'trades (accrueForDeal). If you want to pay for a funded client, that is CPA: a FIXED ' +
        'amount per qualified client, which needs its own column and its own rate — never this ' +
        'path with a percentage.',
    );
  }

  /**
   * Credit every pending accrual into its partner's wallet.
   *
   * ## One transaction PER ACCRUAL, not one for the batch
   *
   * A batch-wide transaction would make one bad row roll back every good credit
   * in the run, and would hold wallet locks across the whole batch. Per-accrual
   * scoping means a failure is isolated to the accrual that caused it and the
   * rest still pay out — and because each is individually idempotent, the next
   * run retries only what did not land.
   *
   * The ledger insert and the status update share that transaction, so an
   * accrual marked `confirmed` with no ledger entry behind it — or a credit with
   * no accrual pointing at it — is a state this system cannot reach.
   */
  async confirmPending(limit = 500): Promise<{ confirmed: number; failed: number; held: number }> {
    const hours = this.holdHours();
    const payableFrom = new Date(Date.now() - hours * 3_600_000);

    const pending = await this.db
      .select()
      .from(ibAccruals)
      .where(and(eq(ibAccruals.status, 'pending'), lte(ibAccruals.createdAt, payableFrom)))
      .orderBy(ibAccruals.createdAt)
      .limit(limit);

    /*
     * Counted separately and REPORTED, because "nothing was paid" has two very
     * different causes: nobody earned anything, or everything earned is still
     * maturing. An operator watching the log needs to tell them apart before
     * concluding the engine has stopped.
     */
    const [{ held = 0 } = {}] = await this.db
      .select({ held: sql<number>`count(*)::int` })
      .from(ibAccruals)
      .where(and(eq(ibAccruals.status, 'pending'), gt(ibAccruals.createdAt, payableFrom)));

    let confirmed = 0;
    let failed = 0;

    for (const accrual of pending) {
      try {
        /* Read once: it decides the beneficiary, the wallet, the ledger type
           and who gets told. */
        const rebate = accrual.kind === 'rebate';

        await this.db.transaction(async (tx) => {
          const posted = await this.wallets.post(
            {
              /*
               * ── WHO IS PAID depends on the accrual's KIND ────────────────
               *
               * A `commission` row pays the PARTNER into their commission
               * wallet. A `rebate` row pays the trading CLIENT into their main
               * wallet — it is their own money coming back, not an earning, and
               * putting it in a commission wallet would both mislabel it and
               * strand it behind a transfer the client has no reason to make.
               *
               * `ibUserId` on a rebate row is the partner whose programme
               * produced it, which is attribution rather than entitlement —
               * reading it as the beneficiary would pay the introducer their
               * client's rebate.
               */
              userId: rebate ? accrual.clientUserId : accrual.ibUserId,
              currency: accrual.currency,
              /*
               * The COMMISSION wallet, not the partner's spending wallet.
               *
               * This credited `main` — the same wallet a deposit lands in — so
               * the ledger knew which movements were earnings but the BALANCE
               * did not. A partner looking at $700 could not tell what they had
               * deposited from what they had earned, and reconciling their
               * commission against their own records meant subtracting their
               * own deposits by hand.
               *
               * Opened lazily, here, by `post` itself: a partner who has never
               * been paid has no commission wallet, and that is the honest
               * state — the portal renders it as "nothing credited yet" rather
               * than as a zero balance, which is the same rule the wallet
               * screen follows for a currency nobody has opened.
               *
               * Existing balances are NOT migrated. Commission already credited
               * to a main wallet is settled money the partner may have spent;
               * moving it now would rewrite history to make a report tidier.
               */
              kind: rebate ? 'main' : 'commission',
              amount: accrual.amount,
              entryType: rebate ? 'rebate' : 'commission',
              /*
               * Keyed on the ACCRUAL, not the source transaction. One deposit
               * can pay two partners, so keying on the transaction would make
               * the second credit look like a replay of the first and silently
               * drop it — the L2 partner would never be paid.
               */
              referenceType: LEDGER_REFERENCE.accrual,
              referenceId: accrual.id,
            },
            tx,
          );

          /*
           * The status write is CONDITIONAL on the row still being pending, so
           * the check and the write are one statement. Two workers racing over
           * the same accrual cannot both pass — the second updates nothing and
           * `post` has already returned the original entry rather than a second
           * credit.
           */
          await tx
            .update(ibAccruals)
            .set({
              status: 'confirmed',
              /*
               * `posted.entry` is the ledger row either way — on a replay
               * `post` returns the ORIGINAL entry with `replayed: true` rather
               * than writing a second one. So this converges on the same id
               * whether or not the credit had already landed, which is what
               * makes a retried run leave the accrual correctly linked instead
               * of pointing at nothing.
               */
              ledgerEntryId: posted.entry.id,
              confirmedAt: new Date(),
            })
            .where(and(eq(ibAccruals.id, accrual.id), eq(ibAccruals.status, 'pending')));

          /*
           * The partner's bell row, in the SAME transaction as the credit and
           * DEDUPED on the accrual id — this loop is at-least-once by design
           * (hourly, safe on every instance), and two runs racing past the
           * `pending` filter must converge on one row, exactly as the ledger
           * credit converges via `ledger_entries_wallet_reference_uq`. No
           * email, deliberately: an hourly batch would mail a busy partner
           * once per accrual per hour; the bell and the earnings screen carry
           * it.
           */
          await this.notifications.notify(
            {
              recipient: { kind: 'client', id: rebate ? accrual.clientUserId : accrual.ibUserId },
              kind: rebate ? 'rebate.credited' : 'commission.confirmed',
              params: {
                accrualId: accrual.id,
                amount: accrual.amount,
                currency: accrual.currency,
              },
              dedupeKey: `${rebate ? 'rebate.credited' : 'commission.confirmed'}:${accrual.id}`,
            },
            tx,
          );
        });
        confirmed += 1;
      } catch (error) {
        /*
         * Counted and logged, never rethrown. One partner's wallet failing to
         * accept a credit must not stop every other partner being paid in the
         * same run; the row stays `pending` and the next run retries it.
         */
        failed += 1;
        this.logger.error(
          `Could not confirm accrual ${accrual.id} for partner ${accrual.ibUserId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (confirmed > 0 || failed > 0) {
      this.logger.log(`Commission confirm run: ${confirmed} credited, ${failed} left pending.`);
    }
    return { confirmed, failed, held };
  }

  /**
   * Take one accrual back — the third status the schema has always promised.
   *
   * `ib_accrual_status` has carried `reversed` since the table existed and the
   * API publishes it, but nothing anywhere SET it. A dealer-cancelled trade,
   * a mistyped rate caught after the window, a duplicate the desk spotted — all
   * of them had exactly one remedy: hand-written SQL against a ledger whose
   * whole design is that it cannot be edited. This is the operation that was
   * missing, not a new policy.
   *
   * ## Deliberately MANUAL, and that is not indecision
   *
   * `DealCommissionService` raises `COMMISSION_CLAWBACK_REQUIRED` when a
   * cancellation lands on a trade that already paid, and stops there. It does
   * not call this. A reversal moves money out of somebody's wallet, which is a
   * decision with a person behind it — a feed should not do it because a code
   * arrived, and a broker that re-sends a day of deals should not empty a
   * partner's balance as a side effect.
   *
   * ## What it costs depends entirely on when you catch it
   *
   * That asymmetry is the reason the settlement window exists at all, and it is
   * visible right here:
   *
   *   PENDING    the money never moved. A status change, and nothing else.
   *   CONFIRMED  the partner has been paid. This posts a compensating entry —
   *              `ledger_entries` is append-only, so taking money back is a new
   *              row and never an edit of the credit.
   *
   * ## The refusal that has no code path around it
   *
   * If the partner has already spent or withdrawn the money, `post` refuses:
   * `wallets_balance_non_negative` is a CHECK constraint, so there is no
   * `allowOverdraft` that would rescue this — the database would reject the row
   * regardless. That refusal is CORRECT and is left to surface. A wallet driven
   * negative is a debt the CRM has no concept of, no way to collect and no way
   * to show a partner; the honest outcome is that the desk is told this cannot
   * be recovered from the wallet and recovers it some other way.
   *
   * The accrual stays `confirmed` when that happens, because it IS confirmed —
   * money was paid and has not come back. Marking it `reversed` on a failed
   * debit would be the one lie this table must never tell.
   */
  async reverseAccrual(
    accrualId: string,
    reason: string,
  ): Promise<{ id: string; status: 'reversed'; movedMoney: boolean }> {
    return this.db.transaction(async (tx) => {
      /*
       * Locked before it is read. Two desks reversing the same accrual is the
       * obvious race, and the ledger's unique constraint would already absorb
       * the second debit — but the STATUS write below has no such guard, and a
       * lost update there would leave a reversed accrual reported as confirmed.
       */
      const [accrual] = await tx
        .select()
        .from(ibAccruals)
        .where(eq(ibAccruals.id, accrualId))
        .for('update')
        .limit(1);

      if (!accrual) throw new NotFoundError('Accrual not found.');

      /*
       * Idempotent rather than an error. A desk that double-submits, or retries
       * after a timeout, is asking for a state the row is already in — and the
       * ledger constraint means the debit cannot have been posted twice anyway.
       * Answering "done" is both true and the answer that stops them trying
       * again on a money screen.
       */
      if (accrual.status === 'reversed') {
        return { id: accrual.id, status: 'reversed' as const, movedMoney: false };
      }

      const paid = accrual.status === 'confirmed';

      if (paid) {
        /*
         * The exact mirror of the confirm credit — same beneficiary, same
         * wallet, same currency, negated. Read `confirmPending`'s note on why
         * `ibUserId` is not the beneficiary of a rebate: getting that wrong
         * here would debit the introducer for their client's rebate, which
         * balances perfectly and takes money from the wrong person.
         */
        const rebate = accrual.kind === 'rebate';

        await this.wallets.post(
          {
            userId: rebate ? accrual.clientUserId : accrual.ibUserId,
            currency: accrual.currency,
            kind: rebate ? 'main' : 'commission',
            amount: money(toDecimal(accrual.amount).negated()),
            /*
             * `adjustment`, not `commission`. The entry types are what every
             * report sums by, and a negative `commission` row would net against
             * real earnings — a partner's lifetime figure would quietly shrink
             * with no line explaining it. An adjustment is visible as its own
             * thing, which is what a clawback needs to be.
             */
            entryType: 'adjustment',
            /*
             * A DIFFERENT reference type from the credit, keyed on the same
             * accrual — see `LEDGER_REFERENCE.accrualReversal`. Reusing
             * `accrual` would make this look like a replay of the credit and be
             * dropped in silence.
             */
            referenceType: LEDGER_REFERENCE.accrualReversal,
            referenceId: accrual.id,
          },
          tx,
        );
      }

      await tx.update(ibAccruals).set({ status: 'reversed' }).where(eq(ibAccruals.id, accrual.id));

      this.logger.warn(
        `Accrual ${accrual.id} REVERSED (${accrual.kind}, ${accrual.amount} ${accrual.currency}, ` +
          `was ${accrual.status}): ${reason}`,
      );

      return { id: accrual.id, status: 'reversed' as const, movedMoney: paid };
    });
  }

  /**
   * Has this system ever credited a commission?
   *
   * This is what `earnings.engineLive` reports, and it is a READ rather than a
   * constant so the flag becomes true on its own the moment the pipeline first
   * pays somebody — with no code change and no chance of it being left false
   * while real money is moving.
   *
   * Deliberately "does any CONFIRMED accrual exist" rather than "is the code
   * deployed": the portal uses this to decide whether a zero means "you earned
   * nothing" or "nothing has been calculated yet", and only an actual payout
   * proves the second has stopped being the answer.
   */
  async isEngineLive(): Promise<boolean> {
    const [row] = await this.db
      .select({ id: ibAccruals.id })
      .from(ibAccruals)
      .where(eq(ibAccruals.status, 'confirmed'))
      .limit(1);
    return row !== undefined;
  }

  /**
   * The partners at and above `introducerId`, as a lookup for `resolveChain`.
   *
   * ## One recursive query, not one round-trip per hop
   *
   * This used to read the introducer, then read them and their parent together —
   * correct while the chain was capped at two and wrong the moment it was not.
   * The obvious repair is a loop of `SELECT`s, which is an N+1 on the money path
   * and puts a variable number of round-trips inside the accrual of every trade.
   *
   * A recursive CTE walks it server-side in one statement instead: start at the
   * introducer, follow `parent_ib_user_id` upward, stop at `MAX_CHAIN_DEPTH`.
   *
   * ## The `path` array is a CYCLE GUARD, and it is not redundant
   *
   * `resolveChain` has its own `seen` set and would terminate a cycle in the
   * result. That is too late: without this predicate the CTE itself would loop
   * inside Postgres, and a mis-assigned parent would hang the accrual rather
   * than skip it. The depth bound alone would cap it, but at
   * `MAX_CHAIN_DEPTH` wasted iterations per trade forever.
   *
   * A SUSPENDED partner is fetched rather than filtered out here. `resolveChain`
   * owns the rule that suspension breaks the chain, and filtering in SQL would
   * put half of it in the query and half in the pure function — where the
   * database's version would silently promote a suspended partner's parent from
   * depth 3 to depth 2 and pay them the wrong tier.
   */
  private async loadChain(db: Executor, introducerId: string): Promise<Map<string, ChainNode>> {
    const result = await db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT a.user_id, a.parent_ib_user_id, a.active, a.level,
               1 AS depth, ARRAY[a.user_id] AS path
          FROM ${ibAccounts} a
         WHERE a.user_id = ${introducerId}
        UNION ALL
        SELECT p.user_id, p.parent_ib_user_id, p.active, p.level,
               c.depth + 1, c.path || p.user_id
          FROM ${ibAccounts} p
          JOIN chain c ON p.user_id = c.parent_ib_user_id
         WHERE c.depth < ${MAX_CHAIN_DEPTH}
           AND NOT p.user_id = ANY(c.path)
      )
      SELECT user_id, parent_ib_user_id, active, level FROM chain
    `);

    /*
     * Raw SQL bypasses drizzle's column mappers, so these are the DATABASE's
     * names and types. All four are plain scalars — uuid, uuid|null, bool, uuid
     * — with no timestamp or numeric among them, so unlike the raw queries in
     * `transactions.service.ts` there is nothing here that needs parsing on the
     * way out.
     */
    const rows = result.rows as unknown as {
      user_id: string;
      parent_ib_user_id: string | null;
      active: boolean;
      level: number;
    }[];

    return new Map(
      rows.map((row) => [
        row.user_id,
        {
          userId: row.user_id,
          parentIbUserId: row.parent_ib_user_id,
          active: row.active,
          level: row.level,
        },
      ]),
    );
  }

  /**
   * The terms every earner in a chain is paid on, keyed by programme id.
   *
   * Read per event rather than cached: an operator editing a programme expects
   * the next trade to pay the new rate, and a cache here would make "when does
   * this take effect" a question with no answer anybody could state.
   *
   * Two queries rather than a join, and the reason is the empty case. A
   * `LEFT JOIN` onto the tiers returns one all-null row for a programme with no
   * tiers — a `rebate_only` programme, legitimately — and reassembling terms
   * from that means a null check on every row to avoid materialising a tier at
   * `depth: null`. Two reads keyed by id have no such row to misread, and both
   * are indexed lookups over at most `MAX_CHAIN_DEPTH` programmes.
   */
  /**
   * The commission ladder, keyed by rung — 0112.
   *
   * Replaced `loadPrograms`, which fetched one programme per earner plus their
   * tiers. A level carries its own single commission term and rebate term, so
   * there is no second table to join and no depth map to build: the row IS the
   * card.
   *
   * Read whole rather than filtered to the rungs in hand. `ib_max_levels` bounds
   * this to a couple of rows, so an IN list would cost more to construct than
   * the rows it saves.
   */
  private async loadLevels(db: Executor): Promise<Map<number, LevelTerms>> {
    const rows = await db.select().from(ibLevels);

    return new Map(
      rows.map((row) => [
        row.level,
        {
          id: row.id,
          level: row.level,
          enabled: row.enabled,
          commissionMode: row.commissionMode,
          commissionRate: row.commissionRate,
          /*
           * Passed only in the mode that reads it. Handing `calculate` an amount
           * on a percentage level would re-price the leg, because the presence
           * of the field is not what it branches on — the MODE is — but leaving
           * a stale figure visible on the terms object invites the next reader
           * to use it.
           */
          commissionAmountPerLot: row.commissionAmountPerLot ?? undefined,
          rebateMode: row.rebateMode,
          rebateRate: row.rebateRate,
          rebateAmountPerLot: row.rebateAmountPerLot ?? undefined,
          revenueBasis: row.revenueBasis,
        },
      ]),
    );
  }
}
