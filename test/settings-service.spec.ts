import { ALL_PERMISSIONS } from './support/all-permissions';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SettingsService } from '../src/modules/settings/settings.service';
import { openSecret } from '../src/common/security/secret-box';
import type { Actor } from '../src/common/security/actor';
import type {
  SmtpSettingsRow,
  SmtpSettingsWrite,
  TradingSettingsRow,
  TradingSettingsWrite,
} from '../src/store/app-settings.store';

/**
 * The Trading and Email settings service.
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
  smtp: SmtpSettingsRow | null = null;
  lastSmtpWrite: SmtpSettingsWrite | null = null;
  trading: TradingSettingsRow | null = null;

  getTrading(): Promise<TradingSettingsRow | null> {
    return Promise.resolve(this.trading);
  }

  /*
   * The two payout ceilings are NOT on the write type any more (0112), and
   * this stub has to model what the real store then does with them: the upsert
   * spreads exactly the keys it is given, so a column the caller never
   * mentions keeps whatever it held. Seeding them here rather than dropping
   * them is what makes this stub's row a `TradingSettingsRow` at all — the
   * READ type still carries both, because the engine still reads both.
   */
  setTrading(values: TradingSettingsWrite, updatedBy: string): Promise<TradingSettingsRow> {
    this.trading = {
      ibMaxTotalPayoutPct: this.trading?.ibMaxTotalPayoutPct ?? '100.0000',
      ibMaxPayoutPerLot: this.trading?.ibMaxPayoutPerLot ?? '50.00000000',
      ...values,
      updatedBy,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    return Promise.resolve(this.trading);
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
    return fallback;
  },
};

let store: FakeStore;
let service: SettingsService;
let audit: { record: Mock; recordWithin: Mock };

/**
 * The acting administrator. `'admin-1'` was this file's id before both writes
 * needed the actor for the audit row; `ACTOR.id` is what still reaches
 * `updated_by`, so the existing assertions on that column are unchanged.
 */
const ACTOR: Actor = {
  id: 'admin-1',
  email: 'settings-admin@oxshare.internal',
  permissions: ALL_PERMISSIONS,
};

beforeEach(() => {
  store = new FakeStore();
  audit = { record: vi.fn(), recordWithin: vi.fn() };
  service = new SettingsService(
    store as never,
    envConfig as never,
    audit as never,
    // AdminsStore — only `namesByIds` is reached, resolving `updated_by` to a
    // name for the response. An empty map is the no-admin-found case.
    { namesByIds: vi.fn().mockResolvedValue(new Map()) } as never,
  );
});

/** A complete, valid trading form — each test varies one field of it. */
const baseTrading = {
  maxLiveAccounts: 5,
  maxDemoAccounts: 5,
  maxDemoDeposit: '1000000',
  /* The committed two levels — Feature List Rev 9, IB-17. */
  ibMaxLevels: 2,
  /* 100: the shipped default, which refuses only a chain costing more than
   * the trade earned. Tests that care about the ceiling override it. */
  ibMaxTotalPayoutPct: '100',
  ibMaxPayoutPerLot: '50',
};

const baseSmtp = {
  host: 'smtp.saved.test',
  port: 587,
  username: 'apikey',
  fromAddress: '"OxShare" <no-reply@oxshare.com>',
  secure: false,
};

describe('SMTP settings — the three-state password', () => {
  it('encrypts a supplied password rather than storing it', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, ACTOR);

    const stored = store.lastSmtpWrite?.passwordCiphertext;
    expect(stored).toBeTypeOf('string');
    expect(stored).not.toContain('hunter2');
    expect(openSecret(stored as string, KEY)).toBe('hunter2');
  });

  it('leaves the stored password untouched when the field is omitted', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, ACTOR);
    const original = store.smtp?.passwordCiphertext;

    // The operator edits the port and submits without retyping the password.
    await service.setSmtp({ ...baseSmtp, port: 465, secure: true }, ACTOR);

    expect(store.lastSmtpWrite?.passwordCiphertext).toBeUndefined();
    expect(store.smtp?.passwordCiphertext).toBe(original);
    expect(store.smtp?.port).toBe(465);
  });

  it('leaves the stored password untouched when the field is explicitly null', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, ACTOR);
    const original = store.smtp?.passwordCiphertext;

    await service.setSmtp({ ...baseSmtp, password: null }, ACTOR);

    expect(store.lastSmtpWrite?.passwordCiphertext).toBeUndefined();
    expect(store.smtp?.passwordCiphertext).toBe(original);
  });

  it('removes the stored password on an explicit empty string', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, ACTOR);

    await service.setSmtp({ ...baseSmtp, password: '' }, ACTOR);

    expect(store.lastSmtpWrite?.passwordCiphertext).toBeNull();
    expect(store.smtp?.passwordCiphertext).toBeNull();
  });

  it('re-encrypts to a different ciphertext when the same password is saved again', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, ACTOR);
    const first = store.smtp?.passwordCiphertext;

    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, ACTOR);

    expect(store.smtp?.passwordCiphertext).not.toBe(first);
  });
});

/**
 * The audit row for an SMTP change carries the FACT, never the credential.
 *
 * Repointing the mail relay is a path to administrator on a system that
 * approves withdrawals — whoever receives the invite links can become an admin
 * — so the action has to be attributable. But the audit log is append-only by
 * database trigger and readable by any unrestricted admin, so a password
 * written into it is one that cannot be revoked from it and is visible to more
 * people than the SMTP form is.
 *
 * These pin both halves: the row exists, and the secret is not in it.
 */
describe('SMTP settings — what the audit row does and does not carry', () => {
  it('records the change without the password, in any form', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, ACTOR);

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [actorId, action, , , details] = audit.record.mock.calls[0] as [
      string,
      string,
      string,
      string,
      Record<string, unknown>,
    ];

    expect(actorId).toBe(ACTOR.id);
    expect(action).toBe('settings.smtp.update');

    // The whole details payload, serialised — a password nested anywhere in it
    // fails this, which is the point. The ciphertext is checked too: it
    // decrypts, so logging it is logging the password with extra steps.
    const serialised = JSON.stringify(details);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain(store.smtp?.passwordCiphertext ?? 'never');
    expect(details).not.toHaveProperty('password');
    expect(details).not.toHaveProperty('passwordCiphertext');
  });

  it('says WHICH WAY the password moved, because that is the auditable fact', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, ACTOR);
    expect(detailsOfLastRecord()['passwordChange']).toBe('replaced');

    await service.setSmtp({ ...baseSmtp, port: 465 }, ACTOR);
    expect(detailsOfLastRecord()['passwordChange']).toBe('unchanged');

    await service.setSmtp({ ...baseSmtp, password: '' }, ACTOR);
    expect(detailsOfLastRecord()['passwordChange']).toBe('removed');
  });

  it('records the host change with the address it used to point at', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, ACTOR);
    await service.setSmtp({ ...baseSmtp, host: 'smtp.attacker.test' }, ACTOR);

    const changed = detailsOfLastRecord()['changed'] as Record<
      string,
      { before: unknown; after: unknown }
    >;
    // The OLD relay, which the UPDATE has already destroyed. "Where was mail
    // going before this change" is the question after a takeover.
    expect(changed['host']).toEqual({
      before: 'smtp.saved.test',
      after: 'smtp.attacker.test',
    });
  });
});

/** The details argument of the most recent `audit.record` call. */
function detailsOfLastRecord(): Record<string, unknown> {
  const calls = audit.record.mock.calls;
  return calls[calls.length - 1][4] as Record<string, unknown>;
}

describe('trading settings — the audit row', () => {
  it('records the previous demo ceiling, not just the new one', async () => {
    await service.setTrading({ ...baseTrading, maxDemoDeposit: '10000' }, ACTOR);
    await service.setTrading({ ...baseTrading, maxDemoDeposit: '1000000' }, ACTOR);

    const changed = detailsOfLastRecord()['changed'] as Record<
      string,
      { before: unknown; after: unknown }
    >;
    expect(changed['maxDemoDeposit']).toEqual({ before: '10000', after: '1000000' });
    // The ladder did not move, so it is not in the diff — a reader should not
    // have to compare identical pairs to find the one thing that changed.
    expect(changed).not.toHaveProperty('leverages');
  });
});

describe('SMTP settings — what the API reports', () => {
  it('never returns the password, only whether one is set', async () => {
    const result = await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, ACTOR);

    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(result.passwordSet).toBe(true);
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('passwordCiphertext');
  });

  it('reports passwordSet false once the password is removed', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, ACTOR);
    const result = await service.setSmtp({ ...baseSmtp, password: '' }, ACTOR);

    expect(result.passwordSet).toBe(false);
  });

  it('reports a BLANK, un-refused form when nothing is saved — the fallback is gone', async () => {
    /*
     * Mail is configured in ONE place now: the database, via Settings → Email.
     * The SMTP_* environment fallback was removed (12a7f6c), so "nothing
     * saved" must read as exactly that — a blank form — and this read must
     * NOT refuse: the settings screen is the only place the unconfigured
     * state can be fixed, so a 503 here would close the door on the fix.
     * `source` stays 'environment' because it is the DTO's word for "not from
     * the database" and both frontends read it.
     */
    const result = await service.getSmtp();

    expect(result.source).toBe('environment');
    expect(result.host).toBe('');
    expect(result.port).toBe(587);
    expect(result.passwordSet).toBe(false);
    expect(result.updatedAt).toBeNull();
  });

  it('reports source "database" once a row exists', async () => {
    await service.setSmtp({ ...baseSmtp, password: 'hunter2' }, ACTOR);

    const result = await service.getSmtp();
    expect(result.source).toBe('database');
    expect(result.host).toBe('smtp.saved.test');
  });

  it('stores secure explicitly rather than deriving it from the port', async () => {
    // A relay on a non-standard SMTPS port is the case `port === 465` gets wrong.
    const result = await service.setSmtp({ ...baseSmtp, port: 10465, secure: true }, ACTOR);
    expect(result.secure).toBe(true);
    expect(result.port).toBe(10465);
  });

  it('treats a blank username as no credentials at all', async () => {
    await service.setSmtp({ ...baseSmtp, username: '   ' }, ACTOR);
    expect(store.lastSmtpWrite?.username).toBeNull();
  });
});

describe('Trading settings', () => {
  it('returns defaults before anything is saved', async () => {
    const result = await service.getTrading();

    expect(result.maxLiveAccounts).toBe(5);
    expect(result.maxDemoAccounts).toBe(5);
    expect(result.updatedAt).toBeNull();
  });

  /*
   * The three leverage cases that were here — normalising a typed CSV,
   * rejecting `1OO`, rejecting an empty ladder — moved to `leverages.spec.ts`
   * with the data. There is no string to parse: each rung is a row, so
   * "positive whole number" is the whole of the validation and the empty-ladder
   * rule is a refusal to disable the last enabled one.
   */

  it('accepts a cap of zero — it is a real setting, not an empty field', async () => {
    // Zero stops new live accounts without touching the ones already open. A
    // service that treated it as "unset" would quietly reopen the door.
    const result = await service.setTrading({ ...baseTrading, maxLiveAccounts: 0 }, ACTOR);
    expect(result.maxLiveAccounts).toBe(0);
  });

  it('keeps the demo ceiling a string', async () => {
    const result = await service.setTrading(
      { ...baseTrading, maxDemoDeposit: '12345678901234567.89' },
      ACTOR,
    );

    // §6: money never goes through a float. `Number()` on this loses the last
    // two digits before anything is even displayed.
    expect(result.maxDemoDeposit).toBe('12345678901234567.89');
  });
});

/*
 * The settlement-window cases that stood here went in 0104 with the field.
 *
 * They pinned that the window was a SETTING rather than a deployment variable —
 * stored, zero accepted as a decision, and both sides recorded in the audit
 * when it moved. It is `IB_COMMISSION_HOLD_HOURS` again, along with the rest of
 * the IB block on this form: commission is configured on the Commission
 * Programmes page, and a second screen that also decides partner pay is a
 * second place for two answers to disagree.
 *
 * What the window DOES — the gap between earned and spendable — is unchanged and
 * is covered against a real database in `commission-hold-window.spec.ts`.
 */
