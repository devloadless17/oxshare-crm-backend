import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { WithdrawalMethodsService } from '../src/modules/payments/withdrawal-methods.service';
import type { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import { ConflictError, NotFoundError } from '../src/common/errors/domain-errors';
import { auditStub, TEST_ACTOR } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Withdrawal methods — `withdrawal_payment_methods`, managed from the console.
 *
 * The table and the portal's reader (`GET /payments/withdrawal-methods`) have
 * existed since 0062; what these pin is the admin side that was missing, and
 * the contract between the two: what the console switches off, the withdraw
 * form stops offering — and nothing already requested is touched.
 */
let ctx: MoneyTestContext;
let methods: WithdrawalMethodsService;
let audit: ReturnType<typeof auditStub>;

/** What the portal's withdraw form reads: enabled rows, in client order. */
async function offeredToClients(): Promise<string[]> {
  const { rows } = await ctx.db.execute<{ key: string }>(sql`
    SELECT key FROM withdrawal_payment_methods WHERE enabled ORDER BY sort_order, name
  `);
  return rows.map((row) => row.key);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  audit = auditStub();
  methods = new WithdrawalMethodsService(ctx.db, audit as unknown as AdminAuditService);
  await ctx.db.execute(sql`DELETE FROM withdrawal_payment_methods WHERE key <> 'whish'`);
  await ctx.db.execute(
    sql`UPDATE withdrawal_payment_methods SET enabled = true, sort_order = 0 WHERE key = 'whish'`,
  );
});

describe('the withdrawal methods list', () => {
  it('includes the seeded method, and disabled ones too', async () => {
    await methods.create({ key: 'bank', name: 'Bank transfer', enabled: false }, TEST_ACTOR);

    const keys = (await methods.listAll()).map((row) => row.key);

    expect(keys).toContain('whish');
    expect(keys).toContain('bank');
  });
});

describe('adding a method', () => {
  it('stores the key lower-case and offers it to clients', async () => {
    const created = await methods.create(
      { key: 'Bank_Transfer', name: '  Bank transfer  ', sortOrder: 2 },
      TEST_ACTOR,
    );

    expect(created.key).toBe('bank_transfer');
    expect(created.name).toBe('Bank transfer');
    expect(created.enabled).toBe(true);
    expect(await offeredToClients()).toEqual(['whish', 'bank_transfer']);
  });

  it('refuses a key that already exists, whatever its case', async () => {
    await expect(
      methods.create({ key: 'WHISH', name: 'Another Whish' }, TEST_ACTOR),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('records who added it', async () => {
    await methods.create({ key: 'omt', name: 'OMT' }, TEST_ACTOR);

    expect(audit.record).toHaveBeenCalledWith(
      TEST_ACTOR.id,
      'withdrawal_method.create',
      'withdrawal_method',
      'omt',
      expect.objectContaining({ name: 'OMT', enabled: true }),
    );
  });
});

describe('changing a method', () => {
  /*
   * THE contract with the portal: switched off here, gone from the withdraw
   * form. The row stays, because requests already made on it still name it.
   */
  it('stops offering a disabled method to clients, and keeps the row', async () => {
    await methods.update('whish', { enabled: false }, TEST_ACTOR);

    expect(await offeredToClients()).toEqual([]);
    expect((await methods.listAll()).map((row) => row.key)).toContain('whish');
  });

  it('records the change as a diff', async () => {
    await methods.update('Whish', { enabled: false, name: 'Whish Money' }, TEST_ACTOR);

    expect(audit.record).toHaveBeenCalledWith(
      TEST_ACTOR.id,
      'withdrawal_method.update',
      'withdrawal_method',
      'whish',
      { changed: { enabled: { before: true, after: false } } },
    );
  });

  it('refuses an unknown key rather than creating it', async () => {
    await expect(methods.update('nope', { enabled: false }, TEST_ACTOR)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('reorders what clients see', async () => {
    await methods.create({ key: 'bank', name: 'Bank transfer', sortOrder: 5 }, TEST_ACTOR);
    await methods.update('bank', { sortOrder: 0 }, TEST_ACTOR);
    await methods.update('whish', { sortOrder: 9 }, TEST_ACTOR);

    expect(await offeredToClients()).toEqual(['bank', 'whish']);
  });
});

describe('migration 0143 — withdrawal logos from the deposit twin', () => {
  /*
   * Re-applies the migration's statement against this suite's database, where
   * the migration has already run once: the point is that it FILLS gaps from
   * the same-key deposit method and never overwrites a logo that is set.
   */
  async function runBackfill(): Promise<void> {
    await ctx.db.execute(sql`
      UPDATE withdrawal_payment_methods AS w
         SET logo_url = d.logo_url, updated_at = now()
        FROM payment_methods AS d
       WHERE d.key = w.key AND w.logo_url IS NULL AND d.logo_url IS NOT NULL
    `);
  }

  it('fills a missing logo from the deposit method with the same key, and only then', async () => {
    const logo = '/v1/uploads/payment-logos/whish-logo.svg';
    await ctx.db.execute(sql`
      INSERT INTO payment_methods (key, name, currency, logo_url)
      VALUES ('whish', 'Whish Money', 'USD', ${logo})
      ON CONFLICT (key) DO UPDATE SET logo_url = ${logo}
    `);
    await ctx.db.execute(
      sql`UPDATE withdrawal_payment_methods SET logo_url = NULL WHERE key = 'whish'`,
    );
    await methods.create({ key: 'bank', name: 'Bank transfer' }, TEST_ACTOR);

    await runBackfill();

    const rows = await methods.listAll();
    expect(rows.find((row) => row.key === 'whish')?.logoUrl).toBe(logo);
    // No deposit twin with a logo — left as it was.
    expect(rows.find((row) => row.key === 'bank')?.logoUrl).toBeNull();

    // An operator's own withdrawal logo is never overwritten.
    await methods.update('whish', { logoUrl: 'https://cdn.example.com/whish-out.svg' }, TEST_ACTOR);
    await runBackfill();
    expect((await methods.findOne('whish'))?.logoUrl).toBe('https://cdn.example.com/whish-out.svg');
  });
});
