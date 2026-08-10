import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { NotFoundError } from '../src/common/errors/domain-errors';
import { decodeCursor } from '../src/common/pagination';
import { NotificationsStore, type NotificationRecipient } from '../src/store/notifications.store';

/**
 * The notifications table's contract, against real Postgres.
 *
 * The properties pinned here are the ones the dispatch port's callers lean on:
 * the dedupe index absorbing an at-least-once replay (a webhook that settles a
 * deposit can fire twice), the insert committing or rolling back WITH the
 * caller's transaction, and ownership being the WHERE clause rather than a
 * post-fetch check. None of those exist in a mock.
 */

let ctx: MoneyTestContext;
let store: NotificationsStore;

const CLIENT_A: NotificationRecipient = {
  kind: 'client',
  id: '11111111-1111-1111-1111-111111111111',
};
const CLIENT_B: NotificationRecipient = {
  kind: 'client',
  id: '22222222-2222-2222-2222-222222222222',
};
const ADMIN: NotificationRecipient = { kind: 'admin', id: '33333333-3333-3333-3333-333333333333' };

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  resetDb();
  store = new NotificationsStore(ctx.db);
});

afterAll(async () => {
  await closeDb();
  if (ctx) await stopMoneyTestDb(ctx);
});

describe('dedupe — idempotency lives in the constraint (§6.3)', () => {
  it('absorbs a replayed insert with the same dedupe key', async () => {
    const input = {
      recipient: CLIENT_A,
      kind: 'deposit.succeeded',
      params: { transactionId: 'tx-1', amount: '25.00000000', currency: 'USD' },
      dedupeKey: 'deposit.succeeded:tx-1',
    };

    expect(await store.insert(input)).toBe(true);
    // The replay: same event, redelivered. One row, and the caller can tell.
    expect(await store.insert(input)).toBe(false);

    const page = await store.findPage(CLIENT_A);
    expect(page.items.filter((n) => n.kind === 'deposit.succeeded')).toHaveLength(1);
  });

  it('scopes the dedupe key to the recipient — the same event may notify two people', async () => {
    const event = {
      kind: 'commission.confirmed',
      params: { accrualId: 'acc-1', amount: '5.00000000', currency: 'USD' },
      dedupeKey: 'commission.confirmed:acc-1',
    };
    expect(await store.insert({ recipient: CLIENT_A, ...event })).toBe(true);
    expect(await store.insert({ recipient: CLIENT_B, ...event })).toBe(true);
  });

  it('lets rows without a dedupe key repeat', async () => {
    const input = { recipient: CLIENT_A, kind: 'kyc.rejected', params: { reason: 'blurry' } };
    expect(await store.insert(input)).toBe(true);
    expect(await store.insert(input)).toBe(true);
  });
});

describe('insertMany — one statement, per-row dedupe', () => {
  it('fans one event to many recipients and absorbs the already-notified ones', async () => {
    const event = {
      kind: 'admin.withdrawal.requested',
      params: { transactionId: 'tx-fan' },
      dedupeKey: 'admin.withdrawal.requested:tx-fan',
    };
    const newcomer: NotificationRecipient = {
      kind: 'admin',
      id: '88888888-8888-8888-8888-888888888888',
    };
    // First delivery reaches both; the replay re-lists BOTH plus a newcomer —
    // only the newcomer lands, per-row, without disturbing the others.
    expect(await store.insertMany([CLIENT_A, CLIENT_B], event)).toBe(2);
    expect(await store.insertMany([CLIENT_A, CLIENT_B, newcomer], event)).toBe(1);
    expect(await store.insertMany([], event)).toBe(0);
  });
});

describe('transactional insert — the row commits with the caller or not at all', () => {
  it('leaves no row behind when the surrounding transaction rolls back', async () => {
    await ctx.db
      .transaction(async (tx) => {
        await store.insert({ recipient: CLIENT_B, kind: 'withdrawal.approved', params: {} }, tx);
        throw new Error('the domain change failed after the notify');
      })
      .catch(() => undefined);

    const page = await store.findPage(CLIENT_B);
    expect(page.items.some((n) => n.kind === 'withdrawal.approved')).toBe(false);
  });
});

describe('read markers', () => {
  it('markRead is idempotent and unreadCount reflects it', async () => {
    await store.insert({ recipient: ADMIN, kind: 'admin.kyc.submitted', params: { userId: 'u' } });
    const [row] = (await store.findPage(ADMIN)).items;
    expect(await store.unreadCount(ADMIN)).toBe(1);

    const first = await store.markRead(ADMIN, row.id);
    expect(first.readAt).not.toBeNull();
    expect(await store.unreadCount(ADMIN)).toBe(0);

    // Second call: same row back, no error, readAt still set.
    const second = await store.markRead(ADMIN, row.id);
    expect(second.readAt).not.toBeNull();
  });

  it("refuses another recipient's row as NOT FOUND — ownership is the WHERE clause", async () => {
    await store.insert({ recipient: CLIENT_A, kind: 'kyc.approved', params: {} });
    const [row] = (await store.findPage(CLIENT_A)).items;

    // CLIENT_B guessing CLIENT_A's uuid must learn "no such notification",
    // never "exists but not yours".
    await expect(store.markRead(CLIENT_B, row.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('markAllRead touches only the recipient and only unread rows', async () => {
    const recipient: NotificationRecipient = {
      kind: 'client',
      id: '44444444-4444-4444-4444-444444444444',
    };
    await store.insert({ recipient, kind: 'a', params: {} });
    await store.insert({ recipient, kind: 'b', params: {} });
    await store.insert({ recipient: CLIENT_A, kind: 'c', params: {} });

    const before = await store.unreadCount(CLIENT_A);
    expect(await store.markAllRead(recipient)).toBe(2);
    expect(await store.unreadCount(recipient)).toBe(0);
    // The other recipient's unread set is untouched.
    expect(await store.unreadCount(CLIENT_A)).toBe(before);
    // Idempotent.
    expect(await store.markAllRead(recipient)).toBe(0);
  });
});

describe('keyset paging', () => {
  it('pages without gaps or duplicates, newest first', async () => {
    const recipient: NotificationRecipient = {
      kind: 'client',
      id: '55555555-5555-5555-5555-555555555555',
    };
    for (let i = 0; i < 7; i++) {
      await store.insert({ recipient, kind: `event.${i}`, params: {} });
    }

    const first = await store.findPage(recipient, { limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();

    const second = await store.findPage(recipient, {
      limit: 3,
      cursor: decodeCursor(first.nextCursor as string),
    });
    const third = await store.findPage(recipient, {
      limit: 3,
      cursor: decodeCursor(second.nextCursor as string),
    });
    expect(third.nextCursor).toBeNull();

    const seen = [...first.items, ...second.items, ...third.items].map((n) => n.id);
    expect(new Set(seen).size).toBe(7);

    const times = [...first.items, ...second.items, ...third.items].map((n) =>
      n.createdAt.getTime(),
    );
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });

  it('unreadOnly filters read rows out of the feed', async () => {
    const recipient: NotificationRecipient = {
      kind: 'client',
      id: '66666666-6666-6666-6666-666666666666',
    };
    await store.insert({ recipient, kind: 'read.one', params: {} });
    await store.insert({ recipient, kind: 'unread.one', params: {} });
    const readTarget = (await store.findPage(recipient)).items.find((n) => n.kind === 'read.one');
    await store.markRead(recipient, (readTarget as { id: string }).id);

    const unread = await store.findPage(recipient, { unreadOnly: true });
    expect(unread.items.map((n) => n.kind)).toEqual(['unread.one']);
  });
});

describe('retention', () => {
  it('prunes only rows older than the window', async () => {
    const recipient: NotificationRecipient = {
      kind: 'client',
      id: '77777777-7777-7777-7777-777777777777',
    };
    await store.insert({ recipient, kind: 'fresh', params: {} });
    // Age one row past the window directly — the store exposes no way to
    // write history, which is the point.
    await store.insert({ recipient, kind: 'stale', params: {}, dedupeKey: 'stale:1' });
    const { sql } = await import('drizzle-orm');
    await ctx.db.execute(
      sql`UPDATE notifications SET created_at = now() - interval '91 days' WHERE kind = 'stale'`,
    );

    const pruned = await store.pruneOlderThan(90);
    expect(pruned).toBeGreaterThanOrEqual(1);

    const kinds = (await store.findPage(recipient)).items.map((n) => n.kind);
    expect(kinds).toContain('fresh');
    expect(kinds).not.toContain('stale');
  });
});
