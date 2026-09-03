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
import { gunzipSync, gzipSync } from 'node:zlib';
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

/**
 * One open position on the wire, and it MUST match `AccountPositionDto` field
 * for field.
 *
 * The polled route and this one render into the same table through the same
 * generated type, so a field present on one and absent on the other is not a
 * type error anywhere — it is a column that empties itself the moment a reading
 * arrives over the socket. That shipped once: `side` was omitted here while the
 * table rendered it, so every pushed row lost its Buy/Sell label.
 *
 * `side` is DERIVED here rather than sent by the bridge. The bridge speaks MT5's
 * numeric `action`; naming it is the CRM's vocabulary, and `positionSideLabel`
 * is the one definition both paths use.
 */
export interface Mt5LivePosition {
  ticket: string;
  symbol: string;
  action: number;
  side: string;
  volume: string;
  priceOpen: string;
  priceCurrent: string;
  stopLoss: string | null;
  takeProfit: string | null;
  profit: string;
  swap: string;
  commission: string | null;
  comment: string | null;
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

/**
 * The key that marks a payload as gzipped-then-base64'd.
 *
 * Deliberately distinctive: a reader decides which form it holds by looking for
 * this one field, so it must be a name no live event could ever carry.
 */
const COMPRESSED_KEY = '__gz';

/**
 * Read a payload off the channel, in either form.
 *
 * ## Why the wire has two forms rather than one
 *
 * Compressing everything would be simpler and is the wrong trade. The common
 * payload — an account with a handful of positions — fits comfortably, and
 * sending it as an opaque base64 blob costs CPU on both ends, makes the channel
 * unreadable to anyone debugging with `LISTEN mt5_live` in psql, and buys
 * nothing. So the plain form stays the default and compression is the exception,
 * used only when the alternative is dropping data.
 *
 * ## What an OLD reader does with a compressed payload
 *
 * The publisher and this decoder ship in the same artifact, but a rolling deploy
 * can briefly have one instance publishing while another is still reading. An
 * instance that predates this parses `{"__gz":"..."}` successfully, finds no
 * `userId`, and emits into a room nobody occupies — so the reading is dropped
 * silently rather than throwing, and the client falls back to polling within
 * `SILENCE_MS`.
 *
 * That window is bounded and affects only the accounts big enough to need
 * compression — which, before this existed, had their positions dropped on
 * EVERY reading anyway. So the worst case during a deploy is briefly worse than
 * after it, and no worse than the behaviour it replaces.
 */
export function decodeLiveEvent(payload: string): Mt5LiveEvent {
  const parsed = JSON.parse(payload) as Record<string, unknown>;

  const packed = parsed[COMPRESSED_KEY];
  if (typeof packed !== 'string') return parsed as unknown as Mt5LiveEvent;

  return JSON.parse(gunzipSync(Buffer.from(packed, 'base64')).toString('utf8')) as Mt5LiveEvent;
}

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

    /*
     * ── COMPRESS BEFORE DROPPING ANYTHING ────────────────────────────────
     *
     * A position list is extremely repetitive JSON — the same dozen keys per
     * row — so gzip takes it down by roughly five to ten times, which moves the
     * ceiling from about twenty-five open positions to several hundred. That is
     * past any realistic retail book, so the drop below stops being something a
     * working trader can reach.
     *
     * Measured against the plain form each time rather than assumed: a payload
     * that does not shrink enough still falls through to the drop, and the
     * common small reading never takes this path at all.
     */
    const packed = JSON.stringify({
      [COMPRESSED_KEY]: gzipSync(Buffer.from(full, 'utf8')).toString('base64'),
    });

    if (Buffer.byteLength(packed, 'utf8') <= MAX_PAYLOAD_BYTES) {
      this.logger.debug(
        `Live payload for account ${event.accountId} compressed from ` +
          `${Buffer.byteLength(full, 'utf8')} to ${Buffer.byteLength(packed, 'utf8')} bytes`,
      );
      return packed;
    }

    const { positions: dropped, ...withoutPositions } = event;

    /*
     * WARN, not debug, because this silently disables a feature for exactly the
     * client who wants it most.
     *
     * A trader with enough open positions to overflow the channel is the one
     * watching that table hardest, and what they get is live account figures
     * above a table fed only by its fallback poll. Nothing else reports it: the
     * event is still valid, the socket still delivers, and the screen looks
     * merely slow rather than degraded.
     *
     * This is now the LAST resort rather than the first: the reading is only
     * dropped after compression has already been tried and still did not fit,
     * which takes several hundred open positions. If this line appears in
     * production it is genuinely exceptional, and the answer is a different
     * transport rather than a bigger constant — `pg_notify`'s 8000 bytes is
     * Postgres's limit, not ours.
     */
    this.logger.warn(
      `Live payload for account ${event.accountId} exceeded ${MAX_PAYLOAD_BYTES} bytes with ` +
        `${dropped?.length ?? 0} positions; sent WITHOUT them, so that client's positions ` +
        'table is on its fallback poll rather than live.',
    );

    return JSON.stringify(withoutPositions);
  }
}
