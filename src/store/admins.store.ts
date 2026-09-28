import { and, count, desc, eq, gt, notExists, sql, type SQLWrapper, inArray } from 'drizzle-orm';
import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { adminClientTagScopes, adminInvites, admins } from '../database/schema';
import { orderTerms, type SortOrder } from '../common/sorting';

/**
 * SHA-256 of an invite token, hex — the same treatment reset tokens get.
 *
 * The token is a bearer credential that CREATES AN ADMIN ACCOUNT, and it used to
 * be stored verbatim: a database dump, a leaked backup or a read-only injection
 * handed over working links to a system that approves payouts. A fast digest is
 * the right tool (the token is 122 bits of randomness, so there is no guessable
 * secret for a slow KDF to protect) and it is what `users.password_reset_token_hash`
 * already uses.
 *
 * Lives here rather than in the service because the STORE is what owns the
 * column: every lookup path has to hash, and one that forgets would silently
 * never match.
 */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The columns the administrator directory may be ordered by — R-2.5.
 *
 * `permissions` and `maskedFields` are deliberately absent: both are `jsonb`
 * arrays, and "sort by a list" has no meaning a reader would agree on.
 * `pagination.ts` refuses a non-scalar cursor value for the same reason.
 */
export const ADMIN_SORT_COLUMNS = {
  name: admins.name,
  email: admins.email,
  role: admins.role,
  status: admins.status,
  createdAt: admins.createdAt,
} as const;

export type AdminSortKey = keyof typeof ADMIN_SORT_COLUMNS;

/**
 * Alphabetical, ASCENDING — and unlike every other list here, that is the point.
 *
 * The queues default to `createdAt desc` because their job is "what arrived
 * most recently". A directory's job is "find this person", and the order you
 * look somebody up in is by name, upwards. This is also the ordering the screen
 * already implied it had while the query had none at all.
 */
export const DEFAULT_ADMIN_SORT: AdminSortKey = 'name';
export const DEFAULT_ADMIN_ORDER: SortOrder = 'asc';

export type AdminRole = 'master_admin' | 'sub_admin';
/** Mirrors `user_status`; only these two are meaningful for an admin. */
export type AdminStatus = 'active' | 'suspended';

export interface Admin {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: AdminRole;
  permissions: string[];
  /** RBAC role the permissions were derived from, when assigned via a role. */
  roleId?: string;
  /** 'active' | 'suspended' — a suspended admin cannot sign in or use a session. */
  status: AdminStatus;
  /**
   * RBAC-03 per-person OVERRIDE of the role's field mask.
   *
   * `undefined` means "inherit the role", which is the common case and the
   * reason the column is nullable. An array — including an empty one — is this
   * person's own answer. See `RolesStore.resolveMaskedFields`.
   */
  maskedFields?: string[];
  /** D-60 — sees the intake pool: clients with no tag assignments yet. */
  seesUntriaged?: boolean;
  /** Sees every client — the explicit grant (0154). See `scopeOf`. */
  seesAllClients?: boolean;
  /**
   * The cutoff that invalidates access tokens issued before it.
   *
   * `undefined` means no cutoff — every account predating the column, and the
   * reason adding it did not sign the back office out. See the guard.
   */
  passwordChangedAt?: Date;
  /** Stored FILENAME of the profile photo, never a URL. See the schema. */
  avatarFilename?: string;
  createdAt: Date;
}

export interface AdminInvite {
  id: string;
  email: string;
  name: string;
  /** SHA-256 of the emailed token. The token itself is never stored. */
  tokenHash: string;
  role: 'sub_admin';
  /** Role/permissions chosen by the inviting master admin (RBAC-07). */
  roleId?: string;
  permissions?: string[];
  /*
   * Territory and masking, chosen at invite time and applied on acceptance.
   *
   * Both columns existed and were written by nothing and read by nothing. An
   * empty scope means UNRESTRICTED, so without these an invited sub-admin saw
   * every client in the system between clicking the link and being configured —
   * see the schema.ts comment on `scoped_tag_ids`.
   */
  maskedFields?: string[];
  scopedTagIds?: string[];
  /** D-60 — intake grant chosen at invite time, applied on acceptance. */
  seesUntriaged?: boolean;
  /** All-clients grant chosen at invite time, applied on acceptance (0154). */
  seesAllClients?: boolean;
  invitedBy: string;
  expiresAt: Date;
  accepted: boolean;
  createdAt: Date;
}

type AdminRow = typeof admins.$inferSelect;
type InviteRow = typeof adminInvites.$inferSelect;

const toAdmin = (r: AdminRow): Admin => ({
  ...r,
  roleId: r.roleId ?? undefined,
  status: r.status === 'suspended' ? 'suspended' : 'active',
  // null → undefined, so "inherit the role" is one value throughout the code
  // rather than two that every caller has to check for.
  maskedFields: r.maskedFields ?? undefined,
  // Same null → undefined normalisation, for the same reason: a nullable column
  // reaching the domain as `null` gives every call site two empty values to
  // handle and one of them eventually gets missed.
  passwordChangedAt: r.passwordChangedAt ?? undefined,
  avatarFilename: r.avatarFilename ?? undefined,
});

const toInvite = (r: InviteRow): AdminInvite => ({
  ...r,
  role: 'sub_admin',
  roleId: r.roleId ?? undefined,
  permissions: r.permissions ?? undefined,
  maskedFields: r.maskedFields ?? undefined,
  scopedTagIds: r.scopedTagIds ?? undefined,
  /*
   * The column is NULLABLE, and that is the migration strategy rather than an
   * oversight.
   *
   * Invites written before hashing landed hold a raw token in a column that no
   * longer exists, so there is nothing to back-fill from — they are invalid by
   * definition, and a NOT NULL column would have needed a data migration to
   * invent values for rows that must not work. NULL never equals a hash in SQL,
   * so `findByToken` simply cannot match them: the old invites are dead by
   * construction, which is exactly the intent.
   *
   * '' here because no live code path can observe it — a row is only reachable
   * through a hash lookup, which a NULL row can never satisfy.
   */
  tokenHash: r.tokenHash ?? '',
});

@Injectable()
export class AdminsStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * Normalises the email on the way IN, because `findByEmail` normalises on the
   * way out and `admins.email` is a case-sensitive varchar.
   *
   * The two halves disagreed. `findByEmail` lowercased its argument; nothing
   * lowercased what was stored. An admin invited as "Sam@Oxshare.com" was
   * written verbatim, and every later lookup searched for "sam@oxshare.com" and
   * matched nothing — so they could never sign in, with the right password, on
   * an account that plainly exists in the directory.
   *
   * The timing made it worse than a login bug: accepting an invite signs you in
   * directly, so onboarding appeared to succeed. The failure arrived the next
   * morning. The portal has always normalised on write (identity/auth.service
   * register); this is the admin side of the same rule, placed in the store so
   * no future caller has to remember it.
   */
  async create(data: Omit<Admin, 'id' | 'createdAt'>, tx?: Executor): Promise<Admin> {
    const [row] = await (tx ?? this.db)
      .insert(admins)
      .values({ ...data, email: data.email.toLowerCase() })
      .returning();
    return toAdmin(row);
  }

  /**
   * Active administrators who see EVERY client: the explicit grant (0154) and
   * no territory tags (tags restrict, only the flag grants). What
   * `assertKeepsFullSight` counts, inside the caller's transaction.
   */
  async countActiveFullSight(executor?: Executor): Promise<number> {
    const db = executor ?? this.db;
    const [row] = await db
      .select({ n: count() })
      .from(admins)
      .where(
        and(
          eq(admins.status, 'active'),
          eq(admins.seesAllClients, true),
          notExists(
            db
              .select({ one: sql`1` })
              .from(adminClientTagScopes)
              .where(eq(adminClientTagScopes.adminId, admins.id)),
          ),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /**
   * Names for a set of ids, in ONE query.
   *
   * Every decision screen records `reviewedBy` and rendered nothing, because
   * the column holds a uuid and a uuid is not an answer to "who approved
   * this". Resolving them one at a time across a page of withdrawals is the
   * 1+N this codebase has removed twice already, so it is a single `inArray`
   * and a Map.
   */
  async namesByIds(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();

    const rows = await this.db
      .select({ id: admins.id, name: admins.name })
      .from(admins)
      .where(inArray(admins.id, unique));

    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async findById(id: string): Promise<Admin | undefined> {
    const [row] = await this.db.select().from(admins).where(eq(admins.id, id)).limit(1);
    return row ? toAdmin(row) : undefined;
  }

  async findByEmail(email: string): Promise<Admin | undefined> {
    const [row] = await this.db
      .select()
      .from(admins)
      .where(eq(admins.email, email.toLowerCase()))
      .limit(1);
    return row ? toAdmin(row) : undefined;
  }

  async update(id: string, patch: Partial<Admin>, tx?: Executor): Promise<Admin | undefined> {
    const { id: _ignored, createdAt: _also, ...rest } = patch;
    // Explicit nulls clear optional columns (e.g. logout clears refreshToken)
    const set = {
      ...rest,
      roleId: 'roleId' in rest ? (rest.roleId ?? null) : undefined,
      // `maskedFields: undefined` in a patch means "clear the override, go back
      // to inheriting the role" — so it must reach the column as NULL, not be
      // dropped from the SET like an absent key. `'maskedFields' in rest` is
      // what distinguishes "set it to inherit" from "do not touch it".
      maskedFields: 'maskedFields' in rest ? (rest.maskedFields ?? null) : undefined,
      refreshToken: 'refreshToken' in rest ? (rest.refreshToken ?? null) : undefined,
      // Same distinction for the photo: `avatarFilename: undefined` in a patch
      // means "remove it", which must reach the column as NULL rather than be
      // dropped from the SET and leave the old filename pointing at a file the
      // caller has just deleted.
      avatarFilename: 'avatarFilename' in rest ? (rest.avatarFilename ?? null) : undefined,
    };
    const [row] = await (tx ?? this.db)
      .update(admins)
      .set(set)
      .where(eq(admins.id, id))
      .returning();
    return row ? toAdmin(row) : undefined;
  }

  /**
   * Void any outstanding reset link.
   *
   * Its own method rather than a field on `Admin`, because the hash is a
   * credential: putting it on the domain type would carry it into every object
   * `findById` returns, and from there into logs and audit payloads. The two
   * writes that touch it — arming and spending — are already methods here for
   * the same reason.
   */
  async clearResetToken(id: string): Promise<void> {
    await this.db
      .update(admins)
      .set({ passwordResetTokenHash: null, passwordResetExpiry: null })
      .where(eq(admins.id, id));
  }

  /**
   * Arm a password reset. Overwrites any token already outstanding.
   *
   * Overwriting rather than refusing is deliberate: a second reset request
   * means the first link did not reach the person, and leaving both live would
   * widen the window for no benefit. The newest link is the only one that works.
   */
  async setResetToken(id: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db
      .update(admins)
      .set({ passwordResetTokenHash: tokenHash, passwordResetExpiry: expiresAt })
      .where(eq(admins.id, id));
  }

  /**
   * Spend the token and set the new password — in ONE statement, on purpose.
   *
   * This is the whole single-use guarantee, and it lives in the WHERE clause
   * rather than in a preceding SELECT. Check-then-write leaves a window in
   * which two requests both read a valid token and both succeed, and the token
   * that grants an administrator account on a system that approves payouts is
   * exactly the wrong place to leave that window open. The same reasoning the
   * money rules apply to `UPDATE … WHERE state='approved'` (ARCHITECTURE §6.3).
   *
   * Expiry is compared IN THE DATABASE for the same reason — a timestamp read
   * out, compared in Node, and written back is three chances to race.
   *
   * Returns the admin whose password was set, or `undefined` when the token was
   * already spent, expired, or never existed. The caller cannot tell those
   * apart, and must not: distinguishing them tells an attacker which guess was
   * closest.
   */
  async consumeResetToken(tokenHash: string, passwordHash: string): Promise<Admin | undefined> {
    const [row] = await this.db
      .update(admins)
      .set({
        passwordHash,
        /*
         * The cutoff the guard compares token `iat` against. Family revocation
         * alone leaves an ACCESS token minted seconds before the reset working
         * for its remaining 15 minutes — on the console that approves payouts,
         * that is the window somebody resetting under duress is closing. The
         * portal's reset has set this since it shipped; this side had not.
         */
        passwordChangedAt: new Date(),
        // Cleared in the same statement, so the token cannot be replayed even
        // if the request that spent it is retried.
        passwordResetTokenHash: null,
        passwordResetExpiry: null,
      })
      .where(
        and(
          eq(admins.passwordResetTokenHash, tokenHash),
          gt(admins.passwordResetExpiry, new Date()),
        ),
      )
      .returning();
    return row ? toAdmin(row) : undefined;
  }

  /**
   * The administrator directory — ordered, and optionally paged.
   *
   * ## The default ORDER BY is a BUG FIX, not a preference
   *
   * This was `SELECT * FROM admins` with no ORDER BY at all. SQL does not
   * promise an order without one, and Postgres genuinely varies it: the row
   * order follows whatever the executor produced, so a seq scan, a plan change
   * after ANALYZE, or an UPDATE moving a row to the end of the heap all reorder
   * the directory. An operator who saw a colleague third in the list yesterday
   * and cannot find them today has no way to tell a reordering from a deletion.
   * `name asc` is the order the screen already presents itself as having.
   *
   * ## Paging is OPT-IN, and that is deliberate
   *
   * `page`/`limit` absent returns every administrator, because that is what this
   * endpoint has always returned and what its callers are written against — the
   * response is a bare array, and wrapping it unconditionally would break the
   * admin directory screen and the two specs that read it. Administrators number
   * in the dozens, not the hundreds of thousands, so unpaged is a defensible
   * default here in a way it never was for the client index.
   *
   * When paging IS requested the count comes back alongside, so a caller can
   * render "of 84" without a second round trip.
   */
  async findAll(
    filter: {
      /** R-2.5 server-side sort. Validated by `sortKey` before it gets here. */
      sort?: AdminSortKey;
      order?: SortOrder;
      /** Omit BOTH to get every row — see above. */
      page?: number;
      limit?: number;
    } = {},
  ): Promise<{ rows: Admin[]; total: number }> {
    const sortKey: AdminSortKey = filter.sort ?? DEFAULT_ADMIN_SORT;
    const direction = filter.order ?? DEFAULT_ADMIN_ORDER;
    const sortColumn: SQLWrapper = ADMIN_SORT_COLUMNS[sortKey];

    const query = this.db
      .select()
      .from(admins)
      // `id` is the total-order tiebreak: `role` has two values and `status`
      // has two, so ties are the norm rather than the exception here, and rows
      // tied on the sort key would otherwise swap places between requests.
      .orderBy(...orderTerms(sortColumn, admins.id, direction))
      .$dynamic();

    const paged =
      filter.page !== undefined && filter.limit !== undefined
        ? await query.limit(filter.limit).offset((filter.page - 1) * filter.limit)
        : await query;

    const [{ value: total }] = await this.db.select({ value: count() }).from(admins);
    return { rows: paged.map(toAdmin), total };
  }

  async findByRoleId(roleId: string): Promise<Admin[]> {
    const rows = await this.db.select().from(admins).where(eq(admins.roleId, roleId));
    return rows.map(toAdmin);
  }
}

@Injectable()
export class InvitesStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * Stores the invite against the HASH of its token.
   *
   * Takes the raw token and hashes it here so no caller can accidentally persist
   * the credential — the service mints it, emails it, and never has to think
   * about the column.
   */
  async create(
    data: Omit<AdminInvite, 'id' | 'createdAt' | 'accepted' | 'tokenHash'> & { token: string },
  ): Promise<AdminInvite> {
    const { token, ...rest } = data;
    const [row] = await this.db
      .insert(adminInvites)
      .values({ ...rest, tokenHash: hashInviteToken(token), accepted: false })
      .returning();
    return toInvite(row);
  }

  /** Takes the RAW token from the link and looks it up by hash. */
  async findByToken(token: string): Promise<AdminInvite | undefined> {
    const [row] = await this.db
      .select()
      .from(adminInvites)
      .where(eq(adminInvites.tokenHash, hashInviteToken(token)))
      .limit(1);
    return row ? toInvite(row) : undefined;
  }

  async markAccepted(token: string): Promise<void> {
    await this.db
      .update(adminInvites)
      .set({ accepted: true })
      .where(eq(adminInvites.tokenHash, hashInviteToken(token)));
  }

  /**
   * CLAIM the invite — conditional single-use, §8.7's shape.
   *
   * `accepted = false` in the WHERE and the rowcount checked by the caller:
   * two accepts racing the same token used to both pass the read-then-check
   * and collide on the admins.email unique constraint — the loser's onboarding
   * ended in a 500. Now exactly one caller claims; the other is told the
   * invite is spent, which is the truth.
   */
  async claim(token: string, tx?: Executor): Promise<AdminInvite | undefined> {
    const [row] = await (tx ?? this.db)
      .update(adminInvites)
      .set({ accepted: true })
      .where(
        and(eq(adminInvites.tokenHash, hashInviteToken(token)), eq(adminInvites.accepted, false)),
      )
      .returning();
    return row ? toInvite(row) : undefined;
  }

  /**
   * What "still live" means for an invite, in one place.
   *
   * Three conditions, and the third is the one that is easy to forget: an invite
   * whose address ALREADY has an admin can never be accepted, because
   * `acceptInvite` re-checks `findByEmail` and refuses. Such a row is a record
   * that an invite was sent, not an outstanding one.
   *
   * Shared because the two callers answer questions where a false positive costs
   * something real — one advertises a dead link to an operator, the other refuses
   * to delete a role on behalf of a grant that can never happen. Both had the
   * same gap for the same reason.
   */
  private liveInvite() {
    return and(
      eq(adminInvites.accepted, false),
      gt(adminInvites.expiresAt, new Date()),
      notExists(
        this.db
          .select({ one: sql`1` })
          .from(admins)
          .where(eq(admins.email, adminInvites.email)),
      ),
    );
  }

  async findPendingByRoleId(roleId: string): Promise<AdminInvite[]> {
    const rows = await this.db
      .select()
      .from(adminInvites)
      .where(and(eq(adminInvites.roleId, roleId), this.liveInvite()));
    return rows.map(toInvite);
  }

  /**
   * A live invite for this address — not accepted, not expired.
   *
   * `admins.email` is UNIQUE but `admin_invites.email` is not, so nothing stopped
   * two live tokens for one address. Both validated; the first accept created the
   * account and the second hit the unique constraint on `admins.email` — a raw
   * 500 at the last step of onboarding, to a person who did nothing wrong.
   */
  async findPendingByEmail(email: string): Promise<AdminInvite | undefined> {
    const [row] = await this.db
      .select()
      .from(adminInvites)
      .where(
        and(
          eq(adminInvites.email, email),
          eq(adminInvites.accepted, false),
          gt(adminInvites.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row ? toInvite(row) : undefined;
  }

  /**
   * Every live invite, newest first — the "who has been asked but not arrived" list.
   *
   * Unaccepted and unexpired is not sufficient — see `liveInvite`. Listing an
   * invite whose address already has an admin advertises a link guaranteed to
   * fail, under a heading that says "sent but not yet accepted".
   *
   * That state is reachable and was reached: before `createInvite` refused a
   * duplicate, one address could be invited twice, and accepting either one left
   * the other pending forever. The guards stop new ones; this stops the existing
   * rows being presented as actionable. It also covers the paths that will never
   * have those guards — an admin seeded or created directly while an invite was
   * outstanding lands in exactly the same place.
   *
   * Filtered here rather than swept by a migration deliberately: the invite row
   * is a true record that the invite was sent, and D-21's audit story is better
   * served by keeping it and rendering it correctly than by deleting history.
   */
  async findAllPending(): Promise<AdminInvite[]> {
    const rows = await this.db
      .select()
      .from(adminInvites)
      .where(this.liveInvite())
      .orderBy(desc(adminInvites.createdAt));
    return rows.map(toInvite);
  }

  async findById(id: string): Promise<AdminInvite | undefined> {
    const [row] = await this.db.select().from(adminInvites).where(eq(adminInvites.id, id)).limit(1);
    return row ? toInvite(row) : undefined;
  }

  /**
   * Revoking DELETES the row rather than flagging it.
   *
   * An accepted invite is kept as the provenance of an existing administrator —
   * `audit_log` records who invited whom. A revoked one never produced an
   * account, so there is no subject to preserve, and leaving the row would mean
   * `findPendingByEmail` had to learn a third state to avoid blocking a re-invite
   * to a corrected address. The revocation itself is audited.
   */
  async deleteById(id: string): Promise<void> {
    await this.db.delete(adminInvites).where(eq(adminInvites.id, id));
  }
}
