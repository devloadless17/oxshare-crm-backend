import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../database/db';
import { transactions, users, wallets } from '../../database/schema';
import { money, toDecimal } from '../wallet/money';
import { Currency, WalletService } from '../wallet/wallet.service';

/**
 * Withdrawal lifecycle (§8.4 + FR-ADM-03).
 *
 *   request  → hold funds, state=pending        (no ledger entry: a hold is
 *   approve  → state=approved                    not a balance change)
 *   reject   → release hold, state=rejected, reason emailed, client may retry
 *   settle   → post the debit, clear the hold, state=success
 *   fail     → release hold, state=failure, client emailed
 *
 * NOT built here (blocked, not forgotten):
 *  - Email OTP before a withdrawal request (CORE-08). §8.4 requires the OTP in
 *    Redis with a 5-minute TTL, "never in Postgres" — Redis arrives with the
 *    queues milestone. Until then a request is admin-reviewed but not
 *    OTP-gated; tracked in DECISIONS D-38.
 *  - Real provider calls (Whish / USDT). Credentials are open decision §12.5,
 *    so settlement is admin-triggered and records the provider reference by
 *    hand. The callback path will reuse settle() unchanged — its idempotency
 *    already lives in UNIQUE(provider, provider_ref).
 */
@Injectable()
export class TransactionsService {
  constructor(private readonly wallets: WalletService) {}

  async requestWithdrawal(params: {
    userId: string;
    amount: string;
    currency: Currency;
    destination: string;
    provider: string;
  }) {
    const amount = toDecimal(params.amount);
    if (!amount.isPositive()) throw new BadRequestException('Withdrawal amount must be positive.');

    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, params.userId)).limit(1);
    if (!user) throw new NotFoundException('User not found.');
    // §8.4: funded features are gated on KYC level 1 (FR-CORE-15).
    if (user.verificationLevel < 1) {
      throw new ForbiddenException('Withdrawals require a verified account (KYC level 1).');
    }

    // hold() enforces available balance = balance − on_hold and throws if short.
    const wallet = await this.wallets.hold(params.userId, params.currency, amount);

    const [tx] = await db
      .insert(transactions)
      .values({
        userId: params.userId,
        walletId: wallet.id,
        direction: 'withdrawal',
        amount: money(amount),
        currency: params.currency,
        state: 'pending',
        provider: params.provider,
        destination: params.destination,
      })
      .returning();
    return tx;
  }

  async listForAdmin(filter: { state?: string; page?: number; limit?: number }) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 25));
    const db = getDb();

    const conditions = [eq(transactions.direction, 'withdrawal')];
    if (filter.state) {
      conditions.push(eq(transactions.state, filter.state as 'pending'));
    }
    const where = and(...conditions);

    const rows = await db
      .select({
        id: transactions.id,
        amount: transactions.amount,
        currency: transactions.currency,
        state: transactions.state,
        provider: transactions.provider,
        providerRef: transactions.providerRef,
        destination: transactions.destination,
        rejectionReason: transactions.rejectionReason,
        requestedAt: transactions.createdAt,
        reviewedAt: transactions.reviewedAt,
        settledAt: transactions.settledAt,
        userId: transactions.userId,
        userEmail: users.email,
        userFirstName: users.firstName,
        userLastName: users.lastName,
      })
      .from(transactions)
      .innerJoin(users, eq(transactions.userId, users.id))
      .where(where)
      .orderBy(desc(transactions.createdAt))
      .limit(limit)
      .offset((page - 1) * limit);

    const [{ value: total }] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(transactions)
      .where(where);

    // Per-state counts over the full set, so admin tab counts stay correct
    // regardless of the active filter.
    const countRows = await db
      .select({ state: transactions.state, value: sql<number>`count(*)::int` })
      .from(transactions)
      .where(eq(transactions.direction, 'withdrawal'))
      .groupBy(transactions.state);
    const counts: Record<string, number> = { all: 0 };
    for (const row of countRows) {
      counts[row.state] = row.value;
      counts['all'] += row.value;
    }

    const items = rows.map((r) => ({
      id: r.id,
      amount: money(r.amount), // money crosses the boundary as a string
      currency: r.currency,
      state: r.state,
      provider: r.provider,
      providerRef: r.providerRef,
      destination: r.destination,
      rejectionReason: r.rejectionReason,
      requestedAt: r.requestedAt,
      reviewedAt: r.reviewedAt,
      settledAt: r.settledAt,
      user: {
        id: r.userId,
        email: r.userEmail,
        firstName: r.userFirstName,
        lastName: r.userLastName,
      },
    }));

    return { items, total, page, limit, counts };
  }

  async listForUser(userId: string) {
    const rows = await getDb()
      .select()
      .from(transactions)
      .where(eq(transactions.userId, userId))
      .orderBy(desc(transactions.createdAt))
      .limit(100);
    return rows.map((r) => ({ ...r, amount: money(r.amount) }));
  }

  async getById(id: string) {
    const [tx] = await getDb().select().from(transactions).where(eq(transactions.id, id)).limit(1);
    if (!tx) throw new NotFoundException('Transaction not found.');
    return tx;
  }

  /**
   * Every state transition that moves money uses the §8.7 conditional update:
   * UPDATE ... WHERE id = ? AND state = <expected>, then check the rowcount.
   * A zero rowcount means someone else already transitioned it — abort rather
   * than act twice. This is what stops a double-clicked button paying twice.
   */
  private async transition(id: string, from: string, patch: Record<string, unknown>) {
    const [row] = await getDb()
      .update(transactions)
      .set(patch)
      .where(and(eq(transactions.id, id), eq(transactions.state, from as 'pending')))
      .returning();
    return row;
  }

  async approve(id: string, adminId: string) {
    const row = await this.transition(id, 'pending', {
      state: 'approved',
      reviewedBy: adminId,
      reviewedAt: new Date(),
    });
    if (!row) {
      const current = await this.getById(id);
      throw new BadRequestException(
        `Only a pending withdrawal can be approved; this one is ${current.state}.`,
      );
    }
    return row;
  }

  async reject(id: string, adminId: string, reason: string) {
    const row = await this.transition(id, 'pending', {
      state: 'rejected',
      rejectionReason: reason,
      reviewedBy: adminId,
      reviewedAt: new Date(),
    });
    if (!row) {
      const current = await this.getById(id);
      throw new BadRequestException(
        `Only a pending withdrawal can be rejected; this one is ${current.state}.`,
      );
    }
    // The reservation goes back to the client's available balance.
    await this.wallets.release(row.userId, row.currency, row.amount);
    return row;
  }

  /** Provider confirmed: post the debit, clear the hold, close the transaction. */
  async settle(id: string, adminId: string, providerRef: string) {
    const row = await this.transition(id, 'approved', {
      state: 'success',
      providerRef,
      settledAt: new Date(),
      reviewedBy: adminId,
    });
    if (!row) {
      const current = await this.getById(id);
      throw new BadRequestException(
        `Only an approved withdrawal can be settled; this one is ${current.state}.`,
      );
    }

    // The debit itself is idempotent on (wallet, 'transaction', id), so even a
    // replayed provider callback credits nothing twice.
    await this.wallets.post({
      userId: row.userId,
      currency: row.currency,
      amount: toDecimal(row.amount).negated(),
      entryType: 'withdrawal',
      referenceType: 'transaction',
      referenceId: row.id,
    });
    await this.wallets.release(row.userId, row.currency, row.amount);
    return row;
  }

  /** Provider failed after approval: release the hold, no balance change. */
  async markFailed(id: string, reason: string) {
    const row = await this.transition(id, 'approved', {
      state: 'failure',
      rejectionReason: reason,
      settledAt: new Date(),
    });
    if (!row) {
      const current = await this.getById(id);
      throw new BadRequestException(
        `Only an approved withdrawal can be marked failed; this one is ${current.state}.`,
      );
    }
    await this.wallets.release(row.userId, row.currency, row.amount);
    return row;
  }

  /**
   * Deposit credit — the §8.3 callback path. Idempotent twice over: the
   * transaction row on UNIQUE(provider, provider_ref) and the ledger entry on
   * (wallet, reference). Used by the provider webhook when credentials land.
   */
  async creditDeposit(params: {
    userId: string;
    amount: string;
    currency: Currency;
    provider: string;
    providerRef: string;
  }) {
    const wallet = await this.wallets.getOrCreateWallet(params.userId, params.currency);
    const [tx] = await getDb()
      .insert(transactions)
      .values({
        userId: params.userId,
        walletId: wallet.id,
        direction: 'deposit',
        amount: money(params.amount),
        currency: params.currency,
        state: 'success',
        provider: params.provider,
        providerRef: params.providerRef,
        settledAt: new Date(),
      })
      .onConflictDoNothing({ target: [transactions.provider, transactions.providerRef] })
      .returning();

    if (!tx) {
      // Replayed callback — the original transaction and credit stand.
      const [existing] = await getDb()
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.provider, params.provider),
            eq(transactions.providerRef, params.providerRef),
          ),
        )
        .limit(1);
      return { transaction: existing, replayed: true as const };
    }

    await this.wallets.post({
      userId: params.userId,
      currency: params.currency,
      amount: params.amount,
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: tx.id,
    });
    return { transaction: tx, replayed: false as const };
  }
}
