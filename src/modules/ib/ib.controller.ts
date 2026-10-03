import { Body, Controller, Get, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { walletView } from '../wallet/wallet-view';
import { Throttle } from '@nestjs/throttler';
import {
  IDEMPOTENCY_HEADER,
  Idempotent,
  IdempotencyInterceptor,
} from '../../common/security/idempotency.interceptor';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { IbApplicationsService } from './ib-applications.service';
import { IbOverviewService, COMMISSION_FEED_LIMIT } from './ib-overview.service';
import { IbWalletService } from './ib-wallet.service';
import { CreateIbApplicationDto, IbApplicationDto, IbStatusDto } from './dto/ib-application.dto';
import { IbCommissionRowDto, IbOverviewDto } from './dto/ib-overview.dto';
import { IbWalletTransferDto, IbWalletTransferResultDto } from './dto/ib-wallet.dto';
import { PublicAgencyDto } from '../products/dto/catalogue.dto';
import { WalletDto } from '../wallet/dto/wallet-response.dto';
import { OpenOwnWalletDto } from '../wallet/dto/open-wallet.dto';
import { ProductsStore, type ProductRow } from '../../store/products.store';
import { ibApplicationView } from './ib-views';
import { RejectionReasonsStore } from '../../store/rejection-reasons.store';

/**
 * The client's own view of the partner programme.
 *
 * `EmailVerifiedGuard` alongside the auth guard, matching KYC: an unverified
 * address cannot receive the decision email, so an application from one is a
 * review whose outcome has nowhere to go.
 *
 * The KYC requirement is NOT a guard. It is a rule about eligibility that the
 * client should be told about before they fill anything in, so `GET /ib/status`
 * reports it as `eligible: false` with a sentence, and `POST /ib/apply`
 * enforces it. Explain first, refuse second — the same split used elsewhere.
 */
@ApiTags('ib')
@Controller('ib')
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@UseInterceptors(IdempotencyInterceptor)
export class IbController {
  constructor(
    private readonly applications: IbApplicationsService,
    private readonly overview: IbOverviewService,
    private readonly ibWallets: IbWalletService,
    /*
     * The `@Global()` store rather than `CatalogueService`, so this module does
     * not have to import ProductsModule (and through it TradingModule) for one
     * read. The shaping the DTO needs — product ids to product names — is two
     * lines and lives below.
     */
    private readonly catalogue: ProductsStore,
    /* The refusal's reason in Arabic, resolved on read (0179). */
    private readonly reasons: RejectionReasonsStore,
  ) {}

  /** Enabled agencies with their product names, for the applicant to read. */
  private async listOpenAgencies(): Promise<PublicAgencyDto[]> {
    const [agencies, products] = await Promise.all([
      this.catalogue.listAgencies(),
      this.catalogue.listProducts(),
    ]);
    const productOf = new Map(products.map((product) => [product.id, product]));

    return agencies
      .filter((agency) => agency.enabled)
      .map((agency) => {
        // Index for index: `productsAr[i]` is the Arabic of `products[i]` (0179).
        const sold = agency.productIds
          .map((id) => productOf.get(id))
          .filter((product): product is ProductRow => Boolean(product?.name));
        return {
          id: agency.id,
          name: agency.name,
          nameAr: agency.nameAr,
          description: agency.description,
          descriptionAr: agency.descriptionAr,
          products: sold.map((product) => product.name),
          productsAr: sold.map((product) => product.nameAr),
        };
      });
  }

  @Get('status')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Where this client stands with the partner programme',
    description:
      'Returns the partner account if they have one AND their most recent application if they ' +
      'have made one. Both, because "never applied" and "rejected, here is why" are different ' +
      'states and a client shown a blank form after a refusal has been told nothing.',
  })
  @ApiOkResponse({ type: IbStatusDto })
  async status(@Req() req: Request & { user: User }) {
    const status = await this.applications.statusFor(req.user.id);
    if (!status.application) return status;
    // Stored Arabic first, then the catalogue's; a blank one is dropped, not sent.
    return {
      ...status,
      application: await this.reasons.withReasonArabic('partner', status.application),
    };
  }

  @Get('overview')
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      "An approved partner's own dashboard — level, earnings, referred clients, sub-partners",
    description:
      'Everything the partner area renders, in one request, because these figures are read ' +
      'together and a count from one instant beside a total from another is a screen that ' +
      'contradicts itself.\n\n' +
      '404s for a client who is not a partner: zeroes across the board would render as a partner ' +
      'dashboard belonging to somebody who is not one. Call GET /ib/status first.\n\n' +
      'IMPORTANT — `earnings.engineLive` is FALSE today. The commission engine was removed in ' +
      'migration 0028 and nothing writes commission entries yet, so the totals are true reads of ' +
      'an empty ledger rather than computed results. A client MUST label them as such instead of ' +
      'presenting a calculated-looking zero.',
  })
  @ApiOkResponse({ type: IbOverviewDto })
  overviewForMe(@Req() req: Request & { user: User }) {
    return this.overview.overviewFor(req.user.id);
  }

  @Get('commissions')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'This partner’s MOST RECENT commission entries, newest first',
    description:
      'The other half of the dashboard totals. Those read the LEDGER — money actually paid — so ' +
      'a partner whose accruals are still maturing sees zero there with no way to tell "nothing ' +
      'earned" from "earned, not yet released". Each row carries its status, so the two numbers ' +
      'explain each other.\n\n' +
      '⚠️ **CAPPED, and deliberately so.** This returns the newest ' +
      `${COMMISSION_FEED_LIMIT} entries and takes no paging parameters. A sum over these rows ` +
      'is a sum over WHAT WAS RETURNED, never a lifetime total — for that, read `earnings` on ' +
      '`GET /ib/overview`, which the database sums over the whole ledger. The portal labels the ' +
      'two separately for exactly this reason (`partner-earnings.ts`).\n\n' +
      'This summary read "Every commission this partner has earned" while the cap was in place, ' +
      'which is the same sentence-versus-behaviour gap the client money history carried under ' +
      'its old LIMIT 100.\n\n' +
      '`source: position` is a closed trade, which is the only thing that pays a revenue share. ' +
      '`transaction` rows are historical — commission is no longer earned on deposits.',
  })
  @ApiOkResponse({ type: [IbCommissionRowDto] })
  commissions(@Req() req: Request & { user: User }) {
    return this.overview.commissionsFor(req.user.id);
  }

  /*
   * ── `GET /ib/positions` IS GONE ──────────────────────────────────────────
   *
   * It queried the `positions` TABLE, which is created empty on purpose and
   * written by nothing — a stored profit is stale the moment it is saved. So
   * the endpoint answered `[]` on a platform with live trades, and the partner
   * screen read as "your clients are not trading".
   *
   * Reading it LIVE is what the account screen does, and it does not scale
   * here: one bridge call per client ACCOUNT, serialised behind the single MT5
   * session lock. A partner with fifty clients holding two accounts each is a
   * hundred round trips per page load, blocking every other client meanwhile.
   *
   * Removed rather than repaired. FR-IB-17 owes a partner visibility of their
   * sub-tree EARNINGS, and `GET /ib/commissions` carries every closed trade
   * that paid them.
   */

  @Get('agencies')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The partner programmes (وكالة) open for application',
    description:
      'What an applicant chooses between, with the products each one carries spelled out by ' +
      'name. Disabled agencies are ABSENT rather than greyed out: nobody here can answer "when ' +
      'does it reopen", and offering a choice that will be refused is a poor way to learn it is ' +
      'closed.\n\n' +
      'An empty list means no programme is open, and there is nothing to apply for — the portal ' +
      'says so instead of offering a button that can only be refused. An applicant introduced by ' +
      'a partner never consults this list at all: their programme is inherited, not chosen.',
  })
  @ApiOkResponse({ type: [PublicAgencyDto] })
  openAgencies() {
    return this.listOpenAgencies();
  }

  /**
   * Open a commission wallet in an offered currency — the partner screen's
   * "Open commission wallet" card. Active partners only; idempotent.
   */
  @Post('wallet/commission')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Open a commission wallet in an offered currency',
    description:
      'For an active partner. Refused for a currency that does not exist or is disabled. ' +
      'Opening one already held returns it unchanged. Commission is credited into a wallet ' +
      'opened on the first confirmed payout anyway; this shows the card before then.',
  })
  @ApiCreatedResponse({ type: WalletDto })
  async openCommissionWallet(@Req() req: Request & { user: User }, @Body() dto: OpenOwnWalletDto) {
    return walletView(await this.ibWallets.openCommissionWallet(req.user.id, dto.currency));
  }

  @Get('wallet/transfers')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Commission moved out of the commission wallet, newest first',
    description:
      'Every transfer, newest first, with the wallet numbers at both ends. It was capped at TEN ' +
      'while it rendered as a short panel beside the balance it explains; it is now a paged tab ' +
      'of its own, and a cap that silently hid a partner’s older transfers was the reason it ' +
      'could not answer “where did my money go”. ' +
      'These rows also appear in `GET /payments/transactions` alongside every other movement — a ' +
      "partner's own money should not be split across two histories that have to be reconciled " +
      'against each other.',
  })
  @ApiOkResponse({ type: [IbWalletTransferResultDto] })
  myWalletTransfers(@Req() req: Request & { user: User }) {
    return this.ibWallets.listTransfers(req.user.id);
  }

  @Post('wallet/transfer')
  @ApiCookieAuth()
  /*
   * R-5.2. The last money-moving route in the system without it.
   *
   * Both legs commit in one transaction, so a transfer cannot half-happen — but
   * nothing stopped the SAME transfer happening twice. A double-clicked "Move to
   * wallet", or a retry after a response is lost in transit, moved the
   * commission again, and both ledger rows are correct and permanent: the ledger
   * is append-only, so the correction is a compensating entry a human has to
   * write.
   *
   * The portal has been sending the header all along
   * (`oxshare-crm-client/src/lib/api/partner.ts`, key from
   * `newIdempotencyKey()`), so this activates a protection that was already
   * being paid for on the wire. That is also why it cannot break a caller: a
   * client that omits the header is the one being protected from itself.
   */
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended transfer, reused only when retrying that same one. Without ' +
      'it a double-clicked button moves the commission twice, and because the ledger is ' +
      'append-only the second movement is undone by a compensating entry rather than deleted ' +
      '(R-5.2).',
  })
  @ApiOperation({
    summary: 'Move commission earnings into the main wallet',
    description:
      'Same currency, same owner, both legs in one transaction — it commits whole or does not ' +
      'happen. There is no pending state to poll: unlike a wallet ⇄ trading-account transfer, ' +
      'nothing here crosses into a server this platform does not own.\n\n' +
      'Refuses a suspended partner, an amount above the available commission balance, and a ' +
      'currency the partner holds no commission wallet in — each with its own message, because ' +
      '"you have nothing to move" and "you have no such wallet" send a partner to different ' +
      'places.\n\n' +
      'Both legs are written to the ledger as `transfer`, NOT `commission`, so lifetime earnings ' +
      'are unchanged by moving money that was already earned.',
  })
  @ApiOkResponse({ type: IbWalletTransferResultDto })
  transferCommission(@Req() req: Request & { user: User }, @Body() dto: IbWalletTransferDto) {
    return this.ibWallets.transferToMain(req.user.id, dto);
  }

  @Post('apply')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Apply to become a partner',
    description:
      'Requires a verified identity (KYC level 1). Refuses a second application while one is ' +
      'still awaiting review, and refuses outright if the client is already a partner. ' +
      '`agencyId` names the programme applied for and must be one GET /ib/agencies returned — ' +
      'OMITTED by an applicant introduced by a partner, whose programme is inherited from the ' +
      'introducer and cannot be chosen.',
  })
  @ApiOkResponse({ type: IbApplicationDto })
  async apply(@Req() req: Request & { user: User }, @Body() dto: CreateIbApplicationDto) {
    return ibApplicationView(await this.applications.apply(req.user.id, dto));
  }
}
