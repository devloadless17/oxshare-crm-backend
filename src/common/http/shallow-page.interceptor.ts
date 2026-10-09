import {
  BadRequestException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, TOTAL_CAP } from '../pagination';

/**
 * Page NUMBERS reach only the first TOTAL_CAP rows (9 Oct 2026).
 *
 * The console numbers pages while within the first 10,000 rows — an offset that
 * shallow is a few milliseconds at any table size — and walks by cursor beyond
 * them. A hand-edited `?page=400000` would make Postgres read and discard every
 * row before it, so it is refused here, once, for every list. Exports page by
 * offset INSIDE the server and never pass through a request's `?page=`.
 */
@Injectable()
export class ShallowPageInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const query = context.switchToHttp().getRequest<Request>()?.query;
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    const page = Number.parseInt(text(query?.['page']), 10);
    if (page > 1) {
      const raw = Number.parseInt(text(query?.['limit']), 10);
      const limit = raw > 0 ? Math.min(raw, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
      if ((page - 1) * limit >= TOTAL_CAP) {
        throw new BadRequestException(
          'Page numbers reach the first 10,000 rows. Use Next or Last (the cursor) beyond them.',
        );
      }
    }
    return next.handle();
  }
}
