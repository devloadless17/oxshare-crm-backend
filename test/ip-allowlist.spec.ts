import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { IpAllowlistGuard } from '../src/modules/admin/guards/ip-allowlist.guard';
import { AdminIpAllowlistService } from '../src/modules/admin/admin-ip-allowlist.service';
import type { AdminIpAllowlistStore, AllowlistRule } from '../src/store/admin-ip-allowlist.store';
import type { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import type { Admin } from '../src/store/admins.store';
import { ConflictError, NotFoundError, ValidationError } from '../src/common/errors/domain-errors';

/**
 * RBAC-08 — who may reach the administration API.
 *
 * Two properties carry the whole feature, and both are the kind that get
 * "simplified" away by someone who does not know why they are there:
 *
 *   1. An EMPTY list means the feature is off. The deploy that creates the
 *      table must not lock every administrator out before anyone can add a rule.
 *   2. A NON-EMPTY list denies an unknown address. Once someone has said "only
 *      these", failing open on a caller we cannot identify defeats the point.
 *
 * The third is operational rather than adversarial, and is the likeliest way
 * this feature actually hurts someone: an admin adding a range that excludes
 * themselves, and losing the screen they would use to undo it.
 */

// A full Admin, not `{ id }`: the service asserts `settings.security.edit` on the
// actor itself (R-4.3), not only in the guard, so the fixture has to be a
// principal rather than a bare id.
const ADMIN: Admin = {
  id: 'admin-1',
  email: 'admin@oxshare.com',
  passwordHash: 'not-used-here',
  name: 'Test Admin',
  role: 'master_admin',
  permissions: ['settings.security.edit'],
  roleId: null,
  createdAt: new Date(),
} as unknown as Admin;

function buildGuard(rules: string[]) {
  const store = { listCidrs: vi.fn().mockResolvedValue(rules) };
  const guard = new IpAllowlistGuard(store as unknown as AdminIpAllowlistStore);
  return { guard, store };
}

/** A Nest execution context for an admin request from `ip`. */
const contextFor = (ip: string | undefined, path = '/v1/admin/clients') =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ path, ip, socket: {} }),
    }),
  }) as never;

describe('IpAllowlistGuard', () => {
  it('allows everything while the list is empty', async () => {
    // The property that stops the deploy locking everyone out.
    const { guard } = buildGuard([]);
    await expect(guard.canActivate(contextFor('8.8.8.8'))).resolves.toBe(true);
  });

  it('allows an address inside a configured range', async () => {
    const { guard } = buildGuard(['203.0.113.0/24']);
    await expect(guard.canActivate(contextFor('203.0.113.9'))).resolves.toBe(true);
  });

  it('refuses an address outside every rule', async () => {
    const { guard } = buildGuard(['203.0.113.0/24']);
    await expect(guard.canActivate(contextFor('8.8.8.8'))).rejects.toThrow(ForbiddenException);
  });

  it('refuses an UNKNOWN address once the list is configured', async () => {
    // Fails closed. An address we cannot read must not be treated as permitted
    // just because we could not identify it.
    const { guard } = buildGuard(['203.0.113.0/24']);
    await expect(guard.canActivate(contextFor(undefined))).rejects.toThrow(ForbiddenException);
  });

  it('normalises an IPv4-mapped IPv6 caller', async () => {
    // Node hands back `::ffff:203.0.113.9` on a dual-stack socket; without
    // normalisation a correctly-configured rule silently never matches.
    const { guard } = buildGuard(['203.0.113.0/24']);
    await expect(guard.canActivate(contextFor('::ffff:203.0.113.9'))).resolves.toBe(true);
  });

  it('leaves the client portal alone', async () => {
    // The portal is public by nature; an allowlist there locks out the customers
    // it exists to serve.
    const { guard, store } = buildGuard(['203.0.113.0/24']);
    await expect(guard.canActivate(contextFor('8.8.8.8', '/v1/auth/login'))).resolves.toBe(true);
    expect(store.listCidrs).not.toHaveBeenCalled();
  });

  it('matches the route, not a literal path, so the /v1 prefix cannot disarm it', async () => {
    // CsrfGuard matched a literal '/admin' and the version prefix silently
    // turned it off for every admin write. Same mistake, same file to avoid it.
    const { guard } = buildGuard(['203.0.113.0/24']);
    await expect(guard.canActivate(contextFor('8.8.8.8', '/v1/admin/withdrawals'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  /**
   * REGRESSION — the allowlist was defeated by one uppercase letter.
   *
   * Express matches routes case-INSENSITIVELY by default and Nest never changes
   * that, while `req.path` hands the guard whatever casing the caller sent. So
   * `GET /v1/Admin/clients` reached the admin controller and returned 200 while
   * `stripApiPrefix(req.path).startsWith('/admin')` evaluated false and this
   * guard returned early. Session cookies are `path: '/'`, so authentication
   * still succeeded: an admin, or anyone holding a stolen admin cookie, got the
   * entire admin surface back from a network this feature exists to deny.
   *
   * The test directly above — "the /v1 prefix cannot disarm it" — passed
   * throughout, because it only ever tried the lowercase spelling. A test that
   * names the bug class but exercises one spelling of it is worse than no test:
   * it is a claim of coverage that is not there.
   */
  it.each(['/V1/ADMIN/clients', '/v1/Admin/clients', '/v1/ADMIN/withdrawals', '/V1/admin/clients'])(
    'refuses an off-list caller on a case-varied admin path: %s',
    async (path) => {
      const { guard, store } = buildGuard(['203.0.113.0/24']);
      await expect(guard.canActivate(contextFor('8.8.8.8', path))).rejects.toThrow(
        ForbiddenException,
      );
      // Not merely "it threw" — it must have consulted the list, i.e. taken the
      // admin branch rather than falling through some other early return.
      expect(store.listCidrs).toHaveBeenCalled();
    },
  );

  it('ignores non-HTTP contexts', async () => {
    const { guard } = buildGuard(['203.0.113.0/24']);
    const rpc = { getType: () => 'rpc' } as never;
    await expect(guard.canActivate(rpc)).resolves.toBe(true);
  });
});

function buildService(rules: AllowlistRule[]) {
  const store = {
    findAll: vi.fn().mockResolvedValue(rules),
    listCidrs: vi.fn().mockResolvedValue(rules.map((r) => r.cidr)),
    create: vi.fn((input: { cidr: string; label: string; createdBy: string }) =>
      Promise.resolve({ id: 'new-rule', createdAt: new Date(), ...input }),
    ),
    delete: vi.fn().mockResolvedValue(rules[0]),
  };
  const audit = { record: vi.fn() };
  const service = new AdminIpAllowlistService(
    store as unknown as AdminIpAllowlistStore,
    audit as unknown as AdminAuditService,
  );
  return { service, store, audit };
}

const rule = (cidr: string, id = cidr): AllowlistRule => ({
  id,
  cidr,
  label: 'test',
  createdBy: 'admin-1',
  createdAt: new Date(),
});

describe('AdminIpAllowlistService — adding', () => {
  it('stores a valid range', async () => {
    const { service, store } = buildService([rule('10.0.0.0/8')]);
    await service.add({ cidr: '203.0.113.0/24', label: 'Office' }, ADMIN, '10.0.0.1');
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ cidr: '203.0.113.0/24' }));
  });

  it('canonicalises before storing', async () => {
    // 10.0.0.5/24 means the 10.0.0.0/24 network. Storing it verbatim would let
    // two spellings of one rule coexist, and removing "the rule" would leave the
    // other in force.
    const { service, store } = buildService([rule('10.0.0.0/8')]);
    await service.add({ cidr: '192.168.1.77/24', label: 'Office' }, ADMIN, '10.0.0.1');
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ cidr: '192.168.1.0/24' }));
  });

  it('refuses a malformed range', async () => {
    const { service } = buildService([rule('10.0.0.0/8')]);
    await expect(
      service.add({ cidr: 'not-an-ip', label: 'Office' }, ADMIN, '10.0.0.1'),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a rule with no label', async () => {
    const { service } = buildService([rule('10.0.0.0/8')]);
    await expect(
      service.add({ cidr: '203.0.113.0/24', label: '   ' }, ADMIN, '10.0.0.1'),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses a duplicate, comparing canonically', async () => {
    const { service } = buildService([rule('192.168.1.0/24')]);
    await expect(
      service.add({ cidr: '192.168.1.99/24', label: 'Again' }, ADMIN, '192.168.1.5'),
    ).rejects.toThrow(ConflictError);
  });

  /**
   * A `/0` is the rule that makes the whole feature lie about itself.
   *
   * It is valid, it canonicalises cleanly, and it passes the lockout check
   * trivially — the author is inside it, because everyone is. But the list then
   * becomes non-empty, so `IpAllowlistGuard` starts "enforcing" and the panel
   * shows a green "Enforced — 1 rule" shield over a control that admits the
   * entire internet. That is worse than an empty list, which says plainly that
   * the protection is off.
   */
  it.each(['0.0.0.0/0', '10.0.0.1/0', '::/0'])(
    'refuses %s — a rule that matches everything',
    async (cidr) => {
      const { service, store } = buildService([]);
      await expect(service.add({ cidr, label: 'Everywhere' }, ADMIN, '8.8.8.8')).rejects.toThrow(
        ValidationError,
      );
      expect(store.create).not.toHaveBeenCalled();
    },
  );

  it('still allows a merely BROAD rule', async () => {
    // The refusal above must not become "no large ranges". A corporate /8 is a
    // legitimate thing to allowlist, and refusing it would push people towards
    // enumerating a hundred /32s that nobody maintains.
    const { service, store } = buildService([]);
    await service.add({ cidr: '10.0.0.0/8', label: 'Corporate' }, ADMIN, '10.4.5.6');
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ cidr: '10.0.0.0/8' }));
  });

  it('LOCKOUT: refuses a FIRST rule that excludes the person adding it', async () => {
    // The single most dangerous moment in the feature. While the list is empty
    // everyone is admitted; the instant this row lands enforcement begins, and
    // if the author is outside it they cannot reach this endpoint to undo it.
    const { service, store } = buildService([]);
    await expect(
      service.add({ cidr: '203.0.113.0/24', label: 'Office' }, ADMIN, '8.8.8.8'),
    ).rejects.toThrow(/first rule/);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('allows a first rule that DOES cover the author', async () => {
    const { service, store } = buildService([]);
    await service.add({ cidr: '203.0.113.0/24', label: 'Office' }, ADMIN, '203.0.113.9');
    expect(store.create).toHaveBeenCalled();
  });

  it('allows a later rule that excludes the author, because others still cover them', async () => {
    // Only the FIRST rule flips enforcement on. Afterwards, adding a branch
    // office you are not sitting in is an ordinary thing to want to do.
    const { service, store } = buildService([rule('10.0.0.0/8')]);
    await service.add({ cidr: '203.0.113.0/24', label: 'Branch' }, ADMIN, '10.0.0.1');
    expect(store.create).toHaveBeenCalled();
  });

  it('audits the addition', async () => {
    const { service, audit } = buildService([rule('10.0.0.0/8')]);
    await service.add({ cidr: '203.0.113.0/24', label: 'Office' }, ADMIN, '10.0.0.1');
    expect(audit.record).toHaveBeenCalledWith(
      ADMIN.id,
      'ip_allowlist.add',
      'ip_allowlist',
      expect.any(String),
      expect.objectContaining({ cidr: '203.0.113.0/24' }),
    );
  });
});

describe('AdminIpAllowlistService — removing', () => {
  it('refuses an id that does not exist', async () => {
    const { service } = buildService([rule('10.0.0.0/8')]);
    await expect(service.remove('nope', ADMIN, '10.0.0.1')).rejects.toThrow(NotFoundError);
  });

  it('LOCKOUT: refuses a removal that would leave the author uncovered', async () => {
    const { service, store } = buildService([rule('10.0.0.0/8', 'a'), rule('203.0.113.0/24', 'b')]);
    // The caller is inside 10.0.0.0/8 and nothing else. Removing it strands them.
    await expect(service.remove('a', ADMIN, '10.0.0.1')).rejects.toThrow(/lose access/);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('allows removing a rule while another still covers the author', async () => {
    const { service, store } = buildService([rule('10.0.0.0/8', 'a'), rule('203.0.113.0/24', 'b')]);
    await service.remove('b', ADMIN, '10.0.0.1');
    expect(store.delete).toHaveBeenCalledWith('b');
  });

  it('allows removing the LAST rule, because that turns enforcement off', async () => {
    // Emptying the list is the documented way to disable the feature, so it must
    // not be blocked by the lockout check — there is no lockout to protect from.
    const { service, store } = buildService([rule('203.0.113.0/24', 'only')]);
    await service.remove('only', ADMIN, '8.8.8.8');
    expect(store.delete).toHaveBeenCalledWith('only');
  });

  it('records that removing the last rule disabled enforcement', async () => {
    // A far bigger event than deleting one row, and the audit trail should say so.
    const { service, audit } = buildService([rule('203.0.113.0/24', 'only')]);
    await service.remove('only', ADMIN, '8.8.8.8');
    expect(audit.record).toHaveBeenCalledWith(
      ADMIN.id,
      'ip_allowlist.remove',
      'ip_allowlist',
      'only',
      expect.objectContaining({ enforcementDisabled: true }),
    );
  });
});
