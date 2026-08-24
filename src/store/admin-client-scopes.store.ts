import { eq, inArray } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { adminClientTagScopes, clientTags } from '../database/schema';
import { scopeOf, type ClientScope } from '../common/security/client-scope';

export interface AdminScopeTag {
  tagId: string;
  slug: string;
  label: string;
}

/**
 * Which client tags an administrator's view is restricted to.
 *
 * Read on EVERY authenticated admin request, via `AdminAuthenticator`, so it is
 * one indexed lookup on a composite primary key and nothing more.
 */
@Injectable()
export class AdminClientScopesStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * The tag ids this admin is restricted to. Empty means unrestricted.
   *
   * DELIBERATELY HAS NO try/catch. A `catch` returning `[]` here would turn a
   * transient database error into UNRESTRICTED — a scoped administrator quietly
   * promoted to seeing every client in the system because a connection blipped.
   * Failing the request is loud, recoverable and correct; failing open is
   * neither. `test/client-scope-enforcement.spec.ts` pins this by making the
   * store throw and asserting the request 500s rather than serving everything.
   */
  async tagIdsFor(adminId: string): Promise<string[]> {
    const rows = await this.db
      .select({ tagId: adminClientTagScopes.tagId })
      .from(adminClientTagScopes)
      .where(eq(adminClientTagScopes.adminId, adminId));
    return rows.map((r) => r.tagId);
  }

  /**
   * The resolved scope, with the empty-means-unrestricted rule applied once.
   * `seesUntriaged` comes from the ADMIN row the caller already holds (D-60) —
   * this store owns only the territory table.
   */
  /*
   * `seesUntriaged` is REQUIRED — there is deliberately no default. It used to
   * default to `false`, and two callers (the notification fan-out and KYC
   * document delivery) took that default rather than reading the admin row they
   * already held, so an intake-granted admin silently lost sight of untagged
   * clients in exactly those two paths while the guard saw them correctly. A
   * default that is safe in one caller and wrong in another is the footgun; the
   * caller holds the admin row, so the caller passes the flag. D-60.
   */
  async scopeFor(adminId: string, seesUntriaged: boolean): Promise<ClientScope> {
    return scopeOf(await this.tagIdsFor(adminId), seesUntriaged);
  }

  /** The scope with tag names attached, for the admin directory and the modal. */
  async describeFor(adminId: string): Promise<AdminScopeTag[]> {
    return this.db
      .select({
        tagId: clientTags.id,
        slug: clientTags.slug,
        label: clientTags.label,
      })
      .from(adminClientTagScopes)
      .innerJoin(clientTags, eq(clientTags.id, adminClientTagScopes.tagId))
      .where(eq(adminClientTagScopes.adminId, adminId));
  }

  /**
   * Replaces an admin's whole territory, in one transaction.
   *
   * Whole-set replace rather than add/remove, because a territory is edited as
   * a set on one screen by one person — unlike a client's tags, where two
   * admins tagging concurrently is routine and a replace would silently discard
   * one of them.
   *
   * The delete and the insert must not be separable: between them the admin has
   * NO scope rows, which means UNRESTRICTED. A crash in that gap would leave
   * them able to see every client, and nothing about the resulting state would
   * look wrong.
   */
  async replace(
    adminId: string,
    tagIds: readonly string[],
    actorId: string,
    outerTx?: Executor,
  ): Promise<void> {
    const run = async (tx: Executor) => {
      await tx.delete(adminClientTagScopes).where(eq(adminClientTagScopes.adminId, adminId));
      if (tagIds.length === 0) return;
      await tx.insert(adminClientTagScopes).values(
        tagIds.map((tagId) => ({
          adminId,
          tagId,
          createdBy: actorId,
        })),
      );
    };
    // Join the caller's transaction when one is offered — acceptInvite writes
    // the admin row and its territory atomically, because a scope write that
    // fails AFTER the row exists leaves an admin with no scope rows, and no
    // scope rows means UNRESTRICTED (client-scope.ts).
    if (outerTx) return run(outerTx);
    await this.db.transaction(async (tx: Executor) => run(tx));
  }

  /** Whether any admin is scoped to these tags — blocks deleting one. */
  async countForTags(tagIds: readonly string[]): Promise<number> {
    if (tagIds.length === 0) return 0;
    const rows = await this.db
      .select({ adminId: adminClientTagScopes.adminId })
      .from(adminClientTagScopes)
      .where(inArray(adminClientTagScopes.tagId, [...tagIds]));
    return rows.length;
  }
}
