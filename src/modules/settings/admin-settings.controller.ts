import { Body, Controller, Get, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Admin } from '../../store/admins.store';
import { PermissionsGuard, RequirePermissions } from '../admin/guards/admin.guard';
import { NotClientScoped } from '../admin/guards/client-scope.decorator';
import { Audited, NotAudited } from '../admin/guards/audited.decorator';
import { EmailService } from '../email/email.service';
import { SettingsService } from './settings.service';
import { RivalSettingsService } from './rival-settings.service';
import {
  SmtpSettingsDto,
  SmtpTestResultDto,
  TradingSettingsDto,
  UpdateSmtpSettingsDto,
  UpdateTradingSettingsDto,
} from './dto/settings.dto';
import {
  RivalSettingsDto,
  RivalTestResultDto,
  RivalWebhookKeyDto,
  UpdateRivalSettingsDto,
} from './dto/rival-settings.dto';

/**
 * The settings screen's API — the Trading and Email tabs.
 *
 * Platforms and the security controls are served by their own controllers
 * (`platforms/admin-platform-links.controller.ts`,
 * `admin/admin-security-settings.controller.ts`) and stay there. The frontend
 * groups the tabs into one screen; that is a presentation decision and is not a
 * reason to merge independently-guarded resources behind one endpoint.
 *
 * A General tab lived here too — brand name, support contacts, a maintenance
 * notice. It was removed with its table: nothing outside its own form ever read
 * any of it, so every field was an operator changing a value with no effect.
 *
 * ── The two halves are guarded differently, on purpose ─────────────────────
 *
 * TRADING is `settings.view` / `settings.edit` — commercial dials, the same
 * class as a download link, and the reasoning in
 * `admin-platform-links.controller.ts` applies unchanged: forcing a master
 * admin to edit a leverage list is how the master credential ends up shared.
 *
 * SMTP is `MasterAdminGuard`, matching the security controls rather than the
 * download links. Whoever controls the mail relay receives every
 * password-reset link and every admin-invite link this system sends — and an
 * invite link, as `email.service.ts` puts it, "turns into a live admin account
 * with the inviter's granted permissions". So repointing SMTP is a path to
 * administrator on a system that approves withdrawals. That is the same
 * "should not be delegatable at all" category the withdrawal-OTP switch is in,
 * and making it a permission key means somebody eventually grants it to a role
 * called "Operations".
 */
@ApiTags('admin')
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly email: EmailService,
    private readonly rival: RivalSettingsService,
  ) {}

  /* ── Trading ────────────────────────────────────────────────────────────── */

  /*
   * `settings.view` / `settings.edit`, the same pair as General rather than the
   * master-admin lock on SMTP.
   *
   * These are commercial dials — the leverage ladder, how many accounts a
   * client may open, the demo ceiling — and the people who set them are the
   * people who run the brokerage, not whoever holds the master credential.
   * Requiring master here is how the master credential ends up shared, which is
   * the argument `admin-platform-links.controller.ts` makes and this follows.
   *
   * They are not the same class as SMTP: nothing here is a path to an
   * administrator account. The worst a bad value does is offer clients terms the
   * broker did not intend, which the audit log attributes and an operator can
   * reverse from the same screen.
   */
  @Get('trading')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The terms clients may open trading accounts on',
    description:
      'The leverage ladder, the per-client account caps and the largest demo opening balance. ' +
      'Until the first save these are the defaults, seeded from MT5_CLIENT_LEVERAGES when that ' +
      'variable is set.',
  })
  @ApiOkResponse({ type: TradingSettingsDto })
  @NotClientScoped('Broker-wide trading terms; contains no client data.')
  getTrading() {
    return this.settings.getTrading();
  }

  @Put('trading')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update the trading terms',
    description:
      'Leverages are a comma-separated list; a malformed entry is REFUSED rather than dropped, ' +
      'so a typo cannot silently shorten the offer. An account cap of 0 stops new accounts of ' +
      'that kind without touching the ones a client already holds.',
  })
  @ApiOkResponse({ type: TradingSettingsDto })
  @NotClientScoped('Broker-wide trading terms; contains no client data.')
  @Audited('settings.trading.update')
  setTrading(@Body() dto: UpdateTradingSettingsDto, @Req() req: Request & { admin: Admin }) {
    return this.settings.setTrading(dto, req.admin);
  }

  /* ── Email / SMTP ───────────────────────────────────────────────────────── */

  @Get('smtp')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.smtp.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Mail server configuration (master admin only)',
    description:
      'The stored password is never returned — `passwordSet` reports only whether one exists. ' +
      '`source` is "environment" until the first save, and the values shown are then the ' +
      'server’s own boot configuration rather than a blank form.',
  })
  @ApiOkResponse({ type: SmtpSettingsDto })
  @NotClientScoped('Mail server configuration; contains no client data.')
  getSmtp() {
    return this.settings.getSmtp();
  }

  @Put('smtp')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.smtp.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update the mail server configuration (master admin only)',
    description:
      'Omit `password` or send null to keep the stored one, a string to replace it, or an ' +
      'empty string to remove it. The password is encrypted at rest and is never read back.',
  })
  @ApiOkResponse({ type: SmtpSettingsDto })
  @NotClientScoped('Mail server configuration; contains no client data.')
  @Audited('settings.smtp.update')
  setSmtp(@Body() dto: UpdateSmtpSettingsDto, @Req() req: Request & { admin: Admin }) {
    return this.settings.setSmtp(dto, req.admin);
  }

  /**
   * Send a test message to the acting admin, and let the failure through.
   *
   * ── The recipient is not a parameter ───────────────────────────────────────
   *
   * It is `req.admin.email`, always. A free-text recipient would make this an
   * authenticated open relay: an endpoint that sends attacker-chosen content
   * from this system's own domain and reputation to any address. Restricting it
   * to the caller's own mailbox removes the reason to want that, and the caller
   * is by definition able to read the result.
   *
   * ── Rate limited, because it is an outbound send ──────────────────────────
   *
   * Three a minute is enough to iterate on a wrong host and not enough to make
   * this a way to bury a mailbox or burn a relay's quota.
   *
   * ── Not audited, and that is a decision ───────────────────────────────────
   *
   * It changes nothing. `settings.smtp.update` records the change this verifies,
   * and an audit row per diagnostic click adds noise to the log an auditor reads
   * without adding a fact they can act on.
   */
  @Post('smtp/test')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.smtp.edit')
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Send a test email to yourself using the saved settings (master admin only)',
    description:
      'Always sent to the signed-in administrator’s own address. A delivery failure is ' +
      'returned as an error carrying the mail server’s own message, because reporting success ' +
      'for a send that failed would defeat the purpose of the endpoint.',
  })
  @ApiOkResponse({ type: SmtpTestResultDto })
  @NotClientScoped('Sends only to the acting admin; contains no client data.')
  @NotAudited(
    'Changes nothing — it only verifies the configuration that settings.smtp.update records.',
  )
  async testSmtp(@Req() req: Request & { admin: Admin }): Promise<SmtpTestResultDto> {
    const { source } = await this.email.sendTestEmail(req.admin.email);
    return { sentTo: req.admin.email, source };
  }

  /* ── Payments / Rival ───────────────────────────────────────────────────── */
  /*
   * Rival is Loadless's payments platform; the CRM is one of its "companies".
   * Deposits and payouts route through it, so this credential pair is
   * SMTP-tier sensitive with a sharper edge: the API key can create payout
   * requests against the company balance, and whoever controls the base URL
   * receives every payout instruction this system issues. Own permission
   * keys (`settings.rival.*`), granted like `settings.smtp.*`.
   */

  @Get('rival')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.rival.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The Rival payments-platform connection',
    description:
      'Neither stored secret is ever returned — `apiKeySet` and `webhookKeyFingerprint` report ' +
      'existence and identity only. `source` is "environment" until the first save.',
  })
  @ApiOkResponse({ type: RivalSettingsDto })
  @NotClientScoped('Operator payment-platform configuration; contains no client data.')
  getRival() {
    return this.rival.get();
  }

  @Put('rival')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.rival.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update the Rival connection',
    description:
      'Omit `apiKey` or send null to keep the stored one, a string to replace it, or an empty ' +
      'string to remove it. Encrypted at rest and never read back.',
  })
  @ApiOkResponse({ type: RivalSettingsDto })
  @NotClientScoped('Operator payment-platform configuration; contains no client data.')
  @Audited('settings.rival.update')
  setRival(@Body() dto: UpdateRivalSettingsDto, @Req() req: Request & { admin: Admin }) {
    return this.rival.set(dto, req.admin);
  }

  /**
   * Mint (or rotate) the key Rival signs webhook deliveries with.
   *
   * The plaintext appears in THIS response and nowhere else, ever — the
   * operator pastes it into Rival's dashboard, whose own CRM-config write is
   * deliberately session-only so a leaked integration key cannot repoint the
   * event stream. Rotation cuts over immediately: deliveries signed with the
   * old key answer 401 (permanent to Rival) until the dashboard is updated,
   * and the poll backstop makes that gap lossless.
   */
  @Post('rival/webhook-key')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.rival.edit')
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Generate a new webhook signing key (shown exactly once)',
    description:
      'Replaces any previous key immediately. Copy it now — it is not retrievable; only its ' +
      'fingerprint is shown afterwards.',
  })
  @ApiOkResponse({ type: RivalWebhookKeyDto })
  @NotClientScoped('Operator payment-platform configuration; contains no client data.')
  @Audited('settings.rival.webhook_key.rotate')
  mintRivalWebhookKey(@Req() req: Request & { admin: Admin }) {
    return this.rival.mintWebhookKey(req.admin);
  }

  @Post('rival/test')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.rival.edit')
  @Throttle({ default: { ttl: 60_000, limit: 6 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Validate the stored Rival credentials',
    description:
      'Calls Rival with the stored key and returns what Rival believes our webhook ' +
      'configuration is, beside the URL it should be — a mismatch between the two sides is ' +
      'visible in one answer. A rejected key comes back as an error naming this screen.',
  })
  @ApiOkResponse({ type: RivalTestResultDto })
  @NotClientScoped('Operator payment-platform configuration; contains no client data.')
  @NotAudited(
    'Changes nothing — it only verifies the configuration that settings.rival.update records.',
  )
  testRival() {
    return this.rival.testConnection();
  }
}
