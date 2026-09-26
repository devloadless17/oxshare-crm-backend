import { ALL_PERMISSIONS } from './support/all-permissions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminComplianceService } from '../src/modules/admin/admin-compliance.service';
import {
  DEFAULT_KYC_STEPS,
  kycConfigVersion,
  type KycStepConfig,
} from '../src/store/kyc-config.store';
import { platformStep } from '../src/common/kyc/identity-core';
import {
  AuthorizationError,
  FieldValidationError,
  KycConfigStaleError,
  NotFoundError,
} from '../src/common/errors/domain-errors';

/**
 * THE ONE PATH EVERY CHANGE TO THE KYC FORM TAKES (26 Sep 2026).
 *
 * This file used to pin the opposite — "THE KYC FLOW IS FULLY CONFIGURABLE.
 * Nothing is undeletable." — after the owner retired the mandatory-step rule on
 * 15 Aug 2026. Then a broker's edit removed a client's first name from the
 * form, and the owner ruled again: the identity fields, the four built-in steps
 * and the identity and address documents are the platform's. Personal
 * Information and Identity Document are always on; Selfie and Proof of Address
 * can be switched off, which keeps the half of the old argument that was right.
 *
 * The rules themselves are pinned one by one in `kyc-config-integrity.spec.ts`.
 * This file pins what the SERVICE adds around them: every route goes through
 * them (the delete route used to check nothing), the version check, the
 * permission a change needs whichever route carries it, and the audit row
 * written in the same transaction.
 *
 * No database: a fake store and a transaction that simply runs its callback.
 */

const FORM: KycStepConfig[] = DEFAULT_KYC_STEPS.map((step) => platformStep(step));
const FUNDS: KycStepConfig = {
  id: 'step-funds',
  stepNumber: 5,
  slug: 'source-of-funds',
  title: 'Source of funds',
  description: '',
  icon: 'FileText',
  enabled: true,
  fields: [{ id: 'f-e', name: 'customField_e', label: 'Employer', type: 'text', required: true }],
  core: false,
  alwaysOn: false,
};

const getSteps = vi.fn();
const setSteps = vi.fn();
const lockForChange = vi.fn();
const recordWithin = vi.fn();

const ADMIN = { id: 'admin-1', email: 'admin@oxshare.com', permissions: ALL_PERMISSIONS } as never;
const EDITOR = {
  id: 'admin-2',
  email: 'editor@oxshare.com',
  permissions: ['kyc.view', 'kyc.edit'],
} as never;

function makeService(current: KycStepConfig[] = FORM) {
  getSteps.mockResolvedValue(current);
  setSteps.mockImplementation((steps: KycStepConfig[]) => Promise.resolve(steps));
  return new AdminComplianceService(
    {} as never, // KycService — unused on these paths
    { getSteps, setSteps, lockForChange } as never,
    {} as never, // RejectionReasonsStore
    { recordWithin } as never, // AdminAuditService
    {} as never, // ClientVisibilityService — the form is a schema, not a submission
    {} as never, // AdminsStore
    { transaction: (run: (tx: unknown) => Promise<unknown>) => run('tx') } as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('saving the whole form', () => {
  it('accepts its own read back, inside one locked transaction, and audits it there', async () => {
    const service = makeService();
    await service.updateKycConfig(FORM, ADMIN, kycConfigVersion(FORM));

    expect(lockForChange).toHaveBeenCalledWith('tx');
    expect(setSteps).toHaveBeenCalledWith(FORM, 'tx');
    expect(recordWithin).toHaveBeenCalledWith(
      'tx',
      'admin-1',
      'kyc_config.replace',
      'kyc_config',
      'steps',
      expect.objectContaining({ changes: [] }),
    );
  });

  it('refuses a save made from a version somebody else has since changed', async () => {
    const service = makeService();
    await expect(service.updateKycConfig(FORM, ADMIN, 'an-older-version')).rejects.toBeInstanceOf(
      KycConfigStaleError,
    );
    expect(setSteps).not.toHaveBeenCalled();
  });

  it('lets a builder that names no version through — deploying the API first breaks no screen', async () => {
    const service = makeService();
    await service.updateKycConfig(FORM, ADMIN, undefined);
    expect(setSteps).toHaveBeenCalled();
  });

  it('refuses a form that drops a built-in step, before writing anything', async () => {
    const service = makeService();
    await expect(
      service.updateKycConfig(
        FORM.filter((step) => step.slug !== 'document'),
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(FieldValidationError);
    expect(setSteps).not.toHaveBeenCalled();
  });

  it('records WHAT changed, in the builder’s words', async () => {
    const service = makeService();
    const off = FORM.map((step) => (step.slug === 'address' ? { ...step, enabled: false } : step));
    await service.updateKycConfig(off, ADMIN);
    expect(recordWithin).toHaveBeenCalledWith(
      'tx',
      'admin-1',
      'kyc_config.replace',
      'kyc_config',
      'steps',
      expect.objectContaining({
        enabled: expect.not.arrayContaining(['address']),
        changes: ['Switched off "Proof of Address"'],
      }),
    );
  });
});

describe('a whole-form save needs the permission of what it does', () => {
  it('refuses ADDING a step without kyc.create — the per-step route would refuse it too', async () => {
    const service = makeService();
    await expect(service.updateKycConfig([...FORM, FUNDS], EDITOR)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(setSteps).not.toHaveBeenCalled();
  });

  it('refuses REMOVING a step without kyc.delete', async () => {
    const service = makeService([...FORM, FUNDS]);
    await expect(service.updateKycConfig(FORM, EDITOR)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('lets kyc.edit alone change what is already there', async () => {
    const service = makeService([...FORM, FUNDS]);
    const renamed = [...FORM, { ...FUNDS, title: 'Where your money comes from' }];
    await service.updateKycConfig(renamed, EDITOR);
    expect(setSteps).toHaveBeenCalled();
  });
});

describe('the per-step routes take the same path', () => {
  it('refuses DELETING a built-in step — that route used to check nothing', async () => {
    const service = makeService();
    await expect(service.deleteKycStep('step-3', ADMIN)).rejects.toThrow(/cannot be removed/);
    expect(setSteps).not.toHaveBeenCalled();
  });

  it('deletes a step of the broker’s own', async () => {
    const service = makeService([...FORM, FUNDS]);
    await expect(service.deleteKycStep('step-funds', ADMIN)).resolves.toBe(true);
    expect(setSteps).toHaveBeenCalledWith(FORM, 'tx');
  });

  it('answers not found for a step that does not exist', async () => {
    const service = makeService();
    await expect(service.deleteKycStep('step-nope', ADMIN)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.updateKycStep('step-nope', { enabled: false }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('switches Selfie off, and refuses switching Identity Document off', async () => {
    const service = makeService();
    await service.updateKycStep('step-3', { enabled: false }, ADMIN);
    expect(setSteps).toHaveBeenCalled();
    await expect(service.updateKycStep('step-2', { enabled: false }, ADMIN)).rejects.toThrow(
      /always on/,
    );
  });

  it('refuses renaming a built-in step', async () => {
    const service = makeService();
    await expect(
      service.updateKycStep('step-4', { title: 'Address check' }, ADMIN),
    ).rejects.toThrow(/keeps its name/);
  });

  it('gives a new step an address from its title', async () => {
    const service = makeService();
    const created = await service.addKycStep(
      {
        slug: '',
        title: 'Source of Funds',
        description: '',
        icon: 'FileText',
        enabled: true,
        fields: [],
      },
      ADMIN,
    );
    expect(created).toMatchObject({ slug: 'source-of-funds', title: 'Source of Funds' });
  });

  it('resets to the defaults, keeping the built-in steps’ own ids', async () => {
    const current = FORM.map((step) => ({ ...step, id: `own-${step.slug}` }));
    const service = makeService([...current, FUNDS]);
    const after = await service.resetKycConfig(ADMIN);
    expect(after.map((step) => step.id)).toEqual(current.map((step) => step.id));
  });
});
