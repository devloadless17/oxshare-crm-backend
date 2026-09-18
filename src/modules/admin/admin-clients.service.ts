import { Injectable } from '@nestjs/common';
import { UsersStore, clientSortKey, clientSortOrder, type User } from '../../store/users.store';
import { IbStore } from '../../store/ib.store';
import { ClientTagsStore } from '../../store/client-tags.store';
import {
  ClientNotFoundError,
  ReferralCodeUnknownError,
  ReferralPartnerInactiveError,
  ReferralSelfError,
  ReferrerAlreadySetError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { buildCursorPage, decodeCursor, pageSize } from '../../common/pagination';
import { AdminAuditService } from './admin-audit.service';
import { assertActorCan } from '../../common/security/actor';
import { maskedFieldsFor } from '../../common/security/field-mask';
import { KycStore, type KycSubmission } from '../../store/kyc.store';
import { actorHasPermission } from '../../common/security/actor';
import { EmailService } from '../email/email.service';
import { RefreshTokensService } from '../../common/security/refresh-tokens.service';
import { randomUUID } from 'crypto';
import { hashEmailedToken } from '../../common/security/emailed-token';

/** The six `kyc_status` values, in the order a client passes through them. */
const KYC_STATUSES = [
  'not_started',
  'in_progress',
  'submitted',
  'under_review',
  'approved',
  'rejected',
] as const;

/**
 * A caller's `?kycStatus=`, or a 400 naming what is allowed.
 *
 * NEVER a silent fallback — R-2.5. A misspelled status that was quietly ignored
 * would return the unfiltered list, and "every client" looks enough like a
 * plausible answer that nobody checks it against the filter they asked for.
 */
export function kycStatusFilter(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(KYC_STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(
      `Cannot filter by kycStatus "${value}". Allowed: ${KYC_STATUSES.join(', ')}.`,
    );
  }
  return value;
}

/**
 * A caller's `?emailVerified=`, as the TRI-STATE it is.
 *
 * Absent means "do not filter", which is a different request from
 * `emailVerified=false` — `=== 'true'` alone collapses the two and makes an
 * unfiltered list silently show only unverified clients.
 *
 * EXPORTED, and that is the point of it being a function at all. This logic
 * lived inline in `listClients` while `AdminExportService` had none, so
 * `/admin/clients/export?emailVerified=false` returned every client while the
 * screen it was exported from showed a filtered set. One definition is what
 * stops the file and the screen answering differently — the same argument
 * `export-rows.dto.ts` makes about masking having one set of declarations.
 */
export function emailVerifiedFilter(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return value === 'true';
}

/**
 * How many referred clients a PROFILE shows.
 *
 * A profile is not a client list. An IB with 4,000 referrals would otherwise
 * turn one screen into an unpaginated dump of 4,000 names and emails, so the
 * list is capped and the screen links to the filtered client index for the
 * rest — which is the tool built for that question.
 */
/** Every document filename a submission references, in one place. */
function documentFilenames(submission: KycSubmission | undefined): string[] {
  if (!submission) return [];
  return [
    submission.document?.frontFilePath,
    submission.document?.backFilePath,
    submission.selfie?.filePath,
    submission.addressProof?.filePath,
    submission.addressProof?.page2FilePath,
  ]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => p.split('/').pop() as string);
}
import type { ClientScope } from '../../common/security/client-scope';
import { AdminHoldingsService } from './admin-holdings.service';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/**
 * How many referred clients the profile carries — one screen's worth.
 *
 * ⚠️ THIS DOCBLOCK MADE TWO CLAIMS AND BOTH WERE FALSE UNTIL 11 Sep 2026. It
 * said the response "says how many came (`referredShown`) so the UI can tell
 * 'all of them' from 'the newest 50'", and that "the full book stays reachable
 * through the client list filtered by referrer".
 *
 *   `referredShown` was `referredClients.length` and NOTHING READ IT — and it
 *   could not have done the job anyway, because the cap 50 is published
 *   nowhere in the contract, so `referredShown: 50` cannot be told from a
 *   partner with exactly fifty. `referredTotal` is the missing half.
 *
 *   The referrer filter DID NOT EXIST. `findPage` took nine filters and none of
 *   them was a referrer, so the "full book" was reachable nowhere in the admin
 *   console: fifty names, no cap notice, and no route to the rest.
 *
 * Both are true now — `referredTotal` from SQL, and `?referredBy=` on the list.
 * Recorded rather than quietly corrected, because a cap justified by an escape
 * hatch that does not exist is a different thing from a cap.
 */
const REFERRED_CLIENTS_SHOWN = 50;

/**
 * Shape-check only — whether such a client EXISTS is answered by the empty
 * result, never by a different status code. A 404-style "no such partner" here
 * would be an oracle over the client base, which is the same reason
 * `client-scope.ts` returns 404 rather than 403 for an out-of-scope client.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    private readonly tags: ClientTagsStore,
    private readonly kyc: KycStore,
    private readonly holdings: AdminHoldingsService,
    private readonly audit: AdminAuditService,
    /*
     * `EmailModule` and `SecurityModule` are both @Global, so these resolve
     * without AdminModule importing anything. Both exist for ONE method,
     * `changeClientEmail`, and both are part of what makes it safe rather
     * than decoration.
     */
    private readonly email: EmailService,
    private readonly refreshTokens: RefreshTokensService,
    /*
     * For the Network sections of the profile: the introducer's partner row
     * (active flag) and, when the client IS a partner, nothing — their
     * downline is read from `users` by attribution. @Global StoreModule.
     */
    private readonly ib: IbStore,
  ) {}

  // ─── Clients list (ADM-01 / ADM-14) ───────────────────────────────────────
  async listClients(
    query: {
      page?: string;
      limit?: string;
      cursor?: string;
      withTotal?: string;
      q?: string;
      type?: string;
      status?: string;
      level?: string;
      country?: string;
      emailVerified?: string;
      kycStatus?: string;
      tag?: string;
      referredBy?: string;
      sort?: string;
      order?: string;
    },
    actor: AuthenticatedAdmin,
  ) {
    /*
     * Asserted HERE as well as in the guard — R-4.3.
     *
     * This method now decides WHICH ROWS and WHICH FIELDS the caller gets, from
     * the actor, so it is making an authorization decision rather than merely
     * receiving one. The guard is a fast reject at the edge; a future export
     * job or scheduled report calling this directly has no guard at all, and
     * "trusted because internal" is how scoping quietly stops applying.
     */
    assertActorCan(actor, 'clients.view', 'list clients');

    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = pageSize(query.limit);

    // An unparseable ?level= used to become NaN and silently return nothing.
    let level: number | undefined;
    if (query.level !== undefined && query.level !== '') {
      const parsed = Number(query.level);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1) {
        throw new ValidationError('level must be 0 or 1.');
      }
      level = parsed;
    }

    /*
     * Cursor first, offset for one more release — R-2.4 / R-8.2.
     *
     * ADM-01 targets ~219,000 records, where offset paging is not merely slow
     * but WRONG: a client registering while an admin reads page 3 shifts every
     * later page, and one client is never seen — silently, since the reviewer
     * believes they looked at everyone.
     *
     * `page` still works so both frontends can move at their own pace. It is the
     * path to delete, not the one to extend.
     */
    /*
     * The sort is validated BEFORE the cursor is decoded, and the order matters.
     *
     * `decodeCursor` refuses a cursor minted under a different ordering, and it
     * needs the current sort key to say which. Decoding first would produce
     * "this cursor is for createdAt but you asked for undefined", which is true
     * and useless.
     */
    const sort = clientSortKey(query.sort);
    const order = clientSortOrder(query.order);

    /*
     * An unknown tag slug is a 400, NOT an empty page.
     *
     * R-2.5: a silently ignored filter is a lie the UI tells. A typo'd segment
     * returning zero clients reads as "nobody is in this segment", which is a
     * statement about the client base rather than about the URL.
     */
    if (query.tag) {
      const tag = await this.tags.findBySlug(query.tag);
      if (!tag) {
        throw new ValidationError(
          `There is no client tag "${query.tag}". Check the tag list for the current names.`,
        );
      }
    }

    /*
     * ⚠️ A MALFORMED referredBy is REFUSED, never ignored, and that is the
     * whole reason it is validated here rather than passed through.
     *
     * These twenty-five query parameters are individual `@Query('name')`
     * bindings rather than a DTO, so `forbidNonWhitelisted` has nothing to
     * reflect on: an unrecognised KEY is silently dropped by Express and the
     * caller gets the UNFILTERED list. Measured on the wire — `?directoin=` on
     * the transactions desk returns the full 130 rows where the intended filter
     * returns 12.
     *
     * That is a platform-wide shape (176 such bindings across twenty
     * controllers) and not this change's to fix. What IS this change's job is
     * not adding another one: a filter that silently does nothing is what would
     * put "Showing only the clients introduced by this partner" over every
     * client in the system. So a value that cannot be a user id fails loudly
     * instead.
     */
    let referredBy: string | undefined;
    if (query.referredBy !== undefined && query.referredBy !== '') {
      if (!UUID_RE.test(query.referredBy)) {
        throw new ValidationError('referredBy must be a client id.');
      }
      referredBy = query.referredBy;
    }

    const { rows, total } = await this.users.findPage({
      page,
      limit,
      cursor: query.cursor ? decodeCursor(query.cursor, sort) : undefined,
      // Counting is a full scan of the filtered set. Requested explicitly, or
      // implied by the legacy offset caller, which renders a page count.
      withTotal: query.withTotal === 'true' || (!query.cursor && query.page !== undefined),
      q: query.q?.trim() || undefined,
      type: query.type,
      status: query.status,
      level,
      country: query.country?.trim() || undefined,
      emailVerified: emailVerifiedFilter(query.emailVerified),
      kycStatus: kycStatusFilter(query.kycStatus),
      tagSlug: query.tag,
      referredBy,
      sort,
      order,
      // Row-level visibility, applied in the WHERE clause. An out-of-scope
      // client is not filtered out of the result — it never enters it.
      scope: actor.clientScope,
    });

    const paged = buildCursorPage(rows, limit, total, sort);

    // Tags for the whole page in ONE query — never per row. 25 extra round
    // trips per keystroke of the search box is the N+1 ARCHITECTURE §5 names.
    const tagsByClient = await this.tags.tagsForClients(paged.items.map((r) => r.id));
    const withTags = paged.items.map((row) => ({
      ...row,
      tags: tagsByClient.get(row.id) ?? [],
    }));

    return {
      ...paged,
      /*
       * Masking is applied HERE, at the last point before the rows become a
       * response, and `maskedFields` travels beside them.
       *
       * The two halves are inseparable: stripping the values without saying so
       * makes a hidden email indistinguishable from a client who has none, and
       * saying so without stripping is a UI convention rather than access
       * control (R-4.1 — the backend enforces, the frontend only hides).
       */
      items: withTags,
      maskedFields: maskedFieldsFor('client', actor.fieldMask),
      page,
      limit,
      total: paged.total ?? rows.length,
    };
  }
  // ─── Client profile (ADM-01) ──────────────────────────────────────────────
  /**
   * FR-ADM-01's full client profile: KYC status, documents, trading accounts
   * and referral relationships, on one screen.
   *
   * Rev 9 deferred this and DECISIONS D-20 recorded the deferral as resolved;
   * it is built here on an explicit reversal, because the FSD's acceptance
   * criterion for ADM-01 is literally "an administrator searches the client
   * base and opens a full client profile". Noted rather than left to be
   * rediscovered as an inconsistency.
   *
   * ── Every section is permission-gated INDIVIDUALLY ──────────────────────────
   *
   * And an omitted section is not the same as an empty one. A compliance
   * reviewer shown no documents concludes none were uploaded; the response has
   * to let the screen say "hidden by your permissions" instead, which it can
   * only do if the two states arrive differently. So a section the caller may
   * not see is ABSENT, and a section they may see with nothing in it is an
   * empty array.
   *
   * The sections are fetched CONCURRENTLY rather than in sequence: they are
   * independent reads on one screen, and doing them one after another turns a
   * profile open into five round trips of latency for no benefit.
   */
  async getClientProfile(clientId: string, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'clients.view', 'open a client profile');

    // The scoped lookup, first. An out-of-scope client 404s exactly as a
    // missing one does — a 403 here would confirm the id names a real client.
    const client = await this.users.findForAdmin(clientId, actor.clientScope);
    if (!client) throw new ClientNotFoundError();

    const may = (permission: string) => actorHasPermission(actor, permission);

    /*
     * Trading accounts were assembled here too once, from `ClientProfileStore`;
     * they went with the teardown and return with the bridge. The REFERRAL pair
     * went with the same teardown — and then stayed gone by accident: the DTO
     * kept promising `referrer`/`referredClients`, nothing here assigned them,
     * and the admin's Network tab said "Not introduced by a partner" about
     * every client, including the ones whose Referral badge (derived from the
     * same column!) proved otherwise. Assembled again below, from
     * `users.referred_by_ib_user_id` — the attribution the old
     * `referral_attributions` table was replaced by in 0032.
     */
    const canSeeNetwork = may('ib.view');
    const [tags, kyc, referrer, referredClients, referredTotal, trading] = await Promise.all([
      this.tags.tagsForClient(clientId),
      may('kyc.view') || may('kyc.review') ? this.kyc.findByUserId(clientId) : undefined,
      canSeeNetwork ? this.referrerOf(client, actor.clientScope) : undefined,
      canSeeNetwork ? this.referredClientsOf(clientId, actor.clientScope) : undefined,
      /*
       * The TOTAL, from SQL, under the same `ib.view` gate and the same scope.
       *
       * `referredShown` is `referredClients.length` — the size of what fitted —
       * and on its own it cannot say "50 of 213" because the cap is published
       * nowhere in the contract. `IbOverviewDto` already says this in capitals
       * about its own capped array: "Read referredClientCount for how many
       * there actually are — NEVER this array's length". The admin profile did
       * the forbidden thing one module away, and `countReferredBy` — written
       * for exactly this and used by the partner detail — went uncalled here.
       */
      canSeeNetwork ? this.users.countReferredBy(clientId, actor.clientScope) : undefined,
      /*
       * ABSENT without `trading.view`, an empty array with it — the same rule
       * the Network sections below follow, for the same reason. The card can
       * then say "hidden by your permissions" rather than "no accounts", which
       * are opposite facts about a client who may hold three.
       *
       * This section was DECLARED on the response and populated by nothing, so
       * every profile reported no trading accounts — the same wrong answer the
       * portal's own accounts page once gave, on the console this time, and to
       * the reader most likely to act on it.
       */
      may('trading.view')
        ? this.holdings.accountsForProfile(clientId, actor.clientScope)
        : undefined,
    ]);

    const profile = {
      id: client.id,
      email: client.email,
      firstName: client.firstName,
      lastName: client.lastName,
      type: client.type,
      status: client.status,
      verificationLevel: client.verificationLevel,
      emailVerified: client.emailVerified,
      country: client.country,
      phone: client.phone,
      createdAt: client.createdAt,
      tags,
      ...(kyc === undefined
        ? {}
        : {
            kyc: {
              status: kyc?.status ?? 'not_started',
              submittedAt: kyc?.submittedAt,
              reviewedAt: kyc?.reviewedAt,
              rejectionReason: kyc?.rejectionReason,
              documentCount: documentFilenames(kyc).length,
            },
          }),
      /*
       * Document FILENAMES, never bytes and never a signed link.
       *
       * Each one is fetched through `GET /uploads/kyc/:file`, which applies the
       * client scope, checks the reader and writes the R-6.6 audit row. Putting
       * the images in this response would route an audited PII read around its
       * own audit — "which admin viewed this passport" would answer "nobody",
       * because opening the profile is not viewing a document.
       */
      ...(may('kyc.documents.view') && kyc !== undefined
        ? { documents: documentFilenames(kyc) }
        : {}),
      ...(trading === undefined ? {} : { tradingAccounts: trading }),
      /*
       * The Network sections, absent without ib.view — the same key the screen
       * gates its whole tab on. `referrer` is additionally absent when nobody
       * introduced this client, which the UI renders as its own message;
       * `referredClients` when permitted is ALWAYS an array, because "may see,
       * has none" must not look like "may not see" (the rule above).
       */
      ...(referrer ? { referrer } : {}),
      ...(referredClients !== undefined
        ? { referredClients, referredShown: referredClients.length, referredTotal }
        : {}),
    };

    /*
     * Masking last, over the assembled object.
     *
     * After the sections rather than before, so a masked field cannot survive
     * inside one of them — `client.email` hides the top-level email AND, via
     * its catalog aliases, the same value wherever else it was copied.
     */
    return {
      ...profile,
      maskedFields: maskedFieldsFor('client', actor.fieldMask),
    };
  }

  /**
   * Who introduced this client, shaped for `ProfileReferrerDto`.
   *
   * Undefined when nobody did — the ordinary case.
   *
   * ## Territory, without the false sentence
   *
   * This was UNSCOPED, and the recorded argument was that hiding the introducer
   * would render "not introduced by a partner", which is exactly the bug the
   * card was added to fix. True — but it treated "show everything" and "show
   * nothing" as the only options, and this codebase had already found the third
   * one for the IB partner parent: say that an introducer EXISTS and withhold
   * who they are (`parentOutsideTerritory`).
   *
   * So the existence of the attribution is still told truthfully to every
   * reader, and the introducer's email and name are told only to a reader whose
   * territory covers them. The field mask never covered this: masking hides
   * COLUMNS by role, scope hides ROWS by territory, and a scoped-desk admin
   * holding every field permission was shown an out-of-territory person in full.
   *
   * `active` is the partner row's flag (a suspended partner still introduced
   * them; the screen labels it), and `since` is the CLIENT's registration —
   * attribution is written once at register and never re-pointed.
   */
  private async referrerOf(client: User, scope: ClientScope) {
    if (!client.referredByIbUserId) return undefined;
    const [introducer, account] = await Promise.all([
      this.users.findByIdInScope(client.referredByIbUserId, scope),
      this.ib.findAccount(client.referredByIbUserId),
    ]);
    /*
     * In scope returns nothing but the attribution column says someone did
     * introduce them: the introducer is real and outside this reader's
     * territory. Told as a fact, with no identity attached.
     */
    if (!introducer && account) {
      return {
        ibUserId: client.referredByIbUserId,
        active: account.active,
        since: client.createdAt,
        outsideTerritory: true,
      };
    }
    // Unreachable while the users→ib_accounts FK stands; refusing to fabricate
    // a half-empty card is still better than trusting that forever.
    if (!introducer || !account) return undefined;
    return {
      ibUserId: introducer.id,
      email: introducer.email,
      firstName: introducer.firstName,
      lastName: introducer.lastName,
      active: account.active,
      since: client.createdAt,
      outsideTerritory: false,
    };
  }

  /**
   * The client's downline, shaped for `ProfileReferredClientDto`.
   *
   * SCOPED since 11 Sep 2026. Masking hides FIELDS by role; scope hides ROWS by
   * territory, and this list is rows — each one a client. See the block above
   * `countReferredBy` for why the previous "unscoped by design" was answered
   * rather than merely overruled.
   */
  private async referredClientsOf(clientId: string, scope: ClientScope) {
    const clients = await this.users.listReferredBy(clientId, REFERRED_CLIENTS_SHOWN, scope);
    return clients.map((referred) => ({
      clientUserId: referred.id,
      email: referred.email,
      firstName: referred.firstName,
      lastName: referred.lastName,
      active: referred.status === 'active',
      since: referred.createdAt,
    }));
  }

  // ─── Client suspension (clients.suspend) ────────────────────────────────────
  /**
   * Correct a client's profile — CORE-18's admin half.
   *
   * ## What this deliberately cannot do
   *
   * Not the email: that is `changeClientEmail` below, behind its own permission,
   * for reasons written out there. Not `status`: suspension is its own action
   * with its own key because it cuts off access. Not `verificationLevel` or
   * `type`: those are conclusions the KYC and partner flows reach from evidence,
   * and an endpoint that lets an operator type the answer directly is a way to
   * mark a client verified without anyone having looked at a document.
   *
   * What is left is exactly the clerical set — the name, phone and country a
   * client gave at registration and a support desk fixes when they were typed
   * wrong. That is the whole intended job.
   */
  async updateClientProfile(
    userId: string,
    patch: { firstName?: string; lastName?: string; phone?: string; country?: string },
    actor: AuthenticatedAdmin,
  ) {
    assertActorCan(actor, 'clients.edit', "edit a client's profile");

    // Scoped: an out-of-scope client is 404, never 403 — see `setClientStatus`
    // for why a 403 here would be an enumeration oracle.
    const user = await this.users.findForAdmin(userId, actor.clientScope);
    if (!user) throw new ClientNotFoundError();

    /*
     * A blank string CLEARS an optional field; it is not a value.
     *
     * "No phone number on file" and "the phone number is the empty string" read
     * identically on a screen and behave differently in a search, an export and
     * a `WHERE phone IS NOT NULL`. Normalising here keeps that distinction from
     * depending on which form posted the row.
     */
    const blankToNull = (value: string | undefined) =>
      value === undefined ? undefined : value.trim() === '' ? null : value.trim();

    const changes: Record<string, unknown> = {};
    if (patch.firstName !== undefined) changes.firstName = patch.firstName.trim();
    if (patch.lastName !== undefined) changes.lastName = patch.lastName.trim();
    if (patch.phone !== undefined) changes.phone = blankToNull(patch.phone);
    if (patch.country !== undefined) changes.country = blankToNull(patch.country);

    if (Object.keys(changes).length === 0) {
      throw new ValidationError('Name a field to change.');
    }

    /*
     * Only what ACTUALLY moved reaches the audit row.
     *
     * A form that posts every field on every save would otherwise record four
     * changes each time somebody fixes one, and the log's whole value is being
     * able to ask "what did this administrator change" and get a short answer.
     */
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(changes)) {
      const current = (user as unknown as Record<string, unknown>)[key] ?? null;
      if (current !== value) {
        before[key] = current;
        after[key] = value;
      }
    }

    if (Object.keys(after).length === 0) {
      // Nothing moved. Not an error — a double-submitted form reaches here — and
      // an audit row saying nothing changed is noise in the log that matters.
      return this.profileView(user, actor);
    }

    const updated = (await this.users.update(userId, changes))!;

    this.audit.record(actor.id, 'client.profile_update', 'user', userId, {
      /*
       * The client's address is NOT recorded here, and its absence is the point.
       *
       * `subject_id` on this row IS the client, and `before`/`after` carry the
       * change itself, so the address was pure denormalised context — it made
       * the row no more answerable and put client PII into the one store this
       * system cannot mask. `audit_log.details` is free-form jsonb with no
       * declared shape, so neither `applyMask` nor the response interceptor can
       * reach inside it: an administrator whose role hides `client.email` read
       * addresses straight off the audit screen.
       *
       * `client.email_change` still records both addresses, and must — there
       * the addresses ARE the change, and a record of an email change that does
       * not say which emails is not a record of anything.
       */
      before,
      after,
    });

    return this.profileView(updated, actor);
  }

  /**
   * Change the address a client signs in with.
   *
   * ## THIS IS THE ACCOUNT-TAKEOVER PRIMITIVE, and everything here is about that
   *
   * Point a client's email at your own inbox, request a password reset, and the
   * account — with whatever balance it holds and whatever withdrawal it can
   * request — is yours. No other operation on the admin surface does that. Four
   * controls exist because of it, and none is optional:
   *
   *   1. Its OWN permission (`clients.email`), so the desk role that fixes
   *      misspelled surnames does not carry this by accident.
   *   2. Sessions are revoked, so whoever was signed in as this client stops
   *      being signed in as this client.
   *   3. Verification is RESET, so the new address must prove itself before the
   *      account is treated as reachable again.
   *   4. The PREVIOUS address is told — the one mailbox an attacker taking the
   *      account over no longer controls. It is the only control here that
   *      points outward, at the person who would actually notice.
   *
   * ## Order: validate, revoke, write
   *
   * Revocation happens BEFORE the update and after every validation that can
   * refuse, because of the direction the failures fall in. A revoke that
   * succeeds before a write that fails logs the client out of a session they can
   * re-establish; a write that succeeds before a revoke that fails leaves the
   * old holder with a live session on an account that is no longer theirs. The
   * first is an inconvenience, the second is the hole this method closes.
   *
   * Access tokens already minted are NOT killed by this — they are short-lived
   * JWTs and expire on their own. What revocation guarantees is that none of
   * them can be refreshed into a new one.
   */
  async changeClientEmail(userId: string, rawEmail: string, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'clients.email', "change a client's sign-in email");

    const user = await this.users.findForAdmin(userId, actor.clientScope);
    if (!user) throw new ClientNotFoundError();

    // The DTO lower-cases and trims; doing it again means the rule holds for any
    // caller, not only one that arrived through validation.
    const email = rawEmail.trim().toLowerCase();

    if (email === user.email.toLowerCase()) {
      throw new ValidationError("That is already this client's sign-in email.");
    }

    /*
     * Checked rather than left to the unique index.
     *
     * `users.email` is UNIQUE, so the collision is caught either way — but as a
     * 23505 it surfaces as a 500 naming a constraint, and the operator retries
     * the same thing. This says which of the two it is.
     */
    const taken = await this.users.findByEmail(email);
    if (taken) {
      throw new ValidationError('Another account already uses that email address.');
    }

    const previousEmail = user.email;

    // Before the write — see the order note above.
    await this.refreshTokens.revokeAllForSubject('portal', userId);

    const token = randomUUID();
    const updated = (await this.users.update(userId, {
      email,
      /*
       * Back to unverified, because nobody has proved this mailbox exists. A
       * client carried across as verified would keep passing
       * `EmailVerifiedGuard` on an address that may be a typo — and the first
       * thing they would not receive is the mail telling them so.
       */
      emailVerified: false,
      emailVerificationTokenHash: hashEmailedToken(token),
      emailVerificationExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000),
      /*
       * Cleared with the rest of the cycle. If this client had already verified
       * their PREVIOUS address, the row still carries that redemption — and a
       * link to the NEW address whose row says "redeemed" would be answered
       * `already_verified` on its first click, verifying nothing while telling
       * the client it had. See the column comment in schema.ts.
       */
      emailVerificationConsumedAt: undefined,
    }))!;

    this.audit.record(actor.id, 'client.email_change', 'user', userId, {
      before: previousEmail,
      after: email,
      sessionsRevoked: true,
    });

    /*
     * After the commit, and neither can fail the operation — `EmailService` logs
     * and swallows by contract. The change has already happened; a mail outage
     * must not leave the account half-changed, and the audit row is the durable
     * record either way.
     */
    await this.email.sendVerificationEmail(email, token);
    await this.email.sendEmailChangedNotice(previousEmail, email);

    return this.profileView(updated, actor);
  }

  /**
   * The shape both edit endpoints answer with, matching `setClientStatus`.
   *
   * ## It is MASKED, like every other read of a client
   *
   * `email`, `phone` and `country` are all `maskable: true` in
   * `config/client-fields.json`, and `getClientProfile` strips them for an
   * actor whose role hides them (RBAC-03: a masked field is ABSENT from the
   * JSON, never merely hidden by the UI). This response returned them raw,
   * which made a PATCH an oracle for the very fields the mask exists to
   * withhold — an admin holding `clients.edit` could edit any harmless field
   * and read the phone number back out of the 200.
   *
   * `maskedFields` rides along for the same reason it does on the profile read:
   * the console must be able to say "hidden by your permissions" rather than
   * render an empty box that reads as "this client has no phone number".
   */
  private profileView(
    user: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      type: string;
      status: string;
      verificationLevel: number;
      emailVerified: boolean;
      country?: string | null;
      phone?: string | null;
      createdAt: Date;
    },
    actor: AuthenticatedAdmin,
  ) {
    const view = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      type: user.type,
      status: user.status,
      verificationLevel: user.verificationLevel,
      emailVerified: user.emailVerified,
      country: user.country ?? null,
      phone: user.phone ?? null,
      createdAt: user.createdAt,
    };
    return {
      ...view,
      maskedFields: maskedFieldsFor('client', actor.fieldMask),
    };
  }

  /**
   * Record the partner who introduced a client, WHEN NONE IS RECORDED.
   *
   * ## The defect this exists for
   *
   * Attribution is captured in exactly one place — `?ref=` on the registration
   * screen — and both of the portal's auth cross-links dropped it. A client
   * followed a partner's link, saw "Referred by PARTNER01", clicked Sign in,
   * found they had no account, clicked Create an account, and registered
   * attributed to NOBODY. The banner vanished and nothing recorded that a
   * partner had just lost a client.
   *
   * The links carry `ref` now. This is for the clients already lost, because
   * `referred_by_ib_user_id` was written at registration and nowhere else: no
   * update route, no service method, no admin path. Permanent, silently.
   *
   * ## ⚠️ NULL → A ONLY. A → B IS REFUSED HERE, NOT IN A SCREEN
   *
   * `docs/` forbids a change-my-IB flow and is right — re-pointing attribution
   * moves a partner's client and their future commissions to somebody else.
   * Filling an EMPTY attribution takes nothing from anybody: the client was
   * referred, we lost it, and the loss was our defect.
   *
   * The refusal is in this method rather than in a rendering condition, because
   * "only show the control when `referrer` is absent" is a decision somebody
   * relaxes in six months without knowing they have built the thing the docs
   * forbid.
   *
   * ## What it pays, which is the first question support will ask
   *
   * `commission.service.ts` reads `users.referred_by_ib_user_id` AT ACCRUAL
   * TIME, per deal. So this pays the partner on deals not yet accrued and
   * touches nothing already credited — an accrual carries its earner. It does
   * not backdate and it cannot restate anything somebody has been paid.
   *
   * ## Three refusals, three codes
   *
   * They need three sentences: a typo the operator can fix, a mistake they
   * should see named, and "the code was RIGHT and that partner is suspended",
   * which is somebody else's decision and a different conversation.
   */
  async setClientReferrer(userId: string, referralCode: string, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'clients.referrer.set', 'record a referring partner');
    // Scoped first: an out-of-scope client 404s exactly as a missing one, so
    // nothing about the response says they exist.
    const client = await this.users.findForAdmin(userId, actor.clientScope);
    if (!client) throw new ClientNotFoundError();

    if (client.referredByIbUserId) {
      throw new ReferrerAlreadySetError(
        'This client already has a referring partner. Attribution is recorded once and is ' +
          'not re-pointed — changing it would move their future commissions to somebody else.',
      );
    }

    // Trimmed and upper-cased exactly as registration resolves it, so a code
    // that worked on a link works here.
    const code = referralCode.trim().toUpperCase();
    const account = await this.ib.findAccountByReferralCode(code);
    if (!account) {
      throw new ReferralCodeUnknownError(`No partner holds the referral code ${code}.`);
    }
    if (account.userId === userId) {
      throw new ReferralSelfError(
        'That is this client\u2019s own referral code. A client cannot introduce themselves, ' +
          'and the commission chain would walk a self-edge.',
      );
    }
    if (!account.active) {
      throw new ReferralPartnerInactiveError(
        `The code ${code} is correct and that partner is SUSPENDED, so attribution cannot be ` +
          'recorded to them. This is not a problem with the code the client gave you.',
      );
    }

    const updated = (await this.users.update(userId, { referredByIbUserId: account.userId }))!;

    /*
     * `before` is always null here — that is what the 409 above guarantees — and
     * it is recorded anyway. An audit row that omits the prior value on the
     * grounds that it is known cannot be read back as evidence of what it was,
     * and "it was empty" is the whole justification for this write being
     * allowed at all.
     */
    this.audit.record(actor.id, 'client.referrer_set', 'user', userId, {
      before: null,
      after: account.userId,
      referralCode: code,
    });

    return updated;
  }

  async setClientStatus(userId: string, status: 'active' | 'suspended', actor: AuthenticatedAdmin) {
    // Suspension kills live sessions and blocks login — a real privilege.
    assertActorCan(actor, 'clients.suspend', 'suspend or reactivate a client');
    // Scoped lookup: an out-of-scope client is 404, never 403. A 403 here would
    // confirm the id exists, turning this endpoint into an oracle for
    // enumerating clients the actor was specifically denied.
    const user = await this.users.findForAdmin(userId, actor.clientScope);
    if (!user) throw new ClientNotFoundError();
    if (user.status === status) {
      throw new ValidationError(`Client is already ${status}.`);
    }

    const updated = (await this.users.update(userId, { status }))!;
    // Suspension bites immediately: the JWT strategy re-checks status on every
    // request, and login/refresh refuse suspended accounts.
    /*
     * And it ends the SESSIONS, which the status check alone does not.
     *
     * The strategy reads `users.status`, so the moment somebody reactivates the
     * account the old cookies work again — a session nobody signed in resumes on
     * its own. That is the whole reason the admin path revokes
     * (`admin-rbac.service.ts`, "what stops their cookies quietly resuming").
     *
     * This path only CLAIMED to. Two comments asserted it — the one above
     * `assertActorCan` here, and the belt-and-braces note in `auth.service.ts`
     * — while nothing revoked anything, so both were false for every reader who
     * checked the behaviour by reading. The email-change path three hundred
     * lines up had the call all along, which is what made the omission look
     * deliberate rather than missed.
     */
    const sessionsRevoked =
      status === 'suspended' ? await this.refreshTokens.revokeAllForSubject('portal', userId) : 0;
    this.audit.record(
      actor.id,
      status === 'suspended' ? 'client.suspend' : 'client.activate',
      'user',
      userId,
      {
        // Same reasoning as `client.profile_update` above: the subject id is the
        // client, the status is the change, and the address only spread PII into
        // a store nothing can mask.
        before: user.status,
        after: status,
        // Recorded like the admin path records it: "we took their access away"
        // is a different statement from "we changed a column", and the count is
        // what tells the two apart months later.
        ...(status === 'suspended' ? { sessionsRevoked } : {}),
      },
    );

    // Through the mask like every other client read. This built its own
    // object and skipped it, so an admin whose role hid `client.email` could
    // read the address out of the 200 by suspending and reactivating.
    const view = {
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
    return {
      ...view,
      maskedFields: maskedFieldsFor('client', actor.fieldMask),
    };
  }
}
