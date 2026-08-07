import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { paymentMethods } from '../../database/schema';
import { CurrenciesService } from '../currencies/currencies.service';
import { toDecimal } from '../wallet/money';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import type { CreatePaymentMethodDto, UpdatePaymentMethodDto } from './dto/payment-method.dto';

export type PaymentMethodRow = typeof paymentMethods.$inferSelect;

/**
 * The ways a client can put money in — operator data, not a constant.
 *
 * ## Why this is a table
 *
 * The deleted deposit screen carried `METHODS = ['bank_transfer', 'usdt_trc20']`
 * inside the React component, and the DTO carried the same list again as a
 * union. So adding a payment option was a code change in three places, and an
 * operator whose provider went down at 2am could not turn one off at all.
 *
 * ## A method with no pay-to details is NOT offered
 *
 * `listAvailable` filters them out, and that is the single most important rule
 * here. A client shown "Whish Money" with nowhere to send the money either
 * abandons the deposit or invents a destination — and the deleted deposit page
 * recorded the consequence of the alternative in as many words: "Inventing an
 * IBAN is the same failure as the fake $0.00 balances, with a worse outcome:
 * the money leaves and does not arrive."
 *
 * So an operator enabling a method is not enough. They have to say where the
 * money goes.
 */
@Injectable()
export class PaymentMethodsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly currencies: CurrenciesService,
  ) {}

  /** Everything, including disabled and unconfigured. The admin screen's list. */
  listAll(): Promise<PaymentMethodRow[]> {
    return this.db
      .select()
      .from(paymentMethods)
      .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.key));
  }

  /**
   * What a CLIENT may actually choose right now.
   *
   * Enabled, and configured. `payTo` is the test for configured: a method whose
   * destination nobody has filled in cannot receive money, so offering it is
   * offering a dead end. The Whish row ships in exactly that state — seeded with
   * its name and logo, disabled, with no account number invented for it.
   */
  async listAvailable(): Promise<PaymentMethodRow[]> {
    const rows = await this.db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.enabled, true))
      .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.key));

    return rows.filter((row) => Boolean(row.payTo?.trim()));
  }

  async findOne(key: string): Promise<PaymentMethodRow | null> {
    const [row] = await this.db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.key, this.normalise(key)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The method a deposit may actually use, or a refusal naming why.
   *
   * The write-path counterpart of `listAvailable`, and it repeats the checks on
   * purpose: the list is what the client was shown a moment ago, and an
   * operator can disable a method between the page render and the submit. R-4.3
   * — the decision belongs where the write happens.
   *
   * Returns the ROW, so the caller has the currency and the bounds without a
   * second read.
   */
  async assertUsable(key: string): Promise<PaymentMethodRow> {
    const row = await this.findOne(key);
    if (!row) throw new NotFoundError(`Unknown payment method ${this.normalise(key)}.`);
    if (!row.enabled) {
      throw new ValidationError(`${row.name} is not currently available. Choose another method.`);
    }
    if (!row.payTo?.trim()) {
      /*
       * Reachable only if an operator enabled a method without configuring it,
       * since `listAvailable` hides those. The message says "not available"
       * rather than "not configured": which of our accounts is set up is not a
       * client's problem, and naming it invites a support call they cannot act
       * on.
       */
      throw new ValidationError(`${row.name} is not currently available. Choose another method.`);
    }
    return row;
  }

  /**
   * Per-method bounds, checked against the amount.
   *
   * SEPARATE from the platform limits in `MoneyLimits`, and both apply. A
   * provider may not accept under $20 while the platform's own floor is $10;
   * the tighter of the two is what the client experiences, and neither is
   * derivable from the other.
   */
  assertAmountWithin(row: PaymentMethodRow, amount: Decimal): void {
    if (row.minAmount && amount.lessThan(toDecimal(row.minAmount))) {
      throw new ValidationError(
        `The minimum ${row.name} deposit is ${toDecimal(row.minAmount).toString()} ${row.currency}.`,
      );
    }
    if (row.maxAmount && amount.greaterThan(toDecimal(row.maxAmount))) {
      throw new ValidationError(
        `The maximum ${row.name} deposit is ${toDecimal(row.maxAmount).toString()} ${row.currency}.`,
      );
    }
  }

  async create(dto: CreatePaymentMethodDto, adminId: string): Promise<PaymentMethodRow> {
    const key = this.normalise(dto.key);
    if (await this.findOne(key)) {
      throw new ConflictError(`A payment method with the key ${key} already exists.`);
    }
    // Refuses an unknown or DISABLED currency — a method denominated in one the
    // platform does not hold could never open a wallet to receive into.
    const currency = await this.currencies.assertUsable(dto.currency);
    this.assertBoundsMakeSense(dto.minAmount, dto.maxAmount);

    const [row] = await this.db
      .insert(paymentMethods)
      .values({
        key,
        name: dto.name.trim(),
        kind: dto.kind,
        currency,
        logoUrl: dto.logoUrl ?? null,
        instructions: dto.instructions ?? null,
        payTo: dto.payTo ?? null,
        minAmount: dto.minAmount ?? null,
        maxAmount: dto.maxAmount ?? null,
        enabled: dto.enabled ?? true,
        sortOrder: dto.sortOrder ?? 0,
        updatedBy: adminId,
      })
      .returning();
    return row;
  }

  async update(
    key: string,
    dto: UpdatePaymentMethodDto,
    adminId: string,
  ): Promise<PaymentMethodRow> {
    const current = await this.findOne(key);
    if (!current) throw new NotFoundError(`Unknown payment method ${this.normalise(key)}.`);

    const currency = dto.currency ? await this.currencies.assertUsable(dto.currency) : undefined;
    this.assertBoundsMakeSense(
      dto.minAmount ?? current.minAmount,
      dto.maxAmount ?? current.maxAmount,
    );

    const [row] = await this.db
      .update(paymentMethods)
      .set({
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.instructions !== undefined ? { instructions: dto.instructions } : {}),
        ...(dto.payTo !== undefined ? { payTo: dto.payTo } : {}),
        ...(dto.minAmount !== undefined ? { minAmount: dto.minAmount } : {}),
        ...(dto.maxAmount !== undefined ? { maxAmount: dto.maxAmount } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        updatedBy: adminId,
        updatedAt: new Date(),
      })
      .where(eq(paymentMethods.key, this.normalise(key)))
      .returning();
    return row;
  }

  /**
   * Remove a method.
   *
   * Refuses one that any transaction references, because `transactions.
   * method_key` is a RESTRICT foreign key — the database would refuse it anyway
   * and this turns that into a sentence an operator can act on. Disabling is
   * almost always what they meant: it stops new deposits and keeps the history
   * readable.
   */
  async remove(key: string): Promise<{ key: string; deleted: true }> {
    const normalised = this.normalise(key);
    const current = await this.findOne(normalised);
    if (!current) throw new NotFoundError(`Unknown payment method ${normalised}.`);

    try {
      await this.db.delete(paymentMethods).where(eq(paymentMethods.key, normalised));
    } catch {
      throw new ConflictError(
        `${current.name} has deposits recorded against it and cannot be deleted. ` +
          'Disable it instead — that stops new deposits and keeps the history intact.',
      );
    }
    return { key: normalised, deleted: true };
  }

  /**
   * A minimum above a maximum accepts nothing, and says so at neither end.
   *
   * The client sees "the minimum is 500" on one attempt and "the maximum is
   * 100" on the next, with no amount satisfying both — a configuration mistake
   * that presents as an unusable payment method rather than as an error.
   */
  private assertBoundsMakeSense(min?: string | null, max?: string | null): void {
    if (!min || !max) return;
    if (toDecimal(min).greaterThan(toDecimal(max))) {
      throw new ValidationError(
        `The minimum (${min}) cannot be above the maximum (${max}) — no amount would be accepted.`,
      );
    }
  }

  /** Keys are lower-case and trimmed, so 'Whish' and 'whish' are one method. */
  private normalise(key: string): string {
    return key.trim().toLowerCase();
  }
}
