import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles, users } from '../src/database/schema';

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

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Audit HTTP Master', permissions: ['*'], isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Audit Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ['*'],
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

    const res = await session.get('/v1/admin/audit-log?action=client.suspend');
    expect(res.status).toBe(200);

    const row = rows(res.body).find((r) => r.subjectId === clientId);
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
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/audit-log?action=client.suspend');

    const row = rows(res.body).find((r) => r.subjectId === clientId);
    expect(row?.actorKind).toBe('admin');
  });

  it('names the administrator who acted', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/audit-log?action=client.suspend');

    const row = rows(res.body).find((r) => r.subjectId === clientId);
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

    const res = await session.get('/v1/admin/audit-log?action=rejection_reason.update');
    const row = rows(res.body).find((r) => r.subjectId === id);

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

    const res = await session.get('/v1/admin/audit-log?action=platform_link.set');
    const row = rows(res.body).find((r) => r.subjectId === 'desktop');

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

    const res = await session.get('/v1/admin/audit-log?action=kyc_config.reset');
    expect(rows(res.body).length, 'discarding the KYC configuration left no trace').toBeGreaterThan(
      0,
    );
    expect(rows(res.body)[0]?.actorEmail).toBe(MASTER.email);
  });
});
