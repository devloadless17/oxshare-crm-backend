import { decodeCursor, pageSize, twoWayPaging } from '../../common/pagination';
import type { DateRange } from '../../common/date-range';
import { ibAccountView } from './ib-views';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { RejectionReasonsStore } from '../../store/rejection-reasons.store';
import { composeReasonArabic } from '../../common/i18n/reason-arabic';
import { randomBytes } from 'node:crypto';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db, Executor } from '../../database/db';
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
import { SignupLinksStore } from '../../store/signup-links.store';
import { IbLevelsService } from './ib-levels.service';
import { ClientVisibilityService } from '../../common/security/client-visibility.service';
import { EmailService } from '../email/email.service';
import { AdminAuditService } from '../admin/admin-audit.service';
import { ProductsStore, type ProductRow } from '../../store/products.store';
import { WalletProvisioningService } from '../wallet/wallet-provisioning.service';
import type { Actor } from '../../common/security/actor';
import type { ClientScope } from '../../common/security/client-scope';
import { maskedFieldsFor, type FieldMask } from '../../common/security/field-mask';
import { REFERRAL_CODE_ALPHABET, REFERRAL_CODE_LENGTH } from '../../common/referral-code';
import { IB_TREE_MAX_LEVELS } from '../../common/ib-levels';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import type { IbIneligibleCode } from './dto/ib-application.dto';
import { localizeMessage } from '../../common/i18n/localize-message';
import { requestLocale } from '../../common/i18n/locale';

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

/*
 * The alphabet moved to `common/referral-code.ts`, because RECOGNISING a code
 * now depends on it as well as minting one. Two copies would be two answers to
 * "which characters are legal", and the reader that strips everything else
 * would drift from the generator that produces them.
 */
const CODE_ALPHABET = REFERRAL_CODE_ALPHABET;
const CODE_LENGTH = REFERRAL_CODE_LENGTH;

/*
 * ── EVERY NEW PARTNER IS A MAIN PARTNER (tech lead, 13 Oct 2026) ──────────
 *
 * Approval places nobody under anybody. A client who applies becomes a main
 * partner (level 1) whoever introduced them, and an administrator makes a
 * partner a sub-partner (level 2) as a deliberate act: by naming the main
 * partner at approval, or later with the level control on the partner's
 * profile (`changeLevel` → `reassignParent`).
 *
 * Until then the introducer recorded at registration became the parent
 * automatically, and two rules followed from it that are gone with it:
 *
 * - `chain_full`: a client introduced by a sub-partner could not apply,
 *   because there was no rung beneath their introducer. Nobody lands beneath
 *   their introducer now, so nobody is refused for where their introducer
 *   stands.
 * - The inherited programme: a sub-partner sells under their master's agency,
 *   so the applicant was not asked. A main partner has no master, so the
 *   applicant chooses, and the reviewer may still override.
 *
 * Two rules decided with it (13 Oct 2026):
 *
 * - "Introduced by" (`users.referred_by_ib_user_id`) FOLLOWS THE POSITION at
 *   approval too, as it already did on every move: a client who becomes a main
 *   partner has no introducer any more, so whoever introduced them stops
 *   earning on them — on their own trades as well as their clients'. The audit
 *   row keeps who it was.
 * - Whenever an administrator places a partner under a main partner (at
 *   approval, or by any move), they CHOOSE the agency in the same step. It is
 *   never copied from the parent.
 */

/*
 * The refusal when a partner is placed under a main partner without an agency.
 * One sentence for approval and for every move, so the doors word it alike.
 */
const SUB_PARTNER_AGENCY_REQUIRED =
  'Choose the agency for this partner. It is chosen every time a partner is placed under a main partner.';

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
    /*
     * The configured reasons' Arabic, copied onto a refusal as it is written
     * (0179). APPENDED LAST and optional, for the positional construction above:
     * without it a refusal simply stores the reviewer's own Arabic, if any.
     */
    @Optional() private readonly reasons?: RejectionReasonsStore,
    /*
     * A partner's tags, copied onto a referral moved to them (0195). APPENDED
     * LAST and optional, for the positional construction above: without it a
     * move changes the introducer and attaches nothing.
     */
    @Optional() private readonly signupLinks?: SignupLinksStore,
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
  async statusFor(userId: number): Promise<{
    account:
      | (IbAccountRow & {
          agencyName: string | null;
          /** Arabic twins (0179): null = untranslated; `productsAr[i]` is `products[i]`. */
          agencyNameAr: string | null;
          products: string[];
          productsAr: (string | null)[];
        })
      | null;
    application:
      (IbApplicationRow & { agencyName: string | null; agencyNameAr: string | null }) | null;
    eligible: boolean;
    /** Why not, in a sentence the portal can show verbatim. Null when eligible. */
    ineligibleReason: string | null;
    /** WHICH requirement is unmet, for chrome the sentence cannot carry. */
    ineligibleCode: IbIneligibleCode | null;
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
    const productOf = new Map(products.map((product) => [product.id, product]));

    const accountAgency = agencyOf(account?.agencyId ?? null);
    const applicationAgency = application ? agencyOf(application.agencyId) : null;
    // Index for index with their Arabic (0179), so the two lists cannot misalign.
    const sold = (accountAgency?.productIds ?? [])
      .map((id) => productOf.get(id))
      .filter((product): product is ProductRow => Boolean(product?.name));

    return {
      account: account
        ? {
            ...account,
            agencyName: accountAgency?.name ?? null,
            agencyNameAr: accountAgency?.nameAr ?? null,
            /*
             * Names, not ids — this goes to a partner, who has no use for a
             * uuid. Empty when they are on no agency, which means their clients
             * are offered the full catalogue rather than nothing.
             */
            products: sold.map((product) => product.name),
            productsAr: sold.map((product) => product.nameAr),
          }
        : null,
      application: application
        ? {
            ...application,
            agencyName: applicationAgency?.name ?? null,
            agencyNameAr: applicationAgency?.nameAr ?? null,
          }
        : null,
      /*
       * ONE gate: verification. Who introduced the client no longer decides
       * whether they may apply, because approval never places them beneath
       * their introducer (see the note above the class).
       */
      eligible: verified,
      // Printed as is by the portal, so in the client's language.
      ineligibleReason: verified
        ? null
        : localizeMessage(
            'Your identity must be verified before you can apply to the partner programme.',
            requestLocale(),
          ),
      ineligibleCode: verified ? null : 'unverified',
    };
  }

  /**
   * Apply.
   *
   * The refusals are ordered by what the client can DO about them: they are
   * already a partner (nothing to do), they are not verified (go and verify),
   * they already have one open (wait). Each says which.
   */
  async apply(
    userId: number,
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
     * Every applicant CHOOSES, because every applicant becomes a main partner
     * (see the note above the class). Until 13 Oct 2026 an applicant introduced
     * by a partner was given that partner's agency and not asked, because they
     * were about to sell beneath them; a main partner sells beneath nobody.
     * Placing a partner under a parent is now an administrator's act, and
     * `approve` gives them the parent's agency when it is.
     */
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

    try {
      const created = await this.ib.createApplication({
        userId,
        agencyId: input.agencyId,
        motivation: input.motivation ?? null,
        website: input.website ?? null,
      });

      // Ring the reviewers' bells — post-write, never-throws. The task resolves
      // itself for every reviewer when the application leaves 'pending'
      // (migration 0140); the queue badge stays the durable signal.
      void this.notifications.notifyAdmins({
        kind: 'admin.partner.applied',
        params: { applicationId: created.id, userId },
        subject: { id: created.id, clientId: userId },
      });

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
      /** One application by its uuid — see the store. */
      id?: string;
      status?: IbApplicationStatus;
      page?: number;
      limit?: number;
      /** Free text over the applicant's email and name — see the store. */
      q?: string;
      sort?: string;
      order?: string;
      range?: DateRange;
      /** Keyset position from a previous page. */
      cursor?: string;
      /** `prev` / `last` walk backward — `pageDirection`. */
      dir?: string;
    },
    scope: ClientScope,
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = pageSize(filter.limit ?? 20);
    // Validated BEFORE the cursor is decoded: the cursor names the sort it is for.
    const sort = sortKey(
      filter.sort,
      IB_APPLICATION_SORT_COLUMNS,
      DEFAULT_IB_APPLICATION_SORT,
      'partner applications',
    );
    const result = await this.ib.findPageWithUsers({
      id: filter.id,
      status: filter.status,
      range: filter.range,
      page,
      limit,
      q: filter.q,
      scope,
      // R-2.5. An unrecognised key is a 400 naming the allowed ones, never a
      // silent fallback — a sort the server ignored is a lie the UI tells.
      sort,
      order: sortOrder(filter.order),
      cursor: filter.cursor ? decodeCursor(filter.cursor, sort, undefined, 'uuid') : undefined,
      paging: twoWayPaging({
        page: filter.page === undefined ? undefined : String(filter.page),
        cursor: filter.cursor,
        dir: filter.dir,
      }),
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
       * from the partner's RUNG now, and the rung follows the position: no
       * parent is level 1, a main partner as parent is level 2.
       */
      /**
       * The main partner to place them under, making them a sub-partner
       * (level 2). Omitted or null: a main partner (level 1), whoever
       * introduced them. Never inferred from the introducer (13 Oct 2026).
       */
      parentIbUserId?: number | null;
      /**
       * The agency to appoint them under. Omitted: what the applicant asked
       * for. REQUIRED with a parent: the administrator chooses it whenever a
       * partner is placed under a main partner (13 Oct 2026).
       */
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
     * enumeration oracle for the exact clients this admin was denied. And the
     * SAME 404 as a missing application — code and message — or the difference
     * is the oracle instead.
     */
    await this.visibility.assertVisible(
      application.userId,
      scope,
      () => new NotFoundError('Application not found.'),
    );
    if (application.status !== 'pending') {
      throw new ConflictError(
        `Only a pending application can be approved; this one is ${application.status}.`,
      );
    }

    /*
     * The parent is the reviewer's choice and nothing else: no parent named is
     * a main partner (see the note above the class). A chosen parent is
     * scoped (#5): a scoped reviewer places the new partner only under a
     * parent in their own territory, and out of it is a 404 before
     * `assertParentHasRoom` can describe it.
     */
    const parentIbUserId = options.parentIbUserId ?? null;
    if (parentIbUserId) {
      await this.visibility.assertVisible(parentIbUserId, scope);
      await this.assertParentHasRoom(parentIbUserId);
    }

    /*
     * ── THE PARTNER'S LEVEL FOLLOWS THEIR POSITION (0112, 0197) ──────────
     *
     * A reviewer used to pick a commission programme here, falling back to the
     * agency's default and then to the catalogue's. None of that exists now:
     * terms come from the partner's RUNG, and the rung is where they sit.
     *
     * A partner with no parent deals with the broker directly and is level 1,
     * which is every approval unless the reviewer named a parent; under a main
     * partner they are one rung deeper.
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
     * The rung a partner placed under a parent would land on must EXIST and be
     * ENABLED on the Commission Levels ladder: a reviewer can aim an
     * application beneath a sub-partner, or beneath a main partner while level
     * 2 is switched off.
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
    if (parentIbUserId && parentLevel >= IB_TREE_MAX_LEVELS) {
      throw new ValidationError(
        'The chosen parent is a sub-partner, and a sub-partner cannot have partners beneath ' +
          'them — the tree has two levels. Approve this application under a main partner, or ' +
          'with no parent.',
      );
    }
    if (parentIbUserId && !(await this.ladderHasRungBeneath(parentLevel))) {
      throw new ValidationError(
        `The chosen parent stands on level ${parentLevel}, and the ladder has no enabled ` +
          `level ${parentLevel + 1} beneath them. Add or enable that level on the Commission ` +
          'Levels page, or approve this application under a different parent.',
      );
    }

    /*
     * THE AGENCY. As a main partner: WHAT THE APPLICANT ASKED FOR, unless the
     * reviewer says otherwise — appointing an applicant who asked for Gold onto
     * Silver is an ordinary decision, and approving a request while silently
     * substituting a different programme is the version of this that produces
     * an angry partner. `undefined` means "the reviewer did not say".
     *
     * Under a parent the administrator CHOOSES it, in this same request
     * (13 Oct 2026). It used to be copied from the parent; it is never inferred
     * now, from the parent or from the application, because placing somebody
     * under a main partner is a fresh decision about what they may sell.
     */
    if (parentIbUserId && !options.agencyId) {
      throw new ValidationError(SUB_PARTNER_AGENCY_REQUIRED);
    }
    const agencyId =
      options.agencyId === undefined ? (application.agencyId ?? null) : options.agencyId;

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

    await this.assertAgencyExists(agencyId);
    /*
     * A DISABLED agency is accepted here, unlike on apply. Closing a programme
     * stops new applications; it does not invalidate the ones already in the
     * queue, and refusing to approve them would strand every applicant who got
     * in before the door shut.
     */

    const referralCode = await this.generateReferralCode();

    /*
     * "Introduced by" FOLLOWS THE POSITION, here as on every later move (the
     * owner's rule of 7 Oct 2026, applied to approval on 13 Oct 2026): a main
     * partner has no introducer, and a sub-partner's introducer is the main
     * partner they sit under. So whoever introduced a client who becomes a main
     * partner stops earning on that client's trades from this approval on.
     * Commission already accrued is theirs and stays. Read here so the audit row
     * keeps who it was: the users row will not.
     */
    const referrerBefore =
      (await this.users.findById(application.userId))?.referredByIbUserId ?? null;

    const account = await this.db.transaction(async (tx) => {
      /*
       * The parent was checked above for a precise refusal; re-checked here,
       * under the tree lock and in the write's own transaction, so a parent
       * suspended in between cannot still receive the new partner.
       */
      if (parentIbUserId) {
        await this.ib.lockTree(tx);
        await this.assertParentHasRoom(parentIbUserId, tx);
      }
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
      if (referrerBefore !== parentIbUserId) {
        await this.users.update(
          application.userId,
          { referredByIbUserId: parentIbUserId ?? undefined },
          tx,
        );
      }

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
        // Who introduced them before, and after: the only place the first survives.
        referrerBefore,
        referrerAfter: parentIbUserId,
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
    userId: number,
    decision: 'approved' | 'rejected',
    options: { referralCode?: string; reason?: string; reasonAr?: string | null },
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) return;
    await this.email.sendPartnerDecisionEmail(
      user.email,
      user.firstName,
      decision,
      options,
      user.locale,
    );
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
    input: { reason?: string; note?: string; reasonAr?: string | null; noteAr?: string | null },
  ): Promise<IbApplicationRow> {
    const reviewerId = actor.id;
    const reason = composeReason(input.reason, input.note);
    /*
     * Its Arabic, decided now and stored with it (0179): the label's Arabic —
     * the reviewer's own, else the catalogue's as it reads today — and the
     * note's, joined the way the English is.
     */
    const label = input.reason?.trim() || null;
    const labelAr =
      input.reasonAr ??
      (label && this.reasons
        ? ((await this.reasons.arabicFor(['partner']))('partner', label) ?? null)
        : null);
    const reasonAr = composeReasonArabic({
      label,
      labelAr,
      note: input.note,
      noteAr: input.noteAr,
    });

    const application = await this.ib.findById(applicationId);
    if (!application) throw new NotFoundError('Application not found.');
    await this.visibility.assertVisible(
      application.userId,
      scope,
      () => new NotFoundError('Application not found.'),
    );
    if (application.status !== 'pending') {
      throw new ConflictError(
        `Only a pending application can be rejected; this one is ${application.status}.`,
      );
    }

    const updated = await this.ib.transition(applicationId, ['pending'], {
      status: 'rejected',
      rejectionReason: reason,
      rejectionReasonAr: reasonAr,
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
      reasonAr,
    });

    // The composed sentence, not the parts — the client reads the same text the
    // portal shows them, so the two can never disagree.
    void this.notifyDecision(application.userId, 'rejected', {
      reason,
      ...(reasonAr ? { reasonAr } : {}),
    });
    // Post-write like the email: the conditional transition already absorbed
    // any race, so a second reject cannot reach this line twice.
    void this.notifications.notify({
      recipient: { kind: 'client', id: application.userId },
      kind: 'partner.rejected',
      params: { reason, ...(reasonAr ? { reasonAr } : {}) },
    });

    return updated;
  }

  // ── managing partners after approval ───────────────────────────────────────

  /**
   * The partner DIRECTORY, scoped to what this admin may see, WITH earnings.
   *
   * Searchable (`q`: Portal ID, name, email or referral code) and filterable by
   * state since the Partners page returned (25 Sep 2026). It was deleted on
   * 13 Aug because it and the client list disagreed about who WAS a partner —
   * 7 against 1 — when this read `ib_accounts` and the client filter read a
   * label nothing maintained. The client type is derived from `ib_accounts`
   * now (`DERIVED_CLIENT_TYPE`), so both read one table, and
   * `test/ib-partner-directory.spec.ts` pins that their totals agree.
   *
   * @param filter.active `true`/`false`, already parsed from `?status=` at the
   *   edge, where an unknown value is a 400 rather than a filter that matches
   *   nothing.
   */
  async listPartners(
    filter: {
      page?: number;
      limit?: number;
      sort?: string;
      order?: string;
      q?: string;
      active?: boolean;
      /** Keyset position from a previous page. */
      cursor?: string;
      /** `prev` / `last` walk backward — `pageDirection`. */
      dir?: string;
    },
    scope: ClientScope,
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = pageSize(filter.limit ?? 20);
    // Validated BEFORE the cursor is decoded: the cursor names the sort it is for.
    const sort = sortKey(filter.sort, IB_PARTNER_SORT_COLUMNS, DEFAULT_IB_PARTNER_SORT, 'partners');
    const result = await this.ib.findPartnersPage({
      page,
      limit,
      scope,
      sort,
      order: sortOrder(filter.order),
      q: filter.q,
      active: filter.active,
      // A partner is keyed by their Portal ID: the cursor's id is an integer.
      cursor: filter.cursor ? decodeCursor(filter.cursor, sort, undefined, 'integer') : undefined,
      paging: twoWayPaging({
        page: filter.page === undefined ? undefined : String(filter.page),
        cursor: filter.cursor,
        dir: filter.dir,
      }),
    });

    /*
     * EARNINGS, attached per row.
     *
     * The list said who the partners were and nothing about what they had made
     * — the first question anybody opening this screen has. One grouped query
     * for the whole page rather than one per row.
     *
     * ONE ENTRY PER CURRENCY (see `IbStore.earningsByPartner`). A partner with
     * no commission reports `[]`: the honest reading of "nothing earned yet",
     * rather than a zero in a currency nobody chose.
     */
    const ids = result.rows.map((r) => r.account.userId);
    const [earnings, ibTotals] = await Promise.all([
      this.ib.earningsByPartner(ids),
      // The IB total column — sub-partners and clients (owner, 7 Oct 2026).
      this.ib.ibTotalsByPartner(ids, scope),
    ]);

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

    /*
     * MAPPED to the declared shape (`IbPartnerListResponseDto`), field by field,
     * rather than spreading the store row.
     *
     * The spread returned the raw `ib_accounts` row — `programId` (dead since
     * 0112), `applicationId`, timestamps — plus a duplicated top-level
     * `agencyId`, none of it declared anywhere, so both frontends typed this
     * response by hand and got it wrong. A declared type is only worth having
     * if it is the WHOLE payload.
     *
     * `parentIbUserId` is deliberately not on it. The parent is named by
     * `parentPortalId`, which the store resolves only inside the reader's
     * territory; the raw uuid beside it handed over the id of a partner the
     * reader is specifically denied — the oracle `partnerDetailFor` refuses to
     * substitute for the same reason. `parentOutsideTerritory` says "there is
     * one you may not see" without saying who.
     */
    return {
      total: result.total,
      totalCapped: result.totalCapped,
      nextCursor: result.nextCursor,
      prevCursor: result.prevCursor,
      rows: withAgency.map((row) => ({
        account: {
          userId: row.account.userId,
          level: row.account.level,
          referralCode: row.account.referralCode,
          active: row.account.active,
          agencyId: row.account.agencyId,
          approvedAt: row.account.approvedAt,
        },
        user: row.user,
        parentPortalId: row.parentPortalId,
        parentOutsideTerritory: row.account.parentIbUserId !== null && row.parentPortalId === null,
        agencyName: row.agencyName,
        earnings: earnings.get(row.account.userId) ?? [],
        subPartnerCount: ibTotals.get(row.account.userId)?.subPartnerCount ?? 0,
        clientCount: ibTotals.get(row.account.userId)?.clientCount ?? 0,
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
  /** Whether this reader may see this client — for a fact, never an error. */
  private canSee(clientId: number, scope: ClientScope): Promise<boolean> {
    if (scope.unrestricted) return Promise.resolve(true);
    return this.visibility.assertVisible(clientId, scope).then(
      () => true,
      () => false,
    );
  }

  /**
   * A partner account as THIS reader may see it (`IbAccountDto`): a parent
   * outside their territory is the fact, never the uuid (R1). Every admin route
   * answering an account goes through here — a partner placed before 13 Oct
   * 2026 may sit under an introducer the reviewer may not see.
   */
  async accountViewFor(account: Parameters<typeof ibAccountView>[0], scope: ClientScope) {
    const view = ibAccountView(account);
    if (view.parentIbUserId && !(await this.canSee(view.parentIbUserId, scope))) {
      return { ...view, parentIbUserId: null, parentOutsideTerritory: true };
    }
    return { ...view, parentOutsideTerritory: false };
  }

  async partnerDetailFor(userId: number, scope: ClientScope, fieldMask: FieldMask) {
    await this.visibility.assertVisible(userId, scope);

    const account = await this.ib.findAccount(userId);
    if (!account) return null;

    const [
      directPartners,
      directPartnersOutsideScope,
      earningsMap,
      ibTotals,
      referredCount,
      referredOutsideScope,
      agencies,
      products,
    ] = await Promise.all([
      this.ib.findDirectPartners(userId, scope),
      this.ib.countDirectPartnersOutside(userId, scope),
      this.ib.earningsByPartner([userId]),
      this.ib.ibTotalsByPartner([userId], scope),
      // Scoped, like every other client read on this route: `assertVisible`
      // above proves the PARTNER is visible and says nothing about their
      // clients. See UsersStore.countReferredBy.
      this.users.countReferredBy(userId, scope),
      this.users.countReferredOutsideScope(userId, scope),
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
    /*
     * Resolved through the SCOPED lookup, not `findById`.
     *
     * `findById` is the deliberately-unscoped variant, and using it here handed
     * the reader the email and full name of a partner who may sit in a territory
     * they are specifically denied — while `countReferredBy` two calls up obeys
     * the same reader's scope. One response, two answers about the same rule.
     *
     * Out of territory comes back as NULL, and the id is not substituted: the
     * whole reason the downline beside this one is scoped is that ids of people
     * a reader is denied are an oracle, and handing one over here would reopen
     * it for the single most interesting person in the tree.
     *
     * `parentOutsideTerritory` is what stops that null misdescribing the tree.
     * "No parent" and "a parent you may not see" are different facts — the first
     * says this partner deals with the broker directly, which decides their
     * terms — and collapsing them into one null is how somebody reads a level 2
     * partner as a level 1.
     */
    const parent = account.parentIbUserId
      ? ((await this.users.findForAdmin(account.parentIbUserId, scope)) ?? null)
      : null;
    const parentOutsideTerritory = Boolean(account.parentIbUserId) && parent === null;

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
    const levelTerms = await this.levels.findTerms(account.level);

    const detail = {
      userId,
      /*
       * The rung, and nothing about a catalogue. It follows the position
       * (level 1 unless an administrator placed them under a main partner)
       * and is changed with `changeLevel`.
       */
      level: account.level,
      levelName: levelTerms?.name ?? null,
      levelEnabled: levelTerms?.enabled ?? false,
      levelCommissionShare: levelTerms?.commissionShare ?? null,
      levelRebateShare: levelTerms?.rebateShare ?? null,
      // 0197 — a sub-partner's own terms; null = the level's.
      commissionShareOverride: account.commissionShareOverride ?? null,
      rebateShareOverride: account.rebateShareOverride ?? null,
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
            portalId: parent.portalId,
            email: parent.email,
            firstName: parent.firstName ?? null,
            lastName: parent.lastName ?? null,
          }
        : null,
      /** True when a parent exists but sits outside this reader's territory. */
      parentOutsideTerritory,
      /* SCOPED to the reader's territory; what it withheld is the count beside
         it — never who (R2, the owner's ruling). */
      directPartners,
      directPartnersOutsideScope,
      /* How many CLIENTS they introduced — the other half of a partner's line,
         and the number the earnings are a consequence of. */
      referredClientCount: referredCount,
      referredClientsOutsideScope: referredOutsideScope,
      /* The IB TOTAL's halves (owner, 7 Oct 2026): direct sub-partners, and
         introduced clients who are not partners themselves — so the two add
         up without counting a sub-partner twice. In-scope only. */
      subPartnerCount: ibTotals.get(userId)?.subPartnerCount ?? 0,
      clientCount: ibTotals.get(userId)?.clientCount ?? 0,
      // One entry per currency; `[]` is "nothing earned yet".
      earnings: earningsMap.get(userId) ?? [],
    };

    /*
     * Masked over the ASSEMBLED object, after the sections rather than before,
     * so a hidden field cannot survive inside one of them — `client.email`
     * removes the parent's address and, through the catalogue's aliases, the
     * same value on every row of `directPartners`.
     */
    return {
      ...detail,
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
      /** One accrual by its uuid — see the store. */
      id?: string;
      page?: number;
      limit?: number;
      sort?: string;
      order?: string;
      ibUserId?: number;
      clientUserId?: number;
      /** Free text over the PARTNER's email and name — see the store. */
      q?: string;
      status?: string;
      kind?: string;
      range?: DateRange;
      /** Keyset position from a previous page. */
      cursor?: string;
      /** `prev` / `last` walk backward — `pageDirection`. */
      dir?: string;
    },
    scope: ClientScope,
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = pageSize(filter.limit ?? 25);
    // Validated BEFORE the cursor is decoded: the cursor names the sort it is for.
    const sort = sortKey(filter.sort, IB_ACCRUAL_SORT_COLUMNS, DEFAULT_IB_ACCRUAL_SORT, 'accruals');
    return this.ib.findAccrualsPage({
      page,
      limit,
      scope,
      range: filter.range,
      id: filter.id,
      ibUserId: filter.ibUserId,
      clientUserId: filter.clientUserId,
      q: filter.q,
      status: filter.status,
      kind: filter.kind,
      sort,
      order: sortOrder(filter.order),
      cursor: filter.cursor ? decodeCursor(filter.cursor, sort, undefined, 'uuid') : undefined,
      paging: twoWayPaging({
        page: filter.page === undefined ? undefined : String(filter.page),
        cursor: filter.cursor,
        dir: filter.dir,
      }),
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
    userId: number,
    level: number,
    scope: ClientScope,
    actor: Actor,
    /** The main partner to sit under, when moving a main partner down to level 2. */
    parentIbUserId?: number | null,
    /** The agency they work under there — required with the parent (13 Oct 2026). */
    agencyId?: string | null,
  ): Promise<IbAccountRow> {
    await this.visibility.assertVisible(userId, scope);

    const account = await this.ib.findAccount(userId);
    if (!account) throw new NotFoundError('That partner does not exist.');

    /*
     * Since 0197 the level IS the position in a two-level tree: level 1 takes
     * the rest of the commission and level 2 takes their own share, so a
     * partner labelled against their position would be paid the wrong side of
     * the split. A partner with no parent is level 1; one with a parent is 2.
     *
     * So a change of level is a MOVE (owner, 7 Oct 2026): 2 → 1 detaches them
     * from their parent, and 1 → 2 places them under the main partner named
     * here. Both go through `reassignParent`, which owns the tree rules and
     * keeps "introduced by" in step with the new position.
     */
    if (level < 1 || level > IB_TREE_MAX_LEVELS) {
      throw new ValidationError(
        'A partner is a main partner (level 1) or a sub-partner (level 2); there is no other level.',
      );
    }
    const positional = account.parentIbUserId ? 2 : 1;
    if (level !== positional) {
      await this.assertLevelUsable(level);
      if (level === 2 && !parentIbUserId) {
        throw new ValidationError(
          'A sub-partner (level 2) sits under a main partner. Choose the main partner to place ' +
            'them under.',
        );
      }
      const moved = await this.reassignParent(
        userId,
        level === 1 ? null : (parentIbUserId ?? null),
        scope,
        actor,
        agencyId,
      );
      this.audit.record(actor.id, 'ib.level_change', 'ib_account', userId, {
        before: account.level,
        after: moved.level,
      });
      return moved;
    }

    const target = await this.assertLevelUsable(level);

    const updated = await this.ib.updateAccount(userId, { level });
    if (!updated) throw new NotFoundError('That partner does not exist.');

    this.audit.record(actor.id, 'ib.level_change', 'ib_account', userId, {
      before: account.level,
      after: updated.level,
      levelName: target.name,
    });
    return updated;
  }

  /** The level must exist and be enabled — see `changeLevel`. */
  private async assertLevelUsable(level: number) {
    const target = await this.levels.findTerms(level);
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
    return target;
  }

  /**
   * A SUB-PARTNER's own terms (0197) — the owner's rule, 6 Oct 2026.
   *
   * `commissionShare`: their percentage of the product's commission; the main
   * partner above takes the rest (100 − it). `rebateShare`: what THEIR clients
   * get back of the product's rebate. Either may be `null` to fall back to
   * level 2's share on the ladder; `undefined` leaves it as it is.
   *
   * Sub-partners only: a main partner takes the whole commission on their own
   * clients and the rest on their sub-partners', so there is no share of
   * theirs to set. Applies from the NEXT trade; accruals record the rate used.
   */
  async setTerms(
    userId: number,
    terms: { commissionShare?: string | null; rebateShare?: string | null },
    scope: ClientScope,
    actor: Actor,
  ): Promise<IbAccountRow> {
    await this.visibility.assertVisible(userId, scope);

    const account = await this.ib.findAccount(userId);
    if (!account) throw new NotFoundError('That partner does not exist.');
    if (!account.parentIbUserId || account.level < 2) {
      throw new ValidationError(
        'Only a sub-partner has their own commission and rebate. A main partner takes the whole ' +
          'commission on their own clients and the rest on their sub-partners’.',
      );
    }

    const patch: { commissionShareOverride?: string | null; rebateShareOverride?: string | null } =
      {};
    if (terms.commissionShare !== undefined) patch.commissionShareOverride = terms.commissionShare;
    if (terms.rebateShare !== undefined) patch.rebateShareOverride = terms.rebateShare;
    if (Object.keys(patch).length === 0) return account;

    const updated = await this.ib.updateAccount(userId, patch);
    if (!updated) throw new NotFoundError('That partner does not exist.');

    // Who changed a partner's pay, from what to what — the row an auditor asks for.
    this.audit.record(actor.id, 'ib.terms_change', 'ib_account', userId, {
      before: {
        commissionShare: account.commissionShareOverride,
        rebateShare: account.rebateShareOverride,
      },
      after: {
        commissionShare: updated.commissionShareOverride,
        rebateShare: updated.rebateShareOverride,
      },
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
    userId: number,
    parentIbUserId: number | null,
    scope: ClientScope,
    actor: Actor,
    /**
     * The agency they work under from now on. REQUIRED when a parent is named
     * (13 Oct 2026); a partner cut loose to deal direct keeps their own.
     */
    agencyId?: string | null,
  ): Promise<IbAccountRow> {
    await this.visibility.assertVisible(userId, scope);

    const account = await this.ib.findAccount(userId);
    if (!account) throw new NotFoundError('That partner does not exist.');
    if (parentIbUserId === userId) {
      throw new ValidationError('A partner cannot be placed under themselves.');
    }
    const referrerBefore = (await this.users.findById(userId))?.referredByIbUserId ?? null;

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
      /*
       * Placing a partner under a main partner decides what they may SELL as
       * well as where they sit, so the administrator names the agency in the
       * same request (13 Oct 2026). It is never copied from the parent.
       */
      if (!agencyId) throw new ValidationError(SUB_PARTNER_AGENCY_REQUIRED);
      await this.assertAgencyExists(agencyId);
    }

    /*
     * Check AND write in one transaction under the tree lock. Checked outside
     * it, A→B and B→A each pass against a tree the other has not yet changed,
     * both commit, and the ring the database cannot refuse is closed.
     */
    const updated = await this.db.transaction(async (tx) => {
      await this.ib.lockTree(tx);
      if (parentIbUserId) {
        if (await this.wouldCreateCycle(userId, parentIbUserId, tx)) {
          throw new ValidationError(
            'That partner already sits beneath this one, so the change would create a loop in ' +
              'the payout chain.',
          );
        }
        await this.assertParentHasRoom(parentIbUserId, tx);
        /*
         * Two levels at most (6 Oct 2026): the new parent must be a main
         * partner, and a partner who has sub-partners of their own cannot
         * become one — their sub-partners would land on a third level.
         */
        const parent = await this.ib.findAccount(parentIbUserId, tx);
        if (parent && parent.level >= IB_TREE_MAX_LEVELS) {
          throw new ValidationError(
            'That partner is a sub-partner, and a sub-partner cannot have partners beneath them. ' +
              'Choose a main partner (level 1).',
          );
        }
        if ((await this.ib.countDirectPartners(userId, tx)) > 0) {
          throw new ValidationError(
            'This partner has sub-partners of their own, so they cannot become a sub-partner. ' +
              'Move their sub-partners first.',
          );
        }
      }
      /*
       * The level follows the position (0197): under a parent → 2, on their
       * own → 1. A per-partner override only means something on a
       * sub-partner, so becoming a main partner clears it.
       */
      const moved = await this.ib.updateAccount(
        userId,
        parentIbUserId
          ? { parentIbUserId, level: 2, agencyId }
          : { parentIbUserId, level: 1, commissionShareOverride: null, rebateShareOverride: null },
        tx,
      );
      /*
       * "Introduced by" FOLLOWS the position (owner, 7 Oct 2026): a main
       * partner is a new partner of the broker's and has no introducer, and a
       * sub-partner's introducer is the main partner they sit under. Written
       * in the same transaction, so the tree and the attribution the
       * commission walk starts from can never disagree.
       */
      await this.users.update(userId, { referredByIbUserId: parentIbUserId ?? undefined }, tx);
      return moved;
    });
    if (!updated) throw new NotFoundError('That partner does not exist.');

    /*
     * A reassignment moves who is paid ABOVE this partner from that point on,
     * and the old parent is not recoverable from the row afterwards — this is
     * the only place it survives. The introducer it replaced is kept beside it.
     */
    this.audit.record(actor.id, 'ib.parent_change', 'ib_account', userId, {
      before: account.parentIbUserId,
      after: updated.parentIbUserId,
      referrerBefore: referrerBefore,
      referrerAfter: parentIbUserId ?? null,
      agencyBefore: account.agencyId,
      agencyAfter: updated.agencyId,
    });
    return updated;
  }

  /**
   * Move a REFERRAL — a client a partner introduced — to another partner
   * (owner, 15 Oct 2026). The twin of `reassignParent` for a client who is not
   * a partner themselves.
   *
   * Any active partner may take them, main or sub-partner: a referral is a
   * leaf, so the two-level rule and the cycle check have nothing to say here.
   * The commission walk reads `referred_by_ib_user_id` per deal, so this pays
   * the new partner from the next accrual and restates nothing credited.
   *
   * The new partner's tags come with the client, as at sign-up (0195). Only
   * ADDS tags; the old partner's stay, because a system-attached tag cannot be
   * told apart from one an administrator's link gave them.
   */
  async moveReferral(
    userId: number,
    ibUserId: number,
    scope: ClientScope,
    actor: Actor,
  ): Promise<{ referredByIbUserId: number }> {
    await this.visibility.assertVisible(userId, scope);
    // The new partner is scoped too: out of territory reads as "does not exist".
    await this.visibility.assertVisible(ibUserId, scope);
    if (ibUserId === userId) {
      throw new ValidationError('A client cannot be introduced by themselves.');
    }

    // Under the tree lock, so an appointment cannot make them a partner between
    // the check below and the write.
    const before = await this.db.transaction(async (tx) => {
      await this.ib.lockTree(tx);
      if (await this.ib.findAccount(userId, tx)) {
        throw new ValidationError(
          'This client is a partner, so who introduced them follows where they sit. Use ' +
            'Move under another partner instead.',
        );
      }
      const client = await this.users.findById(userId, tx);
      if (!client) throw new NotFoundError('That client does not exist.');
      if (!client.referredByIbUserId) {
        throw new ValidationError(
          'No partner introduced this client yet. Record the partner who introduced them instead.',
        );
      }
      if (client.referredByIbUserId === ibUserId) {
        throw new ValidationError('This client is already with that partner.');
      }
      const partner = await this.ib.findAccount(ibUserId, tx);
      if (!partner) throw new NotFoundError('That partner does not exist.');
      if (!partner.active) throw new ValidationError('That partner is suspended.');

      await this.users.update(userId, { referredByIbUserId: ibUserId }, tx);
      if (this.signupLinks) {
        await this.signupLinks.attach(
          userId,
          await this.signupLinks.partnerTagIds(ibUserId, tx),
          tx,
        );
      }
      return client.referredByIbUserId;
    });

    this.audit.record(actor.id, 'client.referrer_move', 'user', userId, {
      before,
      after: ibUserId,
    });
    return { referredByIbUserId: ibUserId };
  }

  /**
   * Make an individual client a partner, from the console (owner, 7 Oct 2026)
   * — under an agency, at the top or under a main partner.
   *
   * It IS an approval: every rule `approve` enforces (agency required, tree of
   * two levels, a rung beneath the parent, scope) and everything it starts
   * (referral code, commission wallet, the client's email and bell) applies
   * unchanged, so there is one way to become a partner. A pending application
   * the client already sent is approved; otherwise one is opened on their
   * behalf, and withdrawn again if approval refuses, so a refusal leaves no
   * stray row in the review queue.
   *
   * "Introduced by" follows the chosen position, as on every later move.
   */
  async appointPartner(
    userId: number,
    options: { agencyId: string; parentIbUserId?: number | null },
    scope: ClientScope,
    actor: Actor,
  ): Promise<IbAccountRow> {
    await this.visibility.assertVisible(userId, scope);
    if (await this.ib.findAccount(userId)) {
      throw new ConflictError('This client is already a partner.');
    }
    if (!(await this.users.findById(userId))) {
      throw new NotFoundError('That client does not exist.');
    }

    const pending = await this.ib.findPendingByUser(userId);
    const application = pending ?? (await this.ib.createApplication({ userId }));
    try {
      return await this.approve(application.id, actor, scope, {
        agencyId: options.agencyId,
        parentIbUserId: options.parentIbUserId ?? null,
      });
    } catch (error) {
      if (!pending) await this.ib.deletePendingApplication(application.id);
      throw error;
    }
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
    userId: number,
    active: boolean,
    scope: ClientScope,
    actor: Actor,
  ): Promise<IbAccountRow> {
    await this.visibility.assertVisible(userId, scope);

    // Read the state BEFORE the write, so a no-op (a retried request, a stale
    // screen re-sending the current state) is recognisable below. The write
    // itself stays unconditional — setting a state to itself is harmless; the
    // ANNOUNCEMENT of it is not.
    // Under the tree lock, so a suspension cannot land between a placement's
    // "is the parent active?" check and its write.
    const { previous, updated } = await this.db.transaction(async (tx) => {
      await this.ib.lockTree(tx);
      return {
        previous: await this.ib.findAccount(userId, tx),
        updated: await this.ib.updateAccount(userId, { active }, tx),
      };
    });
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
  private async assertParentHasRoom(parentIbUserId: number, tx?: Executor): Promise<void> {
    /*
     * Given `tx`, the caller holds the tree lock and writes in the same
     * transaction, so the parent read here cannot go stale before that write.
     * `setActive` takes the same lock, so a suspension cannot slip between.
     */
    const parent = await this.ib.findAccount(parentIbUserId, tx);
    if (!parent) throw new ValidationError('The chosen parent partner does not exist.');
    if (!parent.active) {
      throw new ValidationError('The chosen parent partner is suspended.');
    }
  }

  /**
   * The agency must EXIST. A closed one is accepted: closing a programme stops
   * new applications, not an administrator's decision (see `approve`).
   */
  private async assertAgencyExists(agencyId: string): Promise<void> {
    const agencies = await this.catalogue.listAgencies();
    if (!agencies.some((agency) => agency.id === agencyId)) {
      throw new ValidationError('That agency does not exist. Reload and try again.');
    }
  }

  /**
   * Does the Commission Levels ladder have an ENABLED rung one below
   * `parentLevel` — i.e. is there anywhere to place a partner an
   * administrator puts beneath somebody standing there?
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
    // Two levels at most (6 Oct 2026): nobody is placed beneath a sub-partner.
    if (parentLevel + 1 > IB_TREE_MAX_LEVELS) return false;
    const rung = await this.levels.findTerms(parentLevel + 1);
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
  async wouldCreateCycle(userId: number, parentIbUserId: number, tx?: Executor): Promise<boolean> {
    if (userId === parentIbUserId) return true;
    // If the proposed parent already sits BENEATH this partner, pointing at
    // them closes the ring. Read on the caller's transaction, under its tree
    // lock, so the answer holds until the write commits.
    const ancestorsOfParent = await this.ib.ancestorsOf(parentIbUserId, tx);
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
