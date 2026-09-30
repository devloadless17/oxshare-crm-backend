import { createHash, randomBytes } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { asc, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { paymentMethods, transactions, withdrawalPaymentMethods } from '../../../database/schema';
import {
  FieldValidationError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors/domain-errors';
import { ResourceChangedPublisher } from '../../../common/realtime/resource-changed';
import { assertPublicOutboundHost } from '../../../common/security/outbound-host';
import { sealSecret } from '../../../common/security/secret-box';
import type { Actor } from '../../../common/security/actor';
import {
  PaymentProvidersStore,
  type PaymentProviderRow,
} from '../../../store/payment-providers.store';
import { PaymentProviderEventsStore } from '../../../store/payment-provider-events.store';
import { AdminAuditService } from '../../admin/admin-audit.service';
import type {
  PaymentProviderDto,
  ProviderActivityDto,
  ProviderEventDto,
  ProviderMethodDto,
  ProviderTestResultDto,
  RotatedProviderSecretDto,
  UnmatchedProviderRecordDto,
  UpdatePaymentProviderDto,
} from '../dto/payment-provider.dto';
import type {
  ChannelDirection,
  PaymentProviderAdapter,
  ProviderConfigField,
} from './payment-provider';
import { PaymentProviderRegistry, providerWebhookUrl } from './payment-provider-registry';
import {
  methodAvailability,
  missingSettings,
  payoutMethodStatus,
  type ProviderState,
} from './provider-status';
import {
  ChannelSwitchesService,
  channelSwitchKey,
  readOffSwitches,
  type ChannelSwitch,
} from '../core/channel-switches.service';
import { ProviderRecordsAudit } from '../core/provider-records-audit.service';

const MAX_SETTING_LENGTH = 2048;
const MAX_EVENTS = 200;

/**
 * THE CONSOLE'S SIDE OF EVERY PAYMENT PROVIDER (0168) — System → Payment providers.
 *
 * Generic on purpose: a provider's settings are the fields its adapter
 * declares, so a new provider gets a working settings page, health line and
 * event list without a screen of its own.
 *
 * ── This class seals; it never opens ───────────────────────────────────────
 *
 * The rule `RivalSettingsService` set: `sealSecret` is imported here and
 * `openSecret` only where a provider's adapter reads its own configuration.
 * A secret is never returned, never logged and never written to the audit
 * trail — only whether it changed, and a generated one's fingerprint.
 *
 * ── Built-in providers have nothing to change ──────────────────────────────
 *
 * Manual is the desk: always on, no settings. It is listed so the console can
 * show the desk's channels and the methods on them beside everyone else's.
 */
@Injectable()
export class PaymentProvidersService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly registry: PaymentProviderRegistry,
    private readonly store: PaymentProvidersStore,
    private readonly events: PaymentProviderEventsStore,
    private readonly config: ConfigService,
    private readonly audit: AdminAuditService,
    /* The network switches (0173) — appended last, the positional-construction rule. */
    private readonly switches: ChannelSwitchesService,
    private readonly resourceChanged: ResourceChangedPublisher,
    /* The unmatched-records audit (0174) — appended last, the positional-construction rule. */
    private readonly records: ProviderRecordsAudit,
  ) {}

  async list(): Promise<PaymentProviderDto[]> {
    const rows = await this.store.list();
    const states = await this.registry.states(rows);
    const methods = await this.methodsByProvider(states);
    const activity = await this.activityByProvider();
    const off = await this.switches.offSwitches();
    const unexplained = await this.records.openCounts();
    const byCode = new Map(rows.map((row) => [row.code, row]));
    return this.registry.list().map((adapter) => ({
      ...this.view(
        adapter,
        byCode.get(adapter.code) ?? null,
        states.get(adapter.code),
        methods,
        activity,
        off,
      ),
      auditsRecords: typeof adapter.listRecords === 'function',
      unexplainedRecords: unexplained.get(adapter.code) ?? 0,
    }));
  }

  /** What the provider holds that no transaction here explains (0174). */
  async unmatchedRecords(code: string, open: boolean): Promise<UnmatchedProviderRecordDto[]> {
    this.registry.provider(code);
    return (await this.records.list(code, open)).map(unmatchedView);
  }

  /** A person explains one as a company movement, with a note (audited). */
  async acknowledgeRecord(
    code: string,
    id: string,
    note: string,
    actor: Actor,
  ): Promise<UnmatchedProviderRecordDto> {
    this.registry.provider(code);
    return unmatchedView(await this.records.acknowledge(code, id, actor, note));
  }

  async get(code: string): Promise<PaymentProviderDto> {
    const found = (await this.list()).find((provider) => provider.code === code);
    if (!found) throw new NotFoundError(`There is no payment provider "${code}".`);
    return found;
  }

  /**
   * Change a provider's settings, secrets, environment or switch.
   *
   * Judged against the adapter's DECLARED fields: an unknown name is refused,
   * a URL must be https on the public internet (`outbound-host`), and a
   * generated secret can only be rotated. Switching on needs every required
   * setting; a sandbox configuration is refused outright on a production
   * deployment, so no sandbox webhook can ever move real money.
   */
  async update(
    code: string,
    dto: UpdatePaymentProviderDto,
    actor: Actor,
  ): Promise<PaymentProviderDto> {
    const adapter = this.configurable(code);
    const before = await this.requireRow(code);

    const settings = await this.judgeSettings(adapter, dto.settings);
    const secrets = this.judgeSecrets(adapter, dto.secrets);

    if (dto.environment === 'sandbox' && this.isProduction()) {
      throw new ValidationError(
        'A sandbox configuration cannot be used on a production deployment: its events would ' +
          'move real money. Keep it live here, and use sandbox on a test deployment.',
      );
    }

    // What the row will hold, to judge switching on against it.
    const merged = {
      config: mergeThreeState(before.config, settings),
      secrets: mergeThreeState(before.secrets, secrets),
    };
    const enabled = dto.enabled ?? before.enabled;
    if (enabled) {
      const missing = missingSettings(adapter, merged);
      if (missing.length > 0) {
        throw new ValidationError(
          `${adapter.name} cannot be switched on without: ${missing.join(', ')}.`,
        );
      }
    }

    const sealed = secrets
      ? Object.fromEntries(
          Object.entries(secrets).map(([name, value]) => [
            name,
            value === null ? null : this.seal(value),
          ]),
        )
      : undefined;
    const row = await this.store.update(
      code,
      {
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.environment !== undefined ? { environment: dto.environment } : {}),
        ...(settings ? { config: settings } : {}),
        ...(sealed ? { secrets: sealed } : {}),
      },
      actor.id,
    );
    adapter.settingsChanged?.();

    /*
     * The diff: settings by value (a base URL is where every payment
     * instruction goes, so its before/after is the row an auditor needs), a
     * secret only by what happened to it.
     */
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const name of Object.keys(settings ?? {})) {
      if ((before.config[name] ?? null) !== (row.config[name] ?? null)) {
        changed[name] = { before: before.config[name] ?? null, after: row.config[name] ?? null };
      }
    }
    if (before.environment !== row.environment) {
      changed['environment'] = { before: before.environment, after: row.environment };
    }
    const secretChanges = Object.fromEntries(
      Object.entries(secrets ?? {}).map(([name, value]) => [
        name,
        value === null ? 'removed' : 'replaced',
      ]),
    );
    if (Object.keys(changed).length > 0 || Object.keys(secretChanges).length > 0) {
      this.audit.record(actor.id, 'payment_provider.update', 'payment_provider', code, {
        changed,
        secrets: secretChanges,
      });
    }
    if (before.enabled !== row.enabled) {
      this.audit.record(
        actor.id,
        row.enabled ? 'payment_provider.enable' : 'payment_provider.disable',
        'payment_provider',
        code,
        { environment: row.environment },
      );
    }
    return this.get(code);
  }

  /**
   * Switch one of a provider's channels on or off in one direction (0173) —
   * e.g. 3pay's ERC20 payouts off while TRC20 stays on. A reason is required
   * to switch one off; both directions are audited and every desk and list
   * refreshes live. Money already moving on it still finishes (see
   * `ChannelSwitchesService`).
   */
  async setChannel(
    code: string,
    direction: ChannelDirection,
    channelCode: string,
    enabled: boolean,
    reason: string | null,
    actor: Actor,
  ): Promise<PaymentProviderDto> {
    const adapter = this.registry.provider(code);
    const channel = this.registry.channel({ providerCode: code, channelCode }, direction);
    if (!channel.bindable) {
      throw new ValidationError(`${channel.label} is the desk's own; it has no switch.`);
    }
    const before = await this.switches.offSwitch({ providerCode: code, channelCode }, direction);
    const saved = await this.switches.set(
      { providerCode: code, channelCode },
      direction,
      enabled,
      reason,
      actor.id,
    );
    if ((before === undefined) !== enabled || (!enabled && before?.reason !== saved.reason)) {
      this.audit.record(
        actor.id,
        enabled ? 'payment_provider.channel_enable' : 'payment_provider.channel_disable',
        'payment_provider',
        code,
        { provider: adapter.name, channel: channel.label, direction, reason: saved.reason },
      );
    }
    // The withdrawals desk shows "paused" by channel — data, no chime. The
    // acting admin's own screens refresh from the mutation itself.
    await this.resourceChanged.publish({ resource: 'withdrawals', actorAdminId: actor.id });
    return this.get(code);
  }

  /**
   * Mint a new value for a GENERATED secret (a webhook key). The plaintext
   * leaves once, in the response, for the operator to paste into the
   * provider's dashboard; afterwards only its fingerprint is shown.
   *
   * Not zero-downtime, as Rival's rotation never was: deliveries signed with
   * the old key are refused from this moment until the dashboard is updated,
   * and the poller catches up on what was refused in between.
   */
  async rotateSecret(code: string, name: string, actor: Actor): Promise<RotatedProviderSecretDto> {
    const adapter = this.configurable(code);
    const field = adapter.configFields.find((f) => f.name === name);
    if (!field || field.kind !== 'secret' || !field.generated) {
      throw new ValidationError(`${adapter.name} has no generated secret "${name}".`);
    }
    const before = await this.requireRow(code);
    const missing = missingSettings(adapter, before);
    if (missing.length > 0) {
      throw new ValidationError(
        `Save ${missing.join(', ')} first: the new ${field.label.toLowerCase()} is pasted into ` +
          `${adapter.name}’s dashboard, which is pointless for a connection that is not set up.`,
      );
    }

    const secret = randomBytes(48).toString('base64url');
    const print = fingerprint(secret);
    const fingerprintKey = `${name}Fingerprint`;
    await this.store.update(
      code,
      { secrets: { [name]: this.seal(secret) }, config: { [fingerprintKey]: print } },
      actor.id,
    );
    adapter.settingsChanged?.();

    this.audit.record(actor.id, 'payment_provider.secret_rotate', 'payment_provider', code, {
      secret: name,
      change: before.secrets[name] ? 'rotated' : 'minted',
      previousFingerprint: before.config[fingerprintKey] ?? null,
      fingerprint: print,
    });
    return { name, secret, fingerprint: print, webhookEndpoint: this.webhookEndpoint(adapter) };
  }

  /**
   * Ask the provider whether the saved settings work, and remember the answer —
   * it is the provider page's health line. Changes no setting, so it is not
   * audited.
   */
  async test(code: string): Promise<ProviderTestResultDto> {
    const adapter = this.configurable(code);
    if (!adapter.testConnection) {
      throw new ValidationError(`${adapter.name} has no connection to test.`);
    }
    const result = await adapter.testConnection();
    await this.store.recordCheck(code, result.ok, result.message);
    return { ...result, checkedAt: new Date().toISOString() };
  }

  async recentEvents(code: string, limit = 50): Promise<ProviderEventDto[]> {
    if (!this.registry.find(code)) {
      throw new NotFoundError(`There is no payment provider "${code}".`);
    }
    const rows = await this.events.recent(code, Math.min(Math.max(limit, 1), MAX_EVENTS));
    return rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      providerType: row.providerType,
      source: row.source,
      outcome: row.outcome,
      reason: row.reason,
      transactionId: row.transactionId,
      receivedAt: row.receivedAt.toISOString(),
    }));
  }

  // ── the view ──────────────────────────────────────────────────────────────

  private view(
    adapter: PaymentProviderAdapter,
    row: PaymentProviderRow | null,
    state: ProviderState | undefined,
    methods: Map<string, ProviderMethodDto[]>,
    activity: Map<string, ProviderActivityDto>,
    off: ReadonlyMap<string, ChannelSwitch>,
  ): Omit<PaymentProviderDto, 'auditsRecords' | 'unexplainedRecords'> {
    const saved = row !== null && missingSettings(adapter, row).length === 0;
    return {
      code: adapter.code,
      name: adapter.name,
      builtIn: adapter.builtIn,
      enabled: adapter.builtIn || (row?.enabled ?? false),
      environment: row?.environment === 'sandbox' ? 'sandbox' : 'live',
      status: state?.status ?? 'not_configured',
      statusMessage: state?.message ?? null,
      usable: state?.usable ?? false,
      configuredFrom: adapter.builtIn
        ? null
        : saved
          ? 'console'
          : state?.usable
            ? 'environment'
            : null,
      lastEventAt: row?.lastEventAt?.toISOString() ?? null,
      lastCheck:
        row?.lastCheckAt && row.lastCheckOk !== null
          ? {
              at: row.lastCheckAt.toISOString(),
              ok: row.lastCheckOk,
              message: row.lastCheckMessage,
            }
          : null,
      webhookEndpoint: this.webhookEndpoint(adapter),
      settings: adapter.configFields.map((field) => settingView(field, row)),
      channels: adapter.channels.map((channel) => {
        const switched = off.get(
          channelSwitchKey(
            { providerCode: adapter.code, channelCode: channel.code },
            channel.direction,
          ),
        );
        return {
          code: channel.code,
          direction: channel.direction,
          label: channel.label,
          flow: channel.flow,
          bindable: channel.bindable,
          currencies: channel.currencies === 'any' ? null : [...channel.currencies],
          destinationKind: channel.destination?.kind ?? null,
          destinationNetwork: channel.destination?.network ?? null,
          destinationLabel: channel.destination?.label ?? null,
          acceptsReceipt: channel.acceptsReceipt ?? false,
          // What moves at the provider when it is not the wallet currency (0173).
          assetLabel: channel.asset?.label ?? null,
          creditPolicy: channel.flow === 'redirect' ? (channel.creditPolicy ?? 'exact') : null,
          // The admin's switch (0173): on unless somebody switched it off, with why.
          enabled: switched === undefined,
          offReason: switched?.reason ?? null,
          offSince: switched ? switched.updatedAt.toISOString() : null,
        };
      }),
      methods: methods.get(adapter.code) ?? [],
      last24h: activity.get(adapter.code) ?? { total: 0, succeeded: 0, failed: 0, pending: 0 },
      updatedAt: row && row.updatedBy ? row.updatedAt.toISOString() : null,
    };
  }

  /** Every deposit and payout method, grouped by the provider it runs on. */
  private async methodsByProvider(
    states: Map<string, ProviderState>,
  ): Promise<Map<string, ProviderMethodDto[]>> {
    const [deposits, payouts] = await Promise.all([
      this.db.select().from(paymentMethods).orderBy(asc(paymentMethods.sortOrder)),
      this.db
        .select()
        .from(withdrawalPaymentMethods)
        .orderBy(asc(withdrawalPaymentMethods.sortOrder)),
    ]);
    const grouped = new Map<string, ProviderMethodDto[]>();
    const add = (providerCode: string, method: ProviderMethodDto) => {
      grouped.set(providerCode, [...(grouped.get(providerCode) ?? []), method]);
    };
    const off = await readOffSwitches(this.db);
    for (const row of deposits) {
      add(row.providerCode, {
        key: row.key,
        internalLabel: row.internalLabel,
        name: row.name,
        direction: 'deposit',
        channelCode: row.channelCode,
        enabled: row.enabled,
        availability: methodAvailability(
          row.enabled,
          states.get(row.providerCode),
          !off.has(channelSwitchKey(row, 'deposit')),
        ),
        paidBy: null,
      });
    }
    for (const row of payouts) {
      const rail = this.registry.payoutRail(row)?.rail;
      add(row.providerCode, {
        key: row.key,
        internalLabel: row.internalLabel,
        name: row.name,
        direction: 'payout',
        channelCode: row.channelCode,
        enabled: row.enabled,
        // The desk pays an automated one by hand while its provider cannot —
        // unless the provider waits instead (0173's `whenUnavailable`).
        ...payoutMethodStatus(
          row.enabled,
          rail ? rail.whenUnavailable : null,
          states.get(row.providerCode),
          !off.has(channelSwitchKey(row, 'payout')),
        ),
      });
    }
    return grouped;
  }

  /** Movements filed on each provider in the last 24 hours, by outcome. */
  private async activityByProvider(): Promise<Map<string, ProviderActivityDto>> {
    const rows = await this.db
      .select({
        providerCode: transactions.providerCode,
        total: sql<number>`count(*)::int`,
        succeeded: sql<number>`count(*) FILTER (WHERE ${transactions.state} = 'success')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${transactions.state} IN ('failure', 'rejected'))::int`,
        pending: sql<number>`count(*) FILTER (WHERE ${transactions.state} IN ('pending', 'approved'))::int`,
      })
      .from(transactions)
      .where(sql`${transactions.createdAt} >= now() - interval '24 hours'`)
      .groupBy(transactions.providerCode);
    return new Map(rows.map(({ providerCode, ...counts }) => [providerCode, counts] as const));
  }

  // ── validation ────────────────────────────────────────────────────────────

  /** A provider this console may change: known, and not built in. */
  private configurable(code: string): PaymentProviderAdapter {
    const adapter = this.registry.find(code);
    if (!adapter) throw new NotFoundError(`There is no payment provider "${code}".`);
    if (adapter.builtIn) {
      throw new ValidationError(`${adapter.name} is built in: it has no settings to change.`);
    }
    return adapter;
  }

  private async requireRow(code: string): Promise<PaymentProviderRow> {
    const row = await this.store.get(code);
    if (!row) throw new NotFoundError(`There is no payment provider "${code}".`);
    return row;
  }

  /** URL and text settings: declared, within length, and a URL safe to send money to. */
  private async judgeSettings(
    adapter: PaymentProviderAdapter,
    input: Record<string, string | null> | undefined,
  ): Promise<Record<string, string | null> | undefined> {
    if (input === undefined) return undefined;
    const judged: Record<string, string | null> = {};
    for (const [name, raw] of Object.entries(input)) {
      const field = adapter.configFields.find((f) => f.name === name);
      if (!field || field.kind === 'secret') {
        throw new ValidationError(`${adapter.name} has no setting "${name}".`);
      }
      const value = normaliseValue(raw, field);
      if (value !== null && field.kind === 'url') await this.assertSafeUrl(adapter, field, value);
      // The adapter's own rule for the value (a payout fee must be a decimal).
      const problem = value === null ? undefined : field.validate?.(value);
      if (problem) {
        throw new FieldValidationError(`${adapter.name} · ${field.label}: ${problem}`, {
          [`settings.${name}`]: problem,
        });
      }
      judged[name] = value;
    }
    return judged;
  }

  /** Typed secrets: declared, not generated, within length. */
  private judgeSecrets(
    adapter: PaymentProviderAdapter,
    input: Record<string, string | null> | undefined,
  ): Record<string, string | null> | undefined {
    if (input === undefined) return undefined;
    const judged: Record<string, string | null> = {};
    for (const [name, raw] of Object.entries(input)) {
      const field = adapter.configFields.find((f) => f.name === name);
      if (!field || field.kind !== 'secret') {
        throw new ValidationError(`${adapter.name} has no secret "${name}".`);
      }
      if (field.generated) {
        throw new ValidationError(
          `${field.label} is generated by the platform, never typed. Rotate it instead.`,
        );
      }
      judged[name] = normaliseValue(raw, field);
    }
    return judged;
  }

  /**
   * `https:` on the public internet — every payment and payout instruction, and
   * the key beside it, goes to this address (`RivalSettingsService` records the
   * attack: an admin session writing the metadata endpoint or an internal host).
   * Plain http is allowed only for localhost outside production.
   */
  private async assertSafeUrl(
    adapter: PaymentProviderAdapter,
    field: ProviderConfigField,
    value: string,
  ): Promise<void> {
    const production = this.isProduction();
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new ValidationError(`${adapter.name} · ${field.label} is not a URL.`);
    }
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback && !production)) {
      throw new ValidationError(
        `${adapter.name} · ${field.label} must be https:// — every payment and payout goes to it.`,
      );
    }
    await assertPublicOutboundHost(value, {
      subject: `${adapter.name} · ${field.label}`,
      allowLoopback: !production,
    });
  }

  private webhookEndpoint(adapter: PaymentProviderAdapter): string | null {
    return providerWebhookUrl(this.config.get<string>('API_PUBLIC_URL'), adapter);
  }

  private seal(value: string): string {
    return sealSecret(value, this.config.get<string>('APP_ENCRYPTION_KEY'));
  }

  private isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }
}

/** A setting as the console shows it: a secret never, a generated one by fingerprint. */
function settingView(field: ProviderConfigField, row: PaymentProviderRow | null) {
  const secret = field.kind === 'secret';
  const stored = secret ? row?.secrets[field.name] : row?.config[field.name];
  return {
    name: field.name,
    label: field.label,
    kind: field.kind,
    required: field.required,
    hint: field.hint ?? null,
    generated: field.generated ?? false,
    value: secret ? null : (stored ?? null),
    isSet: Boolean(stored),
    fingerprint: field.generated ? (row?.config[`${field.name}Fingerprint`] ?? null) : null,
  };
}

/** Trimmed; `''` and `null` both mean "remove". */
function normaliseValue(raw: string | null, field: ProviderConfigField): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw new ValidationError(`${field.label} must be text.`);
  const value = raw.trim();
  if (value === '') return null;
  if (value.length > MAX_SETTING_LENGTH) {
    throw new ValidationError(`${field.label} is longer than ${MAX_SETTING_LENGTH} characters.`);
  }
  return value;
}

function mergeThreeState(
  stored: Record<string, string>,
  change: Record<string, string | null> | undefined,
): Record<string, string> {
  const merged = { ...stored };
  for (const [name, value] of Object.entries(change ?? {})) {
    if (value === null) delete merged[name];
    else merged[name] = value;
  }
  return merged;
}

/** sha256[:8] — displayable and audit-safe, useless for recovering the secret. */
function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

/** A filed provider record as the console shows it. */
function unmatchedView(row: {
  id: string;
  subject: string;
  providerId: string;
  rawStatus: string;
  amount: string | null;
  asset: string | null;
  counterparty: string | null;
  reference: string | null;
  occurredAt: Date;
  foundAt: Date;
  matchedTransactionId: string | null;
  acknowledgedAt: Date | null;
  acknowledgement: string | null;
}): UnmatchedProviderRecordDto {
  return {
    id: row.id,
    subject: row.subject === 'payout' ? 'payout' : 'payment',
    providerId: row.providerId,
    rawStatus: row.rawStatus,
    amount: row.amount,
    asset: row.asset,
    counterparty: row.counterparty,
    reference: row.reference,
    occurredAt: row.occurredAt.toISOString(),
    foundAt: row.foundAt.toISOString(),
    matchedTransactionId: row.matchedTransactionId,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    acknowledgement: row.acknowledgement,
  };
}
