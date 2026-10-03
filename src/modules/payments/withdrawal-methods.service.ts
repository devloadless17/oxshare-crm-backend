import { normaliseCountryRule } from '../../common/payments/method-eligibility';
import { Inject, Injectable } from '@nestjs/common';
import { PaymentProviderRegistry } from './providers/payment-provider-registry';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { paymentProviders, transactions, withdrawalPaymentMethods } from '../../database/schema';
import { payoutMethodStatus, type ProviderState } from './providers/provider-status';
import { channelSwitchKey, readOffSwitches } from './core/channel-switches.service';
import { ConflictError, NotFoundError } from '../../common/errors/domain-errors';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import type {
  AdminWithdrawalMethodDto,
  CreateWithdrawalMethodDto,
  UpdateWithdrawalMethodDto,
} from './dto/withdrawal-method.dto';
import {
  assertWithdrawalMethodKeyAllowed,
  generateMethodKey,
  isForeignKeyViolation,
  normaliseMethodKey,
  requireInternalLabel,
} from './method-keys';
import { arabicText } from '../../common/dto/arabic-text';

type WithdrawalMethodRow = typeof withdrawalPaymentMethods.$inferSelect;

/** Does any withdrawal reference this method? Indexed (0161). */
const methodInUse = sql<boolean>`exists (
  select 1 from ${transactions}
  where ${transactions.withdrawalMethodKey} = ${withdrawalPaymentMethods.key}
)`;

/**
 * The payout rails clients may withdraw through — `withdrawal_payment_methods`.
 *
 * The table has existed since migration 0062 and the portal's withdraw form has
 * read it all along (`GET /payments/withdrawal-methods`, enabled rows only). What
 * was missing was a way to change it without a database client: this is that.
 *
 * ## Delete only what nobody used; disable the rest
 *
 * `transactions.withdrawal_method_key` references a row ON DELETE RESTRICT, so a
 * method that has carried a request cannot be removed — the desk has to be able
 * to name the rail on every request it settles. One that never carried any (a
 * typo, a test row) can be deleted. Same rule as the deposit methods.
 *
 * ## `payments.*` keys, shared with the deposit methods
 *
 * They are the same kind of thing configured by the same people, and one grant
 * for "manage payment methods" is what an operator expects. Splitting the keys
 * would be a privilege distinction nobody asked for.
 */
@Injectable()
export class WithdrawalMethodsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly audit: AdminAuditService,
    // Every route a payout method may take (0168).
    private readonly providers: PaymentProviderRegistry,
  ) {}

  /** Every method, disabled ones included, in the order clients see them. */
  async listAll(): Promise<AdminWithdrawalMethodDto[]> {
    const rows = await this.db
      .select({ row: withdrawalPaymentMethods, inUse: methodInUse })
      .from(withdrawalPaymentMethods)
      .orderBy(asc(withdrawalPaymentMethods.sortOrder), asc(withdrawalPaymentMethods.name));
    const providers = await this.providerStates();
    const off = await readOffSwitches(this.db);
    return rows.map(({ row, inUse }) => this.adminView(row, inUse, providers, off));
  }

  /** One method as the console sees it. */
  async findOneForAdmin(key: string): Promise<AdminWithdrawalMethodDto | null> {
    const [found] = await this.db
      .select({ row: withdrawalPaymentMethods, inUse: methodInUse })
      .from(withdrawalPaymentMethods)
      .where(eq(withdrawalPaymentMethods.key, this.normalise(key)))
      .limit(1);
    return found
      ? this.adminView(
          found.row,
          found.inUse,
          await this.providerStates(),
          await readOffSwitches(this.db),
        )
      : null;
  }

  /**
   * `paidBy` is who pays a request on this method NOW (0168). A payout channel
   * the provider automates is paid by the provider while it can take
   * instructions; while it is off or not set up, the desk pays it by hand — as
   * it always has — so an enabled payout method is never hidden for its
   * provider's sake. The approve dialog says which.
   */
  private adminView(
    row: WithdrawalMethodRow,
    inUse: boolean,
    providers: Map<string, ProviderState>,
    off: ReadonlyMap<string, unknown>,
  ): AdminWithdrawalMethodDto {
    const rail = this.providers.payoutRail(row)?.rail;
    const status = payoutMethodStatus(
      row.enabled,
      rail ? rail.whenUnavailable : null,
      providers.get(row.providerCode),
      !off.has(channelSwitchKey(row, 'payout')),
    );
    return { ...row, builtIn: false, inUse, ...status };
  }

  private async providerStates(): Promise<Map<string, ProviderState>> {
    return this.providers.states(await this.db.select().from(paymentProviders));
  }

  async findOne(key: string): Promise<WithdrawalMethodRow | null> {
    const [row] = await this.db
      .select()
      .from(withdrawalPaymentMethods)
      .where(eq(withdrawalPaymentMethods.key, this.normalise(key)))
      .limit(1);
    return row ?? null;
  }

  async create(dto: CreateWithdrawalMethodDto, actor: Actor): Promise<AdminWithdrawalMethodDto> {
    // Generated unless a caller names one. A withdrawal's `provider` column is
    // its method key, so a named one may not enter the `manual_` namespace.
    const key = dto.key !== undefined ? this.normalise(dto.key) : await this.freshKey();
    assertWithdrawalMethodKeyAllowed(key);
    // The payout route, judged at SAVE (0168): a payout channel the provider
    // declares and a method may bind.
    const route = {
      providerCode: dto.providerCode ?? 'manual',
      channelCode: dto.channelCode ?? 'desk',
    };
    this.providers.assertBindable(route, 'payout', {});
    if (dto.key !== undefined && (await this.findOne(key))) {
      throw new ConflictError(`A withdrawal method with the key ${key} already exists.`);
    }
    const internalLabel = requireInternalLabel(dto.internalLabel ?? dto.name);
    await this.assertLabelFree(internalLabel);

    const [row] = await this.db
      .insert(withdrawalPaymentMethods)
      .values({
        key,
        name: dto.name.trim(),
        nameAr: arabicText(dto.nameAr),
        internalLabel,
        logoUrl: dto.logoUrl ?? null,
        enabled: dto.enabled ?? true,
        sortOrder: dto.sortOrder ?? (await this.nextSortOrder()),
        ...(normaliseCountryRule(dto.countryRule, dto.countryCodes) ?? {}),
        providerCode: route.providerCode,
        channelCode: route.channelCode,
      })
      .returning();

    this.audit.record(actor.id, 'withdrawal_method.create', 'withdrawal_method', row.key, {
      name: row.name,
      nameAr: row.nameAr,
      internalLabel: row.internalLabel,
      enabled: row.enabled,
    });
    return this.adminView(row, false, await this.providerStates(), await readOffSwitches(this.db));
  }

  async update(
    key: string,
    dto: UpdateWithdrawalMethodDto,
    actor: Actor,
  ): Promise<AdminWithdrawalMethodDto> {
    const current = await this.findOne(key);
    if (!current) throw new NotFoundError(`Unknown withdrawal method ${this.normalise(key)}.`);

    // The key is permanent (0161); the desk renames a rail with `internalLabel`.
    const internalLabel =
      dto.internalLabel !== undefined ? requireInternalLabel(dto.internalLabel) : undefined;
    if (internalLabel !== undefined) await this.assertLabelFree(internalLabel, current.key);
    const countryRule = normaliseCountryRule(dto.countryRule, dto.countryCodes);
    const [row] = await this.db
      .update(withdrawalPaymentMethods)
      .set({
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.nameAr !== undefined ? { nameAr: arabicText(dto.nameAr) } : {}),
        ...(internalLabel !== undefined ? { internalLabel } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(countryRule ?? {}),
        updatedAt: new Date(),
      })
      .where(eq(withdrawalPaymentMethods.key, current.key))
      .returning();
    if (!row) throw new NotFoundError(`Unknown withdrawal method ${current.key}.`);

    /*
     * The diff, not the new row: "who switched Whish payouts off, and when" is
     * the question this entry exists to answer, and it should not need two rows
     * compared by hand.
     */
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of [
      'name',
      'nameAr',
      'internalLabel',
      'enabled',
      'sortOrder',
      'logoUrl',
    ] as const) {
      if (current[field] !== row[field]) {
        changed[field] = { before: current[field], after: row[field] };
      }
    }
    // Who it is offered to (0178), compared as a whole.
    if (
      current.countryRule !== row.countryRule ||
      current.countryCodes.join() !== row.countryCodes.join()
    ) {
      changed['countryRule'] = {
        before: { rule: current.countryRule, codes: current.countryCodes },
        after: { rule: row.countryRule, codes: row.countryCodes },
      };
    }
    this.audit.record(actor.id, 'withdrawal_method.update', 'withdrawal_method', row.key, {
      changed,
    });
    const updated = await this.findOneForAdmin(row.key);
    if (!updated) throw new NotFoundError(`Unknown withdrawal method ${row.key}.`);
    return updated;
  }

  /**
   * Deletes a method NO withdrawal references. One that carried any request is
   * refused (disable it instead); the RESTRICT foreign key refuses it too, so a
   * race with a new request cannot get past.
   */
  async remove(key: string, actor: Actor): Promise<{ key: string; deleted: true }> {
    const current = await this.findOneForAdmin(key);
    if (!current) throw new NotFoundError(`Unknown withdrawal method ${this.normalise(key)}.`);
    const inUse = new ConflictError(
      `${current.name} has been used by withdrawals and cannot be deleted. Disable it instead.`,
    );
    if (current.inUse) throw inUse;
    try {
      await this.db
        .delete(withdrawalPaymentMethods)
        .where(eq(withdrawalPaymentMethods.key, current.key));
    } catch (error) {
      if (isForeignKeyViolation(error)) throw inUse;
      throw error;
    }
    this.audit.record(actor.id, 'withdrawal_method.delete', 'withdrawal_method', current.key, {
      name: current.name,
      internalLabel: current.internalLabel,
      enabled: current.enabled,
    });
    return { key: current.key, deleted: true };
  }

  /** Two rails may not share an internal name — the unique index is the race-proof guard. */
  private async assertLabelFree(label: string, exceptKey?: string): Promise<void> {
    const sameLabel = sql`lower(${withdrawalPaymentMethods.internalLabel}) = lower(${label})`;
    const [taken] = await this.db
      .select({ key: withdrawalPaymentMethods.key })
      .from(withdrawalPaymentMethods)
      .where(exceptKey ? and(sameLabel, ne(withdrawalPaymentMethods.key, exceptKey)) : sameLabel)
      .limit(1);
    if (taken) {
      throw new ConflictError(`Another withdrawal method is already called “${label}” internally.`);
    }
  }

  /** A generated ID no row holds — see `generateMethodKey`. */
  private async freshKey(): Promise<string> {
    for (;;) {
      const key = generateMethodKey('wm');
      if (!(await this.findOne(key))) return key;
    }
  }

  /** Keys are stored lower-case, so `Whish` and `whish` are one method. */
  private normalise(key: string): string {
    return normaliseMethodKey(key);
  }

  /**
   * Where a new withdrawal method goes when no position is given: after the last one.
   *
   * The console no longer asks for an order (owner, 26 Sep 2026), so every new
   * row would otherwise land at 0 and jump to the top of the list, ahead of
   * rows an operator placed years ago.
   */
  private async nextSortOrder(): Promise<number> {
    const [row] = await this.db
      .select({
        next: sql<number>`coalesce(max(${withdrawalPaymentMethods.sortOrder}), -1)::int + 1`,
      })
      .from(withdrawalPaymentMethods);
    return Number(row?.next ?? 0);
  }
}
