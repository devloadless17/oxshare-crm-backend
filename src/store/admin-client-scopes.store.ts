import { eq, inArray, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { adminClientTagScopes, clientTags } from '../database/schema';
import { scopeOf, type ClientScope } from '../common/security/client-scope';
import { SharedRead } from '../common/shared-read';

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
   * The resolved scope of an administrator — `scopeOf` over their territory
   * and the all-clients grant on their row.
   *
   * Takes the ROW, not an id and a flag: two callers once took a defaulted
   * grant rather than reading the row they held, and lost sight in exactly
   * those paths.
   */
  async scopeFor(admin: { id: string; seesAllClients?: boolean }): Promise<ClientScope> {
    return this.sized(
      scopeOf(
        await this.tagIdsFor(admin.id),
        // Absent reads as NOT granted: a row without the column is restricted.
        admin.seesAllClients ?? false,
      ),
    );
  }

  /** A territory's size class and the platform's size are asked rarely, not per request. */
  private readonly compactTerritories = new SharedRead<boolean>(30_000);
  private readonly platformSize = new SharedRead<number>(600_000);

  /**
   * Marks a territory `compact` when reading from its clients is the cheaper
   * way to apply it (see `clientScopePredicate`). It never changes who is seen.
   *
   * Starting from the clients costs about the territory's size; walking a list
   * costs about (rows wanted x platform / territory). They cross near
   * sqrt(26 x clients on the platform): about 5,000 at a million clients. The
   * limit follows the platform as it grows, between 2,000 and 20,000. A
   * territory is counted only up to that limit, through the tag index.
   */
  async sized(scope: ClientScope): Promise<ClientScope> {
    if (scope.unrestricted || scope.tagIds.length === 0) return scope;
    const tags = [...scope.tagIds].sort();
    try {
      const compact = await this.compactTerritories.get(tags.join(','), async () => {
        const clients = await this.platformSize.get('clients', async () => {
          const { rows } = await this.db.execute<{ n: number }>(
            sql`SELECT greatest(reltuples, 0)::bigint::int AS n FROM pg_class WHERE oid = 'users'::regclass`,
          );
          return rows[0]?.n ?? 0;
        });
        const limit = Math.min(20_000, Math.max(2_000, Math.round(Math.sqrt(26 * clients))));
        const { rows } = await this.db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM (
            SELECT 1 FROM client_tag_assignments
             WHERE tag_id IN (${sql.join(
               tags.map((id) => sql`${id}::uuid`),
               sql`, `,
             )})
             LIMIT ${limit + 1}
          ) counted`);
        return (rows[0]?.n ?? 0) <= limit;
      });
      return compact ? { ...scope, compact: true } : scope;
    } catch {
      // Only how the territory is read is at stake: unmarked is always correct.
      return scope;
    }
  }

  /**
   * `scopeFor` for MANY administrators in ONE query — the notification fan-out,
   * which used to await one territory lookup per admin on the request path of
   * every deposit, withdrawal and KYC submit. Same rule as `scopeFor`, same
   * fail-loud stance: no try/catch, a database error propagates.
   */
  async scopesFor(
    admins: readonly { id: string; seesAllClients?: boolean }[],
  ): Promise<Map<string, ClientScope>> {
    const tagIdsByAdmin = new Map<string, string[]>();
    if (admins.length > 0) {
      const rows = await this.db
        .select({ adminId: adminClientTagScopes.adminId, tagId: adminClientTagScopes.tagId })
        .from(adminClientTagScopes)
        .where(
          inArray(
            adminClientTagScopes.adminId,
            admins.map((a) => a.id),
          ),
        );
      for (const row of rows) {
        const list = tagIdsByAdmin.get(row.adminId) ?? [];
        list.push(row.tagId);
        tagIdsByAdmin.set(row.adminId, list);
      }
    }
    return new Map(
      admins.map((admin) => [
        admin.id,
        scopeOf(tagIdsByAdmin.get(admin.id) ?? [], admin.seesAllClients ?? false),
      ]),
    );
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
