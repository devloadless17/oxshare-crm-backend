import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db, Executor } from '../../../database/db';
import { paymentProviderChannels } from '../../../database/schema';
import { FieldValidationError, ValidationError } from '../../../common/errors/domain-errors';
import { PaymentProviderRegistry } from '../providers/payment-provider-registry';
import type { ChannelDirection, PaymentRoute } from '../providers/payment-provider';

/** One channel switch as stored — only OFF ones have rows worth reading. */
export interface ChannelSwitch {
  providerCode: string;
  direction: ChannelDirection;
  channelCode: string;
  enabled: boolean;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

/** The key a switch is filed under in `readOffSwitches`' map. */
export function channelSwitchKey(route: PaymentRoute, direction: ChannelDirection): string {
  return `${route.providerCode}:${direction}:${route.channelCode}`;
}

/**
 * Every channel switched OFF, by `channelSwitchKey`. One small read — for the
 * services that decide what a client is offered, which take no new injection
 * for it (they are built positionally in the money suites).
 */
export async function readOffSwitches(executor: Executor): Promise<Map<string, ChannelSwitch>> {
  const rows = await executor
    .select()
    .from(paymentProviderChannels)
    .where(eq(paymentProviderChannels.enabled, false));
  return new Map(
    rows.map((row) => [
      channelSwitchKey(row, row.direction as ChannelDirection),
      { ...row, direction: row.direction as ChannelDirection },
    ]),
  );
}

/** A transaction's direction, as a channel's (`withdrawal` rides a `payout` channel). */
export function channelDirectionOf(direction: 'deposit' | 'withdrawal'): ChannelDirection {
  return direction === 'withdrawal' ? 'payout' : 'deposit';
}

/**
 * CHANNEL SWITCHES — a provider's network on or off, per direction (0173).
 *
 * The owner's control (30 Sep 2026): an admin can turn 3pay's ERC20 payouts off
 * while TRC20 stays on, for any reason — a network congested, fees spiking, a
 * provider incident. Provider-neutral: Rival's Whish is switched the same way.
 *
 * ## What OFF means, everywhere at once
 *
 *   - its methods leave the client's lists (`channel_off` availability);
 *   - a NEW deposit or withdrawal request on it is refused at the door;
 *   - approving a payout on it, and submitting an approved one, is PAUSED —
 *     never failed: cancel and refund stay available, and switching it back
 *     on resumes the queue;
 *   - money ALREADY MOVING still finishes: a deposit link the client has paid
 *     is credited, a payout the provider holds is reconciled. A switch that
 *     stranded moving money would be worse than no switch.
 *
 * No row means ON: a channel an adapter declares is usable until an admin
 * says otherwise, with a reason (the table's CHECK).
 */
@Injectable()
export class ChannelSwitchesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly registry: PaymentProviderRegistry,
  ) {}

  /** The map key for a channel in one direction. */
  static key(route: PaymentRoute, direction: ChannelDirection): string {
    return channelSwitchKey(route, direction);
  }

  /** Every channel switched OFF, by `key()`. One small read; callers hold it per request. */
  async offSwitches(executor: Executor = this.db): Promise<Map<string, ChannelSwitch>> {
    return readOffSwitches(executor);
  }

  /** The switch for one channel, when it is OFF; undefined when it is on. */
  async offSwitch(
    route: PaymentRoute,
    direction: ChannelDirection,
    executor: Executor = this.db,
  ): Promise<ChannelSwitch | undefined> {
    const [row] = await executor
      .select()
      .from(paymentProviderChannels)
      .where(
        and(
          eq(paymentProviderChannels.providerCode, route.providerCode),
          eq(paymentProviderChannels.direction, direction),
          eq(paymentProviderChannels.channelCode, route.channelCode),
          eq(paymentProviderChannels.enabled, false),
        ),
      )
      .limit(1);
    return row ? { ...row, direction: row.direction as ChannelDirection } : undefined;
  }

  async isOn(route: PaymentRoute, direction: ChannelDirection): Promise<boolean> {
    return (await this.offSwitch(route, direction)) === undefined;
  }

  /**
   * The sentence the desk reads on a movement paused by a switch — naming the
   * provider and the channel, and why, so nobody opens the logs to find out.
   */
  pausedSentence(route: PaymentRoute, direction: ChannelDirection, off: ChannelSwitch): string {
    const provider = this.registry.find(route.providerCode)?.name ?? route.providerCode;
    const channel = this.registry.findChannel(route, direction)?.label ?? route.channelCode;
    const what = direction === 'payout' ? 'payouts' : 'deposits';
    return `${provider} ${channel} ${what} are switched off: ${off.reason ?? 'no reason given'}.`;
  }

  /**
   * Refuse a NEW movement on a switched-off channel. The client reads "not
   * currently available" — which network is off, and why, is the desk's
   * business, not a client's.
   */
  async assertOnForClient(
    route: PaymentRoute,
    direction: ChannelDirection,
    methodName: string,
  ): Promise<void> {
    if (await this.isOn(route, direction)) return;
    throw new ValidationError(`${methodName} is not currently available. Choose another method.`);
  }

  /**
   * Record a switch. Validated against the adapter's own declarations — a
   * channel the build does not declare cannot be switched — and a reason is
   * required to switch one off (the table enforces it too).
   */
  async set(
    route: PaymentRoute,
    direction: ChannelDirection,
    enabled: boolean,
    reason: string | null,
    actorId: string,
    executor: Executor = this.db,
  ): Promise<ChannelSwitch> {
    this.registry.channel(route, direction);
    const why = reason?.trim() || null;
    if (!enabled && !why) {
      throw new FieldValidationError('Say why this channel is being switched off.', {
        reason: 'A reason is required to switch a channel off.',
      });
    }
    const [row] = await executor
      .insert(paymentProviderChannels)
      .values({
        providerCode: route.providerCode,
        direction,
        channelCode: route.channelCode,
        enabled,
        reason: enabled ? null : why,
        updatedBy: actorId,
      })
      .onConflictDoUpdate({
        target: [
          paymentProviderChannels.providerCode,
          paymentProviderChannels.direction,
          paymentProviderChannels.channelCode,
        ],
        set: {
          enabled,
          reason: enabled ? null : why,
          updatedBy: actorId,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return { ...row, direction: row.direction as ChannelDirection };
  }
}
