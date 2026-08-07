import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import {
  ADMIN_SORT_COLUMNS,
  Admin,
  AdminsStore,
  DEFAULT_ADMIN_ORDER,
  DEFAULT_ADMIN_SORT,
} from '../../store/admins.store';
import {
  DEFAULT_ROLE_ORDER,
  DEFAULT_ROLE_SORT,
  ROLE_SORT_COLUMNS,
  RolesStore,
} from '../../store/roles.store';
import { sortKey, sortOrder } from '../../common/sorting';
import { InvitesStore } from '../../store/admins.store';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { assertActorCan, normalizePermissionKey } from '../../common/security/actor';
import { ClientFieldsService } from './client-fields.service';
import { ClientTagsStore } from '../../store/client-tags.store';
import { AdminClientScopesStore } from '../../store/admin-client-scopes.store';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/** One row of the administrator directory — whatever `sanitize()` admits. */
type AdminProfile = Awaited<ReturnType<AdminRbacService['sanitize']>>;

/** The opt-in paginated envelope `listAdmins` returns when asked for a page. */
// Exported because `listAdmins` is part of a public method's return type on
// AdminRbacController, and TypeScript cannot name an unexported interface
// there (TS4053).
export interface AdminDirectoryPage {
  items: AdminProfile[];
  total: number;
  page: number;
  limit: number;
}

/** `config/permissions.json`, keyed by module. The single grantable vocabulary. */
type PermissionCatalog = Record<
  string,
  { moduleName: string; description: string; permissions: { key: string; label: string }[] }
>;

/**
 * RBAC: the permission catalog, roles, admin users, and the anti-escalation
 * invariant that binds them.
 *
 * `assertGrantable` is the single most security-critical function in the admin
 * surface — a missing `await` on one of its call sites let a sub-admin grant
 * themselves the `*` wildcard. It lives here, next to every caller, with the
 * tests in test/rbac.spec.ts.
 */
@Injectable()
export class AdminRbacService {
  constructor(
    private readonly admins: AdminsStore,
    private readonly invites: InvitesStore,
    private readonly roles: RolesStore,
    private readonly audit: AdminAuditService,
    private readonly clientFields: ClientFieldsService,
    private readonly clientTags: ClientTagsStore,
    private readonly scopes: AdminClientScopesStore,
  ) {}

  // ─── RBAC: permission catalog ─────────────────────────────────────────────
  /**
   * The permission catalog, read from disk ONCE.
   *
   * This did a synchronous readFileSync + JSON.parse on every call, and
   * `catalogKeys()` calls it again per invocation — so every `assertGrantable`,
   * which is the anti-escalation check on every grant, did blocking file IO on
   * the event loop. The file is a build artefact that cannot change while the
   * process runs, so caching it is behaviour-identical.
   *
   * Cached at first use rather than in the constructor: the module resolution
   * below depends on __dirname vs cwd, which differs between `nest start` and a
   * compiled `dist` run, and resolving it lazily keeps that decision at the one
   * moment both are known to be settled.
   */
  private static catalog: PermissionCatalog | null = null;

  getPermissionsCatalog(): PermissionCatalog {
    if (!AdminRbacService.catalog) {
      const file = path.join(__dirname, '../../config/permissions.json');
      const fallback = path.join(process.cwd(), 'src/config/permissions.json');
      const raw = fs.readFileSync(fs.existsSync(file) ? file : fallback, 'utf-8');
      AdminRbacService.catalog = JSON.parse(raw) as PermissionCatalog;
    }
    return AdminRbacService.catalog;
  }
  /** Every grantable key, from the catalog — the single vocabulary for roles. */
  private catalogKeys(): Set<string> {
    const keys = new Set<string>();
    for (const module of Object.values(this.getPermissionsCatalog())) {
      for (const p of module.permissions) keys.add(p.key);
    }
    return keys;
  }
  /**
   * Permission keys are lower-case and dot-separated. One spelling, no shim.
   *
   * This used to rewrite `:` to `.` before checking the catalog, which meant
   * `kyc:review` PASSED validation and was then stored verbatim — the system
   * kept generating the very inconsistency the four normalisation shims existed
   * to paper over. Migration 0009 converted what was stored; rejecting the other
   * spelling here is what stops it coming back.
   *
   * Casing is still folded, because a key differing only in case is a typo
   * rather than a second convention, and the catalog is the authority either way.
   */
  static normalizeKey(key: string): string {
    // Delegates rather than reimplements. Three copies of this rule existed —
    // here, in PermissionsGuard, and in common/security/actor.ts — and the third
    // still rewrote `:` to `.`, so the same stored key was refused by the guard
    // and accepted by the service layer.
    return normalizePermissionKey(key);
  }
  /**
   * Anti-escalation invariant: nobody hands out access they don't hold.
   * - every key must exist in the catalog ('*' is reserved for the master),
   * - a non-master actor can only grant keys from their own permission set.
   * The actor's permissions arrive live-resolved from the guard.
   *
   * Public because AdminAuthService applies the same invariant when an invite
   * carries a permission set. There must be exactly one implementation of it.
   *
   * Async by contract even though the body is synchronous today: every caller
   * awaits it, and the day a check here needs a role lookup, making it async
   * then would silently un-await five call sites. That is precisely the bug
   * this function exists to prevent.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async assertGrantable(actor: Admin, permissions: string[]) {
    const catalog = this.catalogKeys();
    const unknown = permissions.filter(
      (p) => p !== '*' && !catalog.has(AdminRbacService.normalizeKey(p)),
    );
    if (unknown.length > 0) {
      throw new ValidationError(`Unknown permission key(s): ${unknown.join(', ')}.`);
    }

    const actorIsMaster = actor.permissions.includes('*');
    if (permissions.includes('*') && !actorIsMaster) {
      throw new AuthorizationError('Only the master admin can grant the * wildcard.');
    }
    if (actorIsMaster) return;

    const held = new Set(actor.permissions.map((p) => AdminRbacService.normalizeKey(p)));
    const beyond = permissions.filter((p) => !held.has(AdminRbacService.normalizeKey(p)));
    if (beyond.length > 0) {
      throw new AuthorizationError(
        `You cannot grant permissions you do not hold: ${beyond.join(', ')}.`,
      );
    }
  }

  /**
   * The anti-escalation rule for FIELD MASKS — `assertGrantable`'s mirror.
   *
   * Permissions are a GRANT list, so the rule there is "you cannot give what
   * you do not hold": a subset check. A mask is a RESTRICTION list, so the same
   * principle inverts into a SUPERSET check — you cannot give somebody
   * VISIBILITY you do not have yourself.
   *
   * Concretely: an administrator who cannot see `client.phone` must not be able
   * to create a role that can. Without this, masking is trivially defeated —
   * make a role that hides nothing, assign yourself to it, and read the column
   * you were denied. The escalation is one screen and needs no exploit.
   *
   * A master admin holds an empty mask, so the loop below is vacuous for them
   * and they may configure anything. That is FR-RBAC-01's "without exception".
   *
   * Synchronous, unlike `assertGrantable` — but every caller still treats the
   * two the same way, so if this ever needs a lookup, make it async and let the
   * compiler find the call sites rather than adding a lookup inside a sync
   * function. A missing `await` on `assertGrantable` once shipped a privilege
   * escalation; that lesson applies here whether or not the signature has.
   */
  assertMaskAllowed(actor: Admin & { fieldMask?: readonly string[] }, maskedFields: string[]) {
    // Rejects unknown keys and keys the catalog marks unmaskable, each with its
    // own message — a typo and "you cannot hide the status column" call for
    // different fixes.
    this.clientFields.assertMaskable(maskedFields);

    const actorMask = actor.fieldMask ?? [];
    if (actorMask.length === 0) return;

    const proposed = new Set(this.clientFields.expand(maskedFields));
    const wouldReveal = actorMask.filter((key) => !proposed.has(key));
    if (wouldReveal.length > 0) {
      throw new AuthorizationError(
        `You cannot un-hide fields that are hidden from you: ${wouldReveal.join(', ')}.`,
      );
    }
  }

  /**
   * The anti-escalation rule for TERRITORY.
   *
   * A subset check, like permissions and unlike masks: a scope is a grant of
   * visibility, so "you cannot give what you do not hold" applies directly. An
   * administrator restricted to the Levant desk must not be able to put someone
   * else on the EMEA desk — that would be granting a view of clients they
   * cannot see themselves, and a second-hand one is no different from a direct
   * one.
   *
   * The EMPTY case is the one worth reading twice. `[]` means UNRESTRICTED, so
   * a scoped actor handing somebody an empty scope is granting access to every
   * client in the system — the largest possible widening, expressed as the
   * smallest possible value. It is refused explicitly rather than falling
   * through the subset check, which `[] ⊆ anything` would pass.
   */
  async assertScopable(actor: AuthenticatedAdmin, tagIds: string[]) {
    const existing = await this.clientTags.findByIds(tagIds);
    const known = new Set(existing.map((t) => t.id));
    const unknown = tagIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ValidationError(`Unknown client tag(s): ${unknown.join(', ')}.`);
    }

    if (actor.clientScope.unrestricted) return;

    if (tagIds.length === 0) {
      throw new AuthorizationError(
        'You cannot give an administrator an empty client scope, because an empty scope ' +
          'means UNRESTRICTED — every client in the system, including those outside your own.',
      );
    }

    const held = new Set(actor.clientScope.tagIds);
    const beyond = tagIds.filter((id) => !held.has(id));
    if (beyond.length > 0) {
      const labels = existing.filter((t) => beyond.includes(t.id)).map((t) => t.label);
      throw new AuthorizationError(
        `You cannot grant client scope you do not hold yourself: ${labels.join(', ')}.`,
      );
    }
  }
  // ─── RBAC: roles ──────────────────────────────────────────────────────────
  async listRoles(query: { sort?: string; order?: string } = {}) {
    return await this.roles.findAll({
      // R-2.5. An unrecognised key is a 400 naming the allowed ones, never a
      // silent fallback to the default ordering.
      sort: sortKey(query.sort, ROLE_SORT_COLUMNS, DEFAULT_ROLE_SORT, 'roles'),
      order: sortOrder(query.order, DEFAULT_ROLE_ORDER),
    });
  }
  async createRole(
    name: string,
    description: string | undefined,
    permissions: string[],
    actor: Admin,
    maskedFields: string[] = [],
  ) {
    if (await this.roles.findByName(name)) {
      throw new ConflictError('A role with this name already exists.');
    }
    await this.assertGrantable(actor, permissions);
    this.assertMaskAllowed(actor, maskedFields);
    const role = await this.roles.create({ name, description, permissions, maskedFields });
    this.audit.record(actor.id, 'role.create', 'role', role.id, {
      name,
      permissions,
      maskedFields,
    });
    return role;
  }
  async updateRole(
    id: string,
    patch: {
      name?: string;
      description?: string;
      permissions?: string[];
      maskedFields?: string[];
    },
    actor: Admin,
  ) {
    const role = await this.roles.findById(id);
    if (!role) throw new NotFoundError('Role not found.');
    if (role.isSystem) throw new ValidationError('System roles cannot be modified.');
    if (patch.name && patch.name !== role.name && (await this.roles.findByName(patch.name))) {
      throw new ConflictError('A role with this name already exists.');
    }
    if (patch.permissions) await this.assertGrantable(actor, patch.permissions);
    if (patch.maskedFields) this.assertMaskAllowed(actor, patch.maskedFields);
    const updated = await this.roles.update(id, patch);
    this.audit.record(actor.id, 'role.update', 'role', id, {
      before: role.permissions,
      after: updated?.permissions,
      // Recorded separately because a mask change and a permission change are
      // different events and answering "who could see phone numbers in March"
      // from a diff of `permissions` is impossible.
      maskBefore: role.maskedFields,
      maskAfter: updated?.maskedFields,
    });
    return updated;
  }
  async deleteRole(id: string, actorId?: string) {
    const role = await this.roles.findById(id);
    if (!role) throw new NotFoundError('Role not found.');
    if (role.isSystem) throw new ValidationError('System roles cannot be deleted.');
    // A role in use cannot be deleted — silently orphaning its admins would
    // leave them running on the stale per-admin snapshot.
    const holders = await this.admins.findByRoleId(id);
    if (holders.length > 0) {
      throw new ConflictError(
        `Role is assigned to ${holders.length} admin(s). Reassign them first.`,
      );
    }
    const pending = await this.invites.findPendingByRoleId(id);
    if (pending.length > 0) {
      throw new ConflictError(
        `Role is referenced by ${pending.length} pending invite(s). Wait for expiry or invite again with another role.`,
      );
    }
    await this.roles.delete(id);
    if (actorId) this.audit.record(actorId, 'role.delete', 'role', id, { name: role.name });
    return { message: 'Role deleted.' };
  }
  // ─── RBAC: admin directory ────────────────────────────────────────────────
  /**
   * The administrator directory.
   *
   * ## The response SHAPE depends on whether paging was asked for
   *
   * With no `page`/`limit` this returns a bare array, exactly as it always has —
   * the admin app's directory screen, the export service and two specs all read
   * it that way, and administrators number in the dozens. Wrapping it
   * unconditionally would be a breaking change to a contract with live callers,
   * bought for a list that fits on one screen.
   *
   * With `page` or `limit` present it returns `{ items, total, page, limit }`,
   * the envelope every other paginated admin list uses. A caller opts in by
   * asking; nothing that has not asked is affected.
   *
   * `sort`/`order` apply to BOTH shapes — ordering is not paging, and the
   * unpaged array was previously returned in no defined order at all.
   */
  /*
   * OVERLOADED so the unpaged call site is statically an ARRAY.
   *
   * Without these signatures every caller sees `Array | Envelope` and has to
   * narrow, including `exportAdmins`, which legitimately never pages. The
   * overloads encode what the body already guarantees: paging keys absent means
   * the array shape, and the compiler enforces that at each call site rather
   * than each call site asserting it.
   */
  async listAdmins(query?: { sort?: string; order?: string }): Promise<AdminProfile[]>;
  async listAdmins(query: {
    sort?: string;
    order?: string;
    page?: string;
    limit?: string;
  }): Promise<AdminProfile[] | AdminDirectoryPage>;
  async listAdmins(
    query: { sort?: string; order?: string; page?: string; limit?: string } = {},
  ): Promise<AdminProfile[] | AdminDirectoryPage> {
    const sort = sortKey(query.sort, ADMIN_SORT_COLUMNS, DEFAULT_ADMIN_SORT, 'administrators');
    const order = sortOrder(query.order, DEFAULT_ADMIN_ORDER);

    const wantsPaging = query.page !== undefined || query.limit !== undefined;
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '25', 10) || 25));

    const { rows, total } = await this.admins.findAll({
      sort,
      order,
      ...(wantsPaging ? { page, limit } : {}),
    });
    const items = await Promise.all(rows.map((a) => this.sanitize(a)));

    return wantsPaging ? { items, total, page, limit } : items;
  }
  async updateAdmin(
    id: string,
    patch: {
      name?: string;
      roleId?: string;
      permissions?: string[];
      /** RBAC-03 per-person override. `null` clears it — back to inheriting the role. */
      maskedFields?: string[] | null;
      /** RBAC-03 territory. An empty array means unrestricted. */
      scopedTagIds?: string[];
    },
    actor: AuthenticatedAdmin,
  ) {
    const admin = await this.admins.findById(id);
    if (!admin) throw new NotFoundError('Admin not found.');

    /*
     * VISIBILITY is access, so it lives under the same three guards as
     * permissions rather than beside them.
     *
     * Which clients an administrator can see, and which of their fields, decide
     * what that administrator can do just as directly as a permission key does.
     * Leaving these three checks to cover `roleId`/`permissions` only would
     * mean the master admin's territory is editable, and — far worse — that
     * anyone could widen their OWN by editing themselves, which is a one-request
     * privilege escalation with no permission change to notice in the audit log.
     */
    const touchesAccess = Boolean(
      patch.roleId ||
      patch.permissions ||
      patch.maskedFields !== undefined ||
      patch.scopedTagIds !== undefined,
    );

    if (admin.role === 'master_admin' && touchesAccess) {
      throw new ValidationError('The master admin’s permissions cannot be changed.');
    }
    // Nobody rewrites their own access — not even a harmless-looking subset;
    // it keeps every permission change attributable to someone else's decision.
    if (actor.id === id && touchesAccess) {
      throw new AuthorizationError('You cannot change your own role, permissions or visibility.');
    }

    /*
     * A SEPARATE permission from `users.edit`, deliberately.
     *
     * Reusing `users.edit` would mean anyone who can rename an administrator can
     * also widen that administrator's view of the entire client base. Those are
     * not the same size of act, and the permission matrix should not imply they
     * are.
     */
    if (patch.maskedFields !== undefined || patch.scopedTagIds !== undefined) {
      assertActorCan(actor, 'users.scope', "change an administrator's client visibility");
    }

    let update: Partial<Admin> = { name: patch.name ?? admin.name };
    if (patch.roleId) {
      const role = await this.roles.findById(patch.roleId);
      if (!role) throw new NotFoundError('Role not found.');
      await this.assertGrantable(actor, role.permissions);
      update = { ...update, roleId: role.id, permissions: role.permissions };
    } else if (patch.permissions) {
      await this.assertGrantable(actor, patch.permissions);
      update = { ...update, roleId: undefined, permissions: patch.permissions };
    }

    if (patch.maskedFields !== undefined) {
      // `null` clears the override; an array pins this person's own answer.
      if (patch.maskedFields !== null) this.assertMaskAllowed(actor, patch.maskedFields);
      update = { ...update, maskedFields: patch.maskedFields ?? undefined };
    }

    if (patch.scopedTagIds !== undefined) {
      await this.assertScopable(actor, patch.scopedTagIds);
    }

    const updated = (await this.admins.update(id, update))!;

    // After the admin row, so a rejected mask or permission change does not
    // leave a territory applied to an admin whose update failed.
    if (patch.scopedTagIds !== undefined) {
      await this.scopes.replace(id, patch.scopedTagIds, actor.id);
    }

    this.audit.record(actor.id, 'admin.update', 'admin', id, {
      before: { permissions: admin.permissions, roleId: admin.roleId, mask: admin.maskedFields },
      after: {
        permissions: updated.permissions,
        roleId: updated.roleId,
        mask: updated.maskedFields,
      },
      // Recorded separately from permissions: "who could see which clients in
      // March" is not answerable from a permission diff, and it is exactly the
      // question a compliance review asks after an incident.
      ...(patch.scopedTagIds === undefined ? {} : { scopedTagIds: patch.scopedTagIds }),
    });
    return await this.sanitize(updated);
  }

  // ─── Admin suspension (users.suspend) ─────────────────────────────────────
  /**
   * FR-RBAC-07's "manage" half — and the missing end of R-3.3's revocation story.
   *
   * `admins.status` has existed, and been ENFORCED, for a while: admin.guard.ts
   * refuses a suspended admin on every request and admin-auth.service refuses
   * them at login. Nothing ever WROTE it. The only write in the codebase set
   * `'active'` on invite-accept, so cutting off a compromised or departing
   * administrator meant direct SQL — or deleting the row, which destroys the
   * subject every audit entry points at. That is the situation the column was
   * added to fix, and it stayed half-built.
   *
   * Shaped after `admin-clients.service.ts` `setClientStatus()` rather than
   * invented: same permission key, same already-in-state refusal, same audit
   * payload. Two surfaces that both mean "suspend" should not disagree about
   * what that involves.
   */
  async setAdminStatus(id: string, status: 'active' | 'suspended', actor: Admin) {
    assertActorCan(actor, 'users.suspend', 'suspend or reactivate an administrator');

    const admin = await this.admins.findById(id);
    if (!admin) throw new NotFoundError('Admin not found.');

    // Nobody suspends themselves. The same reasoning as updateAdmin's no-self-edit
    // rule, plus a blunter one: suspension bites on the NEXT request, so this
    // would be an administrator locking themselves out mid-session with no way
    // back in — the account that could reverse it is the one just disabled.
    if (actor.id === id) {
      throw new AuthorizationError('You cannot change your own account status.');
    }
    // The master admin is the recovery path for everyone else. Suspending it
    // can leave a deployment with no one able to reinstate anybody.
    if (admin.role === 'master_admin') {
      throw new ValidationError('The master admin’s account status cannot be changed.');
    }
    if (admin.status === status) {
      throw new ValidationError(`Administrator is already ${status}.`);
    }

    const updated = (await this.admins.update(id, { status }))!;
    this.audit.record(
      actor.id,
      status === 'suspended' ? 'admin.suspend' : 'admin.activate',
      'admin',
      id,
      { email: admin.email, before: admin.status, after: status },
    );
    return await this.sanitize(updated);
  }

  /**
   * The admin, as a client may see them, with the LIVE permission set
   * (role-derived when roleId is set) so the frontend's nav gating always
   * matches what the guards will enforce.
   *
   * An ALLOW-LIST, not a deny-list. The portal's equivalent was a deny-list and
   * silently started leaking `password_reset_token_hash` the moment that column
   * existed, on three separate responses, with nothing to notice. Listing what
   * may leave makes forgetting fail safe instead of fail open.
   */
  async sanitize(admin: Admin) {
    const isMaster = admin.role === 'master_admin';

    const [permissions, maskedFields, scopedTags] = await Promise.all([
      this.roles.resolvePermissions(admin.roleId, admin.permissions),
      /*
       * The RESOLVED mask — what this administrator actually cannot see right
       * now, role and override combined. The directory needs the effective
       * answer, not the raw column, or a row would read "nothing hidden" for
       * someone whose role hides four fields.
       */
      isMaster
        ? Promise.resolve([])
        : this.roles.resolveMaskedFields(admin.roleId, admin.maskedFields),
      isMaster ? Promise.resolve([]) : this.scopes.describeFor(admin.id),
    ]);

    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      roleId: admin.roleId,
      status: admin.status,
      createdAt: admin.createdAt,
      permissions,
      maskedFields,
      /*
       * `null` vs an array is the difference between "follows the role" and
       * "has its own answer", and the edit screen cannot offer "put them back
       * on their role" without knowing which. `maskedFields` above is the
       * resolved view; this is the stored one.
       */
      maskedFieldsOverride: isMaster ? null : (admin.maskedFields ?? null),
      scopedTags,
    };
  }
}
