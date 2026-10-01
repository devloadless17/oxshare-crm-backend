import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Admin } from '../../store/admins.store';
import { PermissionsGuard, RequirePermissions } from '../admin/guards/admin.guard';
import { NotClientScoped } from '../admin/guards/client-scope.decorator';
import { Audited, NotAudited } from '../admin/guards/audited.decorator';
import { EmailService } from '../email/email.service';
import { SettingsService } from './settings.service';
import {
  SmtpSettingsDto,
  SmtpTestResultDto,
  TradingSettingsDto,
  UpdateSmtpSettingsDto,
  UpdateTradingSettingsDto,
} from './dto/settings.dto';
import { ScheduledJobListDto, UpdateScheduledJobDto } from './dto/scheduled-jobs.dto';

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

  /* ── Scheduled jobs (0167) ────────────────────────────────────────────────── */

  /*
   * Every background job's timing, edited here rather than in an environment
   * file (owner, 29 Sep 2026). Read with `settings.view`, changed with
   * `settings.edit` — the same keys as the Trading terms, one of which (the
   * commission interval) is shown on both screens.
   */
  @Get('scheduled-jobs')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Background jobs: how often each runs, and its last run',
    description:
      'The CRM jobs are started by ScheduledJobsRunner at these intervals; `bridge.sweep` is read ' +
      'by the MT5 bridge once a minute. The commission pair share the Trading settings interval.',
  })
  @ApiOkResponse({ type: ScheduledJobListDto })
  @NotClientScoped('Platform job timings; contains no client data.')
  listJobs() {
    return this.settings.listJobs();
  }

  @Put('scheduled-jobs/:key')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Change how often a background job runs',
    description:
      'Within the job’s bounds (a 400 names them). Applies within 15 seconds (a minute for the ' +
      'bridge). For the commission jobs this is the Trading settings interval — also the hold.',
  })
  @ApiOkResponse({ type: ScheduledJobListDto })
  @NotClientScoped('Platform job timings; contains no client data.')
  @Audited('settings.jobs.update')
  setJobInterval(
    @Param('key') key: string,
    @Body() dto: UpdateScheduledJobDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.settings.setJobInterval(key, dto.intervalSeconds, req.admin);
  }

  @Post('scheduled-jobs/:key/run')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Run a background job now',
    description:
      'Started at the runner’s next tick (within 15 seconds). Not for the commission jobs or a ' +
      'bridge job (400).',
  })
  @ApiOkResponse({ type: ScheduledJobListDto })
  @NotClientScoped('Platform job timings; contains no client data.')
  @Audited('settings.jobs.run')
  runJobNow(@Param('key') key: string, @Req() req: Request & { admin: Admin }) {
    return this.settings.runJobNow(key, req.admin);
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
}
