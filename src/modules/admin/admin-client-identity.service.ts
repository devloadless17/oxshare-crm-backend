import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { paymentMethods, transactions } from '../../database/schema';
import { formatLimit } from '../../common/currency-limits';
import { NotFoundError } from '../../common/errors/domain-errors';
import { catalogueDocument } from '../../common/kyc/document-catalogue';
import { EVIDENCE_PAGE_SLOTS, identityField } from '../../common/kyc/identity-core';
import { actorHasPermission } from '../../common/security/actor';
import { KycConfigStore } from '../../store/kyc-config.store';
import { UsersStore } from '../../store/users.store';
import { ClientIdentityService } from '../client-identity/client-identity.service';
import type { ClientIdentityRecordDto } from './dto/client-identity.dto';
import type {
  ClientDocumentCategory,
  ClientDocumentDto,
  ClientDocumentListDto,
  ClientDocumentStatus,
} from './dto/client-documents.dto';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/** A returned page, named the way the review names its tiles. */
const PAGE_ORDINALS = ['first', 'second'] as const;
const PAGE_LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    EVIDENCE_PAGE_SLOTS.document.map((slot, i) => [
      slot,
      `Identity document — ${PAGE_ORDINALS[i]} page`,
    ]),
  ),
  ...Object.fromEntries(
    EVIDENCE_PAGE_SLOTS.address.map((slot, i) => [
      slot,
      `Proof of address — ${PAGE_ORDINALS[i]} page`,
    ]),
  ),
  [EVIDENCE_PAGE_SLOTS.selfie[0]]: 'Selfie',
};

const SLOT_LABELS: Readonly<Record<string, string>> = {
  identity: 'Identity document',
  address: 'Proof of address',
  selfie: 'Selfie',
};

/**
 * THE CLIENT'S IDENTITY RECORD, AS THE CONSOLE SHOWS IT (identity-core plan,
 * slice 8) — `GET /admin/clients/:id/identity`.
 *
 * The record belongs to the client (`ClientIdentityService`); this composes it
 * for a reader: the client scope first (out of scope is 404, like the
 * profile), each half behind the permission that already guards it elsewhere
 * — documents behind `kyc.documents.view` or `kyc.review`, exactly what the
 * file route asks; decisions behind `kyc.view` — and the names a person reads:
 * the document by its catalogue name, a broker's upload by the question's name
 * as last recorded (`kyc_field_labels`, 0148).
 */
@Injectable()
export class AdminClientIdentityService {
  constructor(
    private readonly users: UsersStore,
    private readonly identity: ClientIdentityService,
    private readonly kycConfig: KycConfigStore,
    @Inject(DRIZZLE_DB) private readonly db: Db,
  ) {}

  async recordFor(clientId: number, actor: AuthenticatedAdmin): Promise<ClientIdentityRecordDto> {
    const client = await this.users.findForAdmin(clientId, actor.clientScope);
    if (!client) throw new NotFoundError('Client not found.');

    const may = (key: string) => actorHasPermission(actor, key);
    const seesDocuments = may('kyc.documents.view') || may('kyc.review');
    const seesDecisions = may('kyc.view');
    if (!seesDocuments && !seesDecisions) return {};

    const record = await this.identity.recordOf(clientId);
    const questions = await this.kycConfig.recordedLabels([
      ...record.documents
        .map(({ slot }) => slot)
        .filter((slot) => slot.startsWith('other:'))
        .map((slot) => slot.slice('other:'.length)),
      ...record.verifications.flatMap((decision) => decision.returnedItems ?? []),
    ]);
    const itemLabel = (id: string) =>
      identityField(id)?.label ?? PAGE_LABELS[id] ?? questions.get(id)?.label ?? id;

    return {
      ...(seesDocuments
        ? {
            documents: record.documents.map(({ slot, versions }) => ({
              slot,
              label:
                SLOT_LABELS[slot] ??
                questions.get(slot.slice('other:'.length))?.label ??
                'Uploaded document',
              versions: versions.map((version) => {
                const entry = version.docType ? catalogueDocument(version.docType) : undefined;
                return {
                  ...version,
                  docLabel: entry?.label ?? null,
                  pages: version.pages.map((page) => ({
                    ...page,
                    label: entry?.parts[page.part]?.label ?? `Page ${page.part + 1}`,
                  })),
                };
              }),
            })),
          }
        : {}),
      ...(seesDecisions
        ? {
            verifications: record.verifications.map((decision) => ({
              ...decision,
              returnedItems: decision.returnedItems ?? [],
              returnedLabels: (decision.returnedItems ?? []).map(itemLabel),
            })),
          }
        : {}),
    };
  }
  /**
   * EVERY DOCUMENT THE CLIENT HAS HANDED THE PLATFORM, in one list — the
   * profile's Documents tab (owner, 29 Sep 2026), `GET /admin/clients/:id/documents`.
   *
   * Two sources, one vocabulary, and no decision of its own:
   *
   *  - each KYC document VERSION (identity, address, selfie, a broker's own
   *    upload), with the status its review gave it — the same record
   *    `recordFor` composes, flattened;
   *  - each RECEIPT attached to an offline deposit, with its DEPOSIT's state —
   *    so a receipt on a refused deposit reads REJECTED, with the reason.
   *
   * Each half behind the permission that already guards its files (the file
   * routes ask the same): KYC behind `kyc.documents.view` or `kyc.review`,
   * receipts behind `deposits.proofs.view` or `deposits.approve`. A half the
   * reader may not see is named in `hidden`, so "none" and "not yours to see"
   * never read the same. Scoped like the profile: out of scope is 404.
   */
  async documentsFor(clientId: number, actor: AuthenticatedAdmin): Promise<ClientDocumentListDto> {
    const client = await this.users.findForAdmin(clientId, actor.clientScope);
    if (!client) throw new NotFoundError('Client not found.');

    const may = (key: string) => actorHasPermission(actor, key);
    const seesKyc = may('kyc.documents.view') || may('kyc.review');
    const seesReceipts = may('deposits.proofs.view') || may('deposits.approve');

    const items: ClientDocumentDto[] = [];
    const hidden: ClientDocumentCategory[] = [];

    if (seesKyc) {
      const record = await this.recordFor(clientId, actor);
      for (const document of record.documents ?? []) {
        const category = SLOT_CATEGORY[document.slot] ?? 'kyc_other';
        document.versions.forEach((version, index) => {
          items.push({
            id: version.id,
            category,
            title: document.label,
            detail: version.docLabel,
            status: KYC_STATUS[version.status],
            // Newest first, per slot: the first is what the client holds now.
            current: index === 0,
            files: version.pages.map((page) => ({ label: page.label, path: page.path })),
            reason: null,
            transactionId: null,
            // The record's store may hand back a timestamp STRING; a Date either way.
            uploadedAt: new Date(version.presentedAt ?? version.createdAt),
            uploadedByStaff: version.uploadedByStaff ?? null,
          });
        });
      }
    } else {
      hidden.push('identity', 'address', 'selfie', 'kyc_other');
    }

    if (seesReceipts) {
      const receipts = await this.db
        .select({
          id: transactions.id,
          state: transactions.state,
          amount: transactions.amount,
          currency: transactions.currency,
          proofFilename: transactions.proofFilename,
          rejectionReason: transactions.rejectionReason,
          createdAt: transactions.createdAt,
          // The DESK's name for the method (0161) — this is an admin screen.
          method: paymentMethods.internalLabel,
        })
        .from(transactions)
        .leftJoin(paymentMethods, eq(paymentMethods.key, transactions.methodKey))
        .where(and(eq(transactions.userId, clientId), isNotNull(transactions.proofFilename)))
        .orderBy(desc(transactions.createdAt));
      for (const receipt of receipts) {
        items.push({
          id: receipt.id,
          category: 'deposit_receipt',
          title: 'Deposit receipt',
          detail:
            `${formatLimit(receipt.amount)} ${receipt.currency}` +
            (receipt.method ? ` via ${receipt.method}` : ''),
          status: RECEIPT_STATUS[receipt.state],
          current: true,
          files: [{ label: 'Receipt', path: `uploads/deposit-proofs/${receipt.proofFilename}` }],
          reason: receipt.rejectionReason,
          transactionId: receipt.id,
          uploadedAt: new Date(receipt.createdAt),
          uploadedByStaff: null,
        });
      }
    } else {
      hidden.push('deposit_receipt');
    }

    items.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
    return { items, hidden };
  }
}

/** Which Documents-tab category a KYC slot is. `other:<field>` is a broker's own upload. */
const SLOT_CATEGORY: Readonly<Record<string, ClientDocumentCategory>> = {
  identity: 'identity',
  address: 'address',
  selfie: 'selfie',
};

/** A KYC version's review status, in the tab's one vocabulary. */
const KYC_STATUS: Readonly<
  Record<
    'draft' | 'awaiting_review' | 'verified' | 'returned' | 'reverification_requested',
    ClientDocumentStatus
  >
> = {
  draft: 'draft',
  awaiting_review: 'pending',
  verified: 'approved',
  returned: 'rejected',
  reverification_requested: 'reverification_requested',
};

/**
 * A receipt reads its DEPOSIT: credited is approved; refused or failed is
 * rejected; anything still moving is pending.
 */
const RECEIPT_STATUS: Readonly<
  Record<'pending' | 'approved' | 'success' | 'failure' | 'rejected', ClientDocumentStatus>
> = {
  pending: 'pending',
  approved: 'pending',
  success: 'approved',
  failure: 'rejected',
  rejected: 'rejected',
};
