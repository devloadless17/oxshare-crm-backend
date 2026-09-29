import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT_KINDS } from '../src/common/logging/alerts';
import { KYC_BUCKET, StoredFilesService } from '../src/common/uploads/stored-files.service';
import type { StorageDriver } from '../src/common/uploads/storage/storage-driver';
import type { StoredObjectsStore } from '../src/store/stored-objects.store';

/**
 * THE OBJECT STORE BEING DOWN IS AN EVENT, NOT A PATTERN OF 500s.
 *
 * `/health/ready` probes the storage driver, so a sustained outage is visible —
 * to whoever polls it. What had no voice at all was the moment it starts
 * failing, and the people who notice first are clients stuck part-way through
 * onboarding with a document the system will not take.
 *
 * Measured, not imagined: during a verification run an R2 timeout surfaced as
 * `POST /v1/kyc/upload → 500: Request aborted`, from `withDeadline` aborting at
 * the 20s per-operation ceiling. Nothing in that 500 says "the object store is
 * unreachable" — it reads like any other server error, on a route that also
 * 500s for unrelated reasons.
 *
 * `RECONCILIATION_UNAVAILABLE` already exists for exactly this shape of
 * problem; storage had no equivalent.
 *
 * The distinction this file pins is the one that makes the alarm worth having:
 * a REFUSED upload (wrong type, too large, active content) is the caller's
 * problem and must stay silent here, or the alarm fires on every malformed PDF
 * and is muted within a week.
 */

const alerts: unknown[] = [];

beforeEach(() => {
  alerts.length = 0;
  vi.restoreAllMocks();
  vi.spyOn(Logger.prototype, 'error').mockImplementation((payload: unknown) => {
    alerts.push(payload);
    return undefined;
  });
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

function raised() {
  return alerts.filter(
    (a): a is { alert: string; kind: string } =>
      typeof a === 'object' && a !== null && 'alert' in a,
  );
}

/** A minimal PNG — passes the sniffer, so the test reaches the storage write. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
    '05fe02fe' +
    'a7d4c7000000000049454e44ae426082',
  'hex',
);

function service(put: () => Promise<void>) {
  const driver = {
    name: 'r2',
    put,
    get: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    healthy: vi.fn().mockResolvedValue(true),
  } as unknown as StorageDriver;
  const registry = {
    record: vi.fn().mockResolvedValue(undefined),
    // The per-owner quota check runs before the write; 0 keeps every fixture
    // under it so the test reaches the storage call it is about.
    liveBytesForOwner: vi.fn().mockResolvedValue(0),
  } as unknown as StoredObjectsStore;
  return new StoredFilesService(driver, driver, registry);
}

describe('a storage write that fails raises STORAGE_UNAVAILABLE', () => {
  const uploader = { kind: 'client' as const, id: '00000000-0000-0000-0000-000000000001' };

  it('alerts when the driver refuses, and still rethrows', async () => {
    const svc = service(() => Promise.reject(new Error('Request aborted')));

    await expect(svc.write(KYC_BUCKET, PNG, 'image/png', uploader)).rejects.toThrow(/aborted/);

    const alert = raised().find((a) => a.kind === ALERT_KINDS.STORAGE_UNAVAILABLE);
    expect(
      alert,
      'the object store refused a write and nothing raised the alarm — the caller ' +
        'gets a 500 that names no cause, exactly as the R2 timeout did',
    ).toBeDefined();
  });

  it('stays SILENT when the upload is refused for being the caller’s fault', async () => {
    /*
     * The assertion that keeps the alarm credible. An alarm that also fires on
     * every malformed document is one somebody mutes, and then it is not there
     * on the day the store is actually down.
     */
    const svc = service(() => Promise.resolve());

    await expect(
      svc.write(KYC_BUCKET, Buffer.from('not an image at all'), 'image/png', uploader),
    ).rejects.toBeDefined();

    expect(
      raised().find((a) => a.kind === ALERT_KINDS.STORAGE_UNAVAILABLE),
      'a rejected upload raised the storage alarm — the store was never even called',
    ).toBeUndefined();
  });
});
