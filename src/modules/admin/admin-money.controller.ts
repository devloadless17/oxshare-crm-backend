import { Throttle } from '@nestjs/throttler';
// Part of the `admin` controller surface, split by concern.
//
// admin.controller.ts had grown to 717 lines fronting six already well-separated
// services. Nest allows several controllers to share one @Controller prefix, so
// this split changes no route path — test/openapi-routes.spec.ts asserts the full
// 69-route inventory is byte-identical, which is what made the split safe to do.
//
// All guards here are per-route; there is no class-level @UseGuards to preserve.
// @ApiTags('admin') is repeated on each class so Swagger still groups them as one
// tag and the generated types.gen.ts is unchanged.

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { WITHDRAWAL_SORT_COLUMNS } from '../payments/transactions.service';
import { transactionView } from '../payments/transaction-view';
import { transferView } from '../payments/transfer-view';
import { TransferDto } from '../payments/dto/transfer.dto';
import {
  IDEMPOTENCY_HEADER,
  IdempotencyInterceptor,
  Idempotent,
} from '../../common/security/idempotency.interceptor';
import { Request, Response } from 'express';
import { AdminMoneyService } from './admin-money.service';
import { AdminExportService } from './admin-export.service';
import { AdminAuditService } from './admin-audit.service';
import { exportFormat, streamCsv, EXPORT_RATE_LIMIT } from '../../common/export/export-response';
import {
  CreditWalletDto,
  FundTradingAccountDto,
  OpenWalletDto,
  SettleWithdrawalDto,
  AbandonTransferDto,
  DepositRejectDto,
  ResolveAttentionDto,
  FinishFlaggedDepositDto,
  WithdrawalRejectDto,
} from './dto/requests/money.dto';
import {
  LedgerListResponseDto,
  ReconciliationReportDto,
  StuckTransfersDto,
  WithdrawalListResponseDto,
  DepositDecisionDto,
  WithdrawalRowDto,
  AttentionResolvedDto,
  FlaggedDepositFinishedDto,
  TradingAccountFundResultDto,
  WalletCreditResultDto,
} from './dto/responses.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { ReconciliationService } from '../wallet/reconciliation.service';
import { UuidParam, enumQuery, uuidQuery } from '../../common/query-params';
import { ClientRefPipe } from '../../common/client-ref.pipe';
import { transactionStateEnum } from '../../database/schema';
import { NotClientScoped, ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';
import { AnnouncesChange } from '../../common/realtime/announces-change.decorator';

/** Withdrawal lifecycle, the ADM-13 ledger view and IB commission plans. */
@ApiTags('admin')
@Controller('admin')
/*
 * R-5.2. The three withdrawal transitions below carry `@Idempotent()`, and for
 * as long as this line was missing that decorator did NOTHING: it sets metadata
 * that only IdempotencyInterceptor reads, and the interceptor was registered on
 * payments.controller.ts alone. A control that is declared but not wired is
 * worse than one that is absent, because a reader — and a reviewer — sees the
 * decorator and stops looking.
 *
 * The duplicate was still refused by the state machine underneath
 * (transactions.service.ts transitions with `WHERE id = ? AND state = ?` and
 * checks the rowcount), so this was never a double-payment. What was missing is
 * the REPLAY half: a retried approve got an error about the wrong state instead
 * of the original success, which is exactly the case the admin app generates a
 * key for.
 */
@UseInterceptors(IdempotencyInterceptor)
export class AdminMoneyController {
  constructor(
    private readonly money: AdminMoneyService,
    private readonly reconciliation: ReconciliationService,
    private readonly exports: AdminExportService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * The withdrawal queue as CSV — every row matching the state filter.
   *
   * ── Amounts are emitted as the STRING the database produced ────────────────
   *
   * ARCHITECTURE §6.1, and the reason this route is worth reading carefully. A
   * withdrawal amount is `NUMERIC(28,8)`; it reaches the exporter as a string
   * and is written to the file character-for-character. Nothing here calls
   * `Number`, `toFixed` or a locale formatter — a CSV is the output most likely
   * to be re-imported into a spreadsheet that does arithmetic on it, so a value
   * rounded on the way out becomes a wrong number in somebody's reconciliation.
   *
   * Unlike the client, KYC and IB exports, this one has no `withdrawals/:id`
   * GET to be shadowed by, so its position is not load-bearing. It is placed
   * first among the withdrawal routes anyway, to match the pattern the other
   * exports follow.
   */
  @Get('withdrawals/export')
  /*
   * A ceiling on a STREAMING read of the whole client base.
   *
   * Every export here is batched over the full filtered set and held open for
   * the length of the download, and none carried anything but the global
   * 120/min — which is sized for a person clicking around a console, not for
   * 120 concurrent full-table CSV streams. The limit is per route per IP, so a
   * desk exporting clients and then withdrawals is unaffected; what it bounds is
   * one caller pulling the same export in a loop.
   *
   * Six a minute: far above any human use of an Export button, far below what
   * it takes to hurt the database.
   */
  @Throttle({ default: { ttl: 60_000, limit: EXPORT_RATE_LIMIT } })
  @UseGuards(PermissionsGuard)
  // The SAME permission as the list. An export must never be a way around one.
  @RequirePermissions('withdrawals.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Export the filtered withdrawal queue as CSV',
    description:
      'The same `state` filter as GET /admin/withdrawals, over every matching row rather than ' +
      'one page. Amounts are the exact decimal strings the ledger holds — never rounded, never ' +
      'locale-formatted (§6.1).',
  })
  @ApiOkResponse({
    description: 'A CSV file. `Content-Disposition` names it `withdrawals-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @ApiQuery({ name: 'state', required: false, enum: transactionStateEnum.enumValues })
  @ScopedToClients(
    'AdminExportService.withdrawalBatch → TransactionsService.listForExport, the same clientScopePredicate on transactions.user_id the queue applies.',
  )
  @Audited('export.withdrawals')
  async exportWithdrawals(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('state') state?: string,
  ) {
    const chosen = exportFormat(format);
    // Validated against the schema's own enum, exactly as the list route does,
    // so an unrecognised state is a 400 rather than a database error or a file
    // that is silently empty.
    const query = { state: enumQuery(state, transactionStateEnum.enumValues, 'state') };

    this.audit.record(req.admin.id, 'export.withdrawals', 'withdrawal_queue', req.admin.id, {
      format: chosen,
      filters: query,
    });

    /*
     * ONE instant for the whole run, captured before the first batch.
     *
     * The batches page by OFFSET, and `created_at DESC` puts a newly inserted
     * row FIRST — which shifts every later row down one and re-emits a boundary
     * row into the file. Bounding every batch to the same instant is what makes
     * the offsets stable; see `TransactionsService.listForExport`.
     */
    const startedAt = new Date();
    await streamCsv(res, 'withdrawals', chosen, this.exports.withdrawalColumns, (offset, limit) =>
      this.exports.withdrawalBatch(query, req.admin, offset, limit, startedAt),
    );
  }

  // ── Withdrawals (ADM-03 · §8.4) ───────────────────────────────────────────
  @Get('withdrawals')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Withdrawal requests with per-state counts (amounts are strings)',
  })
  @ApiOkResponse({ type: WithdrawalListResponseDto })
  /*
   * Declared OPTIONAL, explicitly — without these, Swagger emits every `@Query()`
   * as `required: true` and the frontends' generated types then demand all six
   * parameters on a call that legitimately passes none.
   */
  @ApiQuery({ name: 'state', required: false, enum: transactionStateEnum.enumValues })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'A Portal ID (digits, matched exactly) or free text over the client’s email and name — ' +
      'the one client search every queue shares.',
  })
  @ApiQuery({ name: 'page', required: false, description: 'Legacy offset paging. Prefer cursor.' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque keyset cursor (R-2.4).' })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: Object.keys(WITHDRAWAL_SORT_COLUMNS),
    description: 'amount sorts on the NUMERIC column in SQL — never cast, never in JS (§6).',
  })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({
    name: 'id',
    required: false,
    description:
      'One record by its uuid — where a notification deep link lands. AND-ed with every other ' +
      "filter and the reader's scope, so a record outside it answers an empty page, like any " +
      'filtered-out row. No state is implied: a handled record is still returned.',
  })
  @ScopedToClients(
    'TransactionsService.listForAdmin applies the predicate to transactions.user_id.',
  )
  listWithdrawals(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('state') state?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('id') id?: string,
  ) {
    return this.money.listWithdrawals(
      {
        id: uuidQuery(id, 'id'),
        // `transactions.service.ts` compared this against a Postgres enum column
        // behind a cast, so an unrecognised value came back as a 500 carrying a
        // database error. Checked against the schema's own value list instead.
        state: enumQuery(state, transactionStateEnum.enumValues, 'state'),
        q,
        page,
        limit,
        cursor,
        // `sort`/`order` are validated in the service against the allowlist,
        // which is where the column mapping lives. Validating here too would put
        // the allowlist in two places.
        sort,
        order,
      },
      req.admin,
    );
  }

  /**
   * Credit a client's wallet by hand — ⚠️ the only way money can ARRIVE without
   * a payment provider.
   *
   * ## Why this route exists
   *
   * It did not, and its absence was the single largest gap in the product: a
   * client could file a manual deposit and nothing could ever confirm it. This
   * controller had approve, reject and settle for withdrawals and no deposit
   * action at all, so money could leave the platform and could not enter it.
   *
   * ## `wallets.credit`, its own permission
   *
   * Not `withdrawals.approve` and not a shared payments key. This one mints
   * balance from nothing, and the separation of duties this file already
   * practises — `withdrawals.settle` deliberately split from
   * `withdrawals.approve` — exists precisely so a capability like this can be
   * granted to a different, smaller set of people.
   *
   * ## The idempotency key becomes the provider reference
   *
   * Not merely an interceptor concern here: the header value is passed to the
   * service and stored as `provider_ref`, where `UNIQUE(provider, provider_ref)`
   * enforces it. A double-submitted form therefore converges on ONE credit in
   * the DATABASE, which is a stronger guarantee than a replay cache and survives
   * a restart.
   */
  @Post('wallets/credit')
  @AnnouncesChange('wallets')
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended credit, reused only when retrying that same one. It is also ' +
      'stored as the transaction `provider_ref`, so a replay collides on UNIQUE(provider, ' +
      'provider_ref) and credits once (R-5.2).',
  })
  @UseGuards(PermissionsGuard)
  @RequirePermissions('wallets.credit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Add funds to a client's wallet by hand",
    description:
      'Writes a successful DEPOSIT transaction and a ledger entry, so the credit appears in the ' +
      "client's own history, and emails them the amount and the reason. Requires a reason: an " +
      'unexplained credit cannot be audited.',
  })
  @ApiCreatedResponse({ type: WalletCreditResultDto })
  @ScopedToClients('The client is resolved through ClientVisibilityService before any money moves.')
  @Audited('wallet.credit')
  async creditWallet(
    @Body() dto: CreditWalletDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    /*
     * The header is read here rather than generated in the service, because it
     * is the CALLER's statement of intent — two different requests must be two
     * different credits, and only the caller knows which of its submissions are
     * the same one retried. `@Idempotent()` has already refused the request if
     * it is absent.
     */
    const reference = req.header(IDEMPOTENCY_HEADER) ?? '';
    const result = await this.money.creditWallet(dto, reference, req.admin);
    // The declared shape: the row carries the desk's payout state.
    return { ...result, transaction: transactionView(result.transaction) };
  }

  /**
   * Move money on a client's TRADING ACCOUNT by hand, either direction.
   *
   * ## Always recorded, which is the point of it
   *
   * A deposit is a wallet CREDIT followed by a TRANSFER to the account; a
   * withdrawal is a TRANSFER off the account into the wallet. Both leave a
   * ledger entry and appear in the client's own history, because that is how
   * money actually moves in this system — the wallet is the ledger and accounts
   * are funded from it.
   *
   * ## ⚠️ THIS REPLACED `POST /admin/trading-accounts/:id/balance`
   *
   * That route moved the MT5 balance alone, with no wallet leg and no ledger
   * entry, and it is GONE. Offering both left the console with two controls that
   * moved money on the same account and differed only in whether anything was
   * written down — the unrecorded one got picked by mistake, and what it moved
   * could not be explained afterwards from the ledger.
   *
   * A withdrawal here is NOT a payout: the money lands in the client's wallet,
   * not in their bank. Paying out is the reviewed withdrawal desk.
   *
   * ## Permissions follow the DIRECTION
   *
   * The decorator can only name a fixed key, so it carries `trading.view` as
   * the FLOOR and the service asserts the real gate: a deposit needs
   * `wallets.credit` AND `trading.deposit` because it mints balance before
   * moving it, a withdrawal needs `trading.withdraw` because it mints nothing.
   *
   * ## The idempotency key becomes the provider reference
   *
   * Exactly as on the credit route above: the header reaches the service and is
   * stored as `provider_ref` under `UNIQUE(provider, provider_ref)`, so a
   * double-submitted form converges on ONE funding in the database rather than
   * relying on the replay cache.
   */
  @Post('trading-accounts/:id/fund')
  @AnnouncesChange('wallets')
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended funding, reused only when retrying that same one. It is ' +
      'also stored as the transaction `provider_ref`, so a replay collides on ' +
      'UNIQUE(provider, provider_ref) and credits once (R-5.2).',
  })
  @UseGuards(PermissionsGuard)
  /*
   * The FLOOR, not the real gate — `trading.view` stops an admin with no
   * trading access at all reaching the handler, and the service asserts the
   * direction-specific keys.
   *
   * This was `wallets.credit`, which was wrong the moment withdraw arrived: a
   * withdraw-only operator mints nothing and must not need the key that governs
   * minting, but the decorator would have denied them at the door.
   */
  @RequirePermissions('trading.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Move money on a client's trading account by hand",
    description:
      'ALWAYS RECORDED, in both directions. A deposit writes a successful DEPOSIT transaction ' +
      'crediting the wallet, then a TRANSFER of the same amount to the trading account. A ' +
      'withdrawal writes a TRANSFER off the account into the wallet — it is NOT a payout and ' +
      'no money leaves the platform. Both are visible in the client history, the ledger and ' +
      "the financial views. The currency is the account's and is not accepted from the caller. " +
      'Enforces the same preconditions as a client transfer: KYC level 1, live and active ' +
      'account (DEMO accounts are refused both ways — practice money has no wallet). A ' +
      'deposit requires wallets.credit AND trading.deposit; a withdrawal requires ' +
      'trading.withdraw.',
  })
  @ApiCreatedResponse({ type: TradingAccountFundResultDto })
  @ScopedToClients(
    'The account is read with the actor client scope joined into the WHERE, so an ' +
      'out-of-scope account is a 404 before any money moves.',
  )
  @Audited('trading.deposit')
  async fundTradingAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FundTradingAccountDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    // The CALLER's statement of intent, for the reason given on the credit
    // route above. `@Idempotent()` has already refused a request without it.
    const reference = req.header(IDEMPOTENCY_HEADER) ?? '';
    const result = await this.money.fundTradingAccount(
      {
        tradingAccountId: id,
        amount: dto.amount,
        reason: dto.reason,
        direction: dto.direction,
      },
      reference,
      req.admin,
    );
    // The declared shapes: both rows carry operator-side state.
    return {
      ...result,
      transaction: result.transaction ? transactionView(result.transaction) : null,
      transfer: result.transfer ? transferView(result.transfer) : null,
    };
  }

  /**
   * Open a wallet for a client in a currency they do not hold one in.
   *
   * Registration opens one per ENABLED currency, so this covers the two gaps
   * that leaves: a currency added after the client signed up, and one that was
   * disabled at the time.
   *
   * `wallets.create`, not `wallets.credit`. This creates an empty container and
   * moves no money; putting it behind the key that mints balance would mean
   * granting the power to create money in order to fix a missing wallet.
   */
  @Post('wallets')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('wallets.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Open a wallet for a client',
    description:
      'Idempotent: opening one that already exists returns it rather than failing. The currency ' +
      'must be one the platform holds and has enabled.',
  })
  @ApiCreatedResponse({ description: 'The wallet, new or existing.' })
  @ScopedToClients('The client is resolved through ClientVisibilityService before the write.')
  @Audited('wallet.create')
  openWallet(@Body() dto: OpenWalletDto, @Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.money.openWallet(dto, req.admin);
  }

  /**
   * Close an EMPTY, UNUSED wallet.
   *
   * ## What this refuses, and why each refusal exists
   *
   * A balance, funds on hold, or any ledger entry, transaction or transfer
   * against it. `ledger_entries`, `transactions` and `transfers` are all
   * RESTRICT foreign keys onto `wallets`, so the database refuses the last case
   * regardless — the service checks first only so the operator reads a sentence
   * rather than a constraint violation.
   *
   * What survives is a wallet opened and never used, which is the only one whose
   * deletion loses nothing. Every other correction is a compensating entry
   * through the ledger (§6.4), never a row that disappears.
   */
  @Delete('wallets/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('wallets.delete')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Close an empty, unused wallet',
    description:
      'Refuses a wallet with a balance, with funds on hold, or with any history against it — a ' +
      'wallet is the anchor its ledger entries point at.',
  })
  @ApiOkResponse({ description: 'The wallet was closed.' })
  @ScopedToClients('The wallet is resolved to its owner, who is checked against the admin scope.')
  @Audited('wallet.delete')
  async closeWallet(
    @Param('id', UuidParam) id: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    await this.money.closeWallet(id, req.admin);
    return { closed: true };
  }

  @Patch('withdrawals/:id/approve')
  @AnnouncesChange('withdrawals')
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended action, reused only when retrying that same one. The state ' +
      'guards below make a REPLAYED CAUSE a no-op; this makes a replayed REQUEST one too ' +
      '(PLATFORM-CONVENTIONS R-5.2).',
  })
  @UseGuards(PermissionsGuard)
  /*
   * `withdrawals.settle`, NOT `withdrawals.approve` — and the change is
   * deliberate rather than a typo beside the reject route below.
   *
   * This action now PAYS: it takes a withdrawal from pending straight to
   * `success`, because approval and settlement were two steps with nothing
   * between them on a platform that has no automated payout rail (see
   * `TransactionsService.approve`). Since one click now releases money, it is
   * gated on the permission that always meant "may complete a payout".
   *
   * What that gives up, stated plainly: the segregation of duties this pair of
   * permissions used to express — "two people must be involved in a payout" —
   * is gone, because there is only one action left to hold. What it keeps is
   * AUTHORITY: an operator holding only `withdrawals.approve` can no longer
   * move money out at all, where before they could take the first of the two
   * steps. Rejecting still needs only `withdrawals.approve`, which is right —
   * refusing a withdrawal returns money to the client and releases nothing.
   */
  @RequirePermissions('withdrawals.settle')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Approve a pending withdrawal and record it as paid',
    description:
      'One step: the withdrawal moves from pending to success with `settledAt` stamped. No ' +
      'balance changes — the debit posted when the client requested it. Requires ' +
      '`withdrawals.settle`, because this releases the payout.',
  })
  @ApiOkResponse({ type: WithdrawalRowDto })
  @ScopedToClients('Predicate joins the state-machine UPDATE ... WHERE id = ? AND state = ?.')
  @Audited('withdrawal.approve')
  approveWithdrawal(
    @Param('id', UuidParam) id: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.money.approveWithdrawal(id, req.admin);
  }

  @Patch('withdrawals/:id/reject')
  @AnnouncesChange('withdrawals')
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended action, reused only when retrying that same one. The state ' +
      'guards below make a REPLAYED CAUSE a no-op; this makes a replayed REQUEST one too ' +
      '(PLATFORM-CONVENTIONS R-5.2).',
  })
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.approve')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Reject a pending withdrawal — releases the hold, emails the client',
  })
  @ApiOkResponse({ type: WithdrawalRowDto })
  @ScopedToClients('Predicate joins the state-machine UPDATE.')
  @Audited('withdrawal.reject')
  rejectWithdrawal(
    @Param('id', UuidParam) id: string,
    @Body() dto: WithdrawalRejectDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.money.rejectWithdrawal(id, req.admin, dto.reason, dto.reasonId);
  }

  /*
   * ── THE OFFLINE DEPOSIT DESK ──────────────────────────────────────────────
   *
   * A client paid outside the platform — OMT, a bank transfer, cash — declared
   * it, and attached a receipt. These two routes are the only way that
   * declaration ever settles.
   *
   * Before them a manual deposit could be filed and never confirmed: the only
   * money-in action here was `POST /admin/wallets/credit`, which mints a
   * SEPARATE `manual_admin` row and leaves the client's own declaration pending
   * for ever. That is still the right tool for a goodwill adjustment and the
   * wrong one for this.
   *
   * `deposits.*` rather than `wallets.credit`, because the powers differ in
   * blast radius: approving credits an amount the CLIENT declared against a
   * reference that reconciles to a bank line, while `wallets.credit` types any
   * figure into any wallet.
   *
   * `@AnnouncesChange('wallets')` and not a new resource name: `RESOURCES` is a
   * closed list, and the admin console already maps `wallets` onto exactly what
   * a credited deposit changes — wallets, transactions, ledger, stats. A new
   * name would refresh nothing until the frontend learned it.
   */
  @Patch('deposits/:id/approve')
  @AnnouncesChange('wallets')
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended action, reused only when retrying that same one. The ' +
      'conditional transition makes a replayed CAUSE a no-op; this makes a replayed REQUEST ' +
      'one too (R-5.2).',
  })
  @UseGuards(PermissionsGuard)
  @RequirePermissions('deposits.approve')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Approve an offline deposit and credit the client wallet',
    description:
      'Moves the deposit from pending to success and posts the ledger credit in one ' +
      'transaction. If the client chose a trading account, the money is chained on to it ' +
      'exactly as a gateway deposit would be. Approving twice credits once.',
  })
  @ApiOkResponse({ type: DepositDecisionDto })
  @ScopedToClients('Predicate joins the state-machine UPDATE ... WHERE id = ? AND state = ?.')
  @Audited('deposit.approve')
  approveDeposit(
    @Param('id', UuidParam) id: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.money.approveDeposit(id, req.admin);
  }

  @Patch('deposits/:id/reject')
  @AnnouncesChange('wallets')
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description: 'A unique value per intended action, reused only when retrying that same one.',
  })
  @UseGuards(PermissionsGuard)
  // A SEPARATE key from approve, on R-5.4's reasoning: refusing a declaration
  // moves no money, crediting one does.
  @RequirePermissions('deposits.reject')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Reject an offline deposit, with a reason the client is told',
    description:
      'Moves the deposit to rejected and emails the client the reason. NOTHING IS REFUNDED, ' +
      'because nothing was ever debited: a deposit posts no ledger entry when it is filed. A ' +
      'client who really did send the money needs support, not a reversal.',
  })
  @ApiOkResponse({ type: DepositDecisionDto })
  @ScopedToClients('Predicate joins the state-machine UPDATE.')
  @Audited('deposit.reject')
  rejectDeposit(
    @Param('id', UuidParam) id: string,
    @Body() dto: DepositRejectDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.money.rejectDeposit(id, req.admin, dto.reason, dto.reasonId);
  }

  @Patch('withdrawals/:id/settle')
  @AnnouncesChange('withdrawals')
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended action, reused only when retrying that same one. The state ' +
      'guards below make a REPLAYED CAUSE a no-op; this makes a replayed REQUEST one too ' +
      '(PLATFORM-CONVENTIONS R-5.2).',
  })
  @UseGuards(PermissionsGuard)
  // R-5.4 — a DIFFERENT permission from approve, deliberately. Settlement is the
  // step that releases the money; approval only says it may be released. While
  // both required `withdrawals.approve`, "two people must be involved in a
  // payout" could not be expressed at all.
  @RequirePermissions('withdrawals.settle')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Mark an approved withdrawal paid — posts the debit and clears the hold',
    description:
      'Requires `withdrawals.settle`, which is separate from `withdrawals.approve` so the two ' +
      'steps can be granted to different people (separation of duties, R-5.4).',
  })
  @ApiOkResponse({ type: WithdrawalRowDto })
  @ScopedToClients('Predicate joins the state-machine UPDATE — the money-releasing step.')
  @Audited('withdrawal.settle')
  settleWithdrawal(
    @Param('id', UuidParam) id: string,
    @Body() dto: SettleWithdrawalDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.money.settleWithdrawal(id, req.admin, dto.providerRef);
  }

  @Patch('withdrawals/:id/cancel')
  @AnnouncesChange('withdrawals')
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended action, reused only when retrying that same one. The state ' +
      'guards below make a REPLAYED CAUSE a no-op; this makes a replayed REQUEST one too ' +
      '(PLATFORM-CONVENTIONS R-5.2).',
  })
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.approve')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Cancel an APPROVED withdrawal — refunds the client, reasoned and emailed',
    description:
      'The "approved, then thought better of it" action. A payout already submitted to the ' +
      'payment platform is cancelled THERE first; if the platform is already processing it ' +
      '(paying the customer), this refuses with nothing changed — act on the outcome instead. ' +
      'The reason follows FR-ADM-03: from the configurable list (or free text), recorded, and ' +
      'emailed to the client.',
  })
  @ApiOkResponse({ type: WithdrawalRowDto })
  @ScopedToClients('Predicate joins the state-machine UPDATE — reverses money already promised.')
  @Audited('withdrawal.cancel')
  cancelWithdrawal(
    @Param('id', UuidParam) id: string,
    @Body() dto: WithdrawalRejectDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.money.cancelWithdrawal(id, req.admin, dto.reason, dto.reasonId);
  }

  /*
   * RESEND a payout a person must decide (0173, every provider). The old
   * `rival-submit` path stays an alias for one release — the console that
   * predates 0173 still calls it.
   */
  @Post(['withdrawals/:id/provider-submit', 'withdrawals/:id/rival-submit'])
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description: 'A unique value per intended action (PLATFORM-CONVENTIONS R-5.2).',
  })
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.approve')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Resend an approved withdrawal to its payment provider',
    description:
      'For rows the provider refused, or held nothing for after the adoption window (the desk ' +
      'shows "needs attention"). Safe under double-click: the claim admits one in-flight create, ' +
      'and a submission whose outcome is still unknown is left for reconciliation rather than ' +
      'resent — no provider takes an idempotency key on payouts, so a blind resend pays twice.',
  })
  @ApiOkResponse({ type: WithdrawalRowDto })
  @ScopedToClients('Predicate joins the withdrawal lookup.')
  @Audited('withdrawal.provider.submit')
  resendPayout(
    @Param('id', UuidParam) id: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.money.resendPayout(id, req.admin);
  }

  // ── Ledger (ADM-13) ───────────────────────────────────────────────────────
  /*
   * A WHOLE-PLATFORM control, reachable only by an UNRESTRICTED admin.
   *
   * This report names clients (`WalletDiscrepancy.userId`) and there is no
   * correct way to scope it. Restricting it to a sub-admin's territory would
   * report "balanced" over a subset — the opposite of what a reconciliation is
   * for, since an operator would read a clean report and conclude the whole
   * ledger agrees, having been shown a slice. Leaving it unscoped would hand a
   * scoped sub-admin the ids of clients they were specifically denied.
   *
   * The old resolution was "master admin only", which the permission rework
   * dissolved — `reconciliation.view` is now an ordinary grantable key, so the
   * leak reopened (finding #2, 13 Aug scoped walk). The answer that survives
   * the master role's removal is a property of the READER, not a role: the
   * report stays WHOLE, and only an admin who can see the whole platform may
   * run it. A scoped admin is refused with a 403 that names no client — the
   * refusal is about the reader's own territory, not any target, so it is not
   * an enumeration oracle. `assertUnrestricted` is the same check the
   * reconciliation over a fragment would fail on its own terms.
   *
   * `GET /admin/ledger` is unaffected — that one IS scoped, and a filtered
   * ledger is a coherent thing to look at in a way a filtered reconciliation
   * is not.
   */
  @Get('reconciliation')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('reconciliation.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Run reconciliation now and return the report (§12.2)',
    description:
      'The same check the hourly job runs: every wallet balance against the sum of its own ' +
      'ledger. Wallet balances ONLY — a confirmed commission accrual that was never credited ' +
      'is a separate alert (UNPAID_CONFIRMED_ACCRUAL), not part of this report. ' +
      'Read-only — a discrepancy is reported, never repaired, because an automatic correction ' +
      'would write a compensating entry for a cause nobody has diagnosed. Whole-platform: an ' +
      'admin scoped to a client territory is refused, because a reconciliation over a fragment ' +
      'is meaningless and the full report names clients outside their territory.',
  })
  @ApiOkResponse({ type: ReconciliationReportDto })
  @NotClientScoped(
    'Whole-platform integrity control, not a per-client read. The report is unscoped by nature; access is refused to a scoped admin (assertUnrestricted below) rather than sliced, so it never reports "balanced" over a subset and never leaks out-of-territory client ids.',
  )
  reconcile(@Req() req: Request & { admin: AuthenticatedAdmin }) {
    if (!req.admin.clientScope.unrestricted) {
      throw new ForbiddenException(
        'Reconciliation is a whole-platform integrity control. Your account is scoped to a ' +
          'client territory, and a reconciliation over part of the ledger cannot answer whether ' +
          'the ledger balances. Ask an administrator without a territory to run it.',
      );
    }
    return this.reconciliation.run();
  }

  /*
   * `ledger.view`, NOT `withdrawals.view` — ADM-13.
   *
   * This endpoint used to ride on the withdrawal queue's read key, and the two
   * are not the same power. `ledger_entries` holds six entry types — deposit,
   * withdrawal, commission, rebate, payout and adjustment — so gating it here
   * meant that granting somebody the withdrawal queue also handed them every
   * client deposit and every partner commission on the platform.
   *
   * The catalog already draws this distinction elsewhere (`wallets.credit` is
   * separate from `wallets.delete` because adding money and removing an account
   * are not one power); reading every money movement earns the same treatment.
   */
  @Get('ledger')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ledger.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Append-only ledger, filterable for reconciliation',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'A Portal ID (digits, matched exactly) or the client’s email or name — the identifiers ' +
      'the Client column shows. Scope ' +
      'still applies: this cannot reach a client outside the actor’s territory.',
  })
  @ApiOkResponse({ type: LedgerListResponseDto })
  @ScopedToClients('WalletService.listEntries applies the predicate to wallets.user_id.')
  listLedger(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('userId', ClientRefPipe) userId?: number,
    @Query('q') q?: string,
    @Query('walletId') walletId?: string,
    @Query('entryType') entryType?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.money.listLedger(
      {
        /*
         * SHAPE-CHECKED AT THE EDGE, so the refusal names the parameter.
         *
         * ⚠️ Not a 500 fix — `AllExceptionsFilter` already maps Postgres `22P02`
         * to a 400. What it cannot do is say WHICH value was wrong, because by
         * then all it has is a cast error. On a route taking several ids that
         * matters, and the database paid for a round trip to produce it.
         */
        userId: userId,
        q,
        walletId: uuidQuery(walletId, 'walletId'),
        entryType,
        page,
        limit,
        cursor,
      },
      req.admin,
    );
  }

  /*
   * The four `/admin/commission-plans` routes were HERE and went with the
   * engine that read them. They configured the numbers ARCHITECTURE §12 leaves
   * open — L1/L2 shares, the ladder, the settlement window — and they return
   * with the MT5 bridge. `/admin/ib-levels` covers the terms half today.
   */

  /**
   * How many transfers are stuck, for the banner on the Financial screen.
   *
   * The condition is already detected — `TransferResumeScheduler` raises
   * `money.transfer_stuck` at `page` severity — but that alert is a log line and
   * §12.3 deliberately stops short of choosing a paging provider, so on this
   * deployment nobody sees it. This is how the console does.
   *
   * A COUNT rather than a list: the rows themselves are already on the Financial
   * table, and a second place to render them is a second place to keep honest.
   * What was missing was a reason to go and look.
   *
   * `transactions.view` — whoever can see the movement list can be told that
   * part of it needs attention. Acting on one still requires `transfers.abandon`.
   */
  @Get('transfers/stuck')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('transactions.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'How many transfers have been pending long enough to need a person',
    description:
      'Counts transfers still pending past the resume scheduler’s own staleness threshold — the ' +
      'same condition that raises the `money.transfer_stuck` alert. No money has moved on any of ' +
      'them: a wallet is debited only once MT5 confirms.',
  })
  @ApiOkResponse({ type: StuckTransfersDto })
  @ScopedToClients('Counts only the caller’s own clients’ transfers.')
  stuckTransfers(@Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.money.stuckTransfers(req.admin);
  }

  /**
   * Release a transfer the MT5 bridge left in flight.
   *
   * ## The state this repairs
   *
   * A `wallet_to_account` transfer HOLDS the money at request time and debits
   * it on settle. When the bridge loses its session mid-call the transfer stays
   * pending — correctly, because the executor cannot tell "MT5 refused" from
   * "MT5 never answered" — and nothing ever expires that hold. The client sees
   * "Processing" and cannot spend their own money, indefinitely, and the resume
   * job retries into the same wall every minute.
   *
   * Until this route existed the only repair was hand-written SQL against a
   * money table.
   *
   * ## Why it is a person's call and not a timeout
   *
   * Releasing a transfer MT5 ACTUALLY APPLIED would let the client spend the
   * same money twice. Only somebody reading the broker's own deal history can
   * rule that out, which is why the reason is required and why this is a
   * deliberate action rather than something the scheduler does after an hour.
   */
  @Post('transfers/:id/abandon')
  /*
   * `wallets`, because that is what a viewer sees change: the hold is released
   * and the spendable balance goes up. The transfer's own state change rides
   * along on the same refresh.
   */
  @AnnouncesChange('wallets')
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended action, reused only when retrying that same one. The state ' +
      'guard makes a REPLAYED CAUSE a no-op — a second abandon finds the transfer already ' +
      'failed — and this makes a replayed REQUEST one too (PLATFORM-CONVENTIONS R-5.2).',
  })
  @UseGuards(PermissionsGuard)
  /*
   * `withdrawals.settle`'s sibling, granted to the same people by 0115. That
   * permission means "decide money did or did not move, on evidence outside
   * this system", which is exactly this judgement. Deliberately NOT
   * `withdrawals.approve`: approving decides whether money SHOULD move, and
   * this states whether it DID.
   */
  @RequirePermissions('transfers.abandon')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Release a stuck transfer — frees the hold and tells the client why',
    description:
      'For a transfer the MT5 bridge left pending: the movement never reached the trading ' +
      'server, so the hold is released and the money becomes spendable again. Refuses anything ' +
      'that is not still pending.\n\n' +
      '⚠️ Only after checking the broker’s own record. If MT5 DID apply the movement, releasing ' +
      'the hold lets the client spend money that has already left — which is the one thing the ' +
      'executor refuses to guess at, and the reason this is a person’s decision.',
  })
  @ApiOkResponse({ type: TransferDto })
  @ScopedToClients('Checks the transfer’s owner; out-of-scope 404s like a missing one.')
  @Audited('transfer.abandon')
  async abandonTransfer(
    @Param('id', UuidParam) id: string,
    @Body() dto: AbandonTransferDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return transferView(await this.money.abandonTransfer(id, req.admin, dto.reason));
  }

  /**
   * "Mark resolved" on a payment only a person could settle.
   *
   * The finish line for the `rival_needs_attention` flag, which had none: an
   * amount mismatch, a reversal, money paid against a failed row, or the
   * platform and this side disagreeing sat flagged for ever, and the admin task
   * about it with it. Clearing the flag here resolves those tasks for everyone
   * (migration 0140). It moves NO money — whatever the reconciliation required
   * (a manual credit, a compensating entry) is its own audited action; this is
   * the record that somebody looked, decided, and said what they found.
   */
  @Patch('transactions/:id/attention/resolve')
  /*
   * `withdrawals` reaches the payout desk AND the Financial page, where a
   * flagged deposit shows — the two screens that carry the attention badge.
   */
  @AnnouncesChange('withdrawals')
  @UseGuards(PermissionsGuard)
  // Any-of here; the service asserts the one matching the payment's direction.
  @RequirePermissions('deposits.approve', 'withdrawals.settle')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Mark a payment that needed attention as resolved — clears the flag and its tasks',
    description:
      'For a deposit or withdrawal flagged as needing a person: reconcile it first (the ' +
      'platform dashboard, the ledger), then record what you found. Refuses a payment that is ' +
      'no longer flagged. Deposits need deposits.approve; withdrawals need withdrawals.settle.',
  })
  @ApiOkResponse({ type: AttentionResolvedDto })
  @ScopedToClients('Checks the payment’s owner; out-of-scope 404s like a missing one.')
  @Audited('transaction.attention_resolve')
  resolveAttention(
    @Param('id', UuidParam) id: string,
    @Body() dto: ResolveAttentionDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.money.resolveAttention(id, req.admin, dto.note);
  }

  /**
   * FINISH A FLAGGED HOSTED DEPOSIT (0173): credit what the provider reported
   * arrived, or close it with no credit. The two ways a deposit paid on a
   * provider's page — which the offline desk refuses — can be finished once a
   * person has decided; "Mark resolved" moves no money, these do.
   */
  @Patch('transactions/:id/attention/finish-deposit')
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description: 'A unique value per intended action (PLATFORM-CONVENTIONS R-5.2).',
  })
  @AnnouncesChange('withdrawals')
  @UseGuards(PermissionsGuard)
  // Any-of here; the engine asserts deposits.approve to credit, deposits.reject to close.
  @RequirePermissions('deposits.approve', 'deposits.reject')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Credit what arrived on a flagged hosted deposit, or close it without credit',
    description:
      'For a deposit paid on a provider’s page and flagged for a person. `credit` credits the ' +
      'amount the provider reported (rounded down to the wallet’s places); `close` credits ' +
      'nothing. Refuses a deposit that is no longer flagged or already finished.',
  })
  @ApiOkResponse({ type: FlaggedDepositFinishedDto })
  @ScopedToClients('Checks the deposit’s owner; out-of-scope 404s like a missing one.')
  @Audited('deposit.credit_received')
  finishFlaggedDeposit(
    @Param('id', UuidParam) id: string,
    @Body() dto: FinishFlaggedDepositDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.money.finishFlaggedDeposit(id, req.admin, dto.decision, dto.reason);
  }
}
