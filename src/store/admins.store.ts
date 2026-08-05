import { and, eq, gt } from 'drizzle-orm';
import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { adminInvites, admins } from '../database/schema';

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
});

const toInvite = (r: InviteRow): AdminInvite => ({
  ...r,
  role: 'sub_admin',
  roleId: r.roleId ?? undefined,
  permissions: r.permissions ?? undefined,
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

  async create(data: Omit<Admin, 'id' | 'createdAt'>): Promise<Admin> {
    const [row] = await this.db.insert(admins).values(data).returning();
    return toAdmin(row);
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

  async update(id: string, patch: Partial<Admin>): Promise<Admin | undefined> {
    const { id: _ignored, createdAt: _also, ...rest } = patch;
    // Explicit nulls clear optional columns (e.g. logout clears refreshToken)
    const set = {
      ...rest,
      roleId: 'roleId' in rest ? (rest.roleId ?? null) : undefined,
      refreshToken: 'refreshToken' in rest ? (rest.refreshToken ?? null) : undefined,
    };
    const [row] = await this.db.update(admins).set(set).where(eq(admins.id, id)).returning();
    return row ? toAdmin(row) : undefined;
  }

  async findAll(): Promise<Admin[]> {
    const rows = await this.db.select().from(admins);
    return rows.map(toAdmin);
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

  async findPendingByRoleId(roleId: string): Promise<AdminInvite[]> {
    const rows = await this.db
      .select()
      .from(adminInvites)
      .where(
        and(
          eq(adminInvites.roleId, roleId),
          eq(adminInvites.accepted, false),
          gt(adminInvites.expiresAt, new Date()),
        ),
      );
    return rows.map(toInvite);
  }
}
