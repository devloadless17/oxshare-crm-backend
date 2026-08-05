import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Admin, AdminsStore } from '../../store/admins.store';
import { RolesStore } from '../../store/roles.store';
import { InvitesStore } from '../../store/admins.store';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { normalizePermissionKey } from '../../common/security/actor';

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
  // ─── RBAC: roles ──────────────────────────────────────────────────────────
  async listRoles() {
    return await this.roles.findAll();
  }
  async createRole(
    name: string,
    description: string | undefined,
    permissions: string[],
    actor: Admin,
  ) {
    if (await this.roles.findByName(name)) {
      throw new ConflictError('A role with this name already exists.');
    }
    await this.assertGrantable(actor, permissions);
    const role = await this.roles.create({ name, description, permissions });
    this.audit.record(actor.id, 'role.create', 'role', role.id, { name, permissions });
    return role;
  }
  async updateRole(
    id: string,
    patch: { name?: string; description?: string; permissions?: string[] },
    actor: Admin,
  ) {
    const role = await this.roles.findById(id);
    if (!role) throw new NotFoundError('Role not found.');
    if (role.isSystem) throw new ValidationError('System roles cannot be modified.');
    if (patch.name && patch.name !== role.name && (await this.roles.findByName(patch.name))) {
      throw new ConflictError('A role with this name already exists.');
    }
    if (patch.permissions) await this.assertGrantable(actor, patch.permissions);
    const updated = await this.roles.update(id, patch);
    this.audit.record(actor.id, 'role.update', 'role', id, {
      before: role.permissions,
      after: updated?.permissions,
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
  async listAdmins() {
    const all = await this.admins.findAll();
    return Promise.all(all.map((a) => this.sanitize(a)));
  }
  async updateAdmin(
    id: string,
    patch: { name?: string; roleId?: string; permissions?: string[] },
    actor: Admin,
  ) {
    const admin = await this.admins.findById(id);
    if (!admin) throw new NotFoundError('Admin not found.');
    if (admin.role === 'master_admin' && (patch.roleId || patch.permissions)) {
      throw new ValidationError('The master admin’s permissions cannot be changed.');
    }
    // Nobody rewrites their own access — not even a harmless-looking subset;
    // it keeps every permission change attributable to someone else's decision.
    if (actor.id === id && (patch.roleId || patch.permissions)) {
      throw new AuthorizationError('You cannot change your own role or permissions.');
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

    const updated = (await this.admins.update(id, update))!;
    this.audit.record(actor.id, 'admin.update', 'admin', id, {
      before: { permissions: admin.permissions, roleId: admin.roleId },
      after: { permissions: updated.permissions, roleId: updated.roleId },
    });
    return await this.sanitize(updated);
  }

  /**
   * Strip secrets from an admin record and surface the LIVE permission set
   * (role-derived when roleId is set), so the frontend's nav gating always
   * matches what the guards will enforce.
   */
  async sanitize(admin: Admin) {
    const { passwordHash, refreshToken, ...safe } = admin;
    return {
      ...safe,
      permissions: await this.roles.resolvePermissions(admin.roleId, admin.permissions),
    };
  }
}
