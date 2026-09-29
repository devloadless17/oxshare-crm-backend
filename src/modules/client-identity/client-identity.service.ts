import { Injectable, Logger } from '@nestjs/common';
import { ALERT_KINDS, raiseAlert } from '../../common/logging/alerts';
import { KYC_BUCKET } from '../../common/uploads/stored-files.service';
import { filenameFromStored, storedPath } from '../../common/uploads/storage/storage-key';
import type { Executor } from '../../database/db';
import {
  ClientIdentityStore,
  type IdentityDecisionRow,
  type IdentityDrift,
  type IdentityRepair,
} from '../../store/client-identity.store';

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
 * Today it has one writer: the KYC layer calls `recordFromKyc` inside every
 * transaction that changes evidence or records a decision, and the record is
 * adopted from the KYC rows by `identity_adopt` (0152). Reads move to the
 * record in the next slice; direct writes replace adoption in the contract
 * slice.
 */
@Injectable()
export class ClientIdentityService {
  private readonly logger = new Logger(ClientIdentityService.name);

  constructor(private readonly store: ClientIdentityStore) {}

  /**
   * Record what the KYC layer just changed for this client — call it INSIDE the
   * transaction that changed it, after its writes and any level change, so the
   * record moves with the change or not at all.
   */
  async recordFromKyc(userId: number, executor: Executor): Promise<void> {
    await this.store.adopt(userId, executor);
  }

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

  /** What is out of step between the KYC rows and the record. Empty is healthy. */
  async drift(userId?: number): Promise<IdentityDrift[]> {
    return this.store.drift(userId);
  }

  /**
   * Bring every client whose KYC rows and record disagree back in step — run on
   * EVERY boot, in every environment (main.ts).
   *
   * The record follows every write to the KYC rows at commit — 0153's triggers
   * see current code, an older build during a rollback and raw SQL alike. What
   * they cannot see is a row written with triggers OFF (a restore,
   * replication), a verification level written directly, or an edit made
   * through the record's own escape; and from the slice that reads the record,
   * out of step is a screen showing documents that are not the client's latest.
   * So this looks on every boot — like `reportPermissionDrift`, outside main.ts's
   * seed guard, because production is where restores happen.
   *
   * Any drift is an ALERT, not routine (`identity.record_drift`). A client it
   * cannot repair is also an ERROR naming them, and is left exactly as it was.
   * It never throws — a repair must not be the reason the process does not
   * start.
   */
  async repairDrift(): Promise<IdentityRepair | undefined> {
    try {
      const result = await this.store.repairDrift();
      const { repaired, failed, problems } = result;
      for (const { userId, message } of failed) {
        this.logger.error(
          `Client ${userId}'s identity record could not be brought in step with their KYC ` +
            `rows and was left as it was: ${message}`,
        );
      }
      if (repaired > 0 || failed.length > 0) {
        const context: Record<string, number> = { repaired, failed: failed.length };
        for (const [problem, count] of Object.entries(problems)) context[problem] = count ?? 0;
        raiseAlert(
          this.logger,
          ALERT_KINDS.IDENTITY_RECORD_DRIFT,
          'notify',
          failed.length > 0
            ? `${failed.length} client(s)' identity record is out of step with their KYC rows ` +
                `and could not be repaired; ${repaired} other(s) were.`
            : `${repaired} client(s)' identity record was out of step with their KYC rows and ` +
                'has been repaired. Something wrote them where the record could not follow — ' +
                'a verification level set directly, or rows restored with triggers off.',
          context,
        );
      }
      return result;
    } catch (error) {
      this.logger.error(
        `Could not check the identity record against the KYC rows: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
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
  pages: { part: number; path: string; fileName: string | null }[];
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
