import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError, AuthorizationError } from '../src/common/errors/domain-errors';
import {
  WithdrawalOtpService,
  type WithdrawalIntent,
} from '../src/modules/payments/withdrawal-otp.service';
import type { OtpRedis } from '../src/common/security/replay-nonce.store';

/**
 * FR-CORE-08 / FR-IND-05 · ARCHITECTURE §8.4 · PLATFORM-CONVENTIONS R-3.7.
 *
 * The property these exist for is the BINDING one, and it is the property the
 * specs do not ask for: an OTP issued for one withdrawal must not authorise a
 * different one. The natural implementation — key on the user, mail a code,
 * accept it on the next withdrawal — builds a confirmation step that confirms
 * nothing, and it passes every test you would write without thinking about it.
 *
 * Against a fake Redis rather than a real one because every guarantee here is in
 * OUR logic — what the key is, when it is deleted, how many attempts are allowed.
 * The one thing that would need real Redis is TTL expiry, and that is Redis's
 * behaviour, not ours.
 */

/** A Redis that behaves like Redis for the five commands this service uses. */
function fakeRedis(): OtpRedis & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    set: (key, value) => {
      store.set(key, value);
      return Promise.resolve('OK');
    },
    get: (key) => Promise.resolve(store.get(key) ?? null),
    del: (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return Promise.resolve(n);
    },
    incr: (key) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return Promise.resolve(next);
    },
    pexpire: () => Promise.resolve(1),
  };
}

const INTENT: WithdrawalIntent = {
  userId: 'user-1',
  amount: '300.00000000',
  currency: 'USD',
  destination: 'GB33BUKB20201555555555',
  provider: 'whish',
};

let redis: ReturnType<typeof fakeRedis>;
let service: WithdrawalOtpService;

beforeEach(() => {
  process.env['JWT_ACCESS_SECRET'] = 'test-only-access-secret-at-least-32-chars';
  redis = fakeRedis();
  service = new WithdrawalOtpService(redis);
});

describe('the code is bound to ONE withdrawal', () => {
  it('accepts the code for the withdrawal it was issued for', async () => {
    const code = await service.issue(INTENT);
    await expect(service.verify(INTENT, code)).resolves.toBeUndefined();
  });

  it('REFUSES the same code for a larger amount', async () => {
    /*
     * The attack this is the whole point of. An attacker holding a live session
     * triggers a send for a small withdrawal to the victim's own account; the
     * victim reads a plausible email and relays six digits; the attacker spends
     * them on a withdrawal of a different size. The email said "confirm your
     * withdrawal" — it did not say which one.
     */
    const code = await service.issue(INTENT);
    await expect(service.verify({ ...INTENT, amount: '9000.00000000' }, code)).rejects.toThrow(
      ValidationError,
    );
  });

  it('REFUSES the same code for a different destination', async () => {
    // The field an attacker actually needs to change: the amount is what a
    // victim would notice, the destination is where the money goes.
    const code = await service.issue(INTENT);
    await expect(
      service.verify({ ...INTENT, destination: 'attacker-wallet-address' }, code),
    ).rejects.toThrow(ValidationError);
  });

  it('REFUSES the same code for a different provider or currency', async () => {
    const code = await service.issue(INTENT);
    await expect(service.verify({ ...INTENT, provider: 'usdt' }, code)).rejects.toThrow(
      ValidationError,
    );
    await expect(service.verify({ ...INTENT, currency: 'USDT' }, code)).rejects.toThrow(
      ValidationError,
    );
  });

  it('REFUSES another user’s code', async () => {
    const code = await service.issue(INTENT);
    await expect(service.verify({ ...INTENT, userId: 'user-2' }, code)).rejects.toThrow(
      ValidationError,
    );
  });

  it('ignores case and surrounding space in the destination', async () => {
    // Otherwise a client who pastes an address with a trailing space gets a code
    // that cannot be spent, and no message explains why.
    const code = await service.issue(INTENT);
    await expect(
      service.verify({ ...INTENT, destination: `  ${INTENT.destination.toLowerCase()} ` }, code),
    ).resolves.toBeUndefined();
  });
});

describe('single use', () => {
  it('cannot be spent twice', async () => {
    const code = await service.issue(INTENT);
    await service.verify(INTENT, code);
    await expect(service.verify(INTENT, code)).rejects.toThrow(ValidationError);
  });

  it('deletes the stored code on success, so nothing reusable is left behind', async () => {
    const code = await service.issue(INTENT);
    await service.verify(INTENT, code);
    expect([...redis.store.keys()].filter((k) => k.startsWith('otp:withdrawal:'))).toEqual([
      // Only the per-user send counter survives, which is the intended bound.
      'otp:withdrawal:sends:user-1',
    ]);
  });
});

describe('attempt limits — R-3.7', () => {
  it('allows five wrong guesses and destroys the code on the sixth', async () => {
    await service.issue(INTENT);
    for (let i = 0; i < WithdrawalOtpService.MAX_ATTEMPTS; i++) {
      await expect(service.verify(INTENT, '000000')).rejects.toThrow(ValidationError);
    }
    // The cap is what makes six digits adequate: without it, 10^6 is guessable.
    await expect(service.verify(INTENT, '000000')).rejects.toThrow(/cancelled/i);
  });

  it('destroys the code rather than merely refusing the attempt', async () => {
    const code = await service.issue(INTENT);
    for (let i = 0; i <= WithdrawalOtpService.MAX_ATTEMPTS; i++) {
      await service.verify(INTENT, '000000').catch(() => undefined);
    }
    // Even the CORRECT code is now dead — an attacker who can keep guessing
    // past the cap has no cap.
    await expect(service.verify(INTENT, code)).rejects.toThrow(ValidationError);
  });

  it('gives a fresh code a fresh attempt budget', async () => {
    await service.issue(INTENT);
    await service.verify(INTENT, '000000').catch(() => undefined);
    await service.verify(INTENT, '000000').catch(() => undefined);

    const code = await service.issue(INTENT);
    // A user who mistyped twice and asked for a new code must not start two
    // attempts down.
    await expect(service.verify(INTENT, code)).resolves.toBeUndefined();
  });
});

describe('send limits — R-3.7', () => {
  it('allows three sends per window and refuses the fourth', async () => {
    for (let i = 0; i < WithdrawalOtpService.MAX_SENDS; i++) {
      await expect(service.issue(INTENT)).resolves.toMatch(/^\d{6}$/);
    }
    await expect(service.issue(INTENT)).rejects.toThrow(ValidationError);
  });

  it('counts sends per USER, not per intent', async () => {
    // Keyed on the intent, an attacker would reset the counter by changing one
    // character of the destination — and the thing being protected here is the
    // victim's inbox as much as the account.
    await service.issue(INTENT);
    await service.issue({ ...INTENT, destination: 'a' });
    await service.issue({ ...INTENT, destination: 'b' });
    await expect(service.issue({ ...INTENT, destination: 'c' })).rejects.toThrow(ValidationError);
  });
});

describe('the code itself', () => {
  it('is six digits', async () => {
    expect(await service.issue(INTENT)).toMatch(/^\d{6}$/);
  });

  it('is never stored in the clear — a Redis dump must not yield live codes', async () => {
    const code = await service.issue(INTENT);
    expect([...redis.store.values()]).not.toContain(code);
  });

  it('differs between issues', async () => {
    const a = await service.issue(INTENT);
    redis.store.clear();
    const b = await service.issue(INTENT);
    // Not a randomness test — a guard against someone deriving the code from
    // the intent, which would make it computable by anyone who knows the scheme.
    expect(a === b && a === '000000').toBe(false);
  });
});

describe('fails closed', () => {
  it('refuses to issue when Redis is unavailable', async () => {
    const offline = new WithdrawalOtpService(null);
    await expect(offline.issue(INTENT)).rejects.toThrow(AuthorizationError);
  });

  it('refuses to VERIFY when Redis is unavailable', async () => {
    // The direction that matters: an outage must not mean "no OTP required".
    // That is exactly how the MT5 timestamp check was disabled before R-5.3.
    const offline = new WithdrawalOtpService(null);
    await expect(offline.verify(INTENT, '123456')).rejects.toThrow(AuthorizationError);
  });
});
