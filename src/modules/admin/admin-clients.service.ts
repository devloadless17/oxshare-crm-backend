import { Injectable } from '@nestjs/common';
import { UsersStore, clientSortKey, clientSortOrder } from '../../store/users.store';
import { ClientTagsStore } from '../../store/client-tags.store';
import { ClientNotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { buildCursorPage, decodeCursor, pageSize } from '../../common/pagination';
import { AdminAuditService } from './admin-audit.service';
import { assertActorCan } from '../../common/security/actor';
import { applyMask, applyMaskAll, maskedFieldsFor } from '../../common/security/field-mask';
import { KycStore, type KycSubmission } from '../../store/kyc.store';
import { actorHasPermission } from '../../common/security/actor';
import { EmailService } from '../email/email.service';
import { RefreshTokensService } from '../../common/security/refresh-tokens.service';
import { randomUUID } from 'crypto';

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
function kycStatusFilter(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(KYC_STATUSES as readonly string[]).includes(value)) {
    throw new ValidationError(
      `Cannot filter by kycStatus "${value}". Allowed: ${KYC_STATUSES.join(', ')}.`,
    );
  }
  return value;
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
import type { AuthenticatedAdmin } from './guards/admin.guard';

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
    private readonly audit: AdminAuditService,
    /*
     * `EmailModule` and `SecurityModule` are both @Global, so these resolve
     * without AdminModule importing anything. Both exist for ONE method,
     * `changeClientEmail`, and both are part of what makes it safe rather
     * than decoration.
     */
    private readonly email: EmailService,
    private readonly refreshTokens: RefreshTokensService,
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
      /*
       * A tri-state, not a boolean: absent means "do not filter", which is a
       * different request from `emailVerified=false`. `=== 'true'` alone would
       * collapse the two and make an unfiltered list silently show only
       * unverified clients.
       */
      emailVerified:
        query.emailVerified === undefined || query.emailVerified === ''
          ? undefined
          : query.emailVerified === 'true',
      kycStatus: kycStatusFilter(query.kycStatus),
      tagSlug: query.tag,
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
      items: applyMaskAll('client', withTags, actor.fieldMask),
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
     * Trading accounts and referral relationships were assembled here too, from
     * `ClientProfileStore`. Both went with the teardown: trading accounts had no
     * table left, and the referral pair belonged to the old IB model. The
     * rebuilt IB feature will put the partner relationship back on this profile
     * — deliberately, rather than by restoring the old shape.
     */
    const [tags, kyc] = await Promise.all([
      this.tags.tagsForClient(clientId),
      may('kyc.view') || may('kyc.review') ? this.kyc.findByUserId(clientId) : undefined,
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
    };

    /*
     * Masking last, over the assembled object.
     *
     * After the sections rather than before, so a masked field cannot survive
     * inside one of them — `client.email` hides the top-level email AND, via
     * its catalog aliases, the same value wherever else it was copied.
     */
    return {
      ...applyMask('client', profile, actor.fieldMask),
      maskedFields: maskedFieldsFor('client', actor.fieldMask),
    };
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
      email: user.email,
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
      emailVerificationToken: token,
      emailVerificationExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000),
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
      ...applyMask('client', view, actor.fieldMask),
      maskedFields: maskedFieldsFor('client', actor.fieldMask),
    };
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
