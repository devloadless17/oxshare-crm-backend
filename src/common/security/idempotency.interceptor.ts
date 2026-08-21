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
import { and, eq, isNull } from 'drizzle-orm';
import { Observable, from, of, switchMap, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
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
 *   4. Handler threw → release the claim. A request that failed produced no
 *      operation, so it must leave no trace: see the note at the `catchError`.
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
    /*
     * PATH PARAMETERS ARE PART OF THE INTENT. The endpoint above is the route
     * PATTERN, so `PATCH /admin/withdrawals/:id/approve` for two different ids
     * is one endpoint — and with an empty body, one key reused across them
     * hashed identically, replayed the first withdrawal's stored answer, and
     * reported success while the second was never approved. Folding the params
     * into the hash turns that into the "same key, different request" refusal
     * it should always have been.
     */
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ params: req.params ?? {}, body: req.body ?? {} }))
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
          return next.handle().pipe(
            switchMap((body: unknown) =>
              from(this.record(key, endpoint, actorId, res.statusCode, body)).pipe(
                map((): unknown => body),
              ),
            ),
            // A handler that THREW never produced an operation to be idempotent
            // about, so the claim must not outlive it.
            //
            // Without this the row survives with responseStatus NULL forever,
            // and the key is poisoned in both directions: resubmitting the same
            // body 409s ("still being processed") for an operation that already
            // finished failing, and resubmitting a CORRECTED body 422s on the
            // hash mismatch. A client that holds one key per intent — which is
            // what R-5.2 asks for, and what `newIdempotencyKey`'s contract
            // describes — would strand the user on the first validation error:
            // rejected for $5, unable to then ask for $50.
            //
            // Releasing restores the intended meaning. A retry of a failed
            // attempt is a fresh claim, while the double-click this exists to
            // stop is unaffected: that races two requests at a SUCCEEDING
            // handler, where the row is held until the response is stored.
            catchError((err: unknown) =>
              from(this.release(key, endpoint, actorId)).pipe(
                switchMap(() => throwError(() => err)),
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
   * Drops a claim whose handler threw, so the key can be claimed again.
   *
   * Deliberately narrow: it deletes only a row this request owns and that still
   * has no stored response. The `responseStatus IS NULL` predicate is what makes
   * it safe under a race — if a concurrent replay somehow recorded a response
   * first, this leaves it alone rather than deleting an answer another caller
   * may already have been given.
   */
  private async release(key: string, endpoint: string, actorId: string): Promise<void> {
    try {
      await this.db
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.key, key),
            eq(idempotencyKeys.endpoint, endpoint),
            eq(idempotencyKeys.actorId, actorId),
            isNull(idempotencyKeys.responseStatus),
          ),
        );
    } catch (error) {
      // Same rule as `record`: bookkeeping must not replace the error the caller
      // actually needs to see. A claim left behind degrades to the old
      // behaviour for that one key, which is a stuck retry, not a lost or
      // duplicated payment.
      this.logger.error(
        `Could not release the idempotency claim for ${endpoint} key ${key}: ` +
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
}
