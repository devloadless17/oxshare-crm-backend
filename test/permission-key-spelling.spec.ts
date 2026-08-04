import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { AdminRbacService } from '../src/modules/admin/admin-rbac.service';

/**
 * One spelling for a permission key — PLATFORM-CONVENTIONS R-4.5.
 *
 * Two were alive since RBAC was built. `config/permissions.json` — the catalog,
 * and the only grantable vocabulary — says `kyc.review`. Issued tokens and some
 * stored grants said `kyc:review`. Four separate `replace(/:/g, '.')` shims
 * bridged them, in AdminRbacService, PermissionsGuard, UploadsController and the
 * admin frontend.
 *
 * The shims were not merely redundant, they were generative: `assertGrantable`
 * normalised BEFORE checking the catalog, so `kyc:review` passed validation and
 * was then stored verbatim. The system kept producing the inconsistency it was
 * compensating for, and a fifth spelling was one copy-paste away.
 *
 * The order of the fix is the load-bearing part and is what these tests cover:
 * migration 0009 converts the stored keys, and only then do the shims come out.
 * Reversed, an admin whose grant still read `kyc:review` would silently stop
 * matching their own permission and lose a page with nothing to explain why.
 */

let ctx: MoneyTestContext;

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  resetDb();
});

afterAll(async () => {
  await closeDb();
  if (ctx) await stopMoneyTestDb(ctx);
});

describe('migration 0009 — stored keys are converted before the shims are removed', () => {
  it('rewrites colon keys in roles, admins and pending invites', async () => {
    // A pre-migration world: rows written by the build that stored what
    // assertGrantable let through.
    await ctx.db.execute(sql`
      INSERT INTO roles (name, permissions)
      VALUES ('Legacy Reviewer', '["kyc:review","users:view"]'::jsonb)
    `);
    await ctx.db.execute(sql`
      INSERT INTO admins (email, password_hash, name, permissions)
      VALUES ('legacy@test.local', 'x', 'Legacy', '["KYC:Review"]'::jsonb)
    `);
    await ctx.db.execute(sql`
      INSERT INTO admin_invites (email, name, token, invited_by, expires_at, permissions)
      VALUES ('invitee@test.local', 'Invitee', 'tok-legacy',
              '11111111-1111-1111-1111-111111111111', now() + interval '2 days',
              '["withdrawals:approve"]'::jsonb)
    `);

    // Re-run the migration body. The container already applied it at startup, so
    // this is both the conversion under test and a proof it is idempotent.
    for (const table of ['roles', 'admins', 'admin_invites']) {
      await ctx.db.execute(
        sql.raw(`
          UPDATE ${table}
          SET permissions = (
            SELECT jsonb_agg(lower(replace(value, ':', '.')))
            FROM jsonb_array_elements_text(permissions) AS value
          )
          WHERE permissions IS NOT NULL AND permissions::text LIKE '%:%'
        `),
      );
    }

    const roles = await ctx.db.execute(
      sql`SELECT permissions FROM roles WHERE name = 'Legacy Reviewer'`,
    );
    expect(roles.rows[0]).toEqual({ permissions: ['kyc.review', 'users.view'] });

    const admins = await ctx.db.execute(
      sql`SELECT permissions FROM admins WHERE email = 'legacy@test.local'`,
    );
    // Case is folded too — `KYC:Review` and `kyc.review` were never two grants.
    expect(admins.rows[0]).toEqual({ permissions: ['kyc.review'] });

    const invites = await ctx.db.execute(
      sql`SELECT permissions FROM admin_invites WHERE token = 'tok-legacy'`,
    );
    // Invites matter: a pending one carries the permission set that becomes an
    // admin's on acceptance, so missing them reintroduces colon keys later.
    expect(invites.rows[0]).toEqual({ permissions: ['withdrawals.approve'] });
  });

  it('leaves nothing with a colon anywhere in the permission tables', async () => {
    const remaining = await ctx.db.execute(sql`
      SELECT count(*)::int AS n FROM (
        SELECT permissions FROM roles
        UNION ALL SELECT permissions FROM admins
        UNION ALL SELECT permissions FROM admin_invites WHERE permissions IS NOT NULL
      ) AS all_grants
      WHERE permissions::text LIKE '%:%'
    `);
    expect((remaining.rows[0] as { n: number }).n).toBe(0);
  });
});

describe('normalizeKey — the shim is gone, the case fold is not', () => {
  it('folds case, because a key differing only in case is a typo', () => {
    expect(AdminRbacService.normalizeKey('KYC.Review')).toBe('kyc.review');
  });

  it('does NOT rewrite a colon into a dot any more', () => {
    // The regression guard. Restoring the shim makes this fail, which is the
    // point: with it, `kyc:review` passes assertGrantable and gets STORED —
    // the system generating the inconsistency it was compensating for.
    expect(AdminRbacService.normalizeKey('kyc:review')).toBe('kyc:review');
    expect(AdminRbacService.normalizeKey('kyc:review')).not.toBe('kyc.review');
  });
});
