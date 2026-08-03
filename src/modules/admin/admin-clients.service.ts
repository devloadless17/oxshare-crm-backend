import { Injectable } from '@nestjs/common';
import { Admin } from '../../store/admins.store';
import { UsersStore } from '../../store/users.store';
import { NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';

/**
 * ADM-01 client directory and ADM-02 suspension.
 *
 * Filtering, sorting and pagination happen in SQL (see UsersStore.findPage) —
 * this list is expected to reach the ~219K rows §5 warns about, and the
 * previous in-process filter loaded every row including password hashes.
 */
@Injectable()
export class AdminClientsService {
  constructor(
    private readonly users: UsersStore,
    private readonly audit: AdminAuditService,
  ) {}

  // ─── Clients list (ADM-01 / ADM-14) ───────────────────────────────────────
  async listClients(query: {
    page?: string;
    limit?: string;
    q?: string;
    type?: string;
    status?: string;
    level?: string;
  }) {
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '25', 10) || 25));

    // An unparseable ?level= used to become NaN and silently return nothing.
    let level: number | undefined;
    if (query.level !== undefined && query.level !== '') {
      const parsed = Number(query.level);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1) {
        throw new ValidationError('level must be 0 or 1.');
      }
      level = parsed;
    }

    const { items, total } = await this.users.findPage({
      page,
      limit,
      q: query.q?.trim() || undefined,
      type: query.type,
      status: query.status,
      level,
    });
    return { items, total, page, limit };
  }
  // ─── Client suspension (users.suspend) ────────────────────────────────────
  async setClientStatus(userId: string, status: 'active' | 'suspended', actor: Admin) {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('Client not found.');
    if (user.status === status) {
      throw new ValidationError(`Client is already ${status}.`);
    }

    const updated = (await this.users.update(userId, { status }))!;
    // Suspension bites immediately: the JWT strategy re-checks status on every
    // request, and login/refresh refuse suspended accounts.
    this.audit.record(
      actor.id,
      status === 'suspended' ? 'client.suspend' : 'client.activate',
      'user',
      userId,
      {
        email: user.email,
        before: user.status,
        after: status,
      },
    );

    return {
      id: updated.id,
      email: updated.email,
      firstName: updated.firstName,
      lastName: updated.lastName,
      type: updated.type,
      status: updated.status,
      verificationLevel: updated.verificationLevel,
      country: updated.country,
      createdAt: updated.createdAt,
    };
  }
}
