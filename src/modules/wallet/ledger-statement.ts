import Decimal from 'decimal.js';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../database/db';
import { clientScopePredicate, type ClientScope } from '../../common/security/client-scope';
import type { DateRange } from '../../common/date-range';
import { money } from './money';

/**
 * THE PERIOD STATEMENT (audit R4-G1, 17 Oct 2026) — what an accountant closes a month from: per
 * currency and wallet kind, the client money held at the start, every posting in the period by
 * type (money in and money out apart), and the money held at the end.
 *
 * Opening and closing are computed as TODAY's wallet balances minus what posted after each
 * instant, so the cost is the postings since the period began, never the whole history. That is
 * exact while every wallet agrees with its own ledger — which is the reconciliation report's job,
 * and the route states its verdict beside the figures rather than repeating a check that would be
 * true by construction here. A statement with no start is the client LIABILITIES at its end.
 */
export interface StatementLine {
  entryType: string;
  /** `in` credits the wallets, `out` debits them. */
  flow: 'in' | 'out';
  count: number;
  /** Always positive: the flow says which way. */
  total: string;
}

export interface Statement {
  currency: string;
  walletKind: string;
  /** Held at the period's start; `0` when the statement has no start. */
  opening: string;
  lines: StatementLine[];
  /** Σ movements, signed. */
  movement: string;
  /** Held at the period's end (or now). */
  closing: string;
}

export async function ledgerStatement(
  db: Pick<Db, 'execute'>,
  scope: ClientScope,
  range: DateRange,
  currency?: string,
): Promise<Statement[]> {
  const scoped = clientScopePredicate(scope, sql`w.user_id`);
  const where = (extra: SQL[]): SQL => {
    const all = [...extra];
    if (scoped) all.push(scoped);
    if (currency) all.push(sql`w.currency = ${currency}`);
    return all.length ? sql` WHERE ${sql.join(all, sql` AND `)}` : sql``;
  };
  const since = (instant: Date | undefined, alias: string): SQL =>
    instant
      ? sql`coalesce((SELECT sum(le.amount) FROM ledger_entries le
            JOIN wallets w ON w.id = le.wallet_id
            ${where([sql`le.created_at >= ${instant.toISOString()}::timestamptz`])}
            AND w.currency = k.currency AND w.kind::text = k.kind), 0)::text AS ${sql.raw(alias)}`
      : sql`'0'::text AS ${sql.raw(alias)}`;

  const { rows: heads } = await db.execute<{
    currency: string;
    kind: string;
    now: string;
    after_from: string;
    after_until: string;
  }>(sql`
    WITH k AS (
      SELECT w.currency, w.kind::text AS kind, coalesce(sum(w.balance), 0)::text AS now
        FROM wallets w${where([])}
       GROUP BY 1, 2
    )
    SELECT k.currency, k.kind, k.now,
           ${since(range.from, 'after_from')},
           ${since(range.until, 'after_until')}
      FROM k
     ORDER BY 1, 2`);

  const period: SQL[] = [];
  if (range.from) period.push(sql`le.created_at >= ${range.from.toISOString()}::timestamptz`);
  if (range.until) period.push(sql`le.created_at < ${range.until.toISOString()}::timestamptz`);
  const { rows: lines } = await db.execute<{
    currency: string;
    kind: string;
    entry_type: string;
    flow: 'in' | 'out';
    value: number;
    total: string;
  }>(sql`
    SELECT w.currency, w.kind::text AS kind, le.entry_type::text AS entry_type,
           CASE WHEN le.amount >= 0 THEN 'in' ELSE 'out' END AS flow,
           count(*)::int AS value, abs(sum(le.amount))::text AS total
      FROM ledger_entries le
      JOIN wallets w ON w.id = le.wallet_id
      ${where(period)}
     GROUP BY 1, 2, 3, 4
     ORDER BY 1, 2, 3, 4`);

  return heads.map((head) => {
    const now = new Decimal(head.now);
    // No start: the statement begins before the first posting, when nothing was held.
    const opening = range.from ? now.minus(head.after_from) : new Decimal(0);
    const closing = range.until ? now.minus(head.after_until) : now;
    const mine = lines.filter((l) => l.currency === head.currency && l.kind === head.kind);
    const movement = mine.reduce(
      (sum, l) => (l.flow === 'in' ? sum.plus(l.total) : sum.minus(l.total)),
      new Decimal(0),
    );
    return {
      currency: head.currency,
      walletKind: head.kind,
      opening: money(opening.toFixed(8)),
      lines: mine.map((l) => ({
        entryType: l.entry_type,
        flow: l.flow,
        count: l.value,
        total: money(l.total),
      })),
      movement: money(movement.toFixed(8)),
      closing: money(closing.toFixed(8)),
    };
  });
}
