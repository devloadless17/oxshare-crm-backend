import { Module, Global } from '@nestjs/common';
import { getDb } from './db';

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
export class DatabaseModule {}
