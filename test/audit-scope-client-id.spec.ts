import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  AuditLogStore,
  CLIENT_SUBJECT_TYPES,
  OUTSIDE_TERRITORY,
  type AuditSubjectType,
} from '../src/store/audit-log.store';
import { scopeOf, UNRESTRICTED, type ClientScope } from '../src/common/security/client-scope';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/*
 * 0156 — which client an audit row concerns is stamped by the database on every
 * insert, and a scoped reader never learns anything about a client outside
 * their territory from the trail: not the row, not the id, not the email.
 *
 * Before 0156 a subject type the read-time CASE did not list resolved to NULL
 * and was shown to EVERY reader — every KYC document read, every receipt read,
 * every commission reversal, every refused request naming a client. Each case
 * below attempts exactly that read.
 */

let ctx: MoneyTestContext;
let store: AuditLogStore;
let inId: number; // client A, in the reader's territory
let outId: number; // client B, outside it
let outPortalId: number;
let reader: ClientScope;
const admin = crypto.randomUUID();

async function client(email: string): Promise<{ id: number }> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', 'Scope', 'Probe') RETURNING id`);
  return { id: rows[0].id };
}

async function write(
  action: string,
  subjectType: AuditSubjectType,
  subjectId: string | number,
  details?: Record<string, unknown>,
  actor: { id: string | number; email: string; kind: 'admin' | 'client' } = {
    id: admin,
    email: 'desk@oxshare.com',
    kind: 'admin',
  },
) {
  await store.record({
    actorId: actor.id,
    actorEmail: actor.email,
    actorKind: actor.kind,
    action,
    subjectType,
    subjectId,
    details,
  });
}

/** One row of every client type, each concerning B the way its writer records it. */
async function aboutB(type: (typeof CLIENT_SUBJECT_TYPES)[number]): Promise<void> {
  const random = crypto.randomUUID();
  switch (type) {
    case 'user':
    case 'kyc_submission':
    case 'ib_account':
      return write(`probe.${type}`, type, outId);
    case 'trading_account':
      return write(`probe.${type}`, type, random, { clientId: outId });
    case 'transaction':
    case 'wallet':
    case 'ib_application':
    case 'transfer':
      return write(`probe.${type}`, type, random, { userId: outId });
    case 'ib_accrual': {
      // A commission B earned on A's trade: the reversal debits B.
      const { rows } = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO ib_accruals (ib_user_id, client_user_id, source_type, source_id, depth,
                                 rate_value, base_amount, amount, currency)
        VALUES (${outId}, ${inId}, 'deal', gen_random_uuid(), 1, 10, 100, 10, 'USD')
        RETURNING id`);
      return write(`probe.${type}`, type, rows[0].id, { reason: 'probe', movedMoney: false });
    }
    case 'kyc_document':
    case 'deposit_proof': {
      // The subject is the FILE; only the storage registry knows whose it is.
      const bucket = type === 'kyc_document' ? 'kyc' : 'deposit-proofs';
      const file = `${random}.png`;
      await ctx.db.execute(sql`
        INSERT INTO stored_objects (bucket, storage_key, provider, content_type, byte_size, sha256,
                                    owner_user_id, uploaded_by_id, uploaded_by_kind)
        VALUES (${bucket}, ${`${bucket}/${file}`}, 'disk', 'image/png', 1, ${'0'.repeat(64)},
                ${outId}, ${String(outId)}, 'client')`);
      return write(`probe.${type}`, type, file);
    }
  }
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new AuditLogStore(ctx.db);

  const { rows } = await ctx.db.execute<{ id: string; slug: string }>(sql`
    INSERT INTO client_tags (slug, label) VALUES ('scope-in', 'In'), ('scope-out', 'Out')
    RETURNING id, slug`);
  const tag = Object.fromEntries(rows.map((r) => [r.slug, r.id]));
  const a = await client('scope-a@oxshare-e2e.test');
  const b = await client('scope-b@oxshare-e2e.test');
  inId = a.id;
  outId = b.id;
  // The Portal ID and the id are the same number since 0159 — kept as a
  // separate name here only because the assertions below read as "by Portal ID".
  outPortalId = b.id;
  await ctx.db.execute(sql`
    INSERT INTO client_tag_assignments (user_id, tag_id)
    VALUES (${inId}, ${tag['scope-in']}), (${outId}, ${tag['scope-out']})`);
  reader = scopeOf([tag['scope-in']], false, false);

  for (const type of CLIENT_SUBJECT_TYPES) await aboutB(type);
  // Refused requests: one naming B by Portal ID, one by uuid, one naming nobody.
  await write('probe.route_portal', 'route', `PATCH /v1/admin/clients/${outPortalId}/status`);
  await write('probe.route_uuid', 'route', `GET /v1/admin/kyc/${outId}`);
  await write('probe.route_none', 'route', 'DELETE /v1/admin/roles/3');
  // A client row whose client cannot be resolved: fail closed.
  await write('probe.unresolved', 'transaction', crypto.randomUUID(), { amount: '1.00' });
  // A row about no client at all.
  await write('probe.role', 'role', crypto.randomUUID());
  // A row ABOUT A that names B beside it, performed by B. Since 0159 a client in
  // `details` is recognised by its KEY (a number has no shape): the keys real
  // writers use, and one that is NOT a client (`level`) holding B's number.
  await write(
    'probe.names_b',
    'ib_account',
    inId,
    { parentIbUserId: outId, nested: [{ userId: outId }], level: outId },
    { id: outId, email: 'scope-b@oxshare-e2e.test', kind: 'client' },
  );
});

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

const find = (scope: ClientScope, q?: string) => store.findAll({ limit: 100, scope, q });

describe('audit_log.client_id — the database decides which client a row concerns', () => {
  it('resolves B for every client subject type, so the list and the SQL cannot drift', async () => {
    const { rows } = await ctx.db.execute<{ action: string; client_id: number | null }>(sql`
      SELECT action, client_id FROM audit_log WHERE action LIKE 'probe.%' ORDER BY action`);
    const clientOf = new Map(rows.map((r) => [r.action, r.client_id]));
    for (const type of CLIENT_SUBJECT_TYPES) {
      expect(clientOf.get(`probe.${type}`), `a ${type} row is not stamped`).toBe(outId);
    }
    expect(clientOf.get('probe.route_portal')).toBe(outId);
    expect(clientOf.get('probe.route_uuid')).toBe(outId);
    expect(clientOf.get('probe.route_none')).toBeNull();
    expect(clientOf.get('probe.unresolved')).toBeNull();
  });
});

describe('a scoped reader learns nothing about a client outside their territory', () => {
  it('sees no row about B — of any type — while an unrestricted reader sees them all', async () => {
    const everything = (await find(UNRESTRICTED)).items.map((r) => r.action);
    const scoped = (await find(reader)).items.map((r) => r.action).sort();

    // Non-vacuous: every probe exists for the reader who may see it.
    for (const type of CLIENT_SUBJECT_TYPES) expect(everything).toContain(`probe.${type}`);
    expect(everything).toContain('probe.unresolved');

    expect(scoped).toEqual(['probe.names_b', 'probe.role', 'probe.route_none']);
  });

  it('shows B beside a visible row as the fact — no uuid, no Portal ID, no email', async () => {
    const page = await find(reader);
    const row = page.items.find((r) => r.action === 'probe.names_b')!;
    expect(row.details).toEqual({
      parentIbUserId: OUTSIDE_TERRITORY,
      nested: [{ userId: OUTSIDE_TERRITORY }],
      level: outId, // not a client key: a level is shown as the number it is
    });
    expect(row.actorId).toBe(OUTSIDE_TERRITORY);
    expect(row.actorEmail).toBe(OUTSIDE_TERRITORY);
    expect(row.actorPortalId).toBeNull();

    const json = JSON.stringify({
      ...page,
      items: page.items.map((r) => ({ ...r, details: null })),
    });
    expect(json).not.toContain(String(outPortalId));
    expect(json).not.toContain('scope-b@');
    expect(json).not.toMatch(/"clientId"/);
  });

  it('an unrestricted reader sees B by Portal ID in the same row', async () => {
    const row = (await find(UNRESTRICTED)).items.find((r) => r.action === 'probe.names_b')!;
    expect(row.details).toEqual({
      parentIbUserId: outPortalId,
      nested: [{ userId: outPortalId }],
      level: outId,
    });
    expect(row.actorPortalId).toBe(outPortalId);
  });

  it('a Portal ID search for B finds nothing, exactly like an unused number', async () => {
    expect((await find(reader, String(outPortalId))).total).toBe(0);
    expect((await find(UNRESTRICTED, String(outPortalId))).total).toBeGreaterThan(10);
  });
});
