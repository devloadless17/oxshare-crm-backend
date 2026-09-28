import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { ClientIdentityService } from '../src/modules/client-identity/client-identity.service';
import { ClientIdentityStore } from '../src/store/client-identity.store';

/**
 * THE BOOT REPAIR — what a rollback leaves behind is put right on the next
 * boot, and somebody is told (identity-core plan, slice 5).
 *
 * The record follows every write to the KYC rows at commit (0153's triggers),
 * whoever makes it. What those cannot see is a row written with triggers OFF —
 * a restore, replication — and a verification level written directly.
 * `ClientIdentityService.repairDrift`, called by main.ts in every environment,
 * adopts each client `identity_drift` names:
 *
 *  - each in its OWN transaction, so a client that cannot be repaired is left
 *    as it was and holds up neither the others nor the boot;
 *  - ONE `identity.record_drift` alert whenever anything was out of step —
 *    never on a healthy boot, or the alert is noise and gets muted;
 *  - it never throws: a broken check is logged and the boot goes on.
 */

let ctx: MoneyTestContext;
let service: ClientIdentityService;
let errors: unknown[];

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await ctx.pool.query(text, values)).rows as T[];
}

async function client(name: string): Promise<string> {
  const [row] = await q<{ id: string }>(
    `INSERT INTO users (email, password_hash, first_name, last_name, email_verified)
     VALUES ($1, 'x', 'Layla', 'Haddad', true) RETURNING id`,
    [`repair-${name}@example.com`],
  );
  return row.id;
}

/** A write the record's triggers cannot see: triggers off, as a restore or replication runs. */
async function withoutTriggers(text: string, values: unknown[]): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query(text, values);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

/** A client working on a passport, adopted — in step. */
async function working(name: string): Promise<string> {
  const user = await client(name);
  await q(
    `INSERT INTO kyc_submissions (user_id, status, document)
     VALUES ($1, 'in_progress', $2)`,
    [
      user,
      JSON.stringify({
        docType: 'passport',
        frontFilePath: `uploads/kyc/repair-${name}.png`,
        frontFileName: 'passport.png',
      }),
    ],
  );
  await q(`SELECT identity_adopt($1)`, [user]);
  return user;
}

const drift = (user?: string) =>
  q<{ problem: string }>(
    user === undefined
      ? `SELECT DISTINCT problem FROM identity_drift ORDER BY problem`
      : `SELECT DISTINCT problem FROM identity_drift WHERE user_id = $1 ORDER BY problem`,
    user === undefined ? [] : [user],
  );

/** The alert lines logged, by their payload. */
const alerts = () =>
  errors.filter(
    (entry): entry is { kind: string; severity: string; summary: string; context: unknown } =>
      typeof entry === 'object' && entry !== null && (entry as { alert?: unknown }).alert === true,
  );

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  service = new ClientIdentityService(new ClientIdentityStore(ctx.db));
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(() => {
  errors = [];
  vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
    errors.push(message);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the boot repair', () => {
  it('repairs every client left out of step, and raises ONE alert', async () => {
    const submitted = await working('submitted');
    const levelled = await client('levelled');
    await working('untouched');

    // A submission restored with triggers off, and a level set by hand.
    await withoutTriggers(`UPDATE kyc_submissions SET status = 'submitted' WHERE user_id = $1`, [
      submitted,
    ]);
    await q(`UPDATE users SET verification_level = 1 WHERE id = $1`, [levelled]);

    const result = await service.repairDrift();

    expect(result).toEqual({
      repaired: 2,
      failed: [],
      problems: { level: 1, not_frozen: 1, stale_draft: 1 },
    });
    expect(await drift()).toEqual([]);
    expect(alerts()).toEqual([
      expect.objectContaining({
        kind: 'identity.record_drift',
        severity: 'notify',
        context: { repaired: 2, failed: 0, level: 1, not_frozen: 1, stale_draft: 1 },
      }),
    ]);
  });

  it('is SILENT on a healthy boot — an alert every boot is one somebody mutes', async () => {
    expect(await service.repairDrift()).toEqual({ repaired: 0, failed: [], problems: {} });
    expect(errors).toEqual([]);
  });

  it('leaves a client it cannot repair as it was, names them, and repairs the rest', async () => {
    const stuck = await client('stuck');
    const fine = await client('fine');
    await q(`UPDATE users SET verification_level = 1 WHERE id = ANY($1)`, [[stuck, fine]]);

    // Adopting `stuck` fails: its decision cannot be written.
    await q(`
      CREATE FUNCTION repair_spec_refuse() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'refused for the test'; END $$ LANGUAGE plpgsql`);
    await q(`
      CREATE TRIGGER repair_spec_refuse BEFORE INSERT ON client_verifications
      FOR EACH ROW WHEN (NEW.user_id = '${stuck}'::uuid) EXECUTE FUNCTION repair_spec_refuse()`);
    try {
      const result = await service.repairDrift();

      expect(result?.repaired).toBe(1);
      expect(result?.failed).toEqual([
        { userId: stuck, message: expect.stringContaining('refused for the test') as unknown },
      ]);
      expect(await drift(fine), 'one client’s failure held up another').toEqual([]);
      expect(await drift(stuck), 'the failed client was changed').toEqual([{ problem: 'level' }]);
      expect(
        errors.some((entry) => typeof entry === 'string' && entry.includes(stuck)),
        'the client that could not be repaired is not named in the log',
      ).toBe(true);
      expect(alerts()).toEqual([
        expect.objectContaining({
          kind: 'identity.record_drift',
          summary: expect.stringContaining('could not be repaired') as unknown,
          context: { repaired: 1, failed: 1, level: 2 },
        }),
      ]);

      // Still broken on the next boot, with nothing else to repair: still said.
      errors = [];
      await service.repairDrift();
      expect(alerts()).toEqual([
        expect.objectContaining({ context: { repaired: 0, failed: 1, level: 1 } }),
      ]);
    } finally {
      await q(`DROP TRIGGER repair_spec_refuse ON client_verifications`);
      await q(`DROP FUNCTION repair_spec_refuse()`);
    }
    // With the fault gone, the next boot repairs it.
    await service.repairDrift();
    expect(await drift()).toEqual([]);
  });

  it('never throws — a check that cannot run is logged, and the boot goes on', async () => {
    await q(`ALTER VIEW identity_drift RENAME TO identity_drift_away`);
    try {
      await expect(service.repairDrift()).resolves.toBeUndefined();
      expect(
        errors.some(
          (entry) =>
            typeof entry === 'string' &&
            entry.includes('Could not check the identity record against the KYC rows'),
        ),
      ).toBe(true);
    } finally {
      await q(`ALTER VIEW identity_drift_away RENAME TO identity_drift`);
    }
  });
});
