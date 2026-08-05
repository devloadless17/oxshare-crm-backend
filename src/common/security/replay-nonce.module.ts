import { Global, Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { NONCE_REDIS, ReplayNonceStore, type NonceRedis } from './replay-nonce.store';

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
/**
 * The commands the withdrawal OTP needs — FR-CORE-08, §8.4.
 *
 * A SECOND token over the SAME connection, not a second client: one Redis
 * process, one socket, two narrowly-typed views of it. Declaring only the
 * commands each use actually issues keeps a fake honest — a test double that has
 * to implement `set/get/del/incr/pexpire` and nothing else cannot quietly
 * diverge from the real client's behaviour on commands nobody calls.
 */
export interface OtpRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  pexpire(key: string, ttlMs: number): Promise<number>;
}

export const OTP_REDIS = Symbol('OTP_REDIS');

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
              'unchecked. Legal only while MT5_BRIDGE_SECRET is also unset.',
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
  ],
  exports: [ReplayNonceStore, OTP_REDIS],
})
export class ReplayNonceModule {}
