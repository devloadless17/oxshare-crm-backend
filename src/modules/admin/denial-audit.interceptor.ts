import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import type { Request } from 'express';
import { AuthorizationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';

/**
 * Records the permission refusals the GUARD never sees.
 *
 * ## The half that was missing
 *
 * `PermissionsGuard` writes a `security.denied` audit row when it refuses, with
 * the route and the keys, "exactly the pattern an investigation wants to see".
 * It is the only writer of that action in the codebase.
 *
 * But the guard is not the only place authorization is decided. Around eighty
 * `assertActorCan` / `assertActorCanAny` call sites refuse INSIDE services, and
 * every one of them threw a 403 that left no trace at all. The gap lands
 * precisely where guard and service deliberately differ — the two money routes
 * whose guard key is a documented "floor" while the real gate is deeper
 * (`admin-money.service.ts` on `trading.deposit` / `trading.withdraw`), and
 * `admins.scope`, which appears on no route at all. Those are the attempted
 * escalations most worth seeing, and they were the ones recorded least.
 *
 * ## Why an interceptor, and why here
 *
 * `assertActorCan` is a pure function in `common/security/actor.ts` — no Nest,
 * no DI, no audit service — and it must stay that way: `common/` may not import
 * from `modules/**`, and the lint rule enforcing that is what keeps the import
 * graph acyclic.
 *
 * `AllExceptionsFilter` already maps `AuthorizationError` to 403 in ONE place,
 * which would be the natural home — except it lives in `common/` too, and the
 * same rule applies.
 *
 * So the recording happens in the one layer that can see the error, knows the
 * actor, and is allowed to reach the audit service. It catches and RETHROWS:
 * the filter still owns the response, and this changes no status code, body or
 * header.
 *
 * ## No double counting
 *
 * The guard throws `ForbiddenException` — an HTTP type — and services throw
 * `AuthorizationError`, a `DomainError`. Matching only the second is what keeps
 * one refusal from producing two rows, and it is a real distinction rather than
 * a convention: `*.service.ts` is lint-forbidden from importing the HTTP family
 * at all.
 */
@Injectable()
export class DenialAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AdminAuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof AuthorizationError) {
          const req = context.switchToHttp().getRequest<Request & { admin?: { id: string } }>();
          const actorId = req.admin?.id;

          /*
           * Only for an ADMIN. A portal client can also be refused — and an
           * `audit_log.actor_id` naming a client would put them in a trail that
           * reads as administrator activity, which is worse than the silence it
           * replaces. Client-side refusals belong to a different record.
           */
          if (actorId) {
            this.audit.record(actorId, 'security.denied', 'route', `${req.method} ${req.path}`, {
              // Distinguishable from the guard's rows at a glance, because the
              // two answer different questions: the guard refused at the door,
              // this refused after the handler had begun deciding.
              reason: 'service',
              message: error.message,
            });
          }
        }
        return throwError(() => error);
      }),
    );
  }
}
