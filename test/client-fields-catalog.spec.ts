import { describe, expect, it } from 'vitest';
import { ClientFieldsService } from '../src/modules/admin/client-fields.service';
import { ValidationError } from '../src/common/errors/domain-errors';
import { ClientRowDto } from '../src/modules/admin/dto/responses.dto';

/**
 * `config/client-fields.json` — RBAC-03's vocabulary.
 *
 * The tests that matter here are the two COVERAGE ones, and they exist because
 * masking has two silent ways to be a lie:
 *
 *   1. A PII field the catalog does not mention cannot be hidden by anybody,
 *      and nothing says so. An operator ticks every box on the screen and the
 *      one field they actually cared about was never offered.
 *   2. A field hidden on the client list but reachable under a different name
 *      on the KYC screen is a bypass that consists of clicking a tab.
 *
 * Both are the kind of gap that opens by ADDITION — someone adds a column to a
 * DTO and does not think about masking — so they are asserted from the DTO and
 * the catalog rather than from a hand-written list that would need the same
 * discipline it is meant to replace.
 */

const service = new ClientFieldsService();

describe('catalog shape', () => {
  it('loads and exposes groups of fields', () => {
    const catalog = service.getCatalog();
    expect(Object.keys(catalog).length).toBeGreaterThan(0);
    for (const [name, group] of Object.entries(catalog)) {
      expect(group.groupName, `${name} has no groupName`).toBeTruthy();
      expect(Array.isArray(group.fields), `${name}.fields is not an array`).toBe(true);
    }
  });

  it('does not expose $comment as a group', () => {
    // The file carries its reasoning inline. Leaking that into the API would
    // put a group with no fields on the admin screen.
    expect(service.getCatalog()).not.toHaveProperty('$comment');
    expect(service.definitions().every((f) => typeof f.key === 'string')).toBe(true);
  });

  it('uses path-qualified keys, never bare field names', () => {
    /*
     * A flat `country` is ambiguous between `users.country` and the country
     * inside a KYC submission's personal_info JSON. Masking one while leaking
     * the other is not masking, and a flat key makes that the DEFAULT outcome
     * rather than a mistake somebody has to make.
     */
    for (const field of service.definitions()) {
      expect(field.key, `${field.key} is not path-qualified`).toMatch(/^[a-z]+\./);
    }
  });

  it('gives every unmaskable field a reason', () => {
    // "You cannot hide this" with no explanation reads as a bug. The reason is
    // surfaced verbatim in the error and on the screen.
    for (const field of service.definitions().filter((f) => !f.maskable)) {
      expect(field.reason, `${field.key} is unmaskable with no reason`).toBeTruthy();
    }
  });
});

describe('COVERAGE — every client PII field is in the catalog', () => {
  /**
   * Read from the DTO itself, so adding a column to the client list forces a
   * decision about masking it.
   *
   * `ClientRowDto` is a class with no runtime properties until instantiated, so
   * the field list is taken from Swagger's metadata — the same source the
   * generated frontend types come from, which is what makes this an assertion
   * about the actual wire shape rather than about a source file.
   */
  function clientRowFields(): string[] {
    const meta = (
      ClientRowDto.prototype as unknown as {
        constructor: { _OPENAPI_METADATA_FACTORY?: () => Record<string, unknown> };
      }
    ).constructor._OPENAPI_METADATA_FACTORY?.();
    // Without the Nest CLI's swagger plugin there is no metadata factory; fall
    // back to the decorated keys, which `@ApiProperty` records on the prototype.
    if (meta) return Object.keys(meta);
    return Object.keys(
      (
        Reflect.getMetadata('swagger/apiModelPropertiesArray', ClientRowDto.prototype) as
          string[] | undefined
      )?.reduce<Record<string, true>>((acc, k) => ({ ...acc, [k.replace(/^:/, '')]: true }), {}) ??
        {},
    );
  }

  it('names every field the client list actually returns', () => {
    const known = new Set(service.definitions().map((f) => f.key));
    const fields = clientRowFields();

    // The reflection above is best-effort across build configurations. If it
    // finds nothing, this test would pass vacuously — which is the failure mode
    // every coverage test has to rule out explicitly.
    expect(
      fields.length,
      'could not read ClientRowDto fields — this test would pass vacuously',
    ).toBeGreaterThan(0);

    const missing = fields.filter((name) => !known.has(`client.${name}`));
    expect(
      missing,
      `These ClientRowDto fields are not in config/client-fields.json, so no role can hide ` +
        `them and nothing says so: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});

describe('COVERAGE — the KYC screen is not a bypass', () => {
  /**
   * THE ONE THAT CLOSES THE HOLE.
   *
   * `GET /admin/kyc/:userId` returns the same person's name, email, phone and
   * country under `personalInfo.*`. Hide `client.phone` without an alias and
   * the number is still one tab away, on a screen the same permission set
   * reaches. The feature would be decorative, and would LOOK configured.
   */
  it('gives every identifying client field a kyc counterpart', () => {
    const definitions = service.definitions();
    const allKeys = new Set(definitions.map((f) => f.key));

    // The fields that also exist inside a KYC submission's personal_info.
    const alsoOnKyc = ['firstName', 'lastName', 'email', 'phone', 'country'];

    for (const name of alsoOnKyc) {
      const field = definitions.find((f) => f.key === `client.${name}`);
      if (!field || !field.maskable) continue;

      const counterpart = `kyc.personalInfo.${name}`;
      const covered = (field.aliases ?? []).includes(counterpart) || allKeys.has(counterpart);

      expect(
        covered,
        `Masking ${field.key} would not hide ${counterpart}, so the KYC review screen ` +
          `leaks it. Add "${counterpart}" to that field's aliases.`,
      ).toBe(true);
    }
  });

  it('expands a stored key into its aliases', () => {
    const expanded = service.expand(['client.phone']);
    expect(expanded).toContain('client.phone');
    expect(expanded).toContain('kyc.personalInfo.phone');
  });

  it('drops an unknown stored key instead of failing the request', () => {
    // `expand` runs on every authenticated admin request. A key removed from
    // the catalog while still stored on a role must degrade to "not masked any
    // more", never to "this administrator cannot log in".
    expect(service.expand(['client.gone'])).toEqual([]);
    expect(service.expand([])).toEqual([]);
  });
});

describe('assertMaskable', () => {
  it('accepts a maskable key', () => {
    expect(() => service.assertMaskable(['client.email'])).not.toThrow();
  });

  it('rejects an unknown key, pointing at the catalog endpoint', () => {
    expect(() => service.assertMaskable(['client.nope'])).toThrow(ValidationError);
    expect(() => service.assertMaskable(['client.nope'])).toThrow(/client-fields/);
  });

  it('rejects a known but unmaskable key, and repeats the reason', () => {
    // A different failure calling for a different fix, so a different message.
    // `client.status` drives suspend/reactivate decisions; hiding it would make
    // an admin act blind rather than merely see less.
    expect(() => service.assertMaskable(['client.status'])).toThrow(ValidationError);
    expect(() => service.assertMaskable(['client.status'])).toThrow(/cannot be hidden/);
  });

  it('rejects the id, which every row and link is addressed by', () => {
    expect(() => service.assertMaskable(['client.id'])).toThrow(ValidationError);
  });
});
