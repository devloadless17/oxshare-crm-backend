import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { adminClientTagScopes, admins, clientTags, roles } from '../src/database/schema';

/**
 * The configuration screens count people per setting — clients per tag,
 * partners per IB level, accounts per MT5 group, payouts per commission type —
 * and each set can cross the reader's territory. D-81 R2: the reader is told
 * how many they may see AND how many they may not, a count and never who.
 *
 * Client A is in the scoped reader's territory, client B is not, and B stands
 * beside A in every set. So each count must read 1 + 1 outside for the scoped
 * reader and 2 + 0 for one who sees everybody — and a refusal caused partly by
 * B must say that part is outside, never who it is.
 */

const SCOPED = { email: 'counts-scoped@oxshare.com', password: 'admin-password-123' };
const MASTER = { email: 'counts-master@oxshare.com', password: 'admin-password-123' };
const GROUP = 'real\\CountsTerritory';

let ctx: HttpTestContext;
let scoped: Session;
let master: Session;
let tagIn: string;
let tagOut: string;
let outId: number;
let typeId: string;

type Row = Record<string, unknown>;
const find = (rows: Row[], key: string, value: unknown) => rows.find((r) => r[key] === value)!;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const { db } = ctx.db;
  const passwords = new PasswordService();
  const [role] = await db
    .insert(roles)
    .values({ name: 'Counts All', permissions: [...ALL_PERMISSIONS] })
    .returning();
  const [scopedAdmin] = await db
    .insert(admins)
    .values({
      email: SCOPED.email,
      passwordHash: await passwords.hash(SCOPED.password),
      name: 'Counts Scoped',
      role: 'sub_admin',
      roleId: role.id,
      permissions: [],
      // Without this an untagged fixture would be visible through intake.
      status: 'active',
    })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Counts Master',
    role: 'sub_admin',
    roleId: role.id,
    permissions: [],
    status: 'active',
  });
  const tags = await db
    .insert(clientTags)
    .values([
      { slug: 'counts-in', label: 'Counts In' },
      { slug: 'counts-out', label: 'Counts Out' },
    ])
    .returning();
  tagIn = tags.find((t) => t.slug === 'counts-in')!.id;
  tagOut = tags.find((t) => t.slug === 'counts-out')!.id;
  await db
    .insert(adminClientTagScopes)
    .values({ adminId: scopedAdmin.id, tagId: tagIn, createdBy: scopedAdmin.id });

  const client = async (name: string, tag: string, login: string) => {
    const { rows } = await db.execute<{ id: number }>(sql`
      INSERT INTO users (email, password_hash, first_name, last_name)
      VALUES (${`counts-${name}@oxshare-e2e.test`}, 'x', 'Counts', ${name}) RETURNING id`);
    const id = rows[0].id;
    await db.execute(
      sql`INSERT INTO client_tag_assignments (user_id, tag_id) VALUES (${id}, ${tag})`,
    );
    await db.execute(sql`
      INSERT INTO ib_accounts (user_id, level, active, referral_code)
      VALUES (${id}, 1, true, ${`COUNTS${name.toUpperCase()}`})`);
    await db.execute(sql`
      INSERT INTO trading_accounts (user_id, login, currency, mt5_group)
      VALUES (${id}, ${login}, 'USD', ${GROUP})`);
    return id;
  };
  const inId = await client('in', tagIn, '88100001');
  outId = await client('out', tagOut, '88100002');

  await db.execute(sql`
    INSERT INTO ib_levels (level, name, commission_share, rebate_share)
    VALUES (1, 'Main', 10, 0) ON CONFLICT (level) DO NOTHING`);
  await db.execute(sql`INSERT INTO mt5_groups (name, currency) VALUES (${GROUP}, 'USD')`);
  const { rows: types } = await db.execute<{ id: string }>(sql`
    INSERT INTO ib_commission_types (name, commission_per_lot, rebate_per_lot)
    VALUES ('Counts Type', 5, 1) RETURNING id`);
  typeId = types[0].id;
  // A's commission, and a REBATE paid to B on A's rung: a payout belongs to its
  // BENEFICIARY, so the second one is outside the reader's territory although
  // its `ib_user_id` is A.
  await db.execute(sql`
    INSERT INTO ib_accruals (kind, ib_user_id, client_user_id, source_type, source_id, depth,
                             rate_value, base_amount, amount, currency, commission_type_id)
    VALUES ('commission', ${inId}, ${inId}, 'deal', gen_random_uuid(), 1, 10, 100, 10, 'USD', ${typeId}),
           ('rebate', ${inId}, ${outId}, 'deal', gen_random_uuid(), 1, 1, 100, 1, 'USD', ${typeId})`);

  scoped = await actingAs(ctx, 'admin', SCOPED);
  master = await actingAs(ctx, 'admin', MASTER);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('configuration counts are split by the reader’s territory (D-81 R2)', () => {
  it('tags: clients carrying each tag, in and outside the territory', async () => {
    const mine = (await scoped.get('/v1/admin/tags').expect(200)).body as Row[];
    expect(find(mine, 'id', tagIn)).toMatchObject({ clientCount: 1, clientsOutsideScope: 0 });
    expect(find(mine, 'id', tagOut)).toMatchObject({ clientCount: 0, clientsOutsideScope: 1 });
    const all = (await master.get('/v1/admin/tags').expect(200)).body as Row[];
    expect(find(all, 'id', tagOut)).toMatchObject({ clientCount: 1, clientsOutsideScope: 0 });
  });

  it('IB levels: partners on each rung, in and outside the territory', async () => {
    const mine = (await scoped.get('/v1/admin/ib-levels').expect(200)).body as Row[];
    expect(find(mine, 'level', 1)).toMatchObject({ partnerCount: 1, partnersOutsideScope: 1 });
    const all = (await master.get('/v1/admin/ib-levels').expect(200)).body as Row[];
    expect(find(all, 'level', 1)).toMatchObject({ partnerCount: 2, partnersOutsideScope: 0 });
  });

  it('MT5 groups: accounts in each group, in and outside the territory', async () => {
    const mine = (await scoped.get('/v1/admin/mt5-groups').expect(200)).body as Row[];
    expect(find(mine, 'name', GROUP)).toMatchObject({ accountCount: 1, accountsOutsideScope: 1 });
    const all = (await master.get('/v1/admin/mt5-groups').expect(200)).body as Row[];
    expect(find(all, 'name', GROUP)).toMatchObject({ accountCount: 2, accountsOutsideScope: 0 });
  });

  it('a refusal says how many are outside and that the reader cannot finish alone', async () => {
    const disable = await scoped.patch('/v1/admin/ib-levels/1').send({ enabled: false });
    expect(disable.status).toBe(409);
    expect(disable.body.message).toContain('2 partners (1 in your territory, 1 outside it) stand');
    expect(disable.body.message).toContain(
      'The one outside your territory needs an administrator who can see it.',
    );

    const remove = await scoped.del(`/v1/admin/ib-commission-types/${typeId}`);
    expect(remove.status).toBe(409);
    expect(remove.body.message).toContain('2 payouts (1 in your territory, 1 outside it)');

    // Told whole to a reader who sees everybody — no split to explain.
    const whole = await master.patch('/v1/admin/ib-levels/1').send({ enabled: false });
    expect(whole.status).toBe(409);
    expect(whole.body.message).toContain('2 partners stand on level 1');
  });

  it('never names who is outside — no Portal ID, email or login of B on any of it', async () => {
    const bodies = await Promise.all(
      ['/v1/admin/tags', '/v1/admin/ib-levels', '/v1/admin/mt5-groups'].map(async (path) =>
        JSON.stringify((await scoped.get(path).expect(200)).body),
      ),
    );
    for (const body of bodies) {
      expect(body).not.toContain(String(outId));
      expect(body).not.toContain('counts-out@');
      expect(body).not.toContain('88100002');
    }
  });
});
