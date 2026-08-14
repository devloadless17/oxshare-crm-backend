import { Module, Global, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { closeDb, getDb } from './db';

export const DRIZZLE_DB = 'DRIZZLE_DB';

// Exposes the same lazy singleton the stores use (src/database/db.ts) to
// Nest DI consumers. One pool, one drizzle instance, created on first use.
@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE_DB,
      useFactory: () => getDb(),
    },
  ],
  exports: [DRIZZLE_DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseModule.name);

  /*
   * `closeDb()` has existed since the pool was introduced and nothing called it:
   * no module implemented a shutdown hook, so on every redeploy the process died
   * with its connections still open and Postgres reaped them on its own timeout.
   * Harmless at one instance and a slow leak at several.
   *
   * Only reached because main.ts calls `app.enableShutdownHooks()` — without
   * that, Nest never runs this and SIGTERM terminates the process outright.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Closing Postgres pool (${signal ?? 'no signal'})`);
    await closeDb();
  }
}
