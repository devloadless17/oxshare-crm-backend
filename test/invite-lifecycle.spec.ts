import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { AdminAuthService } from '../src/modules/admin/admin-auth.service';
import { AdminRbacService } from '../src/modules/admin/admin-rbac.service';
import { PasswordService } from '../src/common/security/password.service';
import { CsrfService } from '../src/common/security/csrf.service';
import type { EmailService } from '../src/modules/email/email.service';
import type { RefreshTokensService } from '../src/common/security/refresh-tokens.service';
import type { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import { hashInviteToken } from '../src/store/admins.store';
import type { Admin, AdminInvite, AdminsStore, InvitesStore } from '../src/store/admins.store';
import type { LoginAttemptsService } from '../src/common/security/login-attempts.service';
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

const MASTER: Admin = {
  id: 'master-1',
  email: 'admin@oxshare.com',
  name: 'Master',
  passwordHash: 'x',
  role: 'master_admin',
  status: 'active',
  permissions: ['*'],
  createdAt: new Date(),
};

const SUB_ADMIN: Admin = {
  ...MASTER,
  id: 'sub-1',
  email: 'sub@oxshare.com',
  role: 'sub_admin',
  permissions: ['kyc.review', 'users.view', 'users.create'],
};

const REVIEWER_ROLE: Role = {
  id: 'role-1',
  name: 'Reviewer',
  permissions: ['kyc.review'],
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

function fakeResponse() {
  const res = { cookie: () => res, clearCookie: () => res };
  return res as unknown as Response;
}

function build(
  options: { existingAdmin?: Admin; stored?: AdminInvite; env?: Record<string, string> } = {},
) {
  const admins = {
    findByEmail: vi.fn().mockResolvedValue(options.existingAdmin),
    findById: vi.fn().mockResolvedValue(options.existingAdmin),
    create: vi.fn((data: Partial<Admin>) => Promise.resolve({ id: 'admin-new', ...data } as Admin)),
    update: vi.fn(),
  };
  const invites = {
    create: vi.fn((data: Partial<AdminInvite>) =>
      Promise.resolve({ id: 'invite-1', ...data } as AdminInvite),
    ),
    findByToken: vi.fn().mockResolvedValue(options.stored),
    markAccepted: vi.fn().mockResolvedValue(undefined),
    findPendingByRoleId: vi.fn().mockResolvedValue([]),
    // Default: no invite outstanding for this address. The one-live-invite-per-
    // email rule is exercised explicitly in the suite below.
    findPendingByEmail: vi.fn().mockResolvedValue(undefined),
    findAllPending: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(options.stored),
    deleteById: vi.fn().mockResolvedValue(undefined),
  };
  const roles = {
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

  const rbac = new AdminRbacService(
    admins as unknown as AdminsStore,
    invites as unknown as InvitesStore,
    roles as unknown as RolesStore,
    audit as unknown as AdminAuditService,
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
  );

  return { service, admins, invites, roles, email, audit, refreshTokens };
}

describe('createInvite', () => {
  it('refuses an email that is already an admin', async () => {
    const h = build({ existingAdmin: SUB_ADMIN });
    await expect(
      h.service.createInvite('sub@oxshare.com', 'Dup', MASTER, undefined, ['kyc.review']),
    ).rejects.toThrow(ConflictError);
    expect(h.invites.create).not.toHaveBeenCalled();
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
      h.service.createInvite('new@oxshare.com', 'New', SUB_ADMIN, undefined, ['*']),
    ).rejects.toThrow(AuthorizationError);
    expect(h.invites.create).not.toHaveBeenCalled();
  });

  it('ANTI-ESCALATION: a sub-admin cannot invite a permission they do not hold', async () => {
    const h = build();
    await expect(
      h.service.createInvite('new@oxshare.com', 'New', SUB_ADMIN, undefined, [
        'withdrawals.approve',
      ]),
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
    await h.service.createInvite('new@oxshare.com', 'New', MASTER, 'role-1', ['*']);
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

  it('echoes the link outside production, to keep local development workable', async () => {
    const h = build({ env: { NODE_ENV: 'development' } });
    const result = await h.service.createInvite('new@oxshare.com', 'New', MASTER, undefined, [
      'kyc.review',
    ]);
    expect(result).toHaveProperty('inviteUrl');
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
    await expect(h.service.acceptInvite('nope', PASSWORD, fakeResponse())).rejects.toThrow(
      NotFoundError,
    );
    expect(h.admins.create).not.toHaveBeenCalled();
  });

  it('SINGLE USE: refuses a token that has already been accepted', async () => {
    // Otherwise one emailed link creates admin accounts without limit.
    const h = build({ stored: invite({ accepted: true }) });
    await expect(h.service.acceptInvite('token-abc', PASSWORD, fakeResponse())).rejects.toThrow(
      ValidationError,
    );
    expect(h.admins.create).not.toHaveBeenCalled();
  });

  it('refuses an expired token', async () => {
    const h = build({ stored: invite({ expiresAt: new Date(Date.now() - 1000) }) });
    await expect(h.service.acceptInvite('token-abc', PASSWORD, fakeResponse())).rejects.toThrow(
      /expired/i,
    );
    expect(h.admins.create).not.toHaveBeenCalled();
  });

  it('creates a sub_admin holding exactly the invited permissions', async () => {
    const h = build({ stored: invite({ permissions: ['kyc.review', 'users.view'] }) });
    await h.service.acceptInvite('token-abc', PASSWORD, fakeResponse());
    expect(h.admins.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'newcomer@oxshare.com',
        role: 'sub_admin',
        permissions: ['kyc.review', 'users.view'],
      }),
    );
  });

  it('takes the email from the INVITE, not from anything the caller supplies', async () => {
    // The caller only presents a token and a password. If the address were
    // caller-supplied, a leaked token would create an account under an attacker's
    // own email.
    const h = build({ stored: invite({ email: 'invited@oxshare.com' }) });
    await h.service.acceptInvite('token-abc', PASSWORD, fakeResponse());
    expect(h.admins.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'invited@oxshare.com' }),
    );
  });

  it('hashes the chosen password', async () => {
    const h = build({ stored: invite() });
    await h.service.acceptInvite('token-abc', PASSWORD, fakeResponse());
    const created = h.admins.create.mock.calls[0][0] as { passwordHash: string };
    expect(created.passwordHash).not.toBe(PASSWORD);
    expect(created.passwordHash).not.toContain(PASSWORD);
  });

  it('marks the invite spent, so the link dies on first use', async () => {
    const h = build({ stored: invite() });
    await h.service.acceptInvite('token-abc', PASSWORD, fakeResponse());
    expect(h.invites.markAccepted).toHaveBeenCalledWith('token-abc');
  });

  it('falls back to a minimal permission set when the invite carries none', async () => {
    const h = build({ stored: invite({ permissions: undefined }) });
    await h.service.acceptInvite('token-abc', PASSWORD, fakeResponse());
    const created = h.admins.create.mock.calls[0][0] as { permissions: string[] };
    expect(created.permissions).not.toContain('*');
    expect(created.permissions.length).toBeGreaterThan(0);
  });

  it('signs the new admin in, recording the refresh family', async () => {
    const h = build({ stored: invite() });
    await h.service.acceptInvite('token-abc', PASSWORD, fakeResponse());
    expect(h.refreshTokens.record).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'admin' }),
    );
  });

  it('never returns the password hash of the account it just made', async () => {
    const h = build({ stored: invite() });
    const result = await h.service.acceptInvite('token-abc', PASSWORD, fakeResponse());
    expect(JSON.stringify(result)).not.toMatch(/passwordHash|\$argon2|\$2[aby]\$/);
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
