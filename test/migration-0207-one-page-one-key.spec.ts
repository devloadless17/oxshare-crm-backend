import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * 0207 — one page, one key. The release that removes `ib.view` and gives every
 * sidebar page its own view key decides, for every stored permission set, who
 * keeps which page. Getting it wrong either strands a team without a page it
 * works in, or hands the buyer's staff the configuration pages he asked to keep
 * from them — so both directions are pinned.
 *
 * The migration is re-runnable (unions and a removal), so the suite migrates a
 * fresh database, writes PRE-0207 sets into it, and runs the file again.
 */
const SQL = readFileSync(
  join(__dirname, '..', 'src', 'database', 'migrations', '0207_one_page_one_key.sql'),
  'utf8',
);

let ctx: MoneyTestContext;

async function role(name: string, permissions: string[]): Promise<void> {
  await ctx.pool.query(`INSERT INTO roles (name, permissions) VALUES ($1, $2::jsonb)`, [
    name,
    JSON.stringify(permissions),
  ]);
}

async function permissionsOf(name: string): Promise<string[]> {
  const { rows } = await ctx.pool.query<{ permissions: string[] }>(
    'SELECT permissions FROM roles WHERE name = $1',
    [name],
  );
  return rows[0].permissions;
}

const CONFIG_KEYS = [
  'ib.levels.view',
  'ib.commission_types.view',
  'products.view',
  'agencies.view',
  'mt5.groups.view',
  'mt5.bridge.view',
];

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  await role('0207 Sales', ['clients.view', 'ib.view', 'trading.view', 'settings.view']);
  await role('0207 KYC builder', ['kyc.view', 'kyc.edit', 'kyc.create']);
  await role('0207 Desk', ['deposits.approve']);
  // One statement batch, one connection: the migration's helper lives in pg_temp.
  await ctx.pool.query(SQL);
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('0207 one page, one key', () => {
  it('carries the WORK pages over from ib.view and removes ib.view', async () => {
    const sales = await permissionsOf('0207 Sales');
    expect(sales).toEqual(
      expect.arrayContaining([
        'ib.partners.view',
        'ib.applications.view',
        'ib.referrals.view',
        'ib.commissions.view',
      ]),
    );
    expect(sales).not.toContain('ib.view');
  });

  it('gives the CONFIGURATION pages to nobody but Administrator', async () => {
    const sales = await permissionsOf('0207 Sales');
    for (const key of CONFIG_KEYS) expect(sales, key).not.toContain(key);

    const administrator = await permissionsOf('Administrator');
    expect(administrator).toEqual(expect.arrayContaining(CONFIG_KEYS));
  });

  it('moves the Rejection reasons page off the KYC builder keys', async () => {
    expect(await permissionsOf('0207 KYC builder')).toEqual(
      expect.arrayContaining([
        'rejection_reasons.view',
        'rejection_reasons.edit',
        'rejection_reasons.create',
      ]),
    );
  });

  it('closes every set over `requires`: an action brings the page it is taken on', async () => {
    expect(await permissionsOf('0207 Desk')).toEqual(['deposits.approve', 'deposits.view']);
  });

  it('is re-runnable — a second run changes nothing', async () => {
    const before = await permissionsOf('0207 Sales');
    await ctx.pool.query(SQL);
    expect(await permissionsOf('0207 Sales')).toEqual(before);
  });
});

/*
 * 0208 — masking covers personal details only. A role still storing a key the
 * catalog now LOCKS could never be saved (the API refuses a locked key, the
 * editor never shows one to untick) — so 0208 strips every locked key, keeping
 * the personal ones, and leaves a NULL override (= follow the role) alone.
 */
describe('0208 masks keep personal details only', () => {
  it('strips locked keys and keeps the personal ones', async () => {
    const sql = readFileSync(
      join(__dirname, '..', 'src', 'database', 'migrations', '0208_mask_personal_details_only.sql'),
      'utf8',
    );
    await ctx.pool.query(
      `INSERT INTO roles (name, permissions, masked_fields) VALUES ('0208 Mask', '[]', $1::jsonb)`,
      [
        JSON.stringify([
          'client.phone',
          'client.tags',
          'kyc.stepData',
          'client.createdAt',
          'client.partnerApplication',
          'client.payoutDestination',
        ]),
      ],
    );
    await ctx.pool.query(sql);
    const { rows } = await ctx.pool.query<{ masked_fields: string[] }>(
      `SELECT masked_fields FROM roles WHERE name = '0208 Mask'`,
    );
    expect(rows[0].masked_fields).toEqual(['client.phone']);
  });
});
