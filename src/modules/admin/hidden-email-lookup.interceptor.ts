import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { UsersStore } from '../../store/users.store';
import { AdminAuditService } from './admin-audit.service';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/**
 * Records every time an admin whose role HIDES client emails finds a client by
 * a complete email address (D-82).
 *
 * `clientIdentitySearch` lets that one lookup through on purpose — support must
 * be able to find the client whose address they already hold — and never a
 * fragment. What the reader learns is which client it is, so who asked and whom
 * they found is recorded: `client.lookup_hidden_email`, subject the client. The
 * typed text is NOT recorded — it may be somebody else's address, and a trail
 * of addresses nobody matched would be a list of PII nobody needed. A lookup
 * that matched nobody the reader may see records nothing, because it revealed
 * nothing.
 *
 * One interceptor rather than a line in each of the twelve searches, so a list
 * written next year is covered without remembering it. Every admin search takes
 * the term as `q`.
 */
@Injectable()
export class HiddenEmailLookupInterceptor implements NestInterceptor {
  constructor(
    private readonly users: UsersStore,
    private readonly audit: AdminAuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<{
      admin?: AuthenticatedAdmin;
      query?: Record<string, unknown>;
      method: string;
      route?: { path?: string };
    }>();
    const admin = req.admin;
    const q = typeof req.query?.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    if (!admin || !q.includes('@') || !admin.fieldMask.includes('client.email')) {
      return next.handle();
    }
    const route = `${req.method} ${req.route?.path ?? ''}`;
    return next.handle().pipe(tap(() => void this.recordLookup(admin, q, route)));
  }

  private async recordLookup(admin: AuthenticatedAdmin, email: string, route: string) {
    const client = await this.users.findByEmail(email);
    if (!client || !(await this.users.findForAdmin(client.id, admin.clientScope))) return;
    this.audit.record(admin.id, 'client.lookup_hidden_email', 'user', client.id, { route });
  }
}
