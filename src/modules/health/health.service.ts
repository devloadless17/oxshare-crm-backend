import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { StoredFilesService } from '../../common/uploads/stored-files.service';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
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
export class HealthService {
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
    private readonly config: ConfigService,
    private readonly files: StoredFilesService,
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
    const probed = await Promise.all([this.checkPostgres(), this.checkStorage()]);
    const declared = [this.checkOptional('redis', 'REDIS_URL')];
    const dependencies = [...probed, ...declared];

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

  /**
   * A dependency that is not wired yet reports `not_configured` rather than being
   * omitted. Omitting it would let this endpoint imply a coverage it does not
   * have — "ready" would silently mean "ready, apart from the parts nobody
   * checked". When Redis and the bridge land, each gets a real probe here and
   * `required: true`.
   */
  private checkOptional(name: string, configKey: string): DependencyHealthDto {
    const configured = Boolean(this.config.get<string>(configKey));
    return {
      name,
      status: configured ? 'up' : 'not_configured',
      detail: configured
        ? 'Configured but not probed yet — no client exists for it.'
        : `Not configured (${configKey} unset). Expected until that milestone lands.`,
      required: false,
    };
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
