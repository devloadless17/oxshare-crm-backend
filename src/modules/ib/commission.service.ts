import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db, Executor } from '../../database/db';
import { ibAccounts, ibAccrualBatches, ibAccruals, ibLevels, users } from '../../database/schema';
import { LEDGER_REFERENCE, type LedgerReferenceType } from '../../database/ledger-reference';
import { NotFoundError } from '../../common/errors/domain-errors';
import Decimal from 'decimal.js';
import { money, toDecimal } from '../wallet/money';
import { LIVE_REVENUE_FEED, isLiveRevenueFeed } from './revenue-feed';
import { AppSettingsStore } from '../../store/app-settings.store';
import { EmailService } from '../email/email.service';
import { tradingTermsFrom } from '../../common/trading-terms';
import { ALERT_KINDS, raiseAlert } from '../../common/logging/alerts';
import { WalletService } from '../wallet/wallet.service';
import { ClientVisibilityService } from '../../common/security/client-visibility.service';
import type { ClientScope } from '../../common/security/client-scope';
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
  type CommissionTypeTerms,
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
/*
 * `DEFAULT_HOLD_HOURS` was 24 here, and the reasoning was the reversal window
 * rather than the number: long enough that a bad deposit is caught by the
 * desk's daily rhythm before the money is spendable.
 *
 * That reasoning survives; the constant does not. The window is
 * `ib_commission_interval_seconds` now (0113), an admin setting rather than a
 * deploy, and its default of one hour is what the old 24h hold and the hourly
 * job produced together. See `holdSeconds` for what shortening it costs.
 */

@Injectable()
export class CommissionService implements CommissionAccrualPort {
  private readonly logger = new Logger(CommissionService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly wallets: WalletService,
    /** The partner's "commission credited" bell row, written with the credit. */
    @Inject(NOTIFICATION_DISPATCH) private readonly notifications: NotificationDispatchPort,
    /*
     * Back for ONE number in 0106 and THREE now (0113): the total payout
     * ceiling, the per-lot ceiling, and the commission interval that decides
     * both how long an accrual matures and how often the payout job runs.
     *
     * `ConfigService` stood beside it and is gone: `IB_COMMISSION_HOLD_HOURS`
     * was the last thing this class read from the environment, and the interval
     * setting replaced it.
     *
     * It left in 0104 with the four IB settings that each DUPLICATED the
     * Commission Programmes page. This one does the opposite — it bounds a
     * total no programme can see, because the earners on one trade may hold
     * different programmes. A per-programme ceiling would be blind to exactly
     * the thing worth bounding.
     */
    private readonly settings: AppSettingsStore,
    /*
     * For the per-run payout SUMMARY only — never per accrual.
     *
     * The per-accrual notification this replaced refused to mail at all, and it
     * was right to: "an hourly batch would mail a busy partner once per accrual
     * per hour". One message about one run has no such problem, which is what
     * made the email possible rather than what made it desirable.
     */
    private readonly emails: EmailService,
    /**
     * The by-id territory gate, for `reverseAccrual` alone.
     *
     * The shared one rather than four scoped lines here, for the reason its own
     * header gives: a copy that answers 403 instead of 404 is a client
     * enumeration oracle nobody notices in review because the others look right.
     *
     * LAST in the list on purpose: eight specs construct this class by hand with
     * positional arguments, so a parameter inserted in the middle rebinds every
     * one of them silently. Appending makes each update an added argument rather
     * than a reshuffle.
     */
    private readonly visibility: ClientVisibilityService,
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
   * How long an accrual is held before it may be confirmed — SECONDS.
   *
   * ## It is a SETTING again (0113), and it is the same number as the job's
   *
   * This was `IB_COMMISSION_HOLD_HOURS` from 0104: a column, then an
   * environment variable, on the reasoning that commission is configured on
   * one page and a second screen deciding partner pay is a "two places"
   * problem. That reasoning holds for AMOUNTS and does not reach this — how
   * OFTEN somebody is paid is not how MUCH, and the IB Levels page has no
   * opinion about it.
   *
   * What made the env variable untenable is that it was never the whole
   * answer. The delay a partner actually experiences is this window PLUS the
   * job's period, and shortening either alone changes almost nothing: a
   * one-minute run against a 24-hour hold still pays nothing for a day. Both
   * now read `ib_commission_interval_seconds`, so the configured number IS the
   * delay.
   *
   * ⚠️ SHORTENING THIS REMOVES A REVIEW WINDOW, and that is its whole purpose.
   * 24 hours existed so a bad deposit is caught by the desk's daily rhythm
   * BEFORE the commission on it is spendable. At 60s the money is in a
   * partner's wallet before anybody could look, and a reversal then claws back
   * a balance they may already have moved.
   *
   * ASYNC again, because it reads the settings row. It was made synchronous in
   * 0104 when there was nothing left to await; there is again.
   */
  private async holdSeconds(): Promise<number> {
    /*
     * `tradingTermsFrom` normalises a bad or missing row to the DEFAULT rather
     * than to the minimum — deliberately, and this is the call site that makes
     * it matter. The failure mode of a corrupt row must not be "pay every
     * commission a minute after the trade", which is the one outcome nobody
     * would choose on purpose.
     */
    return tradingTermsFrom(await this.settings.getTrading()).ibCommissionIntervalSeconds;
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
  /*
   * ⚠️ THIS METHOD CANNOT SEE WHETHER THE ACCOUNT IS DEMO, AND DOES NOT CHECK.
   *
   * It receives a client and an amount, never an account, so the demo gate for
   * this path lives in `PositionsService.close` — which refuses before calling
   * here. That is sound today because `close` is the only caller AND the feed
   * constant below refuses anyway.
   *
   * It stops being sound the moment somebody flips `LIVE_REVENUE_FEED` to
   * `position` and adds a second caller: the deal path keeps its own
   * `environment !== 'live'` check inside the loop, and this one would have
   * nothing. Whoever makes that change must either take the account here and
   * check it, or prove `close` is still the only door.
   */
  async accrueForClosedPosition(position: {
    positionId: string;
    clientUserId: string;
    lots: string;
    currency: string;
    /** The traded product's rate card — see `RevenueEvent.terms`. */
    terms: CommissionTypeTerms | null | undefined;
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
        lots: position.lots,
        terms: position.terms,
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
    /** Lots traded — what every term is priced against. */
    lots: string;
    currency: string;
    /**
     * The traded product's rate card (0140) — see `RevenueEvent.terms` for the
     * three states and why an account with no product is REFUSED rather than
     * paid nothing.
     */
    terms: CommissionTypeTerms | null | undefined;
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
      lots: deal.lots,
      terms: deal.terms,
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
    /** Lots traded — what every term is priced against. */
    lots: string;
    currency: string;
    /** The traded product's rate card — see `RevenueEvent.terms`. */
    terms: CommissionTypeTerms | null | undefined;
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
      currency: event.currency,
      source: 'deal',
      lots: event.lots,
      terms: event.terms,
    };

    const result = calculate(revenue, chain, levels);
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
        { source: event.sourceType, lots: event.lots, currency: event.currency },
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
        commissionTypeId: accrual.commissionTypeId ?? null,
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
              commissionTypeId: result.rebate.commissionTypeId ?? null,
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
          /* Which rate card the share was taken of — the other half of the terms (0140). */
          commissionTypeId: accrual.commissionTypeId ?? null,
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
    const payableFrom = new Date(Date.now() - (await this.holdSeconds()) * 1_000);

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

    /*
     * What each person was paid across this whole run, keyed by recipient AND
     * kind — a partner who is also somebody's client can earn commission and
     * receive a rebate in the same run, and those are two different sentences
     * pointing at two different screens.
     *
     * Totals are summed with decimal.js rather than by adding numbers: these
     * are money (§6.1), and a run of a thousand accruals is a thousand chances
     * for float error to make the notification disagree with the wallet.
     */
    const payouts = new Map<
      string,
      {
        recipientId: string;
        kind: 'commission' | 'rebate';
        total: Decimal;
        count: number;
        currency: string;
      }
    >();

    /*
     * @param accrualCount how many TRADES this amount covers.
     *
     * ⚠️ Passed in rather than incremented by one per call, and that is not
     * cosmetic. Before 0116 each call carried one accrual, so `count += 1` was
     * right by accident. Now one call carries a whole batch — so incrementing by
     * one told a partner paid across forty trades that they had earned on "1
     * trade", while the amount beside it was the sum of all forty.
     *
     * A notification whose two numbers disagree is worse than one with no count
     * at all: it reads as a rate nobody can reproduce.
     */
    const recordPayout = (
      recipientId: string,
      kind: 'commission' | 'rebate',
      amount: string,
      currency: string,
      accrualCount: number,
    ): void => {
      const key = `${recipientId}:${kind}:${currency}`;
      const existing = payouts.get(key);
      if (existing) {
        existing.total = existing.total.plus(amount);
        existing.count += accrualCount;
        return;
      }
      payouts.set(key, {
        recipientId,
        kind,
        total: new Decimal(amount),
        count: accrualCount,
        currency,
      });
    };

    /*
     * ── GROUPED BEFORE ANYTHING IS POSTED (0116) ─────────────────────────────
     *
     * One credit per (beneficiary, wallet kind, currency), not one per accrual.
     *
     * Confirming every minute made the old shape unusable: one ledger row per
     * closed trade per earner, 252 rows across four wallets in a day of
     * testing, and a client's wallet history reduced to a column of two-dollar
     * credits. The money was right and the screen was useless.
     *
     * The GROUPING KEY is the beneficiary plus the wallet kind plus the
     * currency, and every part earns its place: a partner who is also somebody's
     * client receives commission into their commission wallet and a rebate into
     * their main one, and those must never merge into a single line.
     */
    const groups = new Map<
      string,
      {
        userId: string;
        walletKind: 'main' | 'commission';
        kind: 'commission' | 'rebate';
        currency: string;
        total: Decimal;
        accruals: typeof pending;
      }
    >();

    for (const accrual of pending) {
      /* Decides the beneficiary, the wallet, the ledger type and who is told. */
      const rebate = accrual.kind === 'rebate';
      /*
       * `ibUserId` on a rebate row is the partner whose RUNG produced it —
       * attribution, not entitlement. Reading it as the beneficiary would pay
       * the introducer their own client's rebate, and it would balance
       * perfectly while doing it.
       */
      const userId = rebate ? accrual.clientUserId : accrual.ibUserId;
      if (!userId) {
        failed += 1;
        this.logger.error(`Accrual ${accrual.id} has no beneficiary; leaving it pending.`);
        continue;
      }

      const walletKind = rebate ? ('main' as const) : ('commission' as const);
      const key = `${userId}:${walletKind}:${accrual.currency}`;
      const existing = groups.get(key);
      if (existing) {
        existing.total = existing.total.plus(accrual.amount);
        existing.accruals.push(accrual);
        continue;
      }
      groups.set(key, {
        userId,
        walletKind,
        kind: rebate ? 'rebate' : 'commission',
        currency: accrual.currency,
        total: toDecimal(accrual.amount),
        accruals: [accrual],
      });
    }

    for (const group of groups.values()) {
      try {
        await this.db.transaction(async (tx) => {
          /*
           * The wallet is resolved FIRST, because the batch row references it
           * and the credit has to land in the same one. `ensure` opens a
           * commission wallet lazily — a partner who has never been paid has
           * none, which is the honest state the portal renders as "nothing
           * credited yet".
           */
          const wallet = await this.wallets.getOrCreateWallet(
            group.userId,
            group.currency,
            group.walletKind,
            tx,
          );

          /*
           * The BATCH row, written before the credit so the ledger entry has a
           * stable reference id to key on.
           *
           * That id is what makes this idempotent:
           * `ledger_entries_wallet_reference_uq` absorbs a replay. It could not
           * be an accrual id — the entry no longer belongs to one — and it must
           * not be a synthesised key like "wallet+minute", because a key that is
           * merely PROBABLY unique is one that eventually drops a real payout in
           * silence.
           */
          const [batch] = await tx
            .insert(ibAccrualBatches)
            .values({
              walletId: wallet.id,
              kind: group.kind,
              currency: group.currency,
              amount: money(group.total),
              accrualCount: group.accruals.length,
            })
            .returning();

          const posted = await this.wallets.post(
            {
              userId: group.userId,
              currency: group.currency,
              /*
               * The COMMISSION wallet for earnings, the MAIN wallet for a
               * rebate. A rebate is the client's own money coming back rather
               * than an earning, and putting it in a commission wallet would
               * both mislabel it and strand it behind a transfer the client has
               * no reason to make.
               */
              kind: group.walletKind,
              amount: money(group.total),
              entryType: group.kind === 'rebate' ? 'rebate' : 'commission',
              referenceType: LEDGER_REFERENCE.accrualBatch,
              referenceId: batch.id,
            },
            tx,
          );

          /*
           * Every accrual in the group marked in ONE statement, still guarded on
           * `status = 'pending'` so two workers racing the same queue cannot
           * both pass — the second updates nothing, and `post` has already
           * returned the original entry rather than writing a second credit.
           *
           * `ledgerEntryId` now points at the BATCH's entry, so several accruals
           * share one. It was never unique and nothing assumed it was: it is the
           * link from "what was earned" to "how it was paid", and that link is
           * still correct when one payment covered several earnings.
           */
          await tx
            .update(ibAccruals)
            .set({
              status: 'confirmed',
              ledgerEntryId: posted.entry.id,
              batchId: batch.id,
              confirmedAt: new Date(),
            })
            .where(
              and(
                inArray(
                  ibAccruals.id,
                  group.accruals.map((a) => a.id),
                ),
                eq(ibAccruals.status, 'pending'),
              ),
            );
        });

        confirmed += group.accruals.length;
        recordPayout(
          group.userId,
          group.kind,
          money(group.total),
          group.currency,
          group.accruals.length,
        );
      } catch (error) {
        /*
         * Counted and logged, never rethrown. One wallet refusing a credit must
         * not stop every other partner being paid in the same run; the rows stay
         * `pending` and the next run retries them.
         *
         * The blast radius is wider than it was — a whole group rather than one
         * accrual — but it is the same rows either way: they were going to be
         * credited together and they stay pending together.
         */
        failed += group.accruals.length;
        this.logger.error(
          `Could not credit ${group.accruals.length} ${group.kind} accrual(s) to ` +
            `${group.userId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (confirmed > 0 || failed > 0) {
      this.logger.log(`Commission confirm run: ${confirmed} credited, ${failed} left pending.`);
    }
    await this.notifySummaries(payouts);

    return { confirmed, failed, held };
  }

  /**
   * ONE notification per person per run, not one per accrual.
   *
   * ## Why this is not inside the loop
   *
   * It cannot be. A summary is a statement about the whole run — "you earned
   * $148.08 across 188 trades" — and that sentence does not exist until the
   * last accrual has been credited.
   *
   * The cost is that these rows are NOT in the credit's transaction. That is
   * the right trade: a bell row is a convenience, the credit is the money, and
   * the ledger is the record either way. A crash between the two loses a
   * notification about money that is already in the wallet and visible on the
   * earnings screen — where the old shape would have lost nothing but flooded
   * the bell on every ordinary run.
   *
   * ## The dedupe key is the RUN, not the accrual
   *
   * Two schedulers racing the same queue would otherwise both summarise their
   * own share and send two rows. Keying on the recipient, the kind and the
   * minute collapses that to one — the same at-least-once assumption the ledger
   * credit makes, expressed in the units a person reads.
   *
   * ## An EMAIL goes with it, which the per-accrual version could never do
   *
   * That version explicitly refused to mail: "an hourly batch would mail a busy
   * partner once per accrual per hour". A summary has no such problem — it is
   * one message about one run — so the thing a partner actually wants to know,
   * that they have been paid, now reaches them somewhere other than a bell they
   * have to be looking at.
   *
   * Failures are swallowed per recipient. Nobody's notification failing may
   * stop anybody else's, and none of it may undo a credit that has committed.
   */
  private async notifySummaries(
    payouts: Map<
      string,
      {
        recipientId: string;
        kind: 'commission' | 'rebate';
        total: Decimal;
        count: number;
        currency: string;
      }
    >,
  ): Promise<void> {
    /* Whole minutes, so a run straddling a second boundary still collapses. */
    const window = new Date().toISOString().slice(0, 16);

    for (const payout of payouts.values()) {
      const amount = payout.total.toFixed(8);
      try {
        await this.notifications.notify({
          recipient: { kind: 'client', id: payout.recipientId },
          kind: payout.kind === 'rebate' ? 'rebate.credited' : 'commission.confirmed',
          params: {
            amount,
            currency: payout.currency,
            /*
             * How many trades it covers, so the reader can tell one payment
             * from a day's worth. The screen renders it; a consumer that does
             * not know the field ignores it, which is the open-params contract
             * `NotificationEvent` already carries.
             */
            count: String(payout.count),
          },
          dedupeKey: `${payout.kind}.summary:${payout.recipientId}:${payout.currency}:${window}`,
        });
      } catch (error) {
        this.logger.warn(
          `Could not write the ${payout.kind} summary for ${payout.recipientId}; the money is ` +
            `credited and visible regardless: ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
      }

      /*
       * The EMAIL, reusing the wallet-credit template rather than inventing a
       * second one: it already says "money reached your wallet, here is how
       * much and why", which is exactly this message. The `reason` line is
       * where the summary reads as a summary.
       *
       * `EmailService.send` swallows its own failures by contract, so reaching
       * the catch means the user LOOKUP failed. Either way the money stands and
       * is visible on the screen the notification links to.
       */
      try {
        const [recipient] = await this.db
          .select({ email: users.email, firstName: users.firstName })
          .from(users)
          .where(eq(users.id, payout.recipientId))
          .limit(1);

        if (recipient) {
          await this.emails.sendWalletCreditEmail(
            recipient.email,
            recipient.firstName,
            amount,
            payout.currency,
            payout.kind === 'rebate'
              ? `Trading rebate on ${payout.count} closed trade(s)`
              : `Partner commission on ${payout.count} closed trade(s)`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Could not email the ${payout.kind} summary for ${payout.recipientId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
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
    scope: ClientScope,
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
       * TERRITORY, on the person whose wallet this debits.
       *
       * This route carried `@NotClientScoped`, and the reason was sound as far
       * as it went: the scope predicates in `IbStore` filter on
       * `ib_accruals.ib_user_id`, which on a REBATE row is the partner whose
       * rung produced it rather than the person being debited — "a check that
       * reads the wrong column". That rules out one WRONG fix. It was then
       * taken as ruling out scoping altogether, so `ib.commissions.reverse`
       * became the only gate and any holder of it could take money out of any
       * client's wallet on the platform.
       *
       * The right column is the one the debit itself uses, twenty lines down:
       * the client on a rebate, the partner on a commission. Asked here, once,
       * from the same expression — so the check cannot drift from the write.
       *
       * ⚠️ AFTER the row is read, which departs from `assertVisible`'s own "call
       * it FIRST" instruction, and has to: who is debited is a property of the
       * row. Nothing from the accrual has reached a log, a message or the
       * response by this point, so the reason behind that instruction is
       * satisfied even though its letter is not.
       *
       * BEFORE the idempotency short-circuit below, deliberately. Answering
       * "already reversed" to an administrator who may not see the beneficiary
       * would confirm the accrual exists — the same oracle the 404-not-403 rule
       * exists to close.
       */
      await this.visibility.assertVisible(
        accrual.kind === 'rebate' ? accrual.clientUserId : accrual.ibUserId,
        scope,
        () => new NotFoundError('Accrual not found.'),
      );

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
          commissionShare: row.commissionShare,
          rebateShare: row.rebateShare,
        },
      ]),
    );
  }
}
