import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../src/modules/identity/auth.service';
import type { EmailService } from '../src/modules/email/email.service';
import type { RefreshTokensService } from '../src/common/security/refresh-tokens.service';
import type { LoginAttemptsService } from '../src/common/security/login-attempts.service';
import { PasswordService } from '../src/common/security/password.service';
import { CsrfService } from '../src/common/security/csrf.service';
import { StoredFilesService } from '../src/common/uploads/stored-files.service';
import { UsersStore } from '../src/store/users.store';
import { ClientTagsStore } from '../src/store/client-tags.store';
import { clientTagAssignments, clientTags } from '../src/database/schema';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * D-60 — every registration lands in the intake territory.
 *
 * Row-level scoping (D-45) hides untagged clients from every tag-scoped
 * admin, so before this a fresh registration was visible only to unrestricted
 * admins: an invisible pool nobody's territory covered. Migration 0055 makes
 * "new client" a real tag and `AuthService.register` attaches it, which turns
 * intake into a territory like any other — scope the intake team to
 * `new-client` and they see every registrant the moment it exists.
 *
 * Against a REAL database, because the property is a row in
 * `client_tag_assignments` with a NULL `assigned_by` (the system acted, not
 * an admin) joined to the tag migration 0055 guarantees — a stubbed store
 * would prove only that the stub was configured to agree.
 */

const SECRETS: Record<string, string> = {
  ADMIN_JWT_SECRET: 'admin-secret-at-least-32-characters-long',
  JWT_ACCESS_SECRET: 'access-secret-at-least-32-characters-long',
  JWT_REFRESH_SECRET: 'refresh-secret-at-least-32-chars-long!',
  PORTAL_URL: 'http://localhost:3000',
  ADMIN_URL: 'http://localhost:3002',
};

const config = {
  get: (key: string) => SECRETS[key],
  getOrThrow: (key: string) => {
    const value = SECRETS[key];
    if (value === undefined) throw new Error(`missing config: ${key}`);
    return value;
  },
} as unknown as ConfigService;

let ctx: MoneyTestContext;
let service: AuthService;
let tags: ClientTagsStore;

/**
 * `register` answers the same shape whether or not the address was taken
 * (enumeration resistance), so the id needs narrowing before it can be used.
 */
function registeredId(result: Awaited<ReturnType<AuthService['register']>>): string {
  if (!('userId' in result)) throw new Error('registration did not create an account');
  return result.userId;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const users = new UsersStore(ctx.db);
  tags = new ClientTagsStore(ctx.db);

  const email = {
    sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    sendAccountExistsEmail: vi.fn().mockResolvedValue(undefined),
  } as unknown as EmailService;
  const refreshTokens = {
    record: vi.fn().mockResolvedValue(undefined),
    revokeAllForSubject: vi.fn().mockResolvedValue(undefined),
  } as unknown as RefreshTokensService;
  const loginAttempts = {
    lockedFor: vi.fn().mockResolvedValue(null),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
  } as unknown as LoginAttemptsService;

  service = new AuthService(
    new JwtService({}),
    config,
    email,
    users,
    new CsrfService(config),
    refreshTokens,
    new PasswordService(),
    loginAttempts,
    new StoredFilesService(),
    undefined, // ib — referrals are not this spec's subject
    undefined, // wallet provisioning — nor are wallets
    tags,
  );
});

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('the intake tag (D-60)', () => {
  it('is guaranteed by migration 0055', async () => {
    const tag = await tags.findBySlug(ClientTagsStore.NEW_CLIENT_SLUG);
    expect(tag, 'migration 0055 did not seed the new-client tag').toBeDefined();
  });

  it('is attached to every registration, as the SYSTEM, not an admin', async () => {
    const result = await service.register({
      email: 'intake-walk@oxshare-e2e.test',
      password: 'a-good-password-123',
      firstName: 'Intake',
      lastName: 'Walk',
    });
    const userId = registeredId(result);

    const [assignment] = await ctx.db
      .select({
        tagSlug: clientTags.slug,
        assignedBy: clientTagAssignments.assignedBy,
      })
      .from(clientTagAssignments)
      .innerJoin(clientTags, eq(clientTags.id, clientTagAssignments.tagId))
      .where(eq(clientTagAssignments.userId, userId));

    expect(assignment, 'the registration carried no intake tag').toBeDefined();
    expect(assignment?.tagSlug).toBe(ClientTagsStore.NEW_CLIENT_SLUG);
    // NULL, deliberately: no administrator performed this assignment, and the
    // audit answer to "who tagged this client" must not name one.
    expect(assignment?.assignedBy).toBeNull();
  });

  it('never fails a registration over its tagging', async () => {
    // The operator deleted the tag (they can — it is an ordinary tag). The
    // account MUST still be created; the client lands in the unrestricted
    // pool and the log says why.
    const tag = await tags.findBySlug(ClientTagsStore.NEW_CLIENT_SLUG);
    await ctx.db.delete(clientTagAssignments).where(eq(clientTagAssignments.tagId, tag!.id));
    await ctx.db.delete(clientTags).where(eq(clientTags.id, tag!.id));

    const result = await service.register({
      email: 'intake-untagged@oxshare-e2e.test',
      password: 'a-good-password-123',
      firstName: 'No',
      lastName: 'Tag',
    });
    const userId = registeredId(result);

    const rows = await ctx.db
      .select()
      .from(clientTagAssignments)
      .where(eq(clientTagAssignments.userId, userId));
    expect(rows).toEqual([]);
  });
});
