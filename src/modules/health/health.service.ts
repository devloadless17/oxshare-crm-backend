import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { StoredFilesService } from '../../common/uploads/stored-files.service';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { pendingMigrations, shippedMigrations } from '../../database/migration-status';
import { HEALTH_REDIS, type PingableRedis } from '../../common/security/replay-nonce.store';
import { DependencyHealthDto, ReadinessDto } from './dto/health.dto';

/**
 * Liveness and readiness are different questions — PLATFORM-CONVENTIONS R-6.4.
 *
 * The previous /health returned a hardcoded `{ status: 'ok' }` and a list of
 * module names. It checked nothing: with Postgres stopped it still answered 200,
 * so a load balancer trusting it would route traffic to an instance that cannot
 * serve a single request. docs/CLAUDE.md asks for "health endpoints covering
 * database, Redis, and bridge reachability"; this is that.
 *
 * Liveness  — is the process running? Never touches a dependency, because
 *             restarting a healthy process due to a slow database makes an
 *             outage worse, not better.
 * Readiness — can it actually serve? Touches every dependency it needs.
 */
@Injectable()
export class HealthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(HealthService.name);

  /** A readiness probe must never hang; an unreachable host would otherwise
   *  block until the pool's own 10s connect timeout. */
  private static readonly PROBE_TIMEOUT_MS = 2_000;

  /**
   * How long a storage probe's answer is reused.
   *
   * Unlike the Postgres check, this one costs a BILLED round trip to Cloudflare, and
   * a readiness endpoint is polled continuously by whatever is running the process.
   * Probing per request would turn a health check into a line item, and a health
   * check with a cost attached is one somebody eventually switches off.
   *
   * 60s is well inside any sensible probe window while collapsing a poll every few
   * seconds into one call a minute.
   */
  private static readonly STORAGE_CACHE_MS = 60_000;

  private storageProbe: { at: number; result: DependencyHealthDto } | null = null;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly files: StoredFilesService,
    /*
     * The SAME connection the throttler and the replay markers use, under a
     * ping-only view. Null exactly when REDIS_URL is unset, which
     * env.validation permits only while no signed webhook endpoint is live.
     */
    @Inject(HEALTH_REDIS) private readonly redis: PingableRedis | null,
  ) {}

  liveness() {
    return {
      status: 'ok' as const,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  async readiness(): Promise<ReadinessDto> {
    // Real probes run concurrently, so readiness costs one round trip however
    // many dependencies there are. The declared-but-unbuilt ones are config
    // reads, not probes, and are kept separate rather than dressed up as
    // promises — `await-thenable` catches that, and it is right to: a synchronous
    // check inside Promise.all reads as if something is being contacted.
    const probed = await Promise.all([
      this.checkPostgres(),
      this.checkStorage(),
      this.checkMigrations(),
      this.checkRedis(),
    ]);
    const dependencies = [...probed];

    // 'not_configured' is not a failure — the queues are a later milestone
    // (ARCHITECTURE §9). Only a REQUIRED dependency that is actually down makes
    // the instance unready.
    const failed = dependencies.filter((d) => d.required && d.status === 'down');

    return {
      status: failed.length === 0 ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }

  /**
   * Is the object store reachable?
   *
   * REQUIRED, because an API that cannot reach storage cannot accept a KYC document
   * or serve one to a reviewer — the upload fails loudly rather than falling back to
   * local disk, which is the deliberate asymmetry in `StoredFilesService.read`.
   *
   * Cached — see `STORAGE_CACHE_MS`. The cached value is returned with its ORIGINAL
   * latency reading rather than a fresh zero, so the number in the payload always
   * describes a real round trip.
   */
  private async checkStorage(): Promise<DependencyHealthDto> {
    const now = Date.now();
    if (this.storageProbe && now - this.storageProbe.at < HealthService.STORAGE_CACHE_MS) {
      return this.storageProbe.result;
    }

    const startedAt = process.hrtime.bigint();
    const name = `storage (${this.files.providerName})`;
    let result: DependencyHealthDto;
    try {
      const ok = await this.withTimeout(this.files.healthy(), 'storage');
      result = ok
        ? { name, status: 'up', latencyMs: this.elapsedMs(startedAt), required: true }
        : {
            name,
            status: 'down',
            latencyMs: this.elapsedMs(startedAt),
            detail: 'The bucket did not respond as reachable. See server logs.',
            required: true,
          };
    } catch (error) {
      // Summarised in the response for the reason the Postgres probe gives: this
      // endpoint is public, and a storage error can echo the account id and bucket
      // name back to an unauthenticated caller.
      this.logger.error(
        `Readiness probe failed for storage: ${error instanceof Error ? error.message : String(error)}`,
      );
      result = {
        name,
        status: 'down',
        latencyMs: this.elapsedMs(startedAt),
        detail: 'Unreachable or timed out. See server logs for the reason.',
        required: true,
      };
    }

    this.storageProbe = { at: now, result };
    return result;
  }

  /**
   * Say, once and loudly at startup, when this build is running on a database
   * that has not had its migrations. Not awaited: a slow database must not hold
   * the process back from answering, and the readiness check repeats it.
   */
  onApplicationBootstrap(): void {
    void this.pending().then(
      (pending) => {
        if (pending && pending.length > 0) {
          this.logger.error(
            `The database is missing ${pending.length} migration(s) this build needs: ` +
              `${pending.map((entry) => entry.tag).join(', ')}. Features that use them will fail ` +
              'until they run. Run `npm run db:migrate` in the backend folder on this server.',
          );
        }
      },
      () => undefined,
    );
  }

  /** The shipped migrations this database has not run; null when that cannot be told. */
  private async pending() {
    const shipped = shippedMigrations();
    if (!shipped) return null;
    const result = await this.withTimeout(
      this.db.execute(sql`SELECT max(created_at)::text AS last FROM drizzle.__drizzle_migrations`),
      'migrations',
    );
    const rows = (result as unknown as { rows?: { last: string | null }[] }).rows ?? [];
    const last = rows[0]?.last ? Number(rows[0].last) : null;
    return pendingMigrations(shipped, last);
  }

  /**
   * Has this database run every migration this build ships?
   *
   * NOT required: an unmigrated schema breaks the features that need the new
   * migrations, not the whole API, and taking every request out of service
   * over it would turn one broken screen into an outage. It is reported as
   * down, with how many are missing, so the gap is visible on the endpoint an
   * operator checks after every deploy. The tags themselves go to the server
   * log, not to this unauthenticated payload.
   */
  private async checkMigrations(): Promise<DependencyHealthDto> {
    const name = 'database migrations';
    try {
      const pending = await this.pending();
      if (pending === null) {
        return {
          name,
          status: 'not_configured',
          detail:
            'The migration journal is not on disk beside this build, so this cannot be checked.',
          required: false,
        };
      }
      if (pending.length === 0) return { name, status: 'up', required: false };
      return {
        name,
        status: 'down',
        detail:
          `${pending.length} migration(s) this build needs have not been applied. Run ` +
          '`npm run db:migrate` on this server; the server log names them.',
        required: false,
      };
    } catch (error) {
      this.logger.error(
        `Could not read the applied migrations: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        name,
        status: 'down',
        detail: 'Could not read the applied migrations. See server logs for the reason.',
        required: false,
      };
    }
  }

  /**
   * Is Redis actually answering?
   *
   * This used to be a config read dressed as a result: `up` whenever REDIS_URL
   * was a non-empty string, with nothing contacted, and a detail line reading
   * "no client exists for it" — which had been false since ReplayNonceModule
   * started building one. So the endpoint an operator checks after a deploy
   * asserted a healthy dependency on the evidence that its address was typed.
   *
   * NOT required, and that is a judgement rather than an oversight. Redis backs
   * the throttler and the single-use replay markers: with it down, requests are
   * still served and signed webhooks are REFUSED rather than accepted unchecked
   * (see ReplayNonceStore). That is a real loss — deal ingestion stops — but it
   * is narrower than the whole API, and taking every request out of service over
   * it would turn stalled ingestion into an outage. It reports `down` so the
   * gap is visible, which is the thing that was missing.
   */
  private async checkRedis(): Promise<DependencyHealthDto> {
    const name = 'redis';
    if (!this.redis) {
      return {
        name,
        status: 'not_configured',
        detail: 'Not configured (REDIS_URL unset). Signed webhooks are refused while it is.',
        required: false,
      };
    }
    const startedAt = process.hrtime.bigint();
    try {
      await this.withTimeout(this.redis.ping(), 'redis');
      return { name, status: 'up', latencyMs: this.elapsedMs(startedAt), required: false };
    } catch (error) {
      // Summarised here, logged in full: a connection error echoes host and port
      // back to an unauthenticated caller, same reasoning as the Postgres probe.
      this.logger.error(
        `Readiness probe failed for redis: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        name,
        status: 'down',
        latencyMs: this.elapsedMs(startedAt),
        detail:
          'PING failed or timed out. The throttler falls back per-process and signed ' +
          'webhooks are being refused. See server logs for the reason.',
        required: false,
      };
    }
  }

  private async checkPostgres(): Promise<DependencyHealthDto> {
    const startedAt = process.hrtime.bigint();
    try {
      await this.withTimeout(this.db.execute(sql`select 1`), 'postgres');
      return {
        name: 'postgres',
        status: 'up',
        latencyMs: this.elapsedMs(startedAt),
        required: true,
      };
    } catch (error) {
      // The message is logged in full but only summarised in the response: a
      // connection error can echo the host, port and user back to an
      // unauthenticated caller, and this endpoint is deliberately public.
      this.logger.error(
        `Readiness probe failed for postgres: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        name: 'postgres',
        status: 'down',
        latencyMs: this.elapsedMs(startedAt),
        detail: 'Query failed or timed out. See server logs for the reason.',
        required: true,
      };
    }
  }

  private async withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`${label} probe timed out after ${HealthService.PROBE_TIMEOUT_MS}ms`)),
        HealthService.PROBE_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      // Without this the timer keeps the event loop alive for its full duration
      // on every probe — harmless once, measurable when a load balancer polls
      // this endpoint every few seconds forever.
      if (timer) clearTimeout(timer);
    }
  }

  private elapsedMs(startedAt: bigint): number {
    return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
  }
}
