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
import { WalletProvisioningService } from '../wallet/wallet-provisioning.service';
import type { Actor } from '../../common/security/actor';
import type { ClientScope } from '../../common/security/client-scope';
import { applyMask, maskedFieldsFor, type FieldMask } from '../../common/security/field-mask';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import type { IbIneligibleCode } from './dto/ib-application.dto';

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
 * The deepest rung `ib_accounts.level` can hold — matches
 * `ib_accounts_level_range` and `ib_levels_level_range`.
 *
 * The STRUCTURAL bound, deliberately not the policy one. `ib_max_levels` says
 * how deep the broker PAYS and is a settings change; a partner tree may run
 * deeper than that, and clamping a partner to the paid depth would record a rung
 * they do not occupy.
 */
const MAX_STORED_LEVEL = 10;

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

/*
 * `CHAIN_FULL_REASON` IS BACK, in the catalogue-driven form.
 *
 * It went in 0102 with the first ladder, on the reasoning that nesting a
 * partner under another is always structurally possible. Structurally it still
 * is — but 0112 made the rung a partner stands on the whole of their terms, so
 * "which rung would this applicant land on" is a commercial question again, and
 * the business answer is explicit: the tree ends where the Commission Levels
 * ladder ends. A client introduced by a partner on the deepest enabled level
 * has no rung to be placed on, and MUST NOT be able to become a partner (the
 * committed scope is two levels — Feature List Rev 9, IB-17 — and the seeded
 * ladder carries exactly L1 and L2).
 *
 * DELIBERATELY NOT a constant `2`. The ladder is what decides depth (0113
 * removed `ib_max_levels` so the IB Levels page is the only authority), so the
 * question asked everywhere below is "does an ENABLED `ib_levels` row exist one
 * rung beneath the introducer". An operator who adds and enables level 3 opens
 * the door with no code change; a deployment that configured nothing keeps the
 * agreed two.
 *
 * One sentence, shared by `statusFor` (the explanation) and `apply` (the
 * refusal), so the form and the door cannot word the same rule differently.
 */
const CHAIN_FULL_REASON =
  'The partner who introduced you is already on the deepest level of the partner programme, ' +
  'so a new partner account cannot be opened beneath them.';

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
    /*
     * Opens the partner's COMMISSION wallet on approval, so their screen has a
     * card on day one rather than a placeholder for one.
     *
     * The concrete class rather than the WALLET_PROVISIONING port: that token
     * exists so IDENTITY can reach provisioning without importing WalletModule
     * and closing a cycle. There is no cycle here -- WalletModule is @Global,
     * exports this service, and does not depend on IbModule -- and `CommissionService`
     * in this same module already injects `WalletService` the same way.
     *
     * APPENDED LAST, like the two above and for the same reason: this class is
     * constructed positionally in `ib-applications.spec.ts`.
     */
    private readonly walletProvisioning: WalletProvisioningService,
  ) {}

  // ── the client's side ──────────────────────────────────────────────────────

  /*
   * `inheritedAgencyIdFor` IS GONE — folded into `apply`, which already holds
   * the user row it re-read and now needs the introducer's whole ACCOUNT (for
   * the chain-room check) rather than only their agency. One read serves both;
   * the reasoning about why a sub-partner does not choose lives at that site.
   */

  /**
   * Who this applicant sits UNDER in the partner tree — the partner who
   * recruited them.
   *
   * ## The gap this closes
   *
   * `approve()` read `options.parentIbUserId ?? null`, so a tree position was
   * only ever set when a reviewer passed one — and the console never did. Every
   * approved partner landed at the ROOT, whoever had recruited them.
   *
   * The consequence was not cosmetic: FR-IB-17's whole distribution mechanism
   * needs a chain, and through the ordinary flow no chain was ever built. A
   * partner who recruited another partner earned nothing on their downline,
   * because they were not above it. The only remedy was for somebody to
   * remember, afterwards, to open that partner's profile and use the separate
   * "reassign parent" control on a different screen.
   *
   * It was also INCONSISTENT with the agency, which has always been inherited
   * from the introducer (`apply` resolves it from the same row). One
   * relationship, `users.referred_by_ib_user_id`, answered two ways.
   *
   * ## Only a partner can be a parent
   *
   * The introducer must hold an `ib_accounts` row. A client referred by another
   * CLIENT has no chain to join, and `null` puts them at the root — which is
   * exactly right for somebody nobody recruited.
   *
   * ## A SUSPENDED introducer still becomes the parent
   *
   * Suspension stops them EARNING — `resolveChain` breaks at a suspended
   * partner and pays nobody above them — but it is not a statement about who
   * recruited whom. Re-parenting the people they brought in would rewrite
   * history to record a fact that is not true, and would silently move a whole
   * sub-tree the day somebody is switched off and on again.
   */
  private async inheritedParentIbUserIdFor(userId: string): Promise<string | null> {
    const user = await this.users.findById(userId);
    const introducerId = user?.referredByIbUserId;
    if (!introducerId) return null;

    const introducer = await this.ib.findAccount(introducerId);
    return introducer ? introducerId : null;
  }

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
    /** WHICH requirement is unmet, for chrome the sentence cannot carry. */
    ineligibleCode: IbIneligibleCode | null;
    /**
     * The programme this applicant will be placed on, when it is not theirs to
     * pick — a partner introduced by another partner inherits theirs.
     *
     * NULL means the choice IS theirs, which is what the portal keys the picker
     * off: present, hide the picker and name the programme; absent, ask.
     * Sending the name rather than only the id is what lets the screen say
     * which programme they are joining instead of "one has been chosen for
     * you", which reads as an error.
     */
    inheritedAgency: { id: string; name: string } | null;
  }> {
    const [account, application, user] = await Promise.all([
      this.ib.findAccount(userId),
      this.ib.findLatestByUser(userId),
      this.users.findById(userId),
    ]);

    const verified = (user?.verificationLevel ?? 0) >= REQUIRED_VERIFICATION_LEVEL;

    /*
     * The INTRODUCER's account, read once and answering two questions: which
     * agency this applicant would inherit, and whether the ladder has a rung
     * left beneath them (`chainFull` below).
     *
     * Resolved from the `user` already loaded above rather than through a
     * helper that would fetch that row a second time for an answer this method
     * is holding.
     *
     * Skipped for somebody who is already a partner: they will never see the
     * application form, so both answers describe a screen nothing renders.
     */
    const introducer =
      account || !user?.referredByIbUserId
        ? null
        : await this.ib.findAccount(user.referredByIbUserId);

    /*
     * The SECOND requirement, back after 0102 removed it: the ladder must have
     * an enabled rung beneath the introducer, or there is nowhere to place this
     * applicant — see `CHAIN_FULL_REASON` for why the ladder is the authority.
     * A client under nobody lands on rung 1 and is never chain-blocked.
     */
    const chainFull = introducer ? !(await this.ladderHasRungBeneath(introducer.level)) : false;

    const inheritedAgencyId = introducer?.agencyId ?? null;

    /*
     * The agency NAMES, resolved once for both halves.
     *
     * Read only when something references an agency, so the common case — a
     * client who has never applied — costs no extra query. The catalogue is a
     * handful of rows, so listing it whole beats two id lookups.
     */
    const needsCatalogue = Boolean(account?.agencyId ?? application?.agencyId ?? inheritedAgencyId);
    const [agencies, products] = needsCatalogue
      ? await Promise.all([this.catalogue.listAgencies(), this.catalogue.listProducts()])
      : [[], []];

    const agencyOf = (id: string | null) => agencies.find((agency) => agency.id === id) ?? null;
    const productName = new Map(products.map((product) => [product.id, product.name]));

    const accountAgency = agencyOf(account?.agencyId ?? null);
    const inheritedAgency = agencyOf(inheritedAgencyId);

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
      /*
       * TWO gates again, and `chain_full` is reported FIRST when both are
       * unmet. The precedence is about what each code makes the portal draw:
       * `unverified` comes with a "Verify now" button, and sending a client
       * through the whole KYC wizard to reach a door that stays shut is an
       * errand the platform knows to be pointless. `chain_full` has no next
       * step, which is the honest answer for somebody the ladder cannot hold.
       */
      eligible: verified && !chainFull,
      ineligibleReason: chainFull
        ? CHAIN_FULL_REASON
        : verified
          ? null
          : 'Your identity must be verified before you can apply to the partner programme.',
      ineligibleCode: chainFull ? 'chain_full' : verified ? null : 'unverified',
      inheritedAgency: inheritedAgency
        ? { id: inheritedAgency.id, name: inheritedAgency.name }
        : null,
    };
  }

  /**
   * Apply.
   *
   * The refusals are ordered by what the client can DO about them: they are
   * already a partner (nothing to do), the ladder has no rung for them
   * (nothing to do, and no verification errand changes it — the same
   * precedence `statusFor` gives the code), they are not verified (go and
   * verify), they already have one open (wait). Each says which.
   */
  async apply(
    userId: string,
    input: {
      motivation?: string;
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

    /*
     * The INTRODUCER's account, read once for the two things it decides here:
     * whether the ladder has a rung left beneath them, and which agency a
     * sub-partner inherits (below).
     */
    const introducer = user.referredByIbUserId
      ? await this.ib.findAccount(user.referredByIbUserId)
      : null;

    /*
     * The same refusal the portal already renders, enforced rather than
     * assumed: a client whose introducer stands on the deepest enabled level
     * has no rung to be placed on, and their application must not enter the
     * queue — accepting it would ask a reviewer to decide something the ladder
     * has already decided, weeks after the client was told the door was open.
     * See `CHAIN_FULL_REASON` for why the ladder is the authority.
     *
     * BEFORE the verification refusals, matching `statusFor`'s precedence:
     * "verify your email" to somebody the ladder cannot hold is an errand that
     * unlocks nothing.
     */
    if (introducer && !(await this.ladderHasRungBeneath(introducer.level))) {
      throw new ValidationError(CHAIN_FULL_REASON);
    }

    /*
     * A VERIFIED ADDRESS, checked here as well as at the guard.
     *
     * `IbController` carries `EmailVerifiedGuard`, so an HTTP caller cannot
     * reach this method unverified — and that is exactly why the check is worth
     * repeating rather than assuming. The guard protects a ROUTE; this protects
     * the RULE. Anything that calls the service directly — a script, a seeder, a
     * future admin path, the next controller somebody adds without remembering
     * the decorator — bypasses the guard entirely and would create a partner
     * account for an address nobody has proved they own.
     *
     * That matters more here than on an ordinary screen: a partner is PAID, and
     * the referral code is the instrument. An unverified address is one a
     * stranger may have typed.
     *
     * Ordered before the identity check because it is the earlier step in
     * onboarding — telling someone to finish KYC when they have not yet clicked
     * the link in their inbox sends them to a wizard they cannot complete.
     */
    if (!user.emailVerified) {
      throw new ValidationError(
        'Please verify your email address before you apply to the partner programme.',
      );
    }

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
    /*
     * ── AN AGENCY IS REQUIRED, not optional ──────────────────────────────────
     *
     * The agency decides what a partner may sell, and a partner appointed
     * without one has clients offered the ENTIRE catalogue — the broadest
     * permission in the system, reached by leaving a field blank. That is the
     * wrong default for a grant that is otherwise reviewed line by line.
     *
     * This used to be optional so that a broker who had not configured any
     * agencies could still recruit. The trade is now explicit and goes the
     * other way: with no agency open, nobody can apply, and the operator is
     * told to configure one. A programme nobody has defined is not something an
     * applicant should be able to join by omission.
     *
     * Enforced HERE as well as at approval, because accepting an application
     * against nothing and discovering it weeks later is the failure this whole
     * block exists to prevent.
     */
    /*
     * ── A SUB-PARTNER DOES NOT CHOOSE ────────────────────────────────────────
     *
     * An applicant introduced by an existing partner inherits that partner's
     * programme. Left to choose, they could take a programme their introducer
     * does not carry — a master partner's own downline selling a catalogue the
     * master has no relationship with, while commission flowed up a chain
     * whose top never agreed to it. So the programme comes from the introducer
     * and the applicant is not asked; a client under NOBODY is a direct
     * partner and still chooses, because there is nobody above them for the
     * answer to come from.
     *
     * Their `agencyId` is IGNORED rather than refused, because the portal does
     * not draw the picker for them — so anything arriving in that field is a
     * stale form or a hand-made request, and neither is worth an error the
     * honest client would never see.
     *
     * NULL has two meanings and both mean "let them choose": no introducer at
     * all, or an introducer carrying no agency — the pre-agency partners
     * `ib_accounts.agencyId` is nullable for. Refusing the second would punish
     * an applicant for an operator's unfinished migration.
     *
     * The inherited id deliberately skips the "open for applications" check
     * below. That check protects a CHOICE, and this is not one: an operator
     * closing a programme to new direct applicants must not thereby sever the
     * downline of every partner already selling it, which is what refusing here
     * would do.
     */
    const inheritedAgencyId = introducer?.agencyId ?? null;

    if (!inheritedAgencyId) {
      if (!input.agencyId) {
        throw new ValidationError(
          'Choose the partner programme you are applying for. An application cannot be submitted without one.',
        );
      }

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
        agencyId: inheritedAgencyId ?? input.agencyId ?? null,
        motivation: input.motivation ?? null,
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
  async list(
    filter: {
      status?: IbApplicationStatus;
      page?: number;
      limit?: number;
      /** Free text over the applicant's email and name — see the store. */
      q?: string;
      sort?: string;
      order?: string;
    },
    scope: ClientScope,
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
    const result = await this.ib.findPageWithUsers({
      status: filter.status,
      page,
      limit,
      q: filter.q,
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

    /*
     * The agency NAME, attached per row — the same shape `listPartners` uses
     * for earnings, and for the same reason.
     *
     * Which programme somebody applied for is the first thing a reviewer needs:
     * approving grants it, and an approval made without seeing it is one made
     * blind. Resolved from the catalogue in one read rather than joined into
     * the paged query, which is scoped and sorted and does not need a fourth
     * table in it.
     */
    // The id sits on `application`, one level down, like `account` does on the
    // partner rows below — lifted so the shared helper can see it.
    return {
      ...result,
      rows: await this.withAgencyNames(
        result.rows.map((row) => ({ ...row, agencyId: row.application.agencyId })),
      ),
    };
  }

  /**
   * Attach `agencyName` to rows carrying an `agencyId`.
   *
   * Null stays null and means one of two things that resolve identically: the
   * row predates agencies, or the deployment has none. Either way there is no
   * programme to name.
   */
  private async withAgencyNames<T extends { agencyId?: string | null }>(
    rows: T[],
  ): Promise<(T & { agencyName: string | null })[]> {
    if (!rows.some((row) => row.agencyId)) {
      return rows.map((row) => ({ ...row, agencyName: null }));
    }

    const agencies = await this.catalogue.listAgencies();
    const nameOf = new Map(agencies.map((agency) => [agency.id, agency.name]));

    return rows.map((row) => ({
      ...row,
      agencyName: row.agencyId ? (nameOf.get(row.agencyId) ?? null) : null,
    }));
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
   * with a PROGRAMME, a parent and a referral code, which is what every future
   * commission is calculated from and attributed through. R-6.5's rule is that
   * where the money relationship is established the record of who established it
   * commits with it, so a partner who exists and is being paid with no record of
   * who let them in is not a state this system can reach.
   *
   * The other four (`reject`, `program_change`, `parent_change`, `suspend`) use
   * fire-and-forget `record`: they change an existing row rather than creating
   * the relationship, and an audit-write failure should not undo a correct
   * rejection.
   */
  async approve(
    applicationId: string,
    actor: Actor,
    scope: ClientScope,
    options: {
      /*
       * ── `programId` IS GONE (0112) ────────────────────────────────────────
       *
       * A reviewer used to appoint a partner onto a named programme. Terms come
       * from the partner's RUNG now, and a rung is not a choice — it follows
       * from who recruited them. So there is nothing to pass here and nothing on
       * the approval screen to get wrong.
       */
      parentIbUserId?: string | null;
      agencyId?: string | null;
    } = {},
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

    /*
     * The reviewer's choice wins; OMITTING it inherits from whoever recruited
     * the applicant. See `inheritedParentIbUserIdFor` for why that inheritance
     * had to exist at all.
     *
     * `!== undefined` rather than `??`, so an explicit `null` still means "put
     * them at the ROOT". Those are different instructions and `??` cannot tell
     * them apart — it would make deliberately rooting a partner impossible the
     * moment they had an introducer.
     */
    const parentIbUserId =
      options.parentIbUserId !== undefined
        ? options.parentIbUserId
        : await this.inheritedParentIbUserIdFor(application.userId);

    if (parentIbUserId) {
      // The chosen parent is scoped too (#5): a scoped admin approving an
      // application may only place the new partner under a parent inside their
      // own territory — an out-of-scope parent is a 404 before
      // `assertParentHasRoom` can leak its exists/suspended/full state.
      await this.visibility.assertVisible(parentIbUserId, scope);
      await this.assertParentHasRoom(parentIbUserId);
    }

    /*
     * WHAT THE APPLICANT ASKED FOR, unless the reviewer says otherwise — and
     * unless they are being placed BENEATH somebody, in which case the parent
     * decides.
     *
     * The reviewer may still override explicitly: appointing an applicant who
     * asked for Gold onto Silver is an ordinary decision, and approving a
     * request while silently substituting a different programme is the version
     * of this that produces an angry partner. `undefined` means "the reviewer
     * did not say".
     *
     * The PARENT's programme wins over the application's, because a sub-partner
     * sells beneath their master and cannot carry a catalogue the master has no
     * relationship with — the same rule `apply` enforces when the application
     * is submitted. It is re-derived here rather than trusted from
     * the application because the reviewer chooses the parent at THIS moment:
     * an applicant introduced by nobody can still be placed under a partner,
     * and one introduced by A can be placed under B. In both cases the
     * application's stored agency describes a chain that is not the one being
     * created.
     *
     * A parent with no agency of their own falls through to the application's,
     * which keeps the pre-agency partners recruiting rather than making every
     * approval beneath them impossible.
     */
    const parentAgencyId = parentIbUserId
      ? ((await this.ib.findAccount(parentIbUserId))?.agencyId ?? null)
      : null;

    const agencyId =
      options.agencyId === undefined
        ? (parentAgencyId ?? application.agencyId ?? null)
        : options.agencyId;

    /*
     * ── NO AGENCY, NO PARTNER ────────────────────────────────────────────────
     *
     * `null` used to be reachable here and meant "appoint them under no
     * agency" — the pre-agency behaviour, kept deliberately. It is refused now,
     * on both routes into this value: a reviewer who passes null explicitly,
     * and an older application that carries none.
     *
     * The reason is what a null agency GRANTS. Their clients are offered the
     * entire product catalogue, which is the broadest permission the system
     * has, and it was reachable by omitting a field on a form. Every other
     * aspect of this grant — the rung, the parent, the rate — is chosen; this
     * one defaulted to "everything".
     *
     * The cost is real and is the point: the ~691 applications already in the
     * queue carry no agency, so a reviewer must now CHOOSE one for each rather
     * than approving it blank. That is a decision they were always making
     * implicitly.
     */
    if (!agencyId) {
      throw new ValidationError(
        'Choose the agency to appoint this partner under. A partner cannot be approved without one — ' +
          'their clients would be offered the entire product catalogue.',
      );
    }

    const agencies = await this.catalogue.listAgencies();
    if (!agencies.some((agency) => agency.id === agencyId)) {
      throw new ValidationError('That agency does not exist. Reload and try again.');
    }
    /*
     * A DISABLED agency is accepted here, unlike on apply. Closing a programme
     * stops new applications; it does not invalidate the ones already in the
     * queue, and refusing to approve them would strand every applicant who got
     * in before the door shut.
     */

    const referralCode = await this.generateReferralCode();

    /*
     * ── THE PARTNER'S LEVEL, DERIVED FROM WHO RECRUITED THEM (0112) ──────
     *
     * A reviewer used to pick a commission programme here, falling back to the
     * agency's default and then to the catalogue's. None of that exists now:
     * terms come from the partner's RUNG, and a rung is not a choice — it is
     * where they sit.
     *
     * A partner with no parent deals with the broker directly and is level 1.
     * One recruited by another partner is one rung deeper than their recruiter.
     * So there is nothing to choose, nothing to default, and nothing on the
     * approval screen to get wrong.
     *
     * CAPPED at the structural ceiling the column itself carries, not at the
     * platform's configured ladder depth. Those are different bounds and the
     * wider one belongs here: clamping to the ladder would write a rung the
     * partner does not occupy.
     */
    const parentLevel = parentIbUserId
      ? ((await this.ib.findAccount(parentIbUserId))?.level ?? 1)
      : 0;
    const level = Math.min(parentLevel + 1, MAX_STORED_LEVEL);

    /*
     * ── NO RUNG, NO APPROVAL ─────────────────────────────────────────────────
     *
     * The rung a recruited partner would land on must EXIST and be ENABLED on
     * the Commission Levels ladder — the same rule `apply` enforces at the
     * door, repeated here because the reviewer resolves the parent at THIS
     * moment: an application that entered the queue legitimately can still be
     * aimed beneath a partner the ladder ends at, either because the reviewer
     * chose that parent or because the introducer's own level changed while
     * the application waited.
     *
     * Only when there IS a parent. A root approval lands on rung 1, which
     * `IbLevelsService.remove` refuses to delete — and refusing every direct
     * appointment over a disabled rung 1 would be a platform-wide lockout no
     * one asked this method to enforce.
     *
     * A partner on a rung with no configured terms earns nothing silently —
     * `calculate` reports it per trade, but per trade is after the fact. The
     * refusal names both remedies because both are ordinary decisions.
     */
    if (parentIbUserId && !(await this.ladderHasRungBeneath(parentLevel))) {
      throw new ValidationError(
        `The chosen parent stands on level ${parentLevel}, and the ladder has no enabled ` +
          `level ${parentLevel + 1} beneath them. Add or enable that level on the Commission ` +
          'Levels page, or approve this application under a different parent.',
      );
    }

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
    /*
     * The partner's commission wallet, opened AFTER the transaction and
     * fire-and-forget, for the reason the email below records: the approval has
     * already committed, and a reviewer told it failed would approve again.
     *
     * `openCommissionWallet` never throws — it logs — so the `void` here is
     * about not WAITING rather than about ignoring a failure. The wallet is
     * opened lazily by the first confirmed commission regardless; this exists so
     * a newly approved partner's screen shows a commission card on day one
     * rather than a placeholder for one.
     */
    void this.walletProvisioning.openCommissionWallet(application.userId);

    void this.notifyDecision(application.userId, 'approved', { referralCode });

    return account;
  }

  /**
   *
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

    /*
     * The AGENCY, beside the earnings, because the two answer the same
     * question from opposite ends: what a partner sells and what it has made
     * them. A partner row that names neither is a name and a referral code.
     *
     * `withAgencyNames` reads rows with the id at the top level; here it is one
     * level down on `account`, so the mapping is done inline against the same
     * catalogue read.
     */
    const withAgency = await this.withAgencyNames(
      result.rows.map((row) => ({ ...row, agencyId: row.account.agencyId })),
    );

    return {
      ...result,
      rows: withAgency.map((row) => ({
        ...row,
        earnings: earnings.get(row.account.userId) ?? { confirmed: '0', pending: '0' },
      })),
    };
  }

  /**
   * ONE partner, in full — the profile screen's partner tab.
   *
   * ## Why this exists beside `listPartners`
   *
   * The list answers "who are our partners"; a client profile asks "what is
   * THIS person's standing", and the two need different shapes. Reaching the
   * second through the first meant paging the whole partner list in the browser
   * and filtering it, which is a read that grows with the platform to answer a
   * question about one row.
   *
   * Returns null rather than throwing when the client is not a partner. Every
   * client profile asks this — the tab only renders for a partner — so "no
   * partner account" is the ordinary answer, not an error. The CALLER decides
   * what a missing partner means, exactly as `statusFor` does on the portal.
   *
   * ## Scope is checked on the SUBJECT, not on their line
   *
   * `assertVisible` 404s a client outside the reader's tags, which is the same
   * refusal `GET /admin/clients/:id` gives and for the same reason — a scoped
   * admin must not be able to enumerate the client base they were denied.
   *
   * Their sub-partners and their parent are then returned WHOLE. Filtering
   * those by the reader's own scope would under-report a partner's line without
   * saying so — "two sub-partners" when there are five is a number an operator
   * would act on. The relationships are facts about the subject, and the
   * subject is one they are already entitled to see.
   */
  /**
   * @param fieldMask RBAC-03. This response carries the client identity of the
   *   partner's PARENT and of every direct sub-partner, and it carried them
   *   unmasked — the same address `/admin/clients/:id` correctly hides for the
   *   same reader, one screen away. Threaded in rather than masked in the
   *   controller so it sits with the other applyMask calls, where the census
   *   can see it.
   */
  async partnerDetailFor(userId: string, scope: ClientScope, fieldMask: FieldMask) {
    await this.visibility.assertVisible(userId, scope);

    const account = await this.ib.findAccount(userId);
    if (!account) return null;

    const [directPartners, earningsMap, referredCount, agencies, products] = await Promise.all([
      this.ib.findDirectPartners(userId),
      this.ib.earningsByPartner([userId]),
      this.users.countReferredBy(userId),
      account.agencyId ? this.catalogue.listAgencies() : Promise.resolve([]),
      account.agencyId ? this.catalogue.listProducts() : Promise.resolve([]),
    ]);

    const agency = agencies.find((entry) => entry.id === account.agencyId) ?? null;
    const productName = new Map(products.map((product) => [product.id, product.name]));

    /*
     * The PARENT as a person, not a uuid. `parentIbUserId` is the only field on
     * the account that names somebody, and a screen that printed the id would
     * send an operator to the client list to resolve it by hand.
     */
    const parent = account.parentIbUserId
      ? ((await this.users.findById(account.parentIbUserId)) ?? null)
      : null;

    /*
     * The RUNG, and the terms it carries — the whole of what this partner is
     * paid on (0112).
     *
     * `level` / `levelName` / `rateValue` sat here before 0102 and went with the
     * old ladder, because the rung had decided nothing since 0084: the response
     * carried three fields reading like the partner's economics beside the one
     * that actually was. They are back because the rung decides the terms
     * again — and this time it CARRIES them rather than pointing at a
     * catalogue.
     *
     * NULL when the partner stands deeper than the ladder is configured for.
     * That is a real state rather than an impossible one: a tree may run
     * deeper than the broker pays, and such a partner earns nothing until the
     * ladder is extended. Reporting the terms as null is how the screen can say
     * so, instead of showing zeroes that look configured.
     */
    const levelTerms = await this.levels.findOne(account.level);

    const detail = {
      userId,
      /*
       * The rung, and nothing about a catalogue. It is EDITABLE (see
       * `changeLevel`) but not chosen at approval — it follows from who
       * recruited this partner — so the screen reports it with a correction
       * available, rather than presenting it as a decision somebody made.
       */
      level: account.level,
      levelName: levelTerms?.name ?? null,
      levelEnabled: levelTerms?.enabled ?? false,
      levelCommissionMode: levelTerms?.commissionMode ?? null,
      levelCommissionRate: levelTerms?.commissionRate ?? null,
      levelCommissionAmountPerLot: levelTerms?.commissionAmountPerLot ?? null,
      levelRebateMode: levelTerms?.rebateMode ?? null,
      levelRebateRate: levelTerms?.rebateRate ?? null,
      levelRebateAmountPerLot: levelTerms?.rebateAmountPerLot ?? null,
      referralCode: account.referralCode,
      active: account.active,
      approvedAt: account.approvedAt,
      agencyId: account.agencyId,
      agencyName: agency?.name ?? null,
      /* Names, not ids — this is read by a person. Empty when they are on no
         agency, which means their clients are offered the full catalogue. */
      products: (agency?.productIds ?? [])
        .map((id) => productName.get(id))
        .filter((name): name is string => Boolean(name)),
      parent: parent
        ? {
            userId: parent.id,
            email: parent.email,
            firstName: parent.firstName ?? null,
            lastName: parent.lastName ?? null,
          }
        : null,
      directPartners,
      /* How many CLIENTS they introduced — the other half of a partner's line,
         and the number the earnings are a consequence of. */
      referredClientCount: referredCount,
      earnings: earningsMap.get(userId) ?? { confirmed: '0', pending: '0' },
    };

    /*
     * Masked over the ASSEMBLED object, after the sections rather than before,
     * so a hidden field cannot survive inside one of them — `client.email`
     * removes the parent's address and, through the catalogue's aliases, the
     * same value on every row of `directPartners`.
     */
    return {
      ...applyMask('ibPartner', detail, fieldMask),
      maskedFields: maskedFieldsFor('ibPartner', fieldMask),
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
      kind?: string;
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
      kind: filter.kind,
      sort: sortKey(filter.sort, IB_ACCRUAL_SORT_COLUMNS, DEFAULT_IB_ACCRUAL_SORT, 'accruals'),
      order: sortOrder(filter.order),
    });
  }

  /**
   * Move a partner to a different LEVEL — what decides their terms (0112).
   *
   * ## Why a partner's level is editable at all
   *
   * It is written at approval from their parent's level, which is right in the
   * ordinary case and cannot be right in every one: a partner recruited by
   * somebody who is later cut loose to deal direct, or one the broker has
   * agreed to treat as a main partner despite sitting under another, both need
   * moving. Without this the number was decided once by the shape of the tree
   * on one particular afternoon.
   *
   * ## The target level must EXIST and be ENABLED
   *
   * A partner standing on a level that is not configured earns nothing —
   * `calculate` reports it per trade and pays no rows — and a DISABLED level
   * pays nothing by definition. Either way the failure is silent from the
   * partner's side, with their referral links still working. So both are
   * refused here, and `IbLevelsService.update` refuses to disable a level
   * partners are standing on: without this half an operator could route around
   * that refusal by moving people onto an already-disabled rung.
   *
   * ## It applies to the NEXT trade, never to what has been earned
   *
   * Accruals record the rate AND the level they were calculated under, so
   * nothing already credited is restated. That is what makes this an ordinary
   * update rather than an operation that has to reason about history — and it
   * is why the audit row keeps the level on both sides: "who moved this
   * partner, and what were they on before" is the question asked when a payout
   * is disputed, and the current row answers half of it.
   *
   * ⚠️ This does NOT move anybody BENEATH them. A level is one partner's
   * position, and their sub-partners keep the levels they were approved on —
   * deliberately, because cascading would re-price an unbounded number of
   * people from one operator's edit of somebody else's row. Moving a subtree is
   * a series of decisions, each audited.
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

    const target = await this.levels.findOne(level);
    if (!target) {
      throw new NotFoundError(
        `Level ${level} is not configured, and a partner on an unconfigured level earns nothing. ` +
          'Add it on the Commission Levels page first.',
      );
    }
    if (!target.enabled) {
      throw new ValidationError(
        `Level ${level} ("${target.name}") is disabled, and a disabled level pays nothing. ` +
          'Enable it first, or choose another.',
      );
    }

    const updated = await this.ib.updateAccount(userId, { level });
    if (!updated) throw new NotFoundError('That partner does not exist.');

    this.audit.record(actor.id, 'ib.level_change', 'ib_account', userId, {
      before: account.level,
      after: updated.level,
      levelName: target.name,
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
      /*
       * The NEW PARENT is scoped too (#5, the 13 Aug scoped walk). Without this
       * a scoped admin could graft their partner under a partner OUTSIDE their
       * territory, and `assertParentHasRoom` below answers "does not exist" vs
       * "is suspended" vs "is full" distinguishably — a small state oracle over
       * out-of-territory partners. Resolved first, so an out-of-scope parent is
       * a 404 (same as one that does not exist) before any of those branches
       * can speak, and a scoped desk can only reassign within its own territory.
       */
      await this.visibility.assertVisible(parentIbUserId, scope);

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

  /*
   * `resolveLevel` IS GONE (0102).
   *
   * It answered "which rung does this partner land on", walking `ib_levels` to
   * find the shallowest enabled one, or the one below the parent's. Both the
   * table and the question went with the second catalogue: a partner's DEPTH is
   * a fact about the trade being paid on — how many hops above the client they
   * stand — computed per accrual by `resolveChain`, not a number written against
   * them at approval and then free to disagree with the tree.
   *
   * What approval still resolves is the PROGRAMME, which is the thing FR-IB-06
   * actually asks to be assigned. See `approve`.
   */

  /**
   * The chosen parent is real and not suspended.
   *
   * It also enforced `ib_levels.max_direct_partners` — a cap on how many
   * partners a rung could recruit directly — until migration 0055 dropped that
   * column. The cap was defaulted to unlimited, never set, and asked of an
   * operator on every level they created; it is gone, and this keeps the two
   * checks that were doing real work.
   *
   * The NAME is unchanged on purpose: "has room" still reads correctly at the
   * call site, and a partner who is suspended has no room for anybody.
   */
  private async assertParentHasRoom(parentIbUserId: string): Promise<void> {
    const parent = await this.ib.findAccount(parentIbUserId);
    if (!parent) throw new ValidationError('The chosen parent partner does not exist.');
    if (!parent.active) {
      throw new ValidationError('The chosen parent partner is suspended.');
    }
  }

  /**
   * Does the Commission Levels ladder have an ENABLED rung one below
   * `parentLevel` — i.e. is there anywhere to place a partner recruited by
   * somebody standing there?
   *
   * The ladder is the authority on depth (0113), so this asks the catalogue
   * rather than comparing against a constant: a deployment that configured
   * nothing carries the seeded L1+L2 and answers "no" beneath a level-2
   * partner, and an operator who enables a level 3 opens that door with no
   * code change. ENABLED, not merely present — a disabled rung pays nobody
   * standing on it, which is the same reason `changeLevel` refuses one.
   *
   * Past the structural ceiling the answer falls out for free: no `ib_levels`
   * row can exist above 10, so `findOne` returns null and the rung is refused.
   *
   * DELIBERATELY NOT consulted by the parent-reassignment path. Moving an
   * EXISTING partner rewrites the tree edge and not their level, so "no rung
   * beneath the new parent" would refuse the move over a level nothing is
   * about to write — and an operator's freedom to shape the tree deeper than
   * the ladder pays is recorded where `changeParent` and `MAX_STORED_LEVEL`
   * explain it. This gate is about CREATING a partner on a rung that is not
   * for sale.
   */
  private async ladderHasRungBeneath(parentLevel: number): Promise<boolean> {
    const rung = await this.levels.findOne(parentLevel + 1);
    return Boolean(rung?.enabled);
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
