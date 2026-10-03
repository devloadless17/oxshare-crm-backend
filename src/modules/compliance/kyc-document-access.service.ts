import { Injectable } from '@nestjs/common';
import type { FileReadPolicy } from '../../common/uploads/file-read-policy';
import { KYC_BUCKET } from '../../common/uploads/stored-files.service';
import type { ClientScope } from '../../common/security/client-scope';
import { UsersStore } from '../../store/users.store';
import { ClientIdentityService } from '../client-identity/client-identity.service';

/**
 * Who may read a KYC document (`GET /uploads/kyc/:file`).
 *
 * READING a document and DECIDING an outcome are different powers.
 * `kyc.documents.view` is the read on its own; `kyc.review` implies it,
 * deliberately: a reviewer who could not open the documents could not review
 * anything, and requiring both keys would have broken every existing reviewer
 * on deploy. So it widens who may look without changing who may decide.
 */
@Injectable()
export class KycDocumentAccess implements FileReadPolicy {
  readonly bucket = KYC_BUCKET;
  readonly audit = { action: 'kyc.document.view', subjectType: 'kyc_document' as const };
  readonly adminForbidden =
    'The kyc.documents.view or kyc.review permission is required to view documents.';
  readonly clientForbidden = 'You can only access your own documents.';
  readonly notFound = 'Document not found.';

  constructor(
    private readonly identity: ClientIdentityService,
    private readonly users: UsersStore,
  ) {}

  mayRead(permissions: readonly string[]): boolean {
    return permissions.includes('kyc.documents.view') || permissions.includes('kyc.review');
  }

  /**
   * The OWNER first, for EVERY admin — scoped or not.
   *
   * A file no client's record holds is an orphan: a replaced draft page whose
   * deletion failed, the leftovers of a reset, a name somebody guessed. It is
   * nobody's document, so there is nothing to serve. Until 28 Sep 2026 an
   * UNRESTRICTED admin skipped this lookup and was handed any file in the
   * documents bucket by name — the one reader with no owner check at all.
   *
   * Then territory: the admin's own intake grant (D-60), not a default — an
   * intake-granted reviewer must reach an untagged client's DOCUMENTS, not just
   * the submission row.
   */
  async inScope(scope: ClientScope, fileName: string): Promise<boolean> {
    const owner = await this.identity.ownerOfKycFile(fileName);
    if (!owner) return false;
    if (scope.unrestricted) return true;
    return (await this.users.findForAdmin(owner, scope)) !== undefined;
  }

  /**
   * Does this client own this document? Their identity RECORD says (0151):
   * every version of every document they ever presented or are working on —
   * the live submission, a returned attempt, a broker's own upload step, and
   * what was decided before a reset.
   *
   * It used to be read from the KYC rows, and the reset was the hole: the live
   * row goes, and the check stopped at "no submission", so a client lost their
   * own archived passport — while any reviewing admin could still open it.
   */
  async clientOwns(userId: number, fileName: string): Promise<boolean> {
    return (await this.identity.ownerOfKycFile(fileName)) === userId;
  }
}
