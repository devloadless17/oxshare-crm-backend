import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';
import { StoredFilesService } from './stored-files.service';
import { DiskStorageDriver } from './storage/disk.storage-driver';
import { R2StorageDriver } from './storage/r2.storage-driver';
import { STORAGE_DRIVER, type StorageDriver } from './storage/storage-driver';

/**
 * Object storage, wired once.
 *
 * `@Global()` for the same reason `StoreModule` is: `StoredFilesService` is needed
 * by four modules (identity, admin, payments, compliance) and used to be provided
 * separately by two of them and re-exported by a third. That produced more than one
 * instance of a service that owns a connection pool, and it meant "where does the
 * upload service come from" had a different answer per module.
 *
 * ## Driver selection is an EXPLICIT opt-in, never a fallback
 *
 * The tempting wiring is "use R2 when the credentials are present, disk when they
 * are not". That is a silent downgrade: one typo'd variable and a deployment starts
 * cleanly, writes every identity document to a container filesystem, and reports
 * nothing. PLATFORM-CONVENTIONS R-7.3 already names where that ends — "losing the
 * API host loses the KYC documents" — and arriving there by accident is strictly
 * worse than arriving there on purpose.
 *
 * So the choice is made by `STORAGE_DRIVER`, `env.validation.ts` refuses to boot
 * when it says `r2` without credentials, refuses `disk` outright in production, and
 * choosing `disk` anywhere else logs a warning loud enough to notice.
 */

/** Where the disk driver keeps its files — unchanged from before object storage. */
const DISK_ROOT = join(process.cwd(), 'uploads');

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_DRIVER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageDriver => {
        const logger = new Logger('StorageDriver');
        const driver = config.get<string>('STORAGE_DRIVER') ?? 'r2';

        if (driver === 'disk') {
          /*
           * Warned about every boot, deliberately.
           *
           * Production is already refused in env.validation.ts, so this is about
           * the environments in between — a staging box, a demo, a colleague's
           * machine standing in for one. Files written here are not backed up and
           * do not survive the container, and the only symptom is that they are
           * missing later.
           */
          logger.warn(
            JSON.stringify({
              event: 'storage.disk_driver',
              severity: 'warn',
              message:
                'STORAGE_DRIVER=disk — uploads go to the local filesystem and are NOT durable: ' +
                'not backed up, not replicated, lost with this host. Correct for development ' +
                'and the test suite; never for anything holding real client documents.',
              root: DISK_ROOT,
            }),
          );
          return new DiskStorageDriver(DISK_ROOT, logger);
        }

        // `getOrThrow`, matching how the signing secrets are read: env.validation.ts
        // has already refused to boot without these, so a throw here would mean the
        // two checks had drifted — which is worth failing loudly rather than
        // defaulting around.
        return new R2StorageDriver(
          {
            accountId: config.getOrThrow<string>('R2_ACCOUNT_ID'),
            accessKeyId: config.getOrThrow<string>('R2_ACCESS_KEY_ID'),
            secretAccessKey: config.getOrThrow<string>('R2_SECRET_ACCESS_KEY'),
            bucket: config.getOrThrow<string>('R2_BUCKET'),
          },
          logger,
        );
      },
    },
    /**
     * The legacy read fallback (dual-read).
     *
     * Documents uploaded before the R2 move are still on this host's disk, and
     * there is no backfill migration, so `StoredFilesService` tries the active
     * driver and then this one. When the active driver IS disk, the two are the
     * same store and the fallback is a harmless second miss.
     */
    {
      provide: StoredFilesService.LEGACY_DISK_DRIVER,
      useFactory: () => new DiskStorageDriver(DISK_ROOT, new Logger('LegacyDiskStorage')),
    },
    StoredFilesService,
  ],
  exports: [STORAGE_DRIVER, StoredFilesService],
})
export class UploadsModule {}
