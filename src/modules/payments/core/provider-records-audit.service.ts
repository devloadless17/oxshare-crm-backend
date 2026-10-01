import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import {
  paymentProviderUnmatchedRecords,
  paymentProviders,
  transactions,
} from '../../../database/schema';
import { ALERT_KINDS, raiseAlert } from '../../../common/logging/alerts';
import { NotFoundError, ValidationError } from '../../../common/errors/domain-errors';
import { assertActorCan, type Actor } from '../../../common/security/actor';
import { AuditLogStore } from '../../../store/audit-log.store';
import type { PaymentProviderAdapter, ProviderRecord } from '../providers/payment-provider';

type UnmatchedRow = typeof paymentProviderUnmatchedRecords.$inferSelect;

/** Records are judged this long after they happened: every one of ours is recorded by then. */
const LAG_MS = 2 * 60 * 60_000;
/** One run reads at most a day of records, so a long outage catches up in steps. */
const MAX_WINDOW_MS = 24 * 60 * 60_000;
/** Pages per finding up to this many in one run; past it, one page says how many. */
const ALERTS_PER_RUN = 5;
const NOTE_MAX = 500;

/**
 * THE UNMATCHED-RECORDS AUDIT — every movement a provider records is explained
 * by a transaction here, or a person hears about it (0174).
 *
 * The engines make sure every transaction of OURS ends right. This checks the
 * other direction: that the provider holds nothing we did not make. A payout
 * somebody sent by hand from the provider's dashboard, a deposit on a link this
 * platform never created, a payout the engine gave up on (absent past its
 * window, handed to a person) that turned up at the provider after all — each
 * is money the books here do not show, and the last one is a payout that may be
 * paid twice if the person resent it. The owner's ruling (30 Sep 2026): manual
 * moves in 3pay's dashboard are "mostly no", so every one is raised, and a
 * person acknowledges it as a company movement with a note.
 *
 * How: the provider's records (`listRecords`), window by window from a cursor on
 * its `payment_providers` row, two hours behind now — by then every movement of
 * ours is recorded (payout adoption closes within 15 minutes; a link expires in
 * 30). A record that moved money and that no transaction holds by its provider
 * id is filed once (a unique key) and paged. A window the provider could not
 * list completely is not judged, and the cursor waits for it.
 *
 * It moves no money and changes no transaction. A filed record that a
 * transaction later holds is marked matched on the next run.
 */
@Injectable()
export class ProviderRecordsAudit {
  private readonly logger = new Logger(ProviderRecordsAudit.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly auditLog: AuditLogStore,
  ) {}

  /** One provider's next window, judged. Called by the reconcile scheduler. */
  async run(adapter: PaymentProviderAdapter, now: Date = new Date()): Promise<void> {
    if (!adapter.listRecords) return;
    const until = new Date(now.getTime() - LAG_MS);
    const [row] = await this.db
      .select({ cursor: paymentProviders.recordsAuditedUntil })
      .from(paymentProviders)
      .where(eq(paymentProviders.code, adapter.code))
      .limit(1);
    if (!row) return;
    if (!row.cursor) {
      // The first run starts NOW: what the account held before this platform
      // used it is not this platform's to explain.
      await this.db
        .update(paymentProviders)
        .set({ recordsAuditedUntil: until })
        .where(
          and(
            eq(paymentProviders.code, adapter.code),
            isNull(paymentProviders.recordsAuditedUntil),
          ),
        );
      return;
    }

    await this.rematch(adapter.code);
    const from = row.cursor;
    if (until.getTime() <= from.getTime()) return;
    const to = new Date(Math.min(until.getTime(), from.getTime() + MAX_WINDOW_MS));

    const page = await adapter.listRecords(from, to);
    if (!page.complete) {
      this.logger.warn(
        `${adapter.name} records from ${from.toISOString()} could not all be read ` +
          `(${page.reason}); that window waits for the next run.`,
      );
      return;
    }

    const moved = page.records.filter(
      (record) =>
        record.moved &&
        record.occurredAt.getTime() >= from.getTime() &&
        record.occurredAt.getTime() < to.getTime(),
    );
    const unexplained = await this.unexplained(adapter.code, moved);
    const filed =
      unexplained.length === 0
        ? []
        : await this.db
            .insert(paymentProviderUnmatchedRecords)
            .values(unexplained.map((record) => rowOf(adapter.code, record)))
            .onConflictDoNothing()
            .returning();
    await this.db
      .update(paymentProviders)
      .set({ recordsAuditedUntil: to })
      .where(
        and(
          eq(paymentProviders.code, adapter.code),
          eq(paymentProviders.recordsAuditedUntil, from),
        ),
      );

    for (const record of filed.slice(0, ALERTS_PER_RUN)) {
      raiseAlert(
        this.logger,
        ALERT_KINDS.PAYMENT_STATE_MISMATCH,
        'page',
        sentenceOf(adapter, record),
        {
          provider: adapter.code,
          subject: record.subject,
          providerId: record.providerId,
        },
      );
    }
    if (filed.length > ALERTS_PER_RUN) {
      raiseAlert(
        this.logger,
        ALERT_KINDS.PAYMENT_STATE_MISMATCH,
        'page',
        `${adapter.name} holds ${filed.length} movements no transaction here explains. ` +
          'See Payment providers → ' +
          `${adapter.name} → Unexplained records.`,
        { provider: adapter.code, count: filed.length },
      );
    }
  }

  /** The provider's records nobody has explained yet, newest first — or every one filed. */
  list(providerCode: string, open: boolean): Promise<UnmatchedRow[]> {
    return this.db
      .select()
      .from(paymentProviderUnmatchedRecords)
      .where(
        and(
          eq(paymentProviderUnmatchedRecords.providerCode, providerCode),
          open ? isNull(paymentProviderUnmatchedRecords.acknowledgedAt) : undefined,
          open ? isNull(paymentProviderUnmatchedRecords.matchedTransactionId) : undefined,
        ),
      )
      .orderBy(desc(paymentProviderUnmatchedRecords.occurredAt))
      .limit(200);
  }

  /** How many are open per provider — the provider list's badge. */
  async openCounts(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        code: paymentProviderUnmatchedRecords.providerCode,
        n: sql<number>`count(*)::int`,
      })
      .from(paymentProviderUnmatchedRecords)
      .where(
        and(
          isNull(paymentProviderUnmatchedRecords.acknowledgedAt),
          isNull(paymentProviderUnmatchedRecords.matchedTransactionId),
        ),
      )
      .groupBy(paymentProviderUnmatchedRecords.providerCode);
    return new Map(rows.map((row) => [row.code, row.n]));
  }

  /**
   * A person explains a record as a COMPANY MOVEMENT — a payout made on
   * purpose from the dashboard, a deposit the company made itself. Audited with
   * the note; once only.
   */
  async acknowledge(
    providerCode: string,
    id: string,
    actor: Actor,
    note: string,
  ): Promise<UnmatchedRow> {
    assertActorCan(actor, 'payments.providers.edit', 'acknowledge a provider record');
    const text = note.trim();
    if (text.length === 0) throw new ValidationError('Say what this movement was.');
    if (text.length > NOTE_MAX) {
      throw new ValidationError(`Keep the note under ${NOTE_MAX} characters.`);
    }
    return this.db.transaction(async (dbTx) => {
      const [updated] = await dbTx
        .update(paymentProviderUnmatchedRecords)
        .set({ acknowledgedBy: actor.id, acknowledgedAt: new Date(), acknowledgement: text })
        .where(
          and(
            eq(paymentProviderUnmatchedRecords.id, id),
            eq(paymentProviderUnmatchedRecords.providerCode, providerCode),
            isNull(paymentProviderUnmatchedRecords.acknowledgedAt),
            isNull(paymentProviderUnmatchedRecords.matchedTransactionId),
          ),
        )
        .returning();
      if (!updated) {
        throw new NotFoundError(
          'There is no open record with this id; it may be explained already.',
        );
      }
      await this.auditLog.record(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          actorKind: 'admin',
          action: 'payment_provider.record_acknowledge',
          subjectType: 'payment_provider',
          subjectId: providerCode,
          details: {
            recordId: updated.id,
            subject: updated.subject,
            providerId: updated.providerId,
            amount: updated.amount,
            asset: updated.asset,
            note: text,
          },
        },
        dbTx,
      );
      return updated;
    });
  }

  /** Of these records, the ones no transaction here holds by their provider id. */
  private async unexplained(
    providerCode: string,
    records: readonly ProviderRecord[],
  ): Promise<ProviderRecord[]> {
    const ids = (subject: ProviderRecord['subject']) => [
      ...new Set(records.filter((r) => r.subject === subject).map((r) => r.providerId)),
    ];
    const held = new Set<string>();
    const payments = ids('payment');
    if (payments.length > 0) {
      const rows = await this.db
        .select({ id: transactions.providerPaymentId })
        .from(transactions)
        .where(
          and(
            eq(transactions.providerCode, providerCode),
            inArray(transactions.providerPaymentId, payments),
          ),
        );
      for (const row of rows) held.add(`payment:${row.id}`);
    }
    const payouts = ids('payout');
    if (payouts.length > 0) {
      const rows = await this.db
        .select({ id: transactions.providerPayoutId })
        .from(transactions)
        .where(
          and(
            eq(transactions.providerCode, providerCode),
            inArray(transactions.providerPayoutId, payouts),
          ),
        );
      for (const row of rows) held.add(`payout:${row.id}`);
    }
    return records.filter((record) => !held.has(`${record.subject}:${record.providerId}`));
  }

  /** A filed record some transaction holds since: explained. */
  private async rematch(providerCode: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE payment_provider_unmatched_records r
         SET matched_transaction_id = t.id, matched_at = now()
        FROM transactions t
       WHERE r.provider_code = ${providerCode}
         AND r.acknowledged_at IS NULL
         AND r.matched_transaction_id IS NULL
         AND t.provider_code = r.provider_code
         AND ((r.subject = 'payment' AND t.provider_payment_id = r.provider_id)
           OR (r.subject = 'payout' AND t.provider_payout_id = r.provider_id))`);
  }
}

function rowOf(
  providerCode: string,
  record: ProviderRecord,
): typeof paymentProviderUnmatchedRecords.$inferInsert {
  return {
    providerCode,
    subject: record.subject,
    providerId: record.providerId.slice(0, 128),
    rawStatus: record.rawStatus.slice(0, 40),
    amount: record.amount ?? null,
    asset: record.asset?.slice(0, 40) ?? null,
    counterparty: record.counterparty?.slice(0, 255) ?? null,
    reference: record.reference?.slice(0, 255) ?? null,
    occurredAt: record.occurredAt,
  };
}

function sentenceOf(adapter: PaymentProviderAdapter, record: UnmatchedRow): string {
  const what = record.subject === 'payout' ? 'a payout' : 'a deposit';
  const amount = record.amount ? ` of ${record.amount} ${record.asset ?? ''}`.trimEnd() : '';
  const side = record.counterparty
    ? record.subject === 'payout'
      ? ` to ${record.counterparty}`
      : ` on ${record.counterparty}`
    : '';
  return (
    `${adapter.name} shows ${what}${amount}${side} (${record.providerId}) that no transaction here ` +
    'accounts for. Find the transaction it belongs to, or acknowledge it as a company movement.'
  );
}
