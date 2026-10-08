import { randomBytes } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ClientCreation, welcomeLink } from '../identity/client-creation';
import { EmailService } from '../email/email.service';
import { AdminAuditService } from './admin-audit.service';
import { UsersStore, type User } from '../../store/users.store';
import { SignupLinksStore } from '../../store/signup-links.store';
import { PasswordService } from '../../common/security/password.service';
import { assertActorCan } from '../../common/security/actor';
import {
  AuthorizationError,
  ClientNotFoundError,
  ConflictError,
} from '../../common/errors/domain-errors';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import type { AuthenticatedAdmin } from './guards/admin.guard';
import type { CreateClientDto } from './dto/requests/clients.dto';

/**
 * "NEW CLIENT" — staff create a client for somebody who cannot sign up
 * themselves (0211, 8 Oct 2026). Then "Complete KYC" (0210) does their
 * verification, and a welcome email lets them choose their own password.
 *
 * Created by the SAME checks a sign-up passes and given the same things
 * (`ClientCreation`), so the client is identical to one who signed up. What
 * differs is only how they arrive, and the record says it:
 *
 *  - no password anybody knows: an unusable random one until the client
 *    chooses theirs through the welcome link (`password_set_at` stays NULL);
 *  - `created_by_admin_id`, written once (trigger), and a `client.created`
 *    audit row in the same transaction;
 *  - the creating administrator's tags, read LIVE as their sign-up link would
 *    give them (their territory, never a country: the client carries their own),
 *    so the creator's book holds the client they made. A client the creator
 *    could still not see — a country desk creating someone from elsewhere — is
 *    refused and nothing is kept: creating a person you cannot open again
 *    would leave a record nobody on this desk can finish.
 */
@Injectable()
export class AdminClientCreateService {
  constructor(
    private readonly creation: ClientCreation,
    private readonly users: UsersStore,
    private readonly signupLinks: SignupLinksStore,
    private readonly passwords: PasswordService,
    private readonly email: EmailService,
    private readonly audit: AdminAuditService,
    @Inject(DRIZZLE_DB) private readonly db: Db,
  ) {}

  async create(dto: CreateClientDto, actor: AuthenticatedAdmin): Promise<{ id: number }> {
    assertActorCan(actor, 'clients.create', 'create a client');
    const { email, locale, ...details } = dto;
    const seeded = await this.creation.check({ email, ...details });
    const tagIds = (await this.signupLinks.tagsFor(actor.id)).map((tag) => tag.id);
    // Nobody — staff included — ever knows it. The welcome link replaces it.
    const unusable = await this.passwords.hash(randomBytes(32).toString('base64url'));

    const user = await this.db.transaction(async (tx) => {
      const created = await this.creation.insert(
        {
          email,
          passwordHash: unusable,
          ...seeded,
          firstName: seeded.firstName!,
          lastName: seeded.lastName!,
          type: 'individual',
          status: 'active',
          verificationLevel: 0,
          emailVerified: false,
          locale: locale ?? 'en',
          createdByAdminId: actor.id,
        },
        tx,
      );
      await this.signupLinks.attach(created.id, tagIds, tx);
      // Asked of the uncommitted row, through the one scope predicate.
      if (!(await this.users.findForAdmin(created.id, actor.clientScope, tx))) {
        throw new ConflictError(
          'This client would be outside your territory, so you could not open them after ' +
            'creating them. Ask a colleague whose territory includes their country.',
        );
      }
      await this.audit.recordWithin(tx, actor.id, 'client.created', 'user', created.id, {
        tagIds,
        locale: locale ?? 'en',
      });
      return created;
    });

    await this.creation.settle(user.id);
    await this.sendWelcome(user);
    return { id: user.id };
  }

  /**
   * Send the welcome email again — while the client has not chosen a password
   * yet: it expired, went to spam, or the client lost it. A new link replaces
   * the old one (one reset token per client), so only the newest works.
   */
  async resendWelcome(userId: number, actor: AuthenticatedAdmin): Promise<{ message: string }> {
    assertActorCan(actor, 'clients.create', 'send a welcome email');
    const user = await this.users.findForAdmin(userId, actor.clientScope);
    if (!user) throw new ClientNotFoundError();
    if (!user.createdByAdminId || user.passwordSetAt) {
      throw new ConflictError(
        'This client has already chosen a password. They can reset it from the sign-in page.',
      );
    }
    if (user.status === 'suspended') {
      throw new AuthorizationError('This client is suspended. Reactivate them first.');
    }
    await this.sendWelcome(user);
    this.audit.record(actor.id, 'client.welcome_resend', 'user', userId);
    return { message: `Welcome email sent to ${user.email}.` };
  }

  /** The link's token goes in the email and nowhere else; the row keeps its hash. */
  private async sendWelcome(user: User): Promise<void> {
    const { token, patch } = welcomeLink();
    await this.users.update(user.id, patch);
    // Never fails the operation — `EmailService` logs and swallows by contract.
    await this.email.sendClientWelcomeEmail(
      user.email,
      token,
      user.firstName,
      user.id,
      user.locale ?? 'en',
    );
  }
}
