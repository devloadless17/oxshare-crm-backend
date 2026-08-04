import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { CommissionService } from '../partners/commission.service';

interface BridgeDeal {
  ticket: number | string;
  login: number | string;
  symbol: string;
  volume: string;
  spread: string;
  profit?: string;
  opened_at?: string;
  closed_at: string;
}

/**
 * The push half of MT5 ingestion (BRIDGE-CONTRACT, §3.1, §8.6).
 *
 * The bridge subscribes to MT5 deal events and POSTs them here. The sweep job
 * will re-poll a 24-hour window independently and hit the SAME handler —
 * "push alone loses deals under network partition, and a lost deal is an
 * unpaid partner." Double delivery is harmless because ingest is idempotent on
 * UNIQUE(mt5_ticket).
 *
 * Security, per the contract:
 *  - a shared-secret token header, and
 *  - an HMAC-SHA256 signature over the RAW body, verified BEFORE parsing,
 *    compared in constant time.
 *
 * Deviation worth flagging: the contract says enqueue and return 202 without
 * inline work. There are no queues yet (§9/BullMQ is a later milestone), so
 * this processes inline and still answers 202. When BullMQ lands, the body of
 * the handler becomes a job payload and nothing else changes.
 */
@ApiTags('trading')
@Controller('webhooks/mt5')
export class Mt5WebhookController {
  private readonly logger = new Logger(Mt5WebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly commission: CommissionService,
  ) {}

  @Post('deals')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiExcludeEndpoint() // bridge-to-API only; never called by a browser
  @ApiOperation({ summary: 'Closed deals pushed by the MT5 bridge' })
  async receiveDeals(@Req() req: Request & { rawBody?: Buffer }) {
    this.assertAuthentic(req);

    const body = req.body as { deals?: BridgeDeal[] };
    const incoming = Array.isArray(body?.deals) ? body.deals : [];
    if (incoming.length === 0) {
      throw new BadRequestException('Expected a non-empty `deals` array.');
    }

    let ingested = 0;
    let duplicates = 0;
    let accrued = 0;
    let failed = 0;

    // Ordered by closed_at ascending per the contract, so a partial failure
    // can resume. One bad deal must not abort the batch.
    for (const deal of incoming) {
      try {
        const result = await this.commission.ingestAndAccrue({
          mt5Ticket: String(deal.ticket),
          mt5Login: String(deal.login),
          symbol: deal.symbol,
          volume: deal.volume,
          spread: deal.spread,
          profit: deal.profit,
          openedAt: deal.opened_at ? new Date(deal.opened_at) : undefined,
          closedAt: new Date(deal.closed_at),
        });
        if (result.created) ingested += 1;
        else duplicates += 1;
        accrued += result.accruals.length;
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Failed to ingest deal ${String(deal.ticket)}: ${(error as Error).message}`,
        );
      }
    }

    this.logger.log(
      `MT5 batch: ${ingested} ingested, ${duplicates} already seen, ${accrued} accruals, ${failed} failed`,
    );
    return { received: incoming.length, ingested, duplicates, accrued, failed };
  }

  /**
   * Verified against the RAW body — re-serializing the parsed object would
   * produce different bytes and break the signature.
   */
  private assertAuthentic(req: Request & { rawBody?: Buffer }) {
    const secret = this.config.get<string>('MT5_BRIDGE_SECRET', '');
    if (!secret) {
      // Refusing is the safe failure: an unauthenticated deal feed can mint
      // commission out of thin air.
      throw new UnauthorizedException('MT5_BRIDGE_SECRET is not configured; refusing deal push.');
    }

    const token = req.header('X-Bridge-Token');
    if (!token || !constantTimeEquals(token, secret)) {
      throw new UnauthorizedException('Invalid bridge token.');
    }

    const signature = req.header('X-Bridge-Signature');
    if (!signature) throw new UnauthorizedException('Missing X-Bridge-Signature.');

    const raw = req.rawBody;
    if (!raw) {
      throw new UnauthorizedException('Raw body unavailable; cannot verify signature.');
    }
    /*
     * The timestamp is part of what is signed — PLATFORM-CONVENTIONS R-5.3.
     *
     * Without it, a captured signed body replays forever. That happens to be
     * harmless for deals, because ingest is idempotent on `mt5_ticket` — but
     * that is a property of the DOWNSTREAM handler, not of this endpoint, and
     * the Whish and USDT callbacks will arrive at code that has no such
     * guarantee. Making the window part of verification here means those
     * integrations inherit it instead of re-deriving it.
     *
     * Signed as `timestamp.body` rather than just `body`, so an attacker cannot
     * keep an old signature and simply attach a fresh timestamp.
     */
    const timestamp = req.header('X-Bridge-Timestamp');
    const signedPayload = timestamp ? `${timestamp}.${raw.toString('utf8')}` : raw.toString('utf8');
    const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');
    if (!constantTimeEquals(signature, expected)) {
      throw new UnauthorizedException('Bridge signature verification failed.');
    }

    if (timestamp) {
      const sentAt = Date.parse(timestamp);
      if (Number.isNaN(sentAt)) {
        throw new UnauthorizedException('X-Bridge-Timestamp is not a valid ISO-8601 instant.');
      }
      // A window in BOTH directions: a future timestamp is as suspicious as an
      // old one, and modest clock skew between our host and the Windows bridge
      // is normal rather than an attack (§12.5 on clock discipline).
      const skewMs = Math.abs(Date.now() - sentAt);
      if (skewMs > REPLAY_WINDOW_MS) {
        throw new UnauthorizedException(
          `X-Bridge-Timestamp is outside the ${REPLAY_WINDOW_MS / 60_000}-minute replay window.`,
        );
      }
    }
    // A push with no timestamp is still accepted, for exactly one release: the
    // bridge does not exist yet, and its stub must not be locked out before it
    // is written. Make it REQUIRED the moment the real bridge sends one —
    // BRIDGE-CONTRACT.md carries the same note.
  }
}

/** ±5 minutes. Wide enough for clock skew, narrow enough that a captured
 *  request is worthless by the time anyone could reuse it. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** Constant-time comparison — a fast reject leaks the secret one byte at a time. */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Hash both sides first so the comparison is always over equal-length input.
  const hashA = createHmac('sha256', 'len').update(bufA).digest();
  const hashB = createHmac('sha256', 'len').update(bufB).digest();
  return timingSafeEqual(hashA, hashB);
}
