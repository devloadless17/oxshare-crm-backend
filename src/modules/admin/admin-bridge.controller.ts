// Part of the `admin` controller surface, split by concern — the same shape as
// admin-holdings.controller.ts. @ApiTags('admin') is repeated so Swagger groups
// them as one tag and types.gen.ts stays one coherent surface.

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Mt5BridgeClient } from '../trading/mt5/mt5-bridge.client';
import { BridgeLogsDto, BridgeOperationsDto, BridgeOutboxDto } from './dto/bridge.dto';
import { NotClientScoped } from './guards/client-scope.decorator';
import { PermissionsGuard, RequirePermissions } from './guards/admin.guard';

/**
 * The MT5 bridge's own internals: its delivery queue, its balance operations,
 * and its log.
 *
 * ## Why this is not "just logs"
 *
 * The bridge sits between MT5 and this API, and the two failures it can have are
 * invisible from either side alone.
 *
 * A deal that never arrives leaves NO ROW in `mt5_deals` — there is nothing to
 * notice the absence of, so ingestion can be broken for days while every screen
 * looks correct and only the commission engine quietly under-pays. That happened:
 * `mt5_deals` was empty since launch because the bridge could not read a deal
 * page, and nothing surfaced it.
 *
 * A balance operation can be CLAIMED and never confirmed — the bridge told MT5 to
 * move money and never learned whether it did. The key stays claimed on purpose,
 * so a retry cannot double-credit, which also means it stays that way until a
 * person reconciles it. Nothing in this API could see those rows before.
 *
 * ## Read-only, and a passthrough
 *
 * Every route here forwards to the bridge and returns what it says. No storage,
 * no caching, no interpretation — a diagnostic that lies about its own freshness
 * is worse than no diagnostic. If the bridge is down these fail, which is itself
 * the answer to the question being asked.
 *
 * ## `trading.view`, deliberately reused
 *
 * These payloads name client logins, amounts and CRM transfer ids — the same
 * class of data `trading.view` already gates on the trading-account screens. A
 * new permission would need granting to every existing role before anyone could
 * see the screen, and "whoever may read a client's trading account may read the
 * queue behind it" is a rule that holds up.
 */
@ApiTags('admin')
@ApiCookieAuth()
@Controller('admin/bridge')
export class AdminBridgeController {
  constructor(private readonly bridge: Mt5BridgeClient) {}

  @Get('outbox')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.view')
  /*
   * Stated for all three routes here, and the reason is the same one: there is
   * no query to attach a predicate to. Every route in this controller is a
   * passthrough to the bridge's own HTTP API — no CRM table is read, so no
   * `client_id` column exists to filter on.
   *
   * What that does NOT mean is that the response holds nothing about clients:
   * the payloads name MT5 logins, amounts and transfer ids, as the class comment
   * above says. An admin narrowed to a subset of clients therefore sees queue
   * rows belonging to clients outside that subset. That is a consequence of
   * gating on `trading.view` rather than a scope this decorator could enforce,
   * and it is recorded here rather than left for someone to discover — see
   * DEPLOYMENT/handover notes.
   */
  @NotClientScoped(
    'Passthrough to the bridge HTTP API; reads no CRM rows, so there is no column to scope. ' +
      'The payload does name client logins — see the note above this decorator.',
  )
  @ApiOperation({
    summary: "The bridge's deal delivery queue",
    description:
      'Whether each closed deal reached this API, and when. `failing` in the summary is the ' +
      'number worth acting on: a pending row may simply be new, while a failing one has been ' +
      'attempted and rejected — `lastError` says why.',
  })
  @ApiQuery({ name: 'pending', required: false, type: Boolean })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ type: BridgeOutboxDto })
  async outbox(
    @Query('pending') pending?: string,
    @Query('limit') limit?: string,
  ): Promise<BridgeOutboxDto> {
    return await this.bridge.getOutbox({
      pending: pending === 'true',
      limit: parseLimit(limit),
    });
  }

  @Get('operations')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.view')
  @NotClientScoped(
    'Passthrough to the bridge HTTP API; reads no CRM rows, so there is no column to scope. ' +
      'The payload does name client logins — see the note on `outbox`.',
  )
  @ApiOperation({
    summary: 'Balance operations, including the ones stuck mid-flight',
    description:
      'A row with a null `completedAt` is an operation whose outcome the bridge never learned — ' +
      'it told MT5 to move money and did not find out whether it did. Those need reconciling ' +
      "against MT5's deal history by a person; they do not resolve on their own.",
  })
  @ApiQuery({ name: 'stuck', required: false, type: Boolean })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ type: BridgeOperationsDto })
  async operations(
    @Query('stuck') stuck?: string,
    @Query('limit') limit?: string,
  ): Promise<BridgeOperationsDto> {
    return await this.bridge.getBalanceOperations({
      stuck: stuck === 'true',
      limit: parseLimit(limit),
    });
  }

  @Get('logs')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.view')
  @NotClientScoped(
    'Passthrough to the bridge HTTP API; reads no CRM rows, so there is no column to scope. ' +
      'The log text can mention client logins — see the note on `outbox`.',
  )
  @ApiOperation({
    summary: "The tail of the bridge's log for today",
    description:
      '`exists: false` is a normal answer on the first run of a day, and names the file that ' +
      'was looked for so the next guess is informed.',
  })
  @ApiQuery({ name: 'lines', required: false, type: Number })
  @ApiQuery({ name: 'contains', required: false, type: String })
  @ApiOkResponse({ type: BridgeLogsDto })
  async logs(
    @Query('lines') lines?: string,
    @Query('contains') contains?: string,
  ): Promise<BridgeLogsDto> {
    return await this.bridge.getLogs({
      lines: parseLimit(lines),
      // Empty string is not a filter — it would match every line while looking
      // like a deliberate narrowing.
      contains: contains && contains.length > 0 ? contains : undefined,
    });
  }
}

/**
 * A query-string count, or undefined to let the bridge apply its own default.
 *
 * Undefined rather than a number here on purpose: the bridge already clamps and
 * defaults these, and duplicating the bounds would give two places to disagree
 * about the maximum. This only has to reject values that are not numbers at all.
 */
function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
