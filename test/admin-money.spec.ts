import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from '../src/common/errors/domain-errors';
import { AdminMoneyService } from '../src/modules/admin/admin-money.service';
import { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { ProgramsService } from '../src/modules/partners/programs.service';
import { RejectionReasonsStore } from '../src/store/rejection-reasons.store';
import { UsersStore } from '../src/store/users.store';
import { EmailService } from '../src/modules/email/email.service';
import type { Admin } from '../src/store/admins.store';

/**
 * The money desk — withdrawal review, the ledger view, and commission plans.
 *
 * 225 lines with NO tests, and every method either moves client money or
 * decides that money may move. What is pinned here is not the happy path (the
 * §11 acceptance tests already prove the ledger arithmetic) but the authority
 * checks and the reason handling, because those are the parts a refactor would
 * quietly flatten:
 *
 *  - SEPARATION OF DUTIES (R-5.4). Settlement takes `withdrawals.settle` and
 *    approval takes `withdrawals.approve`. If someone "tidies" those to one
 *    permission, "two people must be involved in a payout" stops being
 *    expressible and NOTHING else in the system notices — the audit log would
 *    still look complete, with one name on both rows.
 *  - A rejection always carries a reason. A client told only "declined" cannot
 *    fix whatever was wrong, and the reason is what the configurable list in
 *    FR-ADM-03 exists to standardise.
 *  - Every transition audits INSIDE the transaction that moves the money
 *    (R-6.5), so a failure to record is a failure to act.
 */

const MASTER: Admin = {
  id: 'master-1',
  email: 'admin@oxshare.com',
  name: 'Master',
  passwordHash: 'x',
  role: 'master_admin',
  status: 'active',
  permissions: ['*'],
  createdAt: new Date(),
};

/** Can approve and reject, but must NOT be able to pay out. */
const APPROVER: Admin = {
  ...MASTER,
  id: 'approver-1',
  email: 'approver@oxshare.com',
  role: 'sub_admin',
  permissions: ['withdrawals.view', 'withdrawals.approve'],
};

/** Can pay out, but must NOT be able to approve. */
const SETTLER: Admin = {
  ...MASTER,
  id: 'settler-1',
  email: 'settler@oxshare.com',
  role: 'sub_admin',
  permissions: ['withdrawals.view', 'withdrawals.settle'],
};

const ROW = { id: 'w-1', userId: 'u-1', amount: '250.00000000', currency: 'USD' };
const PROGRAM = {
  id: 'p-1',
  name: 'Standard',
  mode: 'cpa',
  method: 'fixed',
  commissionValue: '10.00000000',
  rebateValue: '1.00000000',
  l1Share: '70.00',
  l2Share: '30.00',
  settlementWindowHours: 24,
  rebateOnClose: true,
};

async function build() {
  /** Stands in for the Drizzle transaction handle the audit callback receives. */
  const TX = Symbol('tx');

  const transactions = {
    listForAdmin: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    // Each writer invokes the audit callback with (tx, row), exactly as the real
    // ones do inside their transaction — that is the contract under test.
    approve: vi.fn((_id: string, _by: string, audit?: (tx: unknown, row: unknown) => void) => {
      audit?.(TX, ROW);
      return Promise.resolve(ROW);
    }),
    reject: vi.fn(
      (_id: string, _by: string, _reason: string, audit?: (tx: unknown, row: unknown) => void) => {
        audit?.(TX, ROW);
        return Promise.resolve(ROW);
      },
    ),
    settle: vi.fn(
      (_id: string, _by: string, _ref: string, audit?: (tx: unknown, row: unknown) => void) => {
        audit?.(TX, ROW);
        return Promise.resolve(ROW);
      },
    ),
  };

  const wallets = { listEntries: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) };

  const programs = {
    findAll: vi.fn().mockResolvedValue([PROGRAM]),
    findById: vi.fn().mockResolvedValue(PROGRAM),
    create: vi.fn((_input: unknown, audit?: (tx: unknown, row: unknown) => void) => {
      audit?.(TX, PROGRAM);
      return Promise.resolve(PROGRAM);
    }),
    update: vi.fn((_id: string, _input: unknown, audit?: (tx: unknown, row: unknown) => void) => {
      audit?.(TX, { ...PROGRAM, commissionValue: '25.00000000' });
      return Promise.resolve(PROGRAM);
    }),
    setActive: vi.fn((_id: string, _a: boolean, audit?: (tx: unknown, row: unknown) => void) => {
      audit?.(TX, PROGRAM);
      return Promise.resolve(PROGRAM);
    }),
  };

  const rejectionReasons = { findById: vi.fn().mockResolvedValue(undefined) };
  const users = { findById: vi.fn().mockResolvedValue({ email: 'c@x.com', firstName: 'Kay' }) };
  const email = { sendWithdrawalDecisionEmail: vi.fn().mockResolvedValue(undefined) };
  const audit = { record: vi.fn(), recordWithin: vi.fn() };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AdminMoneyService,
      { provide: TransactionsService, useValue: transactions },
      { provide: WalletService, useValue: wallets },
      { provide: ProgramsService, useValue: programs },
      { provide: RejectionReasonsStore, useValue: rejectionReasons },
      { provide: UsersStore, useValue: users },
      { provide: EmailService, useValue: email },
      { provide: AdminAuditService, useValue: audit },
    ],
  }).compile();

  return {
    service: moduleRef.get(AdminMoneyService),
    transactions,
    wallets,
    programs,
    rejectionReasons,
    users,
    email,
    audit,
    TX,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('separation of duties — R-5.4', () => {
  it('a settler CANNOT approve', async () => {
    const h = await build();
    await expect(h.service.approveWithdrawal('w-1', SETTLER)).rejects.toThrow(AuthorizationError);
    expect(h.transactions.approve).not.toHaveBeenCalled();
  });

  it('an approver CANNOT settle — the control this whole split exists for', async () => {
    // If these two ever collapse to one permission, one admin can approve their
    // own instruction and pay it out in the same minute, and the audit log shows
    // one name on both rows. Nothing else in the system would notice.
    const h = await build();
    await expect(h.service.settleWithdrawal('w-1', APPROVER, 'ref-1')).rejects.toThrow(
      AuthorizationError,
    );
    expect(h.transactions.settle).not.toHaveBeenCalled();
  });

  it('an approver CAN approve, and a settler CAN settle', async () => {
    const h = await build();
    await h.service.approveWithdrawal('w-1', APPROVER);
    await h.service.settleWithdrawal('w-1', SETTLER, 'ref-1');

    expect(h.transactions.approve).toHaveBeenCalledTimes(1);
    expect(h.transactions.settle).toHaveBeenCalledTimes(1);
  });

  it('the master admin can still do both — deliberately', async () => {
    // Somebody has to be able to unblock a stuck payout at 2am, and that person
    // is the one the audit log watches most closely.
    const h = await build();
    await h.service.approveWithdrawal('w-1', MASTER);
    await h.service.settleWithdrawal('w-1', MASTER, 'ref-1');

    expect(h.transactions.settle).toHaveBeenCalledTimes(1);
  });

  it('rejecting is part of the APPROVE decision, not the payout one', async () => {
    const h = await build();
    await expect(h.service.rejectWithdrawal('w-1', SETTLER, 'nope')).rejects.toThrow(
      AuthorizationError,
    );
    await h.service.rejectWithdrawal('w-1', APPROVER, 'nope');
    expect(h.transactions.reject).toHaveBeenCalledTimes(1);
  });
});

describe('a rejection always carries a reason — FR-ADM-03', () => {
  it('refuses when neither a reason nor a reasonId is given', async () => {
    // "Declined", with nothing else, leaves a client unable to fix whatever was
    // wrong and support unable to explain it.
    const h = await build();
    await expect(h.service.rejectWithdrawal('w-1', MASTER)).rejects.toThrow(ValidationError);
    expect(h.transactions.reject).not.toHaveBeenCalled();
  });

  it('refuses whitespace as a reason', async () => {
    const h = await build();
    await expect(h.service.rejectWithdrawal('w-1', MASTER, '   ')).rejects.toThrow(ValidationError);
    expect(h.transactions.reject).not.toHaveBeenCalled();
  });

  it('refuses an unknown reasonId rather than rejecting without one', async () => {
    const h = await build();
    await expect(h.service.rejectWithdrawal('w-1', MASTER, undefined, 'missing')).rejects.toThrow(
      NotFoundError,
    );
    expect(h.transactions.reject).not.toHaveBeenCalled();
  });

  it('uses the configured label when only a reasonId is given', async () => {
    const h = await build();
    h.rejectionReasons.findById.mockResolvedValue({ id: 'r-1', label: 'Name mismatch' });

    await h.service.rejectWithdrawal('w-1', MASTER, undefined, 'r-1');

    expect(h.transactions.reject).toHaveBeenCalledWith(
      'w-1',
      MASTER.id,
      'Name mismatch',
      expect.any(Function),
    );
  });

  it('combines the configured label with the free-text note', async () => {
    // The list standardises the category; the note carries the specifics. Losing
    // either half makes the decision less reviewable than it was.
    const h = await build();
    h.rejectionReasons.findById.mockResolvedValue({ id: 'r-1', label: 'Name mismatch' });

    await h.service.rejectWithdrawal('w-1', MASTER, 'bank account is in a different name', 'r-1');

    expect(h.transactions.reject).toHaveBeenCalledWith(
      'w-1',
      MASTER.id,
      'Name mismatch — bank account is in a different name',
      expect.any(Function),
    );
  });

  it('tells the client, with the reason', async () => {
    const h = await build();
    await h.service.rejectWithdrawal('w-1', MASTER, 'insufficient documentation');

    expect(h.email.sendWithdrawalDecisionEmail).toHaveBeenCalledWith(
      'c@x.com',
      'Kay',
      'rejected',
      ROW.amount,
      ROW.currency,
      'insufficient documentation',
    );
  });

  it('does not fail the rejection when the client cannot be found', async () => {
    // The money decision is already committed by this point; not being able to
    // email about it must not turn a completed rejection into an error.
    const h = await build();
    h.users.findById.mockResolvedValue(undefined);

    await expect(h.service.rejectWithdrawal('w-1', MASTER, 'reason')).resolves.toBeTruthy();
    expect(h.email.sendWithdrawalDecisionEmail).not.toHaveBeenCalled();
  });
});

describe('every transition is audited inside its own transaction — R-6.5', () => {
  it('approve records within the tx, with the amount', async () => {
    const h = await build();
    await h.service.approveWithdrawal('w-1', MASTER);

    expect(h.audit.recordWithin).toHaveBeenCalledWith(
      h.TX,
      MASTER.id,
      'withdrawal.approve',
      'transaction',
      'w-1',
      expect.objectContaining({ amount: ROW.amount, currency: ROW.currency }),
    );
  });

  it('settle records the provider reference — how a payout is traced', async () => {
    const h = await build();
    await h.service.settleWithdrawal('w-1', MASTER, 'whish-abc-123');

    expect(h.audit.recordWithin).toHaveBeenCalledWith(
      h.TX,
      MASTER.id,
      'withdrawal.settle',
      'transaction',
      'w-1',
      expect.objectContaining({ providerRef: 'whish-abc-123' }),
    );
  });

  it('reject records the reason that was actually applied', async () => {
    const h = await build();
    h.rejectionReasons.findById.mockResolvedValue({ id: 'r-1', label: 'Name mismatch' });
    await h.service.rejectWithdrawal('w-1', MASTER, 'note', 'r-1');

    expect(h.audit.recordWithin).toHaveBeenCalledWith(
      h.TX,
      MASTER.id,
      'withdrawal.reject',
      'transaction',
      'w-1',
      expect.objectContaining({ reason: 'Name mismatch — note' }),
    );
  });

  it('uses recordWithin, never the fire-and-forget record()', async () => {
    // `record()` is right for a role rename and wrong here: the money moves, the
    // row is lost, and "who approved this payout" has only a log line that may
    // have rotated.
    const h = await build();
    await h.service.approveWithdrawal('w-1', MASTER);
    await h.service.settleWithdrawal('w-1', MASTER, 'ref');

    expect(h.audit.record).not.toHaveBeenCalled();
  });
});

describe('commission plans decide what every future accrual pays', () => {
  it('creating requires commissions.manage', async () => {
    const h = await build();
    await expect(h.service.createProgram(PROGRAM as never, APPROVER)).rejects.toThrow(
      AuthorizationError,
    );
    expect(h.programs.create).not.toHaveBeenCalled();
  });

  it('updating and (de)activating require it too', async () => {
    const h = await build();
    await expect(h.service.updateProgram('p-1', PROGRAM as never, APPROVER)).rejects.toThrow(
      AuthorizationError,
    );
    await expect(h.service.setProgramActive('p-1', false, APPROVER)).rejects.toThrow(
      AuthorizationError,
    );
  });

  it('records BOTH the previous and the new rate on an update', async () => {
    // A rate change is only reviewable if the previous rate is in the same row
    // as the new one — otherwise answering "what did we change it from" means
    // reconstructing it from two log entries that may not both exist.
    const h = await build();
    await h.service.updateProgram('p-1', PROGRAM as never, MASTER);

    const payload = h.audit.recordWithin.mock.calls[0]?.[5] as {
      before: { commissionValue: string };
      after: { commissionValue: string };
    };
    expect(payload.before.commissionValue).toBe('10.00000000');
    expect(payload.after.commissionValue).toBe('25.00000000');
  });

  it('reads the previous values BEFORE opening the write transaction', async () => {
    const h = await build();
    await h.service.updateProgram('p-1', PROGRAM as never, MASTER);
    expect(h.programs.findById).toHaveBeenCalledWith('p-1');
  });

  it('distinguishes activate from deactivate in the log', async () => {
    const h = await build();
    await h.service.setProgramActive('p-1', true, MASTER);
    expect(h.audit.recordWithin.mock.calls[0]?.[2]).toBe('program.activate');

    h.audit.recordWithin.mockClear();
    await h.service.setProgramActive('p-1', false, MASTER);
    expect(h.audit.recordWithin.mock.calls[0]?.[2]).toBe('program.deactivate');
  });
});

describe('the ledger view — ADM-13', () => {
  it('refuses an unknown entry type rather than casting it into the query', async () => {
    // The `as` that made `?state=` a 500 on the withdrawals list. Same shape.
    const h = await build();
    await expect(h.service.listLedger({ entryType: 'not-a-type' })).rejects.toThrow();
    expect(h.wallets.listEntries).not.toHaveBeenCalled();
  });

  it('passes a valid entry type through', async () => {
    const h = await build();
    await h.service.listLedger({ entryType: 'deposit' });
    expect(h.wallets.listEntries).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: 'deposit' }),
    );
  });

  it('defaults the page size rather than trusting the querystring', async () => {
    const h = await build();
    await h.service.listLedger({ limit: 'not-a-number' });
    expect(h.wallets.listEntries).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });
});
