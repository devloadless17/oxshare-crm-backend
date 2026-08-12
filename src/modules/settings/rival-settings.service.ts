import { createHash, randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ValidationError } from '../../common/errors/domain-errors';
import { sealSecret } from '../../common/security/secret-box';
import { AppSettingsStore } from '../../store/app-settings.store';
import { AdminAuditService } from '../admin/admin-audit.service';
import type { Actor } from '../../common/security/actor';
import { RivalClient } from '../payments/rival/rival.client';
import { RivalConfigService } from '../payments/rival/rival-config.service';
import type {
  RivalSettingsDto,
  RivalTestResultDto,
  RivalWebhookKeyDto,
  UpdateRivalSettingsDto,
} from './dto/rival-settings.dto';

/**
 * The admin screen's side of the Rival connection.
 *
 * ── This class seals; it never opens ───────────────────────────────────────
 *
 * Same split as `SettingsService`/`SmtpConfigService`: `sealSecret` is imported
 * here, `openSecret` only in `RivalConfigService`. "Who can read the Rival
 * credentials" stays answerable by imports.
 *
 * ── Two secrets with opposite lifecycles ───────────────────────────────────
 *
 * The API KEY is Rival's and is pasted in: write-only, three-state on update
 * (absent = keep, '' = remove, string = replace), never returned.
 *
 * The WEBHOOK KEY is OURS and is minted here: 48 bytes of entropy, returned in
 * plaintext EXACTLY ONCE for the operator to paste into Rival's dashboard,
 * then only its fingerprint is ever shown again. It is not accepted from the
 * request at all — a hand-chosen webhook secret is how "password123" ends up
 * authenticating a money-event stream.
 */
@Injectable()
export class RivalSettingsService {
  constructor(
    private readonly store: AppSettingsStore,
    private readonly rivalConfig: RivalConfigService,
    private readonly rival: RivalClient,
    private readonly config: ConfigService,
    private readonly audit: AdminAuditService,
  ) {}

  async get(): Promise<RivalSettingsDto> {
    const row = await this.store.getRival();
    if (!row) {
      // No row yet: report what the process is actually using (the env floor,
      // or nothing), so the form opens on the live configuration rather than
      // a blank page beside a working integration.
      const effective = await this.rivalConfig.resolve();
      return {
        baseUrl: effective?.baseUrl ?? null,
        apiKeySet: effective !== null,
        webhookKeyFingerprint: effective?.webhookKey ? fingerprint(effective.webhookKey) : null,
        enabled: effective?.enabled ?? false,
        lastEventAt: null,
        source: effective ? 'environment' : 'unconfigured',
        webhookEndpoint: this.webhookEndpoint(),
        updatedAt: null,
      };
    }

    return {
      baseUrl: row.baseUrl,
      apiKeySet: row.apiKeyCiphertext !== null,
      webhookKeyFingerprint: row.webhookKeyFingerprint,
      enabled: row.enabled,
      lastEventAt: row.lastEventAt?.toISOString() ?? null,
      source: 'database',
      webhookEndpoint: this.webhookEndpoint(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async set(dto: UpdateRivalSettingsDto, actor: Actor): Promise<RivalSettingsDto> {
    const previous = await this.get();

    const baseUrl = emptyToNull(dto.baseUrl);
    /*
     * `https:` only, same reasoning as the support URL: this is where every
     * payment create and payout goes, and http can be rewritten in transit.
     * Localhost is the development exception — Rival runs beside the CRM in
     * dev, and refusing it would force the env floor for local work.
     */
    if (baseUrl !== null && !baseUrl.startsWith('https://') && !isLoopback(baseUrl)) {
      throw new ValidationError(
        'The Rival base URL must be https:// (or http://localhost for development). Every ' +
          'payment and payout this system makes goes to it.',
      );
    }
    if (dto.enabled && baseUrl === null) {
      throw new ValidationError('Rival cannot be enabled without a base URL.');
    }

    // The three-state API key, resolved exactly as the SMTP password is.
    let apiKeyCiphertext: string | null | undefined;
    if (dto.apiKey === undefined || dto.apiKey === null) {
      apiKeyCiphertext = undefined;
    } else if (dto.apiKey === '') {
      apiKeyCiphertext = null;
    } else {
      apiKeyCiphertext = sealSecret(dto.apiKey, this.config.get<string>('APP_ENCRYPTION_KEY'));
    }

    if (dto.enabled && apiKeyCiphertext === null) {
      throw new ValidationError('Rival cannot be enabled while removing its API key.');
    }
    if (dto.enabled && apiKeyCiphertext === undefined && !previous.apiKeySet) {
      throw new ValidationError('Rival cannot be enabled without an API key.');
    }

    const row = await this.store.setRival(
      { baseUrl, enabled: dto.enabled, apiKeyCiphertext },
      actor.id,
    );
    this.rivalConfig.invalidate();

    /*
     * THE KEY IS NEVER RECORDED, in any form — the SMTP password's rule, for a
     * sharper reason: this credential can create payouts against the company's
     * Rival balance. What is recorded is the direction of change and the
     * fields that moved. Repointing `baseUrl` is the takeover path this row
     * makes attributable: whoever controls the base URL receives every payout
     * instruction this system issues.
     */
    const apiKeyChange =
      dto.apiKey === undefined || dto.apiKey === null
        ? 'unchanged'
        : dto.apiKey === ''
          ? 'removed'
          : 'replaced';

    const changed: Record<string, { before: unknown; after: unknown }> = {};
    if (previous.baseUrl !== row.baseUrl) {
      changed['baseUrl'] = { before: previous.baseUrl, after: row.baseUrl };
    }
    if (previous.enabled !== row.enabled) {
      changed['enabled'] = { before: previous.enabled, after: row.enabled };
    }

    this.audit.record(actor.id, 'settings.rival.update', 'app_settings', 'rival', {
      changed,
      apiKeyChange,
      apiKeySet: row.apiKeyCiphertext !== null,
      previousSource: previous.source,
    });

    return this.get();
  }

  /**
   * Mint (or rotate) the webhook key. The plaintext leaves this method once,
   * in the response, and is never retrievable again — the operator pastes it
   * into Rival's dashboard (`PUT /company/crm/config`, which is deliberately
   * dashboard-session-only on Rival's side).
   *
   * Rotation is deliberately NOT zero-downtime: the moment the row is written,
   * deliveries signed with the old key answer 401, which Rival treats as
   * permanent. The settings screen says so — rotate, then update Rival,
   * then use the Rival dashboard's demo inbox or the poller to catch up on
   * anything refused in the gap. The poller makes the gap lossless.
   */
  async mintWebhookKey(actor: Actor): Promise<RivalWebhookKeyDto> {
    const previous = await this.store.getRival();
    if (!previous || !previous.baseUrl) {
      throw new ValidationError(
        'Save the Rival base URL and API key before generating a webhook key — the key is ' +
          'pasted into the Rival dashboard, which there is no point doing for an ' +
          'unconfigured connection.',
      );
    }

    const key = randomBytes(48).toString('base64url');
    const keyFingerprint = fingerprint(key);

    await this.store.setRival(
      {
        baseUrl: previous.baseUrl,
        enabled: previous.enabled,
        webhookKeyCiphertext: sealSecret(key, this.config.get<string>('APP_ENCRYPTION_KEY')),
        webhookKeyFingerprint: keyFingerprint,
      },
      actor.id,
    );
    this.rivalConfig.invalidate();

    this.audit.record(actor.id, 'settings.rival.webhook_key.rotate', 'app_settings', 'rival', {
      // The fingerprint identifies WHICH key without carrying it; 'minted' vs
      // 'rotated' is the fact an auditor asks for ("did the signing key change
      // the day those events stopped arriving").
      webhookKeyChange: previous.webhookKeyFingerprint ? 'rotated' : 'minted',
      previousFingerprint: previous.webhookKeyFingerprint,
      fingerprint: keyFingerprint,
    });

    return { webhookKey: key, fingerprint: keyFingerprint, endpoint: this.webhookEndpoint() };
  }

  /**
   * Validate the stored credentials against Rival and report what Rival
   * believes our webhook configuration is, so a mismatch between the two
   * sides is visible on one screen. Errors pass through — `RivalClient`
   * already maps a rejected key to an actionable message.
   */
  async testConnection(): Promise<RivalTestResultDto> {
    const crm = await this.rival.getCrmConfig();
    return {
      ok: true,
      rivalCrmConfig: {
        apiUrl: crm.apiUrl,
        hasApiKey: crm.hasApiKey,
        enabled: crm.enabled,
      },
      expectedApiUrl: this.webhookEndpoint(),
    };
  }

  /**
   * The URL the operator pastes into Rival — built from `API_PUBLIC_URL`, the
   * address this API is reachable at from outside. Null in a deployment that
   * has not set one; the screen renders the gap instead of guessing a host.
   */
  private webhookEndpoint(): string | null {
    const base = this.config.get<string>('API_PUBLIC_URL');
    if (!base) return null;
    const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${trimmed}/v1/payments/rival/webhook`;
  }
}

/** sha256[:8] — displayable and audit-safe, useless for recovering the key. */
function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function isLoopback(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1');
  } catch {
    return false;
  }
}
