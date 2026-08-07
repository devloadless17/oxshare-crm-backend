import { Injectable } from '@nestjs/common';
import { RejectionReasonsStore } from '../../store/rejection-reasons.store';
import { TransactionsService } from '../payments/transactions.service';
import { WalletService } from '../wallet/wallet.service';
import { UsersStore } from '../../store/users.store';
import { EmailService } from '../email/email.service';
import { NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { assertActorCan } from '../../common/security/actor';
import { decodeCursor } from '../../common/pagination';
import { enumQuery } from '../../common/query-params';
import { ledgerEntryTypeEnum } from '../../database/schema';
import { ClientVisibilityService } from '../../common/security/client-visibility.service';
import type { ClientScope } from '../../common/security/client-scope';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/**
 * The money desk: withdrawal review (§8.4) and the append-only ledger view
 * (ADM-13).
 *
 * Every method here either moves money or decides that money may move, which is
 * exactly why it should not have shared a 726-line file with cookie handling
 * and the KYC step configurator.
 *
 * Commission plans used to live here too and went with the engine — see the
 * note at the foot of the class.
 */
@Injectable()
export class AdminMoneyService {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly wallets: WalletService,
    private readonly rejectionReasons: RejectionReasonsStore,
    private readonly users: UsersStore,
    private readonly email: EmailService,
    private readonly audit: AdminAuditService,
    private readonly visibility: ClientVisibilityService,
  ) {}

  // ─── Withdrawals (ADM-03 · §8.4) ──────────────────────────────────────────
  // Every transition here moves client money, so every one is audited.
  async listWithdrawals(
    query: { state?: string; page?: string; limit?: string; cursor?: string },
    actor: AuthenticatedAdmin,
  ) {
    assertActorCan(actor, 'withdrawals.view', 'list withdrawal requests');
    return this.transactions.listForAdmin({
      scope: actor.clientScope,
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
  async approveWithdrawal(id: string, actor: AuthenticatedAdmin) {
    // R-4.3: asserted HERE, not only in the guard. A guard runs on an HTTP
    // request; this method is what a queued job would call.
    assertActorCan(actor, 'withdrawals.approve', 'approve a withdrawal');
    await this.assertWithdrawalVisible(id, actor.clientScope);

    return this.transactions.approve(id, actor.id, (tx, row) =>
      this.audit.recordWithin(tx, actor.id, 'withdrawal.approve', 'transaction', id, {
        amount: row.amount,
        currency: row.currency,
      }),
    );
  }
  async rejectWithdrawal(
    id: string,
    actor: AuthenticatedAdmin,
    reason?: string,
    reasonId?: string,
  ) {
    assertActorCan(actor, 'withdrawals.approve', 'reject a withdrawal');
    await this.assertWithdrawalVisible(id, actor.clientScope);

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
  async settleWithdrawal(id: string, actor: AuthenticatedAdmin, providerRef: string) {
    /*
     * SEPARATION OF DUTIES — R-5.4.
     *
     * `withdrawals.settle`, NOT `withdrawals.approve`. Settlement is the step
     * that actually releases the money; approval only says it may be released.
     * While both required the same permission, "two people must be involved in
     * a payout" was unexpressible — one compromised or dishonest admin could
     * approve their own instruction and pay it out in the same minute, and the
     * audit log would show one name on both rows.
     *
     * Splitting the KEY is what makes the control possible; whether the two are
     * actually granted to different people is a decision for whoever builds the
     * roles, and that is the right place for it. A master admin holds `*` and so
     * can still do both — deliberately, because somebody has to be able to
     * unblock a stuck payout at 2am, and that person is already the one the
     * audit log is watching most closely.
     */
    assertActorCan(actor, 'withdrawals.settle', 'settle a withdrawal');
    await this.assertWithdrawalVisible(id, actor.clientScope);

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
  /**
   * The OWNING CLIENT of a withdrawal must be visible to this actor.
   *
   * Keyed off the transaction's `user_id` rather than the transaction id,
   * because the scope is a statement about CLIENTS. An out-of-scope withdrawal
   * answers 404 — identically to one that does not exist — so a scoped admin
   * cannot use these routes to learn that a withdrawal id is real.
   *
   * Takes the SCOPE rather than the actor, and that is not cosmetic: R-4.3's
   * source-scan requires every method receiving an actor to assert on it, and
   * it is right to. This one makes a visibility decision, not a permission one,
   * and its three callers have already asserted their permission by the time
   * they reach it. Narrowing the parameter to what it actually uses states that
   * honestly, instead of adding a redundant assertion to satisfy a scan.
   *
   * The lookup is skipped entirely for an unrestricted actor. Not only for the
   * query it saves on the money path: doing it unconditionally would ALSO make
   * an unknown id 404 here rather than in the state machine below, quietly
   * changing the error every existing caller sees for a reason that has nothing
   * to do with them.
   */
  private async assertWithdrawalVisible(id: string, scope: ClientScope): Promise<void> {
    if (scope.unrestricted) return;

    const owner = await this.transactions.ownerOf(id);
    if (!owner) throw new NotFoundError('Withdrawal not found.');
    await this.visibility.assertVisible(owner, scope);
  }

  async listLedger(
    query: {
      userId?: string;
      walletId?: string;
      entryType?: string;
      page?: string;
      limit?: string;
      cursor?: string;
    },
    actor: AuthenticatedAdmin,
  ) {
    assertActorCan(actor, 'withdrawals.view', 'view the ledger');
    return this.wallets.listEntries({
      // The ADM-13 ledger is the screen used FOR reconciliation, so the
      // predicate goes into the query rather than filtering afterwards.
      scope: actor.clientScope,
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
  /*
   * The commission-plan methods were HERE and went with the engine.
   *
   * `listPrograms`, `createProgram`, `updateProgram` and `setProgramActive`,
   * all gated on `commissions.manage`, all auditing before/after because "who
   * changed the L1 share" must be answerable. They return with the MT5 bridge;
   * `ib_levels` is the configuration that replaced them for the placement half.
   */
}
