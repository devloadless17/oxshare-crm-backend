import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { AppSettingsStore } from '../../../store/app-settings.store';
import { scheduledJob } from '../../../common/scheduling/scheduled-jobs.catalog';
import { BridgeJobSettingsDto } from './dto/bridge-job-settings.dto';
import {
  ApiExcludeController,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { NoOriginCheck } from '../../../common/security/csrf.guard';
import { VALIDATION_PIPE_OPTIONS } from '../../../common/validation.config';
import { BridgeSecretGuard } from './bridge-secret.guard';
import { Mt5DealsService } from './mt5-deals.service';
import { Mt5AccountSyncService } from './mt5-account-sync.service';
import { Mt5AccountSnapshotDto } from './dto/mt5-account-snapshot.dto';
import { Mt5DealDto } from './dto/mt5-deal.dto';
import { Mt5DealBatchDto } from './dto/mt5-deal-batch.dto';
import { Mt5AccountBatchDto } from './dto/mt5-account-batch.dto';
import { Mt5LiveDto } from './dto/mt5-live.dto';
import { Mt5LiveService } from './mt5-live.service';

/**
 * Where the MT5 bridge posts closed deals — the push half of ARCHITECTURE
 * §3.1's "push + sweep".
 *
 * ── This endpoint always answers 200, even for a duplicate ─────────────────
 *
 * The bridge treats 2xx and 409 as delivered and retries everything else with
 * backoff, forever, because a deal it cannot deliver is a financial event the
 * CRM would never learn about. So the contract here is deliberately generous:
 * a re-delivered ticket is `{ ingested: false }` and a 200, not an error.
 *
 * The only 4xx it can produce is a malformed body (validation) or a bad secret,
 * and both are conditions a retry cannot fix — which is exactly why they must be
 * distinguishable from "the CRM is having a bad minute".
 *
 * ── Not in the public API docs ─────────────────────────────────────────────
 *
 * `@ApiExcludeController`: this is a private machine-to-machine surface on an
 * internal network, and publishing it in the OpenAPI document the admin console
 * generates its client from would invite somebody to call it from a browser.
 *
 * ── The credential is a shared secret. There is NO body signature ──────────
 *
 * This block used to claim the endpoint was authenticated by "the shared secret
 * and an HMAC over the raw body". Only the first half was ever true:
 * `BridgeSecretGuard` compares `X-Bridge-Secret` in fixed time and checks
 * nothing else, and the bridge sends no signature header to check — `Program.cs`
 * attaches `X-Bridge-Secret` and nothing more.
 *
 * Corrected rather than implemented, deliberately. ARCHITECTURE §3.1 asks for
 * "mTLS OR a shared secret", the transport is TLS on a private network, and an
 * HMAC over the raw body would add body integrity that TLS already provides —
 * at the cost of a raw-body middleware in an application that parses JSON
 * globally. What was actually costly was the sentence: a docblock describing a
 * control that does not exist is worse than one describing none, because it is
 * exactly what stops the next reader from checking. `rival-webhook.service.ts`
 * is where this codebase does verify a real signature, if a comparison is wanted.
 */
@ApiTags('mt5')
@ApiExcludeController()
@Controller('webhooks/mt5')
/*
 * ⚠️ This decorator is what lets the bridge's POST through the global
 * CsrfGuard, which refuses Origin-less writes by default. The bridge is a
 * server: it sends no Origin header, so WITHOUT this every real delivery was
 * answered 403 — an absence `csrf.spec.ts`'s webhook branch anticipated
 * ("Whish and USDT arrive the same way") but no HTTP-chain test caught,
 * because the unit tests exercised the guard and the controller separately.
 * Found while wiring the Rival webhook, which shares the guard path.
 */
@NoOriginCheck(
  'Server-to-server delivery from the MT5 bridge: authenticated by the shared secret in ' +
    'X-Bridge-Secret, compared in fixed time. No browser, no cookie, no Origin.',
)
/*
 * ── A MACHINE SURFACE MUST NOT SHARE A LIMIT SIZED FOR PEOPLE ──────────────
 *
 * The global limit is 120/min, chosen for a human clicking a console. The
 * bridge's account sweep sends ONE REQUEST PER ACCOUNT every
 * `SweepIntervalSeconds` (300), so a server with more than ~120 accounts
 * exhausts a limit meant for a person within seconds of every sweep.
 *
 * What made that a DATA LOSS bug rather than a slow one: `AccountSyncWorker`
 * treats any 4xx as a permanent rejection and does not retry it — correctly for
 * 400 or 404, disastrously for 429. So the accounts after the budget were
 * dropped, and because the sweep pushes in a stable order the SAME tail was
 * dropped on every sweep. Not a delay: a permanent blind spot, growing with the
 * account count, in the mirror an operator reads balances from.
 *
 * Raised rather than SKIPPED. `BridgeSecretGuard` already authenticates this,
 * so the limit is not what protects it — but a ceiling still bounds a leaked
 * secret and a bridge stuck in a retry loop, and "unlimited" is a decision
 * nobody would make deliberately.
 *
 * 6000/min is ~100/s, against ~16/s observed from a real sweep. It is also
 * comfortably past this design's OWN ceiling: at 16/s a 300s sweep cannot push
 * more than ~4,800 accounts before the next one starts, whatever the limit
 * says. Beyond that the answer is a batch endpoint, not a bigger number — one
 * request per account is the thing that does not scale, and no limit fixes it.
 */
@Throttle({ default: { limit: 6_000, ttl: 60_000 } })
/*
 * ── THE BRIDGE IS DEPLOYED SEPARATELY, SO AN EXTRA FIELD MUST NOT BE FATAL ──
 *
 * The global pipe sets `forbidNonWhitelisted: true`, which turns an unexpected
 * property into a 400. That is exactly right for a browser posting a form — the
 * caller and the contract disagreeing about a money field must be an error —
 * and exactly wrong here, because the sender is a different service on a
 * different release train.
 *
 * `validation.config.ts` states this principle and then assumes it is already
 * satisfied: "the bridge is a system we do not own ... so it must keep
 * tolerating extra fields", on the reasoning that a signed webhook reads the raw
 * body and never reaches the pipe. That is true of the Rival webhook. It has
 * never been true of THIS controller, which takes `@Body() dto` like any other
 * route — the exemption was documented and not implemented.
 *
 * It became load-bearing the moment the live payload grew a field. Ship the
 * bridge before the CRM and every push 400s: the deal outbox retries forever
 * against an error only a deploy can fix, and the live feed — which never
 * retries, by design — simply stops, with the account screen falling back to
 * polling and nothing on it saying why. That happened.
 *
 * `whitelist` STAYS, so an unknown field is still discarded rather than stored.
 * What changes is that discarding it is silent instead of fatal, which is the
 * behaviour every field on these DTOs already documents for a value it does not
 * recognise.
 *
 * This does NOT weaken the money path: every field the CRM acts on is still
 * validated by the same decorators, and a MISSING or malformed one still 400s.
 * The only thing now tolerated is a field this build has not heard of.
 */
@UsePipes(new ValidationPipe({ ...VALIDATION_PIPE_OPTIONS, forbidNonWhitelisted: false }))
@UseGuards(BridgeSecretGuard)
export class Mt5WebhooksController {
  constructor(
    private readonly deals: Mt5DealsService,
    private readonly accounts: Mt5AccountSyncService,
    private readonly live: Mt5LiveService,
    /** The job timings the bridge reads — Settings → Scheduled jobs (0167). Appended last. */
    private readonly settings: AppSettingsStore,
  ) {}

  /**
   * The bridge's job timings, set in Settings → Scheduled jobs (owner, 29 Sep
   * 2026) and read by the bridge once a minute (`CrmSettingsPoller`), so its
   * sweep interval is edited in the console rather than in the bridge's config.
   * Reading it stamps `external_read_at`, which the settings screen shows as
   * "the bridge picked this up N ago".
   */
  @Get('settings')
  @ApiOperation({ summary: 'The MT5 bridge job timings, as set in the CRM' })
  @ApiOkResponse({ type: BridgeJobSettingsDto })
  async bridgeSettings(): Promise<BridgeJobSettingsDto> {
    const job = scheduledJob('bridge.sweep');
    return {
      sweepIntervalSeconds: await this.settings.readExternalJob(
        'bridge.sweep',
        job?.defaultSeconds ?? 300,
      ),
    };
  }

  @Post('deals')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ingest one closed deal from the MT5 bridge' })
  @ApiOkResponse({
    description:
      '`ingested: false` means the ticket was already stored — the expected outcome for the ' +
      'second of the two deliveries every deal gets.',
  })
  async ingestDeal(
    @Body() deal: Mt5DealDto,
    /**
     * Which path delivered it. Recorded rather than acted on: when one of the
     * two ingestion routes breaks, "every deal for the last day arrived via
     * sweep" is the line that says so.
     */
    @Query('source') source?: string,
  ) {
    const result = await this.deals.ingest(deal, source === 'sweep' ? 'sweep' : 'push');
    return { dealId: deal.dealId, ...result };
  }

  /**
   * The logins this CRM holds, for the bridge's reconciliation pass.
   *
   * A GET on a webhook controller because it shares this surface's
   * authentication and its exemptions — the bridge is the only caller, and
   * giving it a second door with its own guard is how two authorisation paths
   * drift until one is missing a check.
   */
  @Get('logins')
  @ApiOperation({ summary: 'MT5 logins the CRM owns, so the bridge need not enumerate the book' })
  @ApiOkResponse({
    description:
      'Every login with a trading account here, ascending. The bridge reconciles against THIS ' +
      'set instead of every account on the broker server — most of which the CRM has never ' +
      'heard of and discards on arrival.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description:
      'Page size, capped at 50,000. OMIT IT and every login is returned, which is the ' +
      'pre-paging behaviour and is kept so a bridge that predates paging cannot silently ' +
      'reconcile only the first page.',
  })
  @ApiQuery({
    name: 'after',
    required: false,
    description:
      'Keyset cursor — the last login of the previous page. Keyset rather than offset because an ' +
      'account created mid-walk shifts every offset page after it, which here means skipping a ' +
      'login the reconciliation then never visits.',
  })
  async listKnownLogins(@Query('after') after?: string, @Query('limit') limit?: string) {
    const parsed = limit === undefined ? undefined : Number.parseInt(limit, 10);

    return await this.accounts.knownLogins({
      after,
      // A malformed limit falls through to unbounded rather than to a page of
      // NaN — the safe direction on an endpoint the balance mirror depends on.
      limit: parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
    });
  }

  /**
   * The SWEEP's delivery: many deals, one round trip.
   *
   * Per-deal outcomes come back so the bridge's outbox can mark entries
   * individually. Answering only "the batch worked" would force it to retire
   * all-or-nothing, and one bad row would either strand the good deliveries or
   * falsely retire them.
   */
  @Post('deals/batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mirror MANY closed deals pushed by the MT5 bridge' })
  @ApiOkResponse({
    description:
      'One result per ticket, in the order given. `ingested: false` means the CRM already held ' +
      'that deal — normal, and not retried. `orphaned: true` means it was stored against a login ' +
      'no trading account claims, which accrues once the account is linked.',
  })
  async ingestDealBatch(@Body() batch: Mt5DealBatchDto) {
    return await this.deals.ingestBatch(batch.deals, 'sweep');
  }

  /**
   * One account's balance, as MT5 held it when the bridge last asked.
   *
   * ## Why the bridge pushes this instead of the CRM pulling it
   *
   * The console used to read balances live, one bridge call per account per page
   * load. The bridge serialises every MT5 call behind one session lock, so that
   * screen queued twenty-five acquisitions at a time and starved the connection
   * supervisor — which needs the same lock to rebuild a dropped session. Moving
   * the read onto the bridge's existing sweep takes it off the request path
   * entirely; this endpoint is where the answer lands.
   *
   * ## Always 200, even when nothing was written
   *
   * `applied: false` is an ordinary outcome, not a failure, and the distinction
   * matters because the bridge RETRIES a non-2xx with backoff. A snapshot for a
   * login this CRM never opened — the broker's server carries accounts we did
   * not create — would otherwise be retried forever and fill the outbox with
   * deliveries that can never succeed. `reason` says which case it was.
   */
  @Post('accounts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mirror one account balance pushed by the MT5 bridge' })
  @ApiOkResponse({
    description:
      '`applied: false` with `reason: "unknown-login"` means the login names no account here, ' +
      'and `reason: "stale"` means a fresher read already landed. Both are normal and neither ' +
      'is retried.',
  })
  async ingestAccount(@Body() snapshot: Mt5AccountSnapshotDto) {
    const result = await this.accounts.ingestSnapshot(snapshot);
    return { login: snapshot.login, ...result };
  }

  /**
   * A whole sweep round's balances, in one request.
   *
   * Same contract as the single-snapshot endpoint, per login: `applied: false`
   * with `unknown-login` or `stale` is an ordinary outcome and is NOT retried.
   * The per-login answer matters here for the same reason it does for deals —
   * the bridge decides what to re-send from it.
   */
  @Post('accounts/batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mirror MANY account balances pushed by the MT5 bridge' })
  @ApiOkResponse({
    description:
      'One result per login. `applied: false` with `reason: "unknown-login"` means the login ' +
      'names no account here; `"stale"` means a fresher read already landed. Both are normal.',
  })
  async ingestAccountBatch(@Body() batch: Mt5AccountBatchDto) {
    return await this.accounts.ingestSnapshotBatch(batch.snapshots);
  }

  /**
   * One LIVE reading for an account somebody currently has on screen.
   *
   * ## Nothing here is stored, and that is the whole difference
   *
   * `POST accounts` above mirrors a balance into a column, durably, because a
   * balance moves only on a discrete event. This carries equity, margin and
   * floating P/L, which are recomputed from prices on every tick — so it is
   * routed to the owner's socket and forgotten. A stored copy would be a stale
   * number wearing a fresh label, which is the one failure the account screen
   * exists to prevent.
   *
   * ## Rate: this is the loudest endpoint on the service
   *
   * The bridge sends one of these per WATCHED account per round while any
   * client has an account page open, which is orders of magnitude more requests
   * than the balance sweep makes. It inherits the controller's 6000/min for
   * that reason — a limit sized for a machine, not a console — and the bridge
   * caps how many accounts can be watched at once, which is the real bound.
   *
   * ## `delivered: false` is ordinary
   *
   * `unknown-login` means the login names no account here — the broker's server
   * carries accounts this CRM never opened, and a page can be open for an
   * account that has since been closed. It is NOT retried, and must not be: a
   * live reading is a latest-value observation, so the right response to a
   * failed one is a fresher one, which the next round sends anyway.
   */
  @Post('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fan out live MT5 figures for one watched account' })
  @ApiOkResponse({
    description:
      '`delivered: false` with `reason: "unknown-login"` means the login names no account here. ' +
      'It is an ordinary outcome and is not retried.',
  })
  async ingestLive(@Body() reading: Mt5LiveDto) {
    const result = await this.live.ingest(reading);
    return { login: reading.login, ...result };
  }
}
