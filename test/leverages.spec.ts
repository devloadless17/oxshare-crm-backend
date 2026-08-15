import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { LeveragesService } from '../src/modules/leverages/leverages.service';
import { auditStubAs, TEST_ACTOR as ACTOR } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The leverage ladder's rules.
 *
 * Against a real database rather than a stub, because the two rules that matter
 * are statements about the OTHER ROWS: "this is the last enabled rung" and
 * "accounts are open at this ratio" cannot be exercised by a service holding a
 * fake that returns whatever the test says.
 *
 * ## What moved here from `settings-service.spec.ts`
 *
 * The ladder was a CSV on `trading_settings`, and three cases pinned its
 * parsing: normalising what an operator typed, refusing `1OO` rather than
 * dropping it, and refusing an empty ladder. The first two have no analogue —
 * a rung is a row with an integer primary key, so there is no format a typo can
 * hide inside. The third survives as a refusal to disable the last enabled rung,
 * which is the same guarantee stated against the data instead of the string.
 */
let ctx: MoneyTestContext;
let service: LeveragesService;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  service = new LeveragesService(ctx.db, auditStubAs());
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  /*
   * Accounts first: `remove` reads `trading_accounts.leverage`, and a row left
   * behind by the in-use case below would block an unrelated delete two tests
   * later. There is no foreign key to order this for us — deliberately, see the
   * table note — so the fixture has to.
   */
  await ctx.db.execute(sql`DELETE FROM trading_accounts`);
  await ctx.db.execute(sql`DELETE FROM leverages`);
  await ctx.db.execute(sql`
    INSERT INTO leverages (ratio, sort_order) VALUES (50, 0), (100, 10), (500, 20)`);
});

describe('what a client may choose', () => {
  it('offers the enabled rungs in the operator’s order', async () => {
    await service.update(100, { sortOrder: -10 }, ACTOR);

    // `sortOrder`, not the ratio: the order is the operator's, and it is the
    // order the client sees in the dropdown.
    expect(await service.listEnabled()).toEqual([100, 50, 500]);
  });

  it('leaves a disabled rung out entirely rather than flagging it', async () => {
    await service.update(500, { enabled: false }, ACTOR);

    // Filtering in the service is what stops a caller forgetting to — the
    // portal receives a list it can render straight through.
    expect(await service.listEnabled()).toEqual([50, 100]);
  });

  it('falls back to a default ladder when the table is empty', async () => {
    /*
     * A platform mid-setup, not a deliberate choice. An empty ladder renders an
     * account-opening form with no options, and the client cannot fix that from
     * where they are standing.
     */
    await ctx.db.execute(sql`DELETE FROM leverages`);

    expect(await service.listEnabled()).toEqual([50, 100, 200, 500]);
  });

  it('shows an operator the disabled rungs too', async () => {
    await service.update(500, { enabled: false }, ACTOR);

    // The admin list is NOT the client list: somebody has to see what they
    // withdrew in order to put it back.
    const all = await service.listAll();
    expect(all.map((row) => row.ratio)).toEqual([50, 100, 500]);
  });
});

describe('adding a rung', () => {
  it('takes the ratio as its identity', async () => {
    const created = await service.create({ ratio: 200 }, ACTOR);

    expect(created.ratio).toBe(200);
    expect(created.enabled).toBe(true);
    // Appended, in tens, so a later insert fits between without a renumber.
    expect(created.sortOrder).toBe(30);
  });

  it('refuses a duplicate rather than quietly updating it', async () => {
    await expect(service.create({ ratio: 100 }, ACTOR)).rejects.toThrow(/already on the ladder/i);
  });

  it('refuses anything that is not a positive whole number', async () => {
    /*
     * 500 means 500:1. Zero and negatives are not leverage, and a fraction is
     * not a ratio MT5 accepts — this is what is left of the CSV parser's
     * strictness, stated against a value instead of a string.
     */
    for (const ratio of [0, -100, 1.5]) {
      await expect(service.create({ ratio }, ACTOR), String(ratio)).rejects.toThrow(
        /positive whole number/i,
      );
    }
  });
});

describe('withdrawing a rung', () => {
  it('refuses to disable the last enabled one', async () => {
    await service.update(100, { enabled: false }, ACTOR);
    await service.update(500, { enabled: false }, ACTOR);

    await expect(service.update(50, { enabled: false }, ACTOR)).rejects.toThrow(
      /only leverage on offer/i,
    );
    // And the ladder is still standing.
    expect(await service.listEnabled()).toEqual([50]);
  });

  it('allows re-saving an already-disabled rung', async () => {
    await service.update(500, { enabled: false }, ACTOR);

    /*
     * The last-rung rule is checked on the TRANSITION, not on the resulting
     * value — otherwise editing a disabled rung's label trips a rule about a
     * change it is not making.
     */
    const again = await service.update(500, { label: 'Retired' }, ACTOR);
    expect(again.enabled).toBe(false);
    expect(again.label).toBe('Retired');
  });
});

describe('deleting a rung', () => {
  it('refuses while an account is trading at it', async () => {
    const [user] = (
      await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO users (email, password_hash, first_name, last_name)
        VALUES ('leverage-holder@test.local', 'x', 'A', 'Client') RETURNING id`)
    ).rows;
    await ctx.db.execute(sql`
      INSERT INTO trading_accounts (user_id, login, environment, currency, leverage)
      VALUES (${user.id}, 'LEV-1', 'live', 'USD', 500)`);

    /*
     * ⚠️ The reason this is a refusal and not a cascade. Deleting the rung
     * leaves `trading_accounts.leverage` pointing at a ratio the ladder no
     * longer explains, on an account that is still trading at it — and the
     * operator who wanted it off the menu wanted `enabled: false`.
     */
    await expect(service.remove(500, ACTOR)).rejects.toThrow(/disable it instead/i);
    expect(await service.findOne(500)).not.toBeNull();
  });

  it('removes one nobody is standing on', async () => {
    await service.remove(500, ACTOR);

    expect(await service.findOne(500)).toBeNull();
    expect(await service.listEnabled()).toEqual([50, 100]);
  });
});

describe('the gate on the account-opening path', () => {
  it('accepts a ratio currently on offer', async () => {
    await expect(service.assertUsable(100)).resolves.toBe(100);
  });

  it('refuses one the platform never offered', async () => {
    await expect(service.assertUsable(3000)).rejects.toThrow(
      /not a leverage this platform offers/i,
    );
  });

  it('refuses a WITHDRAWN one', async () => {
    await service.update(500, { enabled: false }, ACTOR);

    // The case a foreign key could not catch: the row still exists, and a
    // client holding the form in a tab must not be able to open on it.
    await expect(service.assertUsable(500)).rejects.toThrow(/not currently available/i);
  });
});
