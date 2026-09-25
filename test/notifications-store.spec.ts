import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { NotFoundError } from '../src/common/errors/domain-errors';
import { decodeCursor } from '../src/common/pagination';
import { sql } from 'drizzle-orm';
import { NotificationsStore } from '../src/store/notifications.store';

/** The generic insert writes client rows only — an admin row is a task (0140). */
type NotificationRecipient = { kind: 'client'; id: string };

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
const CLIENT_C: NotificationRecipient = {
  kind: 'client',
  id: '33333333-3333-3333-3333-333333333333',
};
const ADMIN_1 = 'a1111111-1111-4111-8111-111111111111';
const ADMIN_2 = 'a2222222-2222-4222-8222-222222222222';
const ADMIN_3 = 'a3333333-3333-4333-8333-333333333333';

/** A client with a KYC submission in `status` — a real item for a task to be about. */
async function kycSubject(email: string, status: 'submitted' | 'approved'): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', 'Task', 'Subject') RETURNING id`);
  const id = rows[0].id;
  await ctx.db.execute(
    sql`INSERT INTO kyc_submissions (user_id, status) VALUES (${id}, ${status})`,
  );
  return id;
}

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

describe('insertAdminTask — one statement, per-row dedupe, only while still open', () => {
  it('fans one task to many admins and absorbs the already-told ones', async () => {
    const userId = await kycSubject('task-fan@oxshare-e2e.test', 'submitted');
    const task = {
      kind: 'admin.kyc.submitted',
      params: { userId },
      dedupeKey: `admin.kyc.submitted:${userId}`,
      subjectKind: 'kyc' as const,
      subjectId: userId,
      subjectUserId: userId,
      stillOpen: 'awaiting-review' as const,
    };
    // First delivery reaches both; the replay re-lists BOTH plus a newcomer —
    // only the newcomer lands, per-row, without disturbing the others.
    expect(await store.insertAdminTask([ADMIN_1, ADMIN_2], task)).toBe(2);
    expect(await store.insertAdminTask([ADMIN_1, ADMIN_2, ADMIN_3], task)).toBe(1);
    expect(await store.insertAdminTask([], task)).toBe(0);
  });

  it('writes NOTHING for an item already handled — the race that left tasks open forever', async () => {
    /*
     * The fan-out runs after the submission committed. An admin who decided
     * in between would have left rows no trigger could ever resolve. The share
     * lock + re-check is what stops that: a handled item rings nobody.
     */
    const userId = await kycSubject('task-late@oxshare-e2e.test', 'approved');
    const written = await store.insertAdminTask([ADMIN_1], {
      kind: 'admin.kyc.submitted',
      params: { userId },
      subjectKind: 'kyc',
      subjectId: userId,
      subjectUserId: userId,
      stillOpen: 'awaiting-review',
    });
    expect(written).toBe(0);
  });

  it('refuses an admin row that names no subject — the CHECK, beneath the types', async () => {
    const error: unknown = await ctx.db
      .execute(
        sql`
        INSERT INTO notifications (recipient_kind, recipient_id, kind)
        VALUES ('admin', ${ADMIN_1}, 'admin.kyc.submitted')`,
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    // Drizzle wraps the driver's error; the constraint name is on the cause.
    const cause = (error as { cause?: { constraint?: string } } | undefined)?.cause;
    expect(cause?.constraint).toBe('notifications_admin_subject_ck');
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
    await store.insert({ recipient: CLIENT_C, kind: 'kyc.approved', params: {} });
    const [row] = (await store.findPage(CLIENT_C)).items;
    expect(await store.unreadCount(CLIENT_C)).toBe(1);

    const first = await store.markRead(CLIENT_C, row.id);
    expect(first.readAt).not.toBeNull();
    expect(await store.unreadCount(CLIENT_C)).toBe(0);

    // Second call: same row back, no error, readAt still set.
    const second = await store.markRead(CLIENT_C, row.id);
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

  it('markAllRead never marks past `upTo` — a row that arrived after the panel rendered stays unread', async () => {
    const recipient: NotificationRecipient = {
      kind: 'client',
      id: '45454545-4545-4545-4545-454545454545',
    };
    await store.insert({ recipient, kind: 'seen', params: {} });
    const [seen] = (await store.findPage(recipient)).items;
    await ctx.db.execute(
      sql`UPDATE notifications SET created_at = now() - interval '1 minute' WHERE id = ${seen.id}`,
    );
    const shownUpTo = new Date(Date.now() - 30_000);
    await store.insert({ recipient, kind: 'arrived-later', params: {} });

    expect(await store.markAllRead(recipient, shownUpTo)).toBe(1);
    const unread = await store.findPage(recipient, { unreadOnly: true });
    expect(unread.items.map((n) => n.kind)).toEqual(['arrived-later']);
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
    await ctx.db.execute(
      sql`UPDATE notifications SET created_at = now() - interval '91 days' WHERE kind = 'stale'`,
    );

    const pruned = await store.pruneOlderThan('client', 90);
    expect(pruned).toBeGreaterThanOrEqual(1);

    const kinds = (await store.findPage(recipient)).items.map((n) => n.kind);
    expect(kinds).toContain('fresh');
    expect(kinds).not.toContain('stale');
  });
});

describe('retention is per audience', () => {
  it('keeps an admin task for its year while pruning what is older', async () => {
    const userId = await kycSubject('task-retention@oxshare-e2e.test', 'submitted');
    await store.insertAdminTask([ADMIN_1], {
      kind: 'admin.kyc.resubmitted',
      params: { userId },
      subjectKind: 'kyc',
      subjectId: userId,
      subjectUserId: userId,
      stillOpen: 'awaiting-review',
    });
    await ctx.db.execute(sql`
      UPDATE notifications SET created_at = now() - interval '200 days'
       WHERE kind = 'admin.kyc.resubmitted' AND subject_id = ${userId}`);

    // A client-window prune never touches admin rows…
    await store.pruneOlderThan('client', 90);
    // …and 200 days is inside the admin year.
    expect(await store.pruneOlderThan('admin', 365)).toBe(0);

    await ctx.db.execute(sql`
      UPDATE notifications SET created_at = now() - interval '400 days'
       WHERE kind = 'admin.kyc.resubmitted' AND subject_id = ${userId}`);
    expect(await store.pruneOlderThan('admin', 365)).toBe(1);
  });
});
