import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actingAs,
  anonymous,
  completeAdminTotp,
  sessionFrom,
  startHttpTestApp,
  stopHttpTestApp,
  SURFACES,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  adminInvites,
  admins,
  auditLog,
  clientTags,
  roles,
} from '../src/database/schema';
import { and, eq } from 'drizzle-orm';

/**
 * The whole invite journey, over HTTP: invite with a role → accept → log in
 * holding exactly that role.
 *
 * `test/invite-lifecycle.spec.ts` covers the service thoroughly against fakes.
 * What it cannot show is the part an operator actually cares about: that the
 * person at the other end of the email can SIGN IN AFTERWARDS, with the
 * permissions they were promised and no others. That needs a real database and
 * the real login route, because the failure found here lives in the seam
 * between how the email is stored and how it is looked up.
 */

const MASTER = { email: 'journey-master@oxshare.com', password: 'admin-password-123' };

const NEW_ADMIN_PASSWORD = 'invitee-password-123';

let ctx: HttpTestContext;
let reviewerRoleId: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Journey Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();

  const [reviewerRole] = await ctx.db.db
    .insert(roles)
    .values({
      name: 'Journey Reviewer',
      description: 'KYC only.',
      permissions: ['kyc.review', 'clients.view'],
      isSystem: false,
    })
    .returning();
  reviewerRoleId = reviewerRole.id;

  await ctx.db.db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Journey Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** Invite someone and return the accept token from the dev-echoed link. */
async function invite(email: string, name: string, roleId?: string) {
  const master = await actingAs(ctx, 'admin', MASTER);
  const res = await master.post('/v1/admin/invite', { email, name, roleId });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const url = (res.body as { inviteUrl?: string }).inviteUrl;
  if (!url) throw new Error('no inviteUrl echoed — this spec relies on the non-production echo');
  return { token: new URL(url).searchParams.get('token')!, master };
}

function acceptInvite(token: string, password: string) {
  return anonymous(ctx)
    .post('/v1/admin/invite/accept')
    .set('Origin', SURFACES.admin.origin)
    .send({ token, password });
}

describe('invite → accept → sign in with the granted role', () => {
  it('carries the role through to what the new admin may do', async () => {
    const email = 'journey-reviewer@oxshare.com';
    const { token } = await invite(email, 'Journey Reviewer', reviewerRoleId);

    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);

    // The point of the whole flow: they can sign in on their own afterwards.
    const invitee = await actingAs(ctx, 'admin', { email, password: NEW_ADMIN_PASSWORD });
    const me = await invitee.get('/v1/admin/auth/me').expect(200);
    const profile = me.body as { role: string; permissions: string[]; status: string };

    expect(profile.role).toBe('sub_admin');
    expect(profile.status).toBe('active');
    // BOTH sides sorted. Sorting only the received array made this depend on
    // the order the API happens to return, which is not what the test is about
    // — and it duly broke when that order changed.
    expect(profile.permissions.sort()).toEqual(['clients.view', 'kyc.review'].sort());
  });

  it('grants ONLY the role — anything else is 403, not 401', async () => {
    const email = 'journey-scoped@oxshare.com';
    const { token } = await invite(email, 'Journey Scoped', reviewerRoleId);
    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);

    const invitee = await actingAs(ctx, 'admin', { email, password: NEW_ADMIN_PASSWORD });
    /*
     * `clients.view` is granted, so the CLIENT list is readable...
     *
     * This used to read the ADMIN directory and call it "users.view is
     * granted". That key no longer exists, and `/admin/users` is the
     * administrator directory gated on `admins.view` — which this role has
     * never held. So the 200 leg was asserting a route the invitee was always
     * going to be refused, and the test only started saying so when the
     * catalogue was tightened.
     */
    await invitee.get('/v1/admin/clients').expect(200);
    // ...but creating a role is not granted, and the refusal must be FORBIDDEN.
    // A 401 would send the admin app into a refresh-and-retry loop it can never
    // win.
    await invitee.post('/v1/admin/roles', { name: 'Nope', permissions: [] }).expect(403);
  });

  it('sends the invitee straight to authenticator setup — no session until a code checks', async () => {
    /*
     * Accept used to sign the invitee in on the spot. Since 0191 every admin
     * session needs a code from an authenticator app, the newcomer's first one
     * included, so accept answers with the enrolment challenge instead — and
     * that challenge alone carries them through setup to a session.
     */
    const email = 'journey-autologin@oxshare.com';
    const { token } = await invite(email, 'Journey Auto', reviewerRoleId);

    const res = await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);
    const setCookie = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    expect(setCookie.join(';')).not.toMatch(/admin_(at|rt)=/i);
    expect(res.body).toMatchObject({ step: 'totp_setup', challengeToken: expect.any(String) });

    const cookies = await completeAdminTotp(ctx, email, res.body as { challengeToken: string });
    const me = await sessionFrom(ctx, 'admin', cookies).get('/v1/admin/auth/me').expect(200);
    expect((me.body as { email: string }).email).toBe(email);
  });

  it('an invite email with CAPITALS still lets its owner log in', async () => {
    /*
     * The regression this file exists for.
     *
     * `AdminsStore.findByEmail` lowercases its ARGUMENT and compares it against a
     * plain case-sensitive varchar. The portal normalises on write
     * (auth.service.ts register: `dto.email.toLowerCase()`); the admin invite
     * path did not. So inviting "Sam@Oxshare.com" stored that verbatim, and every
     * later lookup searched for "sam@oxshare.com" and found nothing.
     *
     * The cruel part is the timing: accept auto-signs them in, so onboarding
     * looks like it worked. The failure surfaces the next morning, when they try
     * to log in with the password they just chose and are told it is wrong.
     */
    const email = 'Journey.Mixed@Oxshare.com';
    const { token } = await invite(email, 'Journey Mixed', reviewerRoleId);
    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);

    // As typed on the invite...
    const asInvited = await actingAs(ctx, 'admin', { email, password: NEW_ADMIN_PASSWORD });
    await asInvited.get('/v1/admin/auth/me').expect(200);

    // ...and as they will actually type it, which is rarely the same thing.
    const asTyped = await actingAs(ctx, 'admin', {
      email: email.toLowerCase(),
      password: NEW_ADMIN_PASSWORD,
    });
    await asTyped.get('/v1/admin/auth/me').expect(200);
  });
});

describe('two accepts racing one token', () => {
  it('exactly one wins; the loser gets a clean refusal, never a 500', async () => {
    /*
     * Both used to pass the accepted-flag read and collide on the
     * admins.email unique constraint — the loser's onboarding ended in a
     * 500. The claim is conditional now (UPDATE ... WHERE accepted = false),
     * so the race has a defined winner and an honest message for the loser.
     */
    const { token } = await invite('journey-raced@oxshare.com', 'Journey Raced');
    const [a, b] = await Promise.all([
      acceptInvite(token, NEW_ADMIN_PASSWORD),
      acceptInvite(token, NEW_ADMIN_PASSWORD),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses[0]).toBe(200);
    expect(statuses[1], 'the losing accept must fail CLEANLY').toBe(400);
    const loser = a.status === 200 ? b : a;
    expect((loser.body as { message: string }).message).toMatch(/already been used/i);
  });
});

describe('accepting an invite on a browser that already holds a session', () => {
  it("ENDS the signed-in admin's session — it cannot be resumed from another tab", async () => {
    /*
     * /invite/accept deliberately works WITH a session: the invitee may be
     * signed in as somebody else on a shared machine. Accepting overwrites the
     * cookies with the new admin's — but until this change the DISPLACED
     * admin's refresh family stayed live, so a pre-accept tab (or a snapshot
     * of the old cookies) resumed a session its owner believed was gone.
     */
    const { token, master } = await invite('journey-displacer@oxshare.com', 'Journey Displacer');
    // The master's own live session presents its cookies on the accept —
    // exactly what a browser would send following the emailed link.
    await master
      .post('/v1/admin/invite/accept', { token, password: NEW_ADMIN_PASSWORD })
      .expect(200);

    // The displaced session is dead everywhere, not merely overwritten here.
    await master.get('/v1/admin/auth/me').expect(401);

    // And the displaced admin can simply sign in again — nothing about the
    // ACCOUNT changed, only the session ended.
    const back = await actingAs(ctx, 'admin', MASTER);
    await back.get('/v1/admin/auth/me').expect(200);
  });

  it('a session-free accept displaces nobody', async () => {
    const live = await actingAs(ctx, 'admin', MASTER);
    const { token } = await invite('journey-cleanaccept@oxshare.com', 'Journey Clean');
    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);
    // An anonymous accept (the common case) must not end anyone's session.
    await live.get('/v1/admin/auth/me').expect(200);
  });
});

describe('outstanding invites are visible and cancellable', () => {
  it('lists an invite that has been sent and not accepted', async () => {
    // Without this an invite vanished on send: the directory lists accepted
    // admins only, so "did you invite Sam?" was answerable only from sent mail.
    const email = 'journey-pending@oxshare.com';
    const { master } = await invite(email, 'Journey Pending', reviewerRoleId);

    const res = await master.get('/v1/admin/invites').expect(200);
    const rows = res.body as Array<{ email: string; tokenHash?: string; expiresAt: string }>;
    const row = rows.find((r) => r.email === email);

    expect(row).toBeDefined();
    expect(new Date(row!.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // The list is for deciding, not a second delivery channel for the credential.
    expect(row).not.toHaveProperty('tokenHash');
    expect(row).not.toHaveProperty('token');
  });

  it('revoking kills the accept link immediately', async () => {
    const email = 'journey-revoked@oxshare.com';
    const { token, master } = await invite(email, 'Journey Revoked', reviewerRoleId);

    const list = await master.get('/v1/admin/invites').expect(200);
    const row = (list.body as Array<{ id: string; email: string }>).find((r) => r.email === email)!;

    await master.del(`/v1/admin/invites/${row.id}`).expect(200);

    // The 48-hour bearer credential that creates an admin account is now dead.
    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(404);
    await anonymous(ctx).get(`/v1/admin/invite/validate?token=${token}`).expect(400);
  });

  it('drops a revoked invite from the list', async () => {
    const email = 'journey-gone@oxshare.com';
    const { master } = await invite(email, 'Journey Gone', reviewerRoleId);
    const list = await master.get('/v1/admin/invites').expect(200);
    const row = (list.body as Array<{ id: string; email: string }>).find((r) => r.email === email)!;

    await master.del(`/v1/admin/invites/${row.id}`).expect(200);

    const after = await master.get('/v1/admin/invites').expect(200);
    expect((after.body as Array<{ email: string }>).some((r) => r.email === email)).toBe(false);
  });

  it('refuses a SECOND outstanding invite to the same address', async () => {
    // Two live tokens for one email meant the first accept created the account
    // and the second hit the unique constraint on admins.email — a 500 at the
    // last step of onboarding, for someone who did nothing wrong.
    const email = 'journey-dup@oxshare.com';
    const { master } = await invite(email, 'Journey Dup', reviewerRoleId);

    const second = await master.post('/v1/admin/invite', {
      email,
      name: 'Journey Dup Again',
      roleId: reviewerRoleId,
    });
    expect(second.status).toBe(409);
  });

  it('allows a fresh invite once the previous one is revoked', async () => {
    // Revoke DELETES the row, so the re-invite path is not blocked by a tombstone.
    const email = 'journey-reinvite@oxshare.com';
    const { master } = await invite(email, 'Journey Reinvite', reviewerRoleId);
    const list = await master.get('/v1/admin/invites').expect(200);
    const row = (list.body as Array<{ id: string; email: string }>).find((r) => r.email === email)!;
    await master.del(`/v1/admin/invites/${row.id}`).expect(200);

    const again = await master.post('/v1/admin/invite', {
      email,
      name: 'Journey Reinvite',
      roleId: reviewerRoleId,
    });
    expect([200, 201]).toContain(again.status);
  });

  it('hides an invite whose address already has an admin', async () => {
    /*
     * Found in the live dev database: one address held TWO invite rows — one
     * accepted, one not — plus the admin account. The unaccepted one sat under
     * "Outstanding Invites" describing a link that can never be accepted, since
     * `acceptInvite` re-checks `findByEmail` and refuses.
     *
     * `createInvite` now refuses the duplicate that created it, so this asserts
     * the other half: the rows already in the table, and the paths that will
     * never go through `createInvite` at all — an admin seeded or created
     * directly while an invite was outstanding lands in the same state.
     *
     * The second row is inserted directly BECAUSE the service-level guard would
     * refuse it. That is the point: this is about data the guard cannot reach.
     */
    const email = 'journey-orphan@oxshare.com';
    const { token, master } = await invite(email, 'Journey Orphan', reviewerRoleId);

    const [inviter] = await ctx.db.db.select().from(admins).where(eq(admins.email, MASTER.email));
    await ctx.db.db.insert(adminInvites).values({
      email,
      name: 'Journey Orphan Duplicate',
      tokenHash: 'orphaned-duplicate-invite-hash',
      role: 'sub_admin',
      roleId: reviewerRoleId,
      invitedBy: inviter.id,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      accepted: false,
    });

    // Both rows are live and unaccepted at this point.
    const before = await master.get('/v1/admin/invites').expect(200);
    expect((before.body as Array<{ email: string }>).filter((r) => r.email === email)).toHaveLength(
      2,
    );

    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);

    // The duplicate is still unaccepted and still unexpired — and must not be
    // offered as outstanding, because the account it would create exists.
    const after = await master.get('/v1/admin/invites').expect(200);
    expect((after.body as Array<{ email: string }>).filter((r) => r.email === email)).toEqual([]);
  });

  it('lets a role be deleted when only a dead invite still references it', async () => {
    /*
     * The second symptom of the same stale row.
     *
     * Role deletion refuses while a pending invite references the role, which is
     * right — the invite would otherwise be accepted with its `role_id` nulled
     * and no permissions at all. But an invite whose address already has an admin
     * can never be accepted, so it is holding a role hostage on behalf of a grant
     * that cannot happen, and the refusal even advises "wait for expiry".
     */
    const master = await actingAs(ctx, 'admin', MASTER);
    const created = await master.post('/v1/admin/roles', {
      name: 'Journey Disposable',
      permissions: ['clients.view'],
    });
    const roleId = (created.body as { id: string }).id;

    const email = 'journey-hostage@oxshare.com';
    const { token } = await invite(email, 'Journey Hostage', roleId);

    // Held, correctly, while the invite is genuinely outstanding.
    await master.del(`/v1/admin/roles/${roleId}`).expect(409);

    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);
    // The new admin holds the role directly now, so clear that reference too —
    // this test is about the INVITE, not about deleting a role in use.
    const [holder] = await ctx.db.db.select().from(admins).where(eq(admins.email, email));
    await ctx.db.db.update(admins).set({ roleId: null }).where(eq(admins.id, holder.id));

    // Insert the orphan: unaccepted, unexpired, and unacceptable.
    await ctx.db.db.insert(adminInvites).values({
      email,
      name: 'Journey Hostage Duplicate',
      tokenHash: 'hostage-duplicate-invite-hash',
      role: 'sub_admin',
      roleId,
      invitedBy: holder.id,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      accepted: false,
    });

    await master.del(`/v1/admin/roles/${roleId}`).expect(200);
  });

  it('refuses to revoke an invite that has already been accepted', async () => {
    const email = 'journey-accepted@oxshare.com';
    const { token, master } = await invite(email, 'Journey Accepted', reviewerRoleId);
    const list = await master.get('/v1/admin/invites').expect(200);
    const row = (list.body as Array<{ id: string; email: string }>).find((r) => r.email === email)!;

    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);

    // The account exists now; revoking would change nothing and imply it had.
    await master.del(`/v1/admin/invites/${row.id}`).expect(400);
  });
});

/**
 * An invite decides what the new administrator may SEE, and the audit trail
 * only recorded what they may DO.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * `InviteDto` carries `maskedFields`, `scopedTagIds` and `seesUntriaged`, and
 * its own comment explains why they are settable at INVITE time rather than
 * after acceptance: an empty scope means unrestricted, so configuring
 * territory later leaves a window — between the invitee clicking the emailed
 * link and somebody remembering to restrict them — in which they see every
 * client in the system. Closing that window made the invite the PRIMARY place
 * an administrator's sight of the client base is chosen.
 *
 * `admin.update` records all three, with a comment naming the question they
 * answer: "who could see which clients in March" is not derivable from a
 * permission diff, and it is exactly what a compliance review asks after an
 * incident. `admin.invite` and `admin.invite_accept` recorded `{ email,
 * roleId, permissions }` and nothing else — so that question was answerable
 * for an administrator whose territory had been EDITED, and unanswerable for
 * one who simply arrived holding it. The common path was the silent one.
 *
 * ── Why the second case is the one that matters ────────────────────────────
 *
 * Asserting the fields are recorded when they are SET would pass against a
 * payload that spreads them conditionally, and conditional spreading is the
 * existing idiom on `admin.update` — where it is correct, because there an
 * absent key means "not touched". At this door an absent key would mean
 * UNRESTRICTED, which is the most consequential grant there is and the one a
 * reader would never notice was missing. So the second case pins that
 * `scopedTagIds` is present and NULL rather than absent.
 */
describe('an invite records the VISIBILITY it grants, not only the permissions', () => {
  /*
   * `AdminAuditService.record` is deliberately fire-and-forget — an audit-write
   * failure must not fail the admin action — so the row lands shortly AFTER the
   * response. Polled rather than slept: the common case costs one query, and a
   * genuine non-recorder still fails, a second later.
   */
  async function waitForRow(action: string, subjectId: string, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await ctx.db.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, action), eq(auditLog.subjectId, subjectId)));
      if (row || Date.now() >= deadline) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function inviteIdFor(master: Awaited<ReturnType<typeof actingAs>>, email: string) {
    const list = await master.get('/v1/admin/invites').expect(200);
    const row = (list.body as Array<{ id: string; email: string }>).find((r) => r.email === email);
    if (!row) throw new Error(`no outstanding invite for ${email}`);
    return row.id;
  }

  it('carries the mask, the territory and the intake grant onto BOTH audit rows', async () => {
    const [tag] = await ctx.db.db
      .insert(clientTags)
      .values({ slug: 'journey-territory', label: 'Journey Territory' })
      .returning();

    const email = 'journey-visibility@oxshare.com';
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.post('/v1/admin/invite', {
      email,
      name: 'Journey Visibility',
      roleId: reviewerRoleId,
      maskedFields: ['client.phone'],
      scopedTagIds: [tag.id],
      seesUntriaged: false,
    });
    // Asserted rather than assumed: a 400 here (an unmaskable key, an unknown
    // tag) would otherwise leave the audit assertions below testing nothing.
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);

    const inviteRow = await waitForRow('admin.invite', await inviteIdFor(master, email));
    expect(inviteRow, 'no admin.invite audit row was written').toBeDefined();
    const invited = inviteRow.details as Record<string, unknown>;
    expect(invited.maskedFields).toEqual(['client.phone']);
    expect(invited.scopedTagIds).toEqual([tag.id]);
    expect(invited.seesUntriaged).toBe(false);

    // The invite row is keyed on the INVITE. A compliance query about one
    // administrator starts from the admin, so the same facts have to be
    // reachable from the row keyed on them.
    const url = (res.body as { inviteUrl?: string }).inviteUrl;
    if (!url) throw new Error('no inviteUrl echoed — this spec relies on the non-production echo');
    await acceptInvite(new URL(url).searchParams.get('token')!, NEW_ADMIN_PASSWORD).expect(200);

    const [created] = await ctx.db.db.select().from(admins).where(eq(admins.email, email));
    const acceptRow = await waitForRow('admin.invite_accept', created.id);
    expect(acceptRow, 'no admin.invite_accept audit row was written').toBeDefined();
    const accepted = acceptRow.details as Record<string, unknown>;
    expect(accepted.maskedFields).toEqual(['client.phone']);
    expect(accepted.scopedTagIds).toEqual([tag.id]);
    expect(accepted.seesUntriaged).toBe(false);
  });

  it('records an UNRESTRICTED territory as an explicit null, not as an absent key', async () => {
    const email = 'journey-unrestricted@oxshare.com';
    const { master } = await invite(email, 'Journey Unrestricted', reviewerRoleId);

    const row = await waitForRow('admin.invite', await inviteIdFor(master, email));
    expect(row, 'no admin.invite audit row was written').toBeDefined();
    const details = row.details as Record<string, unknown>;

    /*
     * `toHaveProperty` rather than a null comparison, because `details.x` is
     * `undefined` both when the key is absent and when it is null — so
     * `toBeNull()` alone would pass against the conditional spread this case
     * exists to refuse. An invitee nobody scoped can see EVERY client, and the
     * record has to say so out loud.
     */
    expect(details).toHaveProperty('scopedTagIds');
    expect(details.scopedTagIds).toBeNull();
    expect(details).toHaveProperty('maskedFields');
    // The intake grant is not null-able: it resolves to a boolean either way,
    // and an unrestricted inviter grants it by default (0058).
    expect(details.seesUntriaged).toBe(true);
  });
});

/**
 * A SCOPED INVITER CANNOT PRODUCE AN UNRESTRICTED ADMINISTRATOR.
 *
 * `test/invite-lifecycle.spec.ts` proves the INVITE ROW carries the inherited
 * territory. That is half the property, and it is the half that cannot hurt
 * anybody: what matters is whether the ADMIN who accepts it ends up able to see
 * every client. Those are joined by `acceptInvite`'s
 * `if (invite.scopedTagIds?.length)` — so a fix that populated the invite and a
 * carry that dropped it would leave both halves green and the escalation live.
 *
 * This walks the whole thing over HTTP and then reads
 * `admin_client_tag_scopes` directly, because the absence of rows there IS the
 * vulnerability: an empty scope means UNRESTRICTED, so "no rows" and "sees
 * everything" are the same sentence.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * `createInvite` gated BOTH the `admins.scope` check and `assertScopable` on
 * `scopedTagIds !== undefined`. An explicit `[]` was refused by name; omitting
 * the key skipped both guards. So a scoped sub-admin holding `admins.create`
 * could mint a colleague who saw every client in the system by leaving a field
 * out — and `invite-admin-modal.tsx` sends exactly that spelling, spreading the
 * key only when non-empty. Two spellings of "I chose no territory", opposite
 * security outcomes.
 */
describe('a scoped inviter cannot create an admin who sees more than they do', () => {
  it('carries the inviter’s OWN territory through to the accepted account', async () => {
    const [tag] = await ctx.db.db
      .insert(clientTags)
      .values({ slug: 'journey-inherit', label: 'Journey Inherit' })
      .returning();

    const passwords = new PasswordService();
    const INVITER = { email: 'journey-scoped-inviter@oxshare.com', password: 'inviter-pass-123' };
    const [inviter] = await ctx.db.db
      .insert(admins)
      .values({
        email: INVITER.email,
        passwordHash: await passwords.hash(INVITER.password),
        name: 'Journey Scoped Inviter',
        role: 'sub_admin',
        // `admins.create` to invite at all, `kyc.review` so the grant itself is
        // within their gift — without it this dies at `assertGrantable` and
        // never reaches the scope logic under test. Deliberately NOT holding
        // `admins.scope`: the inheritance is the system declining to widen
        // sight, not this actor choosing a visibility.
        permissions: ['admins.create', 'kyc.review'],
        status: 'active',
      })
      .returning();
    await ctx.db.db
      .insert(adminClientTagScopes)
      .values({ adminId: inviter.id, tagId: tag.id, createdBy: inviter.id });

    const scoped = await actingAs(ctx, 'admin', INVITER);
    const email = 'journey-inherited@oxshare.com';
    // NO scopedTagIds, no mask, no intake grant — the silent invite, which is
    // what the console sends when an operator picks no tags.
    const res = await scoped.post('/v1/admin/invite', {
      email,
      name: 'Journey Inherited',
      permissions: ['kyc.review'],
    });
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);

    const url = (res.body as { inviteUrl?: string }).inviteUrl;
    if (!url) throw new Error('no inviteUrl echoed — this spec relies on the non-production echo');
    await acceptInvite(new URL(url).searchParams.get('token')!, NEW_ADMIN_PASSWORD).expect(200);

    const [created] = await ctx.db.db.select().from(admins).where(eq(admins.email, email));
    expect(created, 'the invite did not produce an administrator').toBeDefined();

    const scopeRows = await ctx.db.db
      .select()
      .from(adminClientTagScopes)
      .where(eq(adminClientTagScopes.adminId, created.id));

    /*
     * THE ASSERTION THE WHOLE FILE IS FOR. No rows here does not mean "no
     * access" — it means UNRESTRICTED, every client in the system. Under the
     * defect this array was empty and the new admin outranked the person who
     * invited them.
     */
    expect(
      scopeRows.length,
      'the new admin has NO scope rows, which means UNRESTRICTED — they see every ' +
        'client, including those outside the territory of the admin who invited them',
    ).toBeGreaterThan(0);
    expect(scopeRows.map((r) => r.tagId)).toEqual([tag.id]);
  });
});
