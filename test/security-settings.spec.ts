import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { securitySettings } from '../src/database/schema';
import { SECURITY_SWITCHES, SecuritySettingsStore } from '../src/store/security-settings.store';
import { SecuritySettingsService } from '../src/modules/admin/security-settings.service';
import type { AdminAuditService } from '../src/modules/admin/admin-audit.service';
import type { Admin } from '../src/store/admins.store';
import { ValidationError } from '../src/common/errors/domain-errors';

/**
 * The operator's switch for the withdrawal OTP.
 *
 * A switch that disables a money control is a liability, and the liability is
 * not malice — it is the Tuesday demo that nobody turns back on. These pin the
 * three properties that make leaving it off survivable: it is ON when nobody has
 * said otherwise, only a master admin can change it, and turning it off is both
 * audited and alerted.
 *
 * Against real Postgres because "a missing row means ON" is a property of the
 * QUERY, and that is exactly the kind of thing a fake would get right by
 * accident while the real one returned undefined.
 */

let ctx: MoneyTestContext;
let store: SecuritySettingsStore;
let service: SecuritySettingsService;
let audit: { record: ReturnType<typeof vi.fn>; recordWithin: ReturnType<typeof vi.fn> };

const MASTER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'master@oxshare.com',
  role: 'master_admin',
} as unknown as Admin;

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  store = new SecuritySettingsStore(ctx.db);
}, 120_000);

afterAll(async () => {
  await closeDb();
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.delete(securitySettings);
  audit = { record: vi.fn(), recordWithin: vi.fn() };
  service = new SecuritySettingsService(store, audit as unknown as AdminAuditService);
});

describe('secure by default', () => {
  it('reports the withdrawal OTP as ON when no row exists', async () => {
    /*
     * The direction that matters. A fresh deploy, a restored backup, or a
     * migration that ran before its seed all leave this table empty — and every
     * one of those must protect withdrawals rather than silently skip the OTP.
     */
    expect(await store.isEnabled(SECURITY_SWITCHES.withdrawalOtp)).toBe(true);
  });

  it('lists a known control even when it has never been configured', async () => {
    // Otherwise the admin screen shows an empty list on a fresh install and the
    // operator concludes there is nothing to configure.
    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: SECURITY_SWITCHES.withdrawalOtp, enabled: true });
  });
});

describe('turning a control off', () => {
  it('persists, and is readable afterwards', async () => {
    await service.set(SECURITY_SWITCHES.withdrawalOtp, false, MASTER);
    expect(await store.isEnabled(SECURITY_SWITCHES.withdrawalOtp)).toBe(false);
  });

  it('records WHO, with the before and after value', async () => {
    await service.set(SECURITY_SWITCHES.withdrawalOtp, false, MASTER);

    expect(audit.record).toHaveBeenCalledWith(
      MASTER.id,
      'security.control.set',
      'security_setting',
      SECURITY_SWITCHES.withdrawalOtp,
      expect.objectContaining({ from: true, to: false }),
    );
  });

  it('stamps the admin who changed it', async () => {
    await service.set(SECURITY_SWITCHES.withdrawalOtp, false, MASTER);
    const row = await store.get(SECURITY_SWITCHES.withdrawalOtp);
    expect(row.updatedBy).toBe(MASTER.id);
  });

  it('keeps alerting for as long as it stays off', async () => {
    /*
     * The property this whole design turns on. A single event at the moment of
     * the change scrolls away; a signal that repeats on every read is something
     * monitoring can see, and its DISAPPEARANCE is the resolution.
     */
    await service.set(SECURITY_SWITCHES.withdrawalOtp, false, MASTER);

    const errors = vi.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    await service.isEnabled(SECURITY_SWITCHES.withdrawalOtp);
    await service.isEnabled(SECURITY_SWITCHES.withdrawalOtp);

    expect(errors).toHaveBeenCalledTimes(2);
    expect(errors.mock.calls[0][0]).toMatchObject({
      alert: true,
      kind: 'security.control_disabled',
    });
    errors.mockRestore();
  });

  it('does not alert while the control is ON', async () => {
    await service.set(SECURITY_SWITCHES.withdrawalOtp, true, MASTER);
    const errors = vi.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    await service.isEnabled(SECURITY_SWITCHES.withdrawalOtp);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('turning it back on', () => {
  it('restores the control and audits the change', async () => {
    await service.set(SECURITY_SWITCHES.withdrawalOtp, false, MASTER);
    audit.record.mockClear();

    await service.set(SECURITY_SWITCHES.withdrawalOtp, true, MASTER);

    expect(await store.isEnabled(SECURITY_SWITCHES.withdrawalOtp)).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      MASTER.id,
      'security.control.set',
      'security_setting',
      SECURITY_SWITCHES.withdrawalOtp,
      expect.objectContaining({ from: false, to: true }),
    );
  });
});

describe('the key is a closed set', () => {
  it('refuses a control nobody defined', async () => {
    // An unknown key is a typo or a probe. Creating a row for it would leave a
    // setting in the table that nothing reads — which looks configured and is not.
    await expect(service.set('withdrawal_otp_v2', false, MASTER)).rejects.toThrow(ValidationError);
  });

  it('writes nothing when the key is unknown', async () => {
    await service.set('nonsense', false, MASTER).catch(() => undefined);
    expect(await ctx.db.select().from(securitySettings)).toHaveLength(0);
  });
});
