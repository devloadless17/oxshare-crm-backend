import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { paymentMethods } from '../../database/schema';
import { CurrenciesService } from '../currencies/currencies.service';
import { toDecimal } from '../wallet/money';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import type { CreatePaymentMethodDto, UpdatePaymentMethodDto } from './dto/payment-method.dto';
import { PaymentGateways } from './payment-gateways.service';
import { MoneyLimits } from '../../config/money-limits';

export type PaymentMethodRow = typeof paymentMethods.$inferSelect;

/**
 * A method as a CLIENT sees it: the stored row plus the bounds it is subject to.
 *
 * The bounds are not columns any more — migration 0042 dropped the per-method
 * ones — so they are attached here from `MoneyLimits`. Keeping them ON the
 * method rather than returning them alongside means the portal reads one shape,
 * and would keep reading one shape if per-method bounds ever came back.
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
    /*
     * The platform-wide deposit floor and ceiling, so `listAvailable` can hand
     * the client the bounds they are ACTUALLY subject to. APPENDED LAST — this
     * class is constructed positionally in the unit suites.
     */
    private readonly limits: MoneyLimits,
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

    return available.map((row) => this.withEffectiveBounds(row));
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
   * The per-method columns were DROPPED in migration 0042, so these are simply
   * the platform limits — which is exactly what makes the bounds identical
   * across every method. They are attached to the row rather than returned
   * separately so a caller reads one shape whether or not per-method bounds ever
   * come back.
   */
  private withEffectiveBounds(row: PaymentMethodRow): ClientPaymentMethod {
    // Strings out, at the ledger's scale (§6.1) — never a number, and never
    // rounded to something the validator would not agree with.
    return {
      ...row,
      minAmount: this.limits.minDeposit().toFixed(8),
      maxAmount: this.limits.maxDeposit().toFixed(8),
    };
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
    return this.withEffectiveBounds(row);
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
        `The minimum ${row.name} deposit is ${toDecimal(row.minAmount).toString()} ${row.currency}.`,
      );
    }
    if (amount.greaterThan(toDecimal(row.maxAmount))) {
      throw new ValidationError(
        `The maximum ${row.name} deposit is ${toDecimal(row.maxAmount).toString()} ${row.currency}.`,
      );
    }
  }

  async create(dto: CreatePaymentMethodDto, actor: Actor): Promise<PaymentMethodRow> {
    const adminId = actor.id;
    const key = this.normalise(dto.key);
    if (await this.findOne(key)) {
      throw new ConflictError(`A payment method with the key ${key} already exists.`);
    }
    // Refuses an unknown or DISABLED currency — a method denominated in one the
    // platform does not hold could never open a wallet to receive into.
    const currency = await this.currencies.assertUsable(dto.currency);

    const [row] = await this.db
      .insert(paymentMethods)
      .values({
        key,
        name: dto.name.trim(),
        currency,
        logoUrl: dto.logoUrl ?? null,
        enabled: dto.enabled ?? true,
        sortOrder: dto.sortOrder ?? 0,
        requiresProof: dto.requiresProof ?? false,
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
      currency: row.currency,
      enabled: row.enabled,
    });
    return row;
  }

  async update(key: string, dto: UpdatePaymentMethodDto, actor: Actor): Promise<PaymentMethodRow> {
    const adminId = actor.id;
    const current = await this.findOne(key);
    if (!current) throw new NotFoundError(`Unknown payment method ${this.normalise(key)}.`);

    const currency = dto.currency ? await this.currencies.assertUsable(dto.currency) : undefined;
    const [row] = await this.db
      .update(paymentMethods)
      .set({
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(currency !== undefined ? { currency } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.requiresProof !== undefined ? { requiresProof: dto.requiresProof } : {}),
        updatedBy: adminId,
        updatedAt: new Date(),
      })
      .where(eq(paymentMethods.key, this.normalise(key)))
      .returning();

    /*
     * The changed fields with their OLD values, because the UPDATE destroyed
     * them and the previous value is exactly what an investigator needs.
     *
     * `enabled` is the field this now exists for: a method turned off is a
     * deposit route that stopped working, and "when did it stop, and who" is
     * otherwise unanswerable from a row holding only the current state.
     */
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of ['name', 'currency', 'enabled', 'sortOrder', 'logoUrl'] as const) {
      if (current[field] !== row[field])
        changed[field] = { before: current[field], after: row[field] };
    }
    this.audit.record(actor.id, 'payment_method.update', 'payment_method', row.key, { changed });
    return row;
  }

  /*
   * ── `remove()` IS GONE, AND SHOULD NOT COME BACK ──────────────────────────
   *
   * `transactions.method_key` is a RESTRICT foreign key, so the database
   * refuses to delete any method a deposit has ever referenced. The old method
   * turned that into a readable message — but it meant deleting only ever
   * worked on methods nobody had used, and threw a conflict on every method
   * that mattered.
   *
   * DISABLING is what deleting was reached for, and it does the job completely:
   * `listAvailable` filters on `enabled` so the method vanishes from the client
   * portal immediately, `assertUsable` refuses it on the write path, and every
   * historical deposit keeps a readable method name instead of pointing at a row
   * that no longer exists.
   *
   * The admin surface is therefore create, update, and toggle `enabled` —
   * nothing that can destroy a row money history depends on.
   */

  /** Keys are lower-case and trimmed, so 'Whish' and 'whish' are one method. */
  private normalise(key: string): string {
    return key.trim().toLowerCase();
  }
}
