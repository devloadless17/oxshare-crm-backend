import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { anonymous, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { users } from '../src/database/schema';
import { clientIdentitySearch, phoneSearchTerm } from '../src/store/users.store';
import { SIGN_UP_DETAILS } from './support/registration';

/**
 * ONE CLIENT PER PHONE, AND A CLIENT FOUND BY PHONE (0194, the buyer's demo).
 *
 * Staff must find a client by the number they were called from, which only
 * works if a number names one person. Sign-up refuses a taken number on the
 * phone field (409 `PHONE_ALREADY_REGISTERED`); two sign-ups racing for one
 * number are decided by `users_phone_unique` and the loser gets the SAME answer
 * — not "email taken", which is what any unique violation used to read as.
 * Every client search box then finds the client by that number, typed with or
 * without its country code; a reader whose role hides the phone finds them only
 * by the COMPLETE number, never by a fragment.
 */

let ctx: HttpTestContext;
const ORIGIN = process.env['PORTAL_URL'] ?? 'http://localhost:3000';
const REGISTER = '/v1/auth/register';

const signUp = (email: string, phone: string) =>
  anonymous(ctx)
    .post(REGISTER)
    .set('Origin', ORIGIN)
    .send({
      firstName: 'Phone',
      lastName: 'Probe',
      email,
      password: 'probe-password-123',
      ...SIGN_UP_DETAILS,
      phone,
    });

const mail = (tag: string) => `phone-${tag}-${Date.now()}-${Math.random()}@oxshare-e2e.test`;

async function idsFor(q: string, mask: string[] = []): Promise<number[]> {
  const { rows } = await ctx.db.db.execute<{ id: number }>(sql`
    SELECT ${users.id} AS id FROM ${users} WHERE ${clientIdentitySearch(q, users, mask)} ORDER BY id
  `);
  return rows.map((r) => Number(r.id));
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('sign-up with a phone another client holds', () => {
  it('is refused on the phone field, however the number is typed', async () => {
    expect((await signUp(mail('first'), '+961 70 555 101')).status).toBe(201);

    const again = await signUp(mail('second'), '+96170555101');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PHONE_ALREADY_REGISTERED');
    expect(again.body.fields?.phone).toMatch(/already used/i);

    const holders = await ctx.db.db.select().from(users).where(eq(users.phone, '+96170555101'));
    expect(holders).toHaveLength(1);
  });

  it('a race is decided by the index and answered as a PHONE clash, not an email one', async () => {
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) => signUp(mail(`race-${i}`), '+96170555202')),
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('PHONE_ALREADY_REGISTERED');
    }
  });

  it('still registers a different number (positive control)', async () => {
    expect((await signUp(mail('other'), '+96170555303')).status).toBe(201);
  });
});

describe('every client search finds a client by phone', () => {
  let holder: number;

  beforeAll(async () => {
    const [row] = await ctx.db.db
      .insert(users)
      .values({
        email: mail('search'),
        passwordHash: 'x',
        firstName: 'Search',
        lastName: 'Byphone',
        phone: '+96178123987',
      })
      .returning({ id: users.id });
    holder = row.id;
  });

  it.each([
    ['+96178123987'],
    ['+961 78 123 987'],
    ['0096178123987'],
    ['78 123 987'],
    ['78-123987'],
    ['(78) 123987'],
  ])('finds them by %s', async (q) => {
    expect(await idsFor(q)).toContain(holder);
  });

  it('a Portal ID still finds its client, and "#" means the Portal ID alone', async () => {
    expect(await idsFor(String(holder))).toContain(holder);
    expect(await idsFor(`#${holder}`)).toEqual([holder]);
  });

  it('too few digits are not a phone search', () => {
    expect(phoneSearchTerm('12345')).toBeUndefined();
    expect(phoneSearchTerm('ab 123456')).toBeUndefined();
  });

  it('a HIDDEN phone is never matched by a fragment — only by the complete number', async () => {
    const mask = ['client.phone'];
    expect(await idsFor('78 123 987', mask)).not.toContain(holder);
    expect(await idsFor('123987', mask)).not.toContain(holder);
    expect(await idsFor('+961 78 123 987', mask)).toEqual([holder]);
  });

  it('a local number reads the reversed-phone index (a suffix), not every client', async () => {
    // One connection: a pooled SET would land on another session than the EXPLAIN.
    const plan = await ctx.db.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const { rows } = await tx.execute<{ 'QUERY PLAN': string }>(sql`
        EXPLAIN SELECT id FROM ${users} WHERE ${clientIdentitySearch('78123987', users, [])}
      `);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toMatch(/users_phone_reverse_idx/);
  });
});
