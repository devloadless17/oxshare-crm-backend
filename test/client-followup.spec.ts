import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, auditLog, clientFollowups, roles, users } from '../src/database/schema';

/**
 * A client's Follow-up and Result (0212) — the staff's two notes.
 *
 * What must hold, because a note lost without a word is the failure that matters:
 *   - a save made from an older version is REFUSED (409) and changes nothing;
 *   - two first saves racing each other cannot both win;
 *   - every change leaves an audit row, before and after, in the same transaction;
 *   - reading needs `clients.view`, writing needs `clients.followup.edit`;
 *   - the clients list carries the notes and filters by the follow-up date.
 * Territory (out of scope is 404) is driven by `client-scope-enforcement.spec.ts`.
 */

const EDITOR = { email: 'followup-editor@oxshare.com', password: 'admin-password-123' };
const READER = { email: 'followup-reader@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
let editorId: string;
let clientId: number;
let dueId: number;
let upcomingId: number;
let raceId: number;

const DAY = 24 * 60 * 60 * 1000;

interface FollowUpBody {
  followUp: string | null;
  result: string | null;
  followUpAt: string | null;
  version: number;
  updatedBy: { id: string; name: string } | null;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [editorRole] = await db
    .insert(roles)
    .values({ name: 'Follow-up Editor', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  const [editor] = await db
    .insert(admins)
    .values({
      email: EDITOR.email,
      passwordHash: await passwords.hash(EDITOR.password),
      name: 'Omar Farah',
      role: 'master_admin',
      roleId: editorRole.id,
      permissions: ALL_PERMISSIONS,
      status: 'active',
    })
    .returning();
  editorId = editor.id;

  const [readerRole] = await db
    .insert(roles)
    .values({ name: 'Follow-up Reader', permissions: ['clients.view'] })
    .returning();
  await db.insert(admins).values({
    email: READER.email,
    passwordHash: await passwords.hash(READER.password),
    name: 'Sara Khalil',
    role: 'sub_admin',
    roleId: readerRole.id,
    permissions: [],
    status: 'active',
  });

  const made = await db
    .insert(users)
    .values(
      ['notes', 'due', 'upcoming', 'race'].map((name) => ({
        email: `followup-${name}@oxshare-e2e.test`,
        passwordHash: 'x',
        firstName: 'Follow',
        lastName: name,
      })),
    )
    .returning({ id: users.id });
  [clientId, dueId, upcomingId, raceId] = made.map((row) => row.id);

  await db.insert(clientFollowups).values([
    { userId: dueId, followUp: 'Call about the bonus', followUpAt: new Date(Date.now() - DAY) },
    { userId: upcomingId, followUp: 'Send the spreads', followUpAt: new Date(Date.now() + DAY) },
  ]);
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

const path = (id: number) => `/v1/admin/clients/${id}/followup`;

/** The four fields a save sends — what the console sends back from a GET. */
const editable = ({ followUp, result, followUpAt, version }: FollowUpBody) => ({
  followUp,
  result,
  followUpAt,
  version,
});

describe('saving the notes', () => {
  it('reads as empty, version 0, before anything was written', async () => {
    const session = await actingAs(ctx, 'admin', EDITOR);
    const res = await session.get(path(clientId));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ followUp: null, result: null, followUpAt: null, version: 0 });
  });

  it('stores trimmed text, empty as null, and names who saved it', async () => {
    const session = await actingAs(ctx, 'admin', EDITOR);
    const at = new Date(Date.now() + 2 * DAY).toISOString();
    const res = await session.put(path(clientId), {
      followUp: '  Call back after payday\r\nwants 500 USD  ',
      result: '   ',
      followUpAt: at,
      version: 0,
    });
    expect(res.status).toBe(200);
    const body = res.body as FollowUpBody;
    expect(body.followUp).toBe('Call back after payday\nwants 500 USD');
    expect(body.result).toBeNull();
    expect(new Date(body.followUpAt ?? '').toISOString()).toBe(at);
    expect(body.version).toBe(1);
    expect(body.updatedBy).toEqual({ id: editorId, name: 'Omar Farah' });
  });

  it('refuses a save made from an older version, and keeps the newer words', async () => {
    const session = await actingAs(ctx, 'admin', EDITOR);
    const res = await session.put(path(clientId), {
      followUp: 'An edit made before the last save',
      result: null,
      followUpAt: null,
      version: 0,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FOLLOWUP_STALE');

    const now = (await session.get(path(clientId))).body as FollowUpBody;
    expect(now.followUp).toBe('Call back after payday\nwants 500 USD');
    expect(now.version).toBe(1);
  });

  it('accepts a save that changes nothing, whatever its version (a double click)', async () => {
    const session = await actingAs(ctx, 'admin', EDITOR);
    const current = (await session.get(path(clientId))).body as FollowUpBody;
    const res = await session.put(path(clientId), { ...editable(current), version: 0 });
    expect(res.status).toBe(200);
    expect((res.body as FollowUpBody).version).toBe(1);
  });

  it('records every change in the audit log, before and after', async () => {
    const session = await actingAs(ctx, 'admin', EDITOR);
    const res = await session.put(path(clientId), {
      followUp: 'Call back after payday\nwants 500 USD',
      result: 'Interested',
      followUpAt: null,
      version: 1,
    });
    expect(res.status).toBe(200);

    const rows = await ctx.db.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'client.followup_update'),
          eq(auditLog.subjectId, String(clientId)),
        ),
      );
    expect(rows).toHaveLength(2);
    const last = rows.find(
      (row) => (row.details as { after: { result: string | null } }).after.result === 'Interested',
    );
    expect(last?.details).toMatchObject({
      before: { result: null },
      after: { result: 'Interested', followUpAt: null },
    });
  });

  it('lets exactly one of two racing first saves through', async () => {
    const session = await actingAs(ctx, 'admin', EDITOR);
    const [a, b] = await Promise.all(
      ['first', 'second'].map((text) =>
        session.put(path(raceId), { followUp: text, result: null, followUpAt: null, version: 0 }),
      ),
    );
    // Both made from "nothing written yet" with different words: one wins, one is told.
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const stored = (await session.get(path(raceId))).body as FollowUpBody;
    expect(stored.version).toBe(1);
  });

  it('refuses a newly chosen date in the past, but keeps an old one untouched', async () => {
    const session = await actingAs(ctx, 'admin', EDITOR);
    const past = await session.put(path(clientId), {
      followUp: 'x',
      result: null,
      followUpAt: new Date(Date.now() - 3 * DAY).toISOString(),
      version: (await session.get(path(clientId))).body.version as number,
    });
    expect(past.status).toBe(400);
    expect(past.body.fields).toHaveProperty('followUpAt');

    // `due` carries a date a day overdue: editing its text must still save.
    const due = (await session.get(path(dueId))).body as FollowUpBody;
    const edit = await session.put(path(dueId), { ...editable(due), result: 'No answer' });
    expect(edit.status).toBe(200);
  });

  it('refuses a date without its offset', async () => {
    const session = await actingAs(ctx, 'admin', EDITOR);
    const res = await session.put(path(upcomingId), {
      followUp: 'x',
      result: null,
      followUpAt: '2030-01-01T10:00:00',
      version: 1,
    });
    expect(res.status).toBe(400);
  });
});

describe('who may read and write', () => {
  it('reads with clients.view alone, and cannot write without clients.followup.edit', async () => {
    const session = await actingAs(ctx, 'admin', READER);
    expect((await session.get(path(clientId))).status).toBe(200);
    const res = await session.put(path(clientId), {
      followUp: 'not mine to write',
      result: null,
      followUpAt: null,
      version: 99,
    });
    expect(res.status).toBe(403);
  });
});

describe('the clients list', () => {
  interface Row {
    id: number;
    followUp: string | null;
    followUpAt: string | null;
  }
  const ids = async (query: string) => {
    const session = await actingAs(ctx, 'admin', EDITOR);
    const res = await session.get(`/v1/admin/clients?q=followup-&limit=100${query}`);
    expect(res.status).toBe(200);
    return res.body.items as Row[];
  };

  it('carries the notes on each row', async () => {
    const rows = await ids('');
    expect(rows.find((row) => row.id === upcomingId)?.followUp).toBe('Send the spreads');
  });

  it('filters by the follow-up date against the reader’s cut-off', async () => {
    const endOfToday = new Date(Date.now() + 60_000).toISOString();
    const by = `&followUpDueBy=${encodeURIComponent(endOfToday)}`;
    expect((await ids(`&followUp=due${by}`)).map((row) => row.id)).toEqual([dueId]);
    expect((await ids(`&followUp=upcoming${by}`)).map((row) => row.id)).toEqual([upcomingId]);
    const none = (await ids('&followUp=none')).map((row) => row.id);
    expect(none).toContain(clientId);
    expect(none).not.toContain(dueId);
  });

  it('refuses an unknown follow-up filter rather than ignoring it', async () => {
    const session = await actingAs(ctx, 'admin', EDITOR);
    expect((await session.get('/v1/admin/clients?followUp=soon')).status).toBe(400);
  });
});
