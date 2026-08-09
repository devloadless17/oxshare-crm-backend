import { ALL_PERMISSIONS } from './support/all-permissions';
import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { UploadsController } from '../src/modules/compliance/uploads.controller';
import type { AuditEntry } from '../src/store/audit-log.store';
import { TOKEN_KIND } from '../src/common/security/token-audience';
import { StoredFilesService } from '../src/common/uploads/stored-files.service';
import { UNRESTRICTED, type ClientScope } from '../src/common/security/client-scope';

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
/** An admin REFRESH token — verifies, but must not authenticate a document read. */
const REFRESH_TOKEN = 'admin-refresh-token';
const FILE = '11111111-2222-3333-4444-555555555555.png';

interface Harness {
  controller: UploadsController;
  recorded: Omit<AuditEntry, 'id' | 'createdAt'>[];
}

function makeController(options: {
  adminPermissions?: string[];
  clientOwnsFile?: boolean;
  auditFails?: boolean;
  /**
   * RBAC-08 rules in force. Default `[]` — the allowlist is off, which is the
   * state every other case in this file assumes.
   */
  /** RBAC-03 territory. Default unrestricted — see `scopes` below. */
  clientScope?: ClientScope;
  /** Who the document belongs to. `null` models a filename nobody owns. */
  documentOwner?: string | null;
  /** Whether that owner is inside the reader's territory. */
  ownerInScope?: boolean;
  /** The CLIENT's verification state. Default verified — see `users` below. */
  clientEmailVerified?: boolean;
}): Harness {
  const recorded: Omit<AuditEntry, 'id' | 'createdAt'>[] = [];

  /*
   * Payloads carry `typ`, because real ones do.
   *
   * The controller now checks the token KIND as every other verification site
   * does — a refresh token must not authenticate a document read. A stub that
   * omitted `typ` was describing a token this system never mints, and it made
   * the whole suite fail the moment the check arrived.
   */
  const jwt = {
    verify: (token: string) => {
      if (token === ADMIN_TOKEN) return { sub: 'admin-1', typ: TOKEN_KIND.access };
      if (token === CLIENT_TOKEN) return { sub: 'client-1', typ: TOKEN_KIND.access };
      if (token === REFRESH_TOKEN) return { sub: 'admin-1', typ: TOKEN_KIND.refresh };
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
    // The filename → owning client lookup that makes the scope applicable to a
    // route whose only parameter is a filename.
    // `null` is how a case says "no client owns this filename"; `undefined`
    // means "the case did not care" and gets the default owner. Collapsing the
    // two through `??` made the orphan case silently test the happy path.
    ownerOfDocument: () =>
      Promise.resolve(
        options.documentOwner === null ? undefined : (options.documentOwner ?? 'client-1'),
      ),
  };
  const users = {
    // `emailVerified` matters now: the client branch of `authorize()` refuses an
    // unverified owner. Verified is the realistic fixture — an unverified client
    // cannot have submitted a document to read in the first place.
    findById: () =>
      Promise.resolve({
        id: 'client-1',
        email: 'client@test.local',
        // `emailVerified` matters now: the client branch of `authorize()`
        // refuses an unverified owner. Verified is the realistic default — an
        // unverified client cannot have submitted a document to read.
        emailVerified: options.clientEmailVerified ?? true,
      }),
    // The scoped lookup. Returning undefined is what an out-of-scope client
    // looks like from every admin-facing read.
    findForAdmin: () =>
      Promise.resolve(
        options.ownerInScope === false ? undefined : { id: 'client-1', email: 'client@test.local' },
      ),
  };
  const auditLog = {
    record: (entry: Omit<AuditEntry, 'id' | 'createdAt'>) => {
      if (options.auditFails) return Promise.reject(new Error('audit store unavailable'));
      recorded.push(entry);
      return Promise.resolve({ ...entry, id: 'a1', createdAt: new Date() });
    },
  };

  // Unrestricted unless a case says otherwise: these specs are about the audit
  // record and the permission split, not about territory.
  const scopes = {
    scopeFor: () => Promise.resolve(options.clientScope ?? UNRESTRICTED),
  };

  const controller = new UploadsController(
    jwt as never,
    config as never,
    admins as never,
    roles as never,
    kyc as never,
    users as never,
    auditLog as never,
    new StoredFilesService(),
    scopes as never,
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

function requestWith(cookies: Record<string, string>, ip?: string) {
  // `socket: {}` mirrors what `clientIp()` falls back to on a real request; with
  // no `ip` it resolves to undefined, which is the "we cannot identify this
  // caller" case RBAC-08 must fail closed on.
  return { cookies, ip, socket: {} } as never;
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
      actorKind: 'admin',
      action: 'kyc.document.view',
      subjectType: 'kyc_document',
      subjectId: FILE,
    });
    // And the document was still served.
    expect(res.sent).toHaveLength(1);
  });

  it('REFUSES a client whose email is not verified, and serves nothing', async () => {
    /*
     * The client branch checks `emailVerified`; the ADMIN branch deliberately
     * does not, because an admin has no such column and testing it there would
     * lock every reviewer out of every document. That asymmetry is why this
     * lives in the handler rather than in a controller-level guard — which
     * principal is acting is only knowable after the token resolves.
     *
     * The document is the client's OWN, so this is not about ownership. It is
     * that an unverified address makes "this account holder" a claim nobody
     * confirmed, and a passport is the most sensitive thing this system holds.
     */
    const { controller, recorded } = makeController({
      clientOwnsFile: true,
      clientEmailVerified: false,
    });
    const res = fakeResponse();

    await expect(
      controller.serveKycFile(
        FILE,
        requestWith({ oxshare_crm_portal_at: CLIENT_TOKEN }),
        res as never,
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });

    // No bytes, and no audit row claiming a read that did not happen — the
    // refusal lands before both, exactly as the scope check does.
    expect(res.sent).toHaveLength(0);
    expect(recorded).toHaveLength(0);
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
    /*
     * The KIND is a column, not a suffix on the action name.
     *
     * This used to be a separate action — `kyc.document.view.own` — because the
     * audit table had nowhere to record who was acting, so the action name was
     * the only place to put it. That made "every read of this document" two
     * queries instead of one, and a third kind of reader would have needed a
     * third action name. `actor_kind` is where it belongs, and a compliance
     * query can now exclude the subject themselves by filtering a column.
     */
    expect(recorded[0]).toMatchObject({
      actorId: 'client-1',
      actorKind: 'client',
      action: 'kyc.document.view',
      subjectId: FILE,
    });
  });

  it('lets an auditor holding ONLY kyc.documents.view read a document', async () => {
    /*
     * The split this permission exists for.
     *
     * Reading a document and deciding an outcome used to be the same grant, so
     * an auditor who needed to inspect submissions had to be given the key that
     * also promotes accounts to verification level 1 — which is what opens the
     * withdrawal gate. A large grant to make for a read.
     */
    const { controller, recorded } = makeController({ adminPermissions: ['kyc.documents.view'] });
    const res = fakeResponse();

    await controller.serveKycFile(
      FILE,
      requestWith({ oxshare_crm_admin_at: ADMIN_TOKEN }),
      res as never,
    );

    expect(res.sent).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ actorKind: 'admin', action: 'kyc.document.view' });
  });

  it('still lets a reviewer read, without also needing the new key', async () => {
    // kyc.review IMPLIES the read. Requiring both would have broken every
    // existing reviewer on deploy, silently, at the moment they opened a
    // submission.
    const { controller } = makeController({ adminPermissions: ['kyc.review'] });
    const res = fakeResponse();

    await controller.serveKycFile(
      FILE,
      requestWith({ oxshare_crm_admin_at: ADMIN_TOKEN }),
      res as never,
    );

    expect(res.sent).toHaveLength(1);
  });

  it('refuses an admin holding neither', async () => {
    const { controller } = makeController({ adminPermissions: ['clients.read'] });

    await expect(
      controller.serveKycFile(
        FILE,
        requestWith({ oxshare_crm_admin_at: ADMIN_TOKEN }),
        fakeResponse() as never,
      ),
    ).rejects.toThrow(ForbiddenException);
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

  it('refuses an admin REFRESH token, which is not an access credential', async () => {
    // Every other verification site checks the token KIND; this one did not, so
    // a 30-day refresh token was as good as a 15-minute access token for reading
    // a passport. The separate refresh secret already made this fail — this
    // keeps it failing if the two secrets are ever conflated in a deploy.
    const { controller, recorded } = makeController({ adminPermissions: ['kyc.review'] });
    const res = fakeResponse();

    await expect(
      controller.serveKycFile(
        FILE,
        requestWith({ oxshare_crm_admin_at: REFRESH_TOKEN }),
        res as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(recorded).toHaveLength(0);
    expect(res.sent).toHaveLength(0);
  });

  it('still denies an admin without kyc.review, and records nothing', async () => {
    const { controller, recorded } = makeController({ adminPermissions: ['clients.view'] });
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

  /*
   * The RBAC-08 describe block was HERE — five tests covering the network
   * restriction on admin document reads.
   *
   * They went with the IP allowlist itself. What they asserted is worth
   * recording, because it is exactly what no longer holds: an admin outside the
   * configured CIDRs was refused and nothing was audited; a caller whose
   * address could not be determined was refused too, failing closed; and a
   * CLIENT reading their own document was never restricted, which is why the
   * check lived in the handler rather than in a guard.
   *
   * An admin reading a client's passport is still gated on a valid session and
   * on `kyc.documents.view`, and the read is still audited. It is no longer
   * restricted by network.
   */

  /**
   * RBAC-03 reaches the route whose only parameter is a FILENAME.
   *
   * The sneakiest gap in the whole feature: a scoped administrator who cannot
   * open a client's profile can still hold one of their document filenames —
   * from a screenshot, a stale tab, a ticket someone pasted into chat — and
   * this route had nothing to check it against. The read would have been served
   * and then AUDITED AS LEGITIMATE.
   */
  describe('client scoping covers admin document reads', () => {
    const SCOPED: ClientScope = { unrestricted: false, tagIds: ['tag-alpha'] };

    it('refuses a scoped admin the document of a client outside their territory', async () => {
      const { controller, recorded } = makeController({
        adminPermissions: ['kyc.review'],
        clientScope: SCOPED,
        ownerInScope: false,
      });
      const res = fakeResponse();

      await expect(
        controller.serveKycFile(
          FILE,
          requestWith({ oxshare_crm_admin_at: ADMIN_TOKEN }),
          res as never,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      // 404, not 403 — distinguishing them would tell a scoped admin which
      // filenames are real, which is the enumeration this route is most
      // exposed to.
      expect(res.sent).toHaveLength(0);
      // And NOTHING is recorded. An audit row for a refused read is a claim
      // that a document was accessed when it was not.
      expect(recorded).toHaveLength(0);
    });

    it('serves a scoped admin a document INSIDE their territory, and audits it', async () => {
      // The control. Without it, "the scoped admin is refused" would also pass
      // against a system that refuses everybody.
      const { controller, recorded } = makeController({
        adminPermissions: ['kyc.review'],
        clientScope: SCOPED,
        ownerInScope: true,
      });
      const res = fakeResponse();

      await controller.serveKycFile(
        FILE,
        requestWith({ oxshare_crm_admin_at: ADMIN_TOKEN }),
        res as never,
      );

      expect(res.sent).toHaveLength(1);
      expect(recorded).toHaveLength(1);
    });

    it('refuses a filename no client owns, rather than serving an orphan', async () => {
      const { controller } = makeController({
        adminPermissions: ['kyc.review'],
        clientScope: SCOPED,
        documentOwner: null,
      });
      const res = fakeResponse();

      await expect(
        controller.serveKycFile(
          FILE,
          requestWith({ oxshare_crm_admin_at: ADMIN_TOKEN }),
          res as never,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('does not restrict an UNRESTRICTED admin, and pays no lookup for them', async () => {
      // The common path: a master admin must not pay two extra queries per
      // document view for a check that cannot refuse them.
      const { controller } = makeController({
        adminPermissions: ALL_PERMISSIONS,
        ownerInScope: false, // would refuse, if the gate ran at all
      });
      const res = fakeResponse();

      await controller.serveKycFile(
        FILE,
        requestWith({ oxshare_crm_admin_at: ADMIN_TOKEN }),
        res as never,
      );
      expect(res.sent).toHaveLength(1);
    });
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
    const { controller, recorded } = makeController({ adminPermissions: ALL_PERMISSIONS });
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
