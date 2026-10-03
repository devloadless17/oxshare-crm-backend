import { OfferedCountriesStore } from '../src/store/offered-countries.store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storageStub } from './storage-stub';
import { KycClientService } from '../src/modules/compliance/kyc-client.service';
import { KycReviewService } from '../src/modules/compliance/kyc-review.service';
import type { KycStore, KycSubmission } from '../src/store/kyc.store';
import type { User, UsersStore } from '../src/store/users.store';
import type { AdminsStore } from '../src/store/admins.store';
import type { EmailService } from '../src/modules/email/email.service';
import {
  DEFAULT_KYC_STEPS,
  type KycConfigStore,
  type KycStepConfig,
} from '../src/store/kyc-config.store';
import { platformStep } from '../src/common/kyc/identity-core';
import type { Db } from '../src/database/db';
import type { AuditLogStore } from '../src/store/audit-log.store';
import { ClientProfileService } from '../src/modules/profile/client-profile.service';
import { KycIdentityReview } from '../src/modules/compliance/kyc-identity-review';
import { notificationsStub } from './notifications-stub';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../src/common/errors/domain-errors';

/**
 * KycService — the service that decides a client is verified.
 *
 * CORE-15 is marked done, and this file had no behavioural tests at all: it is
 * stubbed with `useValue` in the one spec that imports it. That matters more
 * than the coverage number suggests, because `approve()` sets
 * `verificationLevel: 1`, and verification level is what gates withdrawals. A
 * mistake here does not throw — it quietly lets money leave, or quietly stops a
 * verified client from moving their own.
 */

/**
 * The seeded flow AS IT IS SERVED — the platform's identity fields, the
 * documents each document step accepts, the selfie camera — as a function so
 * every caller gets a FRESH array.
 *
 * Built through `platformStep` over the stored defaults, which is what the real
 * store returns: a hand-written stub of it is how this file once described a
 * form that asked for no documents at all.
 */
function defaultSteps(): KycStepConfig[] {
  return structuredClone(DEFAULT_KYC_STEPS.map((step) => platformStep(step)));
}

function submission(over: Partial<KycSubmission> = {}): KycSubmission {
  return {
    userId: 1000001,
    status: 'in_progress',
    // Always an object: the column is NOT NULL DEFAULT '{}' (migration 0130),
    // so a fixture with it undefined describes a row the database cannot hold.
    stepData: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function completeSubmission(over: Partial<KycSubmission> = {}): KycSubmission {
  return submission({
    // The identity is the PROFILE's — `USER` below carries the name and the
    // date of birth (0139). `personal_info` holds only answers to fields a
    // broker invented, and this configuration invents none.
    personalInfo: {},
    document: { docType: 'passport', frontFilePath: '/uploads/front.png' },
    selfie: { filePath: '/uploads/selfie.png' },
    addressProof: { docType: 'utility_bill', filePath: '/uploads/address.png' },
    ...over,
  });
}

const USER = {
  id: 1000001,
  portalId: 1000001,
  email: 'client@oxshare.com',
  firstName: 'Jane',
  lastName: 'Doe',
  // Not decoration: `submit()` and `approve()` judge the identity by the
  // platform's rules (FR-IND-03, the identity core), so a client without every
  // required field is not a COMPLETE applicant.
  dateOfBirth: '1990-01-01',
  nationality: 'Lebanese',
  phone: '+96170123456',
  country: 'Lebanon',
  address: 'Hamra Street 12',
  city: 'Beirut',
  verificationLevel: 0,
  status: 'active',
} as User;

function build(options: { stored?: KycSubmission; user?: User } = {}) {
  const stored = options.stored ?? submission();
  const kycStore = {
    getOrCreate: vi.fn().mockResolvedValue(stored),
    findByUserId: vi.fn().mockResolvedValue(stored),
    update: vi.fn((_id: number, patch: Partial<KycSubmission>) =>
      Promise.resolve({ ...stored, ...patch }),
    ),
    findPageWithUsers: vi.fn().mockResolvedValue({ items: [], total: 0, counts: {} }),
    resetUser: vi.fn(),
    /*
     * The conditional write approve/reject now use. The stub honours the `from`
     * precondition rather than always succeeding — otherwise these tests would
     * pass against a store that ignored it, which is the whole defect the real
     * `transition()` closes.
     */
    /*
     * The trailing two parameters are declared even though this stub ignores
     * them, because the ASSERTIONS read them: `unheldOrHeldBy` is the claim
     * guard, and a mock typed to three arguments makes `calls[0][4]` a type
     * error rather than a failed expectation.
     *
     * `_executor` is named and unused for the same reason — dropping it would
     * put the guard at index 3 here and index 4 in the real call, which is the
     * kind of drift a stub is supposed to make impossible.
     */
    transition: vi.fn(
      (
        _id: number,
        from: string[],
        patch: Partial<KycSubmission>,
        _executor?: unknown,
        _unheldOrHeldBy?: string,
      ) => Promise.resolve(from.includes(stored.status) ? { ...stored, ...patch } : undefined),
    ),
    // The upload's row lock. The stub hands back the stored row; the lock
    // itself is proven against real Postgres in kyc-http.spec.ts.
    lockForUpdate: vi.fn().mockResolvedValue(stored),
    // A decision snapshots the attempt before the next one can overwrite it.
    archiveAttempt: vi.fn().mockResolvedValue(undefined),
    listAttempts: vi.fn().mockResolvedValue([]),
    archivedDocumentPaths: vi.fn().mockResolvedValue([]),
  };
  /*
   * The client's row, LIVE: the profile writes land in it and every later read
   * sees them, so a case can save a step and then submit and be judged on what
   * it saved — the way the real tables behave.
   */
  const profileRow: User = { ...(options.user ?? USER) };
  const users = {
    findById: vi.fn(() => Promise.resolve(profileRow)),
    findByIdForUpdate: vi.fn(() => Promise.resolve(profileRow)),
    update: vi.fn(() => Promise.resolve(profileRow)),
  };
  const email = { sendKycDecisionEmail: vi.fn().mockResolvedValue(undefined) };
  const db = {
    transaction: (fn: (tx: unknown) => unknown) => fn(db),
    // The profile service's one write: `tx.update(users).set(changes).where(…)`.
    update: () => ({
      set: (changes: Partial<User>) => ({
        where: () => {
          Object.assign(profileRow, changes);
          return Promise.resolve();
        },
      }),
    }),
  };
  const auditLog = { record: vi.fn().mockResolvedValue(undefined) };
  /*
   * The REAL profile service over the stubs, not a mock of it: the rules a
   * client's answers must pass (a name with no digits, a dialable phone, an
   * adult's date of birth) are the ones production applies, and a mock would
   * let these cases pass against rules nobody runs.
   */
  const profile = new ClientProfileService(
    db as unknown as Db,
    users as unknown as UsersStore,
    auditLog as unknown as AuditLogStore,
    // The review's state, through the port the KYC layer provides.
    new KycIdentityReview(kycStore as unknown as KycStore),
    new OfferedCountriesStore(db as unknown as Db),
  );

  /*
   * The real seeded profile step, trimmed to what these tests exercise.
   *
   * `submit()` now validates the stored profile against the CONFIGURED fields
   * (FR-IND-03), so the service needs the config store. Supplying the real
   * required set rather than an empty one matters: an empty config would make
   * every completeness assertion below vacuously pass, which is the failure mode
   * the validation was added to remove.
   */
  const kycConfig = {
    getSteps: vi.fn().mockResolvedValue(defaultSteps()),
    // The names of questions since removed from the form (0148) — none by default.
    recordedLabels: vi.fn().mockResolvedValue(new Map()),
  };

  const admins = {
    namesByIds: vi.fn().mockResolvedValue(new Map([['admin-2', 'Sarah Chen']])),
  };
  const notifications = notificationsStub();

  // In-memory storage: this suite asserts the KYC decision rules, not where the
  // bytes live. `deleteDocuments` goes through it, and the upload cases read
  // back what it was asked to delete.
  const storage = storageStub();
  /*
   * A transaction stub that just runs the callback: these are unit tests over
   * stubbed stores — the atomicity itself is proven against real Postgres in
   * test/kyc-gates-money.spec.ts — so here the transaction only has to be
   * transparent.
   *
   * KYC is TWO services since the split: the client's flow and the desk's
   * review. Both are built over the same stubs, so a case can drive the client
   * side and then decide it.
   */
  const client = new KycClientService(
    storage.files,
    kycStore as unknown as KycStore,
    users as unknown as UsersStore,
    kycConfig as unknown as KycConfigStore,
    db as unknown as Db,
    notifications,
    profile,
  );
  const review = new KycReviewService(
    email as unknown as EmailService,
    kycStore as unknown as KycStore,
    users as unknown as UsersStore,
    kycConfig as unknown as KycConfigStore,
    db as unknown as Db,
    notifications,
    /*
     * Read ONLY when a decision is refused because another reviewer holds the
     * submission, to name them — so `namesByIds` answering with a populated
     * Map lets those cases assert the reviewer's name in the message.
     */
    admins as unknown as AdminsStore,
    profile,
  );
  return {
    client,
    review,
    kycStore,
    users,
    email,
    kycConfig,
    admins,
    notifications,
    profileRow,
    auditLog,
    storage,
    profile,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('saveStep', () => {
  it('refuses to edit an approved submission', async () => {
    const h = build({ stored: submission({ status: 'approved' }) });
    await expect(h.client.saveStep(1000001, 'personal', {})).rejects.toThrow(AuthorizationError);
    expect(h.kycStore.update).not.toHaveBeenCalled();
  });

  it('refuses to edit while under review', async () => {
    // Otherwise a client can change the documents an admin is looking at, and
    // the approval records a decision about something else.
    for (const status of ['submitted', 'under_review'] as const) {
      const h = build({ stored: submission({ status }) });
      await expect(h.client.saveStep(1000001, 'personal', {})).rejects.toThrow(AuthorizationError);
      expect(h.kycStore.update).not.toHaveBeenCalled();
    }
  });

  it('rejects an unknown step rather than silently dropping the data', async () => {
    const h = build();
    await expect(h.client.saveStep(1000001, 'nonsense', {})).rejects.toThrow(ValidationError);
    expect(h.kycStore.update).not.toHaveBeenCalled();
  });

  it('MERGES into the existing step rather than replacing it', async () => {
    // A client editing one field must not blank the rest of the step — the
    // broker's own questions in `personal_info`, or the rest of the profile.
    const h = build({ stored: submission({ personalInfo: { customField_1: 'Acme' } }) });
    await h.client.saveStep(1000001, 'personal', { phone: '+971 50 123 4567' });
    expect(h.kycStore.update).toHaveBeenCalledWith(
      1000001,
      expect.objectContaining({ personalInfo: { customField_1: 'Acme' } }),
      expect.anything(),
    );
    // The phone went to the PROFILE, stored in one canonical shape.
    expect(h.profileRow).toMatchObject({
      firstName: 'Jane',
      lastName: 'Doe',
      dateOfBirth: '1990-01-01',
      phone: '+971501234567',
    });
  });

  it('moves a fresh submission to in_progress', async () => {
    const h = build({ stored: submission({ status: 'not_started' }) });
    await h.client.saveStep(1000001, 'personal', { firstName: 'Jane' });
    expect(h.kycStore.update).toHaveBeenCalledWith(
      1000001,
      expect.objectContaining({ status: 'in_progress' }),
      expect.anything(),
    );
  });

  it('re-checks the status UNDER THE LOCK — a submission sent from another tab wins', async () => {
    /*
     * The status was read before the transaction. A submit from a second tab
     * landing in between used to be pulled straight back to `in_progress` by
     * this write — out of the review queue, the reviewer's row vanishing.
     */
    const h = build({ stored: submission({ status: 'in_progress' }) });
    h.kycStore.lockForUpdate.mockResolvedValue(submission({ status: 'submitted' }));
    await expect(h.client.saveStep(1000001, 'personal', { firstName: 'Janet' })).rejects.toThrow(
      /under review/,
    );
    expect(h.kycStore.update).not.toHaveBeenCalled();
    expect(h.profileRow.firstName).toBe('Jane');
  });

  it('builds the write from the LOCKED row, so two saves cannot erase each other', async () => {
    // The first read saw nothing; by the time the lock was ours another save
    // had stored an answer. Merging into the stale read would erase it.
    const h = build({ stored: submission({ personalInfo: {} }) });
    h.kycStore.lockForUpdate.mockResolvedValue(
      submission({ personalInfo: { customField_1: 'from the other tab' } }),
    );
    await h.client.saveStep(1000001, 'personal', { lastName: 'Doe' });
    expect(h.kycStore.update.mock.calls[0][1]).toMatchObject({
      personalInfo: { customField_1: 'from the other tab' },
    });
  });
});

describe('documents cannot change once the review has started', () => {
  /*
   * `attachFile` had NO status guard while `saveStep` had one from the start,
   * and `POST /kyc/upload` reaches it with only the auth guards. Two attacks
   * followed:
   *
   *   · swap evidence mid-review — upload a clean passport, submit, then
   *     re-upload a forged one while the reviewer has the row open, so the
   *     approval is recorded against bytes nobody inspected;
   *   · replace documents AFTER approval, leaving `approved` and level 1 in
   *     place over files that were never seen.
   *
   * Neither left a trace: `archiveAttempt` snapshots at DECISION time, so an
   * overwrite before the decision erased the original silently.
   */
  for (const status of ['submitted', 'under_review'] as const) {
    it(`refuses an upload while ${status}`, async () => {
      const h = build({ stored: submission({ status }) });
      await expect(h.client.attachFile(1000001, 'doc_front', 'uploads/kyc/x.jpg')).rejects.toThrow(
        /under review/i,
      );
      expect(h.kycStore.update).not.toHaveBeenCalled();
    });
  }

  it('refuses an upload once approved', async () => {
    const h = build({ stored: submission({ status: 'approved' }) });
    await expect(h.client.attachFile(1000001, 'doc_front', 'uploads/kyc/x.jpg')).rejects.toThrow(
      /already approved/i,
    );
    expect(h.kycStore.update).not.toHaveBeenCalled();
  });

  it('ALLOWS an upload after rejection, which is the point of that state', async () => {
    const h = build({ stored: submission({ status: 'rejected' }) });
    await h.client.attachFile(1000001, 'doc_front', 'uploads/kyc/x.jpg');
    expect(h.kycStore.update).toHaveBeenCalled();
  });
});

describe('submit', () => {
  /*
   * ── THE DEAD END ──────────────────────────────────────────────────────────
   *
   * The three upload checks were unconditional, and that contradicted the
   * configuration they sit behind: the mandatory-step rule was deliberately
   * dropped, so a broker may disable the address step. Doing so meant the portal
   * stopped showing it, the client had no way to upload an address proof, and
   * `submit` refused the submission for not having one.
   *
   * Nobody could finish KYC on that deployment, and nothing said why — the
   * console showed a valid flow and the error named a step no longer in it. The
   * cost lands entirely on clients, which is why it is worth a test naming the
   * shape rather than only the fix.
   */
  it('does not demand an upload for a step the broker has DISABLED', async () => {
    const h = build({
      stored: completeSubmission({ status: 'in_progress', addressProof: undefined }),
    });
    h.kycConfig.getSteps.mockResolvedValue(
      defaultSteps().map((step) => (step.slug === 'address' ? { ...step, enabled: false } : step)),
    );

    await expect(h.client.submit(1000001)).resolves.toBeDefined();
  });

  it('still demands it when the step IS enabled', async () => {
    const h = build({
      stored: completeSubmission({ status: 'in_progress', addressProof: undefined }),
    });
    await expect(h.client.submit(1000001)).rejects.toThrow(/proof of address/i);
  });

  describe('a CUSTOM step', () => {
    /*
     * The builder has always offered Add Step and the API has always accepted
     * any slug. What did not exist was anywhere to store the answers, so a
     * custom step rendered, took what the client typed, and died at Continue
     * with `Unknown step` — a capability the console offered and the storage
     * could not honour. Migration 0130 gives it `step_data`, keyed by slug.
     */
    const textField = (name: string) => ({ id: `f-${name}`, name, label: name, type: 'text' });
    const withCustomStep = (h: ReturnType<typeof build>, fields: unknown[]) =>
      h.kycConfig.getSteps.mockResolvedValue([
        ...defaultSteps(),
        {
          id: 'step-9',
          stepNumber: 9,
          slug: 'compliance-questions',
          title: 'Compliance Questions',
          enabled: true,
          fields,
        },
      ]);

    it('stores its answers under its slug rather than refusing them', async () => {
      const h = build({ stored: submission({ status: 'in_progress' }) });
      // Registered in the config first: a slug the configuration does not name
      // is still refused, so an arbitrary one cannot write into `step_data` —
      // and so is a FIELD it does not name (see "only what the step asks for").
      withCustomStep(h, [textField('sourceOfFunds')]);
      await h.client.saveStep(1000001, 'compliance-questions', { sourceOfFunds: 'salary' });

      expect(h.kycStore.update).toHaveBeenCalledWith(
        1000001,
        expect.objectContaining({
          stepData: { 'compliance-questions': { sourceOfFunds: 'salary' } },
        }),
        expect.anything(),
      );
    });

    /** Steps are resumable: a half-filled step must survive coming back to it. */
    it('MERGES answers rather than replacing the step', async () => {
      const h = build({
        stored: submission({
          status: 'in_progress',
          stepData: { 'compliance-questions': { sourceOfFunds: 'salary' } },
        }),
      });
      withCustomStep(h, [textField('sourceOfFunds'), textField('employer')]);
      await h.client.saveStep(1000001, 'compliance-questions', { employer: 'Acme' });

      expect(h.kycStore.update).toHaveBeenCalledWith(
        1000001,
        expect.objectContaining({
          stepData: { 'compliance-questions': { sourceOfFunds: 'salary', employer: 'Acme' } },
        }),
        expect.anything(),
      );
    });

    it('does not disturb another custom step', async () => {
      const h = build({
        stored: submission({ status: 'in_progress', stepData: { other: { a: '1' } } }),
      });
      withCustomStep(h, [textField('b')]);
      await h.client.saveStep(1000001, 'compliance-questions', { b: '2' });

      expect(h.kycStore.update).toHaveBeenCalledWith(
        1000001,
        expect.objectContaining({
          stepData: { other: { a: '1' }, 'compliance-questions': { b: '2' } },
        }),
        expect.anything(),
      );
    });

    /*
     * The half that makes the feature CORRECT rather than merely present. A
     * `required` flag nothing enforces is decoration — the exact bug
     * `saveStep`'s own comment records for the personal step — and shipping
     * custom steps without this would have reintroduced it on the new surface.
     */
    it('ENFORCES its required fields at submit', async () => {
      const h = build({ stored: completeSubmission({ status: 'in_progress' }) });
      withCustomStep(h, [
        {
          id: 'f-9',
          name: 'sourceOfFunds',
          label: 'Source of Funds',
          type: 'text',
          required: true,
        },
      ]);

      await expect(h.client.submit(1000001)).rejects.toThrow(/Source of Funds/);
    });

    it('accepts the submission once they are answered', async () => {
      const h = build({
        stored: completeSubmission({
          status: 'in_progress',
          stepData: { 'compliance-questions': { sourceOfFunds: 'salary' } },
        }),
      });
      withCustomStep(h, [
        {
          id: 'f-9',
          name: 'sourceOfFunds',
          label: 'Source of Funds',
          type: 'text',
          required: true,
        },
      ]);

      await expect(h.client.submit(1000001)).resolves.toBeDefined();
    });

    /** Whitespace is not an answer — the same rule the personal fields use. */
    it('treats a blank answer as missing', async () => {
      const h = build({
        stored: completeSubmission({
          status: 'in_progress',
          stepData: { 'compliance-questions': { sourceOfFunds: '   ' } },
        }),
      });
      withCustomStep(h, [
        {
          id: 'f-9',
          name: 'sourceOfFunds',
          label: 'Source of Funds',
          type: 'text',
          required: true,
        },
      ]);

      await expect(h.client.submit(1000001)).rejects.toThrow(/Source of Funds/);
    });

    it('leaves OPTIONAL custom fields optional', async () => {
      const h = build({ stored: completeSubmission({ status: 'in_progress' }) });
      withCustomStep(h, [
        { id: 'f-9', name: 'note', label: 'Note', type: 'text', required: false },
      ]);

      await expect(h.client.submit(1000001)).resolves.toBeDefined();
    });

    it('ignores a DISABLED custom step entirely', async () => {
      const h = build({ stored: completeSubmission({ status: 'in_progress' }) });
      h.kycConfig.getSteps.mockResolvedValue([
        ...defaultSteps(),
        {
          id: 'step-9',
          stepNumber: 9,
          slug: 'compliance-questions',
          title: 'Compliance Questions',
          enabled: false,
          fields: [
            {
              id: 'f-9',
              name: 'sourceOfFunds',
              label: 'Source of Funds',
              type: 'text',
              required: true,
            },
          ],
        },
      ]);

      await expect(h.client.submit(1000001)).resolves.toBeDefined();
    });

    /*
     * The guard the old `Unknown step` error was really providing. `saveStep` is
     * client-facing, so accepting any non-canonical slug would let a caller
     * write arbitrary keys into a jsonb column nothing displays and nothing
     * bounds.
     */
    it('refuses a slug the configuration does not name', async () => {
      const h = build({ stored: submission({ status: 'in_progress' }) });
      await expect(h.client.saveStep(1000001, 'not-configured', { x: '1' })).rejects.toThrow(
        /unknown step/i,
      );
      expect(h.kycStore.update).not.toHaveBeenCalled();
    });

    it('refuses a custom step the broker has disabled', async () => {
      const h = build({ stored: submission({ status: 'in_progress' }) });
      h.kycConfig.getSteps.mockResolvedValue([
        ...defaultSteps(),
        {
          id: 's9',
          stepNumber: 9,
          slug: 'compliance-questions',
          title: 'C',
          enabled: false,
          fields: [],
        },
      ]);
      await expect(h.client.saveStep(1000001, 'compliance-questions', { x: '1' })).rejects.toThrow(
        /unknown step/i,
      );
    });

    /** `review` renders answers already given; it collects nothing. */
    it('refuses to save answers against the review step', async () => {
      const h = build({ stored: submission({ status: 'in_progress' }) });
      await expect(h.client.saveStep(1000001, 'review', { x: '1' })).rejects.toThrow(
        /does not collect answers/i,
      );
    });
  });

  it('requires all four documents FR-CORE-15 mandates', async () => {
    const cases: Array<[Partial<KycSubmission>, RegExp, User]> = [
      // The personal step is judged on the PROFILE (0139): a client whose
      // profile lost its name owes the step, whatever the submission holds.
      [{ personalInfo: undefined }, /First Name is required/, { ...USER, firstName: '' }],
      [{ document: undefined }, /document front/i, USER],
      [{ selfie: undefined }, /selfie/i, USER],
      [{ addressProof: undefined }, /proof of address/i, USER],
    ];
    for (const [missing, message, user] of cases) {
      const h = build({ stored: completeSubmission(missing), user });
      await expect(h.client.submit(1000001)).rejects.toThrow(message);
    }
  });

  it('accepts a complete submission and stamps submittedAt', async () => {
    const h = build({ stored: completeSubmission() });
    await h.client.submit(1000001);
    // `transition`, not `update`: the states a submission may legitimately be
    // sent FROM go into the WHERE clause, so an approved client calling submit
    // again matches no row instead of demoting themselves to the queue.
    expect(h.kycStore.transition).toHaveBeenCalledWith(
      1000001,
      ['not_started', 'in_progress', 'rejected'],
      expect.objectContaining({ status: 'submitted', submittedAt: expect.any(Date) }),
      expect.anything(),
    );
  });

  it('REFUSES a profile that is present but empty', async () => {
    /*
     * The defect this closes. `submit()` tested `!finalSub.personalInfo` — the
     * truthiness of an object — and `{}` is truthy. So `POST /kyc/step` with
     * `{"data":{}}` followed by three genuine uploads reached the review queue
     * with no name and no date of birth, and an admin approving it raised the
     * account to level 1.
     */
    const h = build({
      stored: completeSubmission({ personalInfo: {} }),
      user: { ...USER, firstName: '', lastName: '', dateOfBirth: undefined },
    });
    // Every missing field named as the client reads it, and each under its own box.
    const refusal = h.client.submit(1000001);
    await expect(refusal).rejects.toThrow(
      /Personal Information is incomplete: First Name, Last Name, Date of Birth/,
    );
    await expect(refusal).rejects.toMatchObject({
      fields: expect.objectContaining({
        firstName: 'First Name is required.',
        dateOfBirth: 'Date of Birth is required.',
      }),
    });
    expect(h.kycStore.transition).not.toHaveBeenCalledWith(
      1000001,
      expect.anything(),
      expect.objectContaining({ status: 'submitted' }),
    );
  });

  it('REFUSES a client under the minimum age', async () => {
    // "Must be 18+" was a hint string in the seeded config and a check in the
    // browser. A broker onboarding a minor is a licensing matter, so the rule
    // belongs on the server.
    const under18 = new Date();
    under18.setFullYear(under18.getFullYear() - 14);
    // Stored straight into the row, past the profile's own age rule — the
    // submission must refuse it anyway, whoever wrote it.
    const h = build({
      stored: completeSubmission(),
      user: { ...USER, dateOfBirth: under18.toISOString().slice(0, 10) },
    });
    await expect(h.client.submit(1000001)).rejects.toThrow(/at least 18 years old/i);
  });

  it('names which profile fields are missing, so the client can fix them', async () => {
    const h = build({
      stored: completeSubmission(),
      user: { ...USER, lastName: '' },
    });
    // Naming them is the difference between a form the client can complete and
    // one that just says no — by the label they see, under the field it is about.
    const refusal = h.client.submit(1000001);
    await expect(refusal).rejects.toThrow('Last Name is required.');
    await expect(refusal).rejects.toMatchObject({ fields: { lastName: 'Last Name is required.' } });
  });

  it('refuses an APPROVED client re-submitting, which used to demote them', async () => {
    /*
     * `submit()` wrote `status: 'submitted'` unconditionally and never touched
     * `verificationLevel`. So an approved client calling this again landed on
     * `submitted` WITH level 1 still granted — in the review queue and able to
     * withdraw at the same time. That is the divergence `reject()` claws the
     * level back to prevent, reached by a route it does not cover.
     */
    const h = build({ stored: completeSubmission({ status: 'approved' }) });
    await expect(h.client.submit(1000001)).rejects.toThrow(/already approved/i);
  });

  it('refuses a re-submit while already in the queue', async () => {
    // Also stops a client bouncing a claimed row out of `under_review` from
    // under the reviewer holding it.
    const h = build({ stored: completeSubmission({ status: 'under_review' }) });
    await expect(h.client.submit(1000001)).rejects.toThrow(/already been submitted/i);
  });

  it('CLEARS the previous rejection when resubmitting', async () => {
    // A resubmission starts a fresh review. Stale rejection text following it
    // into the queue tells the next reviewer to reject it again.
    const h = build({
      stored: completeSubmission({
        status: 'rejected',
        rejectionReason: 'Date of birth does not match the passport',
        // A TYPED field: a returned DOCUMENT must be replaced before the
        // submission can go back at all — pinned in its own block below.
        rejectedFields: ['dateOfBirth'],
      }),
    });
    await h.client.submit(1000001);
    expect(h.kycStore.transition).toHaveBeenCalledWith(
      1000001,
      // `rejected` is in the allowed set precisely so this resubmission works.
      expect.arrayContaining(['rejected']),
      expect.objectContaining({ rejectionReason: undefined, rejectedFields: undefined }),
      expect.anything(),
    );
  });
});

describe('saveStep stores only what the step asks for', () => {
  /*
   * Reported from production: the portal's review screen posted its WHOLE form
   * as the personal step, and the reviewer read "Doc Choice Document",
   * "Custom Field 1790263652846: [object Object]" beside the client's name.
   * The same merge accepted FILE PATHS into the document columns.
   */
  it('drops the review screen’s whole form from the personal step', async () => {
    const h = build({ stored: submission({ status: 'in_progress' }) });
    await h.client.saveStep(1000001, 'personal', {
      firstName: 'Jane',
      __docChoice__document: 'passport',
      customField_1790263652846: '[object Object]',
      customField_1790263641710: 'Acme',
      docType: 'passport',
    });
    // The name went to the profile; none of the rest was the step's to keep.
    expect(h.kycStore.update).toHaveBeenCalledWith(
      1000001,
      expect.objectContaining({ personalInfo: {} }),
      expect.anything(),
    );
    expect(h.profileRow.firstName).toBe('Jane');
  });

  it('never writes a file path through a step — only the upload route stores files', async () => {
    const h = build({
      stored: submission({
        status: 'in_progress',
        document: { docType: 'passport', frontFilePath: 'uploads/kyc/mine.jpg' },
      }),
    });
    await h.client.saveStep(1000001, 'document', {
      docType: 'passport',
      frontFilePath: 'uploads/kyc/someone-else.jpg',
      backFilePath: 'uploads/kyc/someone-else-2.jpg',
    });
    // The same document again writes NOTHING to the column — so there is no
    // write for a smuggled path to ride on, and the client's own file stays.
    const patch = h.kycStore.update.mock.calls[0][1];
    expect(patch).not.toHaveProperty('document');
    expect(JSON.stringify(patch)).not.toContain('someone-else');
  });

  it('does not let a blank choice erase the document already chosen', async () => {
    const h = build({ stored: submission({ document: { docType: 'national_id' } }) });
    await h.client.saveStep(1000001, 'document', { docType: '' });
    expect(h.kycStore.update.mock.calls[0][1]).not.toHaveProperty('document');
  });

  it('refuses a document of the other category', async () => {
    const h = build({ stored: submission({ document: { docType: 'national_id' } }) });
    await h.client.saveStep(1000001, 'document', { docType: 'utility_bill' });
    expect(h.kycStore.update.mock.calls[0][1]).not.toHaveProperty('document');
  });

  it('refuses an incomplete phone number, naming the field', async () => {
    const h = build();
    await expect(h.client.saveStep(1000001, 'personal', { phone: '+961 70 12' })).rejects.toThrow(
      /Phone Number is incomplete/,
    );
    expect(h.kycStore.update).not.toHaveBeenCalled();
  });

  it('reads a bare country code as a CLEARED number — shown and saved agree', async () => {
    // A client who clears the number down to its prefix has cleared it: the
    // profile holds no phone, rather than a "+961" nobody can dial — and not the
    // OLD number the screen no longer shows. The accidental case (a prefix
    // emitted while picking a country) is the portal's to never autosave.
    const h = build({ user: { ...USER, phone: '+96170123456' } });
    await h.client.saveStep(1000001, 'personal', { phone: '+961' });
    expect(h.profileRow.phone).toBeNull();
  });

  it('sends only what CHANGED to the profile — an untouched value is never re-judged', async () => {
    // A value stored before today's rules must not block a client who did not touch it.
    const h = build({ user: { ...USER, city: 'beirut 1!' } });
    await h.client.saveStep(1000001, 'personal', { city: 'beirut 1!', lastName: 'Smith' });
    expect(h.profileRow.lastName).toBe('Smith');
    expect(h.profileRow.city).toBe('beirut 1!');
  });

  it('cannot forge a stored file into a custom step', async () => {
    const h = build({ stored: submission({ status: 'in_progress' }) });
    h.kycConfig.getSteps.mockResolvedValue([
      ...defaultSteps(),
      {
        id: 'step-9',
        stepNumber: 9,
        slug: 'source-of-funds',
        title: 'Source of funds',
        description: '',
        icon: '',
        enabled: true,
        fields: [
          { id: 'f-a', name: 'payslip', label: 'Payslip', type: 'file', required: true },
          { id: 'f-b', name: 'employer', label: 'Employer', type: 'text', required: false },
        ],
      },
    ]);
    await h.client.saveStep(1000001, 'source-of-funds', {
      payslip: { filePath: 'uploads/kyc/someone-else.jpg' },
      employer: 'Acme',
    });
    expect(h.kycStore.update).toHaveBeenCalledWith(
      1000001,
      expect.objectContaining({ stepData: { 'source-of-funds': { employer: 'Acme' } } }),
      expect.anything(),
    );
  });
});

describe('a returned answer is settled by changing it', () => {
  it('drops the flag of a field whose value changed, and keeps the rest', async () => {
    const h = build({
      stored: submission({
        status: 'rejected',
        rejectedFields: ['dateOfBirth', 'firstName', 'doc_front'],
      }),
    });
    await h.client.saveStep(1000001, 'personal', {
      firstName: 'Jane',
      dateOfBirth: '1991-02-02',
    });
    expect(h.kycStore.update).toHaveBeenCalledWith(
      1000001,
      expect.objectContaining({ rejectedFields: ['firstName', 'doc_front'] }),
      expect.anything(),
    );
  });

  it('keeps every flag when nothing changed — re-saving is not an answer', async () => {
    const h = build({
      stored: submission({ status: 'rejected', rejectedFields: ['dateOfBirth'] }),
    });
    await h.client.saveStep(1000001, 'personal', { dateOfBirth: '1990-01-01' });
    expect(h.kycStore.update.mock.calls[0][1]).not.toHaveProperty('rejectedFields');
  });
});

describe('an upload says which document its page belongs to', () => {
  /*
   * Reported from production: a passport shown as uploaded for the national ID
   * and driving licence. Every identity document shares one column, the type
   * was GUESSED as passport on upload, and only Continue corrected it.
   */
  const upload = (h: ReturnType<typeof build>, field: string, name: string, docType?: string) =>
    h.client.attachFile(1000001, field, `uploads/kyc/${name}`, docType);

  it('starts the document afresh when the page is of a DIFFERENT document', async () => {
    const h = build({
      stored: submission({
        document: {
          docType: 'national_id',
          frontFilePath: 'uploads/kyc/id-front.jpg',
          backFilePath: 'uploads/kyc/id-back.jpg',
        },
      }),
    });
    await upload(h, 'doc_front', 'passport.jpg', 'passport');
    const patch = h.kycStore.update.mock.calls[0][1];
    expect(patch.document).toEqual({
      docType: 'passport',
      frontFilePath: 'uploads/kyc/passport.jpg',
    });
  });

  it('keeps the other page of the SAME document', async () => {
    const h = build({
      stored: submission({
        document: {
          docType: 'national_id',
          frontFilePath: 'uploads/kyc/id-front.jpg',
        },
      }),
    });
    await upload(h, 'doc_back', 'id-back.jpg', 'national_id');
    expect(h.kycStore.update.mock.calls[0][1].document).toEqual({
      docType: 'national_id',
      frontFilePath: 'uploads/kyc/id-front.jpg',
      backFilePath: 'uploads/kyc/id-back.jpg',
    });
  });

  it('never invents a type for an untyped upload — the guessed "passport" was the bug', async () => {
    const h = build();
    await upload(h, 'doc_front', 'front.jpg');
    const document = h.kycStore.update.mock.calls[0][1].document;
    expect(document).toEqual({
      frontFilePath: 'uploads/kyc/front.jpg',
    });
    expect(document).not.toHaveProperty('docType');
  });

  it('deletes the pages of the document the client moved away from — nothing orphaned', async () => {
    const h = build({
      stored: submission({
        document: {
          docType: 'national_id',
          frontFilePath: 'uploads/kyc/id-front.jpg',
          backFilePath: 'uploads/kyc/id-back.jpg',
        },
      }),
    });
    await upload(h, 'doc_front', 'passport.jpg', 'passport');
    expect(h.storage.registry.deleted.map((d) => d.storageKey).sort()).toEqual([
      'kyc/id-back.jpg',
      'kyc/id-front.jpg',
    ]);
  });

  it('keeps a replaced page a decided attempt still holds — that is evidence', async () => {
    const h = build({
      stored: submission({
        status: 'rejected',
        document: {
          docType: 'national_id',
          frontFilePath: 'uploads/kyc/id-front.jpg',
          backFilePath: 'uploads/kyc/id-back.jpg',
        },
      }),
    });
    h.kycStore.archivedDocumentPaths.mockResolvedValue(['uploads/kyc/id-front.jpg']);
    await upload(h, 'doc_front', 'id-front-2.jpg', 'national_id');
    expect(h.storage.registry.deleted).toEqual([]);
    await upload(h, 'doc_back', 'id-back-2.jpg', 'national_id');
    expect(h.storage.registry.deleted.map((d) => d.storageKey)).toEqual(['kyc/id-back.jpg']);
  });

  it('refuses a document the broker does not accept', async () => {
    const h = build();
    h.kycConfig.getSteps.mockResolvedValue(
      defaultSteps().map((step) =>
        step.slug === 'document'
          ? { ...step, fields: step.fields.filter((f) => f.type !== 'doc:residence_permit') }
          : step,
      ),
    );
    await expect(upload(h, 'doc_front', 'permit.jpg', 'residence_permit')).rejects.toThrow(
      /Residence Permit is not a document this verification accepts/,
    );
    expect(h.kycStore.update).not.toHaveBeenCalled();
  });

  it('refuses an upload to a step the broker has switched off', async () => {
    const h = build();
    h.kycConfig.getSteps.mockResolvedValue(
      defaultSteps().map((step) => (step.slug === 'address' ? { ...step, enabled: false } : step)),
    );
    await expect(upload(h, 'address_proof', 'bill.jpg', 'utility_bill')).rejects.toThrow(
      /Proof of Address is not part of this verification/,
    );
    expect(h.kycStore.update).not.toHaveBeenCalled();
  });

  it('refuses an address document in an identity slot', async () => {
    const h = build();
    await expect(upload(h, 'doc_front', 'bill.jpg', 'utility_bill')).rejects.toThrow(
      ValidationError,
    );
    expect(h.kycStore.update).not.toHaveBeenCalled();
  });

  it('stores page two as page two, not as both pages', async () => {
    const h = build();
    await upload(h, 'address_proof_2', 'page2.jpg', 'tenancy_agreement');
    expect(h.kycStore.update.mock.calls[0][1].addressProof).toEqual({
      docType: 'tenancy_agreement',
      page2FilePath: 'uploads/kyc/page2.jpg',
    });
  });

  it('settles the flag of the page it replaces, and leaves typed flags alone', async () => {
    const h = build({
      stored: submission({
        status: 'rejected',
        document: { docType: 'passport', frontFilePath: 'uploads/kyc/old.jpg' },
        rejectedFields: ['doc_front', 'dateOfBirth'],
      }),
    });
    await upload(h, 'doc_front', 'new.jpg', 'passport');
    expect(h.kycStore.update.mock.calls[0][1].rejectedFields).toEqual(['dateOfBirth']);
  });

  it('re-checks the status under the lock — a submission may have gone to review since', async () => {
    const h = build({ stored: submission({ status: 'in_progress' }) });
    h.kycStore.lockForUpdate.mockResolvedValue(submission({ status: 'submitted' }));
    await expect(upload(h, 'doc_front', 'late.jpg', 'passport')).rejects.toThrow(/under review/i);
    expect(h.kycStore.update).not.toHaveBeenCalled();
  });
});

describe('a built-in step holds extra fields, and ONE judge decides every step', () => {
  /*
   * Reported from local testing: a required File field on Proof of Address
   * ("prooof3") that let the client continue without it — the step had nowhere
   * to keep it, so nothing could check it. And the week before: the portal and
   * `submit` judging completeness separately, and disagreeing.
   */
  const withExtras = (h: ReturnType<typeof build>) =>
    h.kycConfig.getSteps.mockResolvedValue(
      defaultSteps().map((step) =>
        step.slug === 'address'
          ? {
              ...step,
              fields: [
                {
                  id: 'f-u',
                  name: 'utilityBill',
                  label: 'Utility Bill',
                  type: 'doc:utility_bill',
                  required: false,
                },
                { id: 'f-l', name: 'prooof3', label: 'Lease', type: 'file', required: true },
                { id: 'f-n', name: 'note', label: 'Landlord', type: 'text', required: true },
              ],
            }
          : step,
      ),
    );

  it('saves an extra answer under the step’s slug, and answers with every step’s state', async () => {
    const h = build({ stored: completeSubmission() });
    withExtras(h);
    const saved = await h.client.saveStep(1000001, 'address', {
      docType: 'utility_bill',
      note: ' Mr Haddad ',
    });
    expect(h.kycStore.update).toHaveBeenCalledWith(
      1000001,
      expect.objectContaining({ stepData: { address: { note: 'Mr Haddad' } } }),
      expect.anything(),
    );
    const address = saved.steps.find((state) => state.slug === 'address')!;
    expect(address.missing).toEqual([{ id: 'prooof3', label: 'Lease', kind: 'upload' }]);
  });

  it('accepts an upload into an extra File field on a built-in step', async () => {
    const h = build({ stored: completeSubmission() });
    withExtras(h);
    await h.client.attachFile(1000001, 'prooof3', 'uploads/kyc/lease.png');
    expect(h.kycStore.update).toHaveBeenCalledWith(
      1000001,
      expect.objectContaining({
        stepData: {
          address: { prooof3: { filePath: 'uploads/kyc/lease.png' } },
        },
      }),
      expect.anything(),
    );
  });

  it('will not submit without a required extra — named by its label, on its step', async () => {
    const h = build({ stored: completeSubmission() });
    withExtras(h);
    await expect(h.client.submit(1000001)).rejects.toThrow(
      /Address is incomplete: Lease, Landlord\./,
    );
  });

  it('submits once the extras are there', async () => {
    const h = build({
      stored: completeSubmission({
        stepData: {
          address: {
            prooof3: { filePath: 'uploads/kyc/l.png' },
            note: 'Mr Haddad',
          },
        },
      }),
    });
    withExtras(h);
    await expect(h.client.submit(1000001)).resolves.toBeDefined();
  });

  it('NEVER relabels the pages on file when the client picks another document — it judges the choice', async () => {
    // A passport on file; the client clicked National ID and pressed Continue.
    const h = build({ stored: completeSubmission() });
    const saved = await h.client.saveStep(1000001, 'document', { docType: 'national_id' });
    const patch = h.kycStore.update.mock.calls[0][1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('document');
    expect(
      saved.steps.find((state) => state.slug === 'document')!.missing.map((m) => m.label),
    ).toEqual(['National ID: Front Side', 'National ID: Back Side']);
  });

  it('records a document chosen before anything is on file', async () => {
    const h = build({ stored: completeSubmission({ document: undefined }) });
    await h.client.saveStep(1000001, 'document', { docType: 'national_id' });
    expect(h.kycStore.update).toHaveBeenCalledWith(
      1000001,
      expect.objectContaining({ document: { docType: 'national_id' } }),
      expect.anything(),
    );
  });

  it('serves every step’s state with the status', async () => {
    const h = build({ stored: completeSubmission({ selfie: undefined }) });
    const status = await h.client.getStatus(1000001);
    expect(status.steps.map((state) => [state.slug, state.complete])).toEqual([
      ['personal', true],
      ['document', true],
      ['selfie', false],
      ['address', true],
    ]);
  });
});

describe('submit asks for every page and every returned document', () => {
  it('refuses a national ID without its back — half a card', async () => {
    const h = build({
      stored: completeSubmission({
        document: { docType: 'national_id', frontFilePath: 'uploads/kyc/front.png' },
      }),
    });
    await expect(h.client.submit(1000001)).rejects.toThrow(/National ID: Back Side is required/);
  });

  it('refuses while a RETURNED document has not been replaced, naming it', async () => {
    const h = build({
      stored: completeSubmission({
        status: 'rejected',
        rejectionReason: 'The passport photo is blurred',
        rejectedFields: ['doc_front'],
      }),
    });
    await expect(h.client.submit(1000001)).rejects.toThrow(
      /replace the documents the reviewer returned: Passport\./,
    );
    expect(h.kycStore.transition).not.toHaveBeenCalled();
  });

  it('accepts it once the returned document is replaced', async () => {
    const h = build({
      stored: completeSubmission({
        status: 'rejected',
        rejectionReason: 'The passport photo is blurred',
        rejectedFields: [],
      }),
    });
    await expect(h.client.submit(1000001)).resolves.toBeDefined();
  });

  it('forgives a returned document on a step the broker has since disabled', async () => {
    const h = build({
      stored: completeSubmission({ status: 'rejected', rejectedFields: ['selfie'] }),
    });
    h.kycConfig.getSteps.mockResolvedValue(
      defaultSteps().map((step) => (step.slug === 'selfie' ? { ...step, enabled: false } : step)),
    );
    await expect(h.client.submit(1000001)).resolves.toBeDefined();
  });

  it('refuses a phone the form REQUIRES and the profile does not hold — and not an optional one', async () => {
    // "+961" can no longer be stored at all (the profile keeps a dialable number
    // or none), so what reaches submission is the absence.
    const h = build({ stored: completeSubmission(), user: { ...USER, phone: undefined } });
    await expect(h.client.submit(1000001)).rejects.toThrow(/Phone Number is required/);

    // Phase 2: the broker made it optional — the absence is no longer owed.
    const optional = build({ stored: completeSubmission(), user: { ...USER, phone: undefined } });
    optional.kycConfig.getSteps.mockResolvedValue(
      defaultSteps().map((step) =>
        step.slug === 'personal'
          ? {
              ...step,
              fields: step.fields.map((f) => (f.name === 'phone' ? { ...f, required: false } : f)),
            }
          : step,
      ),
    );
    await expect(optional.client.submit(1000001)).resolves.toBeDefined();
  });

  it('announces a correction as a RESUBMISSION even after a step was saved', async () => {
    /*
     * Saving any step moves a returned submission to `in_progress`, and the
     * status was the only thing read — so a client who fixed one field before
     * resubmitting reached the reviewers as a brand-new submission.
     */
    const h = build({
      stored: completeSubmission({ status: 'in_progress', rejectionReason: 'Blurred passport' }),
    });
    await h.client.submit(1000001);
    expect(h.notifications.notifyAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'admin.kyc.resubmitted',
        subject: { id: '1000001', clientId: 1000001 },
      }),
    );
  });
});

describe('claim', () => {
  it('refuses a submission that is not submitted', async () => {
    const h = build({ stored: submission({ status: 'in_progress' }) });
    await expect(h.review.claim(1000001, 'admin-1')).rejects.toThrow(ValidationError);
  });

  it('refuses one already under review, and says so', async () => {
    // Two reviewers working the same submission is the thing claiming prevents.
    const h = build({ stored: submission({ status: 'under_review' }) });
    await expect(h.review.claim(1000001, 'admin-1')).rejects.toThrow(/already being reviewed/i);
  });

  it('claims a submitted one for the reviewing admin', async () => {
    const h = build({ stored: submission({ status: 'submitted' }) });
    await h.review.claim(1000001, 'admin-1');
    // Conditional on still being `submitted`, so two admins clicking Review at
    // once cannot both take the row.
    expect(h.kycStore.transition).toHaveBeenCalledWith(1000001, ['submitted'], {
      status: 'under_review',
      reviewedBy: 'admin-1',
    });
  });

  it('refuses the SECOND reviewer when two claim at once', async () => {
    /*
     * The race H1 named: both admins read `submitted`, both passed the check,
     * and the second silently took ownership of a row the first was reading.
     * The store fake honours the `from` precondition, so a row that has already
     * moved to `under_review` matches nothing.
     */
    const h = build({ stored: submission({ status: 'under_review' }) });
    await expect(h.review.claim(1000001, 'admin-2')).rejects.toThrow(/already being reviewed/i);
  });

  it('refuses when there is no submission at all', async () => {
    const h = build();
    h.kycStore.findByUserId.mockResolvedValue(undefined);
    await expect(h.review.claim(1000001, 'admin-1')).rejects.toThrow(NotFoundError);
  });
});

describe('a submission another reviewer is holding', () => {
  /*
   * ## What a claim was worth before this
   *
   * Nothing enforceable. `approve` accepted a transition out of `under_review`
   * without asking who held it, so two reviewers could open the same passport
   * and whoever clicked second decided it — taking the claim with them.
   * Nothing told the first: their screen still showed a submission they
   * believed was theirs, and `reviewed_by` now named somebody else.
   *
   * On a compliance desk that is worse than a wasted afternoon. A claim exists
   * so two people do not verify one identity in parallel and reach different
   * answers, and the audit trail should name one reviewer per decision —
   * because that is the person who will be asked to account for it.
   */
  const heldByAnother = () => completeSubmission({ status: 'under_review', reviewedBy: 'admin-2' });

  it('refuses an APPROVE by a different admin, and names the holder', async () => {
    const h = build({ stored: heldByAnother() });
    // Named, not "someone else": a refusal without a name leaves the reader one
    // option, which is to interrupt the whole desk to find out who.
    await expect(h.review.approve(1000001, 'admin-1')).rejects.toThrow(/Sarah Chen/);
    expect(h.kycStore.transition).not.toHaveBeenCalled();
  });

  it('refuses a REJECT by a different admin too', async () => {
    const h = build({ stored: heldByAnother() });
    await expect(h.review.reject(1000001, 'admin-1', 'Blurry')).rejects.toThrow(/Sarah Chen/);
    expect(h.kycStore.transition).not.toHaveBeenCalled();
  });

  it('lets the HOLDER decide their own claim', async () => {
    const h = build({ stored: heldByAnother() });
    await expect(h.review.approve(1000001, 'admin-2')).resolves.toBeDefined();
  });

  /*
   * The ordinary path must stay frictionless. Requiring a claim before every
   * decision would be friction on the common case to fix a problem that only
   * exists on the contested one.
   */
  it('leaves an UNCLAIMED submission decidable by anyone', async () => {
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    await expect(h.review.approve(1000001, 'admin-1')).resolves.toBeDefined();
  });

  /*
   * ⚠️ THE CHECK ABOVE IS NOT THE ENFORCEMENT, and this pins the difference.
   *
   * Two reviewers who both READ before either WRITES both pass the service
   * check — that is the same TOCTOU the `from` status argument already exists
   * to close. What decides is `unheldOrHeldBy` in `transition`'s WHERE clause,
   * so the database picks one winner.
   *
   * Asserting the argument is reached for is the only way a unit test over a
   * stubbed store can say that; the race itself is proven against real Postgres
   * in `test/kyc-gates-money.spec.ts`.
   */
  it('puts the holder into the WHERE clause, not only into the read', async () => {
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    await h.review.approve(1000001, 'admin-1');

    const call = h.kycStore.transition.mock.calls[0];
    expect(call[1]).toEqual(['submitted', 'under_review']);
    // 5th argument — the claim guard.
    expect(call[4]).toBe('admin-1');
  });

  it('falls back to an anonymous refusal when the holder has been deleted', async () => {
    const h = build({ stored: heldByAnother() });
    h.admins.namesByIds.mockResolvedValueOnce(new Map());
    await expect(h.review.approve(1000001, 'admin-1')).rejects.toThrow(/Another reviewer/);
  });
});

describe('approve', () => {
  it('re-asks the one judge, and REFUSES a record it finds incomplete', async () => {
    // Approval raises the money gate. A record that lost its city, or never had
    // an identity document, is not approvable — whatever its status says.
    const h = build({
      stored: completeSubmission({ status: 'submitted', document: undefined }),
      user: { ...USER, city: undefined },
    });
    const refusal = h.review.approve(1000001, 'admin-1');
    await expect(refusal).rejects.toThrow(ConflictError);
    await expect(refusal).rejects.toThrow(/City/);
    expect(h.users.update).not.toHaveBeenCalled();
    expect(h.kycStore.transition).not.toHaveBeenCalled();
  });

  it('does NOT refuse over a question of the broker’s added after the client submitted', async () => {
    // The broker's own questions were judged at submission; approval re-asks
    // only what the verification rests on, or one builder change would strand
    // every review already waiting.
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    h.kycConfig.getSteps.mockResolvedValue([
      ...defaultSteps(),
      {
        id: 'step-sof',
        slug: 'source-of-funds',
        title: 'Source of funds',
        description: '',
        icon: 'FileText',
        stepNumber: 5,
        enabled: true,
        fields: [
          { id: 'q-1', name: 'customField_sof', label: 'Employer', type: 'text', required: true },
        ],
      },
    ]);
    await expect(h.review.approve(1000001, 'admin-1')).resolves.toBeDefined();
    expect(h.users.update).toHaveBeenCalledWith(
      1000001,
      { verificationLevel: 1 },
      expect.anything(),
    );
  });

  it('raises the client to verification level 1', async () => {
    // This is the line that unlocks withdrawals.
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    await h.review.approve(1000001, 'admin-1');
    // The third argument is the transaction the decision runs in — the level and
    // the status land together or not at all.
    expect(h.users.update).toHaveBeenCalledWith(
      1000001,
      { verificationLevel: 1 },
      expect.anything(),
    );
  });

  it('records who approved it and when', async () => {
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    await h.review.approve(1000001, 'admin-1');
    // `transition`, not `update`: the expected status goes into the WHERE, so
    // two reviewers racing cannot both write.
    expect(h.kycStore.transition).toHaveBeenCalledWith(
      1000001,
      ['submitted', 'under_review'],
      expect.objectContaining({
        status: 'approved',
        reviewedBy: 'admin-1',
        reviewedAt: expect.any(Date),
      }),
      expect.anything(),
      // The claim guard: the WHERE also requires the row to be unclaimed or
      // claimed by this admin, so a colleague's open submission cannot be
      // decided out from under them.
      'admin-1',
    );
  });

  it('emails the client the decision', async () => {
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    await h.review.approve(1000001, 'admin-1');
    expect(h.email.sendKycDecisionEmail).toHaveBeenCalledWith(
      USER.email,
      USER.firstName,
      'approved',
      undefined,
      undefined,
      undefined,
    );
  });

  /*
   * An ADMIN decision is written in the language the CLIENT stored, never the
   * request's — the console sends no locale, so the request is always English.
   */
  it("emails the decision in the client's STORED language", async () => {
    const h = build({
      stored: completeSubmission({ status: 'submitted' }),
      user: { ...USER, locale: 'ar' },
    });
    await h.review.approve(1000001, 'admin-1');
    expect(h.email.sendKycDecisionEmail).toHaveBeenCalledWith(
      USER.email,
      USER.firstName,
      'approved',
      undefined,
      undefined,
      'ar',
    );
  });

  it('refuses when there is no submission', async () => {
    const h = build();
    h.kycStore.findByUserId.mockResolvedValue(undefined);
    await expect(h.review.approve(1000001, 'admin-1')).rejects.toThrow(NotFoundError);
    expect(h.users.update).not.toHaveBeenCalled();
  });

  it('REFUSES to approve a submission the client never submitted', async () => {
    // Otherwise an admin can raise someone to level 1 — unlocking withdrawals —
    // for an account that has uploaded no documents at all. Approval must be a
    // decision about evidence, and there is none in `not_started`.
    for (const status of ['not_started', 'in_progress'] as const) {
      const h = build({ stored: submission({ status }) });
      await expect(h.review.approve(1000001, 'admin-1')).rejects.toThrow();
      expect(h.users.update).not.toHaveBeenCalled();
    }
  });

  it('does not raise the verification level if recording the decision fails', async () => {
    // If the status write fails, the level must not move — otherwise the client
    // is verified with no approved submission behind them, which is the state
    // that lets money leave on the strength of nothing.
    //
    // This used to rest on ORDERING (status first, level second) and a comment
    // arguing the crash window was harmless. It now rests on a transaction, and
    // this asserts the observable consequence either way.
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    h.kycStore.transition.mockRejectedValue(new Error('db down'));
    await expect(h.review.approve(1000001, 'admin-1')).rejects.toThrow();
    expect(h.users.update).not.toHaveBeenCalled();
  });

  it('REFUSES when another reviewer changed the submission first', async () => {
    /*
     * The race the conditional write closes.
     *
     * Two admins hitting approve and reject in the same tick both used to pass
     * their check against the same `submitted` row and both write, last writer
     * winning. Interleaved with the separate level write, that could land as
     * `status: 'rejected'` + `verificationLevel: 1` — refused on paper, able to
     * withdraw in fact.
     *
     * `transition()` returning undefined IS "somebody got there first".
     */
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    h.kycStore.transition.mockResolvedValue(undefined);

    await expect(h.review.approve(1000001, 'admin-1')).rejects.toThrow(/another reviewer/i);
    expect(h.users.update).not.toHaveBeenCalled();
    expect(h.kycStore.archiveAttempt).not.toHaveBeenCalled();
  });
});

describe('reject', () => {
  it('records the reason and the flagged fields', async () => {
    const h = build({ stored: completeSubmission({ status: 'under_review' }) });
    await h.review.reject(1000001, 'admin-1', 'Blurry document', ['doc_front']);
    expect(h.kycStore.transition).toHaveBeenCalledWith(
      1000001,
      expect.arrayContaining(['submitted', 'under_review']),
      expect.objectContaining({
        status: 'rejected',
        rejectionReason: 'Blurry document',
        rejectedFields: ['doc_front'],
      }),
      expect.anything(),
      'admin-1',
    );
  });

  it('emails the client the reason so they can correct and resubmit', async () => {
    const h = build({ stored: completeSubmission({ status: 'under_review' }) });
    await h.review.reject(1000001, 'admin-1', 'Blurry document', ['doc_front', 'lastName']);
    // Named as every screen names them — never `doc_front`.
    expect(h.email.sendKycDecisionEmail).toHaveBeenCalledWith(
      USER.email,
      USER.firstName,
      'rejected',
      'Blurry document',
      ['Passport', 'Last Name'],
      undefined,
      // No Arabic was written with it (0179).
      null,
    );
  });

  it('TAKES BACK verification level 1 when rejecting a previously approved client', async () => {
    // approve() raises the level; reject() must lower it, or an admin who
    // approves by mistake and then rejects leaves the client verified — and
    // verification is what gates withdrawals. The status says rejected while
    // the money path says go ahead.
    const h = build({
      stored: completeSubmission({ status: 'approved' }),
      user: { ...USER, verificationLevel: 1 },
    });
    await h.review.reject(1000001, 'admin-1', 'Approved in error', []);
    expect(h.users.update).toHaveBeenCalledWith(
      1000001,
      { verificationLevel: 0 },
      expect.anything(),
    );
  });

  it('refuses when there is no submission', async () => {
    const h = build();
    h.kycStore.findByUserId.mockResolvedValue(undefined);
    await expect(h.review.reject(1000001, 'admin-1', 'x')).rejects.toThrow(NotFoundError);
  });
});

describe('getByUserId — what a reviewer may see', () => {
  /*
   * REGRESSION. This returned `{ ...submission, user }` with the WHOLE user
   * record, so every admin opening a KYC submission received that client's
   * `password_hash` — plus their refresh-token hash and password-reset hash.
   *
   * A reviewer needs to know who they are looking at, to match a name against a
   * passport. They never need that person's credentials. Same shape of defect as
   * the portal's sanitize() deny-list, in a different file.
   */
  const LEAKY = {
    ...USER,
    passwordHash: 'argon2-hash-here',
    refreshToken: 'refresh-hash',
    passwordResetTokenHash: 'reset-hash',
  } as User;

  it('returns none of the client credentials', async () => {
    const h = build({ stored: completeSubmission(), user: LEAKY });
    const serialised = JSON.stringify(await h.review.getByUserId(1000001));
    for (const secret of ['argon2-hash-here', 'refresh-hash', 'reset-hash']) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).not.toMatch(/passwordHash/);
  });

  it('still returns what a reviewer needs to identify the person', async () => {
    // An allow-list that is too tight breaks the review screen instead of
    // leaking — the better failure, but still one.
    const h = build({ stored: completeSubmission(), user: LEAKY });
    const result = (await h.review.getByUserId(1000001)) as { user?: Record<string, unknown> };
    for (const field of ['id', 'email', 'firstName', 'lastName', 'verificationLevel']) {
      expect(result.user?.[field]).toBeDefined();
    }
  });
});

describe('listAll', () => {
  it('clamps the page size, so one request cannot ask for the whole table', async () => {
    const h = build();
    await h.review.listAll({ limit: 100_000 });
    expect(h.kycStore.findPageWithUsers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('never accepts a page below 1', async () => {
    const h = build();
    await h.review.listAll({ page: -5 });
    expect(h.kycStore.findPageWithUsers).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
  });
});

describe('reset judges the LOCKED row', () => {
  it('refuses when a submit committed after an unlocked read said in_progress', async () => {
    const { client, kycStore } = build({ stored: submission({ status: 'in_progress' }) });
    // A submit from another tab won the row lock: the locked row is in review.
    kycStore.lockForUpdate.mockResolvedValueOnce(submission({ status: 'submitted' }));
    await expect(client.resetKyc(1000001)).rejects.toBeInstanceOf(AuthorizationError);
    expect(kycStore.resetUser).not.toHaveBeenCalled();
  });
});

describe('decisions and corrections re-judge under the locks', () => {
  it('approve refuses when the profile changed after the blocker check', async () => {
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    // A desk edit cleared the phone between the pre-check and the locked re-read.
    h.users.findByIdForUpdate.mockResolvedValueOnce({ ...USER, phone: null } as unknown as User);
    await expect(h.review.approve(1000001, 'admin-1')).rejects.toBeInstanceOf(ConflictError);
    expect(h.kycStore.archiveAttempt).not.toHaveBeenCalled();
  });

  it('a correction refuses when an approval landed after its standing was read', async () => {
    const h = build({ stored: completeSubmission({ status: 'under_review' }) });
    // Under the lock the verification is now approved.
    h.kycStore.lockForUpdate.mockResolvedValueOnce(completeSubmission({ status: 'approved' }));
    await expect(
      h.profile.editAsAdmin(
        1000001,
        { address: '' },
        { id: 'admin-1', email: 'a@x.com', kind: 'admin' },
        { mayCorrect: true, reason: 'typo', via: 'admin_edit' },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(h.profileRow.address).toBe('Hamra Street 12');
  });
});
