import { Injectable } from '@nestjs/common';
import { KYC_BUCKET } from '../../common/uploads/stored-files.service';
import { filenameFromStored, storedPath } from '../../common/uploads/storage/storage-key';
import { ClientIdentityStore, type IdentityDecisionRow } from '../../store/client-identity.store';

/**
 * THE CLIENT'S IDENTITY CORE — the one door into the client's record of
 * documents, selfie and verification decisions (0151).
 *
 * The owner's direction (28 Sep 2026): a client's identity is the most
 * important thing, and KYC is only the PROCESS that collects and checks it —
 * today a manual review, perhaps an external tool later. So the record belongs
 * to the client, and every process writes into it through here.
 *
 * ⚠️ This module never imports the KYC layer (`modules/compliance`, the KYC
 * stores); lint makes that a build error. That is what keeps "replace KYC with
 * a tool" true: the tool would call these methods, not the KYC code.
 *
 * Today it has one writer, the KYC layer: since 0171 `KycStore` writes the
 * record directly (`identity_record_evidence`, `identity_record_decision`) in
 * the same transaction as the KYC row. There is no second copy to adopt from.
 */
@Injectable()
export class ClientIdentityService {
  constructor(private readonly store: ClientIdentityStore) {}

  /**
   * The client a KYC file (`GET /uploads/kyc/<name>`) belongs to: whoever's
   * record holds it — live, returned, or kept as evidence after a reset.
   * Undefined for a name no single client's record holds, or one that names no
   * file at all.
   */
  async ownerOfKycFile(fileName: string): Promise<number | undefined> {
    const name = filenameFromStored(fileName);
    if (!name || name !== fileName) return undefined;
    return this.store.ownerOfFile(storedPath(KYC_BUCKET.dir, name));
  }

  /**
   * The client's identity record as a reader sees it: each document slot with
   * its versions, newest first, and every verification decision, newest first.
   * A version's status is READ FROM THE LOG, never stored: a draft; presented
   * and awaiting review; or the outcome of the latest decision that covered it,
   * with the pages that decision returned.
   */
  async recordOf(userId: number): Promise<IdentityRecord> {
    const { versions, decisions } = await this.store.recordOf(userId);
    const slots = new Map<string, IdentityVersion[]>();
    for (const row of versions) {
      const version: IdentityVersion = {
        id: row.id,
        docType: row.docType,
        status: !row.frozenAt ? 'draft' : (row.decision?.outcome ?? 'awaiting_review'),
        returnedPages:
          row.decision && row.decision.outcome !== 'verified'
            ? returnedPagesOf(row.slot, row.decision.returnedItems ?? [])
            : [],
        createdAt: row.createdAt,
        presentedAt: row.frozenAt,
        pages: row.pages,
      };
      slots.set(row.slot, [...(slots.get(row.slot) ?? []), version]);
    }
    return {
      documents: [...slots.entries()]
        .sort(([a], [b]) => slotOrder(a) - slotOrder(b) || a.localeCompare(b))
        .map(([slot, list]) => ({ slot, versions: list })),
      verifications: decisions,
    };
  }
}

export type IdentityVersionStatus =
  'draft' | 'awaiting_review' | 'verified' | 'returned' | 'reverification_requested';

export interface IdentityVersion {
  id: string;
  docType: string | null;
  status: IdentityVersionStatus;
  /** The item ids of this version's pages the covering decision returned (`doc_back`). */
  returnedPages: string[];
  createdAt: Date;
  /** When it was presented for review — null for a draft. */
  presentedAt: Date | null;
  pages: { part: number; path: string }[];
}

export interface IdentityRecord {
  documents: { slot: string; versions: IdentityVersion[] }[];
  verifications: IdentityDecisionRow[];
}

/** The returned-item ids a slot's pages answer to, by part. */
const PAGE_ITEMS: Readonly<Record<string, readonly string[]>> = {
  identity: ['doc_front', 'doc_back'],
  address: ['address_proof', 'address_proof_2'],
  selfie: ['selfie'],
};

/** Which returned items name a page of this slot — a broker's upload answers to its field key. */
function returnedPagesOf(slot: string, items: readonly string[]): string[] {
  const own = PAGE_ITEMS[slot];
  if (own) return items.filter((item) => own.includes(item));
  return items.filter((item) => `other:${item}` === slot);
}

/** The platform's three first, in the order the review shows them; a broker's after. */
function slotOrder(slot: string): number {
  const at = ['identity', 'address', 'selfie'].indexOf(slot);
  return at === -1 ? 3 : at;
}
