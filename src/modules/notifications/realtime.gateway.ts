import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { Observable, Subject, filter, map } from 'rxjs';
import type { NotificationRecipient } from '../../store/notifications.store';

/** What the trigger sends. Deliberately tiny — see migration 0047. */
export interface NotificationEvent {
  id: string;
  recipientKind: 'client' | 'admin';
  recipientId: string;
  kind: string;
}

/** How long a dropped LISTEN connection waits before reconnecting. */
const RECONNECT_DELAY_MS = 2_000;

/**
 * The real-time seam: one Postgres `LISTEN` per instance, fanned out to the
 * SSE streams held open by this process.
 *
 * ## Why the database is the bus (migration 0047 has the long version)
 *
 * Half the notification writes happen inside somebody else's money
 * transaction, and `pg_notify` is delivered only if that transaction commits.
 * So "the client is told exactly when the decision becomes real" is a property
 * of the mechanism rather than something every call site has to remember.
 *
 * ## This is the seam a different transport would replace
 *
 * Everything above this class talks in terms of "a stream of events for this
 * recipient". SSE is what serves it today because notifications are one-way
 * server→client, which is what SSE is for — no dependency, no CSP change, and
 * the browser reconnects on its own. If a genuinely bidirectional or
 * high-frequency channel ever arrives (a price feed, not a payout), the
 * replacement is this file and the controllers' `@Sse()` handlers, not the
 * notification system.
 *
 * ## A dropped LISTEN is the failure mode worth engineering for
 *
 * If the connection dies and nothing reconnects, every stream stays open and
 * silent: the UI looks connected and simply never updates again, which is
 * worse than an error. So the client reconnects with a delay, re-issues
 * `LISTEN`, and says so in the log — and the frontends keep a slow poll as a
 * safety net underneath, so a silent bus degrades to the old behaviour rather
 * than to nothing.
 */
@Injectable()
export class NotificationsRealtimeGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsRealtimeGateway.name);
  private readonly events = new Subject<NotificationEvent>();
  private client: Client | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    // Tests drive the gateway directly; a listener per suite would hold a
    // connection open against a container that is about to be torn down.
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.events.complete();
    await this.client?.end().catch(() => undefined);
    this.client = null;
  }

  /**
   * The events for ONE recipient, as an Observable the SSE handler can return.
   *
   * Filtered here rather than at the subscriber, so a handler cannot forget:
   * every stream is scoped to the identity that opened it, and an admin's row
   * can never reach a client's connection because the pair must match on BOTH
   * columns — the same ownership rule the store's WHERE clause enforces.
   */
  streamFor(recipient: NotificationRecipient): Observable<NotificationEvent> {
    return this.events.pipe(
      filter(
        (event) => event.recipientKind === recipient.kind && event.recipientId === recipient.id,
      ),
      map((event) => event),
    );
  }

  /** Feeds an event in directly. For tests, and for a future in-process writer. */
  publish(event: NotificationEvent): void {
    this.events.next(event);
  }

  private async connect(): Promise<void> {
    const connectionString = this.config.get<string>('DATABASE_URL');
    if (!connectionString) {
      this.logger.warn(
        'DATABASE_URL is not set — real-time notifications are OFF. The bell still works: ' +
          'both frontends keep a slow poll underneath the stream for exactly this case.',
      );
      return;
    }

    /*
     * A DEDICATED connection, not one from the pool.
     *
     * A listening client is checked out for the lifetime of the process, so
     * taking it from the pool would permanently remove one connection from the
     * set the money path draws on — and `WalletService.post` needs a
     * connection to take its `FOR UPDATE` lock.
     */
    const client = new Client({ connectionString });
    this.client = client;

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
        this.events.next(JSON.parse(message.payload) as NotificationEvent);
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

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void (async () => {
        await this.client?.end().catch(() => undefined);
        this.client = null;
        this.logger.warn('Re-establishing the notification listener.');
        await this.connect();
      })();
    }, RECONNECT_DELAY_MS);
    // Never hold the process open for a reconnect — this is a courtesy channel.
    this.reconnectTimer.unref?.();
  }
}
