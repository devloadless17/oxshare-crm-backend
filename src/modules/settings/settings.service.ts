import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ValidationError } from '../../common/errors/domain-errors';
import { sealSecret } from '../../common/security/secret-box';
import { AppSettingsStore } from '../../store/app-settings.store';
import { SmtpConfigService } from '../email/smtp-config.service';
import type {
  GeneralSettingsDto,
  SmtpSettingsDto,
  UpdateGeneralSettingsDto,
  UpdateSmtpSettingsDto,
} from './dto/settings.dto';

/**
 * Reads and writes the two singleton settings rows.
 *
 * ── This class seals; it never opens ───────────────────────────────────────
 *
 * It imports `sealSecret` and deliberately not `openSecret`. Turning stored
 * ciphertext back into a password happens in exactly one place —
 * `SmtpConfigService`, on the path to the mail transport — and keeping the two
 * directions in separate classes is what makes "who can read the SMTP password"
 * answerable by looking at imports rather than by reading every method.
 *
 * ── Why the DEFAULTS come from the environment ─────────────────────────────
 *
 * `getSmtp` with no row returns the environment's values with
 * `source: 'environment'`, rather than an empty form. The operator opening this
 * screen for the first time is looking at a system that already sends mail, and
 * showing blank fields would invite them to retype a working configuration from
 * memory — or to save a partial one over it.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly store: AppSettingsStore,
    private readonly smtpConfig: SmtpConfigService,
    private readonly config: ConfigService,
  ) {}

  async getGeneral(): Promise<GeneralSettingsDto> {
    const row = await this.store.getGeneral();
    return {
      brandName: row?.brandName ?? 'OxShare',
      supportEmail: row?.supportEmail ?? null,
      supportUrl: row?.supportUrl ?? null,
      maintenanceNotice: row?.maintenanceNotice ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  async setGeneral(dto: UpdateGeneralSettingsDto, adminId: string): Promise<GeneralSettingsDto> {
    /*
     * `https:` only, and checked here rather than with `@IsUrl()`, for the
     * reason `platform-links.service.ts` spells out: class-validator's isURL
     * accepts `http:` and says nothing about `javascript:`, and this value
     * becomes an `href` in a client's browser.
     */
    const supportUrl = emptyToNull(dto.supportUrl);
    if (supportUrl !== null && !supportUrl.startsWith('https://')) {
      throw new ValidationError(
        'The support URL must start with https://. It becomes a link in every client’s ' +
          'browser, where http can be rewritten in transit and other schemes are worse.',
      );
    }

    const row = await this.store.setGeneral(
      {
        brandName: dto.brandName.trim(),
        supportEmail: emptyToNull(dto.supportEmail),
        supportUrl,
        maintenanceNotice: emptyToNull(dto.maintenanceNotice),
      },
      adminId,
    );

    return {
      brandName: row.brandName,
      supportEmail: row.supportEmail,
      supportUrl: row.supportUrl,
      maintenanceNotice: row.maintenanceNotice,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async getSmtp(): Promise<SmtpSettingsDto> {
    const row = await this.store.getSmtp();
    if (!row) {
      // No row yet: report what the process is actually using, so the form opens
      // pre-filled with the live configuration instead of blank.
      const effective = await this.smtpConfig.resolve();
      return {
        host: effective.host,
        port: effective.port,
        username: effective.username,
        passwordSet: effective.password !== null,
        fromAddress: effective.from,
        secure: effective.secure,
        source: 'environment',
        updatedAt: null,
      };
    }

    return {
      host: row.host,
      port: row.port,
      username: row.username,
      passwordSet: row.passwordCiphertext !== null,
      fromAddress: row.fromAddress,
      secure: row.secure,
      source: 'database',
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async setSmtp(dto: UpdateSmtpSettingsDto, adminId: string): Promise<SmtpSettingsDto> {
    /*
     * The three-state password, resolved once here:
     *
     *   undefined / null  → leave the stored value alone   (undefined to the store)
     *   ''                → remove it                      (null to the store)
     *   'secret'          → replace it                     (ciphertext to the store)
     *
     * The middle case is why this is not a simple `dto.password ? seal : null`:
     * that expression maps both "not touching it" and "remove it" to null and
     * silently wipes a working credential whenever an operator edits the port.
     */
    let passwordCiphertext: string | null | undefined;
    if (dto.password === undefined || dto.password === null) {
      passwordCiphertext = undefined;
    } else if (dto.password === '') {
      passwordCiphertext = null;
    } else {
      passwordCiphertext = sealSecret(dto.password, this.config.get<string>('APP_ENCRYPTION_KEY'));
    }

    const row = await this.store.setSmtp(
      {
        host: dto.host.trim(),
        port: dto.port,
        username: emptyToNull(dto.username),
        fromAddress: dto.fromAddress.trim(),
        secure: dto.secure,
        passwordCiphertext,
      },
      adminId,
    );

    return {
      host: row.host,
      port: row.port,
      username: row.username,
      passwordSet: row.passwordCiphertext !== null,
      fromAddress: row.fromAddress,
      secure: row.secure,
      source: 'database',
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/**
 * Treat a blank string as "not set".
 *
 * An operator clearing a field leaves `''`, and storing that would make
 * "configured as empty" and "not configured" two different states the UI has to
 * distinguish for no benefit.
 */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
