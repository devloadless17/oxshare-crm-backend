import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { AUDIT_KEY, type AuditStance } from '../src/modules/admin/guards/audited.decorator';
import { AUDIT_ACTIONS, AUDIT_ACTION_KEYS } from '../src/modules/admin/audit-actions.catalog';

/**
 * Every administrative action that CHANGES something is recorded.
 *
 * FSD §10 requires "attributable, reviewable records of administrative
 * actions". DECISIONS D-21 explains why it was built before anything asked for
 * it: the audit log is the one thing in this system that cannot be
 * reconstructed afterwards. A permission can be re-derived from the current
 * state; "who changed the rejection reason clients are shown, and when" cannot.
 *
 * Coverage was good and incomplete, in the way coverage always is when it
 * depends on remembering — and the gaps were the routes that do not LOOK like
 * money: rejection reasons, the KYC form definition, the download links served
 * to clients. All three change what happens to clients' money or identity
 * documents, and all three could be rewritten leaving no trace.
 *
 * So the rule is inverted, exactly as `route-authorization.spec.ts` inverts the
 * permission rule and `client-scope-coverage.spec.ts` inverts the scope one.
 * Every mutating admin route must STATE whether it records. Saying nothing
 * fails CI.
 */

let app: INestApplication;
let discovery: DiscoveryService;
let reflector: Reflector;

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.ALL]: 'ALL',
};

/** The verbs that change something. A GET is governed by R-6.6 instead. */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface AuditFacts {
  signature: string;
  stance?: AuditStance;
}

beforeAll(async () => {
  process.env['NODE_ENV'] ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  discovery = app.get(DiscoveryService);
  reflector = app.get(Reflector);
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const normalise = (p: string) => (p === '/' || p === '' ? '' : `/${p.replace(/^\/|\/$/g, '')}`);
const joinPath = (prefix: string, path: string) => `${prefix}${path}` || '/';

function pathsOf(raw: unknown): string[] {
  if (typeof raw === 'string') return [normalise(raw)];
  if (Array.isArray(raw)) return raw.flatMap((entry) => pathsOf(entry));
  if (raw && typeof raw === 'object' && 'path' in raw) return pathsOf(raw.path);
  return [''];
}

function auditFacts(): AuditFacts[] {
  const scanner = new MetadataScanner();
  const found: AuditFacts[] = [];

  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    const controllerClass = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
    if (!instance || !controllerClass) continue;

    const prefixes = pathsOf(Reflect.getMetadata(PATH_METADATA, controllerClass));
    const prototype = Object.getPrototypeOf(instance) as object;

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = instance[methodName] as ((...args: never[]) => unknown) | undefined;
      if (!handler) continue;
      const raw = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      if (raw === undefined) continue;

      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
      for (const prefix of prefixes) {
        for (const path of pathsOf(raw)) {
          found.push({
            signature: `${METHOD_NAMES[method]} ${joinPath(prefix, path)}`,
            stance: reflector.get<AuditStance>(AUDIT_KEY, handler),
          });
        }
      }
    }
  }
  return found;
}

const governed = (r: AuditFacts) =>
  r.signature.includes(' /admin') && MUTATING.has(r.signature.split(' ')[0]);

describe('every mutating admin action declares whether it is recorded', () => {
  it('sees EVERY route the OpenAPI document sees', () => {
    // The load-bearing check. A scan that silently misses a controller reports
    // a clean bill of health for routes it never looked at — which, for a test
    // whose job is to notice an unrecorded action, is the worst failure it can
    // have. Cross-checked against the fixture Nest's own Swagger scanner
    // produces, so a disagreement says so instead of passing quietly.
    const fixture = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'openapi-routes.json'), 'utf8'),
    ) as string[];

    const scanned = new Set(auditFacts().map((r) => r.signature));
    const missed = fixture
      .map((route) => route.replace(/\{(\w+)\}/g, ':$1').replace(/ \/v1\//, ' /'))
      .filter((sig) => !scanned.has(sig));

    expect(
      missed,
      `This scan did not see these routes:\n${missed.map((m) => `  ${m}`).join('\n')}`,
    ).toEqual([]);
  });

  it('leaves no mutating admin route without a stance', () => {
    const undeclared = auditFacts()
      .filter(governed)
      .filter((r) => !r.stance)
      .map((r) => r.signature);

    expect(
      undeclared,
      'These routes change something and say nothing about being recorded. On a money ' +
        'system the audit log is the one record that cannot be rebuilt afterwards ' +
        '(DECISIONS D-21). Add @Audited("the.action.name") or @NotAudited("why not") ' +
        `to each:\n${undeclared.map((m) => `  ${m}`).join('\n')}`,
    ).toEqual([]);
  });

  it('requires a real sentence on every exemption', () => {
    const thin = auditFacts()
      .filter((r) => governed(r) && r.stance?.stance === 'none')
      .filter((r) => (r.stance?.note.length ?? 0) < 30)
      .map((r) => `${r.signature} — "${r.stance?.note ?? ''}"`);

    expect(thin, `These exemptions do not explain themselves:\n${thin.join('\n')}`).toEqual([]);
  });

  it('names a dotted action on every audited route', () => {
    // `@Audited('yes')` would satisfy a bare presence check while telling a
    // reader nothing. The declared value is the one written to
    // `audit_log.action`, so it has to look like one.
    const vague = auditFacts()
      .filter((r) => r.stance?.stance === 'audited')
      .filter((r) => !/^[a-z_]+\.[a-z_.]+$/.test(r.stance?.note ?? ''))
      .map((r) => `${r.signature} — "${r.stance?.note ?? ''}"`);

    expect(vague, `These do not name a valid action:\n${vague.join('\n')}`).toEqual([]);
  });

  it('finds a meaningful number of audited routes, so it cannot pass vacuously', () => {
    const audited = auditFacts().filter((r) => r.stance?.stance === 'audited');
    expect(audited.length).toBeGreaterThanOrEqual(20);
  });
});

/**
 * The action FILTER offers every action the system can record.
 *
 * The admin screen hardcoded eight while the system recorded thirty-four, so
 * everything added because it had previously gone unrecorded was ALSO
 * unfilterable — which is to say precisely the actions somebody would come
 * looking for: who reworded the rejection reason a client was emailed, who
 * disabled a KYC step, who repointed a download link.
 *
 * A filter that silently offers a subset is the same defect as a silently
 * ignored query parameter (R-2.5). An operator reads "no results for Rejection
 * Reason Update" as "that never happened", when the truth is that they could
 * not ask.
 *
 * This is the mechanism that stops it happening again: the catalog is derived
 * from nothing, so it can only be kept honest by a test that reads the
 * DECORATORS and demands every one of them be labelled.
 */
describe('the audit action catalog covers what the routes declare', () => {
  it('labels every @Audited action', () => {
    const declared = auditFacts()
      .filter((r) => r.stance?.stance === 'audited')
      .map((r) => r.stance?.note ?? '');

    const missing = [...new Set(declared)].filter((action) => !AUDIT_ACTION_KEYS.has(action));

    expect(
      missing,
      'These actions are recorded but absent from AUDIT_ACTIONS, so the audit screen ' +
        'cannot filter for them — and an operator reads "no results" as "it never ' +
        `happened":\n${missing.map((m) => `  ${m}`).join('\n')}`,
    ).toEqual([]);
  });

  it('finds actions to check, so this cannot pass vacuously', () => {
    const declared = auditFacts().filter((r) => r.stance?.stance === 'audited');
    expect(declared.length).toBeGreaterThanOrEqual(20);
  });

  it('has no duplicate keys', () => {
    // A duplicate renders twice in the filter and reads as two different things.
    const keys = AUDIT_ACTIONS.map((entry) => entry.action);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('groups every entry, so a 30-item filter stays readable', () => {
    const ungrouped = AUDIT_ACTIONS.filter((entry) => !entry.group).map((e) => e.action);
    expect(ungrouped).toEqual([]);
  });
});
