import { ALL_PERMISSIONS } from './support/all-permissions';
import { UNRESTRICTED } from '../src/common/security/client-scope';
import type { AuthenticatedAdmin } from '../src/modules/admin/guards/admin.guard';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AdminAuthService } from '../src/modules/admin/admin-auth.service';
import { ClientFieldsService } from '../src/modules/admin/client-fields.service';
import { AdminRbacService } from '../src/modules/admin/admin-rbac.service';
import { PasswordService } from '../src/common/security/password.service';
import { CsrfService } from '../src/common/security/csrf.service';
import type { EmailService } from '../src/modules/email/email.service';
import type { RefreshTokensService } from '../src/common/security/refresh-tokens.service';
import type { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import { hashInviteToken } from '../src/store/admins.store';
import type { Admin, AdminInvite, AdminsStore, InvitesStore } from '../src/store/admins.store';
import type { LoginAttemptsService } from '../src/common/security/login-attempts.service';
import type { AdminClientScopesStore } from '../src/store/admin-client-scopes.store';
import type { Role, RolesStore } from '../src/store/roles.store';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../src/common/errors/domain-errors';

/**
 * The admin invite lifecycle — issuing, validating and accepting.
 *
 * These three endpoints CREATE ADMIN ACCOUNTS and had no tests at all, on either
 * side. That is the largest untested authority in the system: everything else
 * decides what an existing admin may do, while this decides that a new one
 * exists at all.
 */

const CONFIG: Record<string, string> = {
  ADMIN_JWT_SECRET: 'admin-secret-at-least-32-characters-long',
  ADMIN_JWT_REFRESH_SECRET: 'admin-refresh-secret-at-least-32-chars',
  ADMIN_URL: 'http://localhost:3002',
  PORTAL_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
};

function configWith(overrides: Record<string, string> = {}) {
  const env = { ...CONFIG, ...overrides };
  return {
    get: (key: string, fallback?: string) => env[key] ?? fallback,
    getOrThrow: (key: string) => {
      const value = env[key];
      if (value === undefined) throw new Error(`missing config: ${key}`);
      return value;
    },
  } as unknown as ConfigService;
}

const MASTER: AuthenticatedAdmin = {
  id: 'master-1',
  email: 'admin@oxshare.com',
  name: 'Master',
  passwordHash: 'x',
  role: 'master_admin',
  status: 'active',
  permissions: ALL_PERMISSIONS,
  clientScope: UNRESTRICTED,
  fieldMask: [],
  createdAt: new Date(),
};

const SUB_ADMIN: AuthenticatedAdmin = {
  ...MASTER,
  id: 'sub-1',
  email: 'sub@oxshare.com',
  role: 'sub_admin',
  permissions: ['kyc.review', 'clients.view', 'admins.create'],
};

const REVIEWER_ROLE: Role = {
  id: 'role-1',
  name: 'Reviewer',
  permissions: ['kyc.review'],
  maskedFields: [],
  isSystem: false,
  createdAt: new Date(),
};

function invite(overrides: Partial<AdminInvite> = {}): AdminInvite {
  return {
    id: 'invite-1',
    email: 'newcomer@oxshare.com',
    name: 'New Comer',
    // Stored hashed now — the raw token never reaches the database.
    tokenHash: hashInviteToken('token-abc'),
    role: 'sub_admin',
    permissions: ['kyc.review'],
    invitedBy: MASTER.id,
    expiresAt: new Date(Date.now() + 3_600_000),
    accepted: false,
    createdAt: new Date(),
    ...overrides,
  };
}

function build(
  options: {
    existingAdmin?: Admin;
    stored?: AdminInvite;
    env?: Record<string, string>;
    /** A CLIENT already holding the invited address — see createInvite. */
    existingClient?: { id: string; email: string };
  } = {},
) {
  const admins = {
    findByEmail: vi.fn().mockResolvedValue(options.existingAdmin),
    findById: vi.fn().mockResolvedValue(options.existingAdmin),
    create: vi.fn((data: Partial<Admin>) => Promise.resolve({ id: 'admin-new', ...data } as Admin)),
    update: vi.fn(),
    // 0191 — a freshly accepted admin has no authenticator yet.
    totpState: vi.fn().mockResolvedValue({ secret: null, pendingSecret: null, lastStep: null }),
  };
  const invites = {
    create: vi.fn((data: Partial<AdminInvite>) =>
      Promise.resolve({ id: 'invite-1', ...data } as AdminInvite),
    ),
    findByToken: vi.fn().mockResolvedValue(options.stored),
    // The conditional single-use claim: wins exactly when the stored invite is
    // live and unaccepted, mirroring `WHERE accepted = false`.
    claim: vi.fn(() =>
      Promise.resolve(options.stored && !options.stored.accepted ? options.stored : undefined),
    ),
    findPendingByRoleId: vi.fn().mockResolvedValue([]),
    // Default: no invite outstanding for this address. The one-live-invite-per-
    // email rule is exercised explicitly in the suite below.
    findPendingByEmail: vi.fn().mockResolvedValue(undefined),
    findAllPending: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(options.stored),
    deleteById: vi.fn().mockResolvedValue(undefined),
  };
  const roles = {
    resolveMaskedFields: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(REVIEWER_ROLE),
    resolvePermissions: vi.fn((_r: unknown, snapshot: string[]) => Promise.resolve(snapshot)),
  };
  const email = { sendAdminInviteEmail: vi.fn().mockResolvedValue(undefined) };
  const audit = { record: vi.fn() };
  const refreshTokens = {
    record: vi.fn().mockResolvedValue(undefined),
    revokeAllForSubject: vi.fn(),
  };
  const config = configWith(options.env);
  // R-3.5 lockout — the invite paths do not touch it; never locked.
  const loginAttempts = {
    lockedFor: vi.fn().mockResolvedValue(null),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
  };

  const scopes = { replace: vi.fn().mockResolvedValue(undefined) };

  /*
   * The CLIENT directory, consulted by createInvite alone: somebody who banks
   * here must not also be an administrator who approves withdrawals. Defaults to
   * "no such client", which is what every other test in this file assumes.
   */
  const users = { findByEmail: vi.fn().mockResolvedValue(options.existingClient) };

  const rbac = new AdminRbacService(
    admins as unknown as AdminsStore,
    invites as unknown as InvitesStore,
    roles as unknown as RolesStore,
    audit as unknown as AdminAuditService,
    new ClientFieldsService(),
    // ClientTagsStore — assertScopable at INVITE time resolves the tag ids.
    { findByIds: vi.fn().mockResolvedValue([{ id: 'tag-1' }]) } as never,
    /*
     * AdminClientScopesStore. `describeFor` is reached because `sanitize` now
     * reports each admin's territory, and acceptInvite returns a sanitized
     * admin — so an empty object here fails on a path that has nothing to do
     * with scoping.
     */
    { describeFor: vi.fn().mockResolvedValue([]) } as never,
    // RefreshTokensService — setAdminStatus revokes sessions on suspend; the
    // invite paths under test here never reach it.
    { revokeAllForSubject: vi.fn().mockResolvedValue(0) } as never,
    // ApiKeysStore — setAdminStatus also revokes the keys a suspended admin
    // minted. Same reason as the line above: the invite paths never reach it.
    { revokeAllCreatedBy: vi.fn().mockResolvedValue(0) } as never,
    // DRIZZLE_DB — the manager-invariant lock wraps role/admin writes in a
    // transaction; a pass-through keeps the store mocks in charge.
    {
      transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute: () => Promise.resolve() }),
    } as never,
  );

  const service = new AdminAuthService(
    new JwtService({}),
    config,
    email as unknown as EmailService,
    admins as unknown as AdminsStore,
    invites as unknown as InvitesStore,
    roles as unknown as RolesStore,
    audit as unknown as AdminAuditService,
    rbac,
    new CsrfService(config),
    refreshTokens as unknown as RefreshTokensService,
    new PasswordService(),
    loginAttempts as unknown as LoginAttemptsService,
    // AdminClientScopesStore — acceptInvite now applies the territory the
    // inviter chose, before it mints the session.
    scopes as unknown as AdminClientScopesStore,
    // UsersStore — createInvite refuses an address that already belongs to a
    // client. Appended for the same positional reason as `scopes` above.
    users as never,
    // DRIZZLE_DB — acceptInvite wraps claim + create + scope in one
    // transaction. The mock hands the callback a pass-through executor: the
    // store mocks above ignore it, which is exactly what a unit test wants.
    { transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as never,
    // IpAllowlistGuard — RBAC-08 on sign-in and refresh; no list configured here.
    {
      admitsAddress: () => Promise.resolve(true),
      admitsAdmin: () => Promise.resolve(true),
    } as never,
  );

  return { service, admins, invites, roles, email, audit, refreshTokens, scopes, users };
}

describe('createInvite', () => {
  it('refuses an email that is already an admin', async () => {
    const h = build({ existingAdmin: SUB_ADMIN });
    await expect(
      h.service.createInvite('sub@oxshare.com', 'Dup', MASTER, undefined, ['kyc.review']),
    ).rejects.toThrow(ConflictError);
    expect(h.invites.create).not.toHaveBeenCalled();
  });

  /**
   * SEGREGATION OF DUTIES, not data integrity.
   *
   * `admins` and `users` are separate tables with separate unique constraints,
   * so one address could exist in both and the invite would have been accepted
   * without complaint — leaving one human with a client account that trades and
   * an admin account that approves withdrawals. The same person could file a
   * manual deposit and confirm it, or request a payout and release it.
   */
  it('refuses an email that already belongs to a CLIENT', async () => {
    const h = build({ existingClient: { id: 'user-1', email: 'trader@oxshare.com' } });
    await expect(
      h.service.createInvite('trader@oxshare.com', 'Trader', MASTER, undefined, ['kyc.review']),
    ).rejects.toThrow(ConflictError);
    expect(h.invites.create).not.toHaveBeenCalled();
  });

  it('gives an INDISTINGUISHABLE refusal for a client and an admin collision (#6)', async () => {
    /*
     * The membership-oracle fix: an admin holding `admins.create` but not
     * `admins.view` must not be able to tell a CLIENT address from an existing
     * ADMIN one by trying to invite it. Both refusals carry the same message,
     * so a probe learns only "already in use", never "this address banks here
     * as a client".
     */
    const clientCase = build({ existingClient: { id: 'user-1', email: 'taken@oxshare.com' } });
    const adminCase = build({ existingAdmin: { ...SUB_ADMIN, email: 'taken@oxshare.com' } });

    const clientErr = await clientCase.service
      .createInvite('taken@oxshare.com', 'X', MASTER, undefined, ['kyc.review'])
      .catch((e: Error) => e.message);
    const adminErr = await adminCase.service
      .createInvite('taken@oxshare.com', 'X', MASTER, undefined, ['kyc.review'])
      .catch((e: Error) => e.message);

    expect(clientErr).toBe(adminErr);
    expect(clientErr).not.toMatch(/client/i);
  });

  it('checks the client directory with the NORMALISED address', async () => {
    // Every other guard on this path compares the lower-cased spelling; a
    // client lookup on the raw input would be the one that missed
    // `Trader@Oxshare.com` and let the duplicate through.
    const h = build();
    await h.service.createInvite('Trader@Oxshare.COM', 'Trader', MASTER, undefined, ['kyc.review']);
    expect(h.users.findByEmail).toHaveBeenCalledWith('trader@oxshare.com');
  });

  it('refuses an unknown role', async () => {
    const h = build();
    h.roles.findById.mockResolvedValue(undefined);
    await expect(
      h.service.createInvite('new@oxshare.com', 'New', MASTER, 'no-such-role'),
    ).rejects.toThrow(NotFoundError);
    expect(h.invites.create).not.toHaveBeenCalled();
  });

  it('ANTI-ESCALATION: a sub-admin cannot invite someone with the wildcard', async () => {
    // assertGrantable is applied on the invite path too, not only on roles —
    // otherwise the rule is trivially bypassed by inviting a second account.
    const h = build();
    await expect(
      h.service.createInvite('new@oxshare.com', 'New', SUB_ADMIN, undefined, ALL_PERMISSIONS),
    ).rejects.toThrow(AuthorizationError);
    expect(h.invites.create).not.toHaveBeenCalled();
  });

  it('ANTI-ESCALATION: a sub-admin cannot invite a permission they do not hold', async () => {
    const h = build();
    await expect(
      h.service.createInvite('new@oxshare.com', 'New', SUB_ADMIN, undefined, ['ib.approve']),
    ).rejects.toThrow(AuthorizationError);
    expect(h.invites.create).not.toHaveBeenCalled();
  });

  it('lets a sub-admin invite within their own permissions', async () => {
    const h = build();
    await h.service.createInvite('new@oxshare.com', 'New', SUB_ADMIN, undefined, ['kyc.review']);
    expect(h.invites.create).toHaveBeenCalled();
  });

  it("takes the role's permissions when a role is named, not the caller's list", async () => {
    const h = build();
    await h.service.createInvite('new@oxshare.com', 'New', MASTER, 'role-1', ALL_PERMISSIONS);
    expect(h.invites.create).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: REVIEWER_ROLE.permissions, roleId: 'role-1' }),
    );
  });

  it('always invites as sub_admin — an invite cannot mint a second master', async () => {
    const h = build();
    await h.service.createInvite('new@oxshare.com', 'New', MASTER, undefined, ['kyc.review']);
    expect(h.invites.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'sub_admin' }));
  });

  it('expires the invite in 48 hours rather than leaving it open-ended', async () => {
    const h = build();
    await h.service.createInvite('new@oxshare.com', 'New', MASTER, undefined, ['kyc.review']);
    const created = h.invites.create.mock.calls[0][0] as { expiresAt: Date };
    const hours = (created.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThanOrEqual(48);
  });

  it('emails the link and audits the act', async () => {
    const h = build();
    await h.service.createInvite('new@oxshare.com', 'New', MASTER, undefined, ['kyc.review']);
    expect(h.email.sendAdminInviteEmail).toHaveBeenCalledOnce();
    expect(h.audit.record).toHaveBeenCalledWith(
      MASTER.id,
      'admin.invite',
      'admin_invite',
      expect.any(String),
      expect.objectContaining({ email: 'new@oxshare.com' }),
    );
  });

  it('NEVER returns the token in production', async () => {
    // The token is a bearer credential that creates an admin account. In
    // production it goes to the invitee's mailbox and nowhere else — not into
    // proxy logs, SPA memory or an error reporter.
    const h = build({ env: { NODE_ENV: 'production' } });
    const result = await h.service.createInvite('new@oxshare.com', 'New', MASTER, undefined, [
      'kyc.review',
    ]);
    const token = (h.invites.create.mock.calls[0][0] as { token: string }).token;
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result).not.toHaveProperty('inviteUrl');
  });

  it('echoes the link in DEVELOPMENT, to keep local work workable', async () => {
    const h = build({ env: { NODE_ENV: 'development' } });
    const result = await h.service.createInvite('new@oxshare.com', 'New', MASTER, undefined, [
      'kyc.review',
    ]);
    expect(result).toHaveProperty('inviteUrl');
  });

  it('does NOT echo the link on STAGING — the echo is an allowlist, not a production check', async () => {
    /*
     * `NODE_ENV !== 'production'` also matched 'staging' and every typo, and
     * this is a bearer token that mints an administrator account. Only
     * development and test opt in; every other environment behaves like
     * production.
     */
    const h = build({ env: { NODE_ENV: 'staging' } });
    const result = await h.service.createInvite('new@oxshare.com', 'New', MASTER, undefined, [
      'kyc.review',
    ]);
    expect(result).not.toHaveProperty('inviteUrl');
  });
});

describe('validateInviteToken', () => {
  it('refuses an unknown token', async () => {
    const h = build({ stored: undefined });
    await expect(h.service.validateInviteToken('nope')).rejects.toThrow(ValidationError);
  });

  it('refuses an already-accepted token', async () => {
    const h = build({ stored: invite({ accepted: true }) });
    await expect(h.service.validateInviteToken('token-abc')).rejects.toThrow(ValidationError);
  });

  it('refuses an expired token', async () => {
    const h = build({ stored: invite({ expiresAt: new Date(Date.now() - 1000) }) });
    await expect(h.service.validateInviteToken('token-abc')).rejects.toThrow(ValidationError);
  });

  it('gives every rejection the SAME message', async () => {
    // Unknown, spent and expired must be indistinguishable, or the endpoint
    // becomes an oracle for guessing valid invite tokens.
    const messages = await Promise.all(
      [
        build({ stored: undefined }),
        build({ stored: invite({ accepted: true }) }),
        build({ stored: invite({ expiresAt: new Date(Date.now() - 1000) }) }),
      ].map((h) => h.service.validateInviteToken('t').catch((e: Error) => e.message)),
    );
    expect(new Set(messages).size).toBe(1);
  });

  it('returns only what the form needs to pre-fill, never the permissions', async () => {
    const h = build({ stored: invite() });
    const result = await h.service.validateInviteToken('token-abc');
    expect(result).toEqual({ email: 'newcomer@oxshare.com', name: 'New Comer', role: 'sub_admin' });
    expect(JSON.stringify(result)).not.toContain('kyc.review');
  });
});

describe('acceptInvite', () => {
  const PASSWORD = 'a-good-password-123';

  it('refuses an unknown token', async () => {
    const h = build({ stored: undefined });
    await expect(h.service.acceptInvite('nope', PASSWORD)).rejects.toThrow(NotFoundError);
    expect(h.admins.create).not.toHaveBeenCalled();
  });

  it('SINGLE USE: refuses a token that has already been accepted', async () => {
    // Otherwise one emailed link creates admin accounts without limit.
    const h = build({ stored: invite({ accepted: true }) });
    await expect(h.service.acceptInvite('token-abc', PASSWORD)).rejects.toThrow(ValidationError);
    expect(h.admins.create).not.toHaveBeenCalled();
  });

  it('refuses an expired token', async () => {
    const h = build({ stored: invite({ expiresAt: new Date(Date.now() - 1000) }) });
    await expect(h.service.acceptInvite('token-abc', PASSWORD)).rejects.toThrow(/expired/i);
    expect(h.admins.create).not.toHaveBeenCalled();
  });

  it('creates a sub_admin holding exactly the invited permissions', async () => {
    const h = build({ stored: invite({ permissions: ['kyc.review', 'clients.view'] }) });
    await h.service.acceptInvite('token-abc', PASSWORD);
    expect(h.admins.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'newcomer@oxshare.com',
        role: 'sub_admin',
        permissions: ['kyc.review', 'clients.view'],
      }),
      expect.anything(), // the accept transaction's executor
    );
  });

  it('takes the email from the INVITE, not from anything the caller supplies', async () => {
    // The caller only presents a token and a password. If the address were
    // caller-supplied, a leaked token would create an account under an attacker's
    // own email.
    const h = build({ stored: invite({ email: 'invited@oxshare.com' }) });
    await h.service.acceptInvite('token-abc', PASSWORD);
    expect(h.admins.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'invited@oxshare.com' }),
      expect.anything(), // the accept transaction's executor
    );
  });

  it('hashes the chosen password', async () => {
    const h = build({ stored: invite() });
    await h.service.acceptInvite('token-abc', PASSWORD);
    const created = h.admins.create.mock.calls[0][0] as { passwordHash: string };
    expect(created.passwordHash).not.toBe(PASSWORD);
    expect(created.passwordHash).not.toContain(PASSWORD);
  });

  it('marks the invite spent, so the link dies on first use', async () => {
    const h = build({ stored: invite() });
    await h.service.acceptInvite('token-abc', PASSWORD);
    // The CLAIM is the spend now — conditional on `accepted = false`, inside
    // the accept transaction, so two racing accepts cannot both pass.
    expect(h.invites.claim).toHaveBeenCalledWith('token-abc', expect.anything());
  });

  it('falls back to a minimal permission set when the invite carries none', async () => {
    const h = build({ stored: invite({ permissions: undefined }) });
    await h.service.acceptInvite('token-abc', PASSWORD);
    const created = h.admins.create.mock.calls[0][0] as { permissions: string[] };
    expect(created.permissions).not.toContain('*');
    expect(created.permissions.length).toBeGreaterThan(0);
  });

  it('does NOT sign the new admin in: the authenticator is set up first (0191)', async () => {
    const h = build({ stored: invite() });
    const result = await h.service.acceptInvite('token-abc', PASSWORD);
    // Required for every administrator, the newcomer included: no session
    // family exists until a code from their app has checked.
    expect(h.refreshTokens.record).not.toHaveBeenCalled();
    expect(result).toMatchObject({ step: 'totp_setup', challengeToken: expect.any(String) });
  });

  it('never returns the password hash of the account it just made', async () => {
    const h = build({ stored: invite() });
    const result = await h.service.acceptInvite('token-abc', PASSWORD);
    expect(JSON.stringify(result)).not.toMatch(/passwordHash|\$argon2|\$2[aby]\$/);
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('visibility at INVITE time runs the updateAdmin rulebook', () => {
  /*
   * The invite path used to check permissions only, so an `admins.create`
   * holder could hand out a territory or a mask that the
   * edit path would refuse them. One rulebook, both doors.
   */
  const SCOPER: AuthenticatedAdmin = {
    ...MASTER,
    id: 'scoper-1',
    email: 'scoper@oxshare.com',
    role: 'sub_admin',
    permissions: ['admins.create', 'admins.scope', 'kyc.review', 'admins.view'],
  };

  it('refuses a territory from an inviter without admins.scope', async () => {
    const h = build();
    await expect(
      h.service.createInvite(
        'new@oxshare.com',
        'New',
        SUB_ADMIN, // holds admins.create but NOT admins.scope
        undefined,
        ['kyc.review'],
        undefined,
        ['tag-1'],
      ),
    ).rejects.toThrow(AuthorizationError);
    expect(h.invites.create).not.toHaveBeenCalled();
  });

  it('holds the mask to the SUPERSET rule: you cannot invite sight you do not have', async () => {
    const h = build();
    const masked: AuthenticatedAdmin = { ...SCOPER, fieldMask: ['client.phone'] };
    await expect(
      h.service.createInvite(
        'new@oxshare.com',
        'New',
        masked,
        undefined,
        ['kyc.review'],
        // Reveals the phone the inviter cannot see themselves.
        ['client.email'],
      ),
    ).rejects.toThrow(AuthorizationError);
    expect(h.invites.create).not.toHaveBeenCalled();
  });

  it('an EMPTY territory list means no territory tags — never every client (0154)', async () => {
    // It used to be normalised to "absent", which from this inviter meant
    // UNRESTRICTED: the widest sight, from an empty list.
    const h = build();
    await h.service.createInvite(
      'new@oxshare.com',
      'New',
      MASTER,
      undefined,
      ['kyc.review'],
      undefined,
      [],
    );
    expect(h.invites.create).toHaveBeenCalledWith(
      expect.objectContaining({ scopedTagIds: [], seesAllClients: false }),
    );
  });

  it('lets a SCOPED inviter send an empty list — it narrows, it cannot widen (0154)', async () => {
    const h = build();
    const scopedInviter = {
      ...MASTER,
      permissions: ['admins.create', 'admins.scope', 'kyc.review'],
      clientScope: { unrestricted: false, tagIds: ['tag-1'] },
    };
    await h.service.createInvite(
      'narrow@oxshare.com',
      'Narrow',
      scopedInviter,
      undefined,
      ['kyc.review'],
      undefined,
      [],
    );
    expect(h.invites.create).toHaveBeenCalledWith(
      expect.objectContaining({ scopedTagIds: [], seesAllClients: false }),
    );
  });

  it('REFUSES every-client sight from an inviter who does not have it', async () => {
    const h = build();
    const scopedInviter = {
      ...MASTER,
      permissions: ['admins.create', 'admins.scope', 'kyc.review'],
      clientScope: { unrestricted: false, tagIds: ['tag-1'] },
    };
    await expect(
      h.service.createInvite(
        'wide@oxshare.com',
        'Wide',
        scopedInviter as never,
        undefined,
        ['kyc.review'],
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow(AuthorizationError);
    expect(h.invites.create).not.toHaveBeenCalled();
  });

  it('gives a SILENT scoped inviter their OWN territory, never an unrestricted one', async () => {
    /*
     * The other half of the laundering above, and the half that was open.
     *
     * `[]` from a scoped inviter is refused by name. ABSENT was not: the
     * `admins.scope` gate and `assertScopable` are both conditioned on
     * `scopedTagIds !== undefined`, so omitting the field entirely skipped both
     * and stored `undefined` — and an invite carrying no territory produces an
     * admin with NO scope rows, which this system defines as UNRESTRICTED.
     *
     * So a scoped sub-admin holding `admins.create` could mint a colleague who
     * saw EVERY client, by leaving a field out. `[]` and absent are two
     * spellings of "I chose no territory" and they had opposite security
     * outcomes — and the admin console sends the UNSAFE one: invite-admin-modal
     * spreads `...(scopedTagIds.length > 0 ? { scopedTagIds } : {})`, so
     * picking no tags omits the key rather than sending an empty array.
     *
     * Refusing would be defensible, but the DEFAULT bends to the subset rule
     * instead, exactly as the intake grant's does two lines below it in the
     * service: a silent scoped inviter hands on the territory they hold.
     */
    const h = build();
    const scopedInviter = {
      ...MASTER,
      // Holds `kyc.review` so `assertGrantable` passes and this test reaches
      // the scope logic it is actually about. Notably does NOT hold
      // `admins.scope`: the inheritance below is the system's default, not a
      // visibility choice the actor is making.
      permissions: ['admins.create', 'kyc.review'],
      clientScope: { unrestricted: false, tagIds: ['tag-1', 'tag-2'] },
    };
    await h.service.createInvite(
      'silent@oxshare.com',
      'Silent',
      scopedInviter,
      undefined,
      ['kyc.review'],
      // No mask, NO TERRITORY — every visibility field absent.
    );
    expect(h.invites.create).toHaveBeenCalledWith(
      expect.objectContaining({ scopedTagIds: ['tag-1', 'tag-2'] }),
    );
  });

  it('leaves a silent UNRESTRICTED inviter unrestricted — the default is not a cap', async () => {
    // The guard above must not turn "no territory" into a territory for an
    // actor entitled to grant sight of everything; that would quietly stop
    // master admins from being able to invite another one.
    const h = build();
    await h.service.createInvite('open@oxshare.com', 'Open', MASTER, undefined, ['kyc.review']);
    expect(h.invites.create).toHaveBeenCalledWith(
      expect.objectContaining({ scopedTagIds: undefined }),
    );
  });

  it('stores the full visibility choice for the acceptance to carry', async () => {
    const h = build();
    await h.service.createInvite(
      'new@oxshare.com',
      'New',
      SCOPER,
      undefined,
      ['kyc.review'],
      undefined,
      ['tag-1'],
      true,
    );
    expect(h.invites.create).toHaveBeenCalledWith(
      expect.objectContaining({ scopedTagIds: ['tag-1'] }),
    );
  });
});
