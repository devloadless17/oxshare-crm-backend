import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AdminComplianceService } from '../src/modules/admin/admin-compliance.service';
import { MANDATORY_KYC_SLUGS, type KycStepConfig } from '../src/store/kyc-config.store';
import { ValidationError } from '../src/common/errors/domain-errors';

/**
 * FR-CORE-15 / FR-IND-03: the personal, document, selfie and address steps are
 * mandatory.
 *
 * This rule used to live ONLY in the admin UI. Verified against a running server
 * before the fix:
 *
 *   PUT    /admin/kyc-config              with `personal.enabled = false` -> 200
 *   DELETE /admin/kyc-config/steps/step-2 (identity document)             -> 200, gone
 *
 * The client portal filters /kyc/config to enabled steps, so either call silently
 * removed a required step from onboarding for every new client, and the FSD's §14
 * acceptance criteria depend on those steps existing. Any script, integration or
 * future admin client bypassed the screen that enforced it.
 *
 * No database here: these assertions are about the service's guard, so the store is
 * a fake. The §11 money specs are where Testcontainers earns its cost.
 */

function step(slug: string, over: Partial<KycStepConfig> = {}): KycStepConfig {
  return {
    id: `step-${slug}`,
    stepNumber: 1,
    slug,
    title: slug.charAt(0).toUpperCase() + slug.slice(1),
    description: '',
    icon: 'User',
    enabled: true,
    fields: [],
    ...over,
  };
}

const DEFAULT_STEPS = [...MANDATORY_KYC_SLUGS.map((s) => step(s)), step('review')];

const setSteps = vi.fn();
const updateStep = vi.fn();
const deleteStep = vi.fn();
const getSteps = vi.fn();

function makeService(steps: KycStepConfig[] = DEFAULT_STEPS) {
  getSteps.mockResolvedValue(steps);
  const kycConfig = { setSteps, updateStep, deleteStep, getSteps };
  return new AdminComplianceService(
    {} as never, // KycService — unused on these paths
    kycConfig as never,
    {} as never, // RejectionReasonsStore
    {} as never, // AdminAuditService
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setSteps.mockResolvedValue(DEFAULT_STEPS);
  updateStep.mockResolvedValue(undefined);
  deleteStep.mockResolvedValue(true);
});

describe('replacing the whole KYC configuration', () => {
  it('accepts a config with every mandatory step enabled', async () => {
    const service = makeService();

    await service.updateKycConfig(DEFAULT_STEPS);

    expect(setSteps).toHaveBeenCalledTimes(1);
  });

  it('rejects a config that DISABLES a mandatory step', async () => {
    const service = makeService();
    const steps = DEFAULT_STEPS.map((s) => (s.slug === 'personal' ? { ...s, enabled: false } : s));

    await expect(service.updateKycConfig(steps)).rejects.toBeInstanceOf(ValidationError);
    expect(setSteps).not.toHaveBeenCalled();
  });

  it('rejects a config that OMITS a mandatory step', async () => {
    const service = makeService();
    const steps = DEFAULT_STEPS.filter((s) => s.slug !== 'document');

    await expect(service.updateKycConfig(steps)).rejects.toBeInstanceOf(ValidationError);
    expect(setSteps).not.toHaveBeenCalled();
  });

  it('names which steps are missing, so the caller can fix it', async () => {
    const service = makeService();
    const steps = DEFAULT_STEPS.filter((s) => s.slug !== 'selfie' && s.slug !== 'address');

    await expect(service.updateKycConfig(steps)).rejects.toThrow(
      /selfie.*address|address.*selfie/s,
    );
  });

  it('still allows removing a NON-mandatory step', async () => {
    const service = makeService();
    const steps = DEFAULT_STEPS.filter((s) => s.slug !== 'review');

    await service.updateKycConfig(steps);

    // 'review' is configurable; the four mandated slugs are not.
    expect(setSteps).toHaveBeenCalledTimes(1);
  });

  it.each([...MANDATORY_KYC_SLUGS])('protects the %s step specifically', async (slug) => {
    const service = makeService();
    const steps = DEFAULT_STEPS.filter((s) => s.slug !== slug);

    await expect(service.updateKycConfig(steps)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('deleting a single step', () => {
  it('refuses to delete a mandatory step', async () => {
    const service = makeService();

    await expect(service.deleteKycStep('step-document')).rejects.toBeInstanceOf(ValidationError);
    expect(deleteStep).not.toHaveBeenCalled();
  });

  it('deletes a custom step', async () => {
    const service = makeService([...DEFAULT_STEPS, step('proof-of-income')]);

    await service.deleteKycStep('step-proof-of-income');

    expect(deleteStep).toHaveBeenCalledWith('step-proof-of-income');
  });

  it('leaves an unknown id to the store, which reports not-found', async () => {
    const service = makeService();
    deleteStep.mockResolvedValue(false);

    await expect(service.deleteKycStep('step-nope')).resolves.toBe(false);
  });
});

describe('patching a single step', () => {
  it('refuses to disable a mandatory step', async () => {
    const service = makeService();

    await expect(service.updateKycStep('step-selfie', { enabled: false })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(updateStep).not.toHaveBeenCalled();
  });

  it('refuses to re-slug a mandatory step', async () => {
    const service = makeService();

    // The portal submits by slug, so renaming one is removal by another route.
    await expect(
      service.updateKycStep('step-personal', { slug: 'profile' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(updateStep).not.toHaveBeenCalled();
  });

  it('allows cosmetic edits to a mandatory step', async () => {
    const service = makeService();

    // Retitling or re-describing a required step is fine — only its existence,
    // enabled state and slug are fixed.
    await service.updateKycStep('step-personal', { title: 'Your details' });

    expect(updateStep).toHaveBeenCalledWith('step-personal', { title: 'Your details' });
  });

  it('allows disabling a custom step', async () => {
    const service = makeService([...DEFAULT_STEPS, step('proof-of-income')]);

    await service.updateKycStep('step-proof-of-income', { enabled: false });

    expect(updateStep).toHaveBeenCalledTimes(1);
  });
});
