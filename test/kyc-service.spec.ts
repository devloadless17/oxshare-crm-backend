import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KycService } from '../src/modules/compliance/kyc.service';
import type { KycStore, KycSubmission } from '../src/store/kyc.store';
import type { User, UsersStore } from '../src/store/users.store';
import type { EmailService } from '../src/modules/email/email.service';
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
    personalInfo: { firstName: 'Jane', lastName: 'Doe' },
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
    clearAll: vi.fn(),
  };
  const users = {
    findById: vi.fn().mockResolvedValue(options.user ?? USER),
    update: vi.fn().mockResolvedValue(options.user ?? USER),
  };
  const email = { sendKycDecisionEmail: vi.fn().mockResolvedValue(undefined) };

  const service = new KycService(
    email as unknown as EmailService,
    kycStore as unknown as KycStore,
    users as unknown as UsersStore,
  );
  return { service, kycStore, users, email };
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
    expect(h.kycStore.update).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ status: 'submitted', submittedAt: expect.any(Date) }),
    );
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
    expect(h.kycStore.update).toHaveBeenCalledWith(
      'user-1',
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
    expect(h.kycStore.update).toHaveBeenCalledWith('user-1', {
      status: 'under_review',
      reviewedBy: 'admin-1',
    });
  });

  it('refuses when there is no submission at all', async () => {
    const h = build();
    h.kycStore.findByUserId.mockResolvedValue(undefined);
    await expect(h.service.claim('user-1', 'admin-1')).rejects.toThrow(NotFoundError);
  });
});

describe('approve', () => {
  it('raises the client to verification level 1', async () => {
    // This is the line that unlocks withdrawals.
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    await h.service.approve('user-1', 'admin-1');
    expect(h.users.update).toHaveBeenCalledWith('user-1', { verificationLevel: 1 });
  });

  it('records who approved it and when', async () => {
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    await h.service.approve('user-1', 'admin-1');
    expect(h.kycStore.update).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        status: 'approved',
        reviewedBy: 'admin-1',
        reviewedAt: expect.any(Date),
      }),
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
    // Two writes, no transaction: if the status write fails after the level is
    // raised, the client is verified with no approved submission behind it.
    const h = build({ stored: completeSubmission({ status: 'submitted' }) });
    h.kycStore.update.mockRejectedValue(new Error('db down'));
    await expect(h.service.approve('user-1', 'admin-1')).rejects.toThrow();
    expect(h.users.update).not.toHaveBeenCalled();
  });
});

describe('reject', () => {
  it('records the reason and the flagged fields', async () => {
    const h = build({ stored: completeSubmission({ status: 'under_review' }) });
    await h.service.reject('user-1', 'admin-1', 'Blurry document', ['doc_front']);
    expect(h.kycStore.update).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        status: 'rejected',
        rejectionReason: 'Blurry document',
        rejectedFields: ['doc_front'],
      }),
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
    expect(h.users.update).toHaveBeenCalledWith('user-1', { verificationLevel: 0 });
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
