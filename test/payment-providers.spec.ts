import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { auditStub } from './audit-stub';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { openSecret } from '../src/common/security/secret-box';
import type { Actor } from '../src/common/security/actor';
import type { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { PaymentProvidersStore } from '../src/store/payment-providers.store';
import { PaymentProviderEventsStore } from '../src/store/payment-provider-events.store';
import { RivalConfigService } from '../src/modules/payments/providers/rival/rival-config.service';
import type { RivalClient } from '../src/modules/payments/providers/rival/rival.client';
import { ChannelSwitchesService } from '../src/modules/payments/core/channel-switches.service';
import { AuditLogStore } from '../src/store/audit-log.store';
import { ProviderRecordsAudit } from '../src/modules/payments/core/provider-records-audit.service';
import { PaymentProviderExchangesStore } from '../src/store/payment-provider-exchanges.store';
import type { ResourceChangedPublisher } from '../src/common/realtime/resource-changed';
import { ManualPaymentProvider } from '../src/modules/payments/providers/manual/manual.provider';
import { RivalPaymentProvider } from '../src/modules/payments/providers/rival/rival.provider';
import { PaymentProviderRegistry } from '../src/modules/payments/providers/payment-provider-registry';
import { PaymentProvidersService } from '../src/modules/payments/providers/payment-providers.service';

/**
 * Payment providers (0168): the guarantees that decide whether money can go to
 * the wrong place — a secret never leaves, a URL cannot point inside the
 * network, a sandbox never runs in production, an older build keeps working on
 * the same credentials, and a provider's report is recorded once.
 */

const KEY = 'a-test-key-that-is-at-least-32-characters-long';
const ACTOR: Actor = {
  id: '00000000-0000-4000-8000-0000000000a1',
  email: 'providers@oxshare.internal',
  permissions: ALL_PERMISSIONS,
};
const API_KEY = 'tsk_live_do_not_leak_0123456789';

let ctx: MoneyTestContext;
let store: PaymentProvidersStore;
let events: PaymentProviderEventsStore;
let audit: ReturnType<typeof auditStub>;

function build(env: Record<string, string> = {}) {
  const config = {
    get: (key: string) =>
      key in env
        ? env[key]
        : key === 'APP_ENCRYPTION_KEY'
          ? KEY
          : key === 'API_PUBLIC_URL'
            ? 'https://api.oxshare.test'
            : undefined,
  } as never;
  const rivalConfig = new RivalConfigService(new AppSettingsStore(ctx.db), config);
  const rivalClient = {
    getCrmConfig: vi.fn().mockResolvedValue({ apiUrl: 'x', hasApiKey: true, enabled: true }),
  } as unknown as RivalClient;
  const registry = new PaymentProviderRegistry(
    [new ManualPaymentProvider(), new RivalPaymentProvider(rivalClient, rivalConfig)],
    config,
  );
  audit = auditStub();
  const service = new PaymentProvidersService(
    ctx.db,
    registry,
    store,
    events,
    config,
    audit as unknown as AdminAuditService,
    new ChannelSwitchesService(ctx.db, registry),
    { publish: vi.fn().mockResolvedValue(undefined) } as unknown as ResourceChangedPublisher,
    new ProviderRecordsAudit(ctx.db, new AuditLogStore(ctx.db)),
    new PaymentProviderExchangesStore(ctx.db),
  );
  return { service, registry, rivalConfig };
}

async function reset() {
  await ctx.db.execute(sql`DELETE FROM payment_provider_events`);
  await ctx.db.execute(sql`
    UPDATE payment_providers
       SET enabled = false, environment = 'live', config = '{}'::jsonb, secrets = '{}'::jsonb,
           last_check_at = NULL, last_check_ok = NULL, last_check_message = NULL, updated_by = NULL
     WHERE code = 'rival'`);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new PaymentProvidersStore(ctx.db);
  events = new PaymentProviderEventsStore(ctx.db);
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(reset);

describe('a provider secret', () => {
  it('is sealed at rest, never returned, and reaches the table an older build reads', async () => {
    const { service } = build();
    const saved = await service.update(
      'rival',
      { settings: { baseUrl: 'https://rival.example.test/v1' }, secrets: { apiKey: API_KEY } },
      ACTOR,
    );

    const row = await store.get('rival');
    const sealed = row?.secrets['apiKey'] ?? '';
    expect(sealed).not.toContain(API_KEY);
    expect(openSecret(sealed, KEY)).toBe(API_KEY);

    // Neither the plaintext nor the ciphertext reaches any response or audit row.
    const everything = JSON.stringify([saved, await service.list(), audit.record.mock.calls]);
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain(sealed);
    expect(saved.settings.find((s) => s.name === 'apiKey')).toMatchObject({
      isSet: true,
      value: null,
    });

    // Removing it clears it; the URL beside it stays.
    await service.update('rival', { secrets: { apiKey: null } }, ACTOR);
    const after = await store.get('rival');
    expect(after?.secrets).toEqual({});
    expect(after?.config['baseUrl']).toBe('https://rival.example.test/v1');
  });

  it('a generated one is shown once; afterwards only its fingerprint', async () => {
    const { service } = build();
    await service.update(
      'rival',
      { settings: { baseUrl: 'https://rival.example.test/v1' }, secrets: { apiKey: API_KEY } },
      ACTOR,
    );
    const minted = await service.rotateSecret('rival', 'webhookKey', ACTOR);
    expect(minted.webhookEndpoint).toBe('https://api.oxshare.test/v1/payments/rival/webhook');

    const row = await store.get('rival');
    expect(openSecret(row?.secrets['webhookKey'] ?? '', KEY)).toBe(minted.secret);
    const shown = await service.get('rival');
    expect(shown.settings.find((s) => s.name === 'webhookKey')).toMatchObject({
      isSet: true,
      value: null,
      fingerprint: minted.fingerprint,
    });
    expect(JSON.stringify([shown, audit.record.mock.calls])).not.toContain(minted.secret);

    // Typed in instead of rotated: refused, so no hand-chosen key signs money events.
    await expect(
      service.update('rival', { secrets: { webhookKey: 'password123' } }, ACTOR),
    ).rejects.toThrow(/generated/);
  });
});

describe('where money may be sent', () => {
  it('refuses a non-https URL, an internal address and an undeclared setting', async () => {
    const { service } = build();
    await expect(
      service.update('rival', { settings: { baseUrl: 'http://rival.example.test' } }, ACTOR),
    ).rejects.toThrow(/https/);
    await expect(
      service.update(
        'rival',
        { settings: { baseUrl: 'https://169.254.169.254/latest/meta-data' } },
        ACTOR,
      ),
    ).rejects.toThrow(/private or internal/);
    await expect(
      service.update('rival', { settings: { payoutsTo: 'https://evil.test' } }, ACTOR),
    ).rejects.toThrow(/no setting/);
    expect((await store.get('rival'))?.config).toEqual({});
  });

  it('cannot be switched on without its required settings', async () => {
    const { service } = build();
    await expect(
      service.update(
        'rival',
        { enabled: true, settings: { baseUrl: 'https://rival.example.test/v1' } },
        ACTOR,
      ),
    ).rejects.toThrow(/Company API key/);
    expect((await store.get('rival'))?.enabled).toBe(false);
  });
});

describe('a sandbox configuration on a production deployment', () => {
  it('is refused at save, and refused at run time if one is stored anyway', async () => {
    const { service, registry, rivalConfig } = build({ NODE_ENV: 'production' });
    await expect(service.update('rival', { environment: 'sandbox' }, ACTOR)).rejects.toThrow(
      /sandbox/,
    );

    // Stored some other way (a restore, raw SQL): the adapter still will not run it.
    await store.update(
      'rival',
      {
        enabled: true,
        environment: 'sandbox',
        config: { baseUrl: 'https://rival.example.test/v1' },
        secrets: {
          apiKey: (await import('../src/common/security/secret-box')).sealSecret(API_KEY, KEY),
        },
      },
      ACTOR.id,
    );
    rivalConfig.invalidate();
    expect(await rivalConfig.resolve()).toBeNull();
    const states = await registry.states(await store.list());
    expect(states.get('rival')).toMatchObject({ status: 'sandbox_refused', usable: false });
  });
});

describe('the provider event log', () => {
  it('keeps one row per fact, and lets a retry replace only a failure', async () => {
    const fact = {
      providerCode: 'rival',
      eventType: 'payment.succeeded' as const,
      subjectId: '777',
      source: 'webhook' as const,
    };
    await events.append({ ...fact, outcome: 'failed', reason: 'still pending' });
    await events.append({ ...fact, source: 'poll', outcome: 'applied' });
    await events.append({ ...fact, outcome: 'ignored', reason: 'duplicate' });

    const rows = await events.recent('rival', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'applied', source: 'poll', reason: null });
  });
});
