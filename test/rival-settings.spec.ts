import { ALL_PERMISSIONS } from './support/all-permissions';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { RivalSettingsService } from '../src/modules/settings/rival-settings.service';
import { RivalConfigService } from '../src/modules/payments/rival/rival-config.service';
import { openSecret, sealSecret } from '../src/common/security/secret-box';
import type { Actor } from '../src/common/security/actor';
import type { RivalSettingsRow, RivalSettingsWrite } from '../src/store/app-settings.store';

/**
 * The Rival connection's config substrate.
 *
 * Two behaviours carry the weight here:
 *
 *  1. THE THREE-STATE API KEY — the same defect class the SMTP password spec
 *     pins: "leave it alone" collapsing into "remove it" silently disarms the
 *     whole payments pipe the next time an operator toggles `enabled`.
 *  2. THE ROW WINS WHOLE — a half-merged config (row's base URL with the
 *     environment's key) would authenticate against a server nobody chose.
 *     `RivalConfigService` must resolve to null rather than merge, including
 *     when the stored ciphertext will not decrypt.
 */

const KEY = 'a-test-key-that-is-at-least-32-characters-long';

class FakeStore {
  rival: RivalSettingsRow | null = null;
  lastWrite: RivalSettingsWrite | null = null;

  getRival(): Promise<RivalSettingsRow | null> {
    return Promise.resolve(this.rival);
  }

  setRival(values: RivalSettingsWrite, updatedBy: string): Promise<RivalSettingsRow> {
    this.lastWrite = values;
    const { apiKeyCiphertext, webhookKeyCiphertext, webhookKeyFingerprint, ...rest } = values;
    this.rival = {
      ...rest,
      // Mirrors the real store's contract: undefined leaves the stored value.
      apiKeyCiphertext:
        apiKeyCiphertext === undefined ? (this.rival?.apiKeyCiphertext ?? null) : apiKeyCiphertext,
      webhookKeyCiphertext:
        webhookKeyCiphertext === undefined
          ? (this.rival?.webhookKeyCiphertext ?? null)
          : webhookKeyCiphertext,
      webhookKeyFingerprint:
        webhookKeyFingerprint === undefined
          ? (this.rival?.webhookKeyFingerprint ?? null)
          : webhookKeyFingerprint,
      lastEventAt: this.rival?.lastEventAt ?? null,
      updatedBy,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    return Promise.resolve(this.rival);
  }
}

function envConfig(overrides: Record<string, unknown> = {}) {
  return {
    get: (key: string, fallback?: unknown) => {
      if (key in overrides) return overrides[key];
      if (key === 'APP_ENCRYPTION_KEY') return KEY;
      return fallback;
    },
  };
}

const ACTOR: Actor = {
  id: 'admin-1',
  email: 'rival-admin@oxshare.internal',
  permissions: ALL_PERMISSIONS,
};

let store: FakeStore;
let audit: { record: Mock; recordWithin: Mock };
let configService: RivalConfigService;
let service: RivalSettingsService;

/** The client is only reached by testConnection; everything else is offline. */
const rivalClientStub = {
  getCrmConfig: vi.fn(() =>
    Promise.resolve({ apiUrl: 'https://crm.example/hook', hasApiKey: true, enabled: true }),
  ),
};

function build(env: Record<string, unknown> = {}) {
  store = new FakeStore();
  audit = { record: vi.fn(), recordWithin: vi.fn() };
  const config = envConfig(env);
  configService = new RivalConfigService(store as never, config as never);
  service = new RivalSettingsService(
    store as never,
    configService,
    rivalClientStub as never,
    config as never,
    audit as never,
  );
}

beforeEach(() => build({ API_PUBLIC_URL: 'https://api.oxshare.test' }));

const BASE = { baseUrl: 'https://portal.rivalpayments.test/v1', enabled: false };

describe('the three-state API key', () => {
  it('encrypts a supplied key rather than storing it', async () => {
    await service.set({ ...BASE, apiKey: 'tsk_abc_secret' }, ACTOR);

    const stored = store.lastWrite?.apiKeyCiphertext;
    expect(stored).toBeTypeOf('string');
    expect(stored).not.toContain('tsk_abc_secret');
    expect(openSecret(stored as string, KEY)).toBe('tsk_abc_secret');
  });

  it('an omitted key leaves the stored one untouched', async () => {
    await service.set({ ...BASE, apiKey: 'tsk_abc_secret' }, ACTOR);
    await service.set({ ...BASE, enabled: true }, ACTOR);

    expect(store.lastWrite?.apiKeyCiphertext).toBeUndefined();
    expect(openSecret(store.rival?.apiKeyCiphertext as string, KEY)).toBe('tsk_abc_secret');
  });

  it('an empty string removes the key', async () => {
    await service.set({ ...BASE, apiKey: 'tsk_abc_secret' }, ACTOR);
    await service.set({ ...BASE, apiKey: '' }, ACTOR);

    expect(store.rival?.apiKeyCiphertext).toBeNull();
  });

  it('refuses to enable while removing the key, and to enable with none stored', async () => {
    await expect(service.set({ ...BASE, enabled: true, apiKey: '' }, ACTOR)).rejects.toThrow(
      /cannot be enabled/i,
    );
    await expect(service.set({ ...BASE, enabled: true }, ACTOR)).rejects.toThrow(
      /cannot be enabled/i,
    );
  });

  it('refuses a non-https base URL, allowing localhost for development', async () => {
    await expect(
      service.set({ baseUrl: 'http://rival.example/v1', enabled: false }, ACTOR),
    ).rejects.toThrow(/https/);
    await expect(
      service.set({ baseUrl: 'http://localhost:3001/v1', enabled: false }, ACTOR),
    ).resolves.toBeTruthy();
  });
});

describe('what the API reports', () => {
  it('never returns either secret — existence and fingerprint only', async () => {
    await service.set({ ...BASE, apiKey: 'tsk_abc_secret' }, ACTOR);
    const dto = await service.get();

    expect(JSON.stringify(dto)).not.toContain('tsk_abc_secret');
    expect(dto.apiKeySet).toBe(true);
    expect(dto.source).toBe('database');
    expect(dto.webhookEndpoint).toBe('https://api.oxshare.test/v1/payments/rival/webhook');
  });

  it('reports the environment floor before the first save, and unconfigured without one', async () => {
    build({
      API_PUBLIC_URL: 'https://api.oxshare.test',
      RIVAL_BASE_URL: 'https://env.rival.test/v1',
      RIVAL_API_KEY: 'tsk_env_key',
    });
    expect((await service.get()).source).toBe('environment');

    build({ API_PUBLIC_URL: 'https://api.oxshare.test' });
    expect((await service.get()).source).toBe('unconfigured');
  });

  it('the audit row records direction, never the key', async () => {
    await service.set({ ...BASE, apiKey: 'tsk_abc_secret' }, ACTOR);

    const call = audit.record.mock.calls.find((c) => c[1] === 'settings.rival.update');
    expect(call).toBeDefined();
    expect(JSON.stringify(call)).not.toContain('tsk_abc_secret');
    expect((call?.[4] as { apiKeyChange: string }).apiKeyChange).toBe('replaced');
  });
});

describe('the webhook key', () => {
  it('is refused before the connection is configured', async () => {
    await expect(service.mintWebhookKey(ACTOR)).rejects.toThrow(/base URL and API key/i);
  });

  it('returns the plaintext exactly once, stores ciphertext + fingerprint', async () => {
    await service.set({ ...BASE, apiKey: 'tsk_abc_secret' }, ACTOR);
    const minted = await service.mintWebhookKey(ACTOR);

    expect(minted.webhookKey.length).toBeGreaterThanOrEqual(48);
    expect(minted.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(minted.endpoint).toBe('https://api.oxshare.test/v1/payments/rival/webhook');

    // Round-trips through the stored ciphertext…
    expect(openSecret(store.rival?.webhookKeyCiphertext as string, KEY)).toBe(minted.webhookKey);
    expect(store.rival?.webhookKeyFingerprint).toBe(minted.fingerprint);
    // …and every later read shows only the fingerprint.
    const dto = await service.get();
    expect(JSON.stringify(dto)).not.toContain(minted.webhookKey);
    expect(dto.webhookKeyFingerprint).toBe(minted.fingerprint);
  });

  it('rotation is audited as minted-then-rotated, with fingerprints and no key', async () => {
    await service.set({ ...BASE, apiKey: 'tsk_abc_secret' }, ACTOR);
    const first = await service.mintWebhookKey(ACTOR);
    const second = await service.mintWebhookKey(ACTOR);

    const rotations = audit.record.mock.calls.filter(
      (c) => c[1] === 'settings.rival.webhook_key.rotate',
    );
    expect(rotations).toHaveLength(2);
    expect((rotations[0][4] as { webhookKeyChange: string }).webhookKeyChange).toBe('minted');
    const secondDetails = rotations[1][4] as {
      webhookKeyChange: string;
      previousFingerprint: string;
    };
    expect(secondDetails.webhookKeyChange).toBe('rotated');
    expect(secondDetails.previousFingerprint).toBe(first.fingerprint);
    expect(JSON.stringify(rotations)).not.toContain(first.webhookKey);
    expect(JSON.stringify(rotations)).not.toContain(second.webhookKey);

    // A rotation replaces the ciphertext: the first key is gone.
    expect(openSecret(store.rival?.webhookKeyCiphertext as string, KEY)).toBe(second.webhookKey);
  });

  it('minting preserves the stored API key (the write must not clear siblings)', async () => {
    await service.set({ ...BASE, apiKey: 'tsk_abc_secret' }, ACTOR);
    await service.mintWebhookKey(ACTOR);

    expect(openSecret(store.rival?.apiKeyCiphertext as string, KEY)).toBe('tsk_abc_secret');
  });
});

describe('RivalConfigService — the row wins whole', () => {
  it('resolves the database row over an environment floor', async () => {
    build({ RIVAL_BASE_URL: 'https://env.rival.test/v1', RIVAL_API_KEY: 'tsk_env_key' });
    await service.set({ ...BASE, enabled: true, apiKey: 'tsk_db_key' }, ACTOR);

    const resolved = await configService.resolve();
    expect(resolved?.source).toBe('database');
    expect(resolved?.apiKey).toBe('tsk_db_key');
    expect(resolved?.baseUrl).toBe('https://portal.rivalpayments.test/v1');
  });

  it('a row missing its key resolves to null — never merged with the environment', async () => {
    build({ RIVAL_BASE_URL: 'https://env.rival.test/v1', RIVAL_API_KEY: 'tsk_env_key' });
    // A row with a base URL and no key: half a configuration.
    store.rival = {
      baseUrl: 'https://portal.rivalpayments.test/v1',
      apiKeyCiphertext: null,
      webhookKeyCiphertext: null,
      webhookKeyFingerprint: null,
      enabled: true,
      lastEventAt: null,
      updatedBy: null,
      updatedAt: new Date(),
    };
    /*
     * getRival() returning a half row must NOT hand back the env config —
     * that would call the row's host with the environment's credential.
     * (The env floor only applies when there is NO row at all… but a row
     * without both parts is treated as no configuration, not as half of one.)
     */
    expect(await configService.resolve()).toBeNull();
  });

  it('an undecryptable API key resolves to null, not to the environment', async () => {
    build({ RIVAL_BASE_URL: 'https://env.rival.test/v1', RIVAL_API_KEY: 'tsk_env_key' });
    store.rival = {
      baseUrl: 'https://portal.rivalpayments.test/v1',
      apiKeyCiphertext: sealSecret('tsk_db_key', 'another-key-that-is-32-characters-xx'),
      webhookKeyCiphertext: null,
      webhookKeyFingerprint: null,
      enabled: true,
      lastEventAt: null,
      updatedBy: null,
      updatedAt: new Date(),
    };
    expect(await configService.resolve()).toBeNull();
  });

  it('a save is live immediately — the cache is invalidated', async () => {
    await service.set({ ...BASE, enabled: true, apiKey: 'tsk_first' }, ACTOR);
    expect((await configService.resolve())?.apiKey).toBe('tsk_first');

    await service.set({ ...BASE, enabled: true, apiKey: 'tsk_second' }, ACTOR);
    expect((await configService.resolve())?.apiKey).toBe('tsk_second');
  });

  it('isEnabled asks both halves: configured AND switched on', async () => {
    await service.set({ ...BASE, enabled: false, apiKey: 'tsk_abc' }, ACTOR);
    expect(await configService.isEnabled()).toBe(false);

    await service.set({ ...BASE, enabled: true }, ACTOR);
    expect(await configService.isEnabled()).toBe(true);
  });
});

describe('test connection', () => {
  it("reports Rival's view of our webhook config beside the expected URL", async () => {
    const result = await service.testConnection();
    expect(result.ok).toBe(true);
    expect(result.rivalCrmConfig.hasApiKey).toBe(true);
    expect(result.expectedApiUrl).toBe('https://api.oxshare.test/v1/payments/rival/webhook');
  });
});
