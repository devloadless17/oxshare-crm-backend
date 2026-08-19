import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppSettingsStore } from '../../store/app-settings.store';
import { tradingTermsFrom } from '../../common/trading-terms';
import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db, Executor } from '../../database/db';
import { ibAccounts, ibAccruals, ibLevels, users } from '../../database/schema';
import { LEDGER_REFERENCE, type LedgerReferenceType } from '../../database/ledger-reference';
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
  type ChainNode,
  type LevelTerms,
  type RevenueEvent,
} from './commission';

/**
 * The commission pipeline: accrue on revenue, confirm into the wallet.
 *
 *   accrueForDeposit  resolve chain → calculate → INSERT accruals (idempotent)
 *   confirmPending    pending accruals → locked wallet credit → mark confirmed
 *
 * ## Two steps, not one, and the split is the point
 *
 * A commission is EARNED when a client deposits and PAYABLE once that deposit
 * is settled and beyond reversal. Crediting the partner's wallet in the same
 * breath as the accrual would make every commission irreversible before the
 * revenue behind it was final — and a reversed deposit would leave a partner
 * holding money recoverable only by a compensating entry with no record of what
 * it compensates.
 *
 * So `accrueForDeposit` writes a `pending` row and moves no money. Nothing a
 * partner can spend exists until `confirmPending` runs.
 *
 * ## Every step is idempotent, deliberately
 *
 * These are called directly today and become queue handlers when BullMQ lands.
 * The logic is identical either way, which is the whole reason it is written
 * this way: at-least-once delivery is safe, and re-running the pipeline over
 * the same deposits changes no balance.
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
    private readonly config: ConfigService,
    private readonly settings: AppSettingsStore,
  ) {}

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
  /**
   * The broker's floor, read fresh on every accrual.
   *
   * Not cached: an operator who lowers this after noticing they are paying out
   * too much should see the next trade honour it, not wait out a TTL. One
   * indexed read of a single-row table against a calculation that already
   * touches four tables is not the cost worth optimising.
   */
  private async maxSharePct(): Promise<string> {
    const terms = tradingTermsFrom(await this.settings.getTrading());
    return terms.ibMaxRevenueSharePct;
  }

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
    lots: string;
    currency: string;
  }): Promise<number> {
    return await this.accrueForRevenue({
      sourceType: LEDGER_REFERENCE.deal,
      sourceId: deal.dealRowId,
      describe: `deal ${deal.ticket}`,
      clientUserId: deal.clientUserId,
      brokerRevenue: deal.brokerRevenue,
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
    /** The broker's own earning on this trade — commission plus swap. */
    brokerRevenue: string;
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

    const terms = await this.loadTerms(
      this.db,
      chain.map((entry) => entry.level),
    );

    const revenue: RevenueEvent = {
      grossAmount: event.brokerRevenue,
      currency: event.currency,
      source: 'deal',
      lots: event.lots,
    };

    const result = calculate(revenue, chain, terms, await this.maxSharePct());
    if (result.skippedReason) {
      this.logger.warn(
        `Commission partially skipped for ${event.describe}: ${result.skippedReason}`,
      );
    }
    if (result.accruals.length === 0) return 0;

    const plausible = checkPlausible(revenue, result.accruals);
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

    const inserted = await this.db
      .insert(ibAccruals)
      .values(
        result.accruals.map((accrual) => ({
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
          level: accrual.level,
          rateValue: terms.get(accrual.level)?.rateValue ?? '0',
          baseAmount: event.brokerRevenue,
          amount: accrual.amount,
          currency: event.currency,
        })),
      )
      .onConflictDoNothing({
        target: [ibAccruals.sourceType, ibAccruals.sourceId, ibAccruals.ibUserId],
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
   */
  async accrueForDeposit(
    deposit: {
      transactionId: string;
      clientUserId: string;
      amount: string;
      currency: string;
    },
    executor?: Executor,
  ): Promise<number> {
    const db = executor ?? this.db;

    /*
     * Attribution is read from the CLIENT, not passed in. `referred_by_ib_user_id`
     * is written once at registration and is permanent per client — taking it as
     * a parameter would let a caller credit a partner who never introduced them.
     */
    const [client] = await db
      .select({ referredBy: users.referredByIbUserId })
      .from(users)
      .where(eq(users.id, deposit.clientUserId))
      .limit(1);

    if (!client?.referredBy) return 0; // Not referred — nobody earns. Not an error.

    const chainNodes = await this.loadChain(db, client.referredBy);
    const chain = resolveChain(client.referredBy, (id) => chainNodes.get(id));
    if (chain.length === 0) return 0;

    const terms = await this.loadTerms(
      db,
      chain.map((entry) => entry.level),
    );

    const event: RevenueEvent = {
      grossAmount: deposit.amount,
      currency: deposit.currency,
      source: 'deposit',
    };

    const result = calculate(event, chain, terms, await this.maxSharePct());

    if (result.skippedReason) {
      /*
       * Logged rather than swallowed. "This level is per_lot and a deposit has
       * no lots" is a CONFIGURATION problem somebody must fix, and an empty
       * result with no explanation is indistinguishable from "nobody was owed
       * anything" — which is exactly the ambiguity the portal's `engineLive`
       * flag exists to prevent one layer up.
       */
      this.logger.warn(
        `Commission partially skipped for transaction ${deposit.transactionId}: ${result.skippedReason}`,
      );
    }

    if (result.accruals.length === 0) return 0;

    /*
     * The plausibility backstop, BEFORE anything is written.
     *
     * A rate entered as `70` meaning 70× rather than 70% would otherwise accrue
     * seventy times the deposit. Refusing outright — rather than clamping — is
     * deliberate: a clamped payout is a wrong number that looks deliberate, and
     * the deposit stays re-accruable once the rate is corrected because nothing
     * was written.
     */
    const plausible = checkPlausible(event, result.accruals);
    if (!plausible.ok) {
      this.logger.error(
        `Refusing commission for transaction ${deposit.transactionId}: ${plausible.reason}`,
      );
      return 0;
    }

    const inserted = await db
      .insert(ibAccruals)
      .values(
        result.accruals.map((accrual) => ({
          ibUserId: accrual.ibUserId,
          clientUserId: deposit.clientUserId,
          sourceType: LEDGER_REFERENCE.transaction,
          sourceId: deposit.transactionId,
          depth: accrual.depth,
          level: accrual.level,
          rateValue: terms.get(accrual.level)?.rateValue ?? '0',
          baseAmount: deposit.amount,
          amount: accrual.amount,
          currency: deposit.currency,
        })),
      )
      /*
       * The replay guard, in the DATABASE. A retried job, a redelivered webhook
       * and a double-clicked approval all land here and all become no-ops —
       * which a service-level "have I seen this transaction?" could not
       * guarantee, because every check-then-insert loses under concurrency.
       */
      .onConflictDoNothing({
        target: [ibAccruals.sourceType, ibAccruals.sourceId, ibAccruals.ibUserId],
      })
      .returning({ id: ibAccruals.id });

    return inserted.length;
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
        await this.db.transaction(async (tx) => {
          const posted = await this.wallets.post(
            {
              userId: accrual.ibUserId,
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
              kind: 'commission',
              amount: accrual.amount,
              entryType: 'commission',
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
              recipient: { kind: 'client', id: accrual.ibUserId },
              kind: 'commission.confirmed',
              params: {
                accrualId: accrual.id,
                amount: accrual.amount,
                currency: accrual.currency,
              },
              dedupeKey: `commission.confirmed:${accrual.id}`,
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
   * Fetched in ONE query rather than a walk of round-trips: the chain is at most
   * two deep, so both rows are known from the introducer's own `parent_ib_user_id`
   * after a single read of them together.
   */
  private async loadChain(db: Executor, introducerId: string): Promise<Map<string, ChainNode>> {
    const [introducer] = await db
      .select()
      .from(ibAccounts)
      .where(eq(ibAccounts.userId, introducerId))
      .limit(1);

    if (!introducer) return new Map();

    const wanted = [introducer.userId];
    if (introducer.parentIbUserId) wanted.push(introducer.parentIbUserId);

    const rows = await db.select().from(ibAccounts).where(inArray(ibAccounts.userId, wanted));

    return new Map(
      rows.map((row) => [
        row.userId,
        {
          userId: row.userId,
          parentIbUserId: row.parentIbUserId,
          active: row.active,
          level: row.level,
        },
      ]),
    );
  }

  /** The terms for exactly the rungs in play, keyed by level. */
  private async loadTerms(db: Executor, levels: number[]): Promise<Map<number, LevelTerms>> {
    if (levels.length === 0) return new Map();

    const rows = await db.select().from(ibLevels).where(inArray(ibLevels.level, levels));

    return new Map(
      rows.map((row) => [
        row.level,
        {
          level: row.level,
          rateValue: row.rateValue,
          enabled: row.enabled,
        },
      ]),
    );
  }
}
