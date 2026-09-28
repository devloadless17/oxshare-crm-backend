import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../../common/errors/domain-errors';
import { catalogueDocument } from '../../common/kyc/document-catalogue';
import { identityField } from '../../common/kyc/identity-core';
import { actorHasPermission } from '../../common/security/actor';
import { KycConfigStore } from '../../store/kyc-config.store';
import { UsersStore } from '../../store/users.store';
import { ClientIdentityService } from '../client-identity/client-identity.service';
import type { ClientIdentityRecordDto } from './dto/client-identity.dto';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/** A returned page, named the way the review names its tiles. */
const PAGE_LABELS: Readonly<Record<string, string>> = {
  doc_front: 'Identity document — first page',
  doc_back: 'Identity document — second page',
  address_proof: 'Proof of address — first page',
  address_proof_2: 'Proof of address — second page',
  selfie: 'Selfie',
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
  ) {}

  async recordFor(clientId: string, actor: AuthenticatedAdmin): Promise<ClientIdentityRecordDto> {
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
}
