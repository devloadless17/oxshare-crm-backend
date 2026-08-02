import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export const DRIZZLE_DB = 'DRIZZLE_DB';

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE_DB,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const connectionString = configService.get<string>('DATABASE_URL');
        
        // Return a mock / in-memory fallback pool if DATABASE_URL is not yet provided
        const pool = new Pool({
          connectionString: connectionString || 'postgres://postgres:postgres@localhost:5432/oxshare',
          ssl: connectionString?.includes('neon.tech') || connectionString?.includes('supabase')
            ? { rejectUnauthorized: false }
            : false,
        });

        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DRIZZLE_DB],
})
export class DatabaseModule {}
