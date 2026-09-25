import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * MIGRATION 0140 — every admin row becomes a TASK about one item, and the bell
 * is truthful the minute it deploys.
 *
 * The migration runs once against every real bell, so its rules are proven on
 * the row shapes the old code actually wrote rather than trusted from reading
 * SQL:
 *
 *  - a kind that stays a task learns its item and client from its params;
 *  - a kind that was never a task (a registration, an opened account, a
 *    completed payout) is removed, and so is a row naming nothing that still
 *    exists — neither may be shown, the second because it cannot be
 *    scope-checked;
 *  - a task whose item was already handled is resolved, with the real outcome,
 *    reviewer and time — for KYC taken from the attempt archive, because one
 *    submission row serves every attempt and a resubmission reads 'submitted'
 *    again;
 *  - a task still waiting stays open;
 *  - the client bell's echoes are cleared;
 *  - the CHECK that makes a subject-less admin row impossible is VALIDATED;
 *  - and running it twice changes nothing.
 *
 * The database is migrated to 0139, the rows are written the way the old code
 * wrote them, and then 0140 runs — the order production sees.
 */

const MIGRATIONS = join(__dirname, '..', 'src', 'database', 'migrations');
const TAG = '0140_admin_notification_tasks';
const SQL = readFileSync(join(MIGRATIONS, `${TAG}.sql`), 'utf8');

let ctx: MoneyTestContext;
let folder: string;
const ids: Record<string, string> = {};
const ADMIN_A = 'a0000000-0000-4000-8000-00000000000a';
const ADMIN_B = 'a0000000-0000-4000-8000-00000000000b';

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ctx.pool.query(text, values)).rows as T[];
}

async function client(key: string): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Mig', 'Client') RETURNING id`,
    [`mig0140-${key}@oxshare-e2e.test`],
  );
  ids[key] = row.id;
  return row.id;
}

async function withdrawal(key: string, userId: string, state: string, reviewedBy?: string) {
  // One wallet per (client, currency, kind) — a client's second withdrawal
  // draws on the wallet their first one created.
  const [wallet] = await q<{ id: string }>(
    `WITH found AS (SELECT id FROM wallets WHERE user_id = $1 AND currency = 'USD'),
          made AS (
            INSERT INTO wallets (user_id, currency, balance)
            SELECT $1, 'USD', '0' WHERE NOT EXISTS (SELECT 1 FROM found)
            RETURNING id
          )
     SELECT id FROM found UNION ALL SELECT id FROM made LIMIT 1`,
    [userId],
  );
  const [tx] = await q<{ id: string }>(
    `INSERT INTO transactions (user_id, wallet_id, direction, amount, currency, state, provider, provider_ref, reviewed_by, reviewed_at)
     VALUES ($1, $2, 'withdrawal', '50.00000000', 'USD', $3::transaction_state, 'manual', $4, $5, CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() - interval '2 hours' END)
     RETURNING id`,
    [userId, wallet.id, state, `mig0140-${key}`, reviewedBy ?? null],
  );
  ids[key] = tx.id;
  return tx.id;
}

/** An admin row exactly as the old fan-out wrote it: kind + params, no subject. */
async function legacyRow(
  key: string,
  recipient: string,
  kind: string,
  params: Record<string, unknown>,
  createdAgo = '1 day',
) {
  const [row] = await q<{ id: string }>(
    `INSERT INTO notifications (recipient_kind, recipient_id, kind, params, created_at)
     VALUES ('admin', $1, $2, $3, now() - $4::interval) RETURNING id`,
    [recipient, kind, JSON.stringify(params), createdAgo],
  );
  ids[key] = row.id;
}

async function rowOf(key: string) {
  const [row] = await q<{
    subject_kind: string | null;
    subject_id: string | null;
    subject_user_id: string | null;
    resolved_at: Date | null;
    resolution: string | null;
    resolved_by: string | null;
  }>(
    `SELECT subject_kind, subject_id, subject_user_id, resolved_at, resolution, resolved_by
       FROM notifications WHERE id = $1`,
    [ids[key]],
  );
  return row;
}

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'mig0140-'));
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

  const [reviewer] = await q<{ id: string }>(
    `INSERT INTO admins (email, password_hash, name, role, permissions)
     VALUES ('mig0140-reviewer@oxshare.com', 'x', 'Mig Reviewer', 'sub_admin', '[]') RETURNING id`,
  );
  ids['reviewer'] = reviewer.id;

  // ── Withdrawals: one still waiting, one approved, one cancelled after approval ──
  const w = await client('w');
  await withdrawal('txPending', w, 'pending');
  await withdrawal('txApproved', w, 'approved', reviewer.id);
  await withdrawal('txFailed', w, 'failure', reviewer.id);
  await legacyRow('wPending', ADMIN_A, 'admin.withdrawal.requested', {
    transactionId: ids['txPending'],
    userId: w,
  });
  await legacyRow('wApproved', ADMIN_A, 'admin.withdrawal.requested', {
    transactionId: ids['txApproved'],
    userId: w,
  });
  await legacyRow('wApprovedB', ADMIN_B, 'admin.withdrawal.requested', {
    transactionId: ids['txApproved'],
    userId: w,
  });
  await legacyRow('wFailed', ADMIN_A, 'admin.withdrawal.requested', {
    transactionId: ids['txFailed'],
    userId: w,
  });

  // ── KYC: waiting; approved; rejected-then-resubmitted (the case status cannot tell) ──
  const kWaiting = await client('kWaiting');
  await q(`INSERT INTO kyc_submissions (user_id, status) VALUES ($1, 'under_review')`, [kWaiting]);
  await legacyRow('kycWaiting', ADMIN_A, 'admin.kyc.submitted', { userId: kWaiting });

  const kApproved = await client('kApproved');
  await q(
    `INSERT INTO kyc_submissions (user_id, status, reviewed_by, reviewed_at) VALUES ($1, 'approved', $2, now() - interval '3 hours')`,
    [kApproved, reviewer.id],
  );
  await q(
    `INSERT INTO kyc_submission_attempts (user_id, attempt_no, status, reviewed_at, reviewed_by)
     VALUES ($1, 1, 'approved', now() - interval '3 hours', $2)`,
    [kApproved, reviewer.id],
  );
  await legacyRow('kycApproved', ADMIN_A, 'admin.kyc.submitted', { userId: kApproved });

  const kCycle = await client('kCycle');
  await q(`INSERT INTO kyc_submissions (user_id, status) VALUES ($1, 'submitted')`, [kCycle]);
  // First attempt: raised two days ago, rejected yesterday. Second: raised an hour ago, waiting.
  await q(
    `INSERT INTO kyc_submission_attempts (user_id, attempt_no, status, reviewed_at, reviewed_by)
     VALUES ($1, 1, 'rejected', now() - interval '1 day', $2)`,
    [kCycle, reviewer.id],
  );
  await legacyRow('kycFirst', ADMIN_A, 'admin.kyc.submitted', { userId: kCycle }, '2 days');
  await legacyRow('kycSecond', ADMIN_A, 'admin.kyc.resubmitted', { userId: kCycle }, '1 hour');

  // A KYC reset deletes the row: nothing to review any more.
  const kReset = await client('kReset');
  await legacyRow('kycReset', ADMIN_A, 'admin.kyc.submitted', { userId: kReset });

  // ── IB: one waiting, one rejected ──
  const partner = await client('partner');
  const [appWaiting] = await q<{ id: string }>(
    `INSERT INTO ib_applications (user_id, status) VALUES ($1, 'pending') RETURNING id`,
    [partner],
  );
  const partner2 = await client('partner2');
  const [appRejected] = await q<{ id: string }>(
    `INSERT INTO ib_applications (user_id, status, reviewed_by, reviewed_at) VALUES ($1, 'rejected', $2, now() - interval '5 hours') RETURNING id`,
    [partner2, reviewer.id],
  );
  await legacyRow('ibWaiting', ADMIN_A, 'admin.partner.applied', {
    applicationId: appWaiting.id,
    userId: partner,
  });
  await legacyRow('ibRejected', ADMIN_A, 'admin.partner.applied', {
    applicationId: appRejected.id,
    userId: partner2,
  });

  // ── What was never a task, and what names nothing ──
  await legacyRow('registered', ADMIN_A, 'admin.client.registered', { userId: w, country: 'AE' });
  await legacyRow('opened', ADMIN_A, 'admin.trading_account.opened', { userId: w, login: '123' });
  await legacyRow('paid', ADMIN_A, 'withdrawal.rival_paid', { transactionId: ids['txApproved'] });
  await legacyRow('dangling', ADMIN_A, 'admin.withdrawal.requested', {
    transactionId: '00000000-0000-4000-8000-00000000dead',
  });
  await legacyRow('malformed', ADMIN_A, 'admin.kyc.submitted', { userId: 'not-a-uuid' });

  // ── The client bell's echoes ──
  const [echo] = await q<{ id: string }>(
    `INSERT INTO notifications (recipient_kind, recipient_id, kind, params) VALUES ('client', $1, 'trading_account.opened', '{}') RETURNING id`,
    [w],
  );
  ids['echo'] = echo.id;
  const [outcome] = await q<{ id: string }>(
    `INSERT INTO notifications (recipient_kind, recipient_id, kind, params) VALUES ('client', $1, 'withdrawal.paid', '{}') RETURNING id`,
    [w],
  );
  ids['outcome'] = outcome.id;

  await ctx.pool.query(SQL);
}, 180_000);

afterAll(async () => {
  if (ctx) await stopMoneyTestDb(ctx);
  if (folder) rmSync(folder, { recursive: true, force: true });
});

describe('a task learns what it is about', () => {
  it('fills item and client for each kind that stays a task', async () => {
    expect(await rowOf('wPending')).toMatchObject({
      subject_kind: 'transaction',
      subject_id: ids['txPending'],
      subject_user_id: ids['w'],
    });
    expect(await rowOf('kycWaiting')).toMatchObject({
      subject_kind: 'kyc',
      subject_id: ids['kWaiting'],
      subject_user_id: ids['kWaiting'],
    });
    expect(await rowOf('ibWaiting')).toMatchObject({
      subject_kind: 'ib_application',
      subject_user_id: ids['partner'],
    });
  });

  it('removes what was never a task, and what names nothing any more', async () => {
    for (const key of ['registered', 'opened', 'paid', 'dangling', 'malformed']) {
      expect(await rowOf(key), `${key} survived`).toBeUndefined();
    }
  });
});

describe('the bell is truthful the minute it deploys', () => {
  it('keeps a task that still waits open', async () => {
    for (const key of ['wPending', 'kycWaiting', 'kycSecond', 'ibWaiting']) {
      const row = await rowOf(key);
      expect(row.resolved_at, `${key} was resolved`).toBeNull();
    }
  });

  it('resolves a handled withdrawal for EVERY admin, crediting the reviewer', async () => {
    for (const key of ['wApproved', 'wApprovedB']) {
      expect(await rowOf(key)).toMatchObject({
        resolution: 'approved',
        resolved_by: ids['reviewer'],
      });
    }
  });

  it('credits nobody for a failure — a cancel never records who did it', async () => {
    expect(await rowOf('wFailed')).toMatchObject({ resolution: 'failure', resolved_by: null });
  });

  it('takes a KYC outcome from the attempt archive — true outcome, reviewer and time', async () => {
    const approved = await rowOf('kycApproved');
    expect(approved).toMatchObject({ resolution: 'approved', resolved_by: ids['reviewer'] });
    // The decision's own time, not the migration's.
    expect(Date.now() - (approved.resolved_at as Date).getTime()).toBeGreaterThan(2 * 3_600_000);

    // The first attempt was REJECTED, though the row reads 'submitted' again now.
    expect(await rowOf('kycFirst')).toMatchObject({
      resolution: 'rejected',
      resolved_by: ids['reviewer'],
    });
  });

  it('resolves a KYC whose submission was reset away', async () => {
    expect(await rowOf('kycReset')).toMatchObject({ resolution: 'reset' });
  });

  it('resolves a rejected IB application', async () => {
    expect(await rowOf('ibRejected')).toMatchObject({
      resolution: 'rejected',
      resolved_by: ids['reviewer'],
    });
  });
});

describe('the client bell and the invariants', () => {
  it('clears the client’s echoes and leaves real outcomes unread', async () => {
    const [echo] = await q<{ read_at: Date | null }>(
      `SELECT read_at FROM notifications WHERE id = $1`,
      [ids['echo']],
    );
    const [outcome] = await q<{ read_at: Date | null }>(
      `SELECT read_at FROM notifications WHERE id = $1`,
      [ids['outcome']],
    );
    expect(echo.read_at).not.toBeNull();
    expect(outcome.read_at).toBeNull();
  });

  it('VALIDATES the CHECK — an admin row without a subject is refused from now on', async () => {
    const [ck] = await q<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'notifications_admin_subject_ck'`,
    );
    expect(ck.convalidated).toBe(true);
    await expect(
      q(
        `INSERT INTO notifications (recipient_kind, recipient_id, kind) VALUES ('admin', $1, 'admin.kyc.submitted')`,
        [ADMIN_A],
      ),
    ).rejects.toThrow(/notifications_admin_subject_ck/);
  });

  it('is re-runnable — a second pass changes nothing', async () => {
    const before = await q(
      `SELECT id, subject_id, resolved_at, resolution FROM notifications ORDER BY id`,
    );
    await ctx.pool.query(SQL);
    const after = await q(
      `SELECT id, subject_id, resolved_at, resolution FROM notifications ORDER BY id`,
    );
    expect(after).toEqual(before);
  });
});
