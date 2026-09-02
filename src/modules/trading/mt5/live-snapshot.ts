/**
 * A live MT5 reading on its way to whichever browser is looking at the account.
 *
 * ## Why this is not stored anywhere
 *
 * Every other MT5 figure the bridge pushes lands in a Postgres column: a
 * balance is mirrored so an operator's list is right, a deal is ingested so a
 * partner is paid. None of that applies here. Equity, margin and floating P/L
 * are recomputed from live prices on every tick, so a stored copy is a stale
 * number wearing a fresh label — the single failure `/accounts/[id]` was built
 * to avoid, where two money figures differ and nothing says which is current.
 *
 * So this passes straight through: bridge → webhook → Postgres NOTIFY → socket
 * → screen, and nothing on that path keeps a copy. A reader who missed one gets
 * the next, seconds later, and the one authoritative store is MT5 itself.
 *
 * ## Why `pg_notify` rather than emitting in process
 *
 * The API runs on more than one instance and the socket may be held by a
 * different one than the bridge posted to. Postgres is already the bus for
 * notifications and for resource-changed hints, for exactly this reason.
 *
 * Unlike those two, this event carries NO transaction: it describes an
 * observation the bridge already made, not the outcome of work committing here,
 * so there is nothing to hold it until.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';

/** The Postgres channel. Separate from `notification_created` on purpose. */
export const MT5_LIVE_CHANNEL = 'mt5_live';

/** The socket event name. A new NAME on the one connection, never a new socket. */
export const MT5_LIVE_EVENT = 'account.live';

/**
 * One account's live figures, addressed to the client who owns it.
 *
 * `accountId` is the CRM's own uuid rather than the MT5 login, because that is
 * what the portal's query keys and its route are built on. Resolving it happens
 * once, here, where the ownership lookup is already being done — the browser
 * must never have to map a login to an account, and a login on the wire would
 * be a second identifier for every screen to keep straight.
 */
export interface Mt5LiveEvent {
  /** The room to deliver into: this account's owner. */
  userId: string;
  accountId: string;
  currency: string;
  balance: string;
  equity: string;
  credit: string;
  margin: string;
  marginFree: string;
  marginLevel: string | null;
  /** When the BRIDGE read MT5 — not when this was delivered. */
  readAt: string;
  /**
   * The open positions at that same instant, or absent when they did not fit.
   *
   * OPTIONAL, and that is a contract rather than laziness — the same one
   * `NotificationEvent.params` carries. `pg_notify` refuses a payload over
   * 8000 bytes, and an account with enough open positions will exceed it. The
   * publisher drops the array rather than the whole event, because the account
   * figures are what the top of the screen shows and losing them to a long
   * position list would be the worse half to lose.
   *
   * A consumer must therefore treat absence as "unchanged, ask separately" and
   * never as "no open positions" — rendering an empty table from a dropped
   * field would tell a client holding three trades that they hold none.
   */
  positions?: Mt5LivePosition[];
}

export interface Mt5LivePosition {
  ticket: string;
  symbol: string;
  action: number;
  volume: string;
  priceOpen: string;
  priceCurrent: string;
  stopLoss: string | null;
  takeProfit: string | null;
  profit: string;
  swap: string;
  commission: string | null;
  openedAt: string;
}

/**
 * `pg_notify`'s hard ceiling, minus room for the channel name and framing.
 *
 * Postgres refuses a payload over 8000 bytes with an ERROR, which would turn a
 * client holding many positions into a failing webhook rather than a slightly
 * thinner event.
 */
const MAX_PAYLOAD_BYTES = 7_500;

@Injectable()
export class Mt5LivePublisher {
  private readonly logger = new Logger(Mt5LivePublisher.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * Announce one reading. Never throws.
   *
   * A live figure is a LATEST-VALUE observation: losing one costs nothing
   * because a fresher one is seconds behind, and turning that into a 5xx would
   * make the bridge retry a reading that is already stale — the one thing that
   * puts an out-of-date equity on a screen. Degrading to "the browser keeps
   * polling" is the correct failure here.
   */
  async publish(event: Mt5LiveEvent): Promise<void> {
    try {
      await this.db.execute(sql`SELECT pg_notify(${MT5_LIVE_CHANNEL}, ${this.encode(event)})`);
    } catch (error) {
      this.logger.warn(
        `Could not announce live figures for account ${event.accountId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * JSON for the wire, with the positions dropped if that is what it takes to
   * fit. See `Mt5LiveEvent.positions`.
   */
  private encode(event: Mt5LiveEvent): string {
    const full = JSON.stringify(event);
    if (Buffer.byteLength(full, 'utf8') <= MAX_PAYLOAD_BYTES) return full;

    const { positions: _dropped, ...withoutPositions } = event;
    this.logger.debug(
      `Live payload for account ${event.accountId} exceeded ${MAX_PAYLOAD_BYTES} bytes; ` +
        'sent without positions',
    );

    return JSON.stringify(withoutPositions);
  }
}
