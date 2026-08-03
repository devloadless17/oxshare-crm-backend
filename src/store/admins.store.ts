import { and, eq, gt } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { adminInvites, admins } from '../database/schema';

export type AdminRole = 'master_admin' | 'sub_admin';

export interface Admin {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: AdminRole;
  permissions: string[];
  /** RBAC role the permissions were derived from, when assigned via a role. */
  roleId?: string;
  refreshToken?: string;
  createdAt: Date;
}

export interface AdminInvite {
  id: string;
  email: string;
  name: string;
  token: string;
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
  refreshToken: r.refreshToken ?? undefined,
});

const toInvite = (r: InviteRow): AdminInvite => ({
  ...r,
  role: 'sub_admin',
  roleId: r.roleId ?? undefined,
  permissions: r.permissions ?? undefined,
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
    const set = { ...rest, roleId: 'roleId' in rest ? (rest.roleId ?? null) : undefined,
      refreshToken: 'refreshToken' in rest ? (rest.refreshToken ?? null) : undefined };
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

  async create(data: Omit<AdminInvite, 'id' | 'createdAt' | 'accepted'>): Promise<AdminInvite> {
    const [row] = await this.db
      .insert(adminInvites)
      .values({ ...data, accepted: false })
      .returning();
    return toInvite(row);
  }

  async findByToken(token: string): Promise<AdminInvite | undefined> {
    const [row] = await this.db
      .select()
      .from(adminInvites)
      .where(eq(adminInvites.token, token))
      .limit(1);
    return row ? toInvite(row) : undefined;
  }

  async markAccepted(token: string): Promise<void> {
    await this.db.update(adminInvites).set({ accepted: true }).where(eq(adminInvites.token, token));
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
