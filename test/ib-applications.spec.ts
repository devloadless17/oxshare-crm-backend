import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { auditStubAs } from './audit-stub';
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
  await ctx.db.execute(sql`DELETE FROM ledger_entries`);
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`DELETE FROM users`);
  await ctx.db.execute(sql`DELETE FROM ib_levels`);
  await ctx.db.execute(sql`
    INSERT INTO ib_levels (level, name, rate_value, enabled)
    VALUES (1, 'Master Partner', 70.0000, true),
           (2, 'Sub Partner', 30.0000, true)
  `);

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
 */
async function defaultProgram(store: IbStore): Promise<string> {
  const id = await store.defaultProgramId();
  if (!id) throw new Error('No enabled commission programme — migration 0084 seeds one.');
  return id;
}

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
   * The ladder in these fixtures is two rungs deep, so a client introduced by a
   * level-2 partner has nowhere to stand. That used to be discovered at APPROVAL
   * — `resolveLevel` refused it — which meant the client filled the form in and
   * waited to be told a fact that was knowable when they opened the screen.
   */
  it('refuses a client whose introducer is already on the deepest level', async () => {
    const top = await makeClient('chain-top@test.local');
    const middle = await makeClient('chain-middle@test.local');

    const topAccount = await service.approve(
      (await service.apply(top, { agencyId: AGENCY.id })).id,
      REVIEWER,
      UNRESTRICTED,
    );
    const middleAccount = await service.approve(
      (await service.apply(middle, { agencyId: AGENCY.id })).id,
      REVIEWER,
      UNRESTRICTED,
      { parentIbUserId: topAccount.userId },
    );
    expect(middleAccount.level).toBe(2);

    const client = await makeClient('chain-bottom@test.local');
    await ctx.db.execute(
      sql`UPDATE users SET referred_by_ib_user_id = ${middleAccount.userId} WHERE id = ${client}`,
    );

    const status = await service.statusFor(client);
    expect(status.eligible).toBe(false);
    expect(status.ineligibleCode).toBe('chain_full');
    expect(status.ineligibleReason).toMatch(/deepest level/i);
  });

  /*
   * Hiding the form is not the control. The endpoint is reachable directly and a
   * stale tab still holds a form that was valid when it loaded — without this,
   * the application lands in the review queue as work that can only ever end in
   * a rejection.
   */
  it('refuses the application itself, not only the form', async () => {
    const top = await makeClient('enforced-top@test.local');
    const middle = await makeClient('enforced-middle@test.local');

    const topAccount = await service.approve(
      (await service.apply(top, { agencyId: AGENCY.id })).id,
      REVIEWER,
      UNRESTRICTED,
    );
    const middleAccount = await service.approve(
      (await service.apply(middle, { agencyId: AGENCY.id })).id,
      REVIEWER,
      UNRESTRICTED,
      { parentIbUserId: topAccount.userId },
    );

    const client = await makeClient('enforced-bottom@test.local');
    await ctx.db.execute(
      sql`UPDATE users SET referred_by_ib_user_id = ${middleAccount.userId} WHERE id = ${client}`,
    );

    await expect(service.apply(client, { agencyId: AGENCY.id })).rejects.toThrow(/deepest level/i);
  });

  /*
   * The bias that matters: a false positive HIDES the form from somebody
   * entitled to it. A client under a level-1 partner still has rung 2 free, and
   * an unattributed client is the case the ladder always has room for.
   */
  it('leaves a client under a level-1 partner eligible', async () => {
    const top = await makeClient('room-top@test.local');
    const topAccount = await service.approve(
      (await service.apply(top, { agencyId: AGENCY.id })).id,
      REVIEWER,
      UNRESTRICTED,
    );
    expect(topAccount.level).toBe(1);

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

  it('places a partner with no parent at the shallowest enabled level', async () => {
    const userId = await makeClient('direct@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });

    const account = await service.approve(application.id, REVIEWER, UNRESTRICTED);

    expect(account.level).toBe(1);
    expect(account.parentIbUserId).toBeNull();
    expect(account.referralCode).toHaveLength(8);
  });

  it('places a partner with a parent one level below them', async () => {
    const parentId = await makeClient('the-parent@test.local');
    const parentApp = await service.apply(parentId, { agencyId: AGENCY.id });
    await service.approve(parentApp.id, REVIEWER, UNRESTRICTED);

    const childId = await makeClient('the-child@test.local');
    const childApp = await service.apply(childId, { agencyId: AGENCY.id });
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
    const parentApp = await service.apply(parentId, { agencyId: AGENCY.id });
    await service.approve(parentApp.id, REVIEWER, UNRESTRICTED);

    const childId = await makeClient('too-deep@test.local');
    const childApp = await service.apply(childId, { agencyId: AGENCY.id });

    await expect(
      service.approve(childApp.id, REVIEWER, UNRESTRICTED, { parentIbUserId: parentId }),
    ).rejects.toThrow(/deepest enabled level/i);
  });

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

  it('refuses approval when no level is enabled', async () => {
    const userId = await makeClient('no-ladder@test.local');
    const application = await service.apply(userId, { agencyId: AGENCY.id });
    await ctx.db.execute(sql`UPDATE ib_levels SET enabled = false`);

    await expect(service.approve(application.id, REVIEWER, UNRESTRICTED)).rejects.toThrow(
      /no partner levels are enabled/i,
    );
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
  async function makeChain(): Promise<[string, string, string]> {
    const a = await makeClient('chain-a@test.local');
    const b = await makeClient('chain-b@test.local');
    const c = await makeClient('chain-c@test.local');

    await store.createAccount({
      userId: a,
      level: 1,
      programId: await defaultProgram(store),
      referralCode: 'CHAINAAA',
    });
    await store.createAccount({
      userId: b,
      level: 2,
      programId: await defaultProgram(store),
      parentIbUserId: a,
      referralCode: 'CHAINBBB',
    });
    await store.createAccount({
      userId: c,
      level: 2,
      programId: await defaultProgram(store),
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
      programId: await defaultProgram(store),
      referralCode: 'OUTSIDER',
    });

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
  async function makePair(): Promise<[string, string]> {
    const parent = await makeClient('mgmt-parent@test.local');
    const child = await makeClient('mgmt-child@test.local');
    await store.createAccount({
      userId: parent,
      level: 1,
      programId: await defaultProgram(store),
      referralCode: 'MGMTPRNT',
    });
    await store.createAccount({
      userId: child,
      level: 2,
      programId: await defaultProgram(store),
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
    await store.createAccount({
      userId: outsider,
      level: 1,
      programId: await defaultProgram(store),
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
      programId: await defaultProgram(store),
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
      level: 2,
      programId: await defaultProgram(store),
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
      level: 2,
      programId: await defaultProgram(store),
      referralCode: 'MGMTORPH',
    });

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
