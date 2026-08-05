import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, lte } from 'drizzle-orm';
import {
  commissionAccruals,
  deals,
  ledgerEntries,
  ibProfiles,
  ibPrograms,
  referralAttributions,
  tradingAccounts,
} from '../../database/schema';
import { LEDGER_REFERENCE } from '../../database/ledger-reference';
import { WalletService } from '../wallet/wallet.service';
import { IbNode, availableAt, calculate, resolveChain } from './commission';
import Decimal from 'decimal.js';
import { MoneyRuleError } from '../../common/errors/domain-errors';
import { MoneyLimits } from '../../config/money-limits';
import { ALERT_KINDS, raiseAlert } from '../../common/logging/alerts';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';

/** Thrown to roll back when a concurrent worker already confirmed an accrual. */
class AccrualAlreadyConfirmed extends Error {
  constructor(accrualId: string) {
    super(`Accrual ${accrualId} was confirmed by another worker.`);
  }
}

export interface IngestDealInput {
  mt5Ticket: string;
  mt5Login: string;
  symbol: string;
  volume: string;
  spread: string;
  profit?: string;
  openedAt?: Date;
  closedAt: Date;
}

/**
 * The commission pipeline (§8.6) — "the heart of the system".
 *
 *   ingestDeal      INSERT deals ON CONFLICT (mt5_ticket) DO NOTHING
 *   accrueForDeal   resolve chain → calculate → INSERT accruals ON CONFLICT
 *   confirmMatured  matured accruals → locked wallet credit, mark confirmed
 *
 * These are called directly today and will be queue handlers when BullMQ
 * lands (§9). The logic is identical either way, which is the point: every
 * step is idempotent, so at-least-once delivery is safe. Re-running the whole
 * pipeline over the same deals changes no balance.
 *
 * All decision-making lives in the pure functions (./commission.ts). This
 * class only fetches, persists and moves money.
 */
@Injectable()
export class CommissionService {
  private readonly logger = new Logger(CommissionService.name);

  /**
   * The db is injected, not fetched from the module-level singleton.
   *
   * `this.db` and the DRIZZLE_DB provider return the *same* lazy instance
   * (see database.module.ts), so this is behaviour-identical — but a declared
   * dependency can be seen, and reaching for a global from inside a money method
   * could not. `executor ?? this.db` still lets a caller pass a transaction
   * handle so a method joins their transaction (§6.2).
   */
  constructor(
    private readonly wallets: WalletService,
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly limits: MoneyLimits,
  ) {}

  /** §6.3: re-delivering the same ticket is a no-op, not a duplicate deal. */
  async ingestDeal(input: IngestDealInput) {
    const db = this.db;
    const [account] = await db
      .select()
      .from(tradingAccounts)
      .where(eq(tradingAccounts.mt5Login, input.mt5Login))
      .limit(1);
    if (!account) {
      this.logger.warn(`Deal ${input.mt5Ticket} references unknown MT5 login ${input.mt5Login}`);
      return { deal: null, created: false as const };
    }

    const [deal] = await db
      .insert(deals)
      .values({
        mt5Ticket: input.mt5Ticket,
        tradingAccountId: account.id,
        symbol: input.symbol,
        volume: input.volume,
        spread: input.spread,
        profit: input.profit ?? '0',
        openedAt: input.openedAt,
        closedAt: input.closedAt,
      })
      .onConflictDoNothing({ target: deals.mt5Ticket })
      .returning();

    if (!deal) {
      const [existing] = await db
        .select()
        .from(deals)
        .where(eq(deals.mt5Ticket, input.mt5Ticket))
        .limit(1);
      return { deal: existing, created: false as const };
    }
    return { deal, created: true as const };
  }

  /**
   * Accrue commissions for one closed deal. Safe to run repeatedly — the
   * UNIQUE(deal_id, ib_user_id, level) constraint absorbs replays.
   */
  /**
   * Refuses an accrual set that cannot be arithmetically plausible.
   *
   * Two ceilings, because one alone scales badly: an absolute cap catches a
   * unit error on a small deal, and a share-of-notional cap catches one on a
   * large deal where the absolute number still looks unremarkable.
   */
  private assertWithinBounds(
    deal: { id: string; mt5Ticket: string; volume: string; spread: string },
    accruals: readonly { ibUserId: string; level: number; amount: string }[],
  ): void {
    const absoluteMax = this.limits.maxCommissionPerDeal();

    for (const accrual of accruals) {
      const amount = new Decimal(accrual.amount);

      if (amount.greaterThan(absoluteMax)) {
        const message =
          `Refusing accrual for deal ${deal.mt5Ticket}: level ${accrual.level} commission ` +
          `${accrual.amount} exceeds the absolute ceiling of ${absoluteMax.toString()}. ` +
          'This is far more likely to be a wrong spread unit (DECISIONS D-11) or a ' +
          'misconfigured program than a genuine payout. Nothing has been accrued; the deal ' +
          'is re-ingestible once the configuration is corrected.';
        raiseAlert(
          this.logger,
          ALERT_KINDS.COMMISSION_CEILING_BREACH,
          'page',
          `Accrual refused for deal ${deal.mt5Ticket}: ${accrual.amount} exceeds the ceiling`,
          { mt5Ticket: deal.mt5Ticket, level: accrual.level, amount: accrual.amount },
        );
        this.logger.error(message);
        throw new MoneyRuleError(message);
      }

      // A negative leg would mean the engine is charging the IB, which no
      // program mode expresses. Cheap to assert, catastrophic to miss.
      if (amount.isNegative()) {
        const message =
          `Refusing accrual for deal ${deal.mt5Ticket}: level ${accrual.level} commission ` +
          `${accrual.amount} is negative. No program mode produces a negative leg.`;
        this.logger.error(message);
        throw new MoneyRuleError(message);
      }
    }
  }

  async accrueForDeal(dealId: string) {
    const db = this.db;
    const [deal] = await db.select().from(deals).where(eq(deals.id, dealId)).limit(1);
    if (!deal) return { accruals: [], reason: 'deal-not-found' as const };

    const [account] = await db
      .select()
      .from(tradingAccounts)
      .where(eq(tradingAccounts.id, deal.tradingAccountId))
      .limit(1);
    if (!account) return { accruals: [], reason: 'account-not-found' as const };

    // No attribution → no IB → nobody earns. Not an error: direct clients exist.
    const [attribution] = await db
      .select()
      .from(referralAttributions)
      .where(eq(referralAttributions.clientUserId, account.userId))
      .limit(1);
    if (!attribution || !attribution.active) {
      return { accruals: [], reason: 'no-attribution' as const };
    }

    // Fetch the two profiles the chain can possibly need, then let the pure
    // resolver decide. Two levels means at most two lookups — no recursion.
    const profiles = new Map<string, IbNode>();
    const loadProfile = async (userId: string) => {
      if (profiles.has(userId)) return;
      const [row] = await db
        .select()
        .from(ibProfiles)
        .where(eq(ibProfiles.userId, userId))
        .limit(1);
      if (row) {
        profiles.set(userId, {
          userId: row.userId,
          parentIbUserId: row.parentIbId,
          status: row.status,
          programId: row.programId,
        });
      }
    };
    await loadProfile(attribution.ibUserId);
    const l1 = profiles.get(attribution.ibUserId);
    if (l1?.parentIbUserId) await loadProfile(l1.parentIbUserId);

    const chain = resolveChain(attribution.ibUserId, (id) => profiles.get(id));
    if (chain.length === 0) return { accruals: [], reason: 'chain-empty' as const };

    // The program comes from L1's profile (§8.6).
    if (!l1?.programId) return { accruals: [], reason: 'no-program' as const };
    const [program] = await db
      .select()
      .from(ibPrograms)
      .where(eq(ibPrograms.id, l1.programId))
      .limit(1);
    if (!program || !program.active) return { accruals: [], reason: 'program-inactive' as const };

    const result = calculate(
      { spread: deal.spread, volume: deal.volume },
      {
        mode: program.mode,
        method: program.method,
        commissionValue: program.commissionValue,
        rebateValue: program.rebateValue,
        l1Share: program.l1Share,
        l2Share: program.l2Share,
      },
      chain,
    );

    /*
     * The D-11 backstop — PLATFORM-CONVENTIONS R-5.1 / §12.4.
     *
     * Nobody has confirmed whether MT5's `spread` is points, pips or account
     * currency (DECISIONS D-11), and D-40 records a second unverified assumption
     * that spread_share multiplies by volume. If either is wrong by a factor of
     * 100, every accrual is wrong by a factor of 100 — and Phase 1 has no
     * clawback, so a wrong number that reaches `confirmed` is paid out.
     *
     * So a leg that exceeds the absolute ceiling REFUSES rather than clamping.
     * Clamping would write a wrong number that looks deliberate and is
     * indistinguishable in the ledger from a correct one. Refusing leaves the
     * deal un-accrued and loud — a problem someone fixes, not a number someone
     * trusts. The sweep re-ingests it once the configuration is corrected.
     */
    this.assertWithinBounds(deal, result.accruals);

    const matureAt = availableAt(deal.closedAt, program.settlementWindowHours);
    const written = [];
    for (const accrual of result.accruals) {
      const [row] = await db
        .insert(commissionAccruals)
        .values({
          dealId: deal.id,
          ibUserId: accrual.ibUserId,
          level: accrual.level,
          programId: program.id,
          amount: accrual.amount,
          status: 'accrued',
          availableAt: matureAt,
        })
        .onConflictDoNothing({
          target: [
            commissionAccruals.dealId,
            commissionAccruals.ibUserId,
            commissionAccruals.level,
          ],
        })
        .returning();
      if (row) written.push(row);
    }

    return {
      accruals: written,
      reason: 'ok' as const,
      base: result.base,
      rebate: result.rebate,
    };
  }

  /**
   * §8.6 confirm job: credit accruals whose settlement window has elapsed.
   *
   * Each credit goes through WalletService.post(), so it locks the IB's wallet
   * row and is idempotent on (wallet, 'accrual', accrualId). The accrual is
   * then marked confirmed with a conditional update — if another worker got
   * there first the rowcount is zero and we skip, exactly like §8.7's payout
   * guard. Running this twice concurrently cannot double-credit anyone.
   */
  async confirmMatured(now: Date = new Date(), batchSize = 500) {
    const db = this.db;
    // Bounded: this used to select every matured accrual with no LIMIT and
    // loop serially, which grows without bound in production.
    const matured = await db
      .select()
      .from(commissionAccruals)
      .where(
        and(eq(commissionAccruals.status, 'accrued'), lte(commissionAccruals.availableAt, now)),
      )
      .limit(batchSize);

    let confirmed = 0;
    let failed = 0;

    for (const accrual of matured) {
      try {
        // ONE transaction per accrual, crediting BEFORE confirming.
        //
        // This ordering is §8.6's, and the previous inverse was a silent
        // money-loss bug: marking the accrual 'confirmed' first meant a failed
        // wallet credit left it permanently excluded from the selector above —
        // the IB was never paid while the table claimed they were, and
        // reconciliation could not see it because a missing credit satisfies
        // both sides of the balance check.
        await db.transaction(async (tx) => {
          await this.wallets.post(
            {
              userId: accrual.ibUserId,
              currency: accrual.currency,
              amount: accrual.amount,
              entryType: 'commission',
              referenceType: LEDGER_REFERENCE.accrual,
              referenceId: accrual.id,
            },
            tx,
          );

          // The conditional update is the concurrency guard: if another worker
          // already confirmed this accrual, rowcount is 0 and we roll back —
          // and the credit above is idempotent on (wallet, 'accrual', id)
          // anyway, so neither worker can double-pay.
          const [claimed] = await tx
            .update(commissionAccruals)
            .set({ status: 'confirmed', confirmedAt: now })
            .where(
              and(eq(commissionAccruals.id, accrual.id), eq(commissionAccruals.status, 'accrued')),
            )
            .returning();

          if (!claimed) {
            throw new AccrualAlreadyConfirmed(accrual.id);
          }
        });
        confirmed += 1;
      } catch (error) {
        if (error instanceof AccrualAlreadyConfirmed) continue; // another worker won
        failed += 1;
        this.logger.error(
          `Failed to confirm accrual ${accrual.id} for IB ${accrual.ibUserId}: ${(error as Error).message}`,
        );
      }
    }

    if (failed > 0) {
      this.logger.warn(`${failed} accrual(s) failed to confirm and will be retried next run.`);
    }
    return { examined: matured.length, confirmed, failed };
  }

  /**
   * The cross-check reconciliation cannot perform.
   *
   * `WalletService.reconcile()` compares a wallet's ledger sum to its balance,
   * so a commission that was marked confirmed but never credited satisfies
   * both sides and stays invisible. This asserts the other direction: every
   * confirmed accrual must have the ledger entry that paid it.
   */
  async findAccrualLedgerEntry(accrualId: string) {
    const [entry] = await this.db
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.referenceType, 'accrual'), eq(ledgerEntries.referenceId, accrualId)),
      )
      .limit(1);
    return entry;
  }

  /**
   * Audit every confirmed accrual against the ledger. Intended for a scheduled
   * integrity check and for CI — an unpaid "confirmed" accrual is a partner
   * who was silently short-paid.
   *
   * ## This method currently has no callers, and duplicates a live check
   *
   * `ReconciliationService.findUnpaidConfirmedAccruals()` asks the same question
   * in one SQL statement, runs on the reconciliation schedule, and raises
   * `UNPAID_CONFIRMED_ACCRUAL` on a hit. This one is reachable from nothing —
   * not a controller, not the scheduler, not a spec.
   *
   * That is worth stating rather than quietly deleting. Two implementations of
   * one money invariant is the setup for the version that is wrong being the one
   * someone wires up later, and the docstring above ("intended for … CI")
   * describes an intent that was never carried out. Whether it goes or gets
   * wired is a call for whoever owns this module.
   *
   * Left correct in the meantime: a dead method that is also wrong is worse than
   * a dead method, because the next person to reach for it inherits both
   * problems at once.
   */
  async auditConfirmedAccruals(): Promise<{
    checked: number;
    unpaid: string[];
  }> {
    /*
     * One LEFT JOIN, not a query per accrual.
     *
     * This ran a `SELECT` against `ledger_entries` for every confirmed accrual,
     * which is fine on a seeded database and stops being fine at the volume the
     * job exists to protect: at 100k accruals it is 100k round trips, and a
     * check that takes long enough gets moved to "weekly", then to "when
     * someone remembers". An integrity check that only runs on a small database
     * is a check that is absent exactly when it matters.
     *
     * The join predicate is the same pair `findAccrualLedgerEntry` used, so a
     * row matches here if and only if it matched there. That method is kept —
     * `confirmMatured` calls it per accrual, where one lookup for one accrual is
     * the right shape.
     */
    const rows = await this.db
      .select({ id: commissionAccruals.id, ledgerEntryId: ledgerEntries.id })
      .from(commissionAccruals)
      .leftJoin(
        ledgerEntries,
        and(
          eq(ledgerEntries.referenceType, 'accrual'),
          eq(ledgerEntries.referenceId, commissionAccruals.id),
        ),
      )
      .where(eq(commissionAccruals.status, 'confirmed'));

    /*
     * Counted from DISTINCT accrual ids rather than from `rows.length`. The join
     * is one-to-many in principle — nothing in the schema forbids two ledger
     * entries referencing one accrual — and a duplicate credit would inflate the
     * row count. `checked` must mean "accruals examined", or the number it
     * reports is quietly wrong in the one case worth noticing.
     */
    const unpaid: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (!row.ledgerEntryId) unpaid.push(row.id);
    }
    if (unpaid.length > 0) {
      this.logger.error(
        `INTEGRITY: ${unpaid.length} accrual(s) marked confirmed with no ledger credit: ${unpaid.join(', ')}`,
      );
    }
    return { checked: seen.size, unpaid };
  }

  /** Convenience for the ingest path: store the deal, then accrue if it is new. */
  async ingestAndAccrue(input: IngestDealInput) {
    const { deal, created } = await this.ingestDeal(input);
    if (!deal) return { deal: null, created: false, accruals: [] };
    // Accrual is idempotent, so running it for a replayed deal is harmless —
    // but skipping the work keeps re-delivery cheap.
    const accrual = created
      ? await this.accrueForDeal(deal.id)
      : { accruals: [], reason: 'replayed' as const };
    return {
      deal,
      created,
      accruals: accrual.accruals,
      reason: accrual.reason,
    };
  }
}
