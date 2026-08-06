import { and, desc, eq } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { ibProfiles, referralAttributions, tradingAccounts, users } from '../database/schema';

export interface ProfileTradingAccount {
  id: string;
  mt5Login: string;
  mt5Group?: string;
  environment: string;
  tier?: string;
  leverage?: number;
  createdAt: Date;
}

export interface ProfileReferrer {
  ibUserId: string;
  email: string;
  firstName: string;
  lastName: string;
  active: boolean;
  since: Date;
}

export interface ProfileReferredClient {
  clientUserId: string;
  email: string;
  firstName: string;
  lastName: string;
  active: boolean;
  since: Date;
}

/**
 * The relationships a client profile shows, beyond the client row itself —
 * FR-ADM-01's "trading accounts, and referral relationships".
 *
 * A store rather than three inline queries in the service, because every one of
 * them is a projection choice: what the profile shows about a related row is a
 * decision worth making once, in a place a reviewer can read, rather than three
 * times inside a method that is already assembling four sections.
 */
@Injectable()
export class ClientProfileStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async tradingAccountsFor(userId: string): Promise<ProfileTradingAccount[]> {
    const rows = await this.db
      .select({
        id: tradingAccounts.id,
        mt5Login: tradingAccounts.mt5Login,
        mt5Group: tradingAccounts.mt5Group,
        environment: tradingAccounts.environment,
        tier: tradingAccounts.tier,
        leverage: tradingAccounts.leverage,
        createdAt: tradingAccounts.createdAt,
      })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.userId, userId))
      .orderBy(desc(tradingAccounts.createdAt));

    return rows.map((r) => ({
      ...r,
      mt5Group: r.mt5Group ?? undefined,
      tier: r.tier ?? undefined,
      leverage: r.leverage ?? undefined,
    }));
  }

  /**
   * Who introduced this client, if anyone — the L1 relationship.
   *
   * Only the ACTIVE attribution is meaningful as "their IB", but inactive rows
   * are returned too and flagged: an attribution that was switched off is part
   * of why a commission was or was not paid, and hiding it makes a past payout
   * look unexplained.
   */
  async referrerOf(userId: string): Promise<ProfileReferrer | undefined> {
    const [row] = await this.db
      .select({
        ibUserId: referralAttributions.ibUserId,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        active: referralAttributions.active,
        since: referralAttributions.createdAt,
      })
      .from(referralAttributions)
      .innerJoin(users, eq(users.id, referralAttributions.ibUserId))
      .where(eq(referralAttributions.clientUserId, userId))
      .orderBy(desc(referralAttributions.active), desc(referralAttributions.createdAt))
      .limit(1);
    return row;
  }

  /**
   * The clients this one introduced, when they are themselves an IB.
   *
   * Capped, and the cap is deliberate rather than lazy: a profile page is not a
   * client list, and an IB with 4,000 referrals would otherwise turn one screen
   * into an unpaginated dump of 4,000 rows carrying names and emails. The
   * caller reports the true total alongside, so the screen can link to the
   * filtered client list rather than pretend this is all of them.
   */
  async referredBy(userId: string, limit: number): Promise<ProfileReferredClient[]> {
    const rows = await this.db
      .select({
        clientUserId: referralAttributions.clientUserId,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        active: referralAttributions.active,
        since: referralAttributions.createdAt,
      })
      .from(referralAttributions)
      .innerJoin(users, eq(users.id, referralAttributions.clientUserId))
      .where(eq(referralAttributions.ibUserId, userId))
      .orderBy(desc(referralAttributions.createdAt))
      .limit(limit);
    return rows;
  }

  /** Whether this client is an approved IB, and under which program. */
  async ibProfileOf(userId: string) {
    const [row] = await this.db
      .select({
        status: ibProfiles.status,
        referralCode: ibProfiles.referralCode,
        parentIbId: ibProfiles.parentIbId,
        programId: ibProfiles.programId,
        approvedAt: ibProfiles.approvedAt,
      })
      .from(ibProfiles)
      .where(and(eq(ibProfiles.userId, userId)))
      .limit(1);
    return row;
  }
}
