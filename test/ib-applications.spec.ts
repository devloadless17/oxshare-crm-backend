import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { IbApplicationsService } from '../src/modules/ib/ib-applications.service';
import { IbLevelsService } from '../src/modules/ib/ib-levels.service';
import { IbStore } from '../src/store/ib.store';
import { UsersStore } from '../src/store/users.store';
import { ClientVisibilityService } from '../src/common/security/client-visibility.service';
import type { EmailService } from '../src/modules/email/email.service';
import { UNRESTRICTED } from '../src/common/security/client-scope';
import type { Actor } from '../src/common/security/actor';
import { auditStubAs } from './audit-stub';
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
    auditStubAs(),
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
  permissions: ['*'],
};

/** Verified by default — the unverified case is a test of its own. */
async function makeClient(email: string, verificationLevel = 1): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Client', ${verificationLevel}, true)
    RETURNING id
  `);
  return rows[0].id;
}

beforeEach(async () => {
  sendPartnerDecisionEmail.mockClear();
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM ib_applications`);
  await ctx.db.execute(sql`DELETE FROM users`);
  await ctx.db.execute(sql`DELETE FROM ib_levels`);
  await ctx.db.execute(sql`
    INSERT INTO ib_levels (level, name, payout_model, rate_value, max_direct_partners, enabled)
    VALUES (1, 'Master Partner', 'revenue_share', 70.0000, NULL, true),
           (2, 'Sub Partner', 'revenue_share', 30.0000, NULL, true)
  `);
});

describe('applying', () => {
  it('accepts an application from a verified client', async () => {
    const userId = await makeClient('applicant@test.local');

    const application = await service.apply(userId, { motivation: 'I have an audience.' });

    expect(application.status).toBe('pending');
    expect(application.motivation).toBe('I have an audience.');
  });

  it('refuses an unverified client, and says what to do about it', async () => {
    const userId = await makeClient('unverified@test.local', 0);

    await expect(service.apply(userId, {})).rejects.toThrow(/identity must be verified/i);
  });

  it('refuses a second application while one is pending', async () => {
    const userId = await makeClient('double@test.local');
    await service.apply(userId, {});

    await expect(service.apply(userId, {})).rejects.toThrow(/already have an application/i);
  });

  it('allows re-applying after a rejection', async () => {
    const userId = await makeClient('rejected-then@test.local');
    const first = await service.apply(userId, {});
    await service.reject(first.id, REVIEWER, UNRESTRICTED, { reason: 'Application is unclear' });

    const second = await service.apply(userId, {});
    expect(second.status).toBe('pending');
    expect(second.id).not.toBe(first.id);
  });

  it('refuses somebody who is already a partner', async () => {
    const userId = await makeClient('already@test.local');
    const application = await service.apply(userId, {});
    await service.approve(application.id, REVIEWER, UNRESTRICTED);

    await expect(service.apply(userId, {})).rejects.toThrow(/already a partner/i);
  });
});

describe('status', () => {
  it('distinguishes "never applied" from "rejected, here is why"', async () => {
    const fresh = await makeClient('fresh@test.local');
    const turned = await makeClient('turned-down@test.local');

    const before = await service.statusFor(fresh);
    expect(before.application).toBeNull();
    expect(before.account).toBeNull();

    const application = await service.apply(turned, {});
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
  });
});

describe('approval', () => {
  it('places a partner with no parent at the shallowest enabled level', async () => {
    const userId = await makeClient('direct@test.local');
    const application = await service.apply(userId, {});

    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED);

    expect(account.level).toBe(1);
    expect(account.parentIbUserId).toBeNull();
    expect(account.referralCode).toHaveLength(8);
  });

  it('places a partner with a parent one level below them', async () => {
    const parentId = await makeClient('the-parent@test.local');
    const parentApp = await service.apply(parentId, {});
    await service.approve(parentApp.id, REVIEWER, UNRESTRICTED);

    const childId = await makeClient('the-child@test.local');
    const childApp = await service.apply(childId, {});
    const child = await service.approve(childApp.id, REVIEWER, UNRESTRICTED, {
      parentIbUserId: parentId,
    });

    expect(child.level).toBe(2);
    expect(child.parentIbUserId).toBe(parentId);
  });

  it('refuses to place anybody below the deepest enabled level', async () => {
    // A one-level ladder: a partner beneath an L1 would never be paid, because
    // no level exists to pay them.
    await ctx.db.execute(sql`UPDATE ib_levels SET enabled = false WHERE level = 2`);

    const parentId = await makeClient('deep-parent@test.local');
    const parentApp = await service.apply(parentId, {});
    await service.approve(parentApp.id, REVIEWER, UNRESTRICTED);

    const childId = await makeClient('too-deep@test.local');
    const childApp = await service.apply(childId, {});

    await expect(
      service.approve(childApp.id, REVIEWER, UNRESTRICTED, { parentIbUserId: parentId }),
    ).rejects.toThrow(/deepest enabled level/i);
  });

  it('enforces maxDirectPartners on the parent’s level', async () => {
    await ctx.db.execute(sql`UPDATE ib_levels SET max_direct_partners = 1 WHERE level = 1`);

    const parentId = await makeClient('full-parent@test.local');
    const parentApp = await service.apply(parentId, {});
    await service.approve(parentApp.id, REVIEWER, UNRESTRICTED);

    const firstChild = await makeClient('child-one@test.local');
    const firstApp = await service.apply(firstChild, {});
    await service.approve(firstApp.id, REVIEWER, UNRESTRICTED, { parentIbUserId: parentId });

    const secondChild = await makeClient('child-two@test.local');
    const secondApp = await service.apply(secondChild, {});

    await expect(
      service.approve(secondApp.id, REVIEWER, UNRESTRICTED, { parentIbUserId: parentId }),
    ).rejects.toThrow(/already holds 1 of their 1/i);
  });

  it('refuses when a second reviewer already decided — the WHERE clause, not the pre-read', async () => {
    const userId = await makeClient('raced@test.local');
    const application = await service.apply(userId, {});

    await service.approve(application.id, REVIEWER, UNRESTRICTED);

    await expect(
      service.reject(application.id, REVIEWER, UNRESTRICTED, { reason: 'Too late' }),
    ).rejects.toThrow(/already|approved/i);
  });

  it('creates no account when the transition loses the race', async () => {
    const userId = await makeClient('atomic@test.local');
    const application = await service.apply(userId, {});

    // Somebody else rejects it first. The approve below must leave NOTHING
    // behind — an account without an approved application is a partner nobody
    // decided to create.
    await service.reject(application.id, REVIEWER, UNRESTRICTED, { reason: 'Not eligible' });

    await expect(service.approve(application.id, REVIEWER, UNRESTRICTED)).rejects.toThrow();

    const account = await store.findAccount(userId);
    expect(account).toBeUndefined();
  });

  it('refuses approval when no level is enabled', async () => {
    const userId = await makeClient('no-ladder@test.local');
    const application = await service.apply(userId, {});
    await ctx.db.execute(sql`UPDATE ib_levels SET enabled = false`);

    await expect(service.approve(application.id, REVIEWER, UNRESTRICTED)).rejects.toThrow(
      /no partner levels are enabled/i,
    );
  });

  it('issues referral codes from an unambiguous alphabet', async () => {
    const userId = await makeClient('code@test.local');
    const application = await service.apply(userId, {});
    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED);

    // No 0/O, no 1/I/L — these are dictated over the phone and typed by
    // somebody who is not the partner.
    expect(account.referralCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  });
});

describe('rejection', () => {
  it('refuses a rejection with no reason at all', async () => {
    const userId = await makeClient('no-reason@test.local');
    const application = await service.apply(userId, {});

    await expect(service.reject(application.id, REVIEWER, UNRESTRICTED, {})).rejects.toThrow(
      /needs a reason/i,
    );
  });

  it('accepts a bare note without a configured label', async () => {
    const userId = await makeClient('note-only@test.local');
    const application = await service.apply(userId, {});

    const rejected = await service.reject(application.id, REVIEWER, UNRESTRICTED, {
      note: 'Duplicate of an earlier application.',
    });
    expect(rejected.rejectionReason).toBe('Duplicate of an earlier application.');
  });

  it('records who decided and when', async () => {
    const userId = await makeClient('recorded@test.local');
    const application = await service.apply(userId, {});

    const rejected = await service.reject(application.id, REVIEWER, UNRESTRICTED, {
      reason: 'Application is incomplete or unclear',
    });
    expect(rejected.reviewedBy).toBe(REVIEWER.id);
    expect(rejected.reviewedAt).toBeInstanceOf(Date);
  });
});

describe('the cycle guard', () => {
  /** A → B → C, returned top-down. */
  async function makeChain(): Promise<[string, string, string]> {
    const a = await makeClient('chain-a@test.local');
    const b = await makeClient('chain-b@test.local');
    const c = await makeClient('chain-c@test.local');

    await store.createAccount({ userId: a, level: 1, referralCode: 'CHAINAAA' });
    await store.createAccount({
      userId: b,
      level: 2,
      parentIbUserId: a,
      referralCode: 'CHAINBBB',
    });
    await store.createAccount({
      userId: c,
      level: 2,
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
    await store.createAccount({ userId: outsider, level: 1, referralCode: 'OUTSIDER' });

    expect(await service.wouldCreateCycle(outsider, b)).toBe(false);
  });

  it('terminates on a chain that is ALREADY cyclic', async () => {
    const [a, , c] = await makeChain();
    // Postgres permits this — the schema spec asserts that gap. `ancestorsOf`
    // uses UNION rather than UNION ALL precisely so this query still returns.
    await ctx.db.execute(sql`UPDATE ib_accounts SET parent_ib_user_id = ${c} WHERE user_id = ${a}`);

    await expect(store.ancestorsOf(c)).resolves.toBeInstanceOf(Array);
  });
});

describe('the decision email', () => {
  it('sends the referral code on approval', async () => {
    const userId = await makeClient('approved-mail@test.local');
    const application = await service.apply(userId, {});

    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED);
    // Fire-and-forget, so it is not awaited by the caller. One turn is enough
    // for the promise chain the service kicked off.
    await vi.waitFor(() => expect(sendPartnerDecisionEmail).toHaveBeenCalledTimes(1));

    expect(sendPartnerDecisionEmail).toHaveBeenCalledWith(
      'approved-mail@test.local',
      'Test',
      'approved',
      { referralCode: account.referralCode },
    );
  });

  it('sends the COMPOSED reason on rejection, not its parts', async () => {
    const userId = await makeClient('rejected-mail@test.local');
    const application = await service.apply(userId, {});

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
    );
  });

  it('sends nothing when the decision was refused', async () => {
    const userId = await makeClient('no-mail@test.local');
    const application = await service.apply(userId, {});
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
  async function makePair(): Promise<[string, string]> {
    const parent = await makeClient('mgmt-parent@test.local');
    const child = await makeClient('mgmt-child@test.local');
    await store.createAccount({ userId: parent, level: 1, referralCode: 'MGMTPRNT' });
    await store.createAccount({
      userId: child,
      level: 2,
      parentIbUserId: parent,
      referralCode: 'MGMTCHLD',
    });
    return [parent, child];
  }

  it('moves a partner to another enabled level', async () => {
    const [parent] = await makePair();
    const moved = await service.changeLevel(parent, 2, UNRESTRICTED, REVIEWER);
    expect(moved.level).toBe(2);
  });

  it('refuses a DISABLED level', async () => {
    const [parent] = await makePair();
    await ctx.db.execute(sql`UPDATE ib_levels SET enabled = false WHERE level = 2`);

    // A disabled level takes no share, so this would stop their earnings
    // silently rather than demote them visibly.
    await expect(service.changeLevel(parent, 2, UNRESTRICTED, REVIEWER)).rejects.toThrow(
      /not an enabled/i,
    );
  });

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
      /loop/i,
    );
  });

  it('accepts an unrelated parent', async () => {
    const [, child] = await makePair();
    const outsider = await makeClient('mgmt-outsider@test.local');
    await store.createAccount({ userId: outsider, level: 1, referralCode: 'MGMTOUTS' });

    const moved = await service.reassignParent(child, outsider, UNRESTRICTED, REVIEWER);
    expect(moved.parentIbUserId).toBe(outsider);
  });

  it('cuts a partner loose to deal direct', async () => {
    const [, child] = await makePair();
    const freed = await service.reassignParent(child, null, UNRESTRICTED, REVIEWER);
    // null is a real value, not an omission — it means top of a chain.
    expect(freed.parentIbUserId).toBeNull();
  });

  it('enforces maxDirectPartners on reassignment, not only on approval', async () => {
    // The pair's child is what occupies the parent's single slot. It is never
    // named again — that occupancy is the whole subject of the assertion below.
    const [parent] = await makePair();
    await ctx.db.execute(sql`UPDATE ib_levels SET max_direct_partners = 1 WHERE level = 1`);

    const another = await makeClient('mgmt-another@test.local');
    await store.createAccount({ userId: another, level: 2, referralCode: 'MGMTANOT' });

    // `parent` already holds `child`. A reassignment fills a slot exactly as an
    // approval does, so it has to be checked in both places.
    await expect(service.reassignParent(another, parent, UNRESTRICTED, REVIEWER)).rejects.toThrow(
      /already holds 1 of their 1/i,
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
    await store.createAccount({ userId: orphan, level: 2, referralCode: 'MGMTORPH' });

    await expect(service.reassignParent(orphan, parent, UNRESTRICTED, REVIEWER)).rejects.toThrow(
      /suspended/i,
    );
  });

  it('lists partners with their person and level name', async () => {
    await makePair();
    const page = await service.listPartners({}, UNRESTRICTED);

    expect(page.total).toBe(2);
    // A uuid is not a partner — the list has to carry who they are.
    expect(page.rows[0].user.email).toBeTruthy();
    expect(page.rows[0].levelName).toBeTruthy();
  });
});
