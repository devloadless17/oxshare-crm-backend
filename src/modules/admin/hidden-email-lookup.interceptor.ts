import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { UsersStore, parsePortalId, phoneSearchTerm } from '../../store/users.store';
import { AdminAuditService } from './admin-audit.service';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/**
 * Records every time an admin whose role HIDES client emails finds a client by
 * a complete email address (D-82) — and, since 12 Oct 2026, by a complete phone
 * number or a whole name their role hides (`client.lookup_hidden_phone`,
 * `client.lookup_hidden_name`), under the same rules.
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
    if (!admin || !q) return next.handle();
    const mask = admin.fieldMask;
    const route = `${req.method} ${req.route?.path ?? ''}`;
    const phone = phoneSearchTerm(q);

    let record: (() => Promise<void>) | undefined;
    if (q.includes('@')) {
      if (mask.includes('client.email')) record = () => this.recordEmail(admin, q, route);
    } else if (phone !== undefined) {
      if (mask.includes('client.phone')) record = () => this.recordPhone(admin, `+${phone}`, route);
    } else if (
      parsePortalId(q) === undefined &&
      (mask.includes('client.firstName') || mask.includes('client.lastName'))
    ) {
      record = () => this.recordName(admin, q, route);
    }
    if (!record) return next.handle();
    const write = record;
    return next.handle().pipe(tap(() => void write()));
  }

  private async recordEmail(admin: AuthenticatedAdmin, email: string, route: string) {
    const client = await this.users.findByEmail(email);
    if (!client || !(await this.users.findForAdmin(client.id, admin.clientScope))) return;
    this.audit.record(admin.id, 'client.lookup_hidden_email', 'user', client.id, { route });
  }

  /** A hidden phone is found by the complete international number alone. */
  private async recordPhone(admin: AuthenticatedAdmin, e164: string, route: string) {
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) return;
    const id = await this.users.findIdByPhone(e164);
    if (id === undefined || !(await this.users.findForAdmin(id, admin.clientScope))) return;
    this.audit.record(admin.id, 'client.lookup_hidden_phone', 'user', id, { route });
  }

  /** A hidden name is found by the whole name; a name may label several clients. */
  private async recordName(admin: AuthenticatedAdmin, name: string, route: string) {
    for (const id of await this.users.findIdsByWholeName(name, admin.clientScope)) {
      this.audit.record(admin.id, 'client.lookup_hidden_name', 'user', id, { route });
    }
  }
}
