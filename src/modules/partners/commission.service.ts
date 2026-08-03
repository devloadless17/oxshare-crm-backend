import { Injectable, Logger } from '@nestjs/common';
import { and, eq, lte } from 'drizzle-orm';
import { getDb } from '../../database/db';
import {
  commissionAccruals,
  deals,
  ibProfiles,
  ibPrograms,
  referralAttributions,
  tradingAccounts,
} from '../../database/schema';
import { WalletService } from '../wallet/wallet.service';
import { IbNode, availableAt, calculate, resolveChain } from './commission';

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

  constructor(private readonly wallets: WalletService) {}

  /** §6.3: re-delivering the same ticket is a no-op, not a duplicate deal. */
  async ingestDeal(input: IngestDealInput) {
    const db = getDb();
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
  async accrueForDeal(dealId: string) {
    const db = getDb();
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
          target: [commissionAccruals.dealId, commissionAccruals.ibUserId, commissionAccruals.level],
        })
        .returning();
      if (row) written.push(row);
    }

    return { accruals: written, reason: 'ok' as const, base: result.base, rebate: result.rebate };
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
  async confirmMatured(now: Date = new Date()) {
    const db = getDb();
    const matured = await db
      .select()
      .from(commissionAccruals)
      .where(
        and(eq(commissionAccruals.status, 'accrued'), lte(commissionAccruals.availableAt, now)),
      );

    let confirmed = 0;
    for (const accrual of matured) {
      const [claimed] = await db
        .update(commissionAccruals)
        .set({ status: 'confirmed', confirmedAt: now })
        .where(
          and(
            eq(commissionAccruals.id, accrual.id),
            eq(commissionAccruals.status, 'accrued'), // ← the guard
          ),
        )
        .returning();
      if (!claimed) continue; // another worker confirmed it first

      await this.wallets.post({
        userId: accrual.ibUserId,
        currency: accrual.currency,
        amount: accrual.amount,
        entryType: 'commission',
        referenceType: 'accrual',
        referenceId: accrual.id,
      });
      confirmed += 1;
    }

    return { examined: matured.length, confirmed };
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
    return { deal, created, accruals: accrual.accruals, reason: accrual.reason };
  }
}
