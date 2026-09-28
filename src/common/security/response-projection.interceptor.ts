import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { declaredResponseType } from './field-mask.interceptor';
import { projectByShape } from './response-projection';

export type ProjectionMode = 'enforce' | 'strip' | 'report';

/**
 * EVERY response — admin AND portal — leaves the process holding only the keys
 * its declared DTO names. See `response-projection.ts` for why, and for the
 * leak that made it a rule rather than a review comment.
 *
 * One place, set once, covering routes written next year: the same shape as
 * the RBAC-03 `FieldMaskInterceptor`, and for the same reason — a guarantee
 * each handler must remember is a guarantee some handler will forget.
 *
 * ## Three modes (`RESPONSE_PROJECTION`)
 *
 * - `enforce` — the default under NODE_ENV=test. An undeclared key is a 500
 *   naming the route and the key, so every HTTP spec in the suite is also a
 *   completeness check, and a new DTO gap is a red build rather than a leak.
 * - `strip` — the default everywhere else. The key is removed and logged once
 *   per route and key. Production must never 500 a working screen because a
 *   field was added and not declared; it must never send it either.
 * - `report` — logs and changes nothing. The census mode, run once over the
 *   whole suite to list every gap before enforcement was switched on.
 *
 * A route with no declared 2xx type is left alone — there is nothing to hold
 * it to. `response-shape-coverage.spec.ts` is what keeps that set from
 * growing. Stream and file bodies pass through untouched.
 */
@Injectable()
export class ResponseProjectionInterceptor implements NestInterceptor {
  private readonly logger = new Logger('ResponseProjection');
  private readonly mode: ProjectionMode;
  /** `route path` pairs already logged, so a hot route logs a gap once. */
  private readonly reported = new Set<string>();

  constructor(config: ConfigService) {
    this.mode =
      config.get<ProjectionMode>('RESPONSE_PROJECTION') ??
      (config.get<string>('NODE_ENV') === 'test' ? 'enforce' : 'strip');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const shape = declaredResponseType(context.getHandler());
    if (shape === undefined) return next.handle();

    const request = context
      .switchToHttp()
      .getRequest<{ method: string; route?: { path?: string }; originalUrl?: string }>();
    // The route PATTERN, never the URL: a URL carries ids, and ids are not what
    // a gap report is about.
    const route = `${request.method} ${request.route?.path ?? '(unmatched route)'}`;
    const shapeName = (shape as { name?: string }).name ?? 'declared type';

    return next.handle().pipe(
      map((body: unknown) => {
        if (
          body === null ||
          typeof body !== 'object' ||
          body instanceof StreamableFile ||
          Buffer.isBuffer(body)
        ) {
          return body;
        }

        const { value, undeclared } = projectByShape(shape, body);
        if (undeclared.length === 0) return body;
        const paths = [...new Set(undeclared)];

        if (this.mode === 'enforce') {
          throw new Error(
            `RESPONSE_PROJECTION: ${route} returned key(s) its declared shape (${shapeName}) ` +
              `does not name: ${paths.join(', ')}. Declare them on the DTO (with a ` +
              '@ClientField/@NotClientField stance) or stop returning them.',
          );
        }

        for (const path of paths) {
          const key = `${route} ${path}`;
          if (this.reported.has(key)) continue;
          this.reported.add(key);
          const line = `[response-projection] ${route} (${shapeName}) undeclared: ${path}`;
          // The census reads stderr, where a test run's logger may be quiet.
          if (this.mode === 'report') process.stderr.write(`${line}\n`);
          else this.logger.warn(line);
        }
        return this.mode === 'strip' ? value : body;
      }),
    );
  }
}
