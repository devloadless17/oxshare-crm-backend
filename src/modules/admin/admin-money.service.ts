import { Injectable } from '@nestjs/common';
import { Admin } from '../../store/admins.store';
import { RejectionReasonsStore } from '../../store/rejection-reasons.store';
import { TransactionsService } from '../payments/transactions.service';
import { WalletService } from '../wallet/wallet.service';
import { ProgramInput, ProgramsService } from '../partners/programs.service';
import { UsersStore } from '../../store/users.store';
import { EmailService } from '../email/email.service';
import { NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { assertActorCan } from '../../common/security/actor';
import { decodeCursor } from '../../common/pagination';
import { enumQuery } from '../../common/query-params';
import { ledgerEntryTypeEnum } from '../../database/schema';

/**
 * The money desk: withdrawal review (§8.4), the append-only ledger view
 * (ADM-13), and commission plans (ADM-10 / IB-06).
 *
 * Every method here either moves money or decides that money may move, which is
 * exactly why it should not have shared a 726-line file with cookie handling
 * and the KYC step configurator.
 */
@Injectable()
export class AdminMoneyService {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly wallets: WalletService,
    private readonly programs: ProgramsService,
    private readonly rejectionReasons: RejectionReasonsStore,
    private readonly users: UsersStore,
    private readonly email: EmailService,
    private readonly audit: AdminAuditService,
  ) {}

  // ─── Withdrawals (ADM-03 · §8.4) ──────────────────────────────────────────
  // Every transition here moves client money, so every one is audited.
  async listWithdrawals(query: { state?: string; page?: string; limit?: string; cursor?: string }) {
    return this.transactions.listForAdmin({
      state: query.state,
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '25', 10) || 25,
      // R-2.4. This is a work queue an admin reads while clients keep
      // submitting — the concurrent-insert case offset paging gets wrong.
      cursor: query.cursor ? decodeCursor(query.cursor) : undefined,
    });
  }
  /*
   * Every withdrawal transition below records its audit row INSIDE the
   * transaction that moves the money — R-6.5.
   *
   * `audit.record()` is fire-and-forget, which is right for a role rename and
   * wrong here: the money moves, the row is lost, and "who approved this payout"
   * has only a log line that may have rotated. Now the two commit together, so a
   * failure to record is a failure to act. A withdrawal that fails loudly can be
   * retried; an unrecorded payout cannot be un-made.
   */
  async approveWithdrawal(id: string, actor: Admin) {
    // R-4.3: asserted HERE, not only in the guard. A guard runs on an HTTP
    // request; this method is what a queued job would call.
    assertActorCan(actor, 'withdrawals.approve', 'approve a withdrawal');
    return this.transactions.approve(id, actor.id, (tx, row) =>
      this.audit.recordWithin(tx, actor.id, 'withdrawal.approve', 'transaction', id, {
        amount: row.amount,
        currency: row.currency,
      }),
    );
  }
  async rejectWithdrawal(id: string, actor: Admin, reason?: string, reasonId?: string) {
    assertActorCan(actor, 'withdrawals.approve', 'reject a withdrawal');
    // FR-ADM-03: the reason comes from the configurable list; free text is an
    // optional note alongside it.
    let effectiveReason = reason?.trim();
    if (reasonId) {
      const configured = await this.rejectionReasons.findById(reasonId);
      if (!configured) throw new NotFoundError('Rejection reason not found.');
      effectiveReason = effectiveReason
        ? `${configured.label} — ${effectiveReason}`
        : configured.label;
    }
    if (!effectiveReason) {
      throw new ValidationError('A rejection reason (reasonId or reason text) is required.');
    }

    const row = await this.transactions.reject(id, actor.id, effectiveReason, (tx, rejected) =>
      this.audit.recordWithin(tx, actor.id, 'withdrawal.reject', 'transaction', id, {
        amount: rejected.amount,
        currency: rejected.currency,
        reason: effectiveReason,
      }),
    );
    const user = await this.users.findById(row.userId);
    if (user) {
      void this.email.sendWithdrawalDecisionEmail(
        user.email,
        user.firstName,
        'rejected',
        row.amount,
        row.currency,
        effectiveReason,
      );
    }
    return row;
  }
  async settleWithdrawal(id: string, actor: Admin, providerRef: string) {
    // Settlement is the step that actually moves the money out.
    assertActorCan(actor, 'withdrawals.approve', 'settle a withdrawal');
    const row = await this.transactions.settle(id, actor.id, providerRef, (tx, settled) =>
      this.audit.recordWithin(tx, actor.id, 'withdrawal.settle', 'transaction', id, {
        amount: settled.amount,
        currency: settled.currency,
        providerRef,
      }),
    );
    const user = await this.users.findById(row.userId);
    if (user) {
      void this.email.sendWithdrawalDecisionEmail(
        user.email,
        user.firstName,
        'paid',
        row.amount,
        row.currency,
      );
    }
    return row;
  }
  // ─── Ledger view (ADM-13) ─────────────────────────────────────────────────
  async listLedger(query: {
    userId?: string;
    walletId?: string;
    entryType?: string;
    page?: string;
    limit?: string;
    cursor?: string;
  }) {
    return this.wallets.listEntries({
      userId: query.userId,
      walletId: query.walletId,
      // Checked, not cast — the same `as` that made `?state=` a 500 on the
      // withdrawals list. Missed on this call site when the rest were fixed.
      entryType: enumQuery(query.entryType, ledgerEntryTypeEnum.enumValues, 'entryType'),
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '50', 10) || 50,
      cursor: query.cursor ? decodeCursor(query.cursor) : undefined,
    });
  }
  // ─── Commission plans (ADM-10 · IB-06) ────────────────────────────────────
  // These values drive the commission engine, so every change is audited with
  // before/after — "who changed the L1 share" must be answerable.
  async listPrograms() {
    return this.programs.findAll();
  }
  async createProgram(input: ProgramInput, actor: Admin) {
    // A plan decides what every future accrual pays.
    assertActorCan(actor, 'commissions.manage', 'create a commission plan');
    return this.programs.create(input, (tx, row) =>
      this.audit.recordWithin(tx, actor.id, 'program.create', 'ib_program', row.id, {
        name: row.name,
        mode: row.mode,
        method: row.method,
        commissionValue: row.commissionValue,
        l1Share: row.l1Share,
        l2Share: row.l2Share,
        settlementWindowHours: row.settlementWindowHours,
        rebateOnClose: row.rebateOnClose,
      }),
    );
  }
  async updateProgram(id: string, input: ProgramInput, actor: Admin) {
    assertActorCan(actor, 'commissions.manage', 'update a commission plan');
    // Read before the write opens its transaction: the before/after pair is the
    // whole value of this record, and a rate change is only reviewable if the
    // previous rate is in the same row as the new one.
    const before = await this.programs.findById(id);
    return this.programs.update(id, input, (tx, row) =>
      this.audit.recordWithin(tx, actor.id, 'program.update', 'ib_program', id, {
        before: {
          commissionValue: before.commissionValue,
          rebateValue: before.rebateValue,
          l1Share: before.l1Share,
          l2Share: before.l2Share,
          settlementWindowHours: before.settlementWindowHours,
          rebateOnClose: before.rebateOnClose,
        },
        after: {
          commissionValue: row.commissionValue,
          rebateValue: row.rebateValue,
          l1Share: row.l1Share,
          l2Share: row.l2Share,
          settlementWindowHours: row.settlementWindowHours,
          rebateOnClose: row.rebateOnClose,
        },
      }),
    );
  }
  async setProgramActive(id: string, active: boolean, actor: Admin) {
    assertActorCan(actor, 'commissions.manage', 'activate or deactivate a commission plan');
    return this.programs.setActive(id, active, (tx, row) =>
      this.audit.recordWithin(
        tx,
        actor.id,
        active ? 'program.activate' : 'program.deactivate',
        'ib_program',
        id,
        { name: row.name },
      ),
    );
  }
}
