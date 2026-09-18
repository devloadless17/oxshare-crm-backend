import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import type { ClientScopeStance } from '../src/modules/admin/guards/client-scope.decorator';
import { collectScopeFacts } from './support/scope-facts';

/**
 * Every admin route states whether it applies the CLIENT SCOPE.
 *
 * Deliberately built the same way as `route-authorization.spec.ts`, because it
 * is the same problem in a second dimension. A scope predicate only runs where
 * somebody remembered to pass the actor's scope, and a route that forgot looks
 * exactly like a route that never needed one — both are just a handler. No
 * reviewer reliably tells them apart in a diff, and missing it once shows a
 * scoped administrator client data they were specifically denied, with nothing
 * failing anywhere.
 *
 * So the rule is inverted: every route below must MAKE A STATEMENT —
 * `@ScopedToClients(...)` naming where the predicate goes, or
 * `@NotClientScoped(...)` saying why there is nothing to scope. A new endpoint
 * with neither fails this test, which fails CI.
 *
 * This file only checks that the statement EXISTS. Whether a route that claims
 * to be scoped actually is, is `client-scope-enforcement.spec.ts` — which
 * derives its inputs from this same metadata, so a route cannot join the
 * "declared scoped" set without also being exercised against a real
 * out-of-scope client.
 */

let app: INestApplication;

interface ScopeFacts {
  signature: string;
  stance?: ClientScopeStance;
  guards: string[];
}

beforeAll(async () => {
  process.env['NODE_ENV'] ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

/**
 * Every route, with the scope stance it declares.
 *
 * DELEGATES to `test/support/scope-facts.ts` rather than implementing the scan.
 * It used to be implemented here and exported, and `client-scope-enforcement
 * .spec.ts` claimed to derive its inputs from it — but it read module-level
 * `discovery` and `reflector` that only THIS file's `beforeAll` assigns, so the
 * import would have thrown and never happened. Taking the app as an argument is
 * what makes one scan serve both specs, which is what the claim always needed.
 */
const scopeFacts = (): ScopeFacts[] => collectScopeFacts(app);

/**
 * The routes this rule governs: the admin surface, plus the one client-PII
 * route that lives outside it.
 *
 * `/uploads/kyc/:file` is deliberately in scope despite its prefix — it serves
 * a client's passport to an administrator, which is exactly the kind of read
 * this feature exists to restrict, and its path would otherwise exempt it.
 */
const GOVERNED = (signature: string) =>
  signature.includes(' /admin') || signature.includes(' /uploads');

describe('every admin route declares a client-scope stance', () => {
  it('sees EVERY route the OpenAPI document sees', () => {
    /*
     * The load-bearing check, and the reason it is first.
     *
     * Every assertion below is "no route has problem X". A scan that silently
     * misses a controller reports a clean bill of health for routes it never
     * looked at — the most dangerous possible failure for a test whose whole
     * job is to notice an unscoped endpoint. Cross-checking against the
     * committed OpenAPI fixture, produced by Nest's own Swagger scanner rather
     * than by this file's reflection, means a disagreement says so out loud.
     */
    const fixture = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'openapi-routes.json'), 'utf8'),
    ) as string[];

    // The fixture is OpenAPI-shaped (`{id}`, `/v1/` prefix); this scan reads
    // Nest's own metadata (`:id`, no global prefix). Normalised the same way
    // `route-authorization.spec.ts` does, so the two specs agree about what a
    // route is called.
    const scanned = new Set(scopeFacts().map((r) => r.signature));
    const missed = fixture
      .map((route) => route.replace(/\{(\w+)\}/g, ':$1').replace(/ \/v1\//, ' /'))
      .filter((sig) => !scanned.has(sig));

    expect(
      missed,
      `This scan did not see these routes, so any conclusion it draws about them is ` +
        `worthless:\n${missed.map((m) => `  ${m}`).join('\n')}`,
    ).toEqual([]);
  });

  it('leaves no governed route without a stance', () => {
    const undeclared = scopeFacts()
      .filter((r) => GOVERNED(r.signature))
      .filter((r) => !r.stance)
      .map((r) => r.signature);

    expect(
      undeclared,
      'These routes are on the admin surface and say nothing about client scoping. ' +
        'Add @ScopedToClients("where the predicate goes") if they read client-owned ' +
        'rows, or @NotClientScoped("why there is nothing to scope") if they do ' +
        `not:\n${undeclared.map((m) => `  ${m}`).join('\n')}`,
    ).toEqual([]);
  });

  it('requires a real sentence on every exemption', () => {
    /*
     * The same rule PUBLIC_ROUTES uses, for the same reason: an exemption list
     * with "n/a" in it is an exemption list nobody reviews. A reason long
     * enough to be a sentence is one somebody had to think about.
     */
    const thin = scopeFacts()
      .filter((r) => GOVERNED(r.signature) && r.stance?.stance === 'none')
      .filter((r) => (r.stance?.note.length ?? 0) < 30)
      .map((r) => `${r.signature} — "${r.stance?.note ?? ''}"`);

    expect(thin, `These exemptions do not explain themselves:\n${thin.join('\n')}`).toEqual([]);
  });

  it('requires a scoped route to say WHERE the predicate goes', () => {
    // "This is scoped" is a claim. Naming the store method and the column is
    // what lets a reviewer check it without reading the whole service.
    const vague = scopeFacts()
      .filter((r) => r.stance?.stance === 'scoped')
      .filter((r) => (r.stance?.note.length ?? 0) < 30)
      .map((r) => r.signature);

    expect(vague, `These claim to be scoped without saying how:\n${vague.join('\n')}`).toEqual([]);
  });

  it('finds a meaningful number of scoped routes, so it cannot pass vacuously', () => {
    // The R-4.2 lesson again: if the reflection breaks, every "no route has
    // problem X" assertion above passes by examining nothing.
    const scoped = scopeFacts().filter((r) => r.stance?.stance === 'scoped');
    expect(scoped.length).toBeGreaterThanOrEqual(10);
  });

  /**
   * The audit log is SCOPED now — D-54, resolved (owner, 13 Aug 2026).
   *
   * The history matters enough to keep: the route's exemption once rested on
   * `MasterAdminGuard` (only unrestricted masters could read it), then on a
   * `@NotClientScoped` note claiming "the subjects are admin ids" — which was
   * mostly true and exactly wrong for the KYC and tag rows, whose subject is
   * the CLIENT's own id. A tag-scoped sub-admin holding `audit.view` could
   * read decisions about clients outside their territory. This test used to
   * be the honest record of that gap; it is now the pin on its closure.
   *
   * What is asserted: both audit reads declare `@ScopedToClients` (the store
   * filters client-subject rows by the reader's scope, in the WHERE clause)
   * and stay permission-gated. The behavioural half — in-scope visible,
   * out-of-scope hidden, admin rows untouched, export matching the list —
   * lives in `audit-log-http.spec.ts` against real Postgres.
   */
  it('scopes the audit log’s client-subject rows, and keeps it permission-gated', () => {
    const scopedNow = ['GET /admin/audit-log', 'GET /admin/audit-log/export'];
    const facts = scopeFacts();

    for (const signature of scopedNow) {
      const route = facts.find((r) => r.signature === signature);
      expect(route, `${signature} is gone — update this list or restore the route`).toBeDefined();
      expect(
        route?.stance?.stance,
        `${signature} lost its @ScopedToClients declaration — D-54's exposure is back`,
      ).toBe('scoped');
      expect(route?.guards, `${signature} must stay permission-gated`).toContain(
        'PermissionsGuard',
      );
    }
  });
});
