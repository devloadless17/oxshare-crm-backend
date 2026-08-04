import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { createHash } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Observable, from, of, switchMap } from 'rxjs';
import { map } from 'rxjs/operators';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { idempotencyKeys } from '../../database/schema';
import { ConflictError, ValidationError } from '../errors/domain-errors';

/**
 * Marks a route as requiring an `Idempotency-Key`.
 *
 * Opt-in rather than global, deliberately: replay protection only means anything
 * where a repeat would have a second EFFECT, and storing a response body for
 * every read would be a large table for no benefit. Put it on anything that
 * creates or moves money.
 */
export const IDEMPOTENT_KEY = 'idempotent';
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Rows older than this are swept; long enough to cover any sane client retry. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;

interface StoredResponse {
  responseStatus: number | null;
  responseBody: Record<string, unknown> | null;
  requestHash: string;
}

/**
 * Makes a replayed money-moving request a no-op that returns the first answer.
 *
 * PLATFORM-CONVENTIONS R-5.2. The problem it solves is specific: a
 * double-clicked withdrawal button sends two requests that are genuinely
 * distinct as far as the database is concerned. Both pass validation, both
 * insert a transaction, both place a hold — the client's available balance drops
 * twice for one intended withdrawal and an admin sees two requests to approve.
 * The §6.3 constraints could not catch it, because nothing about the second
 * request is a duplicate of anything.
 *
 * The caller supplies the identity, and the UNIQUE index does the work:
 *
 *   1. INSERT the key. `ON CONFLICT DO NOTHING`, so the insert IS the lock —
 *      never a SELECT first, which is the check-then-insert race §6.3 warns
 *      about and which under a double-click is not theoretical at all.
 *   2. Inserted → this is the first request. Run the handler, store its response.
 *   3. Not inserted → a replay:
 *        - stored response present → return it verbatim, run nothing;
 *        - still in flight (no response yet) → 409, because answering with a
 *          half-written result would be worse than asking the caller to retry;
 *        - same key, DIFFERENT body → 422. Returning the first response would
 *          tell the caller their second, different request had succeeded.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE_DB) private readonly db: Db,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return next.handle();

    const req = context.switchToHttp().getRequest<Request & { user?: { id: string } }>();
    const res = context.switchToHttp().getResponse<Response>();

    const key = req.get(IDEMPOTENCY_HEADER);
    if (!key) {
      // A hard failure, not a silent pass-through. An endpoint that accepts
      // requests with and without a key is only protected for the callers who
      // remembered, which is the same as not being protected.
      throw new ValidationError(
        `This endpoint requires an ${IDEMPOTENCY_HEADER} header: a unique value per intended ` +
          'operation, reused only when retrying that same operation.',
      );
    }

    const actorId = this.actorOf(req);
    // The ROUTE pattern ('/payments/withdrawals'), not the concrete URL, so a
    // key is scoped to the operation rather than to one instance of it. Typed
    // explicitly because Express declares `req.route` as `any`.
    const route = (req.route as { path?: string } | undefined)?.path;
    const endpoint = `${req.method} ${route ?? req.path}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? {}))
      .digest('hex');

    return from(this.claim({ key, endpoint, actorId, requestHash })).pipe(
      switchMap((existing) => {
        if (!existing) {
          // We own this key. Run the handler, then store its answer BEFORE
          // emitting it.
          //
          // Storing after the fact (fire-and-forget) leaves a window in which
          // the first request has already answered but the row still reads "in
          // flight" — so a retry arriving in that gap gets a 409 telling it to
          // try later, for an operation that has in fact completed. Rare, and
          // exactly the kind of rare that shows up as "the app told me my
          // withdrawal was still processing and then it wasn't there".
          // `unknown`, not the `any` that CallHandler.handle() hands back: the
          // body is opaque here and is only ever stored and re-emitted.
          return next
            .handle()
            .pipe(
              switchMap((body: unknown) =>
                from(this.record(key, endpoint, actorId, res.statusCode, body)).pipe(
                  map((): unknown => body),
                ),
              ),
            );
        }

        if (existing.requestHash !== requestHash) {
          throw new ValidationError(
            `This ${IDEMPOTENCY_HEADER} was already used for a different request. Use a new key ` +
              'for a new operation, and reuse a key only to retry the identical one.',
          );
        }

        if (existing.responseStatus === null) {
          throw new ConflictError(
            'An identical request is still being processed. Retry in a moment; it will not run twice.',
          );
        }

        this.logger.log(`Replayed ${endpoint} for key ${key} — handler not executed`);
        res.status(existing.responseStatus);
        return of(existing.responseBody);
      }),
    );
  }

  /**
   * Claims the key, or reports who holds it.
   *
   * Returns null when THIS request won the insert; otherwise the existing row.
   */
  private async claim(row: {
    key: string;
    endpoint: string;
    actorId: string;
    requestHash: string;
  }): Promise<StoredResponse | null> {
    const inserted = await this.db
      .insert(idempotencyKeys)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: idempotencyKeys.id });

    if (inserted.length > 0) return null;

    const [existing] = await this.db
      .select({
        responseStatus: idempotencyKeys.responseStatus,
        responseBody: idempotencyKeys.responseBody,
        requestHash: idempotencyKeys.requestHash,
      })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.key, row.key),
          eq(idempotencyKeys.endpoint, row.endpoint),
          eq(idempotencyKeys.actorId, row.actorId),
        ),
      )
      .limit(1);

    // A row that vanished between the failed insert and this read can only be
    // the retention sweep. Treating it as "we own it" is right: nothing is
    // stored to replay, so running the handler is the correct answer.
    return existing ?? null;
  }

  private async record(
    key: string,
    endpoint: string,
    actorId: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    try {
      await this.db
        .update(idempotencyKeys)
        .set({
          responseStatus: status,
          responseBody: body as Record<string, unknown>,
        })
        .where(
          and(
            eq(idempotencyKeys.key, key),
            eq(idempotencyKeys.endpoint, endpoint),
            eq(idempotencyKeys.actorId, actorId),
          ),
        );
    } catch (error) {
      // Never fail a completed money operation because bookkeeping failed. The
      // consequence is that one retry may re-run rather than replay, which is
      // strictly better than failing a withdrawal that already succeeded.
      this.logger.error(
        `Could not store the idempotent response for ${endpoint} key ${key}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Whose key this is.
   *
   * Scoped to the authenticated principal so two users choosing "1" do not
   * collide — and so one user cannot occupy another's key space. An
   * unauthenticated caller cannot reach these routes; the fallback exists so
   * this never throws before the auth guard has spoken.
   */
  private actorOf(req: Request & { user?: { id: string }; admin?: { id: string } }): string {
    return req.user?.id ?? req.admin?.id ?? '00000000-0000-0000-0000-000000000000';
  }

  /**
   * Deletes rows past the retention window.
   *
   * Called by a scheduled job. Without it this table grows forever, and its only
   * purpose is to answer retries that stopped being plausible a day ago.
   */
  static sweepQuery(db: Db) {
    return db
      .delete(idempotencyKeys)
      .where(
        sql`${idempotencyKeys.createdAt} < now() - interval '${sql.raw(String(IDEMPOTENCY_RETENTION_HOURS))} hours'`,
      );
  }
}
