import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ANNOUNCES_CHANGE } from './announces-change.decorator';
import { ResourceChangedPublisher, type ResourceName } from './resource-changed';

/**
 * Announces a change AFTER the handler has succeeded.
 *
 * `tap` on the success path only, so a refused approval — a 403 from
 * `PermissionsGuard`, a 409 from an already-decided submission — announces
 * nothing. That is the whole reason this sits in an interceptor rather than
 * inside the services: an interceptor cannot fire on a path that threw, while
 * a service call placed one line too early can.
 *
 * It runs after the transaction has committed, so it does not need to join
 * one. `ResourceChangedPublisher.publish` never throws, so nothing here can
 * turn a completed decision into an error response.
 */
@Injectable()
export class ResourceChangedInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly publisher: ResourceChangedPublisher,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const resource = this.reflector.get<ResourceName | undefined>(
      ANNOUNCES_CHANGE,
      context.getHandler(),
    );
    if (!resource) return next.handle();

    const request = context.switchToHttp().getRequest<Request & { admin?: { id: string } }>();
    const actorAdminId = request.admin?.id;

    return next.handle().pipe(
      tap(() => {
        // Fire-and-forget: the response is already on its way, and the
        // publisher swallows its own failures.
        void this.publisher.publish(actorAdminId ? { resource, actorAdminId } : { resource });
      }),
    );
  }
}
