import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  auditLog,
  clientTagAssignments,
  clientTags,
  roles,
  users,
} from '../src/database/schema';

/**
 * What the admin action log ACTUALLY SERVES — not what it stores.
 *
 * The distinction is the whole point of this file. `audit_log.ip_address` and
 * `actor_kind` have been populated since the columns existed, and neither was
 * in `AuditEntryDto` — so the API sent them and the OpenAPI document denied
 * they existed. Both frontends generate their types from that document, so the
 * admin screen could not render either without hand-writing an interface and
 * giving up the one mechanism that turns backend drift into a compile error
 * (R-1.1).
 *
 * The result: "which address did this administrator approve the payout from"
 * was answerable in SQL and nowhere a person would look. On a money system,
 * that is the question asked after an incident.
 */

const MASTER = { email: 'audit-http-master@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
let clientId: string;

interface AuditRow {
  action: string;
  actorEmail: string;
  actorKind: string;
  ipAddress?: string | null;
  subjectType: string;
  subjectId: string;
  details?: Record<string, unknown>;
}

const rows = (body: unknown) => (body as { items: AuditRow[] }).items;

/**
 * Wait for a row to appear, because `record()` is FIRE-AND-FORGET.
 *
 * ── The cause of this file's intermittent failures ─────────────────────────
 *
 * `AdminAuditService.record` deliberately does not await its write: an
 * audit-write failure must never fail the administrative action it describes.
 * So the row lands some time AFTER the HTTP response the caller already has,
 * and a test that asserts on the very next line is racing it. It usually won —
 * the write is a single INSERT on a warm pool — which is the worst kind of
 * flake, because it passes locally and fails on a loaded CI box.
 *
 * ── Polling rather than a fixed sleep ──────────────────────────────────────
 *
 * The same approach `audit-completeness.spec.ts` takes, and the reason is the
 * same: this returns as soon as the row is there, so the ordinary case costs
 * one extra request and nothing else, while a genuine non-recorder still fails
 * — just a second later. A `setTimeout(500)` would instead tax every run for
 * the worst case and STILL be a race, just a longer one.
 *
 * Asserted through the API rather than the table on purpose: this file is about
 * what the endpoint SERVES (`ipAddress`, `actorKind`), so reading the table
 * would test the wrong half. Money routes use `recordWithin`, which commits
 * inside the caller's transaction and needs none of this.
 */
async function waitForRow(
  session: Awaited<ReturnType<typeof actingAs>>,
  query: string,
  match: (row: AuditRow) => boolean,
  timeoutMs = 3000,
): Promise<AuditRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await session.get(query);
    const found = res.status === 200 ? rows(res.body).find(match) : undefined;
    if (found || Date.now() >= deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Audit HTTP Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Audit Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  const [client] = await db
    .insert(users)
    .values({
      email: 'audit-http-target@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Audit',
      lastName: 'Target',
    })
    .returning();
  clientId = client.id;
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the action log serves what it records', () => {
  it('includes the ACTOR ADDRESS on the row', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.patch(`/v1/admin/clients/${clientId}/status`, { status: 'suspended' });

    const row = await waitForRow(
      session,
      '/v1/admin/audit-log?action=client.suspend',
      (r) => r.subjectId === clientId,
    );
    expect(row, 'the suspension was not recorded at all').toBeDefined();
    // The property the whole file exists for. Supertest connects over loopback,
    // so this is 127.0.0.1 — the value matters less than the field being
    // present and populated rather than silently dropped by the DTO.
    expect(row?.ipAddress, 'ip_address is stored but not served').toBeTruthy();
  });

  it('includes the actor KIND, so a job and a person are distinguishable', async () => {
    // Background work runs as a NAMED `system` actor rather than an implicit
    // bypass (R-4.3). Without this field on the wire, a reviewer cannot tell a
    // scheduled sweep from a person at a keyboard.
    //
    // Performs its OWN suspension rather than reading the one the previous test
    // made: relying on a sibling test's side effect makes this pass or fail
    // depending on execution order, which is a second race on top of the one
    // the polling removes.
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.patch(`/v1/admin/clients/${clientId}/status`, { status: 'suspended' });

    const row = await waitForRow(
      session,
      '/v1/admin/audit-log?action=client.suspend',
      (r) => r.subjectId === clientId,
    );
    expect(row?.actorKind).toBe('admin');
  });

  it('names the administrator who acted', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.patch(`/v1/admin/clients/${clientId}/status`, { status: 'suspended' });

    const row = await waitForRow(
      session,
      '/v1/admin/audit-log?action=client.suspend',
      (r) => r.subjectId === clientId,
    );
    expect(row?.actorEmail).toBe(MASTER.email);
  });
});

describe('the actions that previously left no trace', () => {
  /**
   * Each of these changes what happens to a client's money or identity
   * documents, and none of them LOOKS like money — which is exactly why they
   * were the gaps. They could be rewritten with nothing recorded.
   */
  it('records a change to a rejection reason, with the old text', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const created = await session.post('/v1/admin/rejection-reasons', {
      context: 'kyc',
      label: 'Audit HTTP original wording',
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    await session.put(`/v1/admin/rejection-reasons/${id}`, { label: 'Audit HTTP new wording' });

    const row = await waitForRow(
      session,
      '/v1/admin/audit-log?action=rejection_reason.update',
      (r) => r.subjectId === id,
    );

    expect(row, 'editing what a client is TOLD left no trace').toBeDefined();
    // The old wording, because the current value answers nothing about a
    // complaint concerning last month's text.
    expect(row?.details?.['before']).toBe('Audit HTTP original wording');
    expect(row?.details?.['after']).toBe('Audit HTTP new wording');
  });

  it('records a change to the download links served to clients', async () => {
    // Repointing one of these sends every client who clicks it to whatever is
    // at the new address. It was a log line, which is not a record: it rotates,
    // it is not queryable, and it does not appear on the screen an investigator
    // would open.
    const session = await actingAs(ctx, 'admin', MASTER);
    const set = await session.put('/v1/admin/platforms/desktop', {
      url: 'https://download.example.com/mt5-audit-http.exe',
    });
    expect(set.status).toBe(200);

    const row = await waitForRow(
      session,
      '/v1/admin/audit-log?action=platform_link.set',
      (r) => r.subjectId === 'desktop',
    );

    expect(row).toBeDefined();
    expect(row?.details?.['after']).toBe('https://download.example.com/mt5-audit-http.exe');
  });

  it('records a change to the KYC configuration', async () => {
    // The form definition governs what every client must submit to be
    // verified, and verification is what opens the withdrawal gate. A step
    // quietly disabled is a control quietly removed.
    const session = await actingAs(ctx, 'admin', MASTER);

    // The RESET route rather than the replace: it is the most destructive of
    // the five (it discards the entire configuration), takes no body, and was
    // equally unrecorded. Round-tripping GET into PUT would only exercise the
    // request DTO, which is not what this file is about.
    const reset = await session.post('/v1/admin/kyc-config/reset', {});
    expect(reset.status).toBe(201);

    const row = await waitForRow(
      session,
      '/v1/admin/audit-log?action=kyc_config.reset',
      () => true,
    );
    expect(row, 'discarding the KYC configuration left no trace').toBeDefined();
    expect(row?.actorEmail).toBe(MASTER.email);
  });
});

describe('client-subject rows follow the reader’s scope — D-54, resolved', () => {
  /*
   * The exposure D-54 recorded: most audit rows are about ADMINS, but the KYC
   * decisions and tag actions write the CLIENT's own id as the subject — so a
   * tag-scoped sub-admin holding `audit.view` could read decisions about
   * clients outside their territory. Resolved (owner, 13 Aug 2026): rows whose
   * subject is a client follow the reader's scope, in the WHERE clause; rows
   * about admins stay visible to every `audit.view` holder, and the export
   * takes the same path as the list so it cannot be the way around the filter.
   */
  const SCOPED = { email: 'audit-http-scoped@oxshare.com', password: 'admin-password-123' };

  it('hides out-of-territory client rows, keeps admin-subject rows, leaves the master whole', async () => {
    const db = ctx.db.db;
    const passwords = new PasswordService();

    const [tag] = await db
      .insert(clientTags)
      .values({ slug: 'audit-scope-e2e', label: 'Audit Scope' })
      .returning();
    const [inScope] = await db
      .insert(users)
      .values({
        email: 'audit-in-scope@oxshare-e2e.test',
        passwordHash: 'x',
        firstName: 'In',
        lastName: 'Scope',
      })
      .returning();
    const [outScope] = await db
      .insert(users)
      .values({
        email: 'audit-out-scope@oxshare-e2e.test',
        passwordHash: 'x',
        firstName: 'Out',
        lastName: 'Scope',
      })
      .returning();
    await db.insert(clientTagAssignments).values({ userId: inScope.id, tagId: tag.id });

    const [scopedAdmin] = await db
      .insert(admins)
      .values({
        email: SCOPED.email,
        passwordHash: await passwords.hash(SCOPED.password),
        name: 'Audit Scoped Reader',
        permissions: ['audit.view'],
        status: 'active',
      })
      .returning();
    await db
      .insert(adminClientTagScopes)
      .values({ adminId: scopedAdmin.id, tagId: tag.id, createdBy: scopedAdmin.id });

    // Straight into the table: this file otherwise tests what the API serves,
    // but HOW the rows landed is not the property under test here.
    await db.insert(auditLog).values([
      {
        actorId: scopedAdmin.id,
        actorEmail: SCOPED.email,
        action: 'kyc.approve',
        subjectType: 'kyc_submission',
        subjectId: inScope.id,
      },
      {
        actorId: scopedAdmin.id,
        actorEmail: SCOPED.email,
        action: 'kyc.approve',
        subjectType: 'kyc_submission',
        subjectId: outScope.id,
      },
      {
        actorId: scopedAdmin.id,
        actorEmail: SCOPED.email,
        action: 'client_tag.assign',
        subjectType: 'user',
        subjectId: outScope.id,
      },
      {
        actorId: scopedAdmin.id,
        actorEmail: SCOPED.email,
        action: 'admin.update',
        subjectType: 'admin',
        subjectId: scopedAdmin.id,
      },
    ]);

    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const res = await scoped.get('/v1/admin/audit-log?limit=100');
    expect(res.status).toBe(200);
    const visible = rows(res.body);

    expect(
      visible.some((r) => r.subjectId === inScope.id),
      'a row about a client INSIDE the territory disappeared',
    ).toBe(true);
    expect(
      visible.some((r) => r.subjectId === outScope.id),
      'a row naming a client OUTSIDE the territory leaked to a scoped reader',
    ).toBe(false);
    expect(
      visible.some((r) => r.subjectType === 'admin' && r.subjectId === scopedAdmin.id),
      'an admin-subject row was over-filtered — the trail about administrators is not client data',
    ).toBe(true);

    // The unrestricted reader still sees everything, including the rows the
    // scoped reader must not.
    const master = await actingAs(ctx, 'admin', MASTER);
    const everything = rows((await master.get('/v1/admin/audit-log?limit=100')).body);
    expect(everything.some((r) => r.subjectId === outScope.id)).toBe(true);
  });
});
