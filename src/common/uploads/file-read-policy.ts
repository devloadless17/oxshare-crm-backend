import type { ClientScope } from '../security/client-scope';
import type { AuditSubjectType } from '../../store/audit-log.store';
import type { FileBucket } from './stored-files.service';

/**
 * WHO may read a file in a given protected bucket — the questions that differ
 * between one bucket and the next.
 *
 * Everything else about a two-audience file read (which principal is asking,
 * the session checks, RBAC-08, the audit row, the response headers) is the
 * `UploadsController`'s and identical for every bucket. Each bucket's OWNING
 * module implements this (`KycDocumentAccess` in compliance,
 * `DepositReceiptAccess` in payments), so the controller is routing and the
 * decision lives beside the data it is about.
 *
 * Pure answers, never HTTP: the controller turns a `false` into the 403/404.
 */
export interface FileReadPolicy {
  readonly bucket: FileBucket;
  /** Do these (normalised) permission keys let an admin read here at all? */
  mayRead(permissions: readonly string[]): boolean;
  /**
   * May an admin with this territory read THIS file? `false` is answered 404,
   * never 403, worded exactly like a missing file — distinguishing them would
   * tell a scoped admin which filenames are real.
   */
  inScope(scope: ClientScope, fileName: string): Promise<boolean>;
  /** Does this client own this file? */
  clientOwns(userId: number, fileName: string): Promise<boolean>;
  /** The R-6.6 audit row a read writes. */
  readonly audit: { action: string; subjectType: AuditSubjectType };
  readonly adminForbidden: string;
  readonly clientForbidden: string;
  /** The 404 message, for a miss and an out-of-scope file alike. */
  readonly notFound: string;
}
