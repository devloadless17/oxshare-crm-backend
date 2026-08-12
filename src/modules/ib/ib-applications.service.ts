import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../common/provisioning/notification-dispatch.port';
import {
  DEFAULT_IB_ACCRUAL_SORT,
  DEFAULT_IB_APPLICATION_SORT,
  DEFAULT_IB_PARTNER_SORT,
  IB_ACCRUAL_SORT_COLUMNS,
  IB_APPLICATION_SORT_COLUMNS,
  IB_PARTNER_SORT_COLUMNS,
  IbStore,
  type IbAccountRow,
  type IbApplicationRow,
  type IbApplicationStatus,
} from '../../store/ib.store';
import { sortKey, sortOrder } from '../../common/sorting';
import { UsersStore } from '../../store/users.store';
import { IbLevelsService } from './ib-levels.service';
import { ClientVisibilityService } from '../../common/security/client-visibility.service';
import { EmailService } from '../email/email.service';
import { AdminAuditService } from '../admin/admin-audit.service';
import { ProductsStore } from '../../store/products.store';
import type { Actor } from '../../common/security/actor';
import type { ClientScope } from '../../common/security/client-scope';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';

/**
 * The verification level a client must hold before they may apply.
 *
 * 1 is "KYC approved" — the same threshold that gated withdrawals. A partner
 * introduces other people to the platform and is paid for it, so the platform
 * has to know who they are first; taking an application from an unverified
 * account means a reviewer weighing a name nobody has checked.
 */
const REQUIRED_VERIFICATION_LEVEL = 1;

/**
 * Referral codes are drawn from an unambiguous alphabet.
 *
 * No 0/O, no 1/I/L. These get read off a screen, dictated over a phone and
 * typed into a registration form by somebody who is not the partner — a code
 * that is one glyph away from another person's is an attribution that silently
 * pays the wrong partner, and attribution is permanent per client.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/**
 * Partner applications and the accounts they grant.
 *
 * ## Where the rules live
 *
 * All of them here, none in the controller (R-4.3). "Is this client verified
 * enough to apply", "does this parent have room for another partner", "would
 * this reassignment make a loop" are decisions about the domain, and a
 * controller that owned any of them would be a second place to look when the
 * answer surprises somebody.
 */
@Injectable()
export class IbApplicationsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly ib: IbStore,
    private readonly users: UsersStore,
    private readonly levels: IbLevelsService,
    private readonly visibility: ClientVisibilityService,
    private readonly email: EmailService,
    private readonly audit: AdminAuditService,
    /*
     * Bell rows — decisions to the applicant, new applications to reviewers.
     * APPENDED LAST: this class is constructed positionally in
     * `ib-applications.spec.ts`.
     */
    @Inject(NOTIFICATION_DISPATCH) private readonly notifications: NotificationDispatchPort,
    /*
     * The agency catalogue, reached through the `@Global()` STORE rather than
     * through `CatalogueService`. Two reasons, and the second is the load-
     * bearing one: this module would otherwise have to import ProductsModule,
     * which imports TradingModule — a lot of graph for two reads — and the
     * store needs no module wiring at all.
     *
     * APPENDED LAST, like the dispatcher above and for the same reason: this
     * class is constructed positionally in `ib-applications.spec.ts`.
     */
    private readonly catalogue: ProductsStore,
  ) {}

  // ── the client's side ──────────────────────────────────────────────────────

  /**
   * Everything the portal needs to decide which screen to render.
   *
   * Deliberately returns BOTH the account and the latest application. "Not a
   * partner" and "rejected two weeks ago with a reason" are different states,
   * and a client shown the blank application form after a refusal has been told
   * nothing about why. The portal's job is to render the difference; this
   * method's job is to make it available.
   */
  async statusFor(userId: string): Promise<{
    account: (IbAccountRow & { agencyName: string | null; products: string[] }) | null;
    application: (IbApplicationRow & { agencyName: string | null }) | null;
    eligible: boolean;
    /** Why not, in a sentence the portal can show verbatim. Null when eligible. */
    ineligibleReason: string | null;
  }> {
    const [account, application, user] = await Promise.all([
      this.ib.findAccount(userId),
      this.ib.findLatestByUser(userId),
      this.users.findById(userId),
    ]);

    const verified = (user?.verificationLevel ?? 0) >= REQUIRED_VERIFICATION_LEVEL;

    /*
     * The agency NAMES, resolved once for both halves.
     *
     * Read only when something references an agency, so the common case — a
     * client who has never applied — costs no extra query. The catalogue is a
     * handful of rows, so listing it whole beats two id lookups.
     */
    const needsCatalogue = Boolean(account?.agencyId ?? application?.agencyId);
    const [agencies, products] = needsCatalogue
      ? await Promise.all([this.catalogue.listAgencies(), this.catalogue.listProducts()])
      : [[], []];

    const agencyOf = (id: string | null) => agencies.find((agency) => agency.id === id) ?? null;
    const productName = new Map(products.map((product) => [product.id, product.name]));

    const accountAgency = agencyOf(account?.agencyId ?? null);

    return {
      account: account
        ? {
            ...account,
            agencyName: accountAgency?.name ?? null,
            /*
             * Names, not ids — this goes to a partner, who has no use for a
             * uuid. Empty when they are on no agency, which means their clients
             * are offered the full catalogue rather than nothing.
             */
            products: (accountAgency?.productIds ?? [])
              .map((id) => productName.get(id))
              .filter((name): name is string => Boolean(name)),
          }
        : null,
      application: application
        ? { ...application, agencyName: agencyOf(application.agencyId)?.name ?? null }
        : null,
      eligible: verified,
      ineligibleReason: verified
        ? null
        : 'Your identity must be verified before you can apply to the partner programme.',
    };
  }

  /**
   * Apply.
   *
   * The three refusals are ordered by what the client can DO about them: they
   * are already a partner (nothing to do), they already have one open (wait),
   * they are not verified (go and verify). Each says which.
   */
  async apply(
    userId: string,
    input: {
      motivation?: string;
      expectedVolume?: string;
      website?: string;
      agencyId?: string;
    },
  ): Promise<IbApplicationRow> {
    const existingAccount = await this.ib.findAccount(userId);
    if (existingAccount) {
      throw new ConflictError('You are already a partner.');
    }

    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError('Account not found.');

    if (user.verificationLevel < REQUIRED_VERIFICATION_LEVEL) {
      throw new ValidationError(
        'Your identity must be verified before you can apply to the partner programme.',
      );
    }

    /*
     * The advisory half of "one pending application per client".
     *
     * `ib_applications_one_pending_uq` is what actually enforces it — this read
     * loses to a double-submit and is here only to produce a sentence better
     * than a constraint-violation error. If the two disagree the database wins,
     * and the catch below is what turns its refusal back into that same
     * sentence.
     */
    const pending = await this.ib.findPendingByUser(userId);
    if (pending) {
      throw new ConflictError('You already have an application awaiting review.');
    }

    /*
     * The agency must be one that is actually OPEN.
     *
     * Checked here rather than only at approval, because the alternative is
     * accepting an application against a closed programme and telling the
     * applicant weeks later that what they asked for was never available. The
     * portal offers only open agencies; this is the control behind that.
     */
    if (input.agencyId) {
      const agencies = await this.catalogue.listAgencies();
      if (!agencies.some((agency) => agency.id === input.agencyId && agency.enabled)) {
        throw new ValidationError(
          'That partner programme is not open for applications. Choose one from the list.',
        );
      }
    }

    try {
      const created = await this.ib.createApplication({
        userId,
        agencyId: input.agencyId ?? null,
        motivation: input.motivation ?? null,
        expectedVolume: input.expectedVolume ?? null,
        website: input.website ?? null,
      });

      // Ring the reviewers' bells — post-write, never-throws, scope-filtered
      // at write time. The queue badge stays the durable signal.
      void this.notifications.notifyAdminsWithPermission(
        'ib.approve',
        { kind: 'admin.partner.applied', params: { applicationId: created.id, userId } },
        { subjectClientId: userId },
      );

      return created;
    } catch (error) {
      if (violates(error, 'ib_applications_one_pending_uq')) {
        throw new ConflictError('You already have an application awaiting review.');
      }
      throw error;
    }
  }

  // ── the reviewer's side ────────────────────────────────────────────────────

  /**
   * The review queue.
   *
   * `scope` is the reviewing admin's client visibility, applied in the query
   * rather than filtered afterwards. An admin limited to a subset of clients
   * must not see a partner application from outside it, and the per-status
   * counts are scoped identically — a count that ignored visibility would
   * promise twelve pending applications and then show four.
   */
  list(
    filter: {
      status?: IbApplicationStatus;
      page?: number;
      limit?: number;
      sort?: string;
      order?: string;
    },
    scope: ClientScope,
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
    return this.ib.findPageWithUsers({
      status: filter.status,
      page,
      limit,
      scope,
      // R-2.5. An unrecognised key is a 400 naming the allowed ones, never a
      // silent fallback — a sort the server ignored is a lie the UI tells.
      sort: sortKey(
        filter.sort,
        IB_APPLICATION_SORT_COLUMNS,
        DEFAULT_IB_APPLICATION_SORT,
        'partner applications',
      ),
      order: sortOrder(filter.order),
    });
  }

  /**
   * Approve an application and create the partner account, atomically.
   *
   * ## One transaction, and a CONDITIONAL write
   *
   * `transition` puts `status = 'pending'` in the WHERE clause, so the check
   * and the write are a single statement. Two admins racing approve against
   * reject cannot both pass a check against the same row: the second finds
   * nothing to update and is refused. Without the transaction there is a state
   * where the application says approved and no account exists — a partner who
   * has been told they were accepted and has no referral code.
   *
   * The pre-reads above it are advisory, for precise messages only.
   *
   * ## The audit row joins the TRANSACTION — `recordWithin`, not `record`
   *
   * The only one of the five actions here that does. Approving does not merely
   * change a status: it CREATES THE PAYABLE RELATIONSHIP — an `ib_accounts` row
   * with a level, a parent and a referral code, which is what every future
   * commission is calculated from and attributed through. R-6.5's rule is that
   * where the money relationship is established the record of who established it
   * commits with it, so a partner who exists and is being paid with no record of
   * who let them in is not a state this system can reach.
   *
   * The other four (`reject`, `level_change`, `parent_change`, `suspend`) use
   * fire-and-forget `record`: they change an existing row rather than creating
   * the relationship, and an audit-write failure should not undo a correct
   * rejection.
   */
  async approve(
    applicationId: string,
    actor: Actor,
    scope: ClientScope,
    options: { level?: number; parentIbUserId?: string | null; agencyId?: string | null } = {},
  ): Promise<IbAccountRow> {
    const reviewerId = actor.id;
    const application = await this.ib.findById(applicationId);
    if (!application) throw new NotFoundError('Application not found.');
    /*
     * The by-id half of client scope. The list query filters with a predicate;
     * a route that names an application in its PATH has nowhere for that
     * predicate to live, so the question is asked first. It 404s rather than
     * 403s — a 403 would confirm the id names a real application, which is an
     * enumeration oracle for the exact clients this admin was denied.
     */
    await this.visibility.assertVisible(application.userId, scope);
    if (application.status !== 'pending') {
      throw new ConflictError(
        `Only a pending application can be approved; this one is ${application.status}.`,
      );
    }

    const level = await this.resolveLevel(options.level, options.parentIbUserId ?? null);
    const parentIbUserId = options.parentIbUserId ?? null;

    if (parentIbUserId) {
      await this.assertParentHasRoom(parentIbUserId);
    }

    /*
     * WHAT THE APPLICANT ASKED FOR, unless the reviewer says otherwise.
     *
     * The reviewer may override — an applicant who asked for Gold and is being
     * appointed to Silver is an ordinary decision — but the default is the
     * applicant's own choice, because approving a request and silently
     * substituting a different programme is the version of this that produces
     * an angry partner.
     *
     * `undefined` means "not specified by the reviewer" and falls back;
     * explicit `null` means "appoint them under no agency", which is the only
     * way to reach the pre-agency behaviour deliberately.
     */
    const agencyId =
      options.agencyId === undefined ? (application.agencyId ?? null) : options.agencyId;

    if (agencyId) {
      const agencies = await this.catalogue.listAgencies();
      if (!agencies.some((agency) => agency.id === agencyId)) {
        throw new ValidationError('That agency does not exist. Reload and try again.');
      }
      /*
       * A DISABLED agency is accepted here, unlike on apply. Closing a
       * programme stops new applications; it does not invalidate the ones
       * already in the queue, and refusing to approve them would strand every
       * applicant who got in before the door shut.
       */
    }

    const referralCode = await this.generateReferralCode();

    const account = await this.db.transaction(async (tx) => {
      const updated = await this.ib.transition(
        applicationId,
        ['pending'],
        {
          status: 'approved',
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
        },
        tx,
      );
      if (!updated) {
        throw new ConflictError(
          'This application was changed by another reviewer. Reload and try again.',
        );
      }

      const created = await this.ib.createAccount(
        {
          userId: application.userId,
          level,
          parentIbUserId,
          referralCode,
          applicationId,
          agencyId,
        },
        tx,
      );

      /*
       * Inside the transaction, and awaited. The subject is the CLIENT who
       * became a partner rather than the application id, because that is what
       * somebody investigating a disputed payout has in their hand.
       *
       * The referral code is deliberately absent: it is an identifier the
       * partner hands out, it is on the account row already, and the log is
       * read by more people than the account is.
       */
      await this.audit.recordWithin(tx, actor.id, 'ib.approve', 'ib_account', application.userId, {
        applicationId,
        level,
        parentIbUserId,
        /*
         * Both what was asked for and what was granted. They are usually the
         * same and the interesting case is when they are not — "I applied for
         * Gold" is a dispute this row settles, and recording only the outcome
         * would leave the request unrecoverable once the application is read
         * back through a screen that shows the partner's current agency.
         */
        agencyId,
        agencyRequested: application.agencyId ?? null,
      });

      /*
       * The applicant's bell row, committed WITH the account. No referral code
       * in params — the portal shows it the moment they look, and this row
       * outlives the moment (the same reasoning that keeps it off the audit
       * entry above).
       */
      await this.notifications.notify(
        {
          recipient: { kind: 'client', id: application.userId },
          kind: 'partner.approved',
          params: {},
        },
        tx,
      );

      return created;
    });

    /*
     * AFTER the transaction, and fire-and-forget.
     *
     * Inside it, a slow SMTP server would hold a write lock on the application
     * row for as long as the handshake took, and a mail failure would roll back
     * an approval that was correct. Awaited, a client waits on delivery to see
     * their referral code.
     *
     * The trade is that a bounced email leaves an approved partner who was not
     * told. That is recoverable — the portal shows the same code the moment
     * they look — where an approval lost to a mail outage is not.
     * EmailService logs the failure with recipient and reason, never the code.
     */
    void this.notifyDecision(application.userId, 'approved', { referralCode });

    return account;
  }

  /**
   * The decision email, looked up and sent without ever failing the decision.
   *
   * Private and shared by both paths so approve and reject cannot drift into
   * sending different things — and so the `void` is in exactly one place, which
   * is where somebody reading this should have to think about it.
   */
  private async notifyDecision(
    userId: string,
    decision: 'approved' | 'rejected',
    options: { referralCode?: string; reason?: string },
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) return;
    await this.email.sendPartnerDecisionEmail(user.email, user.firstName, decision, options);
  }

  /**
   * Reject, with a reason the client will actually be shown.
   *
   * The reason is REQUIRED and composed here rather than assembled by the
   * frontend, matching how a KYC refusal is built: a configured label,
   * optionally suffixed with the reviewer's note. Refusing an empty reason is
   * the point — "rejected" with no explanation is the outcome this whole field
   * exists to prevent.
   */
  async reject(
    applicationId: string,
    actor: Actor,
    scope: ClientScope,
    input: { reason?: string; note?: string },
  ): Promise<IbApplicationRow> {
    const reviewerId = actor.id;
    const reason = composeReason(input.reason, input.note);

    const application = await this.ib.findById(applicationId);
    if (!application) throw new NotFoundError('Application not found.');
    await this.visibility.assertVisible(application.userId, scope);
    if (application.status !== 'pending') {
      throw new ConflictError(
        `Only a pending application can be rejected; this one is ${application.status}.`,
      );
    }

    const updated = await this.ib.transition(applicationId, ['pending'], {
      status: 'rejected',
      rejectionReason: reason,
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
    });
    if (!updated) {
      throw new ConflictError(
        'This application was changed by another reviewer. Reload and try again.',
      );
    }

    /*
     * The composed REASON is recorded, because that is the sentence the client
     * was shown, and a complaint about a refusal is a complaint about that
     * text. The application row holds it too — but a resubmission overwrites
     * the queue's view of this person, and the log does not.
     */
    this.audit.record(actor.id, 'ib.reject', 'ib_application', applicationId, {
      userId: application.userId,
      reason,
    });

    // The composed sentence, not the parts — the client reads the same text the
    // portal shows them, so the two can never disagree.
    void this.notifyDecision(application.userId, 'rejected', { reason });
    // Post-write like the email: the conditional transition already absorbed
    // any race, so a second reject cannot reach this line twice.
    void this.notifications.notify({
      recipient: { kind: 'client', id: application.userId },
      kind: 'partner.rejected',
      params: { reason },
    });

    return updated;
  }

  // ── managing partners after approval ───────────────────────────────────────

  /** The partner list, scoped to what this admin may see, WITH earnings. */
  async listPartners(
    filter: { page?: number; limit?: number; sort?: string; order?: string },
    scope: ClientScope,
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
    const result = await this.ib.findPartnersPage({
      page,
      limit,
      scope,
      sort: sortKey(filter.sort, IB_PARTNER_SORT_COLUMNS, DEFAULT_IB_PARTNER_SORT, 'partners'),
      order: sortOrder(filter.order),
    });

    /*
     * EARNINGS, attached per row.
     *
     * The list said who the partners were and nothing about what they had made
     * — the first question anybody opening this screen has. One grouped query
     * for the whole page rather than one per row.
     *
     * A partner with no accruals is absent from the map and reports '0': the
     * honest reading of "nothing earned yet", rather than a row invented to fill
     * a column.
     */
    const earnings = await this.ib.earningsByPartner(result.rows.map((r) => r.account.userId));

    return {
      ...result,
      rows: result.rows.map((row) => ({
        ...row,
        earnings: earnings.get(row.account.userId) ?? { confirmed: '0', pending: '0' },
      })),
    };
  }

  /**
   * The COMMISSION LEDGER — every accrual, filterable and paged.
   *
   * The read that did not exist. The engine wrote `ib_accruals` on every settled
   * deposit and nothing ever read them back, so "what do we owe our partners"
   * was answerable only from the database.
   */
  listAccruals(
    filter: {
      page?: number;
      limit?: number;
      sort?: string;
      order?: string;
      ibUserId?: string;
      clientUserId?: string;
      status?: string;
    },
    scope: ClientScope,
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 25));
    return this.ib.findAccrualsPage({
      page,
      limit,
      scope,
      ibUserId: filter.ibUserId,
      clientUserId: filter.clientUserId,
      status: filter.status,
      sort: sortKey(filter.sort, IB_ACCRUAL_SORT_COLUMNS, DEFAULT_IB_ACCRUAL_SORT, 'accruals'),
      order: sortOrder(filter.order),
    });
  }

  /**
   * Move a partner to a different rung.
   *
   * The level must be ENABLED: a disabled level takes no share, so placing
   * somebody on one is a silent stop to their earnings rather than a demotion
   * they could see.
   */
  async changeLevel(
    userId: string,
    level: number,
    scope: ClientScope,
    actor: Actor,
  ): Promise<IbAccountRow> {
    await this.visibility.assertVisible(userId, scope);

    const account = await this.ib.findAccount(userId);
    if (!account) throw new NotFoundError('That partner does not exist.');

    const enabled = await this.levels.listEnabled();
    if (!enabled.some((l) => l.level === level)) {
      throw new ValidationError(
        `Level ${level} is not an enabled partner level. Enabled levels: ${enabled
          .map((l) => l.level)
          .join(', ')}.`,
      );
    }

    const updated = await this.ib.updateAccount(userId, { level });
    if (!updated) throw new NotFoundError('That partner does not exist.');

    // The OLD level, because the level is what decides the rate — "who moved
    // this partner to level 2, and what were they on before" is the question
    // asked when a payout looks wrong, and the current row answers half of it.
    this.audit.record(actor.id, 'ib.level_change', 'ib_account', userId, {
      before: account.level,
      after: updated.level,
    });
    return updated;
  }

  /**
   * Reassign a partner's parent, or cut them loose to deal direct.
   *
   * ## The cycle check is the whole point of this method
   *
   * A self-referencing foreign key checks only that the target row exists, so
   * Postgres accepts A→B→A — `test/ib-schema-constraints.spec.ts` asserts that
   * gap deliberately. The payout walk climbs parents until it runs out, and a
   * loop is a walk that never does. This is the only thing standing between an
   * operator's drop-down and a hung commission calculation.
   *
   * `maxDirectPartners` is checked too, because a reassignment fills a slot on
   * the new parent exactly as an approval would.
   */
  async reassignParent(
    userId: string,
    parentIbUserId: string | null,
    scope: ClientScope,
    actor: Actor,
  ): Promise<IbAccountRow> {
    await this.visibility.assertVisible(userId, scope);

    const account = await this.ib.findAccount(userId);
    if (!account) throw new NotFoundError('That partner does not exist.');

    if (parentIbUserId) {
      if (await this.wouldCreateCycle(userId, parentIbUserId)) {
        throw new ValidationError(
          'That partner already sits beneath this one, so the change would create a loop in the ' +
            'payout chain.',
        );
      }
      await this.assertParentHasRoom(parentIbUserId);
    }

    const updated = await this.ib.updateAccount(userId, { parentIbUserId });
    if (!updated) throw new NotFoundError('That partner does not exist.');

    /*
     * A reassignment moves who is paid ABOVE this partner from that point on,
     * and the old parent is not recoverable from the row afterwards — this is
     * the only place it survives.
     */
    this.audit.record(actor.id, 'ib.parent_change', 'ib_account', userId, {
      before: account.parentIbUserId,
      after: updated.parentIbUserId,
    });
    return updated;
  }

  /**
   * Suspend or reactivate.
   *
   * A suspended partner keeps their referral code and their tree — clients
   * attributed to them stay attributed — and stops earning. Deleting the row
   * instead would orphan everybody beneath them, which is why there is no
   * "remove partner" here at all.
   */
  async setActive(
    userId: string,
    active: boolean,
    scope: ClientScope,
    actor: Actor,
  ): Promise<IbAccountRow> {
    await this.visibility.assertVisible(userId, scope);

    // Read the state BEFORE the write, so a no-op (a retried request, a stale
    // screen re-sending the current state) is recognisable below. The write
    // itself stays unconditional — setting a state to itself is harmless; the
    // ANNOUNCEMENT of it is not.
    const previous = await this.ib.findAccount(userId);
    const updated = await this.ib.updateAccount(userId, { active });
    if (!updated) throw new NotFoundError('That partner does not exist.');

    /*
     * One action for both directions, matching the `@Audited('ib.partners.suspend')` on
     * the route — the DTO carries which. `active: false` stops the partner
     * earning while they keep their tree, so a suspension nobody can attribute
     * is a partner who stopped being paid for reasons no longer on record.
     */
    this.audit.record(actor.id, 'ib.partners.suspend', 'ib_account', userId, {
      active: updated.active,
    });
    /*
     * The bell row is honest about what is known: state changed, no reason is
     * recorded for suspension, so none is invented. No EMAIL, deliberately — a
     * reason-less suspension email is exactly the "decision the reader cannot
     * act on" templates/index.ts rule 3 forbids; in-app says contact support.
     *
     * Rung only when the state ACTUALLY changed: two admins both clicking
     * Suspend, or a retried request, must not tell the client twice — and a
     * stale screen re-sending `active: true` must not announce a restoration
     * that never had a suspension behind it.
     */
    if (previous && previous.active !== updated.active) {
      void this.notifications.notify({
        recipient: { kind: 'client', id: userId },
        kind: updated.active ? 'partner.restored' : 'partner.suspended',
        params: {},
      });
    }
    return updated;
  }

  // ── placement rules ────────────────────────────────────────────────────────

  /**
   * Which rung a new partner lands on.
   *
   * With no parent they are dealing with the broker directly, so they go to the
   * shallowest enabled level. With a parent they go one below the parent's —
   * that IS what the hierarchy means — and the ladder's depth is the limit: a
   * partner placed below the deepest enabled level would never be paid,
   * because no level exists to pay them.
   */
  private async resolveLevel(explicit: number | undefined, parentIbUserId: string | null) {
    const enabled = await this.levels.listEnabled();
    if (enabled.length === 0) {
      throw new ValidationError(
        'No partner levels are enabled, so no partner can be approved. Enable a level first.',
      );
    }

    if (explicit !== undefined) {
      const chosen = enabled.find((l) => l.level === explicit);
      if (!chosen) {
        throw new ValidationError(
          `Level ${explicit} is not an enabled partner level. Enabled levels: ${enabled
            .map((l) => l.level)
            .join(', ')}.`,
        );
      }
      return chosen.level;
    }

    if (!parentIbUserId) return enabled[0].level;

    const parent = await this.ib.findAccount(parentIbUserId);
    if (!parent) throw new ValidationError('The chosen parent partner does not exist.');

    const below = enabled.find((l) => l.level > parent.level);
    if (!below) {
      throw new ValidationError(
        `The partner ladder is ${enabled.length} level(s) deep and this parent is already at the ` +
          'deepest enabled level, so a partner beneath them would never earn. Add a level or ' +
          'choose a different parent.',
      );
    }
    return below.level;
  }

  /** `maxDirectPartners`, enforced at the moment a parent is assigned. */
  private async assertParentHasRoom(parentIbUserId: string): Promise<void> {
    const parent = await this.ib.findAccount(parentIbUserId);
    if (!parent) throw new ValidationError('The chosen parent partner does not exist.');
    if (!parent.active) {
      throw new ValidationError('The chosen parent partner is suspended.');
    }

    const level = await this.levels.findOne(parent.level);
    const max = level?.maxDirectPartners ?? null;
    if (max === null) return;

    const held = await this.ib.countDirectPartners(parentIbUserId);
    if (held >= max) {
      throw new ValidationError(
        `That partner already holds ${held} of their ${max} direct partners. Choose a different ` +
          'parent or raise the limit on their level.',
      );
    }
  }

  /**
   * Would making `parentIbUserId` the parent of `userId` create a loop?
   *
   * Public because the reassign action on the partners list needs it, and it is
   * the guard the DATABASE cannot provide: a self-referencing foreign key
   * checks only that the target row exists, so A→B→A is accepted by Postgres.
   * `test/ib-schema-constraints.spec.ts` asserts that gap on purpose, so this
   * is understood as load-bearing rather than defensive.
   *
   * A cycle is not a cosmetic problem: the payout walk climbs parents until it
   * runs out, and a loop is a walk that never does.
   */
  async wouldCreateCycle(userId: string, parentIbUserId: string): Promise<boolean> {
    if (userId === parentIbUserId) return true;
    // If the proposed parent already sits BENEATH this partner, pointing at
    // them closes the ring.
    const ancestorsOfParent = await this.ib.ancestorsOf(parentIbUserId);
    return ancestorsOfParent.includes(userId);
  }

  /**
   * A code nobody else holds.
   *
   * Retried rather than trusted: 31^8 is large, but the column is UNIQUE and a
   * collision would surface as a failed approval at the worst possible moment.
   * The loop is bounded — an unbounded retry on a saturated keyspace is a hung
   * request — and exhausting it is a real error rather than a silently reused
   * code, because attribution is permanent and a duplicate pays the wrong
   * partner forever.
   */
  private async generateReferralCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = randomCode();
      const taken = await this.ib.findAccountByReferralCode(code);
      if (!taken) return code;
    }
    throw new ConflictError('Could not allocate a referral code. Please try again.');
  }
}

/**
 * `randomBytes`, not `Math.random`.
 *
 * A referral code is not a secret, but it is an identifier somebody could
 * enumerate to map the partner network, and a CSPRNG costs nothing here.
 * Modulo bias is avoided by the alphabet length dividing evenly enough that the
 * skew is immaterial at this size — and the code is checked for uniqueness
 * regardless.
 */
function randomCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

/**
 * The refusal the client is shown, built from the reviewer's inputs.
 *
 * Both parts optional individually, at least one required together — a
 * rejection with nothing in it tells the client only that the answer was no.
 * The note is appended rather than replacing the label so the reason stays
 * comparable across reviewers while still allowing the specific detail.
 */
function composeReason(reason?: string, note?: string): string {
  const label = reason?.trim() ?? '';
  const extra = note?.trim() ?? '';

  if (!label && !extra) {
    throw new ValidationError('A rejection needs a reason. Choose one, or write a note.');
  }
  if (!label) return extra;
  if (!extra) return label;
  return `${label} — ${extra}`;
}

/** Did this error come from a specific named constraint? */
function violates(error: unknown, constraint: string): boolean {
  const cause: unknown = (error as { cause?: unknown }).cause ?? error;
  return (cause as { constraint?: string })?.constraint === constraint;
}
