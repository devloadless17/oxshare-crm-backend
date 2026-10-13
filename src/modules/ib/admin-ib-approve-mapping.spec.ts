import { describe, expect, it, vi } from 'vitest';
import { AdminIbController } from './admin-ib.controller';
import type { IbApplicationsService } from './ib-applications.service';

/**
 * The approve route's MAPPING, pinned — because it is where this feature once
 * broke while every service spec stayed green (the controller rewrote an
 * omitted parent before the service could read it).
 *
 * Since 13 Oct 2026 an omitted parent and `null` both make a main partner
 * (level 1), and only a NAMED parent makes a sub-partner. The controller must
 * still hand the reviewer's choice through untouched, so the service is the
 * one place that decides what each means.
 */
describe('AdminIbController approve mapping', () => {
  const APPLICATION = '5b1c4a48-9adc-4a06-8f28-0e6f7ffbe001';
  const PARENT = 1000002;

  function harness() {
    const approve = vi.fn().mockResolvedValue({});
    // The account as the reader may see it (802bf3a) — not what this spec is about.
    const accountViewFor = vi.fn().mockResolvedValue({});
    const controller = new AdminIbController(
      { approve, accountViewFor } as unknown as IbApplicationsService,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const req = {
      admin: { id: 'reviewer', clientScope: null },
    } as unknown as Parameters<AdminIbController['approve']>[0];
    return { approve, controller, req };
  }

  it('passes an OMITTED parent through as undefined', async () => {
    const { approve, controller, req } = harness();

    await controller.approve(req, APPLICATION, {});

    expect(approve).toHaveBeenCalledWith(
      APPLICATION,
      req.admin,
      req.admin.clientScope,
      expect.objectContaining({ parentIbUserId: undefined }),
    );
  });

  it('passes an EXPLICIT null through', async () => {
    const { approve, controller, req } = harness();

    await controller.approve(req, APPLICATION, {
      parentIbUserId: null,
    });

    expect(approve).toHaveBeenCalledWith(
      APPLICATION,
      req.admin,
      req.admin.clientScope,
      expect.objectContaining({ parentIbUserId: null }),
    );
  });

  it('passes a chosen parent through untouched', async () => {
    const { approve, controller, req } = harness();

    await controller.approve(req, APPLICATION, {
      parentIbUserId: PARENT,
    });

    expect(approve).toHaveBeenCalledWith(
      APPLICATION,
      req.admin,
      req.admin.clientScope,
      expect.objectContaining({ parentIbUserId: PARENT }),
    );
  });
});
