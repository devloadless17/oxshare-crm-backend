import { Injectable } from '@nestjs/common';
import type { FileReadPolicy } from '../../common/uploads/file-read-policy';
import { DEPOSIT_PROOF_BUCKET } from '../../common/uploads/stored-files.service';
import type { ClientScope } from '../../common/security/client-scope';
import { UsersStore } from '../../store/users.store';
import { DepositProofsStore } from '../../store/deposit-proofs.store';

/**
 * Who may read a deposit RECEIPT (`GET /uploads/deposit-proofs/:file`) — a
 * client's proof that they paid from outside the system.
 *
 * `deposits.approve` implies the read for the KYC reason: approving a deposit
 * without being able to see the receipt is approving blind. The separate
 * `deposits.proofs.view` exists for the reviewer who checks the bank statement
 * without holding the power to credit.
 *
 * NOT readable by a `kyc.*` holder, and that is the point of a second policy:
 * a receipt names a bank account and an amount, and the people who verify
 * identity are not necessarily the people who handle money.
 */
@Injectable()
export class DepositReceiptAccess implements FileReadPolicy {
  readonly bucket = DEPOSIT_PROOF_BUCKET;
  readonly audit = { action: 'deposit.proof.view', subjectType: 'deposit_proof' as const };
  readonly adminForbidden =
    'The deposits.proofs.view or deposits.approve permission is required to view receipts.';
  readonly clientForbidden = 'You can only access your own receipts.';
  readonly notFound = 'Receipt not found.';

  constructor(
    private readonly depositProofs: DepositProofsStore,
    private readonly users: UsersStore,
  ) {}

  mayRead(permissions: readonly string[]): boolean {
    return permissions.includes('deposits.proofs.view') || permissions.includes('deposits.approve');
  }

  /**
   * The owner comes from the DEPOSIT, not from `stored_objects.owner_user_id` —
   * the authority on whose receipt this is, is whose deposit it belongs to.
   * An unrestricted admin skips the lookup (a missing object is the
   * controller's 404 either way).
   */
  async inScope(scope: ClientScope, fileName: string): Promise<boolean> {
    if (scope.unrestricted) return true;
    const owner = await this.depositProofs.ownerOfProof(fileName);
    if (!owner) return false;
    return (await this.users.findForAdmin(owner, scope)) !== undefined;
  }

  async clientOwns(userId: number, fileName: string): Promise<boolean> {
    return (await this.depositProofs.ownerOfProof(fileName)) === userId;
  }
}
