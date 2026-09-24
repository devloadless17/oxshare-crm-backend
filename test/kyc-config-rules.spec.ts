import { ALL_PERMISSIONS } from './support/all-permissions';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AdminComplianceService } from '../src/modules/admin/admin-compliance.service';
import { MANDATORY_KYC_SLUGS, type KycStepConfig } from '../src/store/kyc-config.store';

/**
 * THE KYC FLOW IS FULLY CONFIGURABLE. Nothing is undeletable.
 *
 * `personal`, `document`, `selfie` and `address` were mandatory here, citing
 * FR-CORE-15/FR-IND-03 — a config that disabled or omitted one was a 400, and
 * so was deleting or re-slugging it.
 *
 * The owner retired the rule on 15 Aug 2026, and the objection was sound: a KYC
 * flow sold as configurable that refuses to drop four of its steps is not
 * configurable, and which documents a jurisdiction demands is the broker's
 * decision, not this service's. Encoding one regulator's answer made every
 * other answer unreachable without a code change.
 *
 * WHAT REPLACES IT is the audit trail. `kyc_config.replace` records the full
 * slug list and the enabled subset on every save, so "onboarding stopped asking
 * for proof of address on the 12th" has a name and a date attached — a stronger
 * compliance artefact than a block that could only assert the step was never
 * removed.
 *
 * This file now pins the UNLOCK, so a future "safety" patch reinstating the
 * guard has to argue with these cases first.
 *
 * No database here: these assertions are about the service, so the store is a
 * fake. The §11 money specs are where Testcontainers earns its cost.
 */

/**
 * What each built-in step exists to collect — a document to choose on the two
 * document steps, the camera on the selfie step. Without them the flow is one
 * no client could finish, which the builder now refuses to save
 * (`assertFieldsFitTheirStep`); these cases are about which steps exist, so
 * each carries its core.
 */
const CORE: Record<string, KycStepConfig['fields']> = {
  personal: [
    { id: 'f-first', name: 'firstName', label: 'First Name', type: 'text', required: true },
  ],
  document: [
    { id: 'f-pp', name: 'passport', label: 'Passport', type: 'doc:passport', required: false },
  ],
  selfie: [{ id: 'f-selfie', name: 'selfie', label: 'Selfie', type: 'camera', required: true }],
  address: [
    {
      id: 'f-bill',
      name: 'utilityBill',
      label: 'Utility Bill',
      type: 'doc:utility_bill',
      required: false,
    },
  ],
};

function step(slug: string, over: Partial<KycStepConfig> = {}): KycStepConfig {
  return {
    id: `step-${slug}`,
    stepNumber: 1,
    slug,
    title: slug.charAt(0).toUpperCase() + slug.slice(1),
    description: '',
    icon: 'User',
    enabled: true,
    fields: CORE[slug] ?? [],
    ...over,
  };
}

const DEFAULT_STEPS = [...MANDATORY_KYC_SLUGS.map((s) => step(s)), step('review')];

const setSteps = vi.fn();
const updateStep = vi.fn();
const deleteStep = vi.fn();
const getSteps = vi.fn();

/** These config routes are now audited, so they take an acting admin. */
const ACTOR = { id: 'admin-1', email: 'admin@oxshare.com', permissions: ALL_PERMISSIONS } as never;

function makeService(steps: KycStepConfig[] = DEFAULT_STEPS) {
  getSteps.mockResolvedValue(steps);
  const kycConfig = { setSteps, updateStep, deleteStep, getSteps };
  return new AdminComplianceService(
    {} as never, // KycService — unused on these paths
    kycConfig as never,
    {} as never, // RejectionReasonsStore
    { record: () => undefined } as never, // AdminAuditService
    // ClientVisibilityService — unused on these paths: the KYC form
    // CONFIGURATION is a schema, not anybody's submission, so there is no
    // client row to scope.
    {} as never,
    // The admins store, for resolving a claim holder's name.
    {} as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setSteps.mockResolvedValue(DEFAULT_STEPS);
  updateStep.mockResolvedValue(undefined);
  deleteStep.mockResolvedValue(true);
});

describe('replacing the whole KYC configuration', () => {
  it('accepts a config with every step enabled', async () => {
    const service = makeService();
    await service.updateKycConfig(DEFAULT_STEPS, ACTOR);
    expect(setSteps).toHaveBeenCalledWith(DEFAULT_STEPS);
  });

  it('accepts a config that DISABLES a formerly-mandatory step', async () => {
    const service = makeService();
    const steps = DEFAULT_STEPS.map((s) => (s.slug === 'address' ? { ...s, enabled: false } : s));

    await service.updateKycConfig(steps, ACTOR);
    expect(setSteps).toHaveBeenCalledWith(steps);
  });

  it('accepts a config that OMITS a formerly-mandatory step entirely', async () => {
    const service = makeService();
    const steps = DEFAULT_STEPS.filter((s) => s.slug !== 'selfie');

    await service.updateKycConfig(steps, ACTOR);
    expect(setSteps).toHaveBeenCalledWith(steps);
  });

  it('accepts an EMPTY flow — the broker may ask for nothing at all', async () => {
    // The extreme case, stated deliberately. If any step were still secretly
    // required, this is the call that would reveal it.
    const service = makeService();
    await service.updateKycConfig([], ACTOR);
    expect(setSteps).toHaveBeenCalledWith([]);
  });

  it('records the enabled slugs, which is now the compliance record', async () => {
    const record = vi.fn();
    getSteps.mockResolvedValue(DEFAULT_STEPS);
    const service = new AdminComplianceService(
      {} as never,
      { setSteps, updateStep, deleteStep, getSteps } as never,
      {} as never,
      { record } as never,
      {} as never,
      // The admins store, for resolving a claim holder's name.
      {} as never,
    );
    const steps = DEFAULT_STEPS.map((s) => (s.slug === 'address' ? { ...s, enabled: false } : s));

    await service.updateKycConfig(steps, ACTOR);

    /*
     * The block is gone, so THIS is what answers "when did onboarding stop
     * asking for proof of address, and who decided". Losing it would leave the
     * unlock with no control behind it at all.
     */
    expect(record).toHaveBeenCalledWith(
      'admin-1',
      'kyc_config.replace',
      'kyc_config',
      'steps',
      expect.objectContaining({ enabled: expect.not.arrayContaining(['address']) }),
    );
  });
});

describe('deleting a single step', () => {
  it('deletes a formerly-mandatory step', async () => {
    const service = makeService();
    await service.deleteKycStep('step-document', ACTOR);
    expect(deleteStep).toHaveBeenCalledWith('step-document');
  });

  it('deletes a custom step', async () => {
    const service = makeService();
    await service.deleteKycStep('step-review', ACTOR);
    expect(deleteStep).toHaveBeenCalledWith('step-review');
  });

  it('passes the store not-found result through rather than throwing', async () => {
    // The service does not invent a 404 — it returns what the store reports and
    // the controller maps it. Asserted so a refactor that starts throwing here
    // has to update the controller in the same change.
    deleteStep.mockResolvedValue(false);
    const service = makeService();
    await expect(service.deleteKycStep('step-nope', ACTOR)).resolves.toBe(false);
  });
});

describe('patching a single step', () => {
  it('disables a formerly-mandatory step', async () => {
    const service = makeService();
    await service.updateKycStep('step-selfie', { enabled: false }, ACTOR);
    expect(updateStep).toHaveBeenCalledWith('step-selfie', { enabled: false });
  });

  it('re-slugs a formerly-mandatory step', async () => {
    /*
     * The portal branches on slug for its uploader, camera and passport paths,
     * so renaming one changes which special handling that step gets. That is
     * now the operator's call — the API states what it was asked to do and the
     * audit row records it.
     */
    const service = makeService();
    await service.updateKycStep('step-personal', { slug: 'profile' }, ACTOR);
    expect(updateStep).toHaveBeenCalledWith('step-personal', { slug: 'profile' });
  });

  it('refuses to re-slug a document step while it still holds documents', async () => {
    /*
     * Renaming Proof of Address makes it a step the broker ADDED, holding a
     * utility bill — the configuration the builder no longer offers, because a
     * document has no home there (reported from local testing, 25 Sep 2026).
     */
    const service = makeService();
    await expect(
      service.updateKycStep('step-address', { slug: 'residence' }, ACTOR),
    ).rejects.toThrow(/Utility Bill.*document type/);
    expect(updateStep).not.toHaveBeenCalled();
  });

  it('allows cosmetic edits, as it always did', async () => {
    const service = makeService();
    await service.updateKycStep('step-personal', { title: 'About you' }, ACTOR);
    expect(updateStep).toHaveBeenCalledWith('step-personal', { title: 'About you' });
  });
});
