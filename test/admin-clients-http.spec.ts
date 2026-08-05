import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles } from '../src/database/schema';

/**
 * The client directory's query surface — ADM-01.
 *
 * `?type=` and `?status=` reach POSTGRES ENUM columns, and `UsersStore.findPage`
 * casts them straight in (`eq(users.type, filter.type as 'individual')`). The
 * controller guards that with `enumQuery()`, the same helper the ledger view
 * uses for `entryType` — these are individual `@Query()` strings rather than a
 * DTO class, so the global ValidationPipe validates nothing here.
 *
 * WHAT THIS FILE PINS IS THE MESSAGE, NOT THE STATUS CODE, and that distinction
 * is the whole point. Two different layers answer 400 for a bad enum:
 *
 *   - `enumQuery` — 400 VALIDATION_FAILED, naming the field and listing the
 *     values it accepts;
 *   - `AllExceptionsFilter`, if the value gets through — Postgres raises 22P02
 *     and it is mapped to 400 INVALID_IDENTIFIER, "A value in the request is not
 *     a valid identifier", which says nothing about which value or why.
 *
 * A test asserting only `status === 400` passes either way. This one was written
 * that way first, and disabling `enumQuery` did not turn it red — the fallback
 * quietly covered for it. Asserting the helpful message is what makes the guard
 * real: the fallback is a safety net, not the contract, and an operator filtering
 * a client list deserves to be told which filter they got wrong.
 */

const ADMIN = { email: 'clients-http@oxshare.com', password: 'admin-password-123' };
const CLIENTS = '/v1/admin/clients';

let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Clients HTTP Master', permissions: ['*'], isSystem: true })
    .returning();

  await ctx.db.db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'Clients HTTP Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ['*'],
    status: 'active',
  });
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('filters are validated, not cast into the query', () => {
  it('names the field and the allowed values for an unknown ?status=', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?status=definitely-not-a-status`);
    const body = res.body as { code?: string; fields?: Record<string, string> };

    expect(res.status).toBe(400);
    // Not the INVALID_IDENTIFIER fallback — that is the net, not the contract.
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fields?.['status']).toMatch(/active/);
    expect(body.fields?.['status']).toMatch(/suspended/);
  });

  it('names the field and the allowed values for an unknown ?type=', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?type=definitely-not-a-type`);
    const body = res.body as { code?: string; fields?: Record<string, string> };

    expect(res.status).toBe(400);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.fields?.['type']).toMatch(/individual/);
  });

  it('still rejects an out-of-range ?level= — the one that was already guarded', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.get(`${CLIENTS}?level=7`).expect(400);
    await session.get(`${CLIENTS}?level=abc`).expect(400);
  });
});

describe('valid filters keep working', () => {
  it('accepts each real status', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    for (const status of ['active', 'pending', 'suspended']) {
      await session.get(`${CLIENTS}?status=${status}`).expect(200);
    }
  });

  it('accepts each real type', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    for (const type of ['individual', 'referral', 'partner']) {
      await session.get(`${CLIENTS}?type=${type}`).expect(200);
    }
  });

  it('accepts an empty filter, which is how the screen first loads', async () => {
    // An absent filter must not be confused with an invalid one.
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.get(CLIENTS).expect(200);
    await session.get(`${CLIENTS}?status=&type=&level=`).expect(200);
  });

  it('bounds the page size rather than trusting the querystring', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(`${CLIENTS}?limit=100000`).expect(200);
    const body = res.body as { limit: number };
    expect(body.limit).toBeLessThanOrEqual(100);
  });
});
