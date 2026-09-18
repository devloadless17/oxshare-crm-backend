import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storedFilesStub } from './storage-stub';
import { KycService } from '../src/modules/compliance/kyc.service';
import type { KycStore, KycSubmission } from '../src/store/kyc.store';
import type { User, UsersStore } from '../src/store/users.store';
import type { AdminsStore } from '../src/store/admins.store';
import type { EmailService } from '../src/modules/email/email.service';
import type { KycConfigStore } from '../src/store/kyc-config.store';
import type { Db } from '../src/database/db';
import { notificationsStubAs } from './notifications-stub';
import {
  AuthorizationError,
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

function submission(over: Partial<KycSubmission> = {}): KycSubmission {
  return {
    userId: 'user-1',
    status: 'in_progress',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function completeSubmission(over: Partial<KycSubmission> = {}): KycSubmission {
  return submission({
    // `dateOfBirth` is not decoration here: `submit()` validates the profile
    // against the configured required fields and enforces the minimum age
    // (FR-IND-03), so a fixture without it is no longer a COMPLETE submission.
    personalInfo: { firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1990-01-01' },
    document: { docType: 'passport', frontFilePath: '/uploads/front.png' },
    selfie: { filePath: '/uploads/selfie.png' },
    addressProof: { docType: 'utility_bill', filePath: '/uploads/address.png' },
    ...over,
  });
}

const USER = {
  id: 'user-1',
  email: 'client@oxshare.com',
  firstName: 'Jane',
  lastName: 'Doe',
  verificationLevel: 0,
  status: 'active',
} as User;

function build(options: { stored?: KycSubmission; user?: User } = {}) {
  const stored = options.stored ?? submission();
  const kycStore = {
    getOrCreate: vi.fn().mockResolvedValue(stored),
    findByUserId: vi.fn().mockResolvedValue(stored),
    update: vi.fn((_id: string, patch: Partial<KycSubmission>) =>
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
        _id: string,
        from: string[],
        patch: Partial<KycSubmission>,
        _executor?: unknown,
        _unheldOrHeldBy?: string,
      ) => Promise.resolve(from.includes(stored.status) ? { ...stored, ...patch } : undefined),
    ),
    // A decision snapshots the attempt before the next one can overwrite it.
    archiveAttempt: vi.fn().mockResolvedValue(undefined),
    listAttempts: vi.fn().mockResolvedValue([]),
    archivedDocumentPaths: vi.fn().mockResolvedValue([]),
  };
  const users = {
    findById: vi.fn().mockResolvedValue(options.user ?? USER),
    update: vi.fn().mockResolvedValue(options.user ?? USER),
  };
  const email = { sendKycDecisionEmail: vi.fn().mockResolvedValue(undefined) };
  const db = { transaction: (fn: (tx: unknown) => unknown) => fn(db) };

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
    getSteps: vi.fn().mockResolvedValue([
      {
        id: 'step-1',
        stepNumber: 1,
        slug: 'personal',
        title: 'Personal Information',
        enabled: true,
        fields: [
          { id: 'f-1', name: 'firstName', label: 'First Name', type: 'text', required: true },
          { id: 'f-2', name: 'lastName', label: 'Last Name', type: 'text', required: true },
          { id: 'f-3', name: 'dateOfBirth', label: 'Date of Birth', type: 'date', required: true },
        ],
      },
    ]),
  };

  const admins = {
    namesByIds: vi.fn().mockResolvedValue(new Map([['admin-2', 'Sarah Chen']])),
  };

  const service = new KycService(
    email as unknown as EmailService,
    // In-memory storage: this suite asserts the KYC decision rules, not where the
    // bytes live. `deleteDocuments` goes through it, so it has to be callable.
    storedFilesStub(),
    kycStore as unknown as KycStore,
    users as unknown as UsersStore,
    kycConfig as unknown as KycConfigStore,
    /*
     * A transaction stub that just runs the callback.
     *
     * approve/reject now wrap their writes in `db.transaction(...)` so the
     * status, the archived attempt and the verification level land together.
     * These are unit tests over stubbed stores — the atomicity itself is proven
     * against real Postgres in test/kyc-gates-money.spec.ts — so here the
     * transaction only has to be transparent.
     */
    db as unknown as Db,
    notificationsStubAs(),
    /*
     * Appended LAST, matching the constructor.
     *
     * Read ONLY when a decision is refused because another reviewer holds the
     * submission, to name them — so `namesByIds` answering with a populated Map
     * is what lets those cases assert the reviewer's name in the message rather
     * than the anonymous fallback.
     */
    admins as unknown as AdminsStore,
  );
  return { service, kycStore, users, email, kycConfig, admins };
}

beforeEach(() => vi.clearAllMocks());

describe('saveStep', () => {
  it('refuses to edit an approved submission', async () => {
    const h = build({ stored: submission({ status: 'approved' }) });
    await expect(h.service.saveStep('user-1', 'personal', {})).rejects.toThrow(AuthorizationError);
    expect(h.kycStore.update).not.toHaveBeenCalled();
  });

  it('refuses to edit while under review', async () => {
    // Otherwise a client can change the documents an admin is looking at, and
    // the approval records a decision about something else.
    for (const status of ['submitted', 'under_review'] as const) {
      const h = build({ stored: submission({ status }) });
      await expect(h.service.saveStep('user-1', 'personal', {})).rejects.toThrow(
        AuthorizationError,
      );
      expect(h.kycStore.update).not.toHaveBeenCalled();
    }
  });

  it('rejects an unknown step rather than silently dropping the data', async () => {
    const h = build();
    await expect(h.service.saveStep('user-1', 'nonsense', {})).rejects.toThrow(ValidationError);
    expect(h.kycStore.update).not.toHaveBeenCalled();
  });

  it('MERGES into the existing step rather than replacing it', async () => {
    // A client editing one field must not blank the rest of the step.
    const h = build({
      stored: submission({ personalInfo: { firstName: 'Jane', lastName: 'Doe' } }),
    });
    await h.service.saveStep('user-1', 'personal', { phone: '+9715551234' });
    expect(h.kycStore.update).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        personalInfo: { firstName: 'Jane', lastName: 'Doe', phone: '+9715551234' },
      }),
    );
  });

  it('moves a fresh submission to in_progress', async () => {
    const h = build({ stored: submission({ status: 'not_started' }) });
    await h.service.saveStep('user-1', 'personal', { firstName: 'Jane' });
    expect(h.kycStore.update).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ status: 'in_progress' }),
    );
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
      await expect(
        h.service.attachFile('user-1', 'doc_front', 'uploads/kyc/x.jpg', 'x.jpg'),
      ).rejects.toThrow(/under review/i);
      expect(h.kycStore.update).not.toHaveBeenCalled();
    });
  }

  it('refuses an upload once approved', async () => {
    const h = build({ stored: submission({ status: 'approved' }) });
    await expect(
      h.service.attachFile('user-1', 'doc_front', 'uploads/kyc/x.jpg', 'x.jpg'),
    ).rejects.toThrow(/already approved/i);
    expect(h.kycStore.update).not.toHaveBeenCalled();
  });

  it('ALLOWS an upload after rejection, which is the point of that state', async () => {
    const h = build({ stored: submission({ status: 'rejected' }) });
    await h.service.attachFile('user-1', 'doc_front', 'uploads/kyc/x.jpg', 'x.jpg');
    expect(h.kycStore.update).toHaveBeenCalled();
  });
});

describe('submit', () => {
  it('requires all four documents FR-CORE-15 mandates', async () => {
    const cases: Array<[Partial<KycSubmission>, RegExp]> = [
      [{ personalInfo: undefined }, /personal information/i],
      [{ document: undefined }, /document front/i],
      [{ selfie: undefined }, /selfie/i],
      [{ addressProof: undefined }, /proof of address/i],
    ];
    for (const [missing, message] of cases) {
      const h = build({
        stored: completeSubmission(missing),
        user: { ...USER, firstName: '' },
      });
      await expect(h.service.submit('user-1')).rejects.toThrow(message);
    }
  });

  it('accepts a complete submission and stamps submittedAt', async () => {
    const h = build({ stored: completeSubmission() });
    await h.service.submit('user-1');
    // `transition`, not `update`: the states a submission may legitimately be
    // sent FROM go into the WHERE clause, so an approved client calling submit
    // again matches no row instead of demoting themselves to the queue.
    expect(h.kycStore.transition).toHaveBeenCalledWith(
      'user-1',
      ['not_started', 'in_progress', 'rejected'],
      expect.objectContaining({ status: 'submitted', submittedAt: expect.any(Date) }),
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
      stored: completeSubmission({ personalInfo: {} as never }),
      user: { ...USER, firstName: '' },
    });
    await expect(h.service.submit('user-1')).rejects.toThrow(/required before submitting/i);
    expect(h.kycStore.transition).not.toHaveBeenCalledWith(
      'user-1',
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
    const h = build({
      stored: completeSubmission({
        personalInfo: {
          firstName: 'Jane',
          lastName: 'Doe',
          dateOfBirth: under18.toISOString().slice(0, 10),
        },
      }),
    });
    await expect(h.service.submit('user-1')).rejects.toThrow(/at least 18 years old/i);
  });

  it('names which profile fields are missing, so the client can fix them', async () => {
    const h = build({
      stored: completeSubmission({
        personalInfo: { firstName: 'Jane' } as never,
      }),
      user: { ...USER, firstName: '' },
    });
    // Naming them is the difference between a form the client can complete and
    // one that just says no.
    await expect(h.service.submit('user-1')).rejects.toThrow(/lastName/);
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
    await expect(h.service.submit('user-1')).rejects.toThrow(/already approved/i);
  });

  it('refuses a re-submit while already in the queue', async () => {
    // Also stops a client bouncing a claimed row out of `under_review` from
    // under the reviewer holding it.
    const h = build({ stored: completeSubmission({ status: 'under_review' }) });
    await expect(h.service.submit('user-1')).rejects.toThrow(/already been submitted/i);
  });

  it('CLEARS the previous rejection when resubmitting', async () => {
    // A resubmission starts a fresh review. Stale rejection text following it
    // into the queue tells the next reviewer to reject it again.
    const h = build({
      stored: completeSubmission({
        status: 'rejected',
        rejectionReason: 'Document was blurry',
        rejectedFields: ['doc_front'],
      }),
    });
    await h.service.submit('user-1');
    expect(h.kycStore.transition).toHaveBeenCalledWith(
      'user-1',
      // `rejected` is in the allowed set precisely so this resubmission works.
      expect.arrayContaining(['rejected']),
      expect.objectContaining({ rejectionReason: undefined, rejectedFields: undefined }),
    );
  });
});

describe('claim', () => {
  it('refuses a submission that is not submitted', async () => {
    const h = build({ stored: submission({ status: 'in_progress' }) });
    await expect(h.service.claim('user-1', 'admin-1')).rejects.toThrow(ValidationError);
  });

  it('refuses one already under review, and says so', async () => {
    // Two reviewers working the same submission is the thing claiming prevents.
    const h = build({ stored: submission({ status: 'under_review' }) });
    await expect(h.service.claim('user-1', 'admin-1')).rejects.toThrow(/already being reviewed/i);
  });

  it('claims a submitted one for the reviewing admin', async () => {
    const h = build({ stored: submission({ status: 'submitted' }) });
    await h.service.claim('user-1', 'admin-1');
    // Conditional on still being `submitted`, so two admins clicking Review at
    // once cannot both take the row.
    expect(h.kycStore.transition).toHaveBeenCalledWith('user-1', ['submitted'], {
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
    await expect(h.service.claim('user-1', 'admin-2')).rejects.toThrow(/already being reviewed/i);
  });

  it('refuses when there is no submission at all', async () => {
    const h = build();
    h.kycStore.findByUserId.mockResolvedValue(undefined);
    await expect(h.service.claim('user-1', 'admin-1')).rejects.toThrow(NotFoundError);
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
    await expect(h.service.approve('user-1', 'admin-1')).rejects.toThrow(/Sarah Chen/);
    expect(h.kycStore.transition).not.toHaveBeenCalled();
  });

  it('refuses a REJECT by a different admin too', async () => {
    const h = build({ stored: heldByAnother() });
    await expect(h.service.reject('user-1', 'admin-1', 'Blurry')).rejects.toThrow(/Sarah Chen/);
    expect(h.kycStore.transition).not.toHaveBeenCalled();
  });

  it('lets the HOLDER decide their own claim', async () => {
    const h = build({ stored: heldByAnother() });
    await expect(h.service.approve('user-1', 'admin-2')).resolves.toBeDefined();
  });

  /*
   * The ordinary path must stay frictionless. Requiring a claim before every
   * decision would be friction on the common case to fix a problem that only
   * exists on the contested one.
   */
  it('leaves an UNCLAIMED submission decidable by anyone', async () => {
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    await expect(h.service.approve('user-1', 'admin-1')).resolves.toBeDefined();
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
    await h.service.approve('user-1', 'admin-1');

    const call = h.kycStore.transition.mock.calls[0];
    expect(call[1]).toEqual(['submitted', 'under_review']);
    // 5th argument — the claim guard.
    expect(call[4]).toBe('admin-1');
  });

  it('falls back to an anonymous refusal when the holder has been deleted', async () => {
    const h = build({ stored: heldByAnother() });
    h.admins.namesByIds.mockResolvedValueOnce(new Map());
    await expect(h.service.approve('user-1', 'admin-1')).rejects.toThrow(/Another reviewer/);
  });
});

describe('approve', () => {
  it('raises the client to verification level 1', async () => {
    // This is the line that unlocks withdrawals.
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    await h.service.approve('user-1', 'admin-1');
    // The third argument is the transaction the decision runs in — the level and
    // the status land together or not at all.
    expect(h.users.update).toHaveBeenCalledWith(
      'user-1',
      { verificationLevel: 1 },
      expect.anything(),
    );
  });

  it('records who approved it and when', async () => {
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    await h.service.approve('user-1', 'admin-1');
    // `transition`, not `update`: the expected status goes into the WHERE, so
    // two reviewers racing cannot both write.
    expect(h.kycStore.transition).toHaveBeenCalledWith(
      'user-1',
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
    await h.service.approve('user-1', 'admin-1');
    expect(h.email.sendKycDecisionEmail).toHaveBeenCalledWith(
      USER.email,
      USER.firstName,
      'approved',
    );
  });

  it('refuses when there is no submission', async () => {
    const h = build();
    h.kycStore.findByUserId.mockResolvedValue(undefined);
    await expect(h.service.approve('user-1', 'admin-1')).rejects.toThrow(NotFoundError);
    expect(h.users.update).not.toHaveBeenCalled();
  });

  it('REFUSES to approve a submission the client never submitted', async () => {
    // Otherwise an admin can raise someone to level 1 — unlocking withdrawals —
    // for an account that has uploaded no documents at all. Approval must be a
    // decision about evidence, and there is none in `not_started`.
    for (const status of ['not_started', 'in_progress'] as const) {
      const h = build({ stored: submission({ status }) });
      await expect(h.service.approve('user-1', 'admin-1')).rejects.toThrow();
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
    await expect(h.service.approve('user-1', 'admin-1')).rejects.toThrow();
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

    await expect(h.service.approve('user-1', 'admin-1')).rejects.toThrow(/another reviewer/i);
    expect(h.users.update).not.toHaveBeenCalled();
    expect(h.kycStore.archiveAttempt).not.toHaveBeenCalled();
  });
});

describe('reject', () => {
  it('records the reason and the flagged fields', async () => {
    const h = build({ stored: completeSubmission({ status: 'under_review' }) });
    await h.service.reject('user-1', 'admin-1', 'Blurry document', ['doc_front']);
    expect(h.kycStore.transition).toHaveBeenCalledWith(
      'user-1',
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
    await h.service.reject('user-1', 'admin-1', 'Blurry document', ['doc_front']);
    expect(h.email.sendKycDecisionEmail).toHaveBeenCalledWith(
      USER.email,
      USER.firstName,
      'rejected',
      'Blurry document',
      ['doc_front'],
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
    await h.service.reject('user-1', 'admin-1', 'Approved in error', []);
    expect(h.users.update).toHaveBeenCalledWith(
      'user-1',
      { verificationLevel: 0 },
      expect.anything(),
    );
  });

  it('refuses when there is no submission', async () => {
    const h = build();
    h.kycStore.findByUserId.mockResolvedValue(undefined);
    await expect(h.service.reject('user-1', 'admin-1', 'x')).rejects.toThrow(NotFoundError);
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
    const serialised = JSON.stringify(await h.service.getByUserId('user-1'));
    for (const secret of ['argon2-hash-here', 'refresh-hash', 'reset-hash']) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).not.toMatch(/passwordHash/);
  });

  it('still returns what a reviewer needs to identify the person', async () => {
    // An allow-list that is too tight breaks the review screen instead of
    // leaking — the better failure, but still one.
    const h = build({ stored: completeSubmission(), user: LEAKY });
    const result = (await h.service.getByUserId('user-1')) as { user?: Record<string, unknown> };
    for (const field of ['id', 'email', 'firstName', 'lastName', 'verificationLevel']) {
      expect(result.user?.[field]).toBeDefined();
    }
  });
});

describe('listAll', () => {
  it('clamps the page size, so one request cannot ask for the whole table', async () => {
    const h = build();
    await h.service.listAll({ limit: 100_000 });
    expect(h.kycStore.findPageWithUsers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it('never accepts a page below 1', async () => {
    const h = build();
    await h.service.listAll({ page: -5 });
    expect(h.kycStore.findPageWithUsers).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
  });
});
