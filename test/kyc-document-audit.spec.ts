import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { UploadsController } from '../src/modules/compliance/uploads.controller';
import type { AuditEntry } from '../src/store/audit-log.store';

/**
 * Reading a KYC document is an audited event — PLATFORM-CONVENTIONS R-6.6.
 *
 * `UploadsController` already authorized reads correctly (a `kyc.review` admin
 * may fetch any document, a client only their own) and recorded nothing at all.
 * "Which admin viewed this client's passport" is a routine question in a
 * compliance review, and it had no answer.
 *
 * The authorization half is asserted here too, because the change that made the
 * audit possible also reshaped it: `isAuthorized(): boolean` became
 * `authorize(): Reader`, and a refactor of an access-control function deserves
 * its own regression cover regardless of what motivated it.
 */

const ADMIN_TOKEN = 'admin-token';
const CLIENT_TOKEN = 'client-token';
const FILE = '11111111-2222-3333-4444-555555555555.png';

interface Harness {
  controller: UploadsController;
  recorded: Omit<AuditEntry, 'id' | 'createdAt'>[];
}

function makeController(options: {
  adminPermissions?: string[];
  clientOwnsFile?: boolean;
  auditFails?: boolean;
}): Harness {
  const recorded: Omit<AuditEntry, 'id' | 'createdAt'>[] = [];

  const jwt = {
    verify: (token: string) => {
      if (token === ADMIN_TOKEN) return { sub: 'admin-1' };
      if (token === CLIENT_TOKEN) return { sub: 'client-1' };
      throw new Error('bad token');
    },
  };
  const config = { getOrThrow: () => 'x'.repeat(32) };
  const admins = {
    findById: (id: string) =>
      Promise.resolve(
        options.adminPermissions && id === 'admin-1'
          ? { id: 'admin-1', email: 'admin@test.local', roleId: undefined, permissions: [] }
          : undefined,
      ),
  };
  const roles = { resolvePermissions: () => Promise.resolve(options.adminPermissions ?? []) };
  const kyc = {
    findByUserId: () =>
      Promise.resolve(
        options.clientOwnsFile ? { document: { frontFilePath: `uploads/kyc/${FILE}` } } : undefined,
      ),
  };
  const users = { findById: () => Promise.resolve({ id: 'client-1', email: 'client@test.local' }) };
  const auditLog = {
    record: (entry: Omit<AuditEntry, 'id' | 'createdAt'>) => {
      if (options.auditFails) return Promise.reject(new Error('audit store unavailable'));
      recorded.push(entry);
      return Promise.resolve({ ...entry, id: 'a1', createdAt: new Date() });
    },
  };

  const controller = new UploadsController(
    jwt as never,
    config as never,
    admins as never,
    roles as never,
    kyc as never,
    users as never,
    auditLog as never,
  );

  return { controller, recorded };
}

/**
 * A response that records what was sent without touching the filesystem.
 *
 * Closures rather than methods, so nothing here depends on `this` — the object
 * is handed to a controller that may destructure it.
 */
function fakeResponse() {
  const headers: Record<string, string> = {};
  const sent: string[] = [];
  const res = {
    headers,
    sent,
    setHeader: (key: string, value: string) => {
      headers[key] = value;
    },
    sendFile: (path: string) => {
      sent.push(path);
      return res;
    },
  };
  return res;
}

function requestWith(cookies: Record<string, string>) {
  return { cookies } as never;
}

const FIXTURE = join(process.cwd(), 'uploads', 'kyc', FILE);

beforeEach(() => {
  // The handler 404s on a missing file before it audits, so the fixture has to
  // exist. Written into the real upload directory the controller reads from.
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, 'not-a-real-document');
});

afterAll(() => {
  // upload-limits.spec.ts asserts on the total byte size of this directory, so
  // a fixture left behind is a test that changes another test's baseline.
  rmSync(FIXTURE, { force: true });
});

describe('R-6.6 — reading a KYC document writes an audit row', () => {
  it('records which admin viewed which document', async () => {
    const { controller, recorded } = makeController({ adminPermissions: ['kyc.review'] });
    const res = fakeResponse();

    await controller.serveKycFile(
      FILE,
      requestWith({ oxshare_crm_admin_at: ADMIN_TOKEN }),
      res as never,
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      actorId: 'admin-1',
      actorEmail: 'admin@test.local',
      action: 'kyc.document.view',
      subjectType: 'kyc_document',
      subjectId: FILE,
    });
    // And the document was still served.
    expect(res.sent).toHaveLength(1);
  });

  it('records a client reading their own document, distinctly from an admin read', async () => {
    const { controller, recorded } = makeController({ clientOwnsFile: true });
    const res = fakeResponse();

    await controller.serveKycFile(
      FILE,
      requestWith({ oxshare_crm_portal_at: CLIENT_TOKEN }),
      res as never,
    );

    expect(recorded).toHaveLength(1);
    // A separate action, so a compliance query for "who else saw this" can
    // exclude the subject themselves without parsing anything.
    expect(recorded[0]).toMatchObject({
      actorId: 'client-1',
      action: 'kyc.document.view.own',
      subjectId: FILE,
    });
  });

  it('refuses to serve when the access record cannot be written', async () => {
    const { controller, recorded } = makeController({
      adminPermissions: ['kyc.review'],
      auditFails: true,
    });
    const res = fakeResponse();

    // The whole point of R-6.6 is that this access is accountable. Serving PII
    // with no record is the state the rule exists to prevent, so a failure to
    // record has to fail the request rather than be swallowed.
    await expect(
      controller.serveKycFile(
        FILE,
        requestWith({ oxshare_crm_admin_at: ADMIN_TOKEN }),
        res as never,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(recorded).toHaveLength(0);
    expect(res.sent).toHaveLength(0);
  });

  it('still denies an admin without kyc.review, and records nothing', async () => {
    const { controller, recorded } = makeController({ adminPermissions: ['users.view'] });
    const res = fakeResponse();

    await expect(
      controller.serveKycFile(
        FILE,
        requestWith({ oxshare_crm_admin_at: ADMIN_TOKEN }),
        res as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(recorded).toHaveLength(0);
  });

  it("still denies a client reading someone else's document", async () => {
    const { controller, recorded } = makeController({ clientOwnsFile: false });
    const res = fakeResponse();

    await expect(
      controller.serveKycFile(
        FILE,
        requestWith({ oxshare_crm_portal_at: CLIENT_TOKEN }),
        res as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(recorded).toHaveLength(0);
  });

  it('the wildcard permission grants an admin read, and is still audited', async () => {
    const { controller, recorded } = makeController({ adminPermissions: ['*'] });
    const res = fakeResponse();

    await controller.serveKycFile(
      FILE,
      requestWith({ oxshare_crm_admin_at: ADMIN_TOKEN }),
      res as never,
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.action).toBe('kyc.document.view');
  });
});
