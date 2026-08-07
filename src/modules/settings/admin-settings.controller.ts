import { Body, Controller, Get, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Admin } from '../../store/admins.store';
import {
  MasterAdminGuard,
  PermissionsGuard,
  RequirePermissions,
} from '../admin/guards/admin.guard';
import { NotClientScoped } from '../admin/guards/client-scope.decorator';
import { Audited, NotAudited } from '../admin/guards/audited.decorator';
import { EmailService } from '../email/email.service';
import { SettingsService } from './settings.service';
import {
  GeneralSettingsDto,
  SmtpSettingsDto,
  SmtpTestResultDto,
  UpdateGeneralSettingsDto,
  UpdateSmtpSettingsDto,
} from './dto/settings.dto';

/**
 * The settings screen's API — the General and Email tabs.
 *
 * Platforms and the security controls are served by their own controllers
 * (`platforms/admin-platform-links.controller.ts`,
 * `admin/admin-security-settings.controller.ts`) and stay there. The frontend
 * groups four tabs into one screen; that is a presentation decision and is not a
 * reason to merge four independently-guarded resources behind one endpoint.
 *
 * ── The two halves are guarded differently, on purpose ─────────────────────
 *
 * GENERAL is `settings.manage` — a brand name and a support address are routine
 * operational content, the same class as a download link, and the reasoning in
 * `admin-platform-links.controller.ts` applies unchanged: forcing a master admin
 * to edit a support email is how the master credential ends up shared.
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

  /* ── General ────────────────────────────────────────────────────────────── */

  @Get('general')
  // PermissionsGuard, not AdminGuard: AdminGuard authenticates but does not read
  // @RequirePermissions, so the pair below would declare a permission nothing
  // enforced. `route-authorization.spec.ts` fails the build on exactly that.
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Brand name, support contacts and the maintenance notice' })
  @ApiOkResponse({ type: GeneralSettingsDto })
  @NotClientScoped('Operator branding and contact details; contains no client data.')
  getGeneral() {
    return this.settings.getGeneral();
  }

  @Put('general')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update the general settings',
    description:
      'Null or an empty string clears an optional field. The support URL must be https — it ' +
      'becomes a link in every client’s browser.',
  })
  @ApiOkResponse({ type: GeneralSettingsDto })
  @NotClientScoped('Operator branding and contact details; contains no client data.')
  @Audited('settings.general.update')
  setGeneral(@Body() dto: UpdateGeneralSettingsDto, @Req() req: Request & { admin: Admin }) {
    return this.settings.setGeneral(dto, req.admin);
  }

  /* ── Email / SMTP ───────────────────────────────────────────────────────── */

  @Get('smtp')
  @UseGuards(MasterAdminGuard)
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
  @UseGuards(MasterAdminGuard)
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
  @UseGuards(MasterAdminGuard)
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
