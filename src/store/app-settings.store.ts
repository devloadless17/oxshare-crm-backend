import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { generalSettings, smtpSettings } from '../database/schema';

/**
 * The two singleton settings rows — `general_settings` and `smtp_settings`.
 *
 * ONE store for both, unlike the rest of `store/`, because both tables are a
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

export interface GeneralSettingsRow {
  brandName: string;
  supportEmail: string | null;
  supportUrl: string | null;
  maintenanceNotice: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

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

export interface GeneralSettingsWrite {
  brandName: string;
  supportEmail: string | null;
  supportUrl: string | null;
  maintenanceNotice: string | null;
}

@Injectable()
export class AppSettingsStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async getGeneral(): Promise<GeneralSettingsRow | null> {
    const [row] = await this.db.select().from(generalSettings).limit(1);
    return row ?? null;
  }

  /**
   * Upsert the single row.
   *
   * `onConflictDoUpdate` on the primary key, so the first save does not depend
   * on a seed having run and a concurrent double-submit resolves to one row
   * rather than a unique violation the operator has to interpret.
   */
  async setGeneral(values: GeneralSettingsWrite, updatedBy: string): Promise<GeneralSettingsRow> {
    const [row] = await this.db
      .insert(generalSettings)
      .values({ ...values, id: true, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: generalSettings.id,
        set: { ...values, updatedBy, updatedAt: new Date() },
      })
      .returning();
    return row;
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
}
