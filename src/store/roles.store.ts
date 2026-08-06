import { eq } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { roles } from '../database/schema';

export interface Role {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
  /** RBAC-03: client fields holders of this role may not see. See schema.ts. */
  maskedFields: string[];
  isSystem: boolean;
  createdAt: Date;
}

type Row = typeof roles.$inferSelect;
const toRole = (r: Row): Role => ({
  ...r,
  description: r.description ?? undefined,
});

@Injectable()
export class RolesStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async findAll(): Promise<Role[]> {
    const rows = await this.db.select().from(roles);
    return rows.map(toRole);
  }

  async findById(id: string): Promise<Role | undefined> {
    const [row] = await this.db.select().from(roles).where(eq(roles.id, id)).limit(1);
    return row ? toRole(row) : undefined;
  }

  async findByName(name: string): Promise<Role | undefined> {
    const all = await this.db.select().from(roles);
    const row = all.find((r) => r.name.toLowerCase() === name.toLowerCase());
    return row ? toRole(row) : undefined;
  }

  async create(data: Omit<Role, 'id' | 'createdAt' | 'isSystem'>): Promise<Role> {
    const [row] = await this.db
      .insert(roles)
      .values({ ...data, isSystem: false })
      .returning();
    return toRole(row);
  }

  async update(
    id: string,
    patch: Partial<Pick<Role, 'name' | 'description' | 'permissions' | 'maskedFields'>>,
  ): Promise<Role | undefined> {
    const [row] = await this.db.update(roles).set(patch).where(eq(roles.id, id)).returning();
    return row ? toRole(row) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const role = await this.findById(id);
    if (!role || role.isSystem) return false;
    const deleted = await this.db.delete(roles).where(eq(roles.id, id)).returning();
    return deleted.length > 0;
  }

  /**
   * The permissions an admin holds RIGHT NOW.
   *
   * When the admin was assigned via a role, the role is the single source of
   * truth — editing a role must immediately grant/revoke for every admin
   * holding it (RBAC-02: "granted permissions only"). The per-admin snapshot is
   * only a fallback for admins invited with explicit permissions (no roleId) or
   * whose role no longer exists (deletion is blocked while assigned, so that
   * means a pre-existing token raced a delete).
   */
  async resolvePermissions(roleId: string | undefined, snapshot: string[]): Promise<string[]> {
    if (roleId) {
      const role = await this.findById(roleId);
      if (role) return role.permissions;
    }
    return snapshot;
  }

  /**
   * The client fields an admin may NOT see right now — RBAC-03.
   *
   * A deliberate sibling of `resolvePermissions`, in the same file, resolving
   * live for the same reason: adding `client.phone` to the support role must
   * blind every support agent on their next request, with no re-login. Two
   * methods side by side cannot drift; two mechanisms in two files will.
   *
   * The OVERRIDE semantics differ from permissions above, and the difference is
   * the point. `override` is `admins.masked_fields`, which is NULLABLE:
   *
   *   - `undefined` → inherit the role. The common case, and why the column is
   *     not `NOT NULL DEFAULT '[]'`.
   *   - an array (including `[]`) → this person's own answer, pinned.
   *
   * Permissions use `roleId` XOR `permissions`, so a per-person permission
   * grant detaches the admin from their role entirely. Copying that here would
   * mean un-masking ONE field for ONE person silently stops them receiving role
   * permission updates — a security regression performed for a UI convenience.
   * Inherit-by-default keeps the two concerns independent.
   */
  async resolveMaskedFields(
    roleId: string | undefined,
    override: string[] | undefined,
  ): Promise<string[]> {
    if (override !== undefined) return override;
    if (roleId) {
      const role = await this.findById(roleId);
      if (role) return role.maskedFields;
    }
    return [];
  }
}
