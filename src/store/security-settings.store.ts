import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { securitySettings } from '../database/schema';

/** The switches this system knows about. A closed set, on purpose. */
export const SECURITY_SWITCHES = {
  /** FR-CORE-08 / FR-IND-05 — the email OTP on every client withdrawal. */
  withdrawalOtp: 'withdrawal_otp',
} as const;

export type SecuritySwitch = (typeof SECURITY_SWITCHES)[keyof typeof SECURITY_SWITCHES];

export interface SecuritySwitchRow {
  key: string;
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: Date;
}

/**
 * Reads and writes the operator-controlled security switches.
 *
 * `isEnabled` DEFAULTS TO TRUE when no row exists. That direction is the whole
 * point: a switch nobody has configured must behave as though the control is on,
 * so a fresh deployment, a restored backup, or a migration that ran before the
 * seed all fail safe. The opposite default would mean a missing row silently
 * removes the OTP from every withdrawal.
 */
@Injectable()
export class SecuritySettingsStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async isEnabled(key: SecuritySwitch): Promise<boolean> {
    const [row] = await this.db
      .select({ enabled: securitySettings.enabled })
      .from(securitySettings)
      .where(eq(securitySettings.key, key))
      .limit(1);
    return row?.enabled ?? true;
  }

  async get(key: SecuritySwitch): Promise<SecuritySwitchRow> {
    const [row] = await this.db
      .select()
      .from(securitySettings)
      .where(eq(securitySettings.key, key))
      .limit(1);
    return row ?? { key, enabled: true, updatedBy: null, updatedAt: new Date() };
  }

  async list(): Promise<SecuritySwitchRow[]> {
    return await this.db.select().from(securitySettings);
  }

  /** Upsert, so the first write does not depend on a seed having run. */
  async set(key: SecuritySwitch, enabled: boolean, updatedBy: string): Promise<SecuritySwitchRow> {
    const [row] = await this.db
      .insert(securitySettings)
      .values({ key, enabled, updatedBy, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: securitySettings.key,
        set: { enabled, updatedBy, updatedAt: new Date() },
      })
      .returning();
    return row;
  }
}
