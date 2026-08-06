import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsService } from '../src/modules/settings/settings.service';
import { openSecret } from '../src/common/security/secret-box';
import type {
  GeneralSettingsRow,
  GeneralSettingsWrite,
  SmtpSettingsRow,
  SmtpSettingsWrite,
} from '../src/store/app-settings.store';

/**
 * The General and Email settings service.
 *
 * The behaviour worth pinning here is the THREE-STATE PASSWORD. "Leave it
 * alone", "replace it" and "remove it" are three things an operator does, and
 * the natural two-state implementation (`dto.password ? seal(...) : null`)
 * collapses the first into the third — silently wiping a working credential
 * every time somebody edits the port. That defect sends no error and shows no
 * symptom until the next email fails to authenticate.
 */

const KEY = 'a-test-key-that-is-at-least-32-characters-long';

/** Records what the service asked the store to write. */
class FakeStore {
  general: GeneralSettingsRow | null = null;
  smtp: SmtpSettingsRow | null = null;
  lastSmtpWrite: SmtpSettingsWrite | null = null;

  getGeneral(): Promise<GeneralSettingsRow | null> {
    return Promise.resolve(this.general);
  }

  setGeneral(values: GeneralSettingsWrite, updatedBy: string): Promise<GeneralSettingsRow> {
    this.general = { ...values, updatedBy, updatedAt: new Date('2026-01-01T00:00:00Z') };
    return Promise.resolve(this.general);
  }

  getSmtp(): Promise<SmtpSettingsRow | null> {
    return Promise.resolve(this.smtp);
  }

  setSmtp(values: SmtpSettingsWrite, updatedBy: string): Promise<SmtpSettingsRow> {
    this.lastSmtpWrite = values;
    const { passwordCiphertext, ...rest } = values;
    this.smtp = {
      ...rest,
      // Mirrors the store's real contract: undefined leaves the stored value.
      passwordCiphertext:
        passwordCiphertext === undefined
          ? (this.smtp?.passwordCiphertext ?? null)
          : passwordCiphertext,
      updatedBy,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    return Promise.resolve(this.smtp);
  }
}

const envConfig = {
  get: (key: string, fallback?: unknown) => {
    if (key === 'APP_ENCRYPTION_KEY') return KEY;
    if (key === 'SMTP_HOST') return 'smtp.env.test';
    if (key === 'SMTP_PORT') return 2525;
    if (key === 'SMTP_USER') return 'env-user';
    if (key === 'SMTP_PASS') return 'env-pass';
    if (key === 'SMTP_FROM') return '"Env" <env@example.test>';
    return fallback;
  },
};

/** The real resolver would need a database; this mirrors its env-fallback branch. */
const smtpConfigStub = {
  resolve: () =>
    Promise.resolve({
      host: 'smtp.env.test',
      port: 2525,
      secure: false,
      username: 'env-user',
      password: 'env-pass',
      from: '"Env" <env@example.test>',
      source: 'environment' as const,
      fingerprint: 'env',
    }),
};

let store: FakeStore;
let service: SettingsService;

beforeEach(() => {
  store = new FakeStore();
  service = new SettingsService(store as never, smtpConfigStub as never, envConfig as never);
});

const baseSmtp = {
  host: 'smtp.saved.test',
  port: 587,
  username: 'apikey',
  fromAddress: '"OxShare" <no-reply@oxshare.com>',
  secure: false,
};

describe('SMTP settings — the three-state password', () => {
  it('encrypts a supplied password rather than storing it', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, 'admin-1');

    const stored = store.lastSmtpWrite?.passwordCiphertext;
    expect(stored).toBeTypeOf('string');
    expect(stored).not.toContain('hunter2');
    expect(openSecret(stored as string, KEY)).toBe('hunter2');
  });

  it('leaves the stored password untouched when the field is omitted', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, 'admin-1');
    const original = store.smtp?.passwordCiphertext;

    // The operator edits the port and submits without retyping the password.
    await service.setSmtp({ ...baseSmtp, port: 465, secure: true }, 'admin-1');

    expect(store.lastSmtpWrite?.passwordCiphertext).toBeUndefined();
    expect(store.smtp?.passwordCiphertext).toBe(original);
    expect(store.smtp?.port).toBe(465);
  });

  it('leaves the stored password untouched when the field is explicitly null', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, 'admin-1');
    const original = store.smtp?.passwordCiphertext;

    await service.setSmtp({ ...baseSmtp, password: null }, 'admin-1');

    expect(store.lastSmtpWrite?.passwordCiphertext).toBeUndefined();
    expect(store.smtp?.passwordCiphertext).toBe(original);
  });

  it('removes the stored password on an explicit empty string', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, 'admin-1');

    await service.setSmtp({ ...baseSmtp, password: '' }, 'admin-1');

    expect(store.lastSmtpWrite?.passwordCiphertext).toBeNull();
    expect(store.smtp?.passwordCiphertext).toBeNull();
  });

  it('re-encrypts to a different ciphertext when the same password is saved again', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, 'admin-1');
    const first = store.smtp?.passwordCiphertext;

    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, 'admin-1');

    expect(store.smtp?.passwordCiphertext).not.toBe(first);
  });
});

describe('SMTP settings — what the API reports', () => {
  it('never returns the password, only whether one is set', async () => {
    const result = await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, 'admin-1');

    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(result.passwordSet).toBe(true);
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('passwordCiphertext');
  });

  it('reports passwordSet false once the password is removed', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, 'admin-1');
    const result = await service.setSmtp({ ...baseSmtp, password: '' }, 'admin-1');

    expect(result.passwordSet).toBe(false);
  });

  it('falls back to the live environment configuration when nothing is saved', async () => {
    /*
     * An empty form would invite the operator to retype a working configuration
     * from memory. Reporting what the process is actually using — and saying so
     * via `source` — is the difference between "my settings work" and "my
     * settings were never saved".
     */
    const result = await service.getSmtp();

    expect(result.source).toBe('environment');
    expect(result.host).toBe('smtp.env.test');
    expect(result.port).toBe(2525);
    expect(result.passwordSet).toBe(true);
    expect(result.updatedAt).toBeNull();
  });

  it('reports source "database" once a row exists', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, 'admin-1');

    const result = await service.getSmtp();
    expect(result.source).toBe('database');
    expect(result.host).toBe('smtp.saved.test');
  });

  it('stores secure explicitly rather than deriving it from the port', async () => {
    // A relay on a non-standard SMTPS port is the case `port === 465` gets wrong.
    const result = await service.setSmtp({ ...baseSmtp, port: 10465, secure: true }, 'admin-1');
    expect(result.secure).toBe(true);
    expect(result.port).toBe(10465);
  });

  it('treats a blank username as no credentials at all', async () => {
    await service.setSmtp({ ...baseSmtp, username: '   ' }, 'admin-1');
    expect(store.lastSmtpWrite?.username).toBeNull();
  });
});

describe('General settings', () => {
  it('returns defaults before anything is saved', async () => {
    const result = await service.getGeneral();
    expect(result.brandName).toBe('OxShare');
    expect(result.supportEmail).toBeNull();
    expect(result.updatedAt).toBeNull();
  });

  it('round-trips the values it was given', async () => {
    const result = await service.setGeneral(
      {
        brandName: 'Acme Markets',
        supportEmail: 'help@acme.test',
        supportUrl: 'https://help.acme.test',
        maintenanceNotice: 'Back at 09:00 UTC.',
      },
      'admin-1',
    );

    expect(result.brandName).toBe('Acme Markets');
    expect(result.supportUrl).toBe('https://help.acme.test');
    expect(result.maintenanceNotice).toBe('Back at 09:00 UTC.');
  });

  it('clears an optional field given an empty string', async () => {
    await service.setGeneral(
      {
        brandName: 'Acme',
        supportEmail: 'help@acme.test',
        supportUrl: 'https://help.acme.test',
        maintenanceNotice: null,
      },
      'admin-1',
    );

    const result = await service.setGeneral(
      { brandName: 'Acme', supportEmail: '', supportUrl: '', maintenanceNotice: '' },
      'admin-1',
    );

    expect(result.supportEmail).toBeNull();
    expect(result.supportUrl).toBeNull();
    expect(result.maintenanceNotice).toBeNull();
  });

  it('refuses a non-https support URL', async () => {
    /*
     * The value becomes an `href` in a client's browser. `@IsUrl()` would accept
     * http and say nothing about `javascript:` — the same reasoning the platform
     * download links are guarded by.
     */
    await expect(
      service.setGeneral(
        {
          brandName: 'Acme',
          supportEmail: null,
          supportUrl: 'http://help.acme.test',
          maintenanceNotice: null,
        },
        'admin-1',
      ),
    ).rejects.toThrow(/must start with https/i);

    await expect(
      service.setGeneral(
        {
          brandName: 'Acme',
          // eslint-disable-next-line no-script-url
          supportUrl: 'javascript:alert(1)',
          supportEmail: null,
          maintenanceNotice: null,
        },
        'admin-1',
      ),
    ).rejects.toThrow(/must start with https/i);
  });

  it('trims the brand name', async () => {
    const result = await service.setGeneral(
      { brandName: '  Acme  ', supportEmail: null, supportUrl: null, maintenanceNotice: null },
      'admin-1',
    );
    expect(result.brandName).toBe('Acme');
  });
});
