import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ValidationError } from '../../common/errors/domain-errors';
import { sealSecret } from '../../common/security/secret-box';
import { AppSettingsStore } from '../../store/app-settings.store';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
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
    private readonly audit: AdminAuditService,
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

  async setGeneral(dto: UpdateGeneralSettingsDto, actor: Actor): Promise<GeneralSettingsDto> {
    const adminId = actor.id;
    // Read BEFORE the write, because the log's job is answering "what did it
    // used to be" and `setGeneral` overwrites the only copy.
    const previous = await this.getGeneral();
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

    /*
     * The fields that MOVED, before and after.
     *
     * None of these looks like money and all of them are seen by every client:
     * the brand name, the support address a complaint goes to, and the
     * maintenance banner. A support email repointed to somewhere an operator
     * controls is a phishing surface with no other trace.
     *
     * The singleton has one row, so `subjectId` is the constant 'general'
     * rather than an id — the same shape `kyc_config.reset` uses.
     */
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of ['brandName', 'supportEmail', 'supportUrl', 'maintenanceNotice'] as const) {
      if (previous[field] !== row[field]) {
        changed[field] = { before: previous[field], after: row[field] };
      }
    }
    this.audit.record(actor.id, 'settings.general.update', 'app_settings', 'general', { changed });

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

  async setSmtp(dto: UpdateSmtpSettingsDto, actor: Actor): Promise<SmtpSettingsDto> {
    const adminId = actor.id;
    const previous = await this.getSmtp();
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

    /*
     * ── THE PASSWORD IS NEVER RECORDED, in any form ──────────────────────────
     *
     * Not the plaintext, not the ciphertext, not a prefix, not a length. The
     * audit log is append-only by trigger and readable by any unrestricted
     * admin, so a credential written here is a credential that cannot be
     * revoked from it and is visible to more people than the SMTP form is. This
     * class deliberately imports `sealSecret` and not `openSecret` for the same
     * reason — see the class comment.
     *
     * What IS recorded is that the password CHANGED and in which direction —
     * replaced, removed, or left alone. That is the fact an auditor needs
     * ("was the mail relay's credential rotated on the day those invites went
     * out"), and it carries none of the secret.
     *
     * The rest — host, port, from address, TLS — is where mail is SENT, not how
     * it authenticates, and repointing it is the takeover path this action
     * exists to make attributable: whoever controls the relay receives every
     * password-reset and admin-invite link this system sends.
     */
    const passwordChange =
      dto.password === undefined || dto.password === null
        ? 'unchanged'
        : dto.password === ''
          ? 'removed'
          : 'replaced';

    const changed: Record<string, { before: unknown; after: unknown }> = {};
    if (previous.host !== row.host) changed['host'] = { before: previous.host, after: row.host };
    if (previous.port !== row.port) changed['port'] = { before: previous.port, after: row.port };
    if (previous.username !== row.username) {
      changed['username'] = { before: previous.username, after: row.username };
    }
    if (previous.fromAddress !== row.fromAddress) {
      changed['fromAddress'] = { before: previous.fromAddress, after: row.fromAddress };
    }
    if (previous.secure !== row.secure) {
      changed['secure'] = { before: previous.secure, after: row.secure };
    }

    this.audit.record(actor.id, 'settings.smtp.update', 'app_settings', 'smtp', {
      changed,
      passwordChange,
      // Whether a credential is configured at all — a boolean, not the value.
      passwordSet: row.passwordCiphertext !== null,
      // 'environment' → 'database' is itself notable: the first save takes the
      // relay's configuration out of the deployment and into the table.
      previousSource: previous.source,
    });

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
