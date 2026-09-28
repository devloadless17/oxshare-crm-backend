import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { FieldMask } from './field-mask';
import { maskByShape } from './mask-by-shape';

/**
 * RBAC-03, applied to every ADMIN response, without anybody remembering to.
 *
 * ## The question this exists to answer
 *
 * Marking a field on its DTO fixes the ARITHMETIC of masking — one annotation
 * instead of an alias per surface. It does not, on its own, fix the FAILURE
 * MODE. If the decision to mask is still a hand-written call per surface, the
 * defect class survives intact: it has moved from `applyMask` to `maskByShape`
 * and nothing else has changed. Same opt-in, same forgetting, nine exposures and
 * counting.
 *
 * So the call has to stop being a call. Here the question is no longer "did
 * somebody remember to mask this response" but "was this request authenticated
 * as an administrator" — which the guard table already answers, on every route,
 * without being asked.
 *
 * ## Why `req.admin` is the right discriminator, and not a route pattern
 *
 * Exposure 8 is the proof that this distinction is real and cannot be inferred
 * from the shape. `ib-overview.service.ts` projects client identity and is
 * CORRECTLY unmasked, because it is reached only through `ib.controller.ts` with
 * `req.user.id` — a partner reading their own network in the portal, where an
 * administrator's field mask has no standing. The same DTO must be masked on one
 * path and untouched on the other.
 *
 * `AdminGuard` sets `req.admin`; nothing on the portal path does. So the portal
 * is not exempted by a list somebody maintains — it is structurally outside,
 * because it never carries an admin principal at all. A path pattern would have
 * to be kept in step with the routing table by hand, which is the class of
 * bookkeeping this whole exercise is removing.
 *
 * ## What it deliberately does NOT do
 *
 * It does not mask BYTE STREAMS — a CSV or a stored file passes through as
 * whatever the handler returned. That is not an oversight and cannot be fixed
 * here: by the time a response is a stream the rows are gone. Exports therefore
 * mask their ROWS before serialising, and the rule that keeps the two honest is
 * that both must use the same field declarations — one definition, two call
 * sites. `cc53b4b → 8eb3574` is what two definitions cost: the withdrawal desk
 * masked and its CSV did not, for seventeen days.
 *
 * It does not mask a response whose shape is undeclared. `mask-by-shape.ts` says
 * so in an assertion rather than leaving it to be discovered, and
 * `response-shape-coverage.spec.ts` is what stops that set growing.
 *
 * ## While the migration runs
 *
 * With no field yet carrying `@ClientField`, this is a NO-OP by construction:
 * the walker finds nothing marked and returns the response it was given,
 * identity included. That is the property that makes it safe to wire before the
 * first surface is migrated — `applyMask` keeps doing the work, this does
 * nothing, and each field annotated afterwards is one reviewable step with its
 * own test. There is never a window where neither mechanism is running.
 */
@Injectable()
export class FieldMaskInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<{ admin?: { fieldMask?: FieldMask } }>();
    const mask = request?.admin?.fieldMask;

    // Not an admin request, or an administrator who hides nothing. Either way
    // there is no work to do, and the response is passed through untouched
    // rather than walked — this runs on every request.
    if (!mask || mask.length === 0) return next.handle();

    const shape = declaredResponseType(context.getHandler());
    if (shape === undefined) return next.handle();

    return next.handle().pipe(map((body: unknown) => maskByShape(shape, body, mask)));
  }
}

/** Nest stores `@ApiOkResponse({ type: X })` on the handler, keyed by status. */
const API_RESPONSE = 'swagger/apiResponse';

/**
 * The class a route says it returns, from the Swagger metadata it already
 * carries — so the shape is read from the declaration both frontends generate
 * their types from, rather than from a second one maintained for masking.
 *
 * Only 2xx responses: an error body is `AllExceptionsFilter`'s envelope and
 * carries no client projection.
 */
export function declaredResponseType(handler: object): unknown {
  const responses = Reflect.getMetadata(API_RESPONSE, handler) as
    Record<string, { type?: unknown }> | undefined;
  if (!responses) return undefined;

  for (const [status, response] of Object.entries(responses)) {
    if (!status.startsWith('2')) continue;
    let type = response?.type;
    // `type: () => X` — a thunk, where the reference would be circular.
    if (typeof type === 'function' && !(type as { prototype?: unknown }).prototype) {
      type = (type as () => unknown)();
    }
    if (Array.isArray(type)) type = type[0];
    if (typeof type === 'function') return type;
  }
  return undefined;
}
