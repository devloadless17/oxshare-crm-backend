import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskedPathsFor, type FieldMask } from '../src/common/security/field-mask';
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
import { CreatedMt5AccountDto } from '../src/modules/trading/mt5/dto/mt5-account.dto';

/**
 * EVERY PATH THE CATALOGUE CAN MASK IS ACTUALLY MARKED ON A SHAPE.
 *
 * Masking is now done in one place — the response interceptor walks a route's
 * declared DTO and removes the fields marked `@ClientField`. That is only
 * complete while every path the CATALOGUE offers an operator has a
 * corresponding mark, and twice it did not, in ways nothing else caught:
 * `ClientRowDto` omitted `phone` while the API returned it, and
 * `KycSubmissionDto.personalInfo` is a free-form map whose four catalogue keys
 * no declared property could describe.
 *
 * The catalogue is what the ROLE EDITOR offers. So a key an operator can tick
 * with no mark behind it is the worst shape this feature has: the console says
 * the field is hidden and the API returns it. This is the assertion that cannot
 * happen — for every resource, an object is built carrying a value at every
 * path that resource can mask, and the shape mask must remove all of them.
 *
 * It was written to license deleting the old path-based `applyMask`, by running
 * both over the same object and requiring identical output. That comparison is
 * gone with the function; what it was really checking — that the marks cover the
 * catalogue — is what remains, and is the part worth keeping running.
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
  /*
   * The create-account response. It sat in `NO_DECLARED_SHAPE` as "a surface
   * that must KEEP its path-based call until the route gains a DTO" — and the
   * route had already gained one, so the exemption excused a shape that was
   * fully covered. Mapping it is the way OFF that list; adding a line to the
   * list is not.
   */
  tradingAccountCreated: CreatedMt5AccountDto,
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
 *
 * EMPTY, and that is the point of keeping the constant. It held
 * `tradingAccountCreated` after `POST /admin/trading-accounts` gained
 * `@ApiOkResponse({ type: CreatedMt5AccountDto })` — so the entry went on
 * excusing a shape that was fully covered, which is the decay this file's
 * sibling `response-shape-coverage.spec.ts` calls "a line that looks like due
 * diligence and protects nothing".
 */
const NO_DECLARED_SHAPE = new Set<string>([]);

/**
 * `client.*` keys whose value lives on ANOTHER record, never on the client
 * profile (D-82). Planting them on `ClientProfileDto` would test a path no
 * response carries; each is checked where it does live instead.
 */
const NOT_A_PROFILE_PATH: Readonly<Record<string, string>> = {
  payoutDestination: "a withdrawal's destination — `withdrawal.`/`financial.destination`, below",
  ipAddress: "a client actor's audit row, applied per row (field-mask-matrix pins it)",
};

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
      const paths = maskedPathsFor(resource, mask).filter(
        (path) => resource !== 'client' || NOT_A_PROFILE_PATH[path] === undefined,
      );
      expect(paths.length, `the catalogue defines no path for ${resource}`).toBeGreaterThan(0);

      const row: Record<string, unknown> = { id: 'keep-me', untouched: 'keep-me' };
      for (const path of paths) plant(row, path, `SECRET:${path}`);

      const byShape = maskByShape(shape, structuredClone(row), mask);

      /*
       * Reported as the surviving PATHS rather than as an object dump: which
       * catalogue key an operator could tick and still be shown is the whole
       * answer, and a diff of two nested objects buries it.
       */
      const survived = paths.filter((path) => JSON.stringify(byShape).includes(`SECRET:${path}`));
      expect(
        survived,
        `The role editor offers these keys on '${resource}' and the shape mask does not ` +
          `remove them — the console would say hidden while the API returns the ` +
          `value:\n${survived.map((p) => `  ${resource}.${p}`).join('\n')}`,
      ).toEqual([]);

      // Non-vacuous: the rest of the row survived, so an emptied response cannot pass.
      expect((byShape as { id: string }).id).toBe('keep-me');
      expect((byShape as { untouched: string }).untouched).toBe('keep-me');
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
    const paths = maskedPathsFor('client', mask).filter((path) => declared.has(path.split('.')[0]));
    expect(paths.length, 'nothing to plant — the filter removed everything').toBeGreaterThan(0);

    const row: Record<string, unknown> = { id: 'c1' };
    for (const path of paths) plant(row, path, 'SECRET');

    const listed = maskByShape(ClientRowDto, structuredClone(row), mask);
    expect(JSON.stringify(listed)).not.toContain('SECRET');
    expect((listed as { id: string }).id).toBe('c1');
  });
});
