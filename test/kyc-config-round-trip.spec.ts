import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq, inArray, sql } from 'drizzle-orm';
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

/**
 * THE PER-STEP ROUTES COULD NEVER SUCCEED.
 *
 * `PUT` and `DELETE /admin/kyc-config/steps/:id` both parsed the id with
 * `UuidParam`. `kyc_config_steps.id` is a `text` column that has never held a
 * bare uuid: the defaults are `step-1`…`step-4` and `addStep` mints
 * `step-<uuid>`. So both routes answered 400 `must be a UUID` for every id that
 * can exist — a step could be created through its own API and then never
 * updated or deleted through it.
 *
 * Nothing caught it because the builder screen does not use these routes. It
 * saves the whole form through `PUT /admin/kyc-config`, which takes no id, so
 * the console worked while two documented endpoints were dead. The tests above
 * exercise exactly that working path, which is why they were green throughout.
 *
 * Found by a Playwright spec whose CLEANUP used the delete route — the test
 * body passed and the teardown could not undo it.
 */
describe('the per-step config routes', () => {
  it('updates and deletes a step created through the API', async () => {
    const created = await session.post('/v1/admin/kyc-config/steps').send({
      slug: 'per-step-route',
      title: 'Per Step Route',
      enabled: true,
      fields: [{ id: 'f-q', name: 'q', label: 'Q', type: 'text', required: false }],
    });
    expect(created.status, `add refused: ${JSON.stringify(created.body).slice(0, 200)}`).toBe(201);
    const id = (created.body as { id: string }).id;

    /*
     * NON-VACUOUS: if ids ever become bare uuids this assertion fails loudly
     * rather than letting the case pass for the wrong reason — a uuid id would
     * satisfy the old pipe too, and the test would prove nothing.
     */
    expect(id, 'a step id is a text key, not a uuid').toMatch(/^step-/);

    const renamed = await session.put(`/v1/admin/kyc-config/steps/${id}`).send({
      slug: 'per-step-route',
      title: 'Per Step Route Renamed',
      enabled: true,
      fields: [{ id: 'f-q', name: 'q', label: 'Q', type: 'text', required: false }],
    });
    expect(renamed.status, `PUT by id refused: ${JSON.stringify(renamed.body).slice(0, 200)}`).toBe(
      200,
    );

    // Re-read: a 200 that did not persist is the same class of defect.
    const afterRename = await session.get('/v1/admin/kyc-config');
    const steps = (Array.isArray(afterRename.body) ? afterRename.body : afterRename.body.steps) as {
      id: string;
      title: string;
    }[];
    expect(steps.find((s) => s.id === id)?.title).toBe('Per Step Route Renamed');

    const removed = await session.del(`/v1/admin/kyc-config/steps/${id}`);
    expect(removed.status, `DELETE by id refused: ${removed.status}`).toBeLessThan(400);

    const afterDelete = await session.get('/v1/admin/kyc-config');
    const left = (Array.isArray(afterDelete.body) ? afterDelete.body : afterDelete.body.steps) as {
      id: string;
    }[];
    expect(
      left.some((s) => s.id === id),
      'the step survived its own delete',
    ).toBe(false);
  });

  it('addresses a SEEDED step by its id — the ids a real broker actually has', async () => {
    const read = await session.get('/v1/admin/kyc-config');
    const steps = (Array.isArray(read.body) ? read.body : read.body.steps) as {
      id: string;
      slug: string;
      title: string;
      enabled: boolean;
      fields: unknown[];
    }[];
    const seeded = steps.find((s) => s.slug === 'personal');
    expect(seeded, 'the personal step is missing from the fixture').toBeDefined();

    const res = await session.put(`/v1/admin/kyc-config/steps/${seeded!.id}`).send({
      slug: seeded!.slug,
      title: seeded!.title,
      enabled: seeded!.enabled,
      fields: seeded!.fields,
    });
    expect(res.status, `a seeded id was not addressable: ${res.status}`).toBe(200);
  });

  it('still refuses an id that is not a plausible key', async () => {
    for (const bad of ['../../../etc/passwd', 'has space', 'x'.repeat(200), 'semi;colon']) {
      const res = await session.del(`/v1/admin/kyc-config/steps/${encodeURIComponent(bad)}`);
      expect(res.status, `'${bad.slice(0, 20)}' was accepted as a step id`).toBe(400);
    }
  });
});

/**
 * A FIELD GOES ONLY ON A STEP THAT CAN STORE IT — and every route that saves a
 * step says so, not just the one the builder uses.
 *
 * Reported from local testing: documents offered on a step the broker added,
 * and a week of bugs from giving them a second home there. `kyc-config-integrity`
 * holds the rule and its unit cases; these prove each save route applies it,
 * because the two per-step routes applied NO integrity rule until this change.
 */
describe('a field goes only on a step that can store it', () => {
  const passport = {
    id: 'f-pp',
    name: 'pp',
    label: 'Passport',
    type: 'doc:passport',
    required: true,
  };
  const note = { id: 'f-note', name: 'note', label: 'Note', type: 'text', required: false };
  const stepsOf = (body: unknown) =>
    (Array.isArray(body) ? body : (body as { steps: unknown[] }).steps) as { id: string }[];

  it('refuses a document on an added step through the whole-configuration save, and changes nothing', async () => {
    const before = stepsOf((await session.get('/v1/admin/kyc-config')).body);

    const write = await session.put('/v1/admin/kyc-config').send({
      steps: [...before, { slug: 'extra-docs', title: 'Extra', enabled: true, fields: [passport] }],
    });
    expect(write.status, JSON.stringify(write.body).slice(0, 300)).toBe(400);
    expect(JSON.stringify(write.body)).toMatch(/Passport.*document type/);

    const after = stepsOf((await session.get('/v1/admin/kyc-config')).body);
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
  });

  it('refuses it through the per-step ADD and UPDATE routes too', async () => {
    const add = await session
      .post('/v1/admin/kyc-config/steps')
      .send({ slug: 'extra-docs', title: 'Extra', enabled: true, fields: [passport] });
    expect(add.status, JSON.stringify(add.body).slice(0, 300)).toBe(400);

    const created = await session
      .post('/v1/admin/kyc-config/steps')
      .send({ slug: 'extra-docs', title: 'Extra', enabled: true, fields: [note] });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    const patched = await session
      .put(`/v1/admin/kyc-config/steps/${id}`)
      .send({ slug: 'extra-docs', title: 'Extra', enabled: true, fields: [note, passport] });
    expect(patched.status, JSON.stringify(patched.body).slice(0, 300)).toBe(400);

    const stored = stepsOf((await session.get('/v1/admin/kyc-config')).body).find(
      (s) => s.id === id,
    ) as { fields: { type: string }[] } | undefined;
    expect(stored?.fields.map((f) => f.type)).toEqual(['text']);

    await session.del(`/v1/admin/kyc-config/steps/${id}`);
  });
});

describe('0137 puts every catalogue document on the step that holds its kind', () => {
  const migration = readFileSync(
    'src/database/migrations/0137_kyc_fields_fit_their_step.sql',
    'utf8',
  );

  it('keeps every key a file was uploaded under, names each page, and leaves the document steps alone', async () => {
    const documentSteps = async () =>
      ctx.db.db
        .select()
        .from(kycConfigSteps)
        .where(inArray(kycConfigSteps.slug, ['document', 'address']));
    const untouched = await documentSteps();
    expect(untouched.length, 'the fixture must hold both document steps').toBe(2);

    // Written straight to the table — the configuration the rule now refuses.
    await ctx.db.db.insert(kycConfigSteps).values({
      id: 'step-0137',
      stepNumber: 99,
      slug: 'mig-0137',
      title: 'Migrated',
      enabled: true,
      fields: [
        { id: 'f-t', name: 'note', label: 'Note', type: 'text', required: true },
        {
          id: 'f-n',
          name: 'natID',
          label: 'Identity card',
          type: 'doc:national_id',
          required: true,
          hint: 'Both sides',
        },
        { id: 'f-p', name: 'pp', label: '', type: 'doc:passport', required: false },
        { id: 'f-l', name: 'lease', label: 'Lease', type: 'doc:tenancy_agreement', required: true },
        {
          id: 'f-x',
          name: 'old',
          label: 'Old card',
          type: 'doc:withdrawn_card',
          required: true,
          options: ['a'],
        },
      ],
    });

    await ctx.db.db.execute(sql.raw(migration));

    const [row] = await ctx.db.db
      .select()
      .from(kycConfigSteps)
      .where(eq(kycConfigSteps.id, 'step-0137'));
    expect(row.fields).toEqual([
      { id: 'f-t', name: 'note', label: 'Note', type: 'text', required: true },
      // The first page keeps the key its uploads are stored under.
      {
        id: 'f-n',
        name: 'natID',
        label: 'Identity card — Front Side',
        type: 'file',
        required: true,
        hint: 'Both sides',
      },
      {
        id: 'f-n-back',
        name: 'natID__back',
        label: 'Identity card — Back Side',
        type: 'file',
        required: true,
      },
      // One page: no page name. No label: the document's own.
      {
        id: 'f-p',
        name: 'pp',
        label: 'Passport',
        type: 'file',
        required: false,
        hint: 'The page with your photo and details',
      },
      { id: 'f-l', name: 'lease', label: 'Lease — Signature Page', type: 'file', required: true },
      // The optional second sheet stays optional.
      {
        id: 'f-l-back',
        name: 'lease__back',
        label: 'Lease — Additional Page',
        type: 'file',
        required: false,
        hint: 'Only if your address is on a separate page',
      },
      // A document the catalogue no longer knows: one File field.
      { id: 'f-x', name: 'old', label: 'Old card', type: 'file', required: true },
    ]);

    expect(await documentSteps()).toEqual(untouched);

    // Re-runnable: nothing is left to convert.
    const second = await ctx.db.db.execute(sql.raw(migration));
    expect(second.rowCount).toBe(0);

    // And what it leaves is a configuration the builder can save.
    const read = await session.get('/v1/admin/kyc-config');
    const write = await session
      .put('/v1/admin/kyc-config')
      .send({ steps: Array.isArray(read.body) ? read.body : read.body.steps });
    expect(write.status, JSON.stringify(write.body).slice(0, 300)).toBe(200);

    await ctx.db.db.delete(kycConfigSteps).where(eq(kycConfigSteps.id, 'step-0137'));
  });

  it('converts documents on the built-in steps that hold none, drops the wrong kind, and leaves every extra field alone', async () => {
    const f = (id: string, type: string, extra: object = {}) => ({
      id,
      name: id,
      label: id,
      type,
      required: true,
      ...extra,
    });
    // Extra built-in rows, written straight to the table: slugs are not unique.
    await ctx.db.db.insert(kycConfigSteps).values([
      {
        id: 'step-0137-personal',
        stepNumber: 97,
        slug: 'personal',
        title: 'P',
        enabled: true,
        fields: [f('name', 'text'), f('scan', 'file'), f('pp', 'doc:passport'), f('tel', 'phone')],
      },
      {
        id: 'step-0137-address',
        stepNumber: 98,
        slug: 'address',
        title: 'A',
        enabled: true,
        // `prooof3`: an extra upload on Proof of Address — kept, and now it works.
        fields: [
          f('bill', 'doc:utility_bill'),
          f('prooof3', 'file'),
          f('ref', 'checkbox'),
          f('pp', 'doc:passport'),
          f('gone', 'doc:withdrawn_bill'),
        ],
      },
      {
        id: 'step-0137-selfie',
        stepNumber: 99,
        slug: 'selfie',
        title: 'S',
        enabled: true,
        fields: [
          f('selfie', 'camera'),
          f('pick', 'select', { options: ['a'] }),
          f('id', 'doc:national_id'),
        ],
      },
    ]);

    await ctx.db.db.execute(sql.raw(migration));

    const fieldsOf = async (id: string) =>
      (await ctx.db.db.select().from(kycConfigSteps).where(eq(kycConfigSteps.id, id)))[0].fields;
    expect(await fieldsOf('step-0137-personal')).toEqual([
      f('name', 'text'),
      f('scan', 'file'),
      { ...f('pp', 'file'), hint: 'The page with your photo and details' },
      f('tel', 'phone'),
    ]);
    // The wrong kind goes; the withdrawn one and every extra stay.
    expect((await fieldsOf('step-0137-address')).map((x) => x.name)).toEqual([
      'bill',
      'prooof3',
      'ref',
      'gone',
    ]);
    expect(await fieldsOf('step-0137-selfie')).toEqual([
      f('selfie', 'camera'),
      f('pick', 'select', { options: ['a'] }),
      { ...f('id', 'file'), label: 'id — Front Side' },
      { id: 'id-back', name: 'id__back', label: 'id — Back Side', type: 'file', required: true },
    ]);

    const second = await ctx.db.db.execute(sql.raw(migration));
    expect(second.rowCount, 'a second run changed a step again').toBe(0);

    await ctx.db.db
      .delete(kycConfigSteps)
      .where(
        inArray(kycConfigSteps.id, ['step-0137-personal', 'step-0137-address', 'step-0137-selfie']),
      );
  });
});
