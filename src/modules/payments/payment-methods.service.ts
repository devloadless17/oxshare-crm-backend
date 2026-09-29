import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { paymentMethods, transactions } from '../../database/schema';
import { CurrenciesService } from '../currencies/currencies.service';
import { toDecimal } from '../wallet/money';
import {
  ConflictError,
  FieldValidationError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import {
  effectiveDepositRange,
  formatLimit,
  methodRangeProblems,
  type CurrencyLimits,
} from '../../common/currency-limits';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import type { CreatePaymentMethodDto, UpdatePaymentMethodDto } from './dto/payment-method.dto';
import { PaymentGateways } from './payment-gateways.service';
import {
  assertDepositMethodKeyAllowed,
  generateMethodKey,
  isForeignKeyViolation,
  normaliseMethodKey,
  requireInternalLabel,
} from './method-keys';

export type PaymentMethodRow = typeof paymentMethods.$inferSelect;

/**
 * A method as the CONSOLE sees it: what the desk may still do to it, and the
 * range clients are held to (`minAmount`/`maxAmount`) beside the method's own
 * optional override (`ownMinAmount`/`ownMaxAmount`) the form edits.
 */
export type AdminPaymentMethod = ClientPaymentMethod & { builtIn: boolean; inUse: boolean };

/** A currency's deposit pair — what a method's range is resolved against. */
type DepositRange = Pick<CurrencyLimits, 'minDeposit' | 'maxDeposit'>;

/** Does any transaction reference this method? Indexed (0161). */
const methodInUse = sql<boolean>`exists (
  select 1 from ${transactions} where ${transactions.methodKey} = ${paymentMethods.key}
)`;

/**
 * A method as a CLIENT sees it: the stored row plus the range it is held to —
 * the tighter of its currency's deposit limits and its own optional range
 * (0162). Resolved here so the portal reads one shape and shows the figure the
 * validator enforces.
 */
export type ClientPaymentMethod = PaymentMethodRow & {
  /** Decimal strings (§6.1). The same figures `requestDeposit` enforces. */
  minAmount: string;
  maxAmount: string;
};

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
 * ## `enabled` is the operator's WHOLE decision
 *
 * A row is a method; the boolean is whether clients are offered it. There is no
 * second condition an operator can get wrong — no pay-to to leave blank, no kind
 * to classify — because every one of those was a way for a method to sit in the
 * admin list marked Enabled while no client could use it.
 *
 * The one test `enabled` does NOT cover is `isConfigured`, and it is not an
 * operator's to answer: a gateway needs its provider credentials, and those live
 * in the environment.
 */
@Injectable()
export class PaymentMethodsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly currencies: CurrenciesService,
    private readonly audit: AdminAuditService,
    /*
     * Which gateways this deployment can actually reach.
     *
     * APPENDED LAST, for the reason `TransactionsService` records about its own
     * constructor: this class is built positionally in the unit suites, so
     * inserting a parameter in the middle silently shifts every one after it.
     */
    private readonly gateways: PaymentGateways,
  ) {}

  /** The admin screen's list, with what the desk may do to each method. */
  async listAllForAdmin(): Promise<AdminPaymentMethod[]> {
    const rows = await this.db
      .select({ row: paymentMethods, inUse: methodInUse })
      .from(paymentMethods)
      .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.key));
    const ranges = await this.depositRanges(rows.map(({ row }) => row.currency));
    return rows.map(({ row, inUse }) => ({
      ...this.withEffectiveBounds(row, ranges),
      builtIn: this.isBuiltIn(row.key),
      inUse,
    }));
  }

  /** One method as the console sees it — what create and update answer with. */
  async findOneForAdmin(key: string): Promise<AdminPaymentMethod | null> {
    const [found] = await this.db
      .select({ row: paymentMethods, inUse: methodInUse })
      .from(paymentMethods)
      .where(eq(paymentMethods.key, this.normalise(key)))
      .limit(1);
    if (!found) return null;
    const ranges = await this.depositRanges([found.row.currency]);
    return {
      ...this.withEffectiveBounds(found.row, ranges),
      builtIn: this.isBuiltIn(found.row.key),
      inUse: found.inUse,
    };
  }

  /** A gateway: `PaymentGateways` dispatches on its key, so the code depends on the row. */
  private isBuiltIn(key: string): boolean {
    return this.gateways.isImplemented(key);
  }

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
   * Enabled, and CONFIGURED — see `isConfigured` for the one thing enabling a
   * method cannot settle.
   */
  private readonly logger = new Logger(PaymentMethodsService.name);

  /**
   * Keys already warned about, so the log carries the signal once rather than
   * once per deposit page view.
   *
   * Per PROCESS, and deliberately not invalidated when settings change: the hook
   * would have to reach across into the settings module, and a diagnostic log is
   * not worth a dependency edge between the two. A restart re-warns, which is
   * the moment somebody is looking anyway.
   */
  private readonly warnedUnconfigured = new Set<string>();

  async listAvailable(): Promise<ClientPaymentMethod[]> {
    const rows = await this.db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.enabled, true))
      .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.key));

    // `isConfigured` reads the Rival settings row now, so the filter is
    // resolved before filtering — sequential, because the answer is cached
    // after the first gateway row and a client holds a handful of methods.
    const available: typeof rows = [];
    const hidden: string[] = [];
    for (const row of rows) {
      if (await this.isConfigured(row)) available.push(row);
      else hidden.push(row.key);
    }

    /*
     * ── AN ENABLED METHOD THAT NOBODY CAN SEE MUST NOT BE SILENT ─────────────
     *
     * Hiding an unreachable gateway is right — a client who picks one and lands
     * on an error has been told the platform is broken. What was wrong is that
     * it happened invisibly: the operator sees Whish enabled in the admin
     * console, every client sees "no deposit methods are available", and nothing
     * anywhere connects the two.
     *
     * That is how this deployment sat with deposits switched off. The row said
     * enabled, `rival_settings` was empty, and the only signal was a client
     * being told their account manager had not set anything up.
     *
     * Logged at WARN with the key and the fix, because the operator can act on
     * it and nobody else can.
     */
    for (const key of hidden) {
      if (this.warnedUnconfigured.has(key)) continue;
      // Once per key per process — this runs on every deposit page load, and a
      // line per view would bury the first one, which is the one somebody reads.
      this.warnedUnconfigured.add(key);
      this.logger.warn(
        `Payment method "${key}" is ENABLED but hidden from clients: this deployment has no ` +
          'credentials for its provider, so it cannot take a payment. Clients see "no deposit ' +
          'methods available" while the admin console shows it switched on. Configure it under ' +
          'Settings → Payments, or disable the method.',
      );
    }

    const ranges = await this.depositRanges(available.map((row) => row.currency));
    return available.map((row) => this.withEffectiveBounds(row, ranges));
  }

  /**
   * The deposit limits of every currency named — one read per distinct code, and
   * a platform holds a handful. Keyed by code.
   */
  private async depositRanges(codes: readonly string[]): Promise<Map<string, DepositRange>> {
    const ranges = new Map<string, DepositRange>();
    for (const code of new Set(codes)) {
      const limits = await this.currencies.limitsFor(code);
      // Unreachable while `payment_methods.currency` is a foreign key.
      if (!limits) throw new NotFoundError(`Unknown currency ${code}.`);
      ranges.set(code, { minDeposit: limits.minDeposit, maxDeposit: limits.maxDeposit });
    }
    return ranges;
  }

  /**
   * Resolve the bounds a CLIENT is actually subject to, on the row itself.
   *
   * ## Why the server computes this rather than the portal
   *
   * Two limits apply to every deposit and neither is derivable from the other:
   * the platform's own floor and ceiling (`MoneyLimits`, §12.4) and whatever the
   * method carries. `requestDeposit` enforces BOTH, so the number a client is
   * refused by is the tighter of the two.
   *
   * A portal that showed only the per-method value would tell a client "minimum
   * $1" and then refuse $5 against a platform floor of $10 — a rejection with no
   * visible cause. Resolving here means the figure on the screen and the figure
   * in the validator are the same number by construction, rather than by two
   * places agreeing to stay in step.
   *
   * Since 0162 the two limits are the CURRENCY's deposit pair and the method's
   * own optional range, and the client is held to the tighter of them
   * (`effectiveDepositRange`) — so an LBP method is bounded in LBP, not by a
   * USD-sized number every currency used to share.
   */
  private withEffectiveBounds(
    row: PaymentMethodRow,
    ranges: Map<string, DepositRange>,
  ): ClientPaymentMethod {
    const currency = ranges.get(row.currency);
    if (!currency) throw new NotFoundError(`Unknown currency ${row.currency}.`);
    // Strings out, at the ledger's scale (§6.1) — never a number, and never
    // rounded to something the validator would not agree with.
    const { min, max } = effectiveDepositRange(currency, {
      minAmount: row.ownMinAmount,
      maxAmount: row.ownMaxAmount,
    });
    return { ...row, minAmount: min, maxAmount: max };
  }

  /**
   * Refuses a method range that would not narrow its currency's — each sentence
   * under its field. See `methodRangeProblems` for why it refuses rather than
   * clamps.
   */
  private async assertOwnRange(
    currency: string,
    ownMinAmount: string | null,
    ownMaxAmount: string | null,
  ): Promise<void> {
    const ranges = await this.depositRanges([currency]);
    const problems = methodRangeProblems(currency, ranges.get(currency) as DepositRange, {
      minAmount: ownMinAmount,
      maxAmount: ownMaxAmount,
    });
    const fields: Record<string, string> = {};
    if (problems.minAmount) fields.ownMinAmount = problems.minAmount;
    if (problems.maxAmount) fields.ownMaxAmount = problems.maxAmount;
    if (Object.keys(fields).length > 0) {
      throw new FieldValidationError(Object.values(fields)[0], fields);
    }
  }

  /**
   * Is this method actually able to receive money?
   *
   * ## `enabled` is the operator's whole answer
   *
   * A method used to also need `pay_to` filled in, and before that a `kind` an
   * operator picked from a dropdown. Both are gone with their columns: the admin
   * surface is name, key, currency, logo and an enable/disable toggle, so
   * "should clients see this?" is a question the operator answers directly
   * rather than one inferred from whether they happened to complete a form.
   *
   * ## Except for a GATEWAY, which has a second, non-negotiable test
   *
   * A gateway needs its PROVIDER credentials present on this deployment. That is
   * not an operator decision and cannot be one — the keys live in the
   * environment, not the database, so an operator can enable Whish on a
   * deployment that has no way to reach it.
   *
   * Such a method must not appear at all. A client who picks it and lands on an
   * error has been told the platform is broken, rather than that this particular
   * method is unavailable.
   *
   * `isImplemented` decides whether the credential test applies, and it is a fact
   * about the BUILD rather than the row. A key with no gateway behind it is a
   * manual method by definition, and there is nothing about it a deployment can
   * fail to configure.
   */
  private async isConfigured(row: PaymentMethodRow): Promise<boolean> {
    if (this.gateways.isImplemented(row.key)) return this.gateways.isConfigured(row.key);
    return true;
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
  async assertUsable(key: string): Promise<ClientPaymentMethod> {
    const row = await this.findOne(key);
    if (!row) throw new NotFoundError(`Unknown payment method ${this.normalise(key)}.`);
    if (!row.enabled) {
      throw new ValidationError(`${row.name} is not currently available. Choose another method.`);
    }
    if (!(await this.isConfigured(row))) {
      /*
       * Reachable only if an operator enabled a gateway this deployment holds no
       * credentials for, since `listAvailable` hides those. The message says
       * "not available" rather than "not configured": which gateway credentials
       * this deployment holds is not a client's problem, and naming it invites a
       * support call they cannot act on.
       */
      throw new ValidationError(`${row.name} is not currently available. Choose another method.`);
    }
    /*
     * The same resolution the client was shown. `requestDeposit` reads the bounds
     * to refuse an out-of-range amount, so handing back the RAW row here would
     * let the write path disagree with the screen the client just used.
     */
    return this.withEffectiveBounds(row, await this.depositRanges([row.currency]));
  }

  /**
   * The bounds, checked against the amount.
   *
   * Takes a `ClientPaymentMethod` — the resolved shape from `assertUsable`, not
   * a raw row — so the figures enforced here are exactly the ones the client was
   * shown. That is the whole reason the bounds are attached to the method
   * instead of read separately: two call sites reading `MoneyLimits`
   * independently is two places that can drift.
   *
   * The message NAMES the method and the figure, because "deposit refused" with
   * no number is something a client can only respond to by guessing.
   */
  assertAmountWithin(row: ClientPaymentMethod, amount: Decimal): void {
    if (amount.lessThan(toDecimal(row.minAmount))) {
      throw new ValidationError(
        `The minimum ${row.name} deposit is ${formatLimit(row.minAmount)} ${row.currency}.`,
      );
    }
    if (amount.greaterThan(toDecimal(row.maxAmount))) {
      throw new ValidationError(
        `The maximum ${row.name} deposit is ${formatLimit(row.maxAmount)} ${row.currency}.`,
      );
    }
  }

  async create(dto: CreatePaymentMethodDto, actor: Actor): Promise<PaymentMethodRow> {
    const adminId = actor.id;
    /*
     * The console sends no key: the platform generates a permanent, opaque one.
     * A caller may still name one — only to create a row the CODE dispatches on
     * (a gateway) — and it is held to the reserved-provider rule.
     */
    const key = dto.key !== undefined ? this.normalise(dto.key) : await this.freshKey();
    assertDepositMethodKeyAllowed(key);
    if (dto.key !== undefined && (await this.findOne(key))) {
      throw new ConflictError(`A payment method with the key ${key} already exists.`);
    }
    const internalLabel = requireInternalLabel(dto.internalLabel ?? dto.name);
    await this.assertLabelFree(internalLabel);
    // Refuses an unknown or DISABLED currency — a method denominated in one the
    // platform does not hold could never open a wallet to receive into.
    const currency = await this.currencies.assertUsable(dto.currency);
    const ownMinAmount = dto.ownMinAmount ?? null;
    const ownMaxAmount = dto.ownMaxAmount ?? null;
    await this.assertOwnRange(currency, ownMinAmount, ownMaxAmount);

    const [row] = await this.db
      .insert(paymentMethods)
      .values({
        key,
        name: dto.name.trim(),
        internalLabel,
        currency,
        logoUrl: dto.logoUrl ?? null,
        enabled: dto.enabled ?? true,
        sortOrder: dto.sortOrder ?? (await this.nextSortOrder()),
        requiresProof: dto.requiresProof ?? false,
        ownMinAmount,
        ownMaxAmount,
        updatedBy: adminId,
      })
      .returning();

    /*
     * What an operator can actually change, recorded in full.
     *
     * The pay-to and bounds columns went in 0042 and `kind` in 0043, so what is
     * left is the method's identity and the one switch that decides whether
     * clients are offered it. "Who turned Whish off, and when" is the question
     * this answers, and it is the first one asked when deposits stop arriving.
     */
    this.audit.record(actor.id, 'payment_method.create', 'payment_method', row.key, {
      name: row.name,
      internalLabel: row.internalLabel,
      currency: row.currency,
      enabled: row.enabled,
      requiresProof: row.requiresProof,
      ownMinAmount: row.ownMinAmount,
      ownMaxAmount: row.ownMaxAmount,
    });
    return row;
  }

  /**
   * Everything about a method but its KEY, which is permanent (0161).
   *
   * Renaming it for the desk is `internalLabel`: one row, joined at read time by
   * every admin screen and export, rewriting no transaction.
   */
  async update(
    key: string,
    dto: UpdatePaymentMethodDto,
    actor: Actor,
  ): Promise<AdminPaymentMethod> {
    const adminId = actor.id;
    const current = await this.findOne(key);
    if (!current) throw new NotFoundError(`Unknown payment method ${this.normalise(key)}.`);

    const currency = dto.currency ? await this.currencies.assertUsable(dto.currency) : undefined;
    const internalLabel =
      dto.internalLabel !== undefined ? requireInternalLabel(dto.internalLabel) : undefined;
    if (internalLabel !== undefined) await this.assertLabelFree(internalLabel, current.key);
    /*
     * The range is judged against the currency the method WILL have, merged —
     * moving a method to LBP with a USD-sized override left in place is refused
     * rather than saved as a range no LBP client could meet.
     */
    const ownMinAmount = dto.ownMinAmount !== undefined ? dto.ownMinAmount : current.ownMinAmount;
    const ownMaxAmount = dto.ownMaxAmount !== undefined ? dto.ownMaxAmount : current.ownMaxAmount;
    if (
      currency !== undefined ||
      dto.ownMinAmount !== undefined ||
      dto.ownMaxAmount !== undefined
    ) {
      await this.assertOwnRange(currency ?? current.currency, ownMinAmount, ownMaxAmount);
    }
    const [row] = await this.db
      .update(paymentMethods)
      .set({
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(internalLabel !== undefined ? { internalLabel } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.requiresProof !== undefined ? { requiresProof: dto.requiresProof } : {}),
        ...(dto.ownMinAmount !== undefined ? { ownMinAmount: dto.ownMinAmount } : {}),
        ...(dto.ownMaxAmount !== undefined ? { ownMaxAmount: dto.ownMaxAmount } : {}),
        updatedBy: adminId,
        updatedAt: new Date(),
      })
      .where(eq(paymentMethods.key, current.key))
      .returning();
    if (!row) throw new NotFoundError(`Unknown payment method ${current.key}.`);

    /*
     * The changed fields with their OLD values, because the UPDATE destroyed
     * them and the previous value is exactly what an investigator needs.
     *
     * `enabled` is the field this now exists for: a method turned off is a
     * deposit route that stopped working, and "when did it stop, and who" is
     * otherwise unanswerable from a row holding only the current state.
     * `requiresProof` decides how the next deposit is filed, so it is here too.
     */
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of [
      'name',
      'internalLabel',
      'currency',
      'enabled',
      'sortOrder',
      'logoUrl',
      'requiresProof',
      'ownMinAmount',
      'ownMaxAmount',
    ] as const) {
      if (current[field] !== row[field])
        changed[field] = { before: current[field], after: row[field] };
    }
    this.audit.record(actor.id, 'payment_method.update', 'payment_method', row.key, { changed });
    const updated = await this.findOneForAdmin(row.key);
    if (!updated) throw new NotFoundError(`Unknown payment method ${row.key}.`);
    return updated;
  }

  /**
   * A method nobody has used can be deleted (a typo, a test row). One with any
   * transaction cannot: its deposits must keep naming the rail they came
   * through, and `transactions.method_key` is RESTRICT, so the database refuses
   * even if the check below were raced. Disabling is the answer for those.
   */
  async remove(key: string, actor: Actor): Promise<{ key: string; deleted: true }> {
    const current = await this.findOneForAdmin(key);
    if (!current) throw new NotFoundError(`Unknown payment method ${this.normalise(key)}.`);
    if (current.builtIn) {
      throw new ConflictError(`${current.name} is built into the platform and cannot be deleted.`);
    }
    if (current.inUse) throw this.inUseError(current.name);
    try {
      await this.db.delete(paymentMethods).where(eq(paymentMethods.key, current.key));
    } catch (error) {
      if (isForeignKeyViolation(error)) throw this.inUseError(current.name);
      throw error;
    }
    // The row as it was, because the DELETE is the last place it existed.
    this.audit.record(actor.id, 'payment_method.delete', 'payment_method', current.key, {
      name: current.name,
      internalLabel: current.internalLabel,
      currency: current.currency,
      enabled: current.enabled,
    });
    return { key: current.key, deleted: true };
  }

  /**
   * The internal name is how the desk tells methods apart, so two may not share
   * one (case-insensitive). The unique index `payment_methods_internal_label_uq`
   * is the guard a race cannot pass; this is the readable refusal.
   */
  private async assertLabelFree(label: string, exceptKey?: string): Promise<void> {
    const sameLabel = sql`lower(${paymentMethods.internalLabel}) = lower(${label})`;
    const [taken] = await this.db
      .select({ key: paymentMethods.key })
      .from(paymentMethods)
      .where(exceptKey ? and(sameLabel, ne(paymentMethods.key, exceptKey)) : sameLabel)
      .limit(1);
    if (taken) {
      throw new ConflictError(`Another deposit method is already called “${label}” internally.`);
    }
  }

  /** A generated ID no row holds — see `generateMethodKey`. */
  private async freshKey(): Promise<string> {
    for (;;) {
      const key = generateMethodKey('pm');
      if (!(await this.findOne(key))) return key;
    }
  }

  private inUseError(name: string): ConflictError {
    return new ConflictError(
      `${name} has been used by transactions and cannot be deleted. Disable it instead.`,
    );
  }

  /** Keys are lower-case and trimmed, so 'Whish' and 'whish' are one method. */
  private normalise(key: string): string {
    return normaliseMethodKey(key);
  }

  /**
   * Where a new deposit method goes when no position is given: after the last one.
   *
   * The console no longer asks for an order (owner, 26 Sep 2026), so every new
   * row would otherwise land at 0 and jump to the top of the list, ahead of
   * rows an operator placed years ago.
   */
  private async nextSortOrder(): Promise<number> {
    const [row] = await this.db
      .select({ next: sql<number>`coalesce(max(${paymentMethods.sortOrder}), -1)::int + 1` })
      .from(paymentMethods);
    return Number(row?.next ?? 0);
  }
}
