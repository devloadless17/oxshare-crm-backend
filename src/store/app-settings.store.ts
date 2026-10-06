import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { PaymentProvidersStore } from './payment-providers.store';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { scheduledJobs, smtpSettings, tradingSettings } from '../database/schema';

/**
 * The singleton settings rows — `smtp_settings`, `trading_settings` — and
 * Rival's settings, read from its `payment_providers` row since 0168.
 *
 * ONE store for both, unlike the rest of `store/`, because each table is a
 * single row addressed the same way and neither will ever grow a query beyond
 * "read it" and "write it". Two near-identical files whose only difference is a
 * table name would be the more faithful convention and the less useful code.
 *
 * ── `get` returns null rather than a default row ───────────────────────────
 *
 * `SecuritySettingsStore.get` synthesises a safe default when no row exists,
 * because a missing security switch must read as ON. The opposite is true here:
 * a missing SMTP row means "nothing configured, fall back to the environment",
 * and inventing a row with an empty host would send the caller to a mail server
 * that does not exist. The absence is the information.
 *
 * ── Ciphertext in, ciphertext out ──────────────────────────────────────────
 *
 * This layer never encrypts, decrypts or holds a key. It moves the already
 * sealed string to and from the column, so the one place that can turn a stored
 * value back into a password is `settings.service.ts`. A store that could
 * decrypt would put that capability behind every injection of the store.
 */

export interface SmtpSettingsRow {
  host: string;
  port: number;
  username: string | null;
  passwordCiphertext: string | null;
  fromAddress: string;
  secure: boolean;
  updatedBy: string | null;
  updatedAt: Date;
}

/** A write to the SMTP row. `passwordCiphertext: undefined` leaves it untouched. */
export interface SmtpSettingsWrite {
  host: string;
  port: number;
  username: string | null;
  fromAddress: string;
  secure: boolean;
  passwordCiphertext?: string | null;
}

/**
 * The terms self-service account opening runs on.
 *
 * `leverages` is the raw CSV the operator typed, unparsed. The store's job is
 * to move the column; deciding that `50,100` means two leverages belongs to the
 * service, which is also where a malformed one has to produce an error somebody
 * can act on.
 */
export interface TradingSettingsRow {
  // `leverages` was here — the ladder is the `leverages` TABLE now (0067).
  // The account caps were here — they are per product now (0201).
  /** A decimal string, never a number — see §6. */
  maxDemoDeposit: string;
  /** How deep a programme's ladder may reach. Narrow with `normaliseIbMaxLevels`. */
  /** HISTORICAL since 0113 — nothing reads it. See the column in schema.ts. */
  ibMaxLevels: number;
  /**
   * How often commission is paid, in seconds — the maturation delay AND the
   * payout period, as one number (0113).
   */
  ibCommissionIntervalSeconds: number;
  /**
   * The most one trade may pay out in total, as a percentage — a decimal
   * STRING, never a number, because it is multiplied by an amount (§6).
   *
   * Raw from the column: narrow it with `normaliseIbMaxTotalPayoutPct` before
   * use. This interface describes what the DATABASE holds, and a restored dump
   * predating the CHECK can hold anything — typing it as something already
   * validated would make every reader believe a narrowing that had not
   * happened.
   */
  ibMaxTotalPayoutPct: string;
  /** The per-lot unit-error ceiling — 0111. See `TradingTerms`. */
  ibMaxPayoutPerLot: string;
  /*
   * Four doc comments sat here describing fields that 0103 and 0104 removed —
   * the broker cap, the hold window, the accrual start and the revenue basis.
   * The comments outlived their fields and attached themselves to `updatedBy`,
   * which is how a reader ends up believing this row still carries the IB
   * block. It does not: commission is configured on the Commission Programmes
   * page, and the two IB numbers left here BOUND that page rather than
   * restating it.
   */
  updatedBy: string | null;
  updatedAt: Date;
}

export interface TradingSettingsWrite {
  maxDemoDeposit: string;
  /**
   * ── NOT WRITTEN ANY MORE (0113) ─────────────────────────────────────────
   *
   * `ibMaxLevels` capped how deep the ladder could go; the IB Levels page is
   * the only thing that decides that now. It stays on the READ type as the
   * record of what a deployment had configured, and leaves this one — which is
   * the mechanism by which the column keeps its value, because `setTrading`
   * spreads exactly the keys it is given.
   */
  /** How often commission is paid, in seconds — maturation AND payout period. */
  ibCommissionIntervalSeconds: number;
  /**
   * ── THE TWO PAYOUT CEILINGS ARE NO LONGER WRITTEN HERE (0112) ────────────
   *
   * `ibMaxTotalPayoutPct` and `ibMaxPayoutPerLot` are still COLUMNS and still
   * bound every accrual — they are what `checkPlausible` reads. They left this
   * WRITE type with the form controls that set them.
   *
   * That is the whole mechanism by which they keep their values: `setTrading`
   * spreads exactly the keys it is given into the upsert, so a column absent
   * from this interface is one the statement never mentions and the database
   * never touches. Adding either back as an optional field would be worse than
   * useless — Drizzle would write `undefined` as NULL and a NOT NULL column
   * would refuse the whole save.
   */
}

export interface RivalSettingsRow {
  baseUrl: string | null;
  apiKeyCiphertext: string | null;
  webhookKeyCiphertext: string | null;
  webhookKeyFingerprint: string | null;
  enabled: boolean;
  /** `live` or `sandbox` (0168); absent on a row written before providers existed. */
  environment?: string;
  lastEventAt: Date | null;
  updatedBy: string | null;
  updatedAt: Date;
}

@Injectable()
export class AppSettingsStore {
  /**
   * Rival's configuration lives with every other provider's since 0168. Built
   * here rather than injected: the store is stateless, and every spec that
   * constructs this one with a database keeps working.
   */
  private readonly providers: PaymentProvidersStore;

  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {
    this.providers = new PaymentProvidersStore(db);
  }

  async getSmtp(): Promise<SmtpSettingsRow | null> {
    const [row] = await this.db.select().from(smtpSettings).limit(1);
    return row ?? null;
  }

  /**
   * Upsert the single row.
   *
   * When `passwordCiphertext` is undefined the column is left out of the update
   * set entirely rather than written as null. That is what implements "submit
   * the form with the password box empty and the stored password survives" —
   * the alternative would silently clear a working credential every time an
   * operator edited the port.
   */
  async setSmtp(values: SmtpSettingsWrite, updatedBy: string): Promise<SmtpSettingsRow> {
    const { passwordCiphertext, ...rest } = values;
    const touchesPassword = passwordCiphertext !== undefined;

    const [row] = await this.db
      .insert(smtpSettings)
      .values({
        ...rest,
        id: true,
        passwordCiphertext: passwordCiphertext ?? null,
        updatedBy,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: smtpSettings.id,
        set: {
          ...rest,
          ...(touchesPassword ? { passwordCiphertext } : {}),
          updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  /**
   * The trading terms, or null when nobody has set them.
   *
   * Null rather than a synthesised row, for the reason at the top of this file:
   * the absence is information. The service turns it into the same numbers the
   * column defaults carry, and the FIRST save writes a row rather than editing
   * one nobody chose — which is what lets the audit log say what changed.
   */
  async getTrading(): Promise<TradingSettingsRow | null> {
    const [row] = await this.db.select().from(tradingSettings).limit(1);
    return row ?? null;
  }

  async setTrading(values: TradingSettingsWrite, updatedBy: string): Promise<TradingSettingsRow> {
    const [row] = await this.db
      .insert(tradingSettings)
      .values({ ...values, id: true, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: tradingSettings.id,
        set: { ...values, updatedBy, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  /**
   * Rival's row, as it read before 0168 — now kept in `payment_providers`.
   *
   * A row nobody ever saved (no URL, no key, no webhook key, no editor) reads as
   * NO row, exactly as before: the environment then decides, which is how an
   * env-configured deployment keeps working after the migration seeded an empty
   * `rival` provider.
   */
  async getRival(): Promise<RivalSettingsRow | null> {
    const row = await this.providers.get('rival');
    if (!row) return null;
    const baseUrl = row.config['baseUrl'] ?? null;
    const apiKeyCiphertext = row.secrets['apiKey'] ?? null;
    const webhookKeyCiphertext = row.secrets['webhookKey'] ?? null;
    if (!baseUrl && !apiKeyCiphertext && !webhookKeyCiphertext && row.updatedBy === null) {
      return null;
    }
    return {
      baseUrl,
      apiKeyCiphertext,
      webhookKeyCiphertext,
      webhookKeyFingerprint: row.config['webhookKeyFingerprint'] ?? null,
      enabled: row.enabled,
      environment: row.environment,
      lastEventAt: row.lastEventAt,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }

  /** The liveness stamp on a verified inbound event — see `PaymentProvidersStore`. */
  async touchRivalLastEvent(): Promise<void> {
    await this.providers.touchLastEvent('rival');
  }
  // ── Scheduled jobs (0167) — see `scheduled_jobs` in schema.ts ────────────

  /** Every job row, for the settings screen and the runner's tick. */
  async listJobs(): Promise<ScheduledJobRow[]> {
    return await this.db.select().from(scheduledJobs);
  }

  /** Create a job's row with its default if it has none (a job added after 0167). */
  async ensureJob(key: string, intervalSeconds: number): Promise<void> {
    await this.db.insert(scheduledJobs).values({ key, intervalSeconds }).onConflictDoNothing();
  }

  /**
   * CLAIM a due run: true for exactly one caller per period, however many
   * instances ask. The database decides — `last_started_at` moves only if it is
   * NULL ("Run now") or at least one interval old.
   */
  async claimJob(key: string): Promise<Date | null> {
    const [row] = await this.db
      .update(scheduledJobs)
      .set({ lastStartedAt: sql`now()` })
      .where(
        and(
          eq(scheduledJobs.key, key),
          or(
            isNull(scheduledJobs.lastStartedAt),
            sql`${scheduledJobs.lastStartedAt} <= now() - make_interval(secs => ${scheduledJobs.intervalSeconds})`,
          ),
        ),
      )
      .returning({ startedAt: scheduledJobs.lastStartedAt });
    return row?.startedAt ?? null;
  }

  /** What a run did. An error is kept until the next success clears it. */
  async finishJob(key: string, startedAt: Date, error?: string): Promise<void> {
    const finishedAt = new Date();
    await this.db
      .update(scheduledJobs)
      .set({
        lastFinishedAt: finishedAt,
        lastDurationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        ...(error
          ? { lastError: error.slice(0, 2000), lastErrorAt: finishedAt }
          : { lastError: null, lastErrorAt: null }),
      })
      .where(eq(scheduledJobs.key, key));
  }

  /**
   * A run the job's OWN loop started (the commission pair): both stamps at once.
   * Never throws — a status line must not break the job it describes.
   */
  async recordJobRun(key: string, startedAt: Date, error?: string): Promise<void> {
    try {
      await this.db
        .update(scheduledJobs)
        .set({ lastStartedAt: startedAt })
        .where(eq(scheduledJobs.key, key));
      await this.finishJob(key, startedAt, error);
    } catch {
      /* the status is a courtesy; the run itself already happened */
    }
  }

  async setJobInterval(key: string, intervalSeconds: number, updatedBy: string): Promise<void> {
    await this.db
      .insert(scheduledJobs)
      .values({ key, intervalSeconds, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: scheduledJobs.key,
        set: { intervalSeconds, updatedBy, updatedAt: new Date() },
      });
  }

  /** "Run now": the next runner tick, on whichever instance, starts it. */
  async requestJobRun(key: string): Promise<void> {
    await this.db
      .update(scheduledJobs)
      .set({ lastStartedAt: null })
      .where(eq(scheduledJobs.key, key));
  }

  /** A job another process runs (the bridge) read its interval — returns that interval. */
  async readExternalJob(key: string, fallbackSeconds: number): Promise<number> {
    const [row] = await this.db
      .update(scheduledJobs)
      .set({ externalReadAt: sql`now()` })
      .where(eq(scheduledJobs.key, key))
      .returning({ intervalSeconds: scheduledJobs.intervalSeconds });
    return row?.intervalSeconds ?? fallbackSeconds;
  }
}

export type ScheduledJobRow = typeof scheduledJobs.$inferSelect;
