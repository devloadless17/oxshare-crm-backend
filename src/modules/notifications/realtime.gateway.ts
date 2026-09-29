import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { Client } from 'pg';
import {
  RESOURCE_CHANGED_CHANNEL,
  type ResourceChangedEvent,
} from '../../common/realtime/resource-changed';
import {
  MT5_LIVE_CHANNEL,
  MT5_LIVE_EVENT,
  decodeLiveEvent,
  type Mt5LiveEvent,
} from '../trading/mt5/live-snapshot';
import { RealtimePrincipalResolver } from './realtime.principal';
import type { NotificationRecipient } from '../../store/notifications.store';

/**
 * What the Postgres trigger sends — see migrations 0047 and 0061.
 *
 * `params` is OPTIONAL and that is a contract, not laziness: the trigger drops
 * it when the payload would exceed `pg_notify`'s 8000-byte limit (an unbounded
 * rejection reason is the realistic case). A consumer must therefore treat its
 * absence as normal and fall back to generic copy, which is the same path an
 * unrecognised `kind` already takes in both frontends.
 */
export interface NotificationEvent {
  id: string;
  recipientKind: 'client' | 'admin';
  recipientId: string;
  kind: string;
  params?: Record<string, unknown>;
  /**
   * The Portal ID of the client an ADMIN task is about (migration 0140), so a
   * toast can say "#1000245" on arrival. Never a name: names are masked per
   * reader, which only the HTTP read can do.
   */
  subjectPortalId?: number | null;
}

/**
 * A row was READ or RESOLVED — the recipient's badge and lists are stale.
 * Names a room and nothing else; the browser re-reads through the scoped,
 * permission-checked endpoint.
 */
export interface NotificationChangedEvent {
  recipientKind: 'client' | 'admin';
  recipientId: string;
}

/** Postgres channel for `NotificationChangedEvent` — see migration 0140. */
export const NOTIFICATION_CHANGED_CHANNEL = 'notification_changed';

/** The one namespace both apps connect to. See the class note on why one. */
export const REALTIME_NAMESPACE = '/realtime';

/** The event a client listens for. Future features add NAMES, not connections. */
export const NOTIFICATION_EVENT = 'notification.created';

/**
 * The event that says a SHARED QUEUE moved — a second operator decided
 * something you are looking at. Carries a resource name and nothing else; see
 * `common/realtime/resource-changed.ts` for why that emptiness is the point.
 */
export const RESOURCE_EVENT = 'resource.changed';

/**
 * "Your notifications changed" — one of yours was read in another tab, or a
 * task you hold was handled by somebody else and left your inbox. Carries no
 * data at all; see `NotificationChangedEvent`.
 */
export const NOTIFICATION_CHANGED_EVENT = 'notification.changed';

/**
 * Every admin socket, whoever they are.
 *
 * `admin:<id>` addresses ONE operator's tabs and is what personal
 * notifications use. This is the broadcast room, and it exists because a queue
 * is shared: an approval by anyone changes what everyone else is looking at.
 * Deliberately NOT split by permission — the event has no data in it, so
 * scoping delivery would add a second authorization surface to protect
 * nothing, and an operator with no KYC screen mounted refetches nothing when
 * told the KYC queue moved.
 */
export const ADMIN_BROADCAST_ROOM = 'admins';

/** How long a dropped LISTEN connection waits before reconnecting. */
const RECONNECT_DELAY_MS = 2_000;

/**
 * The absolute ceiling on one socket's life, when the token carries no usable
 * expiry. Under the access token's own life either way — see `armReauth`.
 */
const MAX_SOCKET_LIFETIME_MS = 15 * 60 * 1000;

/** A room holds exactly one principal's sockets — every tab they have open. */
function roomFor(recipient: { kind: NotificationRecipient['kind']; id: string | number }): string {
  return `${recipient.kind}:${recipient.id}`;
}

/**
 * The origins allowed to hold a socket, read at REQUEST time.
 *
 * Deliberately a function, not a constant. `@WebSocketGateway`'s options object
 * is evaluated when this MODULE IS IMPORTED, which happens before
 * `NestFactory.create` runs `ConfigModule.forRoot()` and loads `.env` into
 * `process.env`. A constant here would therefore capture `undefined` and pin
 * both origins to their localhost fallbacks in every deployment — invisible in
 * development, where the fallbacks are correct, and a total CORS refusal of the
 * polling transport in production.
 *
 * `main.ts` reads the same two variables safely because it runs inside
 * `bootstrap()`, after the config has loaded.
 */
function allowedOrigins(): string[] {
  return [
    process.env['PORTAL_URL'] ?? 'http://localhost:3000',
    process.env['ADMIN_URL'] ?? 'http://localhost:3002',
  ];
}

/**
 * The realtime transport: Socket.IO, authenticated by session cookie, with one
 * room per principal.
 *
 * ## One connection, many event kinds — the reason this is a socket
 *
 * The tech lead's call, and the design follows it properly rather than
 * minimally: this is a single `/realtime` namespace that every future live
 * feature shares. A deposit settling, a withdrawal changing state, a balance
 * moving — each becomes a new EVENT NAME emitted into the same rooms, over the
 * connection the browser already holds. Nothing else opens a second socket.
 *
 * That is what makes the choice pay off. Adding `withdrawal.state_changed`
 * later is one `emit` and one listener; it costs no new connection, no new
 * handshake, no second authentication path, and no extra entry in the
 * browser's per-origin connection budget.
 *
 * ## Rooms, not per-socket bookkeeping
 *
 * `admin:<uuid>` / `client:<uuid>`. Socket.IO owns the membership, so an
 * operator with four tabs is four sockets in one room and an emit reaches all
 * of them; a disconnect cleans itself up. The kind is part of the room name,
 * so an admin id and a client id that happened to collide still cannot reach
 * each other — the same ownership rule the store's WHERE clause enforces.
 *
 * ## The BUS is still Postgres, and that is not an oversight
 *
 * Half the notification writes happen inside somebody else's money
 * transaction, and `pg_notify` is delivered only if that transaction COMMITS
 * (migration 0047). So the socket is how an event reaches a browser; the
 * trigger is how this process learns the row became real. Emitting from
 * application code instead would announce a withdrawal approval that a
 * rollback then undid — the UI contradicting the ledger.
 *
 * It also solves the multi-instance problem for free, with no Redis adapter:
 * EVERY backend instance LISTENs, so a row written by instance A is emitted by
 * instance B to the sockets B holds. The usual reason to add
 * `@socket.io/redis-adapter` is to reach sockets on another node; here the
 * database already told every node.
 *
 * ## A socket does not outlive its credential
 *
 * Cookies are checked at the HANDSHAKE and there is no second request to
 * re-check on. So each socket is closed when its access token expires (or at a
 * fifteen-minute ceiling), and the client reconnects — through the full
 * authenticator, which re-reads `admins.status`. A suspended operator's socket
 * therefore dies within the window rather than at token expiry, which is the
 * property `admin-suspension-http.spec.ts` protects on the HTTP surface.
 */
@Injectable()
@WebSocketGateway({
  namespace: REALTIME_NAMESPACE,
  /*
   * Both frontend origins, with credentials — the browser connects DIRECTLY to
   * the API rather than through each app's `/api` rewrite, because a Next
   * rewrite does not proxy a WebSocket upgrade. That is also why both apps'
   * CSP `connect-src` names this origin.
   *
   * A CALLBACK, so the allowlist is read per request rather than captured when
   * this module is imported — see `allowedOrigins`.
   *
   * This is the POLLING transport's protection only, and it is not what secures
   * the socket. CORS is a browser-enforced rule on XHR; a WebSocket upgrade is
   * not CORS-checked by browsers at all, so an origin refused here can still
   * complete a `wss://` handshake. `handleConnection` is where the origin is
   * actually enforced, for both transports.
   */
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, ok?: boolean) => void) =>
      callback(null, !origin || allowedOrigins().includes(origin)),
    credentials: true,
  },
  /*
   * WebSocket first, long-polling kept as the fallback.
   *
   * The fallback is what keeps a hostile proxy from being the one place this
   * silently stops: where an upgrade is blocked, Socket.IO degrades to polling
   * on its own and the feature still works, slower. Removing it would trade a
   * measurable win for an unreportable failure.
   */
  transports: ['websocket', 'polling'],
})
export class NotificationsRealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationsRealtimeGateway.name);

  @WebSocketServer()
  private server!: Server;

  private listener: Client | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Per-socket re-auth timers, cleared on disconnect so none leaks. */
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: ConfigService,
    private readonly principals: RealtimePrincipalResolver,
  ) {}

  async onModuleInit(): Promise<void> {
    // Tests drive the gateway directly; a listener per suite would hold a
    // connection open against a container about to be torn down.
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    await this.listen();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    await this.listener?.end().catch(() => undefined);
    this.listener = null;
  }

  /**
   * Authenticate the handshake and put the socket in its room.
   *
   * A refused connection is DISCONNECTED rather than left open unauthenticated
   * — an unauthenticated socket in no room receives nothing, but it still
   * holds a file descriptor and looks connected to the browser, which would
   * make an expired session indistinguishable from a quiet one.
   *
   * NOTHING is allowed to throw out of here. Nest does not await this promise,
   * so a rejection becomes an unhandled rejection, and under Node's default
   * that ends the process — from a header an anonymous caller chose.
   */
  async handleConnection(socket: Socket): Promise<void> {
    try {
      await this.admit(socket);
    } catch (error) {
      this.logger.error(
        `Refusing a handshake that failed unexpectedly: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      socket.emit('unauthorized');
      socket.disconnect(true);
    }
  }

  private async admit(socket: Socket): Promise<void> {
    /*
     * ORIGIN FIRST, before any authentication work.
     *
     * This is the socket's half of the control `CsrfGuard.assertOriginAllowed`
     * applies to every cookie-authenticated write, and it exists for exactly
     * the reason recorded in `session-cookies.ts`: OxShare runs many sites on
     * one registrable domain, so `SameSite=Lax` does NOT stop a sibling
     * `*.oxshare.com` page — the browser considers it same-site and sends the
     * session cookie. Without this check any such page could open a socket AS
     * the reader and receive their notifications, which is precisely the
     * cookie-tossing neighbour the HTTP guard was written to exclude.
     *
     * The gateway's `cors` option does not cover this. Browsers do not
     * CORS-check a WebSocket upgrade, so `cors.origin` refusing an origin only
     * withholds a response header the browser never consults on this path.
     *
     * Exact equality, never a suffix test — `endsWith('.oxshare.com')` also
     * matches `evil-oxshare.com`. A handshake with no Origin at all is refused
     * on the same reasoning the HTTP guard records: every browser sends one, so
     * its absence is a non-browser client, and a non-browser client should not
     * be holding a session cookie.
     */
    const origin = socket.handshake.headers.origin;
    const portalUrl = this.config.get<string>('PORTAL_URL') ?? 'http://localhost:3000';
    const adminUrl = this.config.get<string>('ADMIN_URL') ?? 'http://localhost:3002';
    if (!origin || (origin !== portalUrl && origin !== adminUrl)) {
      this.logger.warn(`Refused a socket from origin ${origin ?? '(absent)'}`);
      socket.emit('unauthorized');
      socket.disconnect(true);
      return;
    }

    /*
     * The ORIGIN decides which surface this socket belongs to, and the
     * principal resolver is given that answer rather than guessing from which
     * cookies happen to be present.
     *
     * Cookies are scoped by host and NOT by port, so a browser signed into both
     * apps sends both session cookies on either app's handshake — which is how
     * the portal's socket used to be authenticated as an admin and joined the
     * admin room. See the note in `realtime.principal.ts`.
     *
     * Safe to derive here because the check above has already refused anything
     * that is not exactly one of the two configured origins.
     */
    const surface = origin === adminUrl ? 'admin' : 'client';

    const principal = await this.principals.resolve(socket.handshake.headers.cookie, surface);

    if (!principal) {
      // The client is told WHY, so the frontend can stop retrying a connection
      // that will never succeed and send the reader to sign in instead.
      socket.emit('unauthorized');
      socket.disconnect(true);
      return;
    }

    /*
     * The socket may have gone during the authentication above — a tab closed,
     * a network dropped. Joining a dead socket leaves an entry in the adapter's
     * room map that no disconnect will ever remove, and arming its timer after
     * `handleDisconnect` has already run leaks that timer for a quarter of an
     * hour. Both are per-connection, so a flapping client compounds them.
     */
    if (socket.disconnected) return;

    const room = roomFor(principal.recipient);
    await socket.join(room);
    // Admins additionally join the broadcast room, so one operator's decision
    // can reach every other operator's open queue.
    if (principal.recipient.kind === 'admin') await socket.join(ADMIN_BROADCAST_ROOM);
    // Stored so a disconnect can log meaningfully; never read for
    // authorization. `socket.data` is `any` in the Socket.IO types, so it is
    // narrowed here rather than trusted.
    (socket.data as { room?: string }).room = room;

    this.armReauth(socket, principal.expiresAt);
  }

  handleDisconnect(socket: Socket): void {
    const timer = this.expiryTimers.get(socket.id);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(socket.id);
    }
  }

  /**
   * Close the socket when its credential dies, so the reconnect re-authenticates.
   *
   * Capped at fifteen minutes even when the token would live longer, and
   * applied at the ceiling when the expiry is unreadable: an unknown expiry
   * must not become an immortal session.
   */
  private armReauth(socket: Socket, expiresAt: number | null): void {
    const untilExpiry = expiresAt ? expiresAt - Date.now() : MAX_SOCKET_LIFETIME_MS;
    const delay = Math.max(1_000, Math.min(untilExpiry, MAX_SOCKET_LIFETIME_MS));

    const timer = setTimeout(() => {
      this.expiryTimers.delete(socket.id);
      // `session_expired` rather than a bare close: the frontend reconnects on
      // its own, and naming the reason keeps that from looking like an error.
      socket.emit('session_expired');
      socket.disconnect(true);
    }, delay);
    timer.unref?.();

    this.expiryTimers.set(socket.id, timer);
  }

  /**
   * Emit one event into its recipient's room.
   *
   * `params` rides along so the browser can TOAST the event on arrival —
   * "Deposit of $500.00 succeeded" — rather than fetching the row first and
   * showing the toast visibly later than the thing it announces. It is passed
   * through only when the trigger sent it (migration 0061); `undefined` is
   * omitted from the emitted object rather than sent as an explicit null, so a
   * listener's `params ?? fallback` reads correctly.
   *
   * The room is the permission boundary: it holds exactly the sockets of the
   * principal this row names, authenticated at the handshake. So `params`
   * reaches the one reader `GET /notifications` would have served it to.
   */
  publish(event: NotificationEvent): void {
    const room = roomFor({ kind: event.recipientKind, id: event.recipientId });
    this.server?.to(room).emit(NOTIFICATION_EVENT, {
      id: event.id,
      kind: event.kind,
      ...(event.params ? { params: event.params } : {}),
      ...(typeof event.subjectPortalId === 'number'
        ? { subjectPortalId: event.subjectPortalId }
        : {}),
    });
  }

  /**
   * Tell one principal's open tabs that their notifications changed.
   *
   * The room is the whole routing decision and the payload is empty: what
   * changed is re-read over HTTP, where scope and permissions apply. That is
   * what lets a resolution — one admin approving — clear the task from every
   * other admin's inbox within a second, without this event ever describing a
   * client to somebody who may no longer be allowed to see them.
   */
  publishNotificationChange(event: NotificationChangedEvent): void {
    this.server
      ?.to(roomFor({ kind: event.recipientKind, id: event.recipientId }))
      .emit(NOTIFICATION_CHANGED_EVENT, {});
  }

  /**
   * Tell every OTHER operator that a shared queue moved.
   *
   * `.except(roomFor(actor))` skips the operator who did it: their own screen
   * refreshed from its own mutation the moment the request returned, so the
   * echo would be a second, redundant refetch of everything they are looking
   * at — on the console where an approval is most likely to be followed
   * immediately by another one.
   *
   * Nothing is emitted when no server is attached (`REALTIME_ENGINE` unset in
   * a unit test), which is why the optional chain stays.
   */
  /**
   * Deliver one live MT5 reading to the client whose account it is.
   *
   * ## Why this is a new EVENT NAME and not a new connection
   *
   * Exactly what the class note above promises: every future live feature is a
   * name on the one socket. This client already holds a connection for their
   * notification bell, so the account screen costs no handshake, no second
   * origin check, and no second authorization surface — it addresses the room
   * the socket already joined.
   *
   * ## The room IS the authorization
   *
   * `client:<userId>` was resolved from the account's owner before this was
   * published, so a reading can only reach the person who owns the account.
   * Unlike `resource.changed` — which carries no data precisely so that a
   * mis-routed event cannot leak — this payload IS the data, so the room has to
   * be right. It is derived from the trading account row, never from anything
   * the socket or the bridge said.
   *
   * ## Dropped when nobody is listening, and that is the normal case
   *
   * A watch outlives the socket that prompted it by up to a lease, so readings
   * keep arriving for a few seconds after a client closes the tab. There is
   * nothing to do with those: `.to()` on an empty room is a no-op, the bridge's
   * lease expires, and the reads stop. No cleanup, no error.
   */
  publishLiveAccount(event: Mt5LiveEvent): void {
    const { userId, ...figures } = event;
    this.server?.to(roomFor({ kind: 'client', id: userId })).emit(MT5_LIVE_EVENT, figures);
  }

  publishResourceChange(event: ResourceChangedEvent): void {
    const audience = event.actorAdminId
      ? this.server
          ?.to(ADMIN_BROADCAST_ROOM)
          .except(roomFor({ kind: 'admin', id: event.actorAdminId }))
      : this.server?.to(ADMIN_BROADCAST_ROOM);
    audience?.emit(RESOURCE_EVENT, { resource: event.resource });
  }

  /** How many sockets a principal currently holds. For tests and diagnostics. */
  async socketsIn(recipient: NotificationRecipient): Promise<number> {
    const sockets = await this.server.in(roomFor(recipient)).fetchSockets();
    return sockets.length;
  }

  // ── The bus: one Postgres LISTEN per instance ────────────────────────────

  private async listen(): Promise<void> {
    const connectionString = this.config.get<string>('DATABASE_URL');
    if (!connectionString) {
      this.logger.warn(
        'DATABASE_URL is not set — real-time notifications are OFF. The bell still works: ' +
          'both frontends keep a slow poll underneath the socket for exactly this case.',
      );
      return;
    }

    /*
     * A DEDICATED connection, not one from the pool. A listening client is
     * checked out for the life of the process, so taking it from the pool
     * would permanently remove a connection the money path draws on —
     * `WalletService.post` needs one to take its `FOR UPDATE` lock.
     */
    const client = new Client({ connectionString });
    this.listener = client;

    /*
     * Both handlers check that this client is STILL the live listener.
     *
     * Without that identity test, replacing the connection re-enters the
     * reconnect: `end()` on the outgoing client emits `'end'`, whose handler
     * schedules another reconnect, which two seconds later ends the healthy
     * connection that just replaced it — and so on, permanently, tearing the
     * listener down every two seconds and dropping every event that lands in
     * the gaps. `stopped` guards shutdown but says nothing about replacement.
     */
    const isCurrent = () => this.listener === client;

    client.on('error', (error: Error) => {
      if (!isCurrent()) return;
      this.logger.error(`LISTEN connection errored: ${error.message}`);
      this.scheduleReconnect();
    });
    client.on('end', () => {
      if (this.stopped || !isCurrent()) return;
      this.scheduleReconnect();
    });

    client.on('notification', (message) => {
      if (!message.payload) return;
      try {
        if (message.channel === RESOURCE_CHANGED_CHANNEL) {
          this.publishResourceChange(JSON.parse(message.payload) as ResourceChangedEvent);
          return;
        }
        if (message.channel === NOTIFICATION_CHANGED_CHANNEL) {
          this.publishNotificationChange(JSON.parse(message.payload) as NotificationChangedEvent);
          return;
        }
        if (message.channel === MT5_LIVE_CHANNEL) {
          /*
           * `decodeLiveEvent`, not `JSON.parse`: a large reading arrives gzipped
           * so that a trader with hundreds of open positions still gets them.
           * The decoder owns which form is which — see its note.
           */
          this.publishLiveAccount(decodeLiveEvent(message.payload));
          return;
        }
        this.publish(JSON.parse(message.payload) as NotificationEvent);
      } catch (error) {
        // A malformed payload is a bug in the trigger, not a reason to stop
        // listening for every other event.
        this.logger.error(
          `Ignoring an unparseable notification payload: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    try {
      await client.connect();
      await client.query('LISTEN notification_created');
      /*
       * A SECOND channel on the SAME connection. A listening client is checked
       * out for the life of the process, so a channel per connection would
       * cost a permanent Postgres connection per feature; `message.channel`
       * separates them for free.
       */
      await client.query(`LISTEN ${RESOURCE_CHANGED_CHANNEL}`);
      /*
       * A THIRD channel, and the first one that is high-rate: the bridge pushes
       * a reading per watched account per round while anybody has an account
       * screen open. It shares this connection for the same reason — a channel
       * per feature would cost a permanent Postgres connection each — and it is
       * safe to share because nothing on this path writes or waits. A payload
       * is parsed and emitted into one room.
       */
      await client.query(`LISTEN ${MT5_LIVE_CHANNEL}`);
      /*
       * A FOURTH, low-rate: a row read or resolved (migration 0140). Same
       * connection for the same reason as the others, and the same shape as
       * the first — a room to address, never data to leak.
       */
      await client.query(`LISTEN ${NOTIFICATION_CHANGED_CHANNEL}`);
      this.logger.log(
        'Listening for notification, notification-change, resource-change and live-account events.',
      );
    } catch (error) {
      this.logger.error(
        `Could not start listening for notifications: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduleReconnect();
    }
  }

  /**
   * A dropped LISTEN is the failure worth engineering for: every socket stays
   * open and silent, so the UI looks connected and never updates again — worse
   * than an error, because nothing reports it.
   */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void (async () => {
        /*
         * Detach the outgoing client BEFORE ending it, and clear `listener`
         * first so its handlers see themselves as stale. Ending a pg client
         * emits `'end'`; a handler still attached would schedule the next
         * reconnect and the loop would never settle.
         */
        const outgoing = this.listener;
        this.listener = null;
        if (outgoing) {
          outgoing.removeAllListeners();
          await outgoing.end().catch(() => undefined);
        }
        if (this.stopped) return;
        this.logger.warn('Re-establishing the notification listener.');
        await this.listen();
      })();
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }
}
