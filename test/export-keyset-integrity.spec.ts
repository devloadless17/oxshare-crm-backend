import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminExportService, type ExportSeek } from '../src/modules/admin/admin-export.service';
import { AuditLogStore } from '../src/store/audit-log.store';
import { UNRESTRICTED } from '../src/common/security/client-scope';
import { EMPTY_MASK } from '../src/common/security/field-mask';
import { EXPORT_BATCH_SIZE } from '../src/common/export/export-response';
import type { AuthenticatedAdmin } from '../src/modules/admin/guards/admin.guard';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/*
 * The audit-log export pages by KEYSET. It used to fetch batch N as
 * `OFFSET N*1000` over newest-first, so a row written while the file streamed
 * (the export writes its own audit row) pushed the last row of each batch into
 * the next one: the file held it twice.
 */
describe('audit-log export — keyset batches', () => {
  let ctx: MoneyTestContext;
  let exports: AdminExportService;
  let audit: AuditLogStore;
  const actor = {
    id: '00000000-0000-4000-8000-000000000001',
    permissions: ['audit.view'],
    clientScope: UNRESTRICTED,
    fieldMask: EMPTY_MASK,
  } as unknown as AuthenticatedAdmin;

  beforeAll(async () => {
    ctx = await startMoneyTestDb();
    audit = new AuditLogStore(ctx.db);
    exports = new AdminExportService(
      ...([{}, {}, {}, audit, {}, {}, {}, {}, {}] as unknown as ConstructorParameters<
        typeof AdminExportService
      >),
    );
    await ctx.db.execute(sql`
      INSERT INTO audit_log (actor_id, actor_email, action, subject_type, subject_id, created_at)
      SELECT ${actor.id}, 'a@x.test', 'test.row', 'role', g::text,
             now() - (g || ' milliseconds')::interval
      FROM generate_series(1, ${EXPORT_BATCH_SIZE + 500}) g
    `);
  }, 120_000);

  afterAll(async () => {
    await stopMoneyTestDb(ctx);
  });

  it('exports every row exactly once while new rows arrive between batches', async () => {
    const seek: ExportSeek = {};
    const ids: string[] = [];
    let batch = await exports.auditBatch({}, actor, 0, EXPORT_BATCH_SIZE, seek);
    ids.push(...batch.map((r) => r.id));
    // A row lands at the HEAD between batches — exactly what shifted OFFSET.
    await audit.record({
      actorId: actor.id,
      actorEmail: 'a@x.test',
      actorKind: 'admin',
      action: 'export.audit_log',
      subjectType: 'role',
      subjectId: 'mid-export',
    });
    batch = await exports.auditBatch({}, actor, ids.length, EXPORT_BATCH_SIZE, seek);
    ids.push(...batch.map((r) => r.id));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(EXPORT_BATCH_SIZE + 500);
  });

  it('ends after a last batch of EXACTLY the batch size, rather than starting over', async () => {
    await ctx.db.execute(sql`
      INSERT INTO audit_log (actor_id, actor_email, action, subject_type, subject_id, created_at)
      SELECT ${actor.id}, 'a@x.test', 'exact.row', 'role', g::text,
             now() - (g || ' milliseconds')::interval
      FROM generate_series(1, ${EXPORT_BATCH_SIZE}) g
    `);
    const seek: ExportSeek = {};
    const first = await exports.auditBatch(
      { action: 'exact.row' },
      actor,
      0,
      EXPORT_BATCH_SIZE,
      seek,
    );
    expect(first).toHaveLength(EXPORT_BATCH_SIZE);
    // `streamCsv` asks again after a full batch; a cursor-less ask was page 1.
    const second = await exports.auditBatch(
      { action: 'exact.row' },
      actor,
      EXPORT_BATCH_SIZE,
      EXPORT_BATCH_SIZE,
      seek,
    );
    expect(second).toHaveLength(0);
  });
});
