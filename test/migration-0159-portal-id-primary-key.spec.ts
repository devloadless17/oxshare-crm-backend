import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * MIGRATION 0159 — the Portal ID becomes the client's key, and the uuid is gone.
 *
 * It rewrites every place a client was named — sixteen foreign keys, the
 * partner tree, five admin-or-client columns, and the ids stored inside the
 * append-only audit trail and the notifications — in one transaction that runs
 * once against real data and cannot be re-run with a fix. A reference it maps
 * wrongly is a ledger, a commission or an audit row silently re-attributed to
 * somebody else. So the properties are proven on rows written the way the old
 * code wrote them, rather than trusted from reading the SQL:
 *
 *  - every client's key becomes the number they already had, and every
 *    reference follows it — the partner tree and the referral included;
 *  - NO old client uuid survives anywhere in the database, except inside a
 *    provider's reference, which is somebody else's text and is left alone;
 *  - the audit trail is rewritten to name clients by Portal ID and is
 *    append-only again afterwards — the guard lifted for three statements is
 *    back on;
 *  - a Portal ID can never change; new clients continue the sequence;
 *  - portal sessions end (their subject was the old id), admin sessions do not;
 *  - the money is untouched.
 *
 * The database is migrated to 0158, the legacy rows are written, and then 0159
 * runs — the order production sees.
 */

const MIGRATIONS = join(__dirname, '..', 'src', 'database', 'migrations');
const TAG = '0159_portal_id_is_the_key';
const SQL = readFileSync(join(MIGRATIONS, `${TAG}.sql`), 'utf8');

/** An administrator. Mixed admin-or-client columns carry no foreign key. */
const ADMIN = '5c1e0a4e-7a1b-4c55-9d2e-0a0b0c0d0e0f';

type Who = 'partner' | 'sub' | 'client';
const uuid = {} as Record<Who, string>;
const pid = {} as Record<Who, number>;

let ctx: MoneyTestContext;
let folder: string;
let money: { entries: string; total: string; balance: string };

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ctx.pool.query(text, values)).rows as T[];
}

async function refused(text: string, values: unknown[] = []): Promise<string> {
  try {
    await q(text, values);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected the database to refuse: ${text}`);
}

async function legacyUser(who: Who): Promise<void> {
  const [row] = await q<{ id: string; portal_id: number }>(
    `INSERT INTO users (email, password_hash, first_name, last_name)
     VALUES ($1, 'x', 'Mig', $2) RETURNING id, portal_id`,
    [`mig0159-${who}@oxshare-e2e.test`, who],
  );
  uuid[who] = row.id;
  pid[who] = row.portal_id;
}

beforeAll(async () => {
  // The committed history, stopped just before 0159.
  folder = mkdtempSync(join(tmpdir(), 'mig0159-'));
  cpSync(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const at = journal.entries.find((entry) => entry.tag === TAG);
  if (!at) throw new Error(`${TAG} is not in the journal`);
  for (const entry of journal.entries.filter((e) => e.idx >= at.idx)) {
    rmSync(join(folder, `${entry.tag}.sql`));
  }
  journal.entries = journal.entries.filter((entry) => entry.idx < at.idx);
  writeFileSync(journalPath, JSON.stringify(journal));

  ctx = await startMoneyTestDb({ migrationsFolder: folder });

  // A two-rung partner tree, and a client referred into it.
  await legacyUser('partner');
  await legacyUser('sub');
  await legacyUser('client');
  await q(`INSERT INTO ib_accounts (user_id, referral_code) VALUES ($1, 'MIG159P')`, [
    uuid.partner,
  ]);
  await q(
    `INSERT INTO ib_accounts (user_id, parent_ib_user_id, referral_code, level)
     VALUES ($1, $2, 'MIG159S', 2)`,
    [uuid.sub, uuid.partner],
  );
  await q('UPDATE users SET referred_by_ib_user_id = $1 WHERE id = $2', [uuid.sub, uuid.client]);

  // Money: a wallet, a ledger row, and a deposit whose PROVIDER reference
  // happens to embed the client's uuid — the one place it must survive.
  const [wallet] = await q<{ id: string }>(
    `INSERT INTO wallets (user_id, currency, balance) VALUES ($1, 'USD', 100) RETURNING id`,
    [uuid.client],
  );
  await q(
    `INSERT INTO ledger_entries (wallet_id, amount, balance_after, entry_type, reference_type, reference_id)
     VALUES ($1, 100, 100, 'deposit', 'transaction', 'mig0159-1')`,
    [wallet.id],
  );
  await q(
    `INSERT INTO transactions (user_id, wallet_id, direction, amount, currency, provider, provider_ref)
     VALUES ($1, $2, 'deposit', 100, 'USD', 'desk', $3)`,
    [uuid.client, wallet.id, `desk-credit-${uuid.client}`],
  );

  // The audit trail, as each kind of writer left it.
  const c = uuid.client;
  const audit = (
    kind: string,
    actor: string,
    action: string,
    type: string,
    subject: string,
    details?: object,
  ) =>
    q(
      `INSERT INTO audit_log (actor_kind, actor_id, actor_email, action, subject_type, subject_id, details)
       VALUES ($1, $2, 'mig0159@oxshare-e2e.test', $3, $4, $5, $6::jsonb)`,
      [kind, actor, action, type, subject, details ? JSON.stringify(details) : null],
    );
  await audit('client', c, 'client.profile_update', 'user', c, { userId: c, via: 'portal' });
  await audit('admin', ADMIN, 'kyc.approve', 'kyc_submission', c, {
    userId: c,
    providerRef: `desk-credit-${c}`,
  });
  await audit('admin', ADMIN, 'rbac.denied', 'route', `GET /v1/admin/clients/${c}/wallets`);
  await audit('admin', ADMIN, 'ib.parent_change', 'ib_account', uuid.sub, {
    before: uuid.partner,
    after: null,
    parentIbUserId: uuid.partner,
  });

  // A client's bell and an admin's task about that client.
  await q(
    `INSERT INTO notifications (recipient_kind, recipient_id, kind, params, dedupe_key, subject_user_id)
     VALUES ('client', $1, 'kyc.approved', $2::jsonb, $3, $4)`,
    [c, JSON.stringify({ userId: c }), `kyc:${c}`, c],
  );
  await q(
    `INSERT INTO notifications (recipient_kind, recipient_id, kind, subject_user_id, subject_kind, subject_id)
     VALUES ('admin', $1, 'kyc.review', $2, 'kyc', $3)`,
    [ADMIN, c, c],
  );

  // One session on each surface.
  for (const [surface, subject] of [
    ['portal', uuid.client],
    ['admin', ADMIN],
  ] as const) {
    await q(
      `INSERT INTO refresh_tokens (id, family_id, surface, subject_id, token_hash, expires_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), $1, $2, $3, now() + interval '1 day')`,
      [surface, subject, `hash-${surface}`],
    );
  }

  const [before] = await q<{ entries: string; total: string; balance: string }>(
    `SELECT (SELECT count(*) FROM ledger_entries)::text AS entries,
            (SELECT sum(amount) FROM ledger_entries)::text AS total,
            (SELECT sum(balance) FROM wallets)::text AS balance`,
  );
  money = before!;

  await ctx.pool.query(SQL);
});

afterAll(async () => {
  if (ctx) await stopMoneyTestDb(ctx);
  if (folder) rmSync(folder, { recursive: true, force: true });
});

describe('migration 0159 — the Portal ID is the key', () => {
  it('keys every client by the number they already had', async () => {
    const rows = await q<{ id: number; last_name: Who }>(
      `SELECT id, last_name FROM users WHERE email LIKE 'mig0159-%'`,
    );
    for (const row of rows) expect(row.id).toBe(pid[row.last_name]);

    const [column] = await q<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'id'`,
    );
    expect(column.data_type).toBe('integer');
    const leftover = await q(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'portal_id'`,
    );
    expect(leftover).toEqual([]);
  });

  it('carries the partner tree, the referral and the money over to the same people', async () => {
    const [sub] = await q<{ parent: number }>(
      'SELECT parent_ib_user_id AS parent FROM ib_accounts WHERE user_id = $1',
      [pid.sub],
    );
    expect(sub.parent).toBe(pid.partner);
    const [client] = await q<{ referrer: number }>(
      'SELECT referred_by_ib_user_id AS referrer FROM users WHERE id = $1',
      [pid.client],
    );
    expect(client.referrer).toBe(pid.sub);
    const owners = await q<{ user_id: number }>(
      `SELECT user_id FROM wallets UNION ALL SELECT user_id FROM transactions`,
    );
    expect(owners.map((o) => o.user_id)).toEqual([pid.client, pid.client]);
  });

  it('leaves no old client uuid anywhere — except inside a provider reference', async () => {
    const columns = await q<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('uuid', 'text', 'character varying', 'jsonb', 'json')
          AND table_name IN (SELECT table_name FROM information_schema.tables
                              WHERE table_schema = 'public' AND table_type = 'BASE TABLE')`,
    );
    const pattern = Object.values(uuid).join('|');
    const hits: string[] = [];
    for (const { table_name, column_name } of columns) {
      const [row] = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${table_name}" WHERE "${column_name}"::text ~* $1`,
        [pattern],
      );
      if (row.n > 0) hits.push(`${table_name}.${column_name}`);
    }
    expect(hits.sort()).toEqual(['audit_log.details', 'transactions.provider_ref']);

    // The audit hit is the provider reference copied into details, verbatim.
    const inDetails = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE (details - 'providerRef')::text ~* $1`,
      [pattern],
    );
    expect(inDetails[0].n).toBe(0);
    const [ref] = await q<{ provider_ref: string }>('SELECT provider_ref FROM transactions');
    expect(ref.provider_ref).toBe(`desk-credit-${uuid.client}`);
  });

  it('rewrites the audit trail to name clients by Portal ID, and leaves admins alone', async () => {
    const rows = await q<{
      action: string;
      actor_id: string;
      subject_id: string;
      client_id: number | null;
      details: Record<string, unknown> | null;
    }>(`SELECT action, actor_id, subject_id, client_id, details FROM audit_log
         WHERE action IN ('client.profile_update', 'kyc.approve', 'rbac.denied', 'ib.parent_change')`);
    const by = Object.fromEntries(rows.map((r) => [r.action, r]));

    expect(by['client.profile_update']).toMatchObject({
      actor_id: String(pid.client),
      subject_id: String(pid.client),
      client_id: pid.client,
      details: { userId: pid.client, via: 'portal' },
    });
    expect(by['kyc.approve']).toMatchObject({
      actor_id: ADMIN,
      subject_id: String(pid.client),
      client_id: pid.client,
      details: { userId: pid.client },
    });
    expect(by['rbac.denied'].subject_id).toBe(`GET /v1/admin/clients/${pid.client}/wallets`);
    expect(by['ib.parent_change']).toMatchObject({
      subject_id: String(pid.sub),
      details: { before: pid.partner, after: null, parentIbUserId: pid.partner },
    });
  });

  it('puts the append-only guard back: the rewritten trail refuses UPDATE and DELETE', async () => {
    expect(await refused(`UPDATE audit_log SET action = 'tampered'`)).toMatch(
      /append-only|not allowed|immutable/i,
    );
    expect(await refused('DELETE FROM audit_log')).toMatch(/append-only|not allowed|immutable/i);
    const disabled = await q(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'D'`,
    );
    expect(disabled).toEqual([]);
  });

  it('the stamp trigger resolves the client of a NEW audit row by Portal ID', async () => {
    const [row] = await q<{ client_id: number }>(
      `INSERT INTO audit_log (actor_kind, actor_id, actor_email, action, subject_type, subject_id)
       VALUES ('admin', $1, 'admin@oxshare.com', 'client.view', 'user', $2) RETURNING client_id`,
      [ADMIN, String(pid.client)],
    );
    expect(row.client_id).toBe(pid.client);
  });

  it('names clients by Portal ID in the notifications too', async () => {
    const [bell] = await q<{
      recipient_id: string;
      params: Record<string, unknown>;
      dedupe_key: string;
      subject_user_id: number;
    }>(
      `SELECT recipient_id, params, dedupe_key, subject_user_id FROM notifications WHERE kind = 'kyc.approved'`,
    );
    expect(bell).toEqual({
      recipient_id: String(pid.client),
      params: { userId: pid.client },
      dedupe_key: `kyc:${pid.client}`,
      subject_user_id: pid.client,
    });
    const [task] = await q<{ recipient_id: string; subject_id: string }>(
      `SELECT recipient_id, subject_id FROM notifications WHERE kind = 'kyc.review'`,
    );
    expect(task).toEqual({ recipient_id: ADMIN, subject_id: String(pid.client) });
  });

  it('ends portal sessions and keeps admin sessions', async () => {
    const sessions = await q<{ surface: string; subject_id: string }>(
      'SELECT surface, subject_id FROM refresh_tokens',
    );
    expect(sessions).toEqual([{ surface: 'admin', subject_id: ADMIN }]);
  });

  it('never lets a Portal ID change, and new clients continue the sequence', async () => {
    expect(await refused('UPDATE users SET id = id + 1 WHERE id = $1', [pid.client])).toMatch(
      /never changes/,
    );
    const [fresh] = await q<{ id: number }>(
      `INSERT INTO users (email, password_hash, first_name, last_name)
       VALUES ('mig0159-new@oxshare-e2e.test', 'x', 'New', 'Client') RETURNING id`,
    );
    expect(fresh.id).toBeGreaterThan(Math.max(...Object.values(pid)));
  });

  it('leaves the money exactly as it was', async () => {
    const [after] = await q<{ entries: string; total: string; balance: string }>(
      `SELECT (SELECT count(*) FROM ledger_entries)::text AS entries,
              (SELECT sum(amount) FROM ledger_entries)::text AS total,
              (SELECT sum(balance) FROM wallets)::text AS balance`,
    );
    expect(after).toEqual(money);
  });
});
