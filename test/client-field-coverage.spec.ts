import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import {
  clientFieldMapOthersOf,
  clientFieldMapsOf,
  clientFieldsOf,
  noClientFieldsReason,
  notClientFieldsOf,
} from '../src/common/security/client-field.decorator';

/**
 * EVERY SHAPE AN ADMIN CAN READ SAYS WHOSE DATA IT HOLDS.
 *
 * ## Why this exists, and why it is not the register that was rejected
 *
 * The response interceptor masks by walking a route's declared shape, so it can
 * only remove what a field has been MARKED as. That marking is opt-in, which is
 * one level down from the property that has failed nine times — nothing fails
 * when a client-shaped field ships unannotated.
 *
 * A route-level masking stance was tried first and abandoned: it restated what
 * the DTO already says, in 170 hand-written sentences that would rot. A FIELD
 * level statement restates nothing. "Whose data is this?" is genuinely not
 * derivable from the shape — `credentialsSentTo: string` is indistinguishable
 * from `reference: string`, and that was the ninth exposure, found by hand
 * because no heuristic over names could see it.
 *
 * ## The shape of the rule
 *
 * A class reachable from an admin response either:
 *   - carries `@NoClientFields(reason)` — it describes no person at all; or
 *   - states every one of its own fields, with `@ClientField`, `@ClientFieldMap`
 *     or `@NotClientField(reason)`.
 *
 * 97 classes take the one-line exemption — currencies, roles, products, levels,
 * settings, stats. The judgement concentrates in the handful that describe a
 * person, which is where it belongs.
 *
 * ## The exemption is the part that can rot, so it is the part that is guarded
 *
 * `@NoClientFields` is true of the class AS WRITTEN. Somebody appends `email` to
 * an exempt configuration shape six weeks from now and the declaration is
 * quietly false. Two guards below:
 *
 *   1. an exempt class may not REFERENCE a class carrying marked fields. At
 *      runtime the walker recurses and the child's own marks still apply, so
 *      this is a false STATEMENT rather than a leak — it becomes a leak the
 *      moment somebody reads the exemption and trusts it.
 *
 *   2. an exempt class may not carry a person-ish field NAME. This reuses the
 *      very heuristic that was too weak to be a boundary, and the reuse is the
 *      point: as a boundary a false negative leaves a surface ungoverned, but as
 *      a guard on an exemption it merely leaves one class wrongly exempt — no
 *      worse than not checking. Same names, opposite consequence, because the
 *      direction of the error changed.
 */

let app: INestApplication;

beforeAll(async () => {
  process.env['NODE_ENV'] ??= 'test';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const API_RESPONSE = 'swagger/apiResponse';
const SWAGGER_PROPERTIES = 'swagger/apiModelProperties';
const SWAGGER_PROPERTY_LIST = 'swagger/apiModelPropertiesArray';

type Ctor = new (...args: never[]) => unknown;

/** The declared property names on a DTO class, as Swagger recorded them. */
function propertiesOf(type: Ctor): string[] {
  const names = Reflect.getMetadata(SWAGGER_PROPERTY_LIST, type.prototype as object) as
    string[] | undefined;
  return (names ?? []).map((name) => name.replace(/^:/, ''));
}

/** The class behind a property, following `@ApiProperty({ type })` then the emitted type. */
function childTypeOf(type: Ctor, property: string): Ctor | undefined {
  const declared = Reflect.getMetadata(SWAGGER_PROPERTIES, type.prototype as object, property) as
    { type?: unknown } | undefined;

  let candidate: unknown = declared?.type;
  if (typeof candidate === 'function' && !(candidate as { prototype?: unknown }).prototype) {
    candidate = (candidate as () => unknown)();
  }
  if (Array.isArray(candidate)) candidate = candidate[0];
  if (typeof candidate !== 'function') {
    candidate = Reflect.getMetadata('design:type', type.prototype as object, property);
  }
  if (typeof candidate !== 'function') return undefined;
  const ctor = candidate as Ctor;
  // Built-ins are not shapes: String, Number, Boolean, Date, Array, Object.
  return propertiesOf(ctor).length > 0 || clientFieldsOf(ctor).size > 0 ? ctor : undefined;
}

/** Every DTO class reachable from an admin route's declared response. */
function reachableShapes(): Map<string, Ctor> {
  const discovery = app.get(DiscoveryService);
  const scanner = new MetadataScanner();
  const found = new Map<string, Ctor>();
  const frontier: Ctor[] = [];

  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    const controllerClass = wrapper.metatype as Ctor | undefined;
    if (!instance || !controllerClass) continue;

    const prefix = String(Reflect.getMetadata(PATH_METADATA, controllerClass) ?? '');
    if (!prefix.startsWith('admin') && !prefix.startsWith('uploads')) continue;

    const prototype = Object.getPrototypeOf(instance) as object;
    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = instance[methodName];
      if (typeof handler !== 'function') continue;
      const responses = Reflect.getMetadata(API_RESPONSE, handler) as
        Record<string, { type?: unknown }> | undefined;
      if (!responses) continue;

      for (const [status, response] of Object.entries(responses)) {
        if (!status.startsWith('2')) continue;
        let type: unknown = response?.type;
        if (typeof type === 'function' && !(type as { prototype?: unknown }).prototype) {
          type = (type as () => unknown)();
        }
        if (Array.isArray(type)) type = type[0];
        if (typeof type === 'function') frontier.push(type as Ctor);
      }
    }
  }

  while (frontier.length > 0) {
    const type = frontier.pop()!;
    if (found.has(type.name)) continue;
    found.set(type.name, type);
    for (const property of propertiesOf(type)) {
      const child = childTypeOf(type, property);
      if (child && !found.has(child.name)) frontier.push(child);
    }
  }
  return found;
}

/**
 * Names that suggest a person.
 *
 * Too weak to decide WHICH fields are client-owned — it misses
 * `credentialsSentTo` — and used here only to challenge an exemption, where a
 * miss costs nothing and a hit is always worth reading.
 */
const PERSONISH =
  /email|firstname|lastname|phone|country|address|birth|national|personalinfo|credentials|motivation|website/i;

describe('every admin-reachable shape says whose data it holds', () => {
  it('reaches a meaningful number of shapes, so it cannot pass vacuously', () => {
    // If the scan breaks, every "no class has problem X" assertion below passes
    // by examining nothing at all — the R-4.2 lesson, again.
    expect(reachableShapes().size).toBeGreaterThan(80);
  });

  it('leaves no shape without a statement', () => {
    const silent: string[] = [];

    for (const [name, type] of reachableShapes()) {
      if (noClientFieldsReason(type) !== undefined) continue;

      const stated = new Set([
        ...clientFieldsOf(type).keys(),
        ...clientFieldMapsOf(type).keys(),
        ...notClientFieldsOf(type).keys(),
      ]);
      const unstated = propertiesOf(type).filter((property) => !stated.has(property));
      if (unstated.length > 0) silent.push(`${name}: ${unstated.join(', ')}`);
    }

    expect(
      silent,
      'These fields are reachable from an admin response and say nothing about whose ' +
        'data they are. Mark each with @ClientField(key) / @ClientFieldMap(prefix), or ' +
        '@NotClientField(reason) — or put @NoClientFields(reason) on the class if it ' +
        `describes no person at all:\n${silent.map((s) => `  ${s}`).join('\n')}`,
    ).toEqual([]);
  });

  it('requires a real sentence on every exemption', () => {
    const thin: string[] = [];
    for (const [name, type] of reachableShapes()) {
      const reason = noClientFieldsReason(type);
      if (reason !== undefined && reason.length < 30) thin.push(`${name} — "${reason}"`);
      for (const [property, reason2] of notClientFieldsOf(type)) {
        if (reason2.length < 30) thin.push(`${name}.${property} — "${reason2}"`);
      }
    }
    expect(thin, `These exemptions do not explain themselves:\n${thin.join('\n')}`).toEqual([]);
  });

  it('GUARD 1 — an exempt class may not reference one carrying client fields', () => {
    /*
     * The exemption is a claim about the whole subtree. A class can hold no
     * client field of its own and embed one that does, and then the sentence is
     * false even though nothing leaks — the walker still applies the child's
     * marks. It becomes a leak the moment somebody reads the exemption and
     * trusts it, which is what an exemption is for.
     */
    const lying: string[] = [];
    for (const [name, type] of reachableShapes()) {
      if (noClientFieldsReason(type) === undefined) continue;
      for (const property of propertiesOf(type)) {
        const child = childTypeOf(type, property);
        if (!child) continue;
        if (clientFieldsOf(child).size > 0 || clientFieldMapsOf(child).size > 0) {
          lying.push(`${name}.${property} -> ${child.name}`);
        }
      }
    }
    expect(
      lying,
      'These classes claim to hold no client data while embedding a shape that does. ' +
        `Remove @NoClientFields and state the fields:\n${lying.map((s) => `  ${s}`).join('\n')}`,
    ).toEqual([]);
  });

  it('GUARD 2 — an exempt class may not carry a person-ish field name', () => {
    /*
     * The tripwire. Somebody appends `email` to an exempt configuration shape
     * and the declaration silently stops being true; nothing else would notice,
     * because there is no field-level statement on an exempt class to go stale.
     */
    const suspicious: string[] = [];
    for (const [name, type] of reachableShapes()) {
      if (noClientFieldsReason(type) === undefined) continue;
      const hits = propertiesOf(type).filter((property) => PERSONISH.test(property));
      if (hits.length > 0) suspicious.push(`${name}: ${hits.join(', ')}`);
    }
    expect(
      suspicious,
      'These classes are exempted as holding no client data, but carry a field whose ' +
        'name suggests a person. Either the exemption is stale or the field needs a ' +
        `statement:\n${suspicious.map((s) => `  ${s}`).join('\n')}`,
    ).toEqual([]);
  });

  it('names a catalogue key that exists, so a marking cannot be a typo', () => {
    /*
     * `maskedPathsFor` filters the reader's mask by prefix, so a key nothing is
     * ever prefixed with matches nothing and the marking is a silent no-op —
     * indistinguishable in review from a field that is correctly masked.
     */
    const catalogue = JSON.parse(
      readFileSync(join(__dirname, '..', 'src', 'config', 'client-fields.json'), 'utf8'),
    ) as Record<string, { fields?: { key?: string; aliases?: string[] }[] }>;

    const known = new Set<string>();
    for (const [group, value] of Object.entries(catalogue)) {
      if (group === '$comment' || typeof value !== 'object' || value === null) continue;
      for (const field of value.fields ?? []) {
        if (field.key) known.add(field.key);
        for (const alias of field.aliases ?? []) known.add(alias);
      }
    }
    // A map declares a PREFIX; its keys are whatever the operator configured.
    const prefixes = new Set([...known].map((key) => key.slice(0, key.lastIndexOf('.'))));

    const unknown: string[] = [];
    for (const [name, type] of reachableShapes()) {
      for (const [property, key] of clientFieldsOf(type)) {
        if (!known.has(key)) unknown.push(`${name}.${property} -> ${key}`);
      }
      for (const [property, prefix] of clientFieldMapsOf(type)) {
        if (!prefixes.has(prefix)) unknown.push(`${name}.${property} -> ${prefix}.*`);
      }
      // The key that hides a map's unnamed entries must exist too, or those
      // entries — a broker's own questions — are unmaskable again.
      for (const [property, rule] of clientFieldMapOthersOf(type)) {
        if (!known.has(rule.others)) unknown.push(`${name}.${property} (others) -> ${rule.others}`);
      }
    }
    expect(
      unknown,
      `These name a catalogue key that does not exist, which makes the marking a ` +
        `no-op:\n${unknown.map((s) => `  ${s}`).join('\n')}`,
    ).toEqual([]);
  });
});

describe('no field claims to be both client-owned and not', () => {
  it('refuses a property carrying @ClientField AND @NotClientField', () => {
    /*
     * Thirty-eight properties did. Each paired a REAL catalogue key —
     * `client.email`, `client.phone`, `client.country`, `client.createdAt` —
     * with templated boilerplate reading "not a client-owned attribute — email
     * describes the record rather than the person". Five more carried the same
     * `@NotClientField` twice.
     *
     * ## Why it passed everything
     *
     * The two decorators write DISJOINT metadata keys, `maskByShape` consults
     * only the first, and the coverage census above unions all three maps to ask
     * whether a field said *anything*. So masking worked, every suite was green,
     * and each of those fields simultaneously asserted two opposite facts about
     * itself.
     *
     * ## Why that is worth a test rather than a tidy-up
     *
     * The failure is a future one. Anybody deleting the `@ClientField` on the
     * strength of the sentence beside it — which is what a `@NotClientField`
     * reason is FOR — silently unmasks a client's email address, with a green
     * build and nothing in the diff that looks wrong. The contradiction is the
     * bug; the masking still working is what makes it invisible.
     *
     * The `@ClientField` was authoritative in all thirty-eight: every key named
     * one that really exists in `client-fields.json`, which is what settled
     * which half to delete.
     */
    const contradictory: string[] = [];

    for (const [name, type] of reachableShapes()) {
      const owned = new Set(clientFieldsOf(type).keys());
      for (const property of notClientFieldsOf(type).keys()) {
        if (owned.has(property)) contradictory.push(`${name}.${property}`);
      }
    }

    expect(
      contradictory,
      'These properties are marked @ClientField AND @NotClientField. Both cannot be true, ' +
        'and masking silently honours the first — so the second is a sentence that will one ' +
        'day persuade somebody to delete the mark that does the work:\n' +
        contradictory.map((c) => `  ${c}`).join('\n'),
    ).toEqual([]);
  });
});
