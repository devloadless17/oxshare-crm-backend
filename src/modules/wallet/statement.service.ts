import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { money } from './money';

/** The longest period one statement may cover — a year and a day, so "last 12 months" fits. */
export const MAX_STATEMENT_DAYS = 366;

/**
 * The most lines one statement returns. A client's wallet does not approach
 * this in a year; the cap is there so a pathological account cannot turn one
 * request into an unbounded read, and `truncated` says so rather than hiding it.
 */
export const MAX_STATEMENT_LINES = 5000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface StatementLine {
  id: string;
  createdAt: Date;
  entryType: string;
  referenceType: string;
  referenceId: string;
  /** Signed: positive credits the wallet, negative debits it. */
  amount: string;
  balanceAfter: string;
  /** The payment rail's own name, for a line that came from a deposit or withdrawal. */
  methodName: string | null;
  /** The payment's provider — `manual_admin` is money the team placed by hand. */
  provider: string | null;
  /** The MT5 login, for a line that moved money to or from a trading account. */
  tradingAccountLogin: string | null;
  /** The account's own name, so a transfer line can say WHICH account. */
  tradingAccountName: string | null;
  /** `wallet_to_account` / `account_to_wallet`, for a transfer line. */
  transferDirection: string | null;
}

export interface Statement {
  walletId: string;
  walletNumber: string;
  currency: string;
  from: string;
  to: string;
  openingBalance: string;
  closingBalance: string;
  totalCredits: string;
  totalDebits: string;
  lines: StatementLine[];
  truncated: boolean;
  generatedAt: Date;
}

/**
 * A wallet's ACCOUNT STATEMENT for a period — opening balance, every movement
 * with the balance it left, and the closing balance.
 *
 * ## Why this is its own read and not `/wallet/ledger` with dates
 *
 * A statement is only a statement if it reconciles: opening + credits − debits
 * = closing, line by line. The ledger list is keyset-paged newest-first across
 * every wallet, which is right for browsing and useless for that — the opening
 * balance is the `balance_after` of the last entry BEFORE the period, which no
 * page of the list contains.
 *
 * Every figure comes from `ledger_entries`, the book of record, and the running
 * balance is the stored `balance_after` rather than one re-added here: the
 * column is written under the wallet's row lock, so it is the balance the
 * system actually had. Re-deriving it would print a balance the system never
 * held the first time two entries shared a timestamp.
 *
 * ## Dates
 *
 * `from`/`to` are inclusive calendar days, compared on the constants
 * (`created_at >= from AND created_at < to + 1 day`) so the column stays bare
 * for its index — the same rule the transaction list follows.
 */
@Injectable()
export class StatementService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async forWallet(userId: number, walletId: string, from: string, to: string): Promise<Statement> {
    if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) {
      throw new ValidationError('from and to must be YYYY-MM-DD dates.');
    }
    const fromDay = new Date(`${from}T00:00:00Z`);
    const toDay = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(fromDay.getTime()) || Number.isNaN(toDay.getTime())) {
      throw new ValidationError('from and to must be real dates.');
    }
    if (fromDay > toDay) throw new ValidationError('from must not be after to.');
    const days = (toDay.getTime() - fromDay.getTime()) / 86_400_000 + 1;
    if (days > MAX_STATEMENT_DAYS) {
      throw new ValidationError(`A statement covers at most ${MAX_STATEMENT_DAYS} days.`);
    }

    /*
     * Ownership in the WHERE, not checked afterwards: a wallet id that is not
     * this client's is indistinguishable from one that does not exist, so the
     * route cannot be used to learn which ids are real.
     */
    const walletResult = await this.db.execute(sql`
      SELECT id, wallet_number, currency
      FROM wallets
      WHERE id = ${walletId} AND user_id = ${userId}
      LIMIT 1
    `);
    const wallet = walletResult.rows[0] as
      { id: string; wallet_number: string; currency: string } | undefined;
    if (!wallet) throw new NotFoundError('Wallet not found.');

    const [openingResult, linesResult] = await Promise.all([
      this.db.execute(sql`
        SELECT balance_after::text AS balance_after
        FROM ledger_entries
        WHERE wallet_id = ${walletId} AND created_at < ${from}::date
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `),
      /*
       * The description joins are LEFT and keyed on the reference: a line whose
       * source row cannot be resolved still prints, with its type and
       * reference, because a statement that drops a movement no longer adds up.
       */
      this.db.execute(sql`
        SELECT
          le.id,
          le.created_at,
          le.entry_type::text           AS entry_type,
          le.reference_type,
          le.reference_id,
          le.amount::text               AS amount,
          le.balance_after::text        AS balance_after,
          COALESCE(pm.name, wpm.name)   AS method_name,
          t.provider                    AS provider,
          ta.login                      AS trading_account_login,
          ta.name                       AS trading_account_name,
          tr.direction::text            AS transfer_direction
        FROM ledger_entries le
        -- split_part: a refused withdrawal's REFUND is keyed '<id>:refund' so it
        -- does not collide with the debit it reverses; it names the same row.
        -- The reference is cast only when it IS a uuid (a cast that could throw
        -- is guarded), so the join probes the primary key instead of scanning.
        LEFT JOIN transactions t
          ON t.id = CASE WHEN le.reference_type = 'transaction'
                          AND split_part(le.reference_id, ':', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         THEN split_part(le.reference_id, ':', 1)::uuid END
        LEFT JOIN payment_methods pm ON pm.key = t.method_key
        LEFT JOIN withdrawal_payment_methods wpm ON wpm.key = t.withdrawal_method_key
        LEFT JOIN transfers tr
          ON tr.id = CASE WHEN le.reference_type = 'transfer' AND le.reference_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          THEN le.reference_id::uuid END
        LEFT JOIN trading_accounts ta ON ta.id = tr.trading_account_id
        WHERE le.wallet_id = ${walletId}
          AND le.created_at >= ${from}::date
          AND le.created_at < (${to}::date + 1)
        ORDER BY le.created_at ASC, le.id ASC
        LIMIT ${MAX_STATEMENT_LINES + 1}
      `),
    ]);

    const openingRow = openingResult.rows[0] as { balance_after: string } | undefined;
    const openingBalance = new Decimal(openingRow?.balance_after ?? '0');

    const rawLines = linesResult.rows as unknown as {
      id: string;
      created_at: string | Date;
      entry_type: string;
      reference_type: string;
      reference_id: string;
      amount: string;
      balance_after: string;
      method_name: string | null;
      provider: string | null;
      trading_account_login: string | null;
      trading_account_name: string | null;
      transfer_direction: string | null;
    }[];
    const truncated = rawLines.length > MAX_STATEMENT_LINES;
    const kept = truncated ? rawLines.slice(0, MAX_STATEMENT_LINES) : rawLines;

    let credits = new Decimal(0);
    let debits = new Decimal(0);
    const lines: StatementLine[] = kept.map((row) => {
      const amount = new Decimal(row.amount);
      if (amount.greaterThan(0)) credits = credits.plus(amount);
      else if (amount.lessThan(0)) debits = debits.plus(amount.abs());
      return {
        id: row.id,
        createdAt: new Date(row.created_at),
        entryType: row.entry_type,
        referenceType: row.reference_type,
        referenceId: row.reference_id,
        amount: money(row.amount),
        balanceAfter: money(row.balance_after),
        methodName: row.method_name,
        provider: row.provider,
        tradingAccountLogin: row.trading_account_login,
        tradingAccountName: row.trading_account_name,
        transferDirection: row.transfer_direction,
      };
    });

    /*
     * The closing balance is the LAST line's stored balance, not opening +
     * credits − debits. The two agree whenever the book does; if they ever did
     * not, printing the arithmetic would hide the disagreement behind a figure
     * the system never held. With no movement in the period it is the opening.
     */
    const closingBalance = lines.length
      ? lines[lines.length - 1].balanceAfter
      : money(openingBalance);

    return {
      walletId: wallet.id,
      walletNumber: wallet.wallet_number,
      currency: wallet.currency,
      from,
      to,
      openingBalance: money(openingBalance),
      closingBalance,
      totalCredits: money(credits),
      totalDebits: money(debits),
      lines,
      truncated,
      generatedAt: new Date(),
    };
  }
}
