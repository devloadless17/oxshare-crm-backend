import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles } from '../src/database/schema';

/**
 * The last-manager invariant under CONCURRENCY — the TOCTOU the advisory lock
 * closes. `assertKeepsAManager` predicts the post-write state, and prediction
 * is a read: before the lock, two concurrent demotions each counted the OTHER
 * admin as still a manager, both passed, and the console was left with nobody
 * able to manage roles or admins. The invariant is global (it counts across
 * ALL roles and admins), so only serialising the writes can protect it.
 */

const A = { email: 'race-manager-a@oxshare.com', password: 'admin-password-123' };
const B = { email: 'race-manager-b@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
let idA: string;
let idB: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const hash = await passwords.hash(A.password);

  /*
   * EXACTLY TWO admins hold the manager keys, so suspending both is the
   * console-lockout the invariant forbids — and the fixture where the race
   * used to slip through. No master beside them: a third manager would make
   * both suspensions individually legal.
   */
  const [managerRole] = await ctx.db.db
    .insert(roles)
    .values({
      name: 'Race Manager',
      permissions: ['roles.edit', 'admins.edit', 'admins.view', 'admins.suspend'],
    })
    .returning();
  const rows = await ctx.db.db
    .insert(admins)
    .values(
      [A, B].map((c, i) => ({
        email: c.email,
        passwordHash: hash,
        name: `Race Manager ${i}`,
        role: 'sub_admin' as const,
        roleId: managerRole.id,
        permissions: [],
        status: 'active' as const,
      })),
    )
    .returning();
  idA = rows.find((r) => r.email === A.email)!.id;
  idB = rows.find((r) => r.email === B.email)!.id;
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('two concurrent demotions of the last two managers', () => {
  it('exactly one succeeds; a manager always remains', async () => {
    const asA = await actingAs(ctx, 'admin', A);
    const asB = await actingAs(ctx, 'admin', B);

    // Fired in the same tick: A suspends B while B suspends A.
    const [aSuspendsB, bSuspendsA] = await Promise.all([
      asA.patch(`/v1/admin/users/${idB}/status`, { status: 'suspended' }),
      asB.patch(`/v1/admin/users/${idA}/status`, { status: 'suspended' }),
    ]);

    const statuses = [aSuspendsB.status, bSuspendsA.status].sort((x, y) => x - y);
    expect(statuses[0], 'one demotion must succeed').toBe(200);
    expect(
      statuses[1],
      'BOTH demotions succeeded — the console has no manager left',
    ).toBeGreaterThanOrEqual(400);

    // The invariant, read from the database: at least one ACTIVE admin still
    // resolves the manager keys.
    const remaining = await ctx.db.db.select().from(admins);
    const activeManagers = remaining.filter(
      (r) => r.status === 'active' && (r.email === A.email || r.email === B.email),
    );
    expect(activeManagers.length, 'nobody can manage the console any more').toBeGreaterThan(0);
  });
});

describe('the async authorization guards are always awaited', () => {
  it('no call site drops the await that once caused the escalation', () => {
    /*
     * REGRESSION C1's shape: `assertGrantable` is async, and a call without
     * `await` resolves to a pending promise — truthy, never thrown, so the
     * refusal evaporates and the write proceeds. This scan turns the
     * convention into a failure: every call to an async assert-guard in the
     * admin services must be awaited (or returned).
     */
    const GUARDS = [
      'assertGrantable',
      'assertRoleGrantable',
      'assertKeepsAManager',
      'assertScopable',
      'assertActorOutranks',
    ];
    const files = ['admin-rbac.service.ts', 'admin-auth.service.ts'].map((f) =>
      join(__dirname, '..', 'src', 'modules', 'admin', f),
    );
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const guard of GUARDS) {
          const at = line.indexOf(`this.${guard}(`);
          if (at === -1) continue;
          const before = line.slice(0, at);
          // Definitions ("async assertX(") and comments are not calls.
          if (/(?:async|\*|\/\/|\.)\s*$/.test(before)) continue;
          if (!/(?:await|return)\s+$/.test(before)) {
            offenders.push(`${file.split('/').pop()}:${i + 1} ${line.trim()}`);
          }
        }
      });
    }
    expect(offenders, `un-awaited guard calls:\n${offenders.join('\n')}`).toEqual([]);
  });
});
