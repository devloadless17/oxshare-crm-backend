import { Observable, interval, map, merge, take, takeUntil, timer } from 'rxjs';
import type { NotificationEvent } from './realtime.gateway';
import type { NotificationRecipient } from '../../store/notifications.store';

/**
 * One SSE frame. Nest serialises `data` and writes the `type` as the event
 * name, which is what lets a browser listener distinguish a real event from
 * the keep-alive below.
 */
export interface StreamFrame {
  type: 'notification' | 'ping';
  data: { id?: string; kind?: string; at: string };
}

/**
 * How often the stream emits a keep-alive.
 *
 * Not decoration. An idle SSE connection is indistinguishable from a dead one
 * to every proxy between here and the browser, and the usual idle timeout is
 * sixty seconds — so a bell that is working perfectly gets its connection
 * culled during any quiet period, which is most of them. A frame every
 * twenty-five seconds keeps it demonstrably alive.
 */
const HEARTBEAT_MS = 25_000;

/**
 * How long one stream lives before the server closes it.
 *
 * ## This is an AUTHENTICATION control, not a resource one
 *
 * The guard authenticates when the stream OPENS and never again — there is no
 * second request to check. A connection held for eight hours would therefore
 * outlive the access token that opened it, and keep pushing to a session that
 * has since been signed out, suspended, or had its password changed.
 *
 * Ending the stream on a timer forces `EventSource` to reconnect, and the
 * reconnect goes through the full guard chain with whatever cookies the
 * browser holds now. A suspended admin's next reconnect is refused —
 * `AdminGuard` re-reads the row on every request, which is the property
 * `admin-suspension-http.spec.ts` exists to protect. Fifteen minutes is under
 * the access token's own life, so a stream never outlives its credential.
 *
 * The browser reconnects on its own, so this costs the reader nothing.
 */
const STREAM_TTL_MS = 15 * 60 * 1000;

/**
 * The frames one recipient's SSE connection emits.
 *
 * Pure and transport-shaped on purpose: the controllers hand it a filtered
 * event stream and it decides only what goes down the wire, so the heartbeat
 * and the TTL are stated once rather than in both controllers.
 *
 * The frame carries the id and kind, NOT the notification body. A reader acts
 * on it by re-reading the feed over the authenticated endpoint, so the content
 * never travels outside a permission-checked read — and a client that missed
 * frames while its laptop was asleep converges by refetching rather than by
 * replaying a log.
 */
export function notificationStream(
  events: Observable<NotificationEvent>,
  recipient: NotificationRecipient,
): Observable<StreamFrame> {
  void recipient;

  const closeAfter = timer(STREAM_TTL_MS);

  const notifications = events.pipe(
    map((event): StreamFrame => ({
      type: 'notification',
      data: { id: event.id, kind: event.kind, at: new Date().toISOString() },
    })),
  );

  /*
   * The first ping is immediate.
   *
   * It is what tells the browser the stream is genuinely open rather than
   * merely connecting, so the UI can stop polling as soon as it has proof —
   * and if the connection is going to fail, it fails now instead of at the
   * first real event, which might be hours away and unobserved.
   */
  const heartbeat = merge(timer(0).pipe(take(1)), interval(HEARTBEAT_MS)).pipe(
    map((): StreamFrame => ({ type: 'ping', data: { at: new Date().toISOString() } })),
  );

  return merge(notifications, heartbeat).pipe(takeUntil(closeAfter));
}

export const NOTIFICATION_STREAM_TTL_MS = STREAM_TTL_MS;
export const NOTIFICATION_HEARTBEAT_MS = HEARTBEAT_MS;
