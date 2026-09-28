import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { transactions } from '../database/schema';

/**
 * Who owns a deposit RECEIPT.
 *
 * One question, asked by the route that serves the image: an admin's scope check
 * needs the owning client, and a client's ownership check needs to know the file
 * is theirs.
 *
 * ## ⚠️ Why this is not a lookup in the upload registry
 *
 * `stored_objects` answers "who uploaded this object", across EVERY bucket.
 * Asking it here would let a client fetch their own KYC passport through the
 * deposit-receipt route — the file is theirs, so the check passes — and the
 * read would be audited as `deposit.proof.view`, leaving a hole in the KYC
 * access trail where a passport read should be. (The KYC route asks its own
 * question the same way: the client's identity record, 0151.)
 *
 * This asks the question the route actually means: is there a DEPOSIT carrying
 * this receipt, and whose is it? A filename from another bucket matches nothing.
 */
@Injectable()
export class DepositProofsStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /** The client whose deposit carries this receipt, or null if none does. */
  async ownerOfProof(filename: string): Promise<string | null> {
    const [row] = await this.db
      .select({ userId: transactions.userId })
      .from(transactions)
      .where(and(eq(transactions.proofFilename, filename), isNotNull(transactions.proofFilename)))
      .limit(1);
    return row?.userId ?? null;
  }
}
