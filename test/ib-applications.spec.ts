import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { IbApplicationsService } from '../src/modules/ib/ib-applications.service';
import { IbLevelsService } from '../src/modules/ib/ib-levels.service';
import { IbStore } from '../src/store/ib.store';
import { ProductsStore } from '../src/store/products.store';
import { UsersStore } from '../src/store/users.store';
import { ClientVisibilityService } from '../src/common/security/client-visibility.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { WalletProvisioningService } from '../src/modules/wallet/wallet-provisioning.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { WalletsStore } from '../src/store/wallets.store';
import type { EmailService } from '../src/modules/email/email.service';
import { scopeOf, UNRESTRICTED } from '../src/common/security/client-scope';
import type { Actor } from '../src/common/security/actor';
import type { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import { auditStub, auditStubAs } from './audit-stub';
import { notificationsStubAs } from './notifications-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The partner programme's rules.
 *
 * Against a real database, like the levels suite and for the same reason: most
 * of these are statements about OTHER ROWS ("does this parent have room", "is
 * there a pending application already", "would this close a loop") and a
 * service holding a stub proves only that the stub was configured to agree.
 */
let ctx: MoneyTestContext;
let service: IbApplicationsService;
let store: IbStore;
let users: UsersStore;
/**
 * The service's audit writer, kept so a case can read what it was asked to
 * record — the sub-partner terms change (0197) is the first case here whose
 * audit row is part of the behaviour under test.
 */
const audit = auditStub();

/**
 * A stand-in for EmailService, so the decision emails are OBSERVABLE.
 *
 * A real one would short-circuit under NODE_ENV=test and prove nothing. What
 * matters here is not that mail was delivered — that is EmailService's own
 * suite — but that the service asks for it, with the right recipient and the
 * right payload, and only after the decision has actually landed.
 */
const sendPartnerDecisionEmail = vi.fn().mockResolvedValue(undefined);
const email = { sendPartnerDecisionEmail } as unknown as EmailService;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new IbStore(ctx.db);
  users = new UsersStore(ctx.db);
  service = new IbApplicationsService(
    ctx.db,
    store,
    users,
    new IbLevelsService(ctx.db, auditStubAs()),
    new ClientVisibilityService(users),
    email,
    audit as unknown as AdminAuditService,
    notificationsStubAs(),
    /*
     * A REAL store on the test database, not a stub. The agency checks read it
     * on every apply and approve, and the cases worth pinning here — an
     * application against an agency that does not exist, an approval carrying
     * the applicant's choice onto the partner row — are exactly the ones a stub
     * returning `[]` would make unreachable.
     */
    new ProductsStore(ctx.db),
    /*
     * A REAL provisioning service on the test database, not a stub — same
     * reasoning as the store above. What is worth pinning is that approving an
     * application actually OPENS the partner's commission wallet, and a stub
     * would make that assertion a statement about the stub.
     */
    new WalletProvisioningService(
      new WalletService(ctx.db),
      new CurrenciesService(ctx.db, auditStubAs()),
      new WalletsStore(ctx.db),
    ),
  );
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

/**
 * The reviewing administrator.
 *
 * An `Actor` rather than a bare id: the decisions record who made them, and the
 * audit writer needs the actor the same way the money services do. No FK on
 * `reviewed_by`, so any uuid stands in — `REVIEWER.id` is what lands there.
 */
const REVIEWER: Actor = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'ib-reviewer@oxshare.internal',
  permissions: ALL_PERMISSIONS,
};

/**
 * The agency every application is submitted against.
 *
 * A mutable holder rather than a `let`, so the helpers below can close over it
 * once instead of taking it as a parameter each of the forty-odd call sites
 * would then have to thread through.
 */
const AGENCY = { id: '' };

/** Verified by default — the unverified case is a test of its own. */
async function makeClient(email: string, verificationLevel = 1): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Client', ${verificationLevel}, true)
    RETURNING id
  `);
  return rows[0].id;
}

/**
 * A two-rung chain on the default ladder — a level-1 partner, a level-2
 * partner beneath them — and a client attributed to the level-2 one: the exact
 * shape the chain-room rule exists for. The attribution is written directly
 * because that is what registration with a referral code does; going through
 * `apply` is impossible here, since refusing that client is the behaviour
 * under test.
 */
async function twoRungChain(
  prefix: string,
  bottomVerification = 1,
): Promise<{ top: number; middle: number; client: number }> {
  const top = await makeClient(`${prefix}-top@test.local`);
  const topAccount = await service.approve(
    (await service.apply(top, { agencyId: AGENCY.id })).id,
    REVIEWER,
    UNRESTRICTED,
  );
  const middle = await makeClient(`${prefix}-middle@test.local`);
  const middleAccount = await service.approve(
    (await service.apply(middle, { agencyId: AGENCY.id })).id,
    REVIEWER,
    UNRESTRICTED,
    { parentIbUserId: topAccount.userId },
  );
  const client = await makeClient(`${prefix}-bottom@test.local`, bottomVerification);
  await ctx.db.execute(
    sql`UPDATE users SET referred_by_ib_user_id = ${middleAccount.userId} WHERE id = ${client}`,
  );
  return { top: topAccount.userId, middle: middleAccount.userId, client };
}

beforeEach(async () => {
  sendPartnerDecisionEmail.mockClear();
  /*
   * Attribution is cleared BEFORE the partners it points at.
   *
   * `users.referred_by_ib_user_id` is a real foreign key onto
   * `ib_accounts.user_id`, so deleting the accounts first fails on any suite
   * that attributed a client to a partner — which the chain-depth cases below
   * are the first to do. Nulling the column is the only order that works: the
   * users rows are deleted two statements later anyway, so nothing survives it.
   */
  await ctx.db.execute(sql`UPDATE users SET referred_by_ib_user_id = NULL`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM ib_applications`);
  // Territory rows reference users; clear them (and the tags) before the users
  // they point at — the scope test below assigns a tag to a partner.
  await ctx.db.execute(sql`DELETE FROM client_tag_assignments`);
  await ctx.db.execute(sql`DELETE FROM client_tags`);
  /*
   * Wallets reference users with ON DELETE RESTRICT, so they go first.
   *
   * Approving an application now opens the partner's commission wallet, which
   * made `DELETE FROM users` fail for every test after the first approval — the
   * error surfaced as 41 unrelated failures rather than as anything about
   * wallets. Ledger entries reference wallets and are cleared ahead of them for
   * the same reason, even though nothing here posts one yet.
   */
  /*
   * RETRIED, because the insert this races is FIRE-AND-FORGET.
   *
   * Ordering alone is not enough. `WalletProvisioningService.openCommissionWallet`
   * runs AFTER the approval transaction and is deliberately not awaited — the
   * lazy path in `WalletService.post` is what guarantees the wallet exists, so
   * the eager call is only there to spare a new partner a placeholder. That
   * means it can land BETWEEN `DELETE FROM wallets` and `DELETE FROM users`,
   * and the FK then refuses the second delete.
   *
   * It fails as `DELETE FROM users` in a hook, so the report blames a cleanup
   * rather than any assertion — and it only loses the race on a loaded runner,
   * so it passed locally and failed in CI. That is the worst shape a flake can
   * have, which is why this is a retry rather than a longer sleep.
   */
  for (let attempt = 0; ; attempt += 1) {
    try {
      await ctx.db.execute(
        sql`TRUNCATE ledger_entries, ib_accruals CASCADE` /* not DELETE: the ledger is append-only by trigger (§6.4). TRUNCATE resets a fixture table without firing row triggers, and no production path truncates. */,
      );
      await ctx.db.execute(sql`DELETE FROM wallets`);
      await ctx.db.execute(sql`DELETE FROM users`);
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  /*
   * No ladder to seed. `ib_levels` and `ib_accounts.level` went in 0102, so a
   * partner fixture needs only a programme — and the migrations seed one.
   *
   * Programmes created BY a case are removed and the seeded one re-enabled.
   *
   * Both halves are load-bearing. `refuses approval when no programme is
   * enabled` disables the catalogue on purpose, and without the re-enable every
   * later case failed on "no enabled commission programme" — 17 failures whose
   * message named a fixture rather than the assertion that broke. The delete is
   * the other direction: a case that creates "Gold" and leaves it behind can
   * make itself the FIRST enabled programme by sort order, and silently become
   * the terms a later approval assigns.
   */
  /*
   * 'Standard' is the lowest-sorted seeded programme since 0106, which replaced
   * the single 'Default' with a three-programme rate card. Reducing to ONE here
   * is deliberate and not laziness about the other two: several cases below
   * create a 'Gold' of their own to prove that approval falls back to the
   * default rather than inheriting a parent's terms, and a seeded Gold would
   * collide with it on `ib_programs.name`, which is unique.
   */
  await ctx.db.execute(sql`DELETE FROM ib_programs WHERE name <> 'Standard'`);
  await ctx.db.execute(sql`UPDATE ib_programs SET enabled = true WHERE name = 'Standard'`);

  /*
   * An OPEN agency, because an application without one is refused now.
   *
   * Recreated per test rather than once in `beforeAll`: the rows above are
   * cleared wholesale each time, and an agency surviving that while the
   * applications referencing it do not is the kind of half-reset fixture that
   * makes one test depend on another having run.
   */
  await ctx.db.execute(sql`DELETE FROM agencies`);
  const agency = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO agencies (name, enabled) VALUES ('Test Agency', true) RETURNING id
  `);
  AGENCY.id = agency.rows[0].id;
});

/**
 * The programme a fixture partner is placed on.
 *
 * Read rather than hardcoded: migration 0084 seeds one carrying the ladder's
 * own rates, and a fixture pinning its id or name would break the day an
 * operator renames it — which is a change to test data, not to behaviour.

/**
 * THE COMMITTED TWO-LEVEL STRUCTURE, enforced where an operator meets it.
 *
 * Feature List Rev 9 IB-17: "Two-level structure (L1 + L2) — both earn; no
 * level beyond L2." `trading_settings.ib_max_levels` carries that, defaulting to
 * 2, and these assert both halves: the default ships the agreed scope, and
 * raising it is a decision an operator can actually make from the form.
 *
 * The DATABASE bound is deliberately wider (1..10), so that widening the
 * ceiling is a form somebody fills in rather than a migration somebody writes.
 */
/**
 * ── A SUB-PARTNER'S TERMS ARE THE BROKER'S DECISION, NOT THEIR PARENT'S ─────
 *
 * The AGENCY is inherited — a sub-partner sells what their introducer sells,
 * because a downline offering a catalogue the master has no relationship with
 * is incoherent. The PROGRAMME deliberately is not, and the asymmetry is the
 * point: an agency decides what they may SELL, a programme decides what the
 * broker PAYS them.
 *
 * If the programme were inherited, a master partner on Gold would put everyone
 * they recruit on Gold — a partner setting what the broker pays their own
 * downline, out of the broker's money. In practice a sub-partner is usually put
 * on LESS than their parent, who takes the override on top, so inheriting would
 * be exactly backwards.
 *
 * The engine supports the mixed chain on purpose: each earner reads their own
 * programme, and `ib-multi-level.spec.ts` proves a deep programme still pays
 * through a shallow one beneath it.
 */
describe('approving a partner who is already under one', () => {
  /** A parent partner already appointed, and a client they introduced. */
  async function parentAndClient(): Promise<{ parent: number; client: number }> {
    const parent = await makeClient('sub-parent@test.local');
    const parentApp = await service.apply(parent, { agencyId: AGENCY.id });
    await service.approve(parentApp.id, REVIEWER, UNRESTRICTED);

    const client = await makeClient('sub-child@test.local');
    await ctx.db.execute(
      sql`UPDATE users SET referred_by_ib_user_id = ${parent} WHERE id = ${client}`,
    );
    return { parent, client };
  }

  /*
   * ── THE RULE THAT REPLACED PROGRAMME SELECTION (0112) ────────────────────
   *
   * Three tests used to live here, all about which named programme a reviewer
   * picked at approval and whether it leaked from the parent. None of that
   * exists: a partner's terms come from their RUNG, and a rung is not chosen —
   * it follows from who recruited them.
   *
   * So the thing worth pinning is the derivation itself. It is the only place a
   * partner's economics are decided, it happens once, and getting it wrong puts
   * somebody on terms nobody negotiated with no screen showing the mistake.
   */
  it('appoints a partner with no parent on the first rung', async () => {
    const applicant = await makeClient('direct@test.local');
    const application = await service.apply(applicant, { agencyId: AGENCY.id });

    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED);

    expect(account.level).toBe(1);
  });

  it('appoints a recruited partner one rung below the partner who recruited them', async () => {
    const { parent, client } = await parentAndClient();
    const application = await service.apply(client, {});

    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED, {
      parentIbUserId: parent,
    });

    expect(account.level).toBe(2);
    /* And the parent is untouched — one approval must not restate their terms. */
    expect((await store.findAccount(parent))?.level).toBe(1);
  });

  /*
   * The AGENCY is still inherited, and the rung is still derived. They travel
   * together and neither is a reviewer's choice, which is the whole reason the
   * approval screen no longer carries a commercial control at all.
   */
  it('inherits the agency from the parent while deriving the rung', async () => {
    const { parent, client } = await parentAndClient();
    const application = await service.apply(client, {});

    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED, {
      parentIbUserId: parent,
    });

    expect(account.agencyId).toBe(AGENCY.id);
    expect(account.level).toBe(2);
  });
});

describe('how deep the ladder may go', () => {
  const levels = () => new IbLevelsService(ctx.db, auditStubAs());

  /*
   * ── THERE IS NO CONFIGURABLE CEILING ANY MORE (0113) ─────────────────────
   *
   * Five cases stood here, all about `ib_max_levels`: that a third rung was
   * refused under the default of 2, that raising the setting allowed it, that
   * the database refused an absurd ceiling, and that lowering one truncated
   * nothing.
   *
   * The setting is gone. Adding a third rung meant first raising a number on a
   * different screen, which is a second place standing between an operator and
   * a decision the IB Levels page already expresses — remove the rung and it
   * stops paying.
   *
   * ── AND NOW THE TREE IS FIXED AT TWO (0197, the owner's rule, 6 Oct 2026) ──
   *
   * Main partners (level 1) and their sub-partners (level 2), no deeper. The
   * three cases that stood here — a third level accepted, a level no partner
   * stands on accepted, a level past the engine's walk refused — became one
   * rule: anything past level 2 is refused, with the sentence that says why.
   */
  afterEach(async () => {
    // Belt and braces: nothing below should be able to create one.
    await ctx.db.execute(sql`DELETE FROM ib_levels WHERE level > 2`);
  });

  it('refuses a third level — the tree is main partners and sub-partners only', async () => {
    await expect(
      levels().create({ level: 3, name: 'Three Deep', commissionShare: '10' }, REVIEWER),
    ).rejects.toThrow(/partner tree has 2 levels/i);

    const { rows } = await ctx.db.execute<{ n: number }>(
      sql`SELECT count(*)::int n FROM ib_levels WHERE level > 2`,
    );
    expect(rows[0].n).toBe(0);
  });

  /*
   * A level past the engine's walk is refused by the same two-level rule
   * first: the sentence an operator reads is the business rule, not an
   * implementation limit.
   */
  it('refuses a level deeper than the engine walks with the same two-level sentence', async () => {
    await expect(
      levels().create({ level: 11, name: 'Unreachable', commissionShare: '10' }, REVIEWER),
    ).rejects.toThrow(/main partners \(level 1\) and their sub-partners \(level 2\)/i);
  });

  /*
   * The form reads its "how deep may I go" from `limits()`, so the cap it
   * offers is the cap the service enforces.
   */
  it('reports two levels as the limit the form offers', () => {
    expect(levels().limits()).toEqual({ maxLevels: 2, absoluteMaxLevels: 2 });
  });
});

describe('moving a partner onto different terms', () => {
  /*
   * ── THE LEVEL IS THE POSITION (0197) ─────────────────────────────────────
   *
   * `changeLevel` used to move a partner onto any configured, enabled rung.
   * Since the tree became two levels the rung decides which SIDE of the split
   * a partner is paid — level 1 takes the rest, level 2 their own share — so a
   * label that disagrees with the position pays the wrong side. A partner with
   * no parent is level 1, one with a parent is level 2, and moving them is
   * "Reassign parent", which re-levels them.
   */
  async function mainAndSub(prefix: string): Promise<{ main: number; sub: number }> {
    const main = await makeClient(`${prefix}-main@test.local`);
    const sub = await makeClient(`${prefix}-sub@test.local`);
    await store.createAccount({ userId: main, level: 1, referralCode: `${prefix}M`.slice(0, 8) });
    await store.createAccount({
      userId: sub,
      level: 2,
      parentIbUserId: main,
      referralCode: `${prefix}S`.slice(0, 8),
    });
    return { main, sub };
  }

  /*
   * ── A CHANGE OF LEVEL IS A MOVE (owner, 7 Oct 2026) ──────────────────────
   *
   * 2 → 1 detaches them and clears "introduced by" (a new main partner of the
   * broker's); 1 → 2 needs the main partner to sit under, and "introduced by"
   * follows to them.
   */
  it('refuses to move a main partner onto level 2 without naming a parent', async () => {
    const { main } = await mainAndSub('LVMAIN');

    await expect(service.changeLevel(main, 2, UNRESTRICTED, REVIEWER)).rejects.toThrow(
      /Choose the main partner to place them under/i,
    );
    expect((await store.findAccount(main))?.level).toBe(1);
  });

  it('moves a main partner under the named main partner onto level 2', async () => {
    const { main: target } = await mainAndSub('LVTGT');
    const mover = await makeClient('lvmove-main@test.local');
    await store.createAccount({ userId: mover, level: 1, referralCode: 'LVMOVER1' });

    const moved = await service.changeLevel(mover, 2, UNRESTRICTED, REVIEWER, target);

    expect(moved.level).toBe(2);
    expect(moved.parentIbUserId).toBe(target);
    expect((await users.findById(mover))?.referredByIbUserId).toBe(target);
  });

  it('moves a sub-partner to level 1: detached, and "introduced by" removed', async () => {
    const { sub } = await mainAndSub('LVSUB');
    await ctx.db.execute(sql`
      UPDATE users SET referred_by_ib_user_id = (SELECT parent_ib_user_id FROM ib_accounts WHERE user_id = ${sub})
       WHERE id = ${sub}
    `);

    const freed = await service.changeLevel(sub, 1, UNRESTRICTED, REVIEWER);

    expect(freed.level).toBe(1);
    expect(freed.parentIbUserId).toBeNull();
    expect((await users.findById(sub))?.referredByIbUserId).toBeUndefined();
  });

  it('refuses level 2 under a sub-partner, and moves nobody', async () => {
    const { sub } = await mainAndSub('LVBAD');
    const mover = await makeClient('lvbad-mover@test.local');
    await store.createAccount({ userId: mover, level: 1, referralCode: 'LVBADMV1' });

    await expect(service.changeLevel(mover, 2, UNRESTRICTED, REVIEWER, sub)).rejects.toThrow(
      /sub-partner cannot have partners beneath them/i,
    );
    expect((await store.findAccount(mover))?.parentIbUserId).toBeNull();
  });

  /*
   * The level matching the position is still accepted — it is how a partner
   * whose row predates 0197 and carries the wrong label is put right.
   */
  it('accepts the level that matches the position', async () => {
    const { main, sub } = await mainAndSub('LVFIX');
    // A legacy row: under a parent but labelled level 1.
    await ctx.db.execute(sql`UPDATE ib_accounts SET level = 1 WHERE user_id = ${sub}`);

    const fixed = await service.changeLevel(sub, 2, UNRESTRICTED, REVIEWER);
    expect(fixed.level).toBe(2);
    expect((await service.changeLevel(main, 1, UNRESTRICTED, REVIEWER)).level).toBe(1);
  });

  /*
   * A disabled level pays NOTHING, so moving somebody onto one stops their
   * earnings silently instead of changing their terms visibly. The position
   * rule comes first; the disabled refusal still guards the level it allows.
   */
  it('refuses to move a partner onto a disabled level', async () => {
    const { sub } = await mainAndSub('LVDIS');

    await ctx.db.execute(sql`UPDATE ib_levels SET enabled = false WHERE level = 2`);
    try {
      await expect(service.changeLevel(sub, 2, UNRESTRICTED, REVIEWER)).rejects.toThrow(
        /disabled/i,
      );
    } finally {
      await ctx.db.execute(sql`UPDATE ib_levels SET enabled = true WHERE level = 2`);
    }
  });

  /*
   * A level past the tree is refused by the position rule, before the ladder
   * is even consulted: there is no position a level 9 could match.
   */
  it('refuses a level that matches no position in a two-level tree', async () => {
    const { main, sub } = await mainAndSub('LVGHST');

    await expect(service.changeLevel(sub, 9, UNRESTRICTED, REVIEWER)).rejects.toThrow(
      /main partner \(level 1\) or a sub-partner \(level 2\)/i,
    );
    await expect(service.changeLevel(main, 3, UNRESTRICTED, REVIEWER)).rejects.toThrow(
      /main partner \(level 1\) or a sub-partner \(level 2\)/i,
    );
    expect((await store.findAccount(sub))?.parentIbUserId).toBe(main);
  });
});

describe('a sub-partner’s own commission and rebate (0197)', () => {
  /** A main partner and one sub-partner beneath them, on the default ladder. */
  async function mainAndSub(): Promise<{ main: number; sub: number }> {
    const main = await makeClient('terms-main@test.local');
    const sub = await makeClient('terms-sub@test.local');
    await store.createAccount({ userId: main, level: 1, referralCode: 'TERMSMAN' });
    await store.createAccount({
      userId: sub,
      level: 2,
      parentIbUserId: main,
      referralCode: 'TERMSSUB',
    });
    return { main, sub };
  }

  beforeEach(() => {
    audit.record.mockClear();
  });

  it('stores both shares on a sub-partner', async () => {
    const { sub } = await mainAndSub();

    const updated = await service.setTerms(
      sub,
      { commissionShare: '25', rebateShare: '7.5' },
      UNRESTRICTED,
      REVIEWER,
    );

    expect(Number(updated.commissionShareOverride)).toBe(25);
    expect(Number(updated.rebateShareOverride)).toBe(7.5);
    const stored = await store.findAccount(sub);
    expect(Number(stored?.commissionShareOverride)).toBe(25);
    expect(Number(stored?.rebateShareOverride)).toBe(7.5);
  });

  it('resets a share to the level’s with null, and leaves an absent one alone', async () => {
    const { sub } = await mainAndSub();
    await service.setTerms(
      sub,
      { commissionShare: '25', rebateShare: '7.5' },
      UNRESTRICTED,
      REVIEWER,
    );

    const reset = await service.setTerms(sub, { commissionShare: null }, UNRESTRICTED, REVIEWER);

    expect(reset.commissionShareOverride).toBeNull();
    // Absent key = unchanged, not cleared.
    expect(Number(reset.rebateShareOverride)).toBe(7.5);

    const both = await service.setTerms(sub, { rebateShare: null }, UNRESTRICTED, REVIEWER);
    expect(both.commissionShareOverride).toBeNull();
    expect(both.rebateShareOverride).toBeNull();
  });

  it('refuses a main partner — there is no share of theirs to set', async () => {
    const { main } = await mainAndSub();

    await expect(
      service.setTerms(main, { commissionShare: '25' }, UNRESTRICTED, REVIEWER),
    ).rejects.toThrow(/only a sub-partner has their own commission and rebate/i);
    expect((await store.findAccount(main))?.commissionShareOverride).toBeNull();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('writes an ib.terms_change audit row with the shares before and after', async () => {
    const { sub } = await mainAndSub();

    await service.setTerms(
      sub,
      { commissionShare: '25', rebateShare: '7.5' },
      UNRESTRICTED,
      REVIEWER,
    );
    await service.setTerms(sub, { commissionShare: '40' }, UNRESTRICTED, REVIEWER);

    const rows = audit.record.mock.calls.filter((call) => call[1] === 'ib.terms_change');
    expect(rows).toHaveLength(2);
    const [actorId, , subjectType, subjectId, details] = rows[1];
    expect(actorId).toBe(REVIEWER.id);
    expect(subjectType).toBe('ib_account');
    expect(subjectId).toBe(sub);
    const { before, after } = details as {
      before: { commissionShare: string | null; rebateShare: string | null };
      after: { commissionShare: string | null; rebateShare: string | null };
    };
    expect(Number(before.commissionShare)).toBe(25);
    expect(Number(before.rebateShare)).toBe(7.5);
    expect(Number(after.commissionShare)).toBe(40);
    expect(Number(after.rebateShare)).toBe(7.5);
  });
});

describe('applying', () => {
  it('accepts an application from a verified client', async () => {
    const userId = await makeClient('applicant@test.local');

    const application = await service.apply(userId, {
      agencyId: AGENCY.id,
      motivation: 'I have an audience.',
    });

    expect(application.status).toBe('pending');
    expect(application.motivation).toBe('I have an audience.');
  });

  it('refuses an unverified client, and says what to do about it', async () => {
    const userId = await makeClient('unverified@test.local', 0);

    await expect(service.apply(userId, { agencyId: AGENCY.id })).rejects.toThrow(
      /identity must be verified/i,
    );
  });

  /*
   * `EmailVerifiedGuard` on IbController already stops an HTTP caller, which is
   * why this is asserted at the SERVICE: a script, a seeder or the next
   * controller added without the decorator bypasses the guard entirely, and a
   * partner is paid — the referral code is an instrument, and an unverified
   * address is one a stranger may have typed.
   */
  it('refuses a client whose email address is not verified', async () => {
    const userId = await makeClient('email-unverified@test.local');
    await ctx.db.execute(sql`UPDATE users SET email_verified = false WHERE id = ${userId}`);

    await expect(service.apply(userId, { agencyId: AGENCY.id })).rejects.toThrow(
      /verify your email/i,
    );
  });

  /*
   * Email comes FIRST when both are outstanding. Telling somebody to finish KYC
   * before they have clicked the link in their inbox sends them into a wizard
   * they cannot complete.
   */
  it('names the email step before the identity step when both are outstanding', async () => {
    const userId = await makeClient('neither@test.local', 0);
    await ctx.db.execute(sql`UPDATE users SET email_verified = false WHERE id = ${userId}`);

    await expect(service.apply(userId, { agencyId: AGENCY.id })).rejects.toThrow(
      /verify your email/i,
    );
  });

  /*
   * ── An agency is REQUIRED, at both gates ─────────────────────────────────
   *
   * A partner with no agency has clients offered the ENTIRE product catalogue.
   * That is the broadest grant the system makes, and it used to be reachable by
   * leaving a field blank on a form — while every other aspect of the same
   * grant (rung, parent, rate) was chosen deliberately.
   */
  it('refuses an application with no agency', async () => {
    const userId = await makeClient('no-agency@test.local');

    await expect(service.apply(userId, {})).rejects.toThrow(/choose the partner programme/i);
  });

  it('refuses an application against an agency that is closed', async () => {
    const userId = await makeClient('closed-agency@test.local');
    await ctx.db.execute(sql`UPDATE agencies SET enabled = false WHERE id = ${AGENCY.id}`);

    /*
     * Refused on SUBMIT rather than queued and refused at review. The
     * programme is shut; letting the application sit means telling somebody
     * weeks later that what they asked for was never available.
     */
    await expect(service.apply(userId, { agencyId: AGENCY.id })).rejects.toThrow(
      /not open for applications/i,
    );
  });

  it('refuses a second application while one is pending', async () => {
    const userId = await makeClient('double@test.local');
    await service.apply(userId, { agencyId: AGENCY.id });

    await expect(service.apply(userId, { agencyId: AGENCY.id })).rejects.toThrow(
      /already have an application/i,
    );
  });

  it('allows re-applying after a rejection', async () => {
    const userId = await makeClient('rejected-then@test.local');
    const first = await service.apply(userId, { agencyId: AGENCY.id });
    await service.reject(first.id, REVIEWER, UNRESTRICTED, { reason: 'Application is unclear' });

    const second = await service.apply(userId, { agencyId: AGENCY.id });
    expect(second.status).toBe('pending');
    expect(second.id).not.toBe(first.id);
  });

  it('refuses somebody who is already a partner', async () => {
    const userId = await makeClient('already@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });
    await service.approve(application.id, REVIEWER, UNRESTRICTED);

    await expect(service.apply(userId, { agencyId: AGENCY.id })).rejects.toThrow(
      /already a partner/i,
    );
  });
});

describe('status', () => {
  it('distinguishes "never applied" from "rejected, here is why"', async () => {
    const fresh = await makeClient('fresh@test.local');
    const turned = await makeClient('turned-down@test.local');

    const before = await service.statusFor(fresh);
    expect(before.application).toBeNull();
    expect(before.account).toBeNull();

    const application = await service.apply(turned, { agencyId: AGENCY.id });
    await service.reject(application.id, REVIEWER, UNRESTRICTED, {
      reason: 'Expected volume does not meet the programme minimum',
      note: 'Reapply once trading regularly.',
    });

    const after = await service.statusFor(turned);
    expect(after.application?.status).toBe('rejected');
    // Composed, and this is the sentence the portal renders verbatim.
    expect(after.application?.rejectionReason).toBe(
      'Expected volume does not meet the programme minimum — Reapply once trading regularly.',
    );
  });

  it('reports ineligibility with a reason before the client fills anything in', async () => {
    const userId = await makeClient('not-yet@test.local', 0);

    const status = await service.statusFor(userId);
    expect(status.eligible).toBe(false);
    expect(status.ineligibleReason).toMatch(/verified/i);
    expect(status.ineligibleCode).toBe('unverified');
  });

  /*
   * ── THE CEILING IS BACK, AND THE LADDER IS WHAT CARRIES IT ─────────────────
   *
   * 0102 removed the `chain_full` refusal on the reasoning that nesting a
   * partner under another is always structurally possible. 0112 made the rung
   * a partner stands on the whole of their terms again, and the business rule
   * followed: the tree ends where the Commission Levels ladder ends, so a
   * client introduced by a partner on the deepest ENABLED level cannot become
   * a partner — the committed scope (IB-17) is two levels, and the seeded
   * ladder carries exactly L1 and L2.
   *
   * DELIBERATELY not a constant 2: the cases below pin BOTH halves — the door
   * is shut beneath a level-2 partner on the default ladder, and enabling a
   * level 3 opens it with no code change, because depth is the IB Levels
   * page's decision (0113).
   */
  it('refuses a client whose introducer is on the deepest enabled level', async () => {
    const { client } = await twoRungChain('deep');

    const status = await service.statusFor(client);
    expect(status.eligible).toBe(false);
    expect(status.ineligibleCode).toBe('chain_full');
    // The sentence the portal renders verbatim.
    expect(status.ineligibleReason).toMatch(/deepest level/i);
  });

  /*
   * Since 0197 the door beneath a sub-partner stays shut for good: there is
   * no level 3 an operator could enable to open it (the ladder refuses one),
   * and even a level-3 row written behind the service's back changes nothing.
   */
  it('keeps the door shut beneath a sub-partner — no level 3 can open it', async () => {
    const { client } = await twoRungChain('reopened');

    await expect(
      new IbLevelsService(ctx.db, auditStubAs()).create(
        { level: 3, name: 'Three Deep', commissionShare: '10' },
        REVIEWER,
      ),
    ).rejects.toThrow(/partner tree has 2 levels/i);

    await ctx.db.execute(sql`
      INSERT INTO ib_levels (level, name, commission_share, rebate_share, enabled)
      SELECT 3, 'Smuggled', commission_share, rebate_share, true FROM ib_levels WHERE level = 2
    `);
    try {
      const status = await service.statusFor(client);
      expect(status.eligible).toBe(false);
      expect(status.ineligibleCode).toBe('chain_full');
    } finally {
      await ctx.db.execute(sql`DELETE FROM ib_levels WHERE level > 2`);
    }
  });

  /*
   * A DISABLED rung is no rung. It pays nobody standing on it, which is the
   * same reason `changeLevel` refuses to move a partner onto one — so a client
   * under a LEVEL-1 partner is blocked while level 2 is switched off.
   */
  it('treats a disabled rung as no rung at all', async () => {
    const top = await makeClient('disabled-rung-top@test.local');
    const topAccount = await service.approve(
      (await service.apply(top, { agencyId: AGENCY.id })).id,
      REVIEWER,
      UNRESTRICTED,
    );
    const client = await makeClient('disabled-rung-bottom@test.local');
    await ctx.db.execute(
      sql`UPDATE users SET referred_by_ib_user_id = ${topAccount.userId} WHERE id = ${client}`,
    );

    await ctx.db.execute(sql`UPDATE ib_levels SET enabled = false WHERE level = 2`);
    try {
      const status = await service.statusFor(client);
      expect(status.eligible).toBe(false);
      expect(status.ineligibleCode).toBe('chain_full');
    } finally {
      await ctx.db.execute(sql`UPDATE ib_levels SET enabled = true WHERE level = 2`);
    }
  });

  /*
   * `chain_full` OUTRANKS `unverified` when both are unmet. `unverified` comes
   * with a "Verify now" button, and sending a client through the whole KYC
   * wizard to reach a door that stays shut is an errand the platform knows to
   * be pointless.
   */
  it('reports chain_full ahead of unverified — no errand unlocks a full ladder', async () => {
    const { client } = await twoRungChain('unverified-under', 0);

    const status = await service.statusFor(client);
    expect(status.eligible).toBe(false);
    expect(status.ineligibleCode).toBe('chain_full');
  });

  /*
   * And the door is shut, not merely the form: `statusFor` decides what a
   * screen SHOWS, and `apply` is the control. A form that offers something the
   * endpoint refuses — or the reverse — is the disagreement worth pinning in
   * both directions.
   */
  it('refuses the application at the door, with the sentence the form shows', async () => {
    const { client } = await twoRungChain('door');

    await expect(service.apply(client, { agencyId: AGENCY.id })).rejects.toThrow(/deepest level/i);
  });

  /*
   * Applying under a sub-partner is chain-full (0197): the case that used to
   * prove a third level opened the door now proves nothing can, and that no
   * application row is left behind by the refusal.
   */
  it('refuses an application under a sub-partner as chain-full, leaving no row', async () => {
    const { client } = await twoRungChain('accepted');

    await expect(service.apply(client, { agencyId: AGENCY.id })).rejects.toThrow(/deepest level/i);

    const { rows } = await ctx.db.execute<{ n: number }>(
      sql`SELECT count(*)::int n FROM ib_applications WHERE user_id = ${client}`,
    );
    expect(rows[0].n).toBe(0);
  });

  /*
   * The bias that matters: a false positive HIDES the form from somebody
   * entitled to it. A client under a level-1 partner still has rung 2 free, and
   * an unattributed client is the case the ladder always has room for.
   */
  it('leaves a client under a top-level partner eligible', async () => {
    const top = await makeClient('room-top@test.local');
    const topAccount = await service.approve(
      (await service.apply(top, { agencyId: AGENCY.id })).id,
      REVIEWER,
      UNRESTRICTED,
    );
    const client = await makeClient('room-bottom@test.local');
    await ctx.db.execute(
      sql`UPDATE users SET referred_by_ib_user_id = ${topAccount.userId} WHERE id = ${client}`,
    );

    const status = await service.statusFor(client);
    expect(status.eligible).toBe(true);
    expect(status.ineligibleCode).toBeNull();
  });

  /*
   * There is deliberately no "introducer is not a partner" case here.
   *
   * `users.referred_by_ib_user_id` is a foreign key onto `ib_accounts.user_id`,
   * so an attribution to a non-partner cannot be written at all — the setup for
   * that test fails on the constraint rather than on the assertion. The service
   * still handles the shape defensively (`if (!introducer) return false`),
   * because the store returns null for a row it cannot find and a check that
   * assumed otherwise would fail closed, hiding the form from an entitled
   * client. It is unreachable, not unconsidered.
   */
  it('leaves an unattributed client eligible', async () => {
    const client = await makeClient('unattributed@test.local');

    const status = await service.statusFor(client);
    expect(status.eligible).toBe(true);
    expect(status.ineligibleCode).toBeNull();
  });
});

describe('approval', () => {
  /*
   * The approval half of the agency rule, and the case that actually bites: an
   * application submitted BEFORE an agency was required carries none, and the
   * ~691 already in the queue are all like that. The reviewer must choose one
   * — a decision they were previously making implicitly, as "everything".
   */
  it('refuses to approve an application that carries no agency', async () => {
    const userId = await makeClient('legacy-applicant@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });
    // The shape of a pre-requirement row, which `apply` can no longer produce.
    await ctx.db.execute(
      sql`UPDATE ib_applications SET agency_id = NULL WHERE id = ${application.id}`,
    );

    await expect(service.approve(application.id, REVIEWER, UNRESTRICTED)).rejects.toThrow(
      /cannot be approved without one/i,
    );
  });

  it('lets the reviewer supply the agency an old application lacks', async () => {
    const userId = await makeClient('legacy-fixed@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });
    await ctx.db.execute(
      sql`UPDATE ib_applications SET agency_id = NULL WHERE id = ${application.id}`,
    );

    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED, {
      agencyId: AGENCY.id,
    });

    expect(account.agencyId).toBe(AGENCY.id);
  });

  it('refuses an explicit null, which used to mean "under no agency"', async () => {
    const userId = await makeClient('explicit-null@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });

    /*
     * `null` was the deliberate way to reach the pre-agency behaviour. It is
     * refused now — the escape hatch and the accident led to the same place,
     * and that place grants the whole catalogue.
     */
    await expect(
      service.approve(application.id, REVIEWER, UNRESTRICTED, { agencyId: null }),
    ).rejects.toThrow(/cannot be approved without one/i);
  });

  /**
   * ── A SUB-PARTNER INHERITS THEIR INTRODUCER'S AGENCY ──────────────────────
   *
   * The rule the whole agency feature exists for, and it was enforced by code
   * that nothing asserted. `agencies` carry products, products carry MT5
   * groups — so the agency decides what a partner's clients may open. A
   * sub-partner who ended up on a different agency would be selling a catalogue
   * their introducer has no relationship with, while commission flowed up a
   * chain whose top never agreed to it.
   *
   * Three cases, because the rule has three halves that can each break alone:
   * the inheritance itself, the fact that a stale form CANNOT override it, and
   * the products that follow from it.
   */
  describe('a sub-partner sells under their introducer', () => {
    /** A second agency, so "inherited" is distinguishable from "the only one". */
    async function otherAgency(): Promise<string> {
      const { rows } = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO agencies (name, enabled) VALUES ('Other Agency', true) RETURNING id
      `);
      return rows[0].id;
    }

    /** A partner on `agencyId`, and a client attributed to them. */
    async function partnerWithClient(
      agencyId: string,
      emails: [string, string],
    ): Promise<{ partner: number; client: number }> {
      const partner = await makeClient(emails[0]);
      const application = await service.apply(partner, { agencyId });
      await service.approve(application.id, REVIEWER, UNRESTRICTED);

      const client = await makeClient(emails[1]);
      await ctx.db.execute(
        sql`UPDATE users SET referred_by_ib_user_id = ${partner} WHERE id = ${client}`,
      );
      return { partner, client };
    }

    it('takes the introducer’s agency, not the one the applicant sent', async () => {
      const other = await otherAgency();
      const { client } = await partnerWithClient(AGENCY.id, [
        'inherit-parent@test.local',
        'inherit-child@test.local',
      ]);

      /*
       * The applicant asks for the OTHER agency. The portal does not draw the
       * picker for a sub-partner, so this is a stale form or a hand-made
       * request — ignored rather than refused, and the introducer's answer
       * wins.
       */
      const application = await service.apply(client, { agencyId: other });

      expect(application.agencyId).toBe(AGENCY.id);
      expect(application.agencyId).not.toBe(other);
    });

    it('carries that agency onto the approved partner account', async () => {
      const { client } = await partnerWithClient(AGENCY.id, [
        'inherit-approve-parent@test.local',
        'inherit-approve-child@test.local',
      ]);

      const application = await service.apply(client, {});
      const account = await service.approve(application.id, REVIEWER, UNRESTRICTED);

      expect(account.agencyId).toBe(AGENCY.id);
    });

    /*
     * The end of the chain, and the reason any of this matters: agency →
     * products → MT5 groups. Two partners on one agency are offered the same
     * catalogue, so their clients can open the same accounts.
     */
    it('offers the sub-partner the same products as their introducer', async () => {
      const { rows: product } = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO trading_products (name, enabled, type, sort_order)
        VALUES ('Agency Product', true, 'real', 950)
        ON CONFLICT (name) DO UPDATE SET enabled = true
        RETURNING id
      `);
      await ctx.db.execute(sql`
        INSERT INTO agency_products (agency_id, product_id)
        VALUES (${AGENCY.id}, ${product[0].id})
        ON CONFLICT DO NOTHING
      `);

      const { partner, client } = await partnerWithClient(AGENCY.id, [
        'inherit-products-parent@test.local',
        'inherit-products-child@test.local',
      ]);
      const application = await service.apply(client, {});
      await service.approve(application.id, REVIEWER, UNRESTRICTED);

      const parentStatus = await service.statusFor(partner);
      const childStatus = await service.statusFor(client);

      expect(parentStatus.account?.products).toEqual(['Agency Product']);
      expect(childStatus.account?.products).toEqual(parentStatus.account?.products);
    });

    /* Arabic (0179): the agency and its products travel in both languages. */
    it('serves the agency and product names in Arabic beside the English', async () => {
      await ctx.db.execute(sql`
        UPDATE agencies SET name_ar = 'وكالة الاختبار' WHERE id = ${AGENCY.id}
      `);
      const { rows: product } = await ctx.db.execute<{ id: string }>(sql`
        INSERT INTO trading_products (name, name_ar, enabled, type, sort_order)
        VALUES ('Arabic Product', 'منتج عربي', true, 'real', 951)
        ON CONFLICT (name) DO UPDATE SET name_ar = 'منتج عربي'
        RETURNING id
      `);
      await ctx.db.execute(sql`
        INSERT INTO agency_products (agency_id, product_id)
        VALUES (${AGENCY.id}, ${product[0].id})
        ON CONFLICT DO NOTHING
      `);

      const { partner, client } = await partnerWithClient(AGENCY.id, [
        'arabic-parent@test.local',
        'arabic-child@test.local',
      ]);
      const before = await service.statusFor(client);
      expect(before.inheritedAgency).toMatchObject({
        name: 'Test Agency',
        nameAr: 'وكالة الاختبار',
      });

      const application = await service.apply(client, {});
      expect((await service.statusFor(client)).application?.agencyNameAr).toBe('وكالة الاختبار');
      await service.approve(application.id, REVIEWER, UNRESTRICTED);

      const status = await service.statusFor(partner);
      expect(status.account?.agencyNameAr).toBe('وكالة الاختبار');
      const pairs = (status.account?.products ?? []).map((name, i) => [
        name,
        status.account?.productsAr[i],
      ]);
      expect(pairs).toContainEqual(['Arabic Product', 'منتج عربي']);
    });

    /*
     * A DIRECT applicant — nobody above them — still chooses, because there is
     * no introducer for the answer to come from. The mirror of the cases above,
     * so none of them can pass by the service simply always using `AGENCY.id`.
     */
    it('still lets an unattributed applicant choose', async () => {
      const other = await otherAgency();
      const userId = await makeClient('inherit-direct@test.local');

      const application = await service.apply(userId, { agencyId: other });

      expect(application.agencyId).toBe(other);
    });
  });

  it('approves against a CLOSED agency, unlike apply', async () => {
    const userId = await makeClient('closed-at-review@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });
    await ctx.db.execute(sql`UPDATE agencies SET enabled = false WHERE id = ${AGENCY.id}`);

    /*
     * Closing a programme stops NEW applications; it does not strand the ones
     * already in the queue. The asymmetry with `apply` is deliberate.
     */
    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED);
    expect(account.agencyId).toBe(AGENCY.id);
  });

  it('opens the new partner a COMMISSION wallet, and no balance in it', async () => {
    /*
     * The lazy path in `WalletService.post` would open this on the first
     * confirmed accrual anyway, so what this pins is the SCREEN: a partner
     * approved today opens /partner and finds a commission card rather than a
     * placeholder for one.
     *
     * Fire-and-forget after the transaction, so it is awaited here by polling
     * rather than by the approve() promise -- the approval must not fail because
     * a wallet did not open, which is the whole reason it is not inside.
     */
    const userId = await makeClient('gets-a-commission-wallet@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });
    await service.approve(application.id, REVIEWER, UNRESTRICTED);

    let rows: { kind: string; balance: string; currency: string }[] = [];
    for (let attempt = 0; attempt < 50 && rows.length === 0; attempt += 1) {
      const result = await ctx.db.execute<{ kind: string; balance: string; currency: string }>(
        sql`SELECT kind, balance, currency FROM wallets
             WHERE user_id = ${userId} AND kind = 'commission'`,
      );
      rows = result.rows;
      if (rows.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(rows).toHaveLength(1);
    /*
     * EMPTY, and that matters more than its existence. A wallet opened with a
     * balance would be money nobody earned -- the one outcome the whole
     * commission separation exists to make impossible.
     */
    expect(rows[0].balance).toBe('0.00000000');

    // ...and it did NOT open a second MAIN wallet in the same currency, which is
    // what a conflict target still naming (user_id, currency) would have done.
    const { rows: main } = await ctx.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM wallets
           WHERE user_id = ${userId} AND kind = 'main' AND currency = ${rows[0].currency}`,
    );
    expect(Number(main[0].n)).toBeLessThanOrEqual(1);
  });

  it('appoints a partner with no parent at the top of their own chain', async () => {
    const userId = await makeClient('direct@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });

    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED);

    expect(account.parentIbUserId).toBeNull();
    expect(account.referralCode).toHaveLength(8);
  });

  /*
   * PLACEMENT is the parent and nothing else now.
   *
   * This used to assert `child.level === 2` beside the parent link — two
   * records of one relationship, free to disagree. 0102 dropped the column: how
   * far above a client a partner stands is computed per accrual by
   * `resolveChain`, from this link.
   */
  it('nests a partner under the parent the reviewer chose', async () => {
    const parentId = await makeClient('the-parent@test.local');
    const parentApp = await service.apply(parentId, { agencyId: AGENCY.id });
    await service.approve(parentApp.id, REVIEWER, UNRESTRICTED);

    const childId = await makeClient('the-child@test.local');
    const childApp = await service.apply(childId, { agencyId: AGENCY.id });
    const child = await service.approve(childApp.id, REVIEWER, UNRESTRICTED, {
      parentIbUserId: parentId,
    });

    expect(child.parentIbUserId).toBe(parentId);
  });

  /*
   * ── THE DISABLED-PROGRAMME REFUSAL IS GONE (0112) ────────────────────────
   *
   * A test here refused to appoint a partner onto a disabled programme, because
   * that produced somebody whose referral link worked and whose earnings were
   * silently zero. Approval names no terms at all now — the rung is derived —
   * so the case cannot arise at this door.
   *
   * The equivalent hazard moved rather than vanished: a partner can sit on a
   * rung that is disabled, or on one the ladder does not reach. `calculate`
   * reports both by name in `skippedReason` instead of paying silently, and
   * `commission.spec.ts` pins each.
   */

  /*
   * The `maxDirectPartners` case that stood here is gone with migration 0055,
   * which dropped the column. What `assertParentHasRoom` still enforces — the
   * parent exists, and is not suspended — is covered below.
   */
  it('refuses a parent who is suspended', async () => {
    const parentId = await makeClient('suspended-parent@test.local');
    const parentApp = await service.apply(parentId, { agencyId: AGENCY.id });
    await service.approve(parentApp.id, REVIEWER, UNRESTRICTED);
    await ctx.db.execute(sql`UPDATE ib_accounts SET active = false WHERE user_id = ${parentId}`);

    const childId = await makeClient('orphan@test.local');
    const childApp = await service.apply(childId, { agencyId: AGENCY.id });

    await expect(
      service.approve(childApp.id, REVIEWER, UNRESTRICTED, { parentIbUserId: parentId }),
    ).rejects.toThrow(/suspended/i);
  });

  /*
   * The approval half of the chain-room rule. `apply` shuts the door on a
   * client whose INTRODUCER is on the deepest rung, but the reviewer resolves
   * the parent at approval time — so an application that entered the queue
   * legitimately (no introducer at all) can still be AIMED beneath a partner
   * the ladder ends at, and that is where this refusal bites. The message
   * names both remedies, because both are ordinary decisions.
   */
  it('refuses to nest a new partner beneath a parent on the deepest enabled level', async () => {
    const { middle } = await twoRungChain('nest-refused');

    const applicant = await makeClient('nest-refused-applicant@test.local');
    const application = await service.apply(applicant, { agencyId: AGENCY.id });

    await expect(
      service.approve(application.id, REVIEWER, UNRESTRICTED, { parentIbUserId: middle }),
    ).rejects.toThrow(/sub-partner cannot have partners beneath them/i);
  });

  /*
   * 0197: approving under a sub-partner is refused even with a level-3 row in
   * the table — the tree's two-level rule, not the ladder, is what decides it —
   * and the refusal leaves the application pending and no account behind.
   */
  it('refuses to approve a partner under a sub-partner, whatever the ladder holds', async () => {
    const { middle } = await twoRungChain('approve-under-sub');
    const applicant = await makeClient('approve-under-sub-applicant@test.local');
    const application = await service.apply(applicant, { agencyId: AGENCY.id });

    await ctx.db.execute(sql`
      INSERT INTO ib_levels (level, name, commission_share, rebate_share, enabled)
      SELECT 3, 'Smuggled', commission_share, rebate_share, true FROM ib_levels WHERE level = 2
    `);
    try {
      await expect(
        service.approve(application.id, REVIEWER, UNRESTRICTED, { parentIbUserId: middle }),
      ).rejects.toThrow(/sub-partner cannot have partners beneath them/i);
    } finally {
      await ctx.db.execute(sql`DELETE FROM ib_levels WHERE level > 2`);
    }

    expect(await store.findAccount(applicant)).toBeUndefined();
    const { rows } = await ctx.db.execute<{ status: string }>(
      sql`SELECT status FROM ib_applications WHERE id = ${application.id}`,
    );
    expect(rows[0].status).toBe('pending');
  });

  /*
   * The escape hatch the refusal must not close: a reviewer may still ROOT an
   * applicant whose introducer is chain-blocked. Explicit null means "deal
   * direct", the rung written is 1, and the ladder has nothing to say about a
   * partner placed at its top. The application predates the attribution here
   * because `apply` would refuse it afterwards — the same order the door test
   * pins from the other side.
   */
  it('still lets the reviewer root an applicant whose introducer is chain-blocked', async () => {
    const applicant = await makeClient('rooted-anyway@test.local');
    const application = await service.apply(applicant, { agencyId: AGENCY.id });

    const { middle } = await twoRungChain('rooted-anyway');
    await ctx.db.execute(
      sql`UPDATE users SET referred_by_ib_user_id = ${middle} WHERE id = ${applicant}`,
    );

    // Omitting the parent would inherit the level-2 introducer and be refused;
    // the explicit null is the reviewer's decision, and it stands.
    await expect(
      service.approve(application.id, REVIEWER, UNRESTRICTED, { parentIbUserId: middle }),
    ).rejects.toThrow(/sub-partner cannot have partners beneath them/i);

    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED, {
      parentIbUserId: null,
    });
    expect(account.level).toBe(1);
    expect(account.parentIbUserId).toBeNull();
  });

  it('refuses when a second reviewer already decided — the WHERE clause, not the pre-read', async () => {
    const userId = await makeClient('raced@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });

    await service.approve(application.id, REVIEWER, UNRESTRICTED);

    await expect(
      service.reject(application.id, REVIEWER, UNRESTRICTED, { reason: 'Too late' }),
    ).rejects.toThrow(/already|approved/i);
  });

  it('creates no account when the transition loses the race', async () => {
    const userId = await makeClient('atomic@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });

    // Somebody else rejects it first. The approve below must leave NOTHING
    // behind — an account without an approved application is a partner nobody
    // decided to create.
    await service.reject(application.id, REVIEWER, UNRESTRICTED, { reason: 'Not eligible' });

    await expect(service.approve(application.id, REVIEWER, UNRESTRICTED)).rejects.toThrow();

    const account = await store.findAccount(userId);
    expect(account).toBeUndefined();
  });

  it('issues referral codes from an unambiguous alphabet', async () => {
    const userId = await makeClient('code@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });
    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED);

    // No 0/O, no 1/I/L — these are dictated over the phone and typed by
    // somebody who is not the partner.
    expect(account.referralCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });
});

describe('rejection', () => {
  it('refuses a rejection with no reason at all', async () => {
    const userId = await makeClient('no-reason@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });

    await expect(service.reject(application.id, REVIEWER, UNRESTRICTED, {})).rejects.toThrow(
      /needs a reason/i,
    );
  });

  it('accepts a bare note without a configured label', async () => {
    const userId = await makeClient('note-only@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });

    const rejected = await service.reject(application.id, REVIEWER, UNRESTRICTED, {
      note: 'Duplicate of an earlier application.',
    });
    expect(rejected.rejectionReason).toBe('Duplicate of an earlier application.');
  });

  it('records who decided and when', async () => {
    const userId = await makeClient('recorded@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });

    const rejected = await service.reject(application.id, REVIEWER, UNRESTRICTED, {
      reason: 'Application is incomplete or unclear',
    });
    expect(rejected.reviewedBy).toBe(REVIEWER.id);
    expect(rejected.reviewedAt).toBeInstanceOf(Date);
  });
});

describe('the cycle guard', () => {
  /** A → B → C, returned top-down. */
  async function makeChain(): Promise<[number, number, number]> {
    const a = await makeClient('chain-a@test.local');
    const b = await makeClient('chain-b@test.local');
    const c = await makeClient('chain-c@test.local');

    await store.createAccount({
      userId: a,
      level: 1,
      referralCode: 'CHAINAAA',
    });
    await store.createAccount({
      userId: b,
      level: 1,
      parentIbUserId: a,
      referralCode: 'CHAINBBB',
    });
    await store.createAccount({
      userId: c,
      level: 1,
      parentIbUserId: b,
      referralCode: 'CHAINCCC',
    });
    return [a, b, c];
  }

  it('refuses to make a partner their own parent', async () => {
    const [a] = await makeChain();
    expect(await service.wouldCreateCycle(a, a)).toBe(true);
  });

  it('refuses a parent who is already a descendant', async () => {
    const [a, , c] = await makeChain();
    // A is the top; making C — two levels beneath — A's parent closes the ring.
    expect(await service.wouldCreateCycle(a, c)).toBe(true);
  });

  it('allows an unrelated partner as a parent', async () => {
    const [, b] = await makeChain();
    const outsider = await makeClient('outsider@test.local');
    await store.createAccount({
      userId: outsider,
      level: 1,
      referralCode: 'OUTSIDER',
    });

    expect(await service.wouldCreateCycle(outsider, b)).toBe(false);
  });

  it('terminates on a chain that is ALREADY cyclic', async () => {
    const [a, , c] = await makeChain();
    // Postgres permits this — the schema spec asserts that gap. The chain
    // walk's `path` guard is what makes this query still return.
    await ctx.db.execute(sql`UPDATE ib_accounts SET parent_ib_user_id = ${c} WHERE user_id = ${a}`);

    await expect(store.ancestorsOf(c)).resolves.toBeInstanceOf(Array);
  });

  it('cannot close a ring with two CONCURRENT opposite moves', async () => {
    /*
     * Two roots, X and Y. "X under Y" and "Y under X" are each legal against
     * the tree as it stands; run together, a check read outside the write's
     * transaction let both pass and commit X→Y→X. Under the tree lock the
     * second sees the first's write and is refused.
     */
    const x = await makeClient('race-x@test.local');
    const y = await makeClient('race-y@test.local');
    await store.createAccount({ userId: x, level: 1, referralCode: 'RACEXXXX' });
    await store.createAccount({ userId: y, level: 1, referralCode: 'RACEYYYY' });

    for (let round = 0; round < 5; round += 1) {
      await ctx.db.execute(
        sql`UPDATE ib_accounts SET parent_ib_user_id = NULL WHERE user_id IN (${x}, ${y})`,
      );
      const results = await Promise.allSettled([
        service.reassignParent(x, y, UNRESTRICTED, REVIEWER),
        service.reassignParent(y, x, UNRESTRICTED, REVIEWER),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const { rows } = await ctx.db.execute<{ n: number }>(sql`
        SELECT count(*)::int n FROM ib_accounts
         WHERE user_id IN (${x}, ${y}) AND parent_ib_user_id IS NOT NULL
      `);
      expect(rows[0].n).toBe(1);
    }
  });
});

describe('the decision email', () => {
  it('sends the referral code on approval', async () => {
    const userId = await makeClient('approved-mail@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });

    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED);
    // Fire-and-forget, so it is not awaited by the caller. One turn is enough
    // for the promise chain the service kicked off.
    await vi.waitFor(() => expect(sendPartnerDecisionEmail).toHaveBeenCalledTimes(1));

    expect(sendPartnerDecisionEmail).toHaveBeenCalledWith(
      'approved-mail@test.local',
      'Test',
      'approved',
      { referralCode: account.referralCode },
      'en',
    );
  });

  it('sends the COMPOSED reason on rejection, not its parts', async () => {
    const userId = await makeClient('rejected-mail@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });

    await service.reject(application.id, REVIEWER, UNRESTRICTED, {
      reason: 'Application is incomplete or unclear',
      note: 'No website given.',
    });
    await vi.waitFor(() => expect(sendPartnerDecisionEmail).toHaveBeenCalledTimes(1));

    // The same sentence the portal renders. Two copies assembled differently
    // is how an email and a screen end up disagreeing about why.
    expect(sendPartnerDecisionEmail).toHaveBeenCalledWith(
      'rejected-mail@test.local',
      'Test',
      'rejected',
      { reason: 'Application is incomplete or unclear — No website given.' },
      'en',
    );
  });

  it('sends nothing when the decision was refused', async () => {
    const userId = await makeClient('no-mail@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });
    await service.approve(application.id, REVIEWER, UNRESTRICTED);
    /*
     * Wait for the APPROVAL's email before clearing.
     *
     * It is fire-and-forget, so it lands a turn after `approve` resolves —
     * clearing immediately would let it arrive afterwards and be counted as a
     * rejection email that was never sent. This assertion is about the reject
     * call below, so the earlier send has to be settled and cleared first.
     */
    await vi.waitFor(() => expect(sendPartnerDecisionEmail).toHaveBeenCalledTimes(1));
    sendPartnerDecisionEmail.mockClear();

    await expect(
      service.reject(application.id, REVIEWER, UNRESTRICTED, { reason: 'Too late' }),
    ).rejects.toThrow();

    // A client told they were rejected after being approved is worse than no
    // email at all.
    expect(sendPartnerDecisionEmail).not.toHaveBeenCalled();
  });
});

describe('managing a live partner', () => {
  /** A → B, both real partners. Returns [parent, child]. */
  async function makePair(): Promise<[number, number]> {
    const parent = await makeClient('mgmt-parent@test.local');
    const child = await makeClient('mgmt-child@test.local');
    await store.createAccount({
      userId: parent,
      level: 1,
      referralCode: 'MGMTPRNT',
    });
    await store.createAccount({
      userId: child,
      level: 2,
      parentIbUserId: parent,
      referralCode: 'MGMTCHLD',
    });
    return [parent, child];
  }

  /** A root partner with no parent and nobody beneath them. */
  async function makeRoot(email: string, referralCode: string): Promise<number> {
    const userId = await makeClient(email);
    await store.createAccount({ userId, level: 1, referralCode });
    return userId;
  }

  /*
   * ── TWO LEVELS AT MOST, ON REASSIGNMENT TOO (0197) ───────────────────────
   *
   * Reassigning is the other door into the tree, so it holds the same rule an
   * approval does: the new parent must be a main partner, a partner with
   * sub-partners of their own cannot become one, and the moved partner's level
   * follows their new position.
   */
  it('refuses to reassign a partner under a sub-partner', async () => {
    const [, child] = await makePair();
    const mover = await makeRoot('mgmt-mover@test.local', 'MGMTMOVE');

    await expect(service.reassignParent(mover, child, UNRESTRICTED, REVIEWER)).rejects.toThrow(
      /sub-partner cannot have partners beneath them/i,
    );
    const unchanged = await store.findAccount(mover);
    expect(unchanged?.parentIbUserId).toBeNull();
    expect(unchanged?.level).toBe(1);
  });

  it('refuses to reassign a partner who has sub-partners of their own', async () => {
    const [parent, child] = await makePair();
    const newParent = await makeRoot('mgmt-newparent@test.local', 'MGMTNEWP');

    await expect(service.reassignParent(parent, newParent, UNRESTRICTED, REVIEWER)).rejects.toThrow(
      /has sub-partners of their own/i,
    );
    // Nobody moved: the parent is still a root on level 1, the child still theirs.
    const stillRoot = await store.findAccount(parent);
    expect(stillRoot?.parentIbUserId).toBeNull();
    expect(stillRoot?.level).toBe(1);
    expect((await store.findAccount(child))?.parentIbUserId).toBe(parent);
  });

  it('re-levels a partner moved under a main partner to level 2', async () => {
    const mover = await makeRoot('mgmt-relevel-down@test.local', 'MGMTRLDN');
    const newParent = await makeRoot('mgmt-relevel-parent@test.local', 'MGMTRLPR');

    const moved = await service.reassignParent(mover, newParent, UNRESTRICTED, REVIEWER);

    expect(moved.parentIbUserId).toBe(newParent);
    expect(moved.level).toBe(2);
    expect((await store.findAccount(mover))?.level).toBe(2);
  });

  it('re-levels a partner cut loose to level 1 and clears their own terms', async () => {
    const [, child] = await makePair();
    await service.setTerms(
      child,
      { commissionShare: '25', rebateShare: '7.5' },
      UNRESTRICTED,
      REVIEWER,
    );

    const freed = await service.reassignParent(child, null, UNRESTRICTED, REVIEWER);

    expect(freed.parentIbUserId).toBeNull();
    expect(freed.level).toBe(1);
    // An override only means something on a sub-partner; a main partner has none.
    expect(freed.commissionShareOverride).toBeNull();
    expect(freed.rebateShareOverride).toBeNull();
    const stored = await store.findAccount(child);
    expect(stored?.commissionShareOverride).toBeNull();
    expect(stored?.rebateShareOverride).toBeNull();
  });

  /*
   * Moving a sub-partner sideways — from one main partner to another — keeps
   * them a sub-partner, and keeps the terms set for them.
   */
  it('keeps a sub-partner’s level and terms when moved to another main partner', async () => {
    const [, child] = await makePair();
    await service.setTerms(child, { commissionShare: '25' }, UNRESTRICTED, REVIEWER);
    const other = await makeRoot('mgmt-sideways@test.local', 'MGMTSIDE');

    const moved = await service.reassignParent(child, other, UNRESTRICTED, REVIEWER);

    expect(moved.parentIbUserId).toBe(other);
    expect(moved.level).toBe(2);
    expect(Number(moved.commissionShareOverride)).toBe(25);
  });

  /*
   * `changeLevel` and its two tests went in 0102 with the rung they moved a
   * partner between. What they claimed to control — "a disabled level takes no
   * share, so this would stop their earnings silently" — had not been true since
   * 0084, when the rate moved to the programme.
   *
   * The two questions it conflated are covered where they now live: terms by
   * `changeProgram` (see 'moving a partner onto different terms' above), and
   * position in the tree by `changeParent` below.
   */

  it('refuses a parent that would close a loop', async () => {
    const [parent, child] = await makePair();

    // Making the child the parent's parent completes A→B→A. Postgres would
    // accept it; this is the only guard.
    await expect(service.reassignParent(parent, child, UNRESTRICTED, REVIEWER)).rejects.toThrow(
      /loop/i,
    );
  });

  it('refuses a partner as their own parent', async () => {
    const [parent] = await makePair();
    await expect(service.reassignParent(parent, parent, UNRESTRICTED, REVIEWER)).rejects.toThrow(
      /under themselves/i,
    );
  });

  /*
   * "Introduced by" follows the position (owner, 7 Oct 2026): it is the new
   * parent after a move, and nobody once cut loose.
   */
  it('points "introduced by" at the new parent when moved sideways', async () => {
    const [parent, child] = await makePair();
    await ctx.db.execute(
      sql`UPDATE users SET referred_by_ib_user_id = ${parent} WHERE id = ${child}`,
    );
    const other = await makeRoot('mgmt-ref-follow@test.local', 'MGMTREFF');

    await service.reassignParent(child, other, UNRESTRICTED, REVIEWER);

    expect((await users.findById(child))?.referredByIbUserId).toBe(other);
  });

  it('removes "introduced by" when a partner is cut loose', async () => {
    const [parent, child] = await makePair();
    await ctx.db.execute(
      sql`UPDATE users SET referred_by_ib_user_id = ${parent} WHERE id = ${child}`,
    );

    await service.reassignParent(child, null, UNRESTRICTED, REVIEWER);

    expect((await users.findById(child))?.referredByIbUserId).toBeUndefined();
  });

  it('leaves "introduced by" alone when the move is refused', async () => {
    const [parent, child] = await makePair();
    const mover = await makeRoot('mgmt-ref-keep@test.local', 'MGMTREFK');
    await ctx.db.execute(
      sql`UPDATE users SET referred_by_ib_user_id = ${parent} WHERE id = ${mover}`,
    );

    await expect(service.reassignParent(mover, child, UNRESTRICTED, REVIEWER)).rejects.toThrow();

    expect((await users.findById(mover))?.referredByIbUserId).toBe(parent);
  });

  it('accepts an unrelated parent', async () => {
    const [, child] = await makePair();
    const outsider = await makeClient('mgmt-outsider@test.local');
    await store.createAccount({
      userId: outsider,
      level: 1,
      referralCode: 'MGMTOUTS',
    });

    const moved = await service.reassignParent(child, outsider, UNRESTRICTED, REVIEWER);
    expect(moved.parentIbUserId).toBe(outsider);
  });

  it('cuts a partner loose to deal direct', async () => {
    const [, child] = await makePair();
    const freed = await service.reassignParent(child, null, UNRESTRICTED, REVIEWER);
    // null is a real value, not an omission — it means top of a chain.
    expect(freed.parentIbUserId).toBeNull();
  });

  it('refuses a NEW PARENT outside the actor’s territory — a 404, not a state oracle (#5)', async () => {
    /*
     * The child is in the actor's territory; the proposed new parent is NOT.
     * Reassigning must fail as "not found" — the same answer as a parent that
     * does not exist — before `assertParentHasRoom` can leak whether that
     * out-of-scope partner exists, is suspended, or is full. Without the scope
     * check on the parent, a scoped admin could both graft their partner under
     * an out-of-territory one and probe its state.
     */
    const [, child] = await makePair();
    const outsider = await makeClient('mgmt-out-of-scope@test.local');
    await store.createAccount({
      userId: outsider,
      level: 1,
      referralCode: 'MGMTOOS1',
    });

    // A territory containing the CHILD but not the outsider parent.
    const { rows: tagRows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO client_tags (slug, label) VALUES ('ib-scope-mine', 'IB Scope Mine') RETURNING id
    `);
    const tagId = tagRows[0].id;
    await ctx.db.execute(sql`
      INSERT INTO client_tag_assignments (user_id, tag_id) VALUES (${child}, ${tagId})
    `);
    const scope = scopeOf([tagId], false);

    await expect(service.reassignParent(child, outsider, scope, REVIEWER)).rejects.toThrow(
      /not.*(found|exist)/i,
    );
    // Unchanged: the child still has its original parent.
    const stillChild = await store.findAccount(child);
    expect(stillChild?.parentIbUserId).not.toBe(outsider);

    // And an unrestricted actor CAN make the same move, proving the refusal was
    // about territory, not the parent being invalid.
    const moved = await service.reassignParent(child, outsider, UNRESTRICTED, REVIEWER);
    expect(moved.parentIbUserId).toBe(outsider);
  });

  it('approves their OWN client under an introducer outside the territory — and hides who (R1)', async () => {
    /*
     * The introducer is INHERITED, not chosen: the reviewer holds the applicant
     * and the platform places a partner under whoever recruited them. Scoping
     * the inherited parent made a desk unable to approve its own client
     * whenever the recruiter sat in another territory. A CHOSEN outside parent
     * is still refused (#5, above).
     */
    const introducer = await makeClient('inherit-outside-top@test.local');
    const middle = (
      await service.approve(
        (await service.apply(introducer, { agencyId: AGENCY.id })).id,
        REVIEWER,
        UNRESTRICTED,
      )
    ).userId;
    const client = await makeClient('inherit-outside-client@test.local');
    await ctx.db.execute(
      sql`UPDATE users SET referred_by_ib_user_id = ${middle} WHERE id = ${client}`,
    );
    const { rows: tagRows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO client_tags (slug, label) VALUES ('ib-inherit-mine', 'Mine') RETURNING id`);
    await ctx.db.execute(sql`
      INSERT INTO client_tag_assignments (user_id, tag_id) VALUES (${client}, ${tagRows[0].id})`);
    const scope = scopeOf([tagRows[0].id], false);

    const application = await service.apply(client, {});
    const account = await service.approve(application.id, REVIEWER, scope);
    expect(account.parentIbUserId).toBe(middle); // placed under the recruiter

    const view = await service.accountViewFor(account, scope);
    expect(view.parentIbUserId).toBeNull();
    expect(view.parentOutsideTerritory).toBe(true);
    expect(JSON.stringify(view)).not.toContain(middle);
    // The same account, seen by an unrestricted reader, names the parent.
    expect((await service.accountViewFor(account, UNRESTRICTED)).parentIbUserId).toBe(middle);
  });

  /*
   * The reassignment half of the `maxDirectPartners` pair, gone with 0055 for
   * the same reason. The check it exercised — that a reassignment goes through
   * the same guard an approval does — is still worth holding, so it is asserted
   * on the rule that survived.
   */
  it('refuses a reassignment onto a SUSPENDED parent, as an approval would', async () => {
    const [parent] = await makePair();
    await ctx.db.execute(sql`UPDATE ib_accounts SET active = false WHERE user_id = ${parent}`);

    const another = await makeClient('mgmt-another@test.local');
    await store.createAccount({
      userId: another,
      level: 1,
      referralCode: 'MGMTANOT',
    });

    await expect(service.reassignParent(another, parent, UNRESTRICTED, REVIEWER)).rejects.toThrow(
      /suspended/i,
    );
  });

  it('suspends without deleting the tree', async () => {
    const [parent, child] = await makePair();

    const suspended = await service.setActive(parent, false, UNRESTRICTED, REVIEWER);
    expect(suspended.active).toBe(false);
    // The code and the tree survive: clients attributed to them stay
    // attributed, and everybody beneath keeps their placement.
    expect(suspended.referralCode).toBe('MGMTPRNT');
    expect((await store.findAccount(child))?.parentIbUserId).toBe(parent);
  });

  it('reactivates', async () => {
    const [parent] = await makePair();
    await service.setActive(parent, false, UNRESTRICTED, REVIEWER);
    const back = await service.setActive(parent, true, UNRESTRICTED, REVIEWER);
    expect(back.active).toBe(true);
  });

  it('refuses a suspended partner as a new parent', async () => {
    const [parent] = await makePair();
    await service.setActive(parent, false, UNRESTRICTED, REVIEWER);

    const orphan = await makeClient('mgmt-orphan@test.local');
    await store.createAccount({
      userId: orphan,
      level: 1,
      referralCode: 'MGMTORPH',
    });

    await expect(service.reassignParent(orphan, parent, UNRESTRICTED, REVIEWER)).rejects.toThrow(
      /suspended/i,
    );
  });

  it('lists partners with their person and rung', async () => {
    await makePair();
    const page = await service.listPartners({}, UNRESTRICTED);

    expect(page.total).toBe(2);
    // A uuid is not a partner — the list has to carry who they are.
    expect(page.rows[0].user.email).toBeTruthy();
    // And which RUNG they stand on, which is what decides their pay (0112).
    expect(page.rows[0].account.level).toBeGreaterThanOrEqual(1);
  });
});

/*
 * ── THE AGENCY'S DEFAULT TERMS ARE GONE (0112) ─────────────────────────────
 *
 * A whole suite lived here proving an agency's default commission programme was
 * applied at approval, overridden by an explicit choice, fallen through when
 * disabled, and cleared when the programme was deleted.
 *
 * An agency has no opinion about pay any more. It still bounds what a partner
 * may SELL through its products — covered where that behaviour lives — and a
 * partner's terms come from their rung.
 */

/*
 * ── A PARTNER SITS UNDER WHOEVER RECRUITED THEM ─────────────────────────────
 *
 * `approve()` read `options.parentIbUserId ?? null`, so a tree position existed
 * only when a reviewer passed one — and the console never did. Every approved
 * partner landed at the ROOT, whoever had introduced them.
 *
 * That was not cosmetic. FR-IB-17's distribution needs a CHAIN, and through the
 * ordinary flow no chain was ever built: a partner who recruited another earned
 * nothing on their downline, because they were not above it. It was also
 * inconsistent with the AGENCY, which has always been inherited from the same
 * `referred_by_ib_user_id` relationship.
 *
 * Found by walking the real API end to end — `scripts/partner-flow-walkthrough.mjs`.
 * No suite here could have caught it: every one of them builds its tree with an
 * INSERT, so they assert the engine pays a chain correctly while never asking
 * whether a chain is ever created.
 */
/**
 * The CONSTRAINT that refused a statement, not the message that reported it.
 *
 * Drizzle wraps driver errors, so `error.message` is "Failed query: UPDATE …"
 * and the constraint name lives on the cause. Matching the message would pass
 * for any failure at all — a typo'd column included — which is exactly the kind
 * of test that reports green while proving nothing. Twin of the helper in
 * test/ib-schema-constraints.spec.ts.
 */
async function constraintViolatedBy(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    const cause: unknown = (error as { cause?: unknown }).cause ?? error;
    const name = (cause as { constraint?: string }).constraint;
    if (name) return name;
    throw new Error(`Statement failed, but not on a constraint: ${(cause as Error).message}`);
  }
  throw new Error('Expected the statement to be refused, but it succeeded.');
}

describe('who a new partner sits under', () => {
  /** An approved partner, and a client who registered through their link. */
  async function recruitedBy(
    parentEmail: string,
    childEmail: string,
  ): Promise<{ parent: number; child: number }> {
    const parent = await makeClient(parentEmail);
    const parentApp = await service.apply(parent, { agencyId: AGENCY.id });
    await service.approve(parentApp.id, REVIEWER, UNRESTRICTED, {});

    const child = await makeClient(childEmail);
    await ctx.db.execute(
      sql`UPDATE users SET referred_by_ib_user_id = ${parent} WHERE id = ${child}`,
    );
    return { parent, child };
  }

  it('inherits the introducer as the parent when the reviewer names none', async () => {
    const { parent, child } = await recruitedBy('rec-parent@test.local', 'rec-child@test.local');

    const application = await service.apply(child, {});
    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED, {});

    expect(account.parentIbUserId).toBe(parent);
  });

  it('lets the reviewer override the introducer', async () => {
    const { child } = await recruitedBy('ovr-parent@test.local', 'ovr-child@test.local');
    const elsewhere = await makeClient('ovr-elsewhere@test.local');
    const elsewhereApp = await service.apply(elsewhere, { agencyId: AGENCY.id });
    await service.approve(elsewhereApp.id, REVIEWER, UNRESTRICTED, {});

    const application = await service.apply(child, {});
    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED, {
      parentIbUserId: elsewhere,
    });

    expect(account.parentIbUserId).toBe(elsewhere);
  });

  /*
   * An explicit `null` is a different instruction from omitting the field, and
   * `??` could not tell them apart — it would have made deliberately rooting a
   * recruited partner impossible.
   */
  it('honours an explicit null as "put them at the root"', async () => {
    const { child } = await recruitedBy('root-parent@test.local', 'root-child@test.local');

    const application = await service.apply(child, {});
    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED, {
      parentIbUserId: null,
    });

    expect(account.parentIbUserId).toBeNull();
  });

  it('leaves a partner nobody recruited at the root', async () => {
    const solo = await makeClient('solo-partner@test.local');

    const application = await service.apply(solo, { agencyId: AGENCY.id });
    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED, {});

    expect(account.parentIbUserId).toBeNull();
  });

  /*
   * A NON-PARTNER CANNOT BE AN INTRODUCER — the database says so, not the
   * service.
   *
   * `users_referred_by_ib_accounts_user_id_fk` points at `ib_accounts.user_id`,
   * not at `users.id`, so attributing a client to somebody who holds no partner
   * account is refused at the INSERT. `inheritedParentIbUserIdFor` still checks
   * — a pure function should not assume a constraint it cannot see — but the
   * branch is unreachable through any real write.
   *
   * Worth pinning as the guarantee rather than as a service behaviour: if that
   * FK is ever pointed at `users.id`, this fails and says exactly what changed.
   */
  it('cannot attribute a client to somebody who is not a partner', async () => {
    const notAPartner = await makeClient('nonpartner-introducer@test.local');
    const child = await makeClient('nonpartner-child@test.local');

    const refusedBy = await constraintViolatedBy(
      ctx.db.execute(
        sql`UPDATE users SET referred_by_ib_user_id = ${notAPartner} WHERE id = ${child}`,
      ),
    );

    expect(refusedBy).toBe('users_referred_by_ib_accounts_user_id_fk');
  });
});

describe('making an individual a partner from the console (7 Oct 2026)', () => {
  async function makeMain(email: string, code: string): Promise<number> {
    const userId = await makeClient(email);
    await store.createAccount({ userId, level: 1, referralCode: code, agencyId: AGENCY.id });
    return userId;
  }

  it('appoints a client as a main partner under the agency, with no introducer', async () => {
    const introducer = await makeMain('appoint-intro@test.local', 'APPINTRO');
    const client = await makeClient('appoint-top@test.local');
    await ctx.db.execute(
      sql`UPDATE users SET referred_by_ib_user_id = ${introducer} WHERE id = ${client}`,
    );

    const account = await service.appointPartner(
      client,
      { agencyId: AGENCY.id },
      UNRESTRICTED,
      REVIEWER,
    );

    expect(account.level).toBe(1);
    expect(account.parentIbUserId).toBeNull();
    expect(account.agencyId).toBe(AGENCY.id);
    expect(account.referralCode).toMatch(/\S+/);
    expect((await users.findById(client))?.referredByIbUserId).toBeUndefined();
    // It is an approval: the application it went through is on record as approved.
    expect((await store.findLatestByUser(client))?.status).toBe('approved');
  });

  it('appoints a client as a sub-partner under a main partner', async () => {
    const main = await makeMain('appoint-main@test.local', 'APPMAIN1');
    const client = await makeClient('appoint-sub@test.local');

    const account = await service.appointPartner(
      client,
      { agencyId: AGENCY.id, parentIbUserId: main },
      UNRESTRICTED,
      REVIEWER,
    );

    expect(account.level).toBe(2);
    expect(account.parentIbUserId).toBe(main);
    expect((await users.findById(client))?.referredByIbUserId).toBe(main);
  });

  it('approves the application the client already sent rather than opening another', async () => {
    const client = await makeClient('appoint-pending@test.local');
    const pending = await store.createApplication({ userId: client, agencyId: AGENCY.id });

    await service.appointPartner(client, { agencyId: AGENCY.id }, UNRESTRICTED, REVIEWER);

    expect((await store.findById(pending.id))?.status).toBe('approved');
    const { rows } = await ctx.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ib_applications WHERE user_id = ${client}`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('refuses a client who is already a partner', async () => {
    const main = await makeMain('appoint-twice@test.local', 'APPTWICE');
    await expect(
      service.appointPartner(main, { agencyId: AGENCY.id }, UNRESTRICTED, REVIEWER),
    ).rejects.toThrow(/already a partner/i);
  });

  it('leaves no stray application in the queue when the approval is refused', async () => {
    const main = await makeMain('appoint-chain-main@test.local', 'APPCHM01');
    const sub = await makeClient('appoint-chain-sub@test.local');
    await store.createAccount({
      userId: sub,
      level: 2,
      parentIbUserId: main,
      referralCode: 'APPCHS01',
    });
    const client = await makeClient('appoint-refused@test.local');

    await expect(
      service.appointPartner(
        client,
        { agencyId: AGENCY.id, parentIbUserId: sub },
        UNRESTRICTED,
        REVIEWER,
      ),
    ).rejects.toThrow(/sub-partner/i);

    expect(await store.findAccount(client)).toBeUndefined();
    expect(await store.findLatestByUser(client)).toBeUndefined();
  });

  it('refuses an agency that does not exist', async () => {
    const client = await makeClient('appoint-noagency@test.local');
    await expect(
      service.appointPartner(
        client,
        { agencyId: '00000000-0000-4000-8000-0000000000aa' },
        UNRESTRICTED,
        REVIEWER,
      ),
    ).rejects.toThrow(/agency does not exist/i);
    expect(await store.findLatestByUser(client)).toBeUndefined();
  });

  it('refuses a client outside the actor’s territory as not found', async () => {
    const client = await makeClient('appoint-scope@test.local');
    const scoped: Actor = { ...REVIEWER, clientScope: scopeOf([], false) } as Actor;
    await expect(
      service.appointPartner(client, { agencyId: AGENCY.id }, scopeOf([], false), scoped),
    ).rejects.toThrow(/not found|does not exist/i);
    expect(await store.findAccount(client)).toBeUndefined();
  });
});
