import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, kycConfigSteps, roles } from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';

/**
 * WHAT `GET /admin/kyc-config` RETURNS, `PUT` MUST ACCEPT.
 *
 * The KYC step builder could not save. Not "sometimes", not "for some
 * configurations" — at all, since the document catalogue existed. Every "Save
 * all changes" answered 400 while the screen reported success and nothing
 * persisted.
 *
 * Two halves of one cause, and both were a request DTO that had drifted from the
 * response it is supposed to mirror:
 *
 *   `type`      the store defines a field type as "a base type, or `doc:<value>`
 *               for a document" and SEEDS `doc:passport`, `doc:national_id`,
 *               `doc:driving_license`, `doc:utility_bill`. The request DTO's
 *               `@IsIn` listed the seven BASE types only.
 *   `document`  GET hydrates every document field with `{ value, label,
 *               category, parts[] }`, resolved from `type` and deliberately not
 *               persisted. The global `whitelist` pipe then answered "property
 *               document should not exist" to a client returning exactly what it
 *               had been given.
 *
 * The builder does `steps = draft ?? query.data` with no transform, which is the
 * honest thing for a client to do — so it sent back what it received and was
 * refused every time.
 *
 * ## Why nothing caught it
 *
 * The jsdom page tests mock `api.put`, so the request shape was never checked
 * against the real DTO. `console-pages.spec.ts` loads the screen and asserts it
 * renders. No browser spec clicked Save until one was written for the Domain 1
 * pass, and that is what found it.
 *
 * This is the ROUND TRIP asserted directly, at the layer where the contradiction
 * lived — cheaper than a browser and impossible to satisfy by mocking.
 */

const ADMIN = { email: 'kyc-config-rt@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
let session: Awaited<ReturnType<typeof actingAs>>;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const [role] = await ctx.db.db
    .insert(roles)
    .values({ name: 'KYC Config RT', permissions: ALL_PERMISSIONS })
    .returning();
  await ctx.db.db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await new PasswordService().hash(ADMIN.password),
    name: 'KYC Config RT',
    role: 'sub_admin',
    roleId: role.id,
    permissions: [],
    status: 'active',
  });
  /*
   * SEED THE DEFAULT FLOW. `startHttpTestApp` deliberately does not run the
   * seeds — "a suite states the identities it needs" — and these cases are about
   * the seeded document fields specifically, since `doc:*` is exactly what the
   * request DTO used to refuse.
   */
  await ctx.db.db.insert(kycConfigSteps).values(
    DEFAULT_KYC_STEPS.map((step) => ({
      id: step.id,
      stepNumber: step.stepNumber,
      slug: step.slug,
      title: step.title,
      description: step.description,
      icon: step.icon,
      enabled: step.enabled,
      fields: step.fields as unknown as Record<string, unknown>[],
    })),
  );

  session = await actingAs(ctx, 'admin', ADMIN);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the KYC config round trip', () => {
  it('accepts its own GET back, unchanged — which is all the builder ever sends', async () => {
    const read = await session.get('/v1/admin/kyc-config');
    expect(read.status, `GET answered ${read.status}`).toBe(200);

    const steps = (Array.isArray(read.body) ? read.body : read.body.steps) as unknown[];
    expect(steps.length, 'no steps configured — the round trip would be vacuous').toBeGreaterThan(
      0,
    );

    /*
     * NON-VACUOUS, and this is the assertion that makes the file worth having:
     * the fixture must actually contain a hydrated document field, or a DTO that
     * still rejected `doc:*` would pass this test.
     */
    const fields = steps.flatMap((s) => (s as { fields?: unknown[] }).fields ?? []);
    const docField = fields.find((f) =>
      String((f as { type?: string }).type ?? '').startsWith('doc:'),
    );
    expect(
      docField,
      'the seeded config carries no `doc:*` field, so this cannot prove the DTO accepts one',
    ).toBeDefined();
    expect(
      (docField as { document?: unknown }).document,
      'the GET did not hydrate `document`, so this cannot prove the DTO tolerates it',
    ).toBeDefined();

    const write = await session.put('/v1/admin/kyc-config').send({ steps });
    expect(
      write.status,
      `PUT refused its own GET: ${JSON.stringify(write.body).slice(0, 300)}`,
    ).toBe(200);
  });

  it('persists a REORDER, which is what the builder button does', async () => {
    const read = await session.get('/v1/admin/kyc-config');
    const steps = (Array.isArray(read.body) ? read.body : read.body.steps) as {
      slug: string;
    }[];
    expect(steps.length, 'need two steps to swap').toBeGreaterThan(1);

    const before = steps.map((s) => s.slug);
    const swapped = [steps[1], steps[0], ...steps.slice(2)];

    const write = await session.put('/v1/admin/kyc-config').send({ steps: swapped });
    expect(write.status, `reorder refused: ${JSON.stringify(write.body).slice(0, 200)}`).toBe(200);

    /*
     * RE-READ. A 200 that did not persist is exactly the defect being fixed —
     * the screen said success and the order never moved — so the write's own
     * response cannot be the evidence.
     */
    const after = await session.get('/v1/admin/kyc-config');
    const afterOrder = (
      (Array.isArray(after.body) ? after.body : after.body.steps) as { slug: string }[]
    ).map((s) => s.slug);

    expect(afterOrder, 'the save answered 200 and the order did not move').toEqual([
      before[1],
      before[0],
      ...before.slice(2),
    ]);

    // Leave the config as it was found.
    await session.put('/v1/admin/kyc-config').send({ steps });
  });
});

describe('an empty configuration is refused, and refused BEFORE the delete', () => {
  /*
   * THE FOUR CLICKS THAT DELETE ONBOARDING FOR EVERY CLIENT.
   *
   * `KycConfigStore.setSteps` is a DELETE of every row followed by an INSERT of
   * what it was handed. Given `[]` it performed the DELETE, inserted nothing,
   * and answered 200 — the builder screen deleted its last step, saved, and
   * reported success. Measured before the fix: config 4 steps → 0.
   *
   * What that costs is not a configuration screen looking empty. The wizard has
   * no steps to render, so no client can submit; nothing arrives for a reviewer;
   * and no client can reach a money screen again, because verification cannot be
   * completed. It is silent — every existing approved client is unaffected, so
   * the platform looks entirely normal until the next registration.
   *
   * ## The assertion that matters is the SECOND one
   *
   * A refusal that answers 400 after the DELETE has already run is not a
   * refusal; it is the same outage with a worse status code. So this re-reads
   * the config and requires the steps still to be there. `@ArrayNotEmpty` on the
   * DTO is what makes that true — the pipe rejects the body before the service
   * is entered at all, which is the only place the guarantee costs nothing to be
   * sure about.
   */
  it('REFUSES `PUT { steps: [] }` and leaves the configuration intact', async () => {
    const before = await session.get('/v1/admin/kyc-config');
    expect(before.status).toBe(200);
    const existing = (Array.isArray(before.body) ? before.body : before.body.steps) as unknown[];
    // Non-vacuous: with no steps to lose, an unchanged config proves nothing.
    expect(
      existing.length,
      'no steps configured — this case cannot prove anything',
    ).toBeGreaterThan(0);

    const wipe = await session.put('/v1/admin/kyc-config').send({ steps: [] });

    expect(
      wipe.status,
      `saving an empty step list answered ${wipe.status}. A 200 here deletes ` +
        'onboarding for every client: the wizard renders nothing, nobody can ' +
        'submit, and no client can reach a money screen again.',
    ).toBe(400);

    const after = await session.get('/v1/admin/kyc-config');
    const survived = (Array.isArray(after.body) ? after.body : after.body.steps) as unknown[];
    expect(
      survived.length,
      'the save was refused with a 400 and the steps were deleted anyway — the ' +
        'refusal is landing after setSteps has already run its DELETE',
    ).toBe(existing.length);
  });
});

describe('a step the caller did not name', () => {
  /*
   * A 500 WHERE THE CONTRACT PROMISED A SAVE.
   *
   * `KycStepDto.id` is declared OPTIONAL and `stepNumber` is documented as
   * "server-assigned ordering; ignored on create", so a caller adding a step
   * the way the published shape invites — slug, title, fields, no id — is doing
   * exactly what the DTO asks. `kyc_config_steps.id` is a text primary key with
   * no database default, so `toRow` handed Drizzle `undefined`, the INSERT wrote
   * `default` for a column that has none, and the request answered **500
   * INTERNAL_ERROR** with "an unexpected error occurred".
   *
   * It hid because every caller that exists today happens to carry an id: the
   * builder round-trips what GET gave it, and `addStep` mints its own. The first
   * caller to build a step from nothing was a test, which is the only reason it
   * surfaced at all rather than waiting for the next client of this API.
   *
   * ## The second half is the collision, and it is why this is not one line
   *
   * Deriving the id from the slug is the obvious repair and it is not sufficient
   * on its own: slugs carry no unique constraint, and a payload whose OTHER step
   * already holds the id this one would generate reintroduces the same failed
   * INSERT — more rarely, and therefore worse, because it would ship. So the
   * assignment is de-duplicated against the ids already spoken for in the same
   * request, and this case constructs that collision deliberately rather than
   * trusting the reasoning.
   */
  it('assigns an id, and never one another step in the same payload already holds', async () => {
    const before = await session.get('/v1/admin/kyc-config');
    const original = (Array.isArray(before.body) ? before.body : before.body.steps) as unknown[];

    const field = (id: string) => ({
      id,
      name: 'note',
      label: 'Note',
      type: 'text',
      required: false,
    });

    /*
     * The collision, built on purpose: the FIRST step explicitly claims
     * `step-audit`, which is exactly what the second — slug `audit`, no id —
     * would otherwise be given.
     */
    const write = await session.put('/v1/admin/kyc-config').send({
      steps: [
        { id: 'step-audit', slug: 'other', title: 'Other', enabled: true, fields: [field('f-a')] },
        { slug: 'audit', title: 'Audit', enabled: true, fields: [field('f-b')] },
      ],
    });

    expect(
      write.status,
      `a step with no id answered ${write.status}: ${JSON.stringify(write.body).slice(0, 200)}`,
    ).toBe(200);

    const after = await session.get('/v1/admin/kyc-config');
    const saved = (Array.isArray(after.body) ? after.body : after.body.steps) as {
      id: string;
      slug: string;
    }[];

    expect(
      saved.map((s) => s.slug),
      'the save answered 200 and did not persist',
    ).toEqual(['other', 'audit']);
    const ids = saved.map((s) => s.id);
    expect(ids[0], "the caller's own id was overwritten").toBe('step-audit');
    expect(ids[1], 'the assigned id is empty').toBeTruthy();
    expect(new Set(ids).size, 'two steps were saved under one id').toBe(2);

    // Leave the config as it was found.
    await session.put('/v1/admin/kyc-config').send({ steps: original });
  });
});
