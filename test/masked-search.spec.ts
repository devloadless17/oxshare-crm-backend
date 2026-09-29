import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { UsersStore, CLIENT_SORT_COLUMNS } from '../src/store/users.store';
import { requestContext } from '../src/common/logging/request-context';
import { sortKey } from '../src/common/sorting';
import { ValidationError } from '../src/common/errors/domain-errors';
import type { FieldMask } from '../src/common/security/field-mask';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/*
 * D-82 — a field the reader's role hides cannot be learned by ASKING: not by a
 * fragment search, not by a filter, not by a sort. Each case attempts exactly
 * that. The one exception is the owner's: a COMPLETE email still finds its
 * client, because support already holds it (audited elsewhere).
 */

let ctx: MoneyTestContext;
let store: UsersStore;
const EMAIL = 'hidden.target@example.test';

// Async, so a synchronous refusal inside `run` arrives as a rejection.
async function as<T>(mask: FieldMask, run: () => Promise<T> | T): Promise<T> {
  return requestContext.run({ requestId: 'masked-search', fieldMask: mask }, run);
}

async function found(mask: FieldMask, q: string): Promise<string[]> {
  const page = await as(mask, () => store.findPage({ page: 1, limit: 10, q }));
  return page.rows.map((row: { email: string }) => row.email);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new UsersStore(ctx.db);
  await ctx.db.execute(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, country)
    VALUES (${EMAIL}, 'x', 'Zanele', 'Mokoena', 'ZA')`);
});

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('search obeys the mask', () => {
  it('unmasked: any fragment of the email or the name finds them (the control)', async () => {
    expect(await found([], 'hidden.tar')).toEqual([EMAIL]);
    expect(await found([], 'Zanele')).toEqual([EMAIL]);
  });

  it('email hidden: no fragment of it matches, the complete address does, names still do', async () => {
    const mask = ['client.email'];
    expect(await found(mask, 'hidden')).toEqual([]);
    expect(await found(mask, 'example.test')).toEqual([]);
    expect(await found(mask, 'hidden.target@example')).toEqual([]);
    expect(await found(mask, ` ${EMAIL.toUpperCase()} `)).toEqual([EMAIL]);
    expect(await found(mask, 'Mokoena')).toEqual([EMAIL]);
  });

  it('name hidden: no fragment of it matches, and there is no exact-name lookup', async () => {
    const mask = ['client.firstName'];
    expect(await found(mask, 'Zanele')).toEqual([]);
    expect(await found(mask, 'Mokoena')).toEqual([]);
    expect(await found(mask, 'Zanele Mokoena')).toEqual([]);
    expect(await found(mask, 'hidden.tar')).toEqual([EMAIL]);
  });

  it('everything hidden: only the complete email (and the Portal ID) can find them', async () => {
    const mask = ['client.email', 'client.firstName', 'client.lastName'];
    expect(await found(mask, 'hidden')).toEqual([]);
    expect(await found(mask, 'Zanele')).toEqual([]);
    expect(await found(mask, EMAIL)).toEqual([EMAIL]);
  });
});

describe('filter and sort obey the mask', () => {
  it('refuses to sort by a hidden column, and allows it when visible', async () => {
    await expect(
      as(['client.email'], () => sortKey('email', CLIENT_SORT_COLUMNS, 'createdAt', 'clients')),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      as(['client.createdAt'], () =>
        sortKey('createdAt', CLIENT_SORT_COLUMNS, 'createdAt', 'clients'),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await as([], () => sortKey('email', CLIENT_SORT_COLUMNS, 'createdAt', 'clients'))).toBe(
      'email',
    );
  });

  it('refuses to filter by a hidden country', async () => {
    await expect(
      as(['client.country'], () => store.findPage({ page: 1, limit: 10, country: 'ZA' })),
    ).rejects.toBeInstanceOf(ValidationError);
    const visible = await as([], () => store.findPage({ page: 1, limit: 10, country: 'ZA' }));
    expect(visible.rows).toHaveLength(1);
  });
});
