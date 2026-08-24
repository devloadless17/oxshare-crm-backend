import { eq, type SQLWrapper } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { roles } from '../database/schema';
import { orderTerms, type SortOrder } from '../common/sorting';

/**
 * The columns the role list may be ordered by — R-2.5.
 *
 * Small on purpose. `permissions` and `maskedFields` are jsonb arrays with no
 * meaningful ordering, and `isSystem` is a two-value flag that groups rather
 * than sorts — a caller wanting the system roles first is filtering, not
 * sorting, and the screen already does that in the client.
 */
export const ROLE_SORT_COLUMNS = {
  name: roles.name,
  createdAt: roles.createdAt,
} as const;

export type RoleSortKey = keyof typeof ROLE_SORT_COLUMNS;

/** Alphabetical — a list you look a role up in, not a feed. */
export const DEFAULT_ROLE_SORT: RoleSortKey = 'name';
export const DEFAULT_ROLE_ORDER: SortOrder = 'asc';

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

  /**
   * Every role, ordered — by name ascending unless asked otherwise.
   *
   * The default ORDER BY is a BUG FIX. This was `SELECT * FROM roles` with none
   * at all, and SQL promises no order without one: Postgres returns rows in
   * whatever order the plan produced, so editing a role can move it in the list
   * because the UPDATE rewrote it to the end of the heap. On a screen where an
   * operator picks the role they are about to grant somebody, a list that
   * silently reorders between visits is how the wrong row gets clicked.
   *
   * Alphabetical rather than newest-first for the same reason the administrator
   * directory is: this is a list you look something up in, not a feed.
   */
  async findAll(filter: { sort?: RoleSortKey; order?: SortOrder } = {}): Promise<Role[]> {
    const sortKey: RoleSortKey = filter.sort ?? DEFAULT_ROLE_SORT;
    const direction = filter.order ?? DEFAULT_ROLE_ORDER;
    const sortColumn: SQLWrapper = ROLE_SORT_COLUMNS[sortKey];

    const rows = await this.db
      .select()
      .from(roles)
      // `id` breaks ties so two roles sharing a creation timestamp — the seeded
      // system roles are inserted together — cannot swap places between reads.
      .orderBy(...orderTerms(sortColumn, roles.id, direction));
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
    tx?: Executor,
  ): Promise<Role | undefined> {
    const [row] = await (tx ?? this.db)
      .update(roles)
      .set(patch)
      .where(eq(roles.id, id))
      .returning();
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
