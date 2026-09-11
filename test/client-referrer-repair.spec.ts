import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, ibAccounts, roles, users } from '../src/database/schema';

/**
 * RECORDING A MISSING REFERRING PARTNER — NULL → A ONLY.
 *
 * Attribution is captured in exactly one place, `?ref=` on the registration
 * screen, and both portal auth cross-links dropped it. A client followed a
 * partner's link, saw the referral banner, clicked "Sign in", found they had no
 * account, clicked "Create an account", and registered attributed to NOBODY —
 * permanently, because `referred_by_ib_user_id` was written at registration and
 * nowhere else.
 *
 * ## The refusal that matters is the 409
 *
 * `docs/` forbids a "change my IB" flow and is right: re-pointing attribution
 * moves a partner's client and their future commissions to somebody else.
 * Filling an EMPTY attribution takes nothing from anybody. The distinction is
 * the whole design, so it is enforced in the SERVICE rather than by a screen
 * that only renders the control when `referrer` is absent — a rendering
 * condition is something somebody relaxes without knowing what they have built.
 *
 * ## Three refusals, three codes
 *
 * They need three sentences and one status makes the screen guess. The third is
 * what earns the split: "the code was RIGHT and that partner is suspended" tells
 * an operator the client was telling the truth, which is a different
 * conversation from "check the spelling".
 */

const ADMIN = { email: 'ref-repair-admin@oxshare.com', password: 'admin-password-123' };
const EDITOR = { email: 'ref-repair-editor@oxshare.com', password: 'admin-password-123' };

const ROUTE = (id: string) => `/v1/admin/clients/${id}/referrer`;

let ctx: HttpTestContext;
let orphanId: string;
let attributedId: string;
let partnerId: string;
let suspendedPartnerId: string;
let selfPartnerId: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();

  const [full] = await db
    .insert(roles)
    .values({ name: 'Ref Repair Full', permissions: ALL_PERMISSIONS })
    .returning();
  await db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'Ref Repair Full',
    role: 'sub_admin',
    roleId: full.id,
    permissions: [],
    status: 'active',
  });

  /*
   * An admin who may EDIT a client but not record a referrer. Without this, the
   * 403 case could be produced by an admin holding nothing, which would say
   * nothing about the split being asserted: fixing a surname and deciding who
   * gets paid are different powers.
   */
  const [editor] = await db
    .insert(roles)
    .values({ name: 'Ref Repair Editor', permissions: ['clients.view', 'clients.edit'] })
    .returning();
  await db.insert(admins).values({
    email: EDITOR.email,
    passwordHash: await passwords.hash(EDITOR.password),
    name: 'Ref Repair Editor',
    role: 'sub_admin',
    roleId: editor.id,
    permissions: [],
    status: 'active',
  });

  const mkUser = async (local: string) => {
    const [row] = await db
      .insert(users)
      .values({
        email: `ref-repair-${local}@oxshare-e2e.test`,
        passwordHash: 'x',
        firstName: 'Ref',
        lastName: local,
        emailVerified: true,
      })
      .returning();
    return row.id;
  };

  partnerId = await mkUser('partner');
  suspendedPartnerId = await mkUser('suspended');
  selfPartnerId = await mkUser('self');
  orphanId = await mkUser('orphan');
  attributedId = await mkUser('attributed');

  await db.insert(ibAccounts).values([
    { userId: partnerId, level: 1, active: true, referralCode: 'REPAIROK1' },
    { userId: suspendedPartnerId, level: 1, active: false, referralCode: 'REPAIROFF' },
    { userId: selfPartnerId, level: 1, active: true, referralCode: 'REPAIRSELF' },
  ]);

  // Already attributed, so the 409 has a subject.
  await db.update(users).set({ referredByIbUserId: partnerId }).where(eq(users.id, attributedId));
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** The orphan starts unattributed before every case. */
beforeEach(async () => {
  await ctx.db.db.update(users).set({ referredByIbUserId: null }).where(eq(users.id, orphanId));
});

const referrerOf = async (id: string) => {
  const [row] = await ctx.db.db
    .select({ ref: users.referredByIbUserId })
    .from(users)
    .where(eq(users.id, id));
  return row?.ref ?? null;
};

describe('recording a referrer where none was recorded', () => {
  it('accepts the code the client reports, case-insensitively, and records it', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    // Lower case and padded: exactly what somebody types off a support ticket,
    // and what registration itself accepts.
    const res = await session.patch(ROUTE(orphanId)).send({ referralCode: '  repairok1 ' });

    expect(res.status, `recording a referrer answered ${res.status}`).toBe(200);
    expect(
      await referrerOf(orphanId),
      'the call answered 200 and the attribution did not land',
    ).toBe(partnerId);
  });
});

describe('the refusals, which are the design', () => {
  it('REFUSES a client who already has a referrer — 409, and changes nothing', async () => {
    /*
     * THE A→B REFUSAL. This is the one that keeps the route from being the
     * change-my-IB flow `docs/` forbids, and it is asserted here rather than
     * trusted to a screen that hides the control.
     */
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.patch(ROUTE(attributedId)).send({ referralCode: 'REPAIRSELF' });

    expect(
      res.status,
      `re-pointing an existing attribution answered ${res.status}. A 200 here moves a ` +
        "partner's client, and their future commissions, to somebody else.",
    ).toBe(409);
    expect((res.body as { code?: string }).code).toBe('REFERRER_ALREADY_SET');
    expect(await referrerOf(attributedId), 'the refused call re-pointed it anyway').toBe(partnerId);
  });

  it('names an UNKNOWN code distinctly — a typo the operator can fix', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.patch(ROUTE(orphanId)).send({ referralCode: 'NOSUCHCODE' });

    expect(res.status).toBe(400);
    expect((res.body as { code?: string }).code).toBe('REFERRAL_CODE_UNKNOWN');
    expect(await referrerOf(orphanId)).toBeNull();
  });

  it('names a SELF-referral distinctly — the chain would walk a self-edge', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.patch(ROUTE(selfPartnerId)).send({ referralCode: 'REPAIRSELF' });

    expect(res.status).toBe(400);
    expect((res.body as { code?: string }).code).toBe('REFERRAL_SELF');
    expect(await referrerOf(selfPartnerId)).toBeNull();
  });

  it('names a SUSPENDED partner distinctly — the code was right', async () => {
    /*
     * The refusal that earns the three-code split. Folded into
     * REFERRAL_CODE_UNKNOWN an operator would go and check the spelling of a
     * code that is perfectly correct, and never learn that somebody suspended
     * the partner.
     */
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.patch(ROUTE(orphanId)).send({ referralCode: 'REPAIROFF' });

    expect(res.status).toBe(400);
    expect(
      (res.body as { code?: string }).code,
      'a suspended partner is indistinguishable from a bad code, so the operator is sent ' +
        'to check a spelling that is already correct',
    ).toBe('REFERRAL_PARTNER_INACTIVE');
    expect(await referrerOf(orphanId)).toBeNull();
  });

  it('refuses an admin with clients.edit but not the new key', async () => {
    const session = await actingAs(ctx, 'admin', EDITOR);
    const res = await session.patch(ROUTE(orphanId)).send({ referralCode: 'REPAIROK1' });

    expect(
      res.status,
      `an admin holding clients.edit answered ${res.status}; deciding who gets paid is not ` +
        'the same power as fixing a surname, and 401 would prove nothing about either',
    ).toBe(403);
    expect(await referrerOf(orphanId)).toBeNull();
  });
});
