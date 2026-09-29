import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  admins,
  auditLog,
  kycConfigSteps,
  kycSubmissions,
  roles,
  users,
} from '../src/database/schema';
import { DEFAULT_KYC_STEPS } from '../src/store/kyc-config.store';
import { EmailService } from '../src/modules/email/email.service';
import { recordKycEvidence } from './support/kyc-evidence';

/**
 * CORE-18 — THE ONE STATE WITH NO CORRECTION PATH.
 *
 * The tracker said "a typo'd date of birth has no correction path anywhere in
 * the product". That was wrong and the true version is worse. `saveStep`
 * refuses `approved`, `submitted` and `under_review` and falls through for the
 * rest, so a client CAN fix a typo while not_started, in_progress or rejected —
 * four of six states. APPROVED had none, and it is the state every real client
 * ends in.
 *
 * What made it a defect rather than a narrowing is that the product NAMED a
 * remedy that did not exist. As it stood — the sentence has since been
 * rewritten to promise only what this route delivers:
 *
 *   POST /kyc/reset       403 "An approved verification cannot be reset.
 *                         Contact support if your details have changed."
 *                         ← the OLD copy, quoted for the record
 *   support is the admin  UpdateClientProfileDto = firstName, lastName, phone,
 *                         country. No dateOfBirth. No address.
 *   reset on their behalf there is no such route — the only `reset` on the
 *                         admin side is kyc-config/reset, the step BUILDER
 *   the lever left        REJECT the verification, which
 *                         `kyc-gates-money.spec.ts` proves takes
 *                         verificationLevel to 0 and shuts both money doors
 *
 * ## Where the values live — the PROFILE (0139)
 *
 * This spec used to explain why the values were NOT on the users row: date of
 * birth and address existed only in `kyc_submissions.personalInfo`, and adding
 * `users` columns to carry a copy would have created a second home for a field
 * that had one. That was right about copies. 0139 answered it the other way
 * round: the profile columns are the ONLY home, `personal_info` keeps only a
 * broker's own questions, and a correction is a profile write — so these cases
 * read the `users` row, and prove the submission's own answers are untouched.
 *
 * ## The case that matters most is the REFUSAL
 *
 * Without re-validation this route is a BYPASS for the age rule: an operator
 * could write any date onto an approved record, on the side of the system where
 * it is least visible, and the hole works both ways. The refusal is a 409
 * rather than a 400 on purpose — "the record is wrong" is a compliance event and
 * needs a different screen from "you typed it wrong".
 */

const ADMIN = { email: 'kyc-correct-admin@oxshare.com', password: 'admin-password-123' };
const REVIEWER = { email: 'kyc-correct-reviewer@oxshare.com', password: 'admin-password-123' };

const ROUTE = (id: number) => `/v1/admin/kyc/${id}/personal-info`;
/** Every correction of a verified record says why (the owner's ruling, 26 Sep 2026). */
const REASON = 'Typed wrongly at registration; the passport reads otherwise.';

let ctx: HttpTestContext;
let userId: number;

const ORIGINAL = {
  firstName: 'Layla',
  lastName: 'Haddad',
  dateOfBirth: '1985-04-12',
  nationality: 'Lebanese',
  address: '12 Rue Verdun',
  city: 'Beirut',
  postalCode: '1103',
  phone: '+9613111222',
  country: 'Lebanon',
};

/** A broker's own question on the personal step — the one thing `personal_info` holds. */
const CUSTOM_ANSWERS = { customField_1790000000001: 'Engineer' };

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();

  const [full] = await db
    .insert(roles)
    .values({ name: 'KYC Correct Full', permissions: ALL_PERMISSIONS })
    .returning();
  await db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'KYC Correct Full',
    role: 'sub_admin',
    roleId: full.id,
    permissions: [],
    status: 'active',
  });

  /*
   * A REVIEWER, deliberately holding every KYC key EXCEPT the new one. Without
   * this the 403 case below could be produced by an admin who simply holds
   * nothing, which would say nothing about the split being asserted: that
   * deciding a submission and rewriting the claim inside it are different
   * powers.
   */
  const [reviewer] = await db
    .insert(roles)
    .values({
      name: 'KYC Correct Reviewer',
      permissions: ['kyc.view', 'kyc.review', 'kyc.documents.view', 'kyc.edit', 'clients.view'],
    })
    .returning();
  await db.insert(admins).values({
    email: REVIEWER.email,
    passwordHash: await passwords.hash(REVIEWER.password),
    name: 'KYC Correct Reviewer',
    role: 'sub_admin',
    roleId: reviewer.id,
    permissions: [],
    status: 'active',
  });

  /*
   * The KYC CONFIG, because `profileRules()` fails CLOSED: with no enabled
   * `personal` step it throws a 500 rather than defaulting to "nothing is
   * required", which is the right call on a compliance path and means this
   * fixture has to supply one. A container starts empty; the bootstrap seed
   * does not run under NODE_ENV=test.
   */
  await db.insert(kycConfigSteps).values(
    DEFAULT_KYC_STEPS.map((step, idx) => ({
      id: step.id,
      stepNumber: idx + 1,
      slug: step.slug,
      title: step.title,
      description: step.description,
      icon: step.icon,
      enabled: step.enabled,
      fields: step.fields as unknown as Record<string, unknown>[],
    })),
  );

  const [client] = await db
    .insert(users)
    .values({
      email: 'kyc-correct-subject@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Layla',
      lastName: 'Haddad',
      emailVerified: true,
      verificationLevel: 1,
    })
    .returning();
  userId = client.id;
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** Back to an APPROVED submission, over a profile holding the original details. */
beforeEach(async () => {
  const db = ctx.db.db;
  await db.update(users).set(ORIGINAL).where(eq(users.id, userId));
  await db.delete(kycSubmissions).where(eq(kycSubmissions.userId, userId));
  await db.insert(kycSubmissions).values({
    userId,
    status: 'approved',
    submittedAt: new Date(),
    reviewedAt: new Date(),
    personalInfo: CUSTOM_ANSWERS,
  });
  await recordKycEvidence(db, userId, { document: { docType: 'passport' } });
});

/** The client's identity, as stored — the profile columns (0139). */
const profile = async () => {
  const [row] = await ctx.db.db
    .select({
      firstName: users.firstName,
      lastName: users.lastName,
      dateOfBirth: users.dateOfBirth,
      nationality: users.nationality,
      address: users.address,
      city: users.city,
      postalCode: users.postalCode,
      phone: users.phone,
      country: users.country,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row as Record<string, unknown>;
};

const storedPersonalInfo = async () => {
  const [row] = await ctx.db.db
    .select({ personalInfo: kycSubmissions.personalInfo })
    .from(kycSubmissions)
    .where(eq(kycSubmissions.userId, userId));
  return (row?.personalInfo ?? {}) as Record<string, unknown>;
};

describe('correcting an approved submission', () => {
  it('writes the new value and KEEPS every other field', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session
      .patch(ROUTE(userId))
      .send({ reason: REASON, dateOfBirth: '1985-04-21' });

    expect(res.status, `correction answered ${res.status}`).toBe(200);

    const after = await profile();
    expect(after['dateOfBirth']).toBe('1985-04-21');
    /*
     * A MERGE, not a replace: correcting one field must leave every other one
     * exactly as it was — the rest of the profile, and the broker's own
     * questions in the submission — or a route whose whole purpose is
     * correcting one field silently drops the rest of a compliance record.
     */
    expect(after, 'the correction replaced the record instead of merging').toEqual({
      ...ORIGINAL,
      dateOfBirth: '1985-04-21',
    });
    expect(await storedPersonalInfo()).toEqual(CUSTOM_ANSWERS);
  });

  it('corrects the whole address in one go, in its canonical shape', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.patch(ROUTE(userId)).send({
      reason: REASON,
      address: '  4 Hamra   Street ',
      city: 'Jounieh',
      postalCode: 'lb 1200',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await profile()).toMatchObject({
      address: '4 Hamra Street',
      city: 'Jounieh',
      postalCode: 'LB 1200',
      dateOfBirth: ORIGINAL.dateOfBirth,
    });
  });

  it('shows the corrected value on the review screen — one record, not a copy', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session
      .patch(ROUTE(userId))
      .send({ reason: REASON, dateOfBirth: '1985-04-21' });
    expect(res.status).toBe(200);
    // The route answers with the submission as the reviewer reads it.
    const personal = (res.body as { personalInfo?: Record<string, unknown> }).personalInfo;
    expect(personal).toMatchObject({
      dateOfBirth: '1985-04-21',
      firstName: ORIGINAL.firstName,
      ...CUSTOM_ANSWERS,
    });

    const detail = await session.get(`/v1/admin/kyc/${userId}`);
    expect((detail.body as { personalInfo?: Record<string, unknown> }).personalInfo).toMatchObject({
      dateOfBirth: '1985-04-21',
    });
  });

  it('audits the SUBMISSION with the value on BOTH sides', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    expect(
      (await session.patch(ROUTE(userId)).send({ reason: REASON, dateOfBirth: '1985-04-21' }))
        .status,
    ).toBe(200);

    /*
     * The audit write is fire-and-forget once the decision has landed — see the
     * block above `approveKyc` — so it is polled rather than assumed present on
     * the response.
     */
    let rows: { action: string; subjectType: string; details: unknown }[] = [];
    for (let attempt = 0; attempt < 40 && rows.length === 0; attempt += 1) {
      rows = await ctx.db.db
        .select({
          action: auditLog.action,
          subjectType: auditLog.subjectType,
          details: auditLog.details,
        })
        .from(auditLog)
        .where(eq(auditLog.subjectId, String(userId)));
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 50));
    }

    const row = rows.find((r) => r.action === 'kyc.identity_correct');
    expect(row, 'no audit row was written for the correction').toBeDefined();
    expect(
      row?.subjectType,
      'filed against the wrong subject — a reviewer reading the submission history will ' +
        'never find it',
    ).toBe('kyc_submission');

    const details = row?.details as {
      before?: Record<string, unknown>;
      after?: unknown;
      via?: unknown;
    };
    expect(
      details?.before?.['dateOfBirth'],
      'the audit row carries only the new value, so "what was it before" — the whole ' +
        'question this row exists to answer — is unanswerable',
    ).toBe(ORIGINAL.dateOfBirth);
    expect(details?.after).toEqual({ dateOfBirth: '1985-04-21' });
    expect(details?.via).toBe('kyc_correction');
    expect((details as { reason?: unknown }).reason, 'the reason was not recorded').toBe(REASON);
    // Written by the profile write, in its transaction — not a second row
    // under the generic action beside it.
    expect(rows.filter((r) => r.action === 'client.profile_update')).toEqual([]);
  });
});

describe('the correction is RE-VALIDATED, or this route is a bypass', () => {
  it('REFUSES an under-18 date with 409, and changes NOTHING', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const thisYear = new Date().getUTCFullYear();
    const res = await session
      .patch(ROUTE(userId))
      .send({ reason: REASON, dateOfBirth: `${thisYear - 10}-04-12` });

    expect(
      res.status,
      `an under-18 correction answered ${res.status}. Without this refusal an operator can ` +
        'write any date onto an APPROVED record — the age rule bypassed on the side of the ' +
        'system where it is least visible.',
    ).toBe(409);
    expect(
      (res.body as { code?: string }).code,
      'a 400 says "you typed it wrong"; this is "the record is wrong", which needs a ' +
        'different screen and a different follow-up — so it carries its own CODE rather ' +
        'than a bare CONFLICT, because the caller has to branch on it',
    ).toBe('KYC_CORRECTION_REFUSED');
    expect(
      (res.body as { message?: string }).message,
      'the refusal does not say WHICH rule refused, and the filter does not surface ' +
        'DomainError.details — so the message is the only place it can be',
    ).toMatch(/at least 18 years old/i);

    expect(
      (await profile())['dateOfBirth'],
      'the refusal answered 409 and wrote the value anyway',
    ).toBe(ORIGINAL.dateOfBirth);
  });

  it('REFUSES a date in the future, for the same reason', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session
      .patch(ROUTE(userId))
      .send({ reason: REASON, dateOfBirth: '3000-01-01' });

    expect(res.status).toBe(409);
    expect((res.body as { code?: string }).code).toBe('KYC_CORRECTION_REFUSED');
    expect((res.body as { message?: string }).message).toMatch(/cannot be in the future/i);
    expect((await profile())['dateOfBirth']).toBe(ORIGINAL.dateOfBirth);
  });
});

describe('what the route refuses', () => {
  it('refuses any state but APPROVED — the others are the CLIENT’s to fix', async () => {
    /*
     * The narrowing, asserted. In every other state the client can edit their
     * own details through `saveStep`, so an admin correction there would be a
     * second way to do something they can already do — with more privilege and
     * less context about what they meant.
     */
    await ctx.db.db
      .update(kycSubmissions)
      .set({ status: 'rejected' })
      .where(eq(kycSubmissions.userId, userId));

    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session
      .patch(ROUTE(userId))
      .send({ reason: REASON, dateOfBirth: '1985-04-21' });

    expect(res.status, `a rejected submission answered ${res.status}`).toBe(400);
    expect((await profile())['dateOfBirth']).toBe(ORIGINAL.dateOfBirth);
  });

  it('refuses a REVIEWER — deciding a submission is not rewriting the claim in it', async () => {
    /*
     * The permission split, and the reviewer holds every other KYC key so this
     * cannot pass for "an admin with nothing". Approving or rejecting is a
     * decision about what the client claimed; this REWRITES the claim, and
     * `kyc.edit` is a third thing again — the step builder.
     */
    const session = await actingAs(ctx, 'admin', REVIEWER);
    const res = await session
      .patch(ROUTE(userId))
      .send({ reason: REASON, dateOfBirth: '1985-04-21' });

    expect(
      res.status,
      `a kyc.review admin correcting an identity answered ${res.status}; 401 would mean the ` +
        'session failed and would prove nothing about the permission',
    ).toBe(403);
    expect((await profile())['dateOfBirth']).toBe(ORIGINAL.dateOfBirth);
  });

  it('corrects a NAME, a NATIONALITY and a COUNTRY too — and tells the client (26 Sep 2026)', async () => {
    /*
     * It could not: those "needed a new verification", so a misspelt surname on
     * an approved client had no remedy but a rejection, which shuts the money
     * doors for a typo. The owner's ruling: a reviewer corrects ANY identity
     * field but the phone, with a reason, re-checked, recorded, and the client
     * emailed which details changed.
     */
    const email = ctx.app.get(EmailService);
    const told = vi.spyOn(email, 'sendKycDetailsCorrectedEmail').mockResolvedValue(undefined);
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session
      .patch(ROUTE(userId))
      .send({ reason: REASON, lastName: 'Haddâd', nationality: 'Syrian', country: 'Syria' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await profile()).toMatchObject({
      lastName: 'Haddâd',
      nationality: 'Syrian',
      country: 'Syria',
      firstName: ORIGINAL.firstName,
    });
    expect(told).toHaveBeenCalledWith(expect.any(String), ORIGINAL.firstName, [
      'Last Name',
      'Nationality',
      'Country of Residence',
    ]);
    told.mockRestore();
  });

  it('still re-checks a corrected NAME by the profile’s rules — "t1" is not a legal name', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.patch(ROUTE(userId)).send({ reason: REASON, firstName: 't1' });
    expect(res.status).toBe(400);
    expect((res.body as { fields?: Record<string, string> }).fields?.firstName).toMatch(/letters/);
    expect(await profile()).toEqual(ORIGINAL);
  });

  it('does NOT take the phone — the desk edits that directly, no document proves it', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.patch(ROUTE(userId)).send({ reason: REASON, phone: '+96170000000' });
    expect(res.status).toBe(400);
    expect(await profile()).toEqual(ORIGINAL);
  });

  it('refuses a correction with no reason — a verified record never changes silently', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    for (const body of [
      { lastName: 'Smith' },
      { reason: '', lastName: 'Smith' },
      // Trimmed first: a reason of spaces is still no reason.
      { reason: '   ', lastName: 'Smith' },
    ]) {
      const res = await session.patch(ROUTE(userId)).send(body);
      expect(res.status, `${JSON.stringify(body)} answered ${res.status}`).toBe(400);
    }
    expect(await profile()).toEqual(ORIGINAL);
  });

  /*
   * Reported 28 Sep 2026: a ten-character floor made a reviewer pad a complete
   * reason ("Typo") before Save would work. A reason must EXIST; how long it
   * is, is the reviewer's call.
   */
  it('takes a SHORT reason — what matters is that there is one', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.patch(ROUTE(userId)).send({ reason: 'Typo', lastName: 'Smith' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await profile())['lastName']).toBe('Smith');
  });

  it('refuses an empty body rather than logging a correction that changed nothing', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.patch(ROUTE(userId)).send({ reason: REASON });
    expect(res.status).toBe(400);
  });
});

describe('what a correction may CLEAR follows the requirements the client was verified under', () => {
  it('refuses clearing what they required, clears what the form left optional (Phase 2)', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);

    // No requirements on record: an approval from before 0158, judged by the fixed tier.
    const legacy = await session.patch(ROUTE(userId)).send({ reason: REASON, address: '' });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(400);
    expect((await profile()).address).toBe(ORIGINAL.address);

    // Verified under a form that asked for the address without requiring it.
    await ctx.db.db
      .update(kycSubmissions)
      .set({
        formPolicy: {
          steps: [],
          identity: [
            { name: 'address', required: false },
            { name: 'city', required: true },
          ],
        },
      })
      .where(eq(kycSubmissions.userId, userId));

    const cleared = await session.patch(ROUTE(userId)).send({ reason: REASON, address: '' });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect((await profile()).address).toBeNull();

    const refused = await session.patch(ROUTE(userId)).send({ reason: REASON, city: '' });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/city is required/i);
    expect((await profile()).city).toBe(ORIGINAL.city);
  });
});
