import { Global, Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  NONCE_REDIS,
  OTP_REDIS,
  ReplayNonceStore,
  type NonceRedis,
  type OtpRedis,
} from './replay-nonce.store';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * The Redis connection behind single-use replay markers (§8.4, R-5.3).
 *
 * `@Global` because this is infrastructure, like the database module: the
 * alternative is threading an import through every module that ever verifies a
 * signed callback, and Whish and USDT are both coming.
 *
 * `null` when REDIS_URL is unset — which is legal ONLY when the bridge secret is
 * also unset, because `env.validation.ts` refuses to start otherwise. The store
 * turns a null client into a REFUSAL rather than a bypass, so the worst case of
 * a misconfiguration is a rejected webhook rather than an accepted replay.
 *
 * `lazyConnect` so constructing the client never blocks boot on a Redis that is
 * still starting; the first command connects. A dead Redis therefore surfaces as
 * a refused webhook, which is the failure we want, rather than a process that
 * will not start.
 */
@Global()
@Module({
  providers: [
    {
      provide: NONCE_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): NonceRedis | null => {
        const url = config.get<string>('REDIS_URL');
        if (!url) {
          new Logger('ReplayNonce').warn(
            'REDIS_URL is not set — signed webhooks will be REFUSED rather than accepted ' +
              'unchecked. Legal only while no signed webhook endpoint is live.',
          );
          return null;
        }

        const client = new Redis(url, {
          lazyConnect: true,
          maxRetriesPerRequest: 2,
          // Never let a slow Redis hold a webhook open: the caller is a bridge
          // with its own timeout, and a hung request is indistinguishable from
          // an accepted one from its side.
          commandTimeout: 2_000,
        });

        // An 'error' event with no listener terminates Node — the same defect
        // that made a Postgres restart take down every instance at once.
        client.on('error', (error: Error) => {
          new Logger('ReplayNonce').error(`Redis connection error: ${error.message}`);
        });

        return client;
      },
    },
    {
      // The SAME connection under a second token — see OtpRedis above.
      provide: OTP_REDIS,
      inject: [NONCE_REDIS],
      useFactory: (client: NonceRedis | null): OtpRedis | null => client as OtpRedis | null,
    },
    ReplayNonceStore,
    RedisThrottlerStorage,
  ],
  exports: [ReplayNonceStore, OTP_REDIS, RedisThrottlerStorage],
})
export class ReplayNonceModule {}
