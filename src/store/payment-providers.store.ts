import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { paymentProviders } from '../database/schema';

export type PaymentProviderRow = typeof paymentProviders.$inferSelect;

/**
 * A write to one provider's configuration.
 *
 * `config` and `secrets` are MERGED key by key with the three-state contract
 * the Rival and SMTP rows already carry: an absent key is left alone, `null`
 * removes it, a string replaces it — so an operator switching a provider off
 * cannot wipe a credential by omission. Secrets arrive here already sealed
 * (`secret-box`); this store never sees plaintext.
 */
export interface PaymentProviderWrite {
  enabled?: boolean;
  environment?: 'live' | 'sandbox';
  config?: Record<string, string | null>;
  secrets?: Record<string, string | null>;
}

/**
 * Every payment provider's configuration row (`payment_providers`, 0168).
 *
 * `rival_settings` — where Rival's configuration lived before 0168, and what an
 * older build still reads — is kept in step with the `rival` row by triggers in
 * both directions (0168), so nothing here writes it.
 */
@Injectable()
export class PaymentProvidersStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  list(): Promise<PaymentProviderRow[]> {
    return this.db.select().from(paymentProviders).orderBy(asc(paymentProviders.code));
  }

  async get(code: string): Promise<PaymentProviderRow | null> {
    const [row] = await this.db
      .select()
      .from(paymentProviders)
      .where(eq(paymentProviders.code, code))
      .limit(1);
    return row ?? null;
  }

  /**
   * Merge a write into one provider's row, in ONE statement — `config || $set`
   * minus the removed keys — so two admins saving different fields at once
   * cannot overwrite each other's with a stale copy read beforehand.
   */
  async update(
    code: string,
    values: PaymentProviderWrite,
    updatedBy: string,
  ): Promise<PaymentProviderRow> {
    const config = splitMerge(values.config);
    const secrets = splitMerge(values.secrets);
    const [row] = await this.db
      .update(paymentProviders)
      .set({
        ...(values.enabled !== undefined ? { enabled: values.enabled } : {}),
        ...(values.environment !== undefined ? { environment: values.environment } : {}),
        ...(config ? { config: merged(paymentProviders.config, config) } : {}),
        ...(secrets ? { secrets: merged(paymentProviders.secrets, secrets) } : {}),
        updatedBy,
        updatedAt: new Date(),
      })
      .where(eq(paymentProviders.code, code))
      .returning();
    if (!row) throw new Error(`No payment provider row for ${code}.`);
    return row;
  }

  /**
   * The liveness stamp on a verified inbound event: the database's clock, so
   * two instances cannot disagree about which event was the latest.
   */
  async touchLastEvent(code: string): Promise<void> {
    await this.db
      .update(paymentProviders)
      .set({ lastEventAt: sql`now()` })
      .where(eq(paymentProviders.code, code));
  }

  /** What the last connection test said — the provider page's health line. */
  async recordCheck(code: string, ok: boolean, message: string): Promise<void> {
    await this.db
      .update(paymentProviders)
      .set({ lastCheckAt: sql`now()`, lastCheckOk: ok, lastCheckMessage: message.slice(0, 500) })
      .where(eq(paymentProviders.code, code));
  }
}

/**
 * `column || set`, then each removed key taken off with its own `- key`. One
 * `- text[]` would be neater, but Drizzle spreads an interpolated array into a
 * parameter LIST, and an empty one becomes `()` — a syntax error on every save
 * that removes nothing.
 */
function merged(
  column: AnyPgColumn,
  change: { set: Record<string, string>; removed: string[] },
): SQL {
  let expr = sql`(${column} || ${JSON.stringify(change.set)}::jsonb)`;
  for (const key of change.removed) expr = sql`(${expr} - ${key}::text)`;
  return expr;
}

/** A three-state map as the keys to set and the keys to remove; undefined when absent. */
function splitMerge(
  map: Record<string, string | null> | undefined,
): { set: Record<string, string>; removed: string[] } | undefined {
  if (!map) return undefined;
  const set: Record<string, string> = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    if (value === null) removed.push(key);
    else set[key] = value;
  }
  return { set, removed };
}
