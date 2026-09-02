import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db, Executor } from '../../database/db';

/**
 * The RESOURCES an operator's action can change under another operator's eyes.
 *
 * Deliberately a closed list rather than a free string: the frontends map each
 * name to the query keys it refreshes, and a name no frontend knows is an
 * event that costs a round trip and refreshes nothing.
 */
export const RESOURCES = ['kyc', 'withdrawals', 'ib-applications', 'clients', 'wallets'] as const;

export type ResourceName = (typeof RESOURCES)[number];

/** The Postgres channel. Separate from `notification_created` on purpose. */
export const RESOURCE_CHANGED_CHANNEL = 'resource_changed';

export interface ResourceChangedEvent {
  resource: ResourceName;
  /**
   * Who did it, so their own browser can ignore the echo — their screen
   * already refreshed from its own mutation. Absent for a system actor.
   */
  actorAdminId?: string;
}

/**
 * Tells every OTHER operator's console that a shared queue moved.
 *
 * ## Why this is not a notification row
 *
 * The bell already reaches admins, and it would have been less code to insert
 * a `notifications` row per reviewer. That is the wrong instrument: a row per
 * admin per decision fills every reviewer's bell with "another admin approved
 * a KYC document for a client you cannot see", which is noise that gets the
 * bell ignored, and it writes a permanent record of something nobody needs to
 * read later. This is a HINT that data moved, not news.
 *
 * ## Why it carries no data
 *
 * The payload is a resource NAME and nothing else. That is the property that
 * makes the whole feature safe: there is no client id, no amount, no status,
 * so fan-out cannot leak anything, and the receiving console still reads the
 * actual rows through the same permission- and scope-guarded endpoints it
 * always did. A mis-routed event costs a wasted request, never a disclosure.
 *
 * It is also why the socket does NOT scope delivery by permission. That was
 * designed and rejected: permission rooms would add a second authorization
 * surface — the exact drift `realtime.principal.ts` refuses for the handshake
 * — to protect a message with nothing in it. An admin who cannot see the KYC
 * queue has no KYC query mounted, so the invalidate matches nothing and fires
 * no request. The cost of telling them is a few bytes.
 *
 * ## Why `pg_notify` and not an in-process emit
 *
 * The API runs on more than one instance and the socket may be held by a
 * different one than served the request. Postgres is already the bus for
 * notifications, for the same reason. And NOTIFY is queued until COMMIT, so
 * passing the caller's transaction means a rolled-back decision cannot
 * announce itself — the same guarantee migration 0047's trigger gives.
 */
@Injectable()
export class ResourceChangedPublisher {
  private readonly logger = new Logger(ResourceChangedPublisher.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * @param executor pass the caller's transaction to hold the event until it
   *   commits. Omit it and the event fires immediately, which is correct from
   *   an interceptor running after the response is already on its way.
   */
  async publish(event: ResourceChangedEvent, executor: Executor = this.db): Promise<void> {
    try {
      await executor.execute(
        sql`SELECT pg_notify(${RESOURCE_CHANGED_CHANNEL}, ${JSON.stringify(event)})`,
      );
    } catch (error) {
      /*
       * NEVER throws. This runs after the work it describes has committed, so
       * a failure here must not turn a successful approval into a 500 — the
       * decision stands, and the only cost is that another operator's screen
       * waits for its 60s poll instead of updating in seconds. Degrading to
       * the old behaviour is the correct failure mode for a live-update hint.
       */
      this.logger.warn(
        `Could not announce a ${event.resource} change: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
