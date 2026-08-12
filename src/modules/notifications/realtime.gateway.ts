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
import { RealtimePrincipalResolver } from './realtime.principal';
import type { NotificationRecipient } from '../../store/notifications.store';

/** What the Postgres trigger sends. Deliberately tiny — see migration 0047. */
export interface NotificationEvent {
  id: string;
  recipientKind: 'client' | 'admin';
  recipientId: string;
  kind: string;
}

/** The one namespace both apps connect to. See the class note on why one. */
export const REALTIME_NAMESPACE = '/realtime';

/** The event a client listens for. Future features add NAMES, not connections. */
export const NOTIFICATION_EVENT = 'notification.created';

/** How long a dropped LISTEN connection waits before reconnecting. */
const RECONNECT_DELAY_MS = 2_000;

/**
 * The absolute ceiling on one socket's life, when the token carries no usable
 * expiry. Under the access token's own life either way — see `armReauth`.
 */
const MAX_SOCKET_LIFETIME_MS = 15 * 60 * 1000;

/** A room holds exactly one principal's sockets — every tab they have open. */
function roomFor(recipient: NotificationRecipient): string {
  return `${recipient.kind}:${recipient.id}`;
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
   */
  cors: {
    origin: [
      process.env['PORTAL_URL'] ?? 'http://localhost:3000',
      process.env['ADMIN_URL'] ?? 'http://localhost:3002',
    ],
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
   */
  async handleConnection(socket: Socket): Promise<void> {
    const principal = await this.principals.resolve(socket.handshake.headers.cookie);

    if (!principal) {
      // The client is told WHY, so the frontend can stop retrying a connection
      // that will never succeed and send the reader to sign in instead.
      socket.emit('unauthorized');
      socket.disconnect(true);
      return;
    }

    const room = roomFor(principal.recipient);
    await socket.join(room);
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

  /** Emit one event into its recipient's room. */
  publish(event: NotificationEvent): void {
    const room = roomFor({ kind: event.recipientKind, id: event.recipientId });
    this.server?.to(room).emit(NOTIFICATION_EVENT, { id: event.id, kind: event.kind });
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

    client.on('error', (error: Error) => {
      this.logger.error(`LISTEN connection errored: ${error.message}`);
      this.scheduleReconnect();
    });
    client.on('end', () => {
      if (!this.stopped) this.scheduleReconnect();
    });

    client.on('notification', (message) => {
      if (!message.payload) return;
      try {
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
      this.logger.log('Listening for notification events.');
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
        await this.listener?.end().catch(() => undefined);
        this.listener = null;
        this.logger.warn('Re-establishing the notification listener.');
        await this.listen();
      })();
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref?.();
  }
}
