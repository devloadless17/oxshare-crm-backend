import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyMask, maskedPathsFor, type FieldMask } from '../src/common/security/field-mask';
import { maskByShape } from '../src/common/security/mask-by-shape';
import {
  AdminTransactionRowDto,
  ClientProfileDto,
  ClientRowDto,
  KycAttemptDto,
  KycSubmissionDto,
  TradingAccountRowDto,
  WalletRowDto,
  WithdrawalRowDto,
} from '../src/modules/admin/dto/responses.dto';
import { IbPartnerDetailDto } from '../src/modules/ib/dto/ib-application.dto';

/**
 * THE TWO MECHANISMS REMOVE THE SAME THINGS.
 *
 * `applyMask` strips by PATH from the object that actually exists.
 * `maskByShape` strips what the DECLARED shape says is there.
 *
 * They are equivalent only while every path the catalogue knows is also marked
 * on the DTO — and they were NOT, twice, in ways nothing else caught:
 * `ClientRowDto` omitted `phone` while the API returned it, and
 * `KycSubmissionDto.personalInfo` is a free-form map whose four catalogue keys
 * no declared property could describe.
 *
 * So this is the precondition for deleting `applyMask`, asserted rather than
 * argued. For every resource the catalogue defines, an object is built carrying
 * a value at EVERY path that resource can mask — including inside arrays and
 * free-form maps — and both mechanisms are run over it with the full mask. If
 * the results differ, shape-masking would lose something the path mask removes,
 * and removing the path mask would open exactly that hole.
 *
 * It needs no fixture and no HTTP round trip, which is why it can cover every
 * surface rather than the two that happen to have seeded rows.
 *
 * ## The mapping is a DECLARATION
 *
 * Naming which DTO answers for which catalogue resource is a claim somebody has
 * to make; it cannot be derived, because the catalogue is keyed by response
 * SHAPE and the DTOs are keyed by route. A resource with no entry here is
 * reported rather than skipped — silence would let a whole surface drop out of
 * this check by being forgotten, which is the failure mode of every register in
 * this system.
 */

const CATALOGUE = join(__dirname, '..', 'src', 'config', 'client-fields.json');

/** Every catalogue key and alias, which is what an unrestricted-mask reader hides. */
function everyMaskKey(): FieldMask {
  const catalogue = JSON.parse(readFileSync(CATALOGUE, 'utf8')) as Record<
    string,
    { fields?: { key?: string; maskable?: boolean; aliases?: string[] }[] }
  >;

  const keys = new Set<string>();
  for (const [group, value] of Object.entries(catalogue)) {
    if (group === '$comment' || typeof value !== 'object' || value === null) continue;
    for (const field of value.fields ?? []) {
      if (field.maskable === false) continue;
      if (field.key) keys.add(field.key);
      for (const alias of field.aliases ?? []) keys.add(alias);
    }
  }
  return [...keys];
}

/** Which DTO answers for which catalogue resource. See the note above. */
const SHAPE_FOR: Record<string, unknown> = {
  client: ClientProfileDto,
  kyc: KycSubmissionDto,
  withdrawal: WithdrawalRowDto,
  financial: AdminTransactionRowDto,
  wallet: WalletRowDto,
  tradingAccount: TradingAccountRowDto,
  ibPartner: IbPartnerDetailDto,
};

/**
 * Resources served as a CSV, which an interceptor structurally cannot reach —
 * by the time the response is a byte stream the rows are gone. These keep a
 * row-level call by necessity, so they are outside this equivalence.
 */
const STREAM_ONLY = new Set([
  'withdrawalExport',
  'financialExport',
  'walletExport',
  'tradingAccountExport',
]);

/**
 * Resources whose route declares NO response type, so `maskByShape` has nothing
 * to walk. Listed rather than skipped: each is a surface that must KEEP its
 * path-based call until the route gains a DTO.
 */
const NO_DECLARED_SHAPE = new Set(['tradingAccountCreated']);

/** Set `a.b.c` on a nested object, creating arrays where the DTO declares one. */
function plant(target: Record<string, unknown>, path: string, value: string): void {
  const segments = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    cursor[key] ??= {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}

/** The property names a DTO declares, so a path it never carries is not planted. */
function declaredOn(shape: unknown): Set<string> {
  const names = Reflect.getMetadata(
    'swagger/apiModelPropertiesArray',
    (shape as { prototype: object }).prototype,
  ) as string[] | undefined;
  return new Set((names ?? []).map((name) => name.replace(/^:/, '')));
}

const resourcesInCatalogue = (mask: FieldMask): string[] => [
  ...new Set(mask.filter((key) => key.includes('.')).map((key) => key.slice(0, key.indexOf('.')))),
];

describe('masking by shape removes exactly what masking by path removes', () => {
  const mask = everyMaskKey();

  it('finds a meaningful catalogue, so it cannot pass vacuously', () => {
    expect(mask.length).toBeGreaterThan(30);
    expect(resourcesInCatalogue(mask).length).toBeGreaterThan(5);
  });

  it('names a shape for every resource, or says why it has none', () => {
    /*
     * A resource that is neither mapped nor explicitly excluded would simply
     * not be checked below — and a surface dropping silently out of a coverage
     * test is the failure this whole workstream exists to close.
     */
    const unaccounted = resourcesInCatalogue(mask).filter(
      (resource) =>
        SHAPE_FOR[resource] === undefined &&
        !STREAM_ONLY.has(resource) &&
        !NO_DECLARED_SHAPE.has(resource),
    );

    expect(
      unaccounted,
      'These catalogue resources are neither mapped to a DTO nor declared as ' +
        `stream-only:\n${unaccounted.map((r) => `  ${r}`).join('\n')}`,
    ).toEqual([]);
  });

  for (const [resource, shape] of Object.entries(SHAPE_FOR)) {
    it(`agrees on every path of '${resource}'`, () => {
      const paths = maskedPathsFor(resource, mask);
      expect(paths.length, `the catalogue defines no path for ${resource}`).toBeGreaterThan(0);

      const row: Record<string, unknown> = { id: 'keep-me', untouched: 'keep-me' };
      for (const path of paths) plant(row, path, `SECRET:${path}`);

      const byPath = applyMask(resource, structuredClone(row), mask);
      const byShape = maskByShape(shape, structuredClone(row), mask);

      /*
       * Compared as JSON so a difference reads as the missing FIELD rather than
       * as two object dumps — which one is absent is the whole answer.
       */
      expect(
        JSON.stringify(byShape),
        `masking '${resource}' by shape kept something the path mask removes, so ` +
          `deleting applyMask here would leak it`,
      ).toBe(JSON.stringify(byPath));

      // Non-vacuous, twice over: something was removed, and the rest survived.
      expect(JSON.stringify(byShape)).not.toContain('SECRET:');
      expect((byShape as { id: string }).id).toBe('keep-me');
    });
  }

  it('masks the KYC personal-info map, which has no declared properties at all', () => {
    /*
     * Called out separately because it is the case a DTO cannot describe: the
     * step builder lets an operator add fields, so `personalInfo` is
     * `Record<string, string>` and the walk above finds nothing to recurse
     * into. If `@ClientFieldMap` were ever dropped this would be the only
     * assertion that noticed.
     */
    const row = {
      userId: 'u1',
      personalInfo: { dateOfBirth: 'SECRET', nationality: 'SECRET', firstName: 'Alpha' },
    };
    const masked = maskByShape(KycSubmissionDto, structuredClone(row), mask);

    expect('dateOfBirth' in masked.personalInfo).toBe(false);
    expect('nationality' in masked.personalInfo).toBe(false);
    expect(masked.userId).toBe('u1');
  });

  it('masks an archived KYC attempt the same way as a live submission', () => {
    /*
     * The history panel was the third surface to ship unmasked (20332db); it
     * reuses `kyc`, so it must agree with the submission it archives.
     *
     * Only the paths this shape ACTUALLY carries are planted. An archived
     * attempt has no `user` object — the person is on the submission, not on
     * the snapshot of it — and planting one would test a response that cannot
     * occur, then report the difference as a leak.
     */
    const declared = declaredOn(KycAttemptDto);
    const paths = maskedPathsFor('kyc', mask).filter((path) => declared.has(path.split('.')[0]));
    expect(paths.length, 'nothing to plant — the filter removed everything').toBeGreaterThan(0);

    const row: Record<string, unknown> = { attemptNo: 1 };
    for (const path of paths) plant(row, path, 'SECRET');

    expect(JSON.stringify(maskByShape(KycAttemptDto, structuredClone(row), mask))).not.toContain(
      'SECRET',
    );
    expect(
      (maskByShape(KycAttemptDto, structuredClone(row), mask) as { attemptNo: number }).attemptNo,
    ).toBe(1);
  });

  it('masks a client LIST row the same way as the profile it links to', () => {
    // Two shapes, one catalogue resource: the list was masked before the
    // profile was, and they drifted once already over `phone`.
    const declared = declaredOn(ClientRowDto);
    const paths = maskedPathsFor('client', mask).filter((path) =>
      declared.has(path.split('.')[0]),
    );
    expect(paths.length, 'nothing to plant — the filter removed everything').toBeGreaterThan(0);

    const row: Record<string, unknown> = { id: 'c1' };
    for (const path of paths) plant(row, path, 'SECRET');

    const listed = maskByShape(ClientRowDto, structuredClone(row), mask);
    expect(JSON.stringify(listed)).not.toContain('SECRET');
    expect((listed as { id: string }).id).toBe('c1');
  });
});
