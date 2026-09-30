import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { paymentProviders } from '../../../database/schema';
import { ALERT_KINDS, raiseAlert } from '../../../common/logging/alerts';
import { ValidationError } from '../../../common/errors/domain-errors';
import { assertActorCan, type Actor } from '../../../common/security/actor';
import { AuditLogStore } from '../../../store/audit-log.store';
import type { PaymentProviderAdapter, ProviderBalance } from '../providers/payment-provider';

/** A difference below this is rounding, not money (the providers settle in cents). */
const TOLERANCE = new Decimal('0.01');
/**
 * How long a difference must stand before a person is paged: longer than the
 * unmatched-records audit's two-hour lag, so a top-up or a dashboard payout is
 * filed — and booked — before it could look like missing money.
 */
const PERSIST_MS = 150 * 60_000;
/** A standing difference is repeated at most this often. */
const REPEAT_MS = 60 * 60_000;
/**
 * The books start only at a reading with no movement of ours this close to it:
 * one that landed at the provider just before or after the read cannot be
 * placed on the right side of it.
 */
const QUIET_MARGIN_MS = 2 * 60_000;
const NOTE_MAX = 500;

type BooksRow = typeof paymentProviders.$inferSelect;

/** One balance reading, and when it was asked for. */
export interface BalanceReading {
  balance: ProviderBalance;
  /** Taken BEFORE the request: the earliest instant the figure can describe. */
  readAt: Date;
}

/**
 * THE PROVIDER'S BALANCE AGAINST OUR BOOKS (0175) — 3pay's guide, §6.5 step 3:
 * "compare totalAmt to what your books say your balance should be. Alert if
 * they diverge more than a small tolerance."
 *
 * ## The baseline, and why it waits for a quiet moment
 *
 * The books start from a BASELINE: one balance reading. From there the balance
 * SHOULD be
 *
 *   baseline
 *   + the net of every deposit the provider CONFIRMED since (`provider_paid_at`
 *     — whatever was then decided about it: its money reached the balance)
 *   − what every payout SENT since asked it to move, unless it came back
 *     (refused, failed: `provider_outcome = 'returned'`)
 *   + what came back since of a payout sent before
 *   + the net of each unexplained deposit its records hold, − each unexplained
 *     payout (the unmatched-records audit's rows, at the provider's own time;
 *     one a transaction later claims is counted through that transaction).
 *
 * A reading taken while money is TRAVELLING would be wrong for ever: a deposit
 * confirmed just before it but seen here just after would be counted twice (in
 * the reading, and as confirmed since); a payout whose request crossed it would
 * be counted by neither. 3pay's `totalAmt` also drops the moment a payout is
 * accepted and rises again if it fails. So the books start only at a reading
 * taken when nothing is travelling: the deposit sweep just asked about every
 * open link, no payout sits between the provider and its final word, and none
 * of our movements landed within two minutes of the read. A person's reset
 * clears the baseline, and the next such reading starts the books again.
 *
 * ## After the baseline
 *
 * Lags are normal (a webhook missed until the next sweep, a dashboard payout
 * filed two hours behind). A difference that stands past them pages a person,
 * and repeats hourly while it stands; one that closes clears itself. What it
 * catches is what neither the engines nor the records audit can: money that
 * moved at the provider with no record of it at all — an adjustment, a fee
 * taken outside a movement, an error on the provider's side.
 *
 * Reads and pages; never moves money. Where a figure is missing (a confirmed
 * deposit without the provider's net), the books say so rather than guess, and
 * nothing is compared that round.
 */
@Injectable()
export class ProviderBooks {
  private readonly logger = new Logger(ProviderBooks.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly auditLog: AuditLogStore,
  ) {}

  /**
   * One comparison. `depositsSwept`: the deposit sweep that ran just before
   * this reading asked about every open link (only then can the books start).
   */
  async check(
    adapter: PaymentProviderAdapter,
    reading: BalanceReading,
    depositsSwept: boolean,
    now: Date = new Date(),
  ): Promise<void> {
    const row = await this.row(adapter.code);
    if (!row) return;
    const available = new Decimal(reading.balance.available);

    if (row.booksBaselineAt === null || row.booksBaseline === null) {
      const quiet = depositsSwept && (await this.quietAt(adapter.code, reading.readAt));
      await this.db
        .update(paymentProviders)
        .set({
          ...(quiet
            ? {
                // The books start here: nothing before this reading is ours to explain.
                booksBaseline: available.toFixed(8),
                booksBaselineAt: reading.readAt,
                booksExpected: available.toFixed(8),
              }
            : { booksExpected: null }),
          booksAsset: reading.balance.asset.slice(0, 40),
          booksCheckedAt: now,
          booksAvailable: available.toFixed(8),
          booksDriftSince: null,
          booksAlertedAt: null,
        })
        .where(
          and(eq(paymentProviders.code, adapter.code), isNull(paymentProviders.booksBaselineAt)),
        );
      return;
    }

    const movement = await this.movementSince(adapter.code, row.booksBaselineAt);
    if (movement === null) {
      // A figure is missing: say what the provider holds, claim nothing about it.
      await this.db
        .update(paymentProviders)
        .set({
          booksAsset: reading.balance.asset.slice(0, 40),
          booksCheckedAt: now,
          booksAvailable: available.toFixed(8),
          booksExpected: null,
          booksDriftSince: null,
          booksAlertedAt: null,
        })
        .where(eq(paymentProviders.code, adapter.code));
      this.logger.warn(
        `${adapter.name}'s books are incomplete: a movement since they started has no figure ` +
          'from the provider, so the balance is not compared this round.',
      );
      return;
    }

    const expected = new Decimal(row.booksBaseline).plus(movement);
    const difference = available.minus(expected);
    const off = difference.abs().greaterThan(TOLERANCE);
    const since = off ? (row.booksDriftSince ?? now) : null;
    const due =
      off &&
      since !== null &&
      now.getTime() - since.getTime() >= PERSIST_MS &&
      (row.booksAlertedAt === null || now.getTime() - row.booksAlertedAt.getTime() >= REPEAT_MS);

    await this.db
      .update(paymentProviders)
      .set({
        booksAsset: reading.balance.asset.slice(0, 40),
        booksCheckedAt: now,
        booksAvailable: available.toFixed(8),
        booksExpected: expected.toFixed(8),
        booksDriftSince: since,
        booksAlertedAt: off ? (due ? now : row.booksAlertedAt) : null,
      })
      .where(eq(paymentProviders.code, adapter.code));

    if (due) {
      const asset = reading.balance.asset;
      raiseAlert(
        this.logger,
        ALERT_KINDS.PAYMENT_STATE_MISMATCH,
        'page',
        `${adapter.name} holds ${available.toFixed()} ${asset}, but our books say ` +
          `${expected.toFixed()}: ${difference.toFixed()} ${asset} has been unexplained for ` +
          `over two hours. Check ${adapter.name}'s dashboard. After a top-up or a move its ` +
          'records do not show, reset the books on its provider page.',
        {
          provider: adapter.code,
          available: available.toFixed(),
          expected: expected.toFixed(),
          difference: difference.toFixed(),
        },
      );
    }
  }

  /**
   * A person restarts the books — after a top-up or a move the provider's
   * records do not show. The baseline is cleared, and the next quiet reading
   * starts them again. Audited with the note and the figures it replaces;
   * never moves money.
   */
  async reset(providerCode: string, actor: Actor, note: string): Promise<void> {
    assertActorCan(actor, 'payments.providers.edit', 'reset a provider’s books');
    const text = note.trim();
    if (text.length === 0) throw new ValidationError('Say why the books are reset.');
    if (text.length > NOTE_MAX) {
      throw new ValidationError(`Keep the note under ${NOTE_MAX} characters.`);
    }
    await this.db.transaction(async (dbTx) => {
      const [row] = await dbTx
        .select()
        .from(paymentProviders)
        .where(eq(paymentProviders.code, providerCode))
        .for('update')
        .limit(1);
      if (!row || row.booksBaselineAt === null) {
        throw new ValidationError(
          'These books have not started yet, so there is nothing to reset.',
        );
      }
      await dbTx
        .update(paymentProviders)
        .set({
          booksBaseline: null,
          booksBaselineAt: null,
          booksExpected: null,
          booksDriftSince: null,
          booksAlertedAt: null,
        })
        .where(eq(paymentProviders.code, providerCode));
      await this.auditLog.record(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          actorKind: 'admin',
          action: 'payment_provider.books_reset',
          subjectType: 'payment_provider',
          subjectId: providerCode,
          details: {
            available: row.booksAvailable,
            expected: row.booksExpected,
            baseline: row.booksBaseline,
            startedAt: row.booksBaselineAt.toISOString(),
            readAt: row.booksCheckedAt?.toISOString() ?? null,
            note: text,
          },
        },
        dbTx,
      );
    });
  }

  private async row(code: string): Promise<BooksRow | null> {
    const [row] = await this.db
      .select()
      .from(paymentProviders)
      .where(eq(paymentProviders.code, code))
      .limit(1);
    return row ?? null;
  }

  /**
   * Nothing of ours travelling at `readAt`: no payout between the provider and
   * its final word, and no movement landed within the margin either side.
   */
  private async quietAt(code: string, readAt: Date): Promise<boolean> {
    const near = new Date(readAt.getTime() - QUIET_MARGIN_MS);
    const { rows } = await this.db.execute<{ travelling: string }>(sql`
      SELECT count(*) AS travelling FROM transactions
       WHERE provider_code = ${code}
         AND (
           (direction = 'withdrawal' AND state = 'approved'
             AND provider_submitted_at IS NOT NULL
             AND coalesce(provider_outcome, 'pending') = 'pending')
           OR (direction = 'withdrawal' AND provider_submitted_at > ${near})
           OR (direction = 'withdrawal' AND provider_outcome_at > ${near})
           OR (direction = 'deposit' AND provider_paid_at > ${near}))`);
    return new Decimal(rows[0]?.travelling ?? '1').isZero();
  }

  /** Our books' change since the baseline — or null when a figure is missing. */
  private async movementSince(code: string, since: Date): Promise<Decimal | null> {
    const { rows } = await this.db.execute<{
      deposits_in: string;
      deposits_missing: string;
      payouts_out: string;
      payouts_back: string;
      payouts_missing: string;
      records_in: string;
      records_out: string;
      records_missing: string;
    }>(sql`
      SELECT
        -- A deposit's net reached the provider's balance when it CONFIRMED it.
        (SELECT coalesce(sum(provider_net_amount), 0) FROM transactions
          WHERE provider_code = ${code} AND direction = 'deposit'
            AND provider_paid_at > ${since}) AS deposits_in,
        (SELECT count(*) FROM transactions
          WHERE provider_code = ${code} AND direction = 'deposit'
            AND provider_paid_at > ${since} AND provider_net_amount IS NULL) AS deposits_missing,
        -- A payout left it when it was sent — unless it came back.
        (SELECT coalesce(sum(provider_request_amount), 0) FROM transactions
          WHERE provider_code = ${code} AND direction = 'withdrawal'
            AND provider_payout_id IS NOT NULL AND provider_submitted_at > ${since}
            AND coalesce(provider_outcome, 'pending') <> 'returned') AS payouts_out,
        -- One sent before the baseline that came back after it.
        (SELECT coalesce(sum(provider_request_amount), 0) FROM transactions
          WHERE provider_code = ${code} AND direction = 'withdrawal'
            AND provider_payout_id IS NOT NULL AND provider_submitted_at <= ${since}
            AND provider_outcome = 'returned' AND provider_outcome_at > ${since}) AS payouts_back,
        (SELECT count(*) FROM transactions
          WHERE provider_code = ${code} AND direction = 'withdrawal'
            AND provider_payout_id IS NOT NULL
            AND (provider_submitted_at > ${since} OR provider_outcome_at > ${since})
            AND provider_request_amount IS NULL) AS payouts_missing,
        -- What its records hold that no transaction here explains, at the provider's time.
        (SELECT coalesce(sum(net_amount), 0) FROM payment_provider_unmatched_records
          WHERE provider_code = ${code} AND subject = 'payment'
            AND matched_transaction_id IS NULL
            AND coalesce(moved_at, occurred_at) > ${since}) AS records_in,
        (SELECT coalesce(sum(amount), 0) FROM payment_provider_unmatched_records
          WHERE provider_code = ${code} AND subject = 'payout'
            AND matched_transaction_id IS NULL
            AND coalesce(moved_at, occurred_at) > ${since}) AS records_out,
        (SELECT count(*) FROM payment_provider_unmatched_records
          WHERE provider_code = ${code} AND matched_transaction_id IS NULL
            AND coalesce(moved_at, occurred_at) > ${since}
            AND ((subject = 'payment' AND net_amount IS NULL)
              OR (subject = 'payout' AND amount IS NULL))) AS records_missing`);
    const r = rows[0];
    if (!r) return null;
    const missing = new Decimal(r.deposits_missing).plus(r.payouts_missing).plus(r.records_missing);
    if (!missing.isZero()) return null;
    return new Decimal(r.deposits_in)
      .minus(r.payouts_out)
      .plus(r.payouts_back)
      .plus(r.records_in)
      .minus(r.records_out);
  }
}

/** Where a provider's books stand, for its page. */
export interface ProviderBooksView {
  /**
   * `starting`: waiting for a reading with nothing travelling. `matches` /
   * `differs`: the last comparison. `incomplete`: a figure is missing, so the
   * last reading was not compared.
   */
  status: 'starting' | 'matches' | 'differs' | 'incomplete';
  asset: string | null;
  available: string | null;
  expected: string | null;
  difference: string | null;
  checkedAt: string | null;
  startedAt: string | null;
  differsSince: string | null;
}

export function providerBooksView(row: BooksRow | null): ProviderBooksView {
  const at = (value: Date | null | undefined) => value?.toISOString() ?? null;
  const base = {
    asset: row?.booksAsset ?? null,
    available: row?.booksAvailable ?? null,
    checkedAt: at(row?.booksCheckedAt),
    startedAt: at(row?.booksBaselineAt),
  };
  if (!row || row.booksBaselineAt === null) {
    return { ...base, status: 'starting', expected: null, difference: null, differsSince: null };
  }
  if (row.booksExpected === null || row.booksAvailable === null) {
    return { ...base, status: 'incomplete', expected: null, difference: null, differsSince: null };
  }
  const difference = new Decimal(row.booksAvailable).minus(row.booksExpected);
  const off = difference.abs().greaterThan(TOLERANCE);
  return {
    ...base,
    status: off ? 'differs' : 'matches',
    expected: row.booksExpected,
    difference: difference.toFixed(8),
    differsSince: off ? at(row.booksDriftSince) : null,
  };
}
