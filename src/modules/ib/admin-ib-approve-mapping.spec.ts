import { describe, expect, it, vi } from 'vitest';
import { AdminIbController } from './admin-ib.controller';
import type { IbApplicationsService } from './ib-applications.service';

/**
 * The approve route's MAPPING, pinned — because it is where this feature
 * actually broke while every service spec stayed green.
 *
 * To `IbApplicationsService.approve`, `parentIbUserId: undefined` means "the
 * reviewer did not say" (the introducer recorded at registration becomes the
 * parent) and `null` is an explicit "root them". The controller coalesced an
 * omitted field to null, so every partner approved through the console was
 * rooted: no tree edge, level 1 for everyone, and a chain-full guard that
 * never ran because there was never a parent to check. The service specs call
 * the service directly and never saw it.
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

  it('passes an OMITTED parent through as undefined — the inherit instruction', async () => {
    const { approve, controller, req } = harness();

    await controller.approve(req, APPLICATION, {});

    expect(approve).toHaveBeenCalledWith(
      APPLICATION,
      req.admin,
      req.admin.clientScope,
      expect.objectContaining({ parentIbUserId: undefined }),
    );
  });

  it('passes an EXPLICIT null through — the root-them instruction', async () => {
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
