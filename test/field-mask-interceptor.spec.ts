import { describe, expect, it } from 'vitest';
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger';
import { of, lastValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { ClientField } from '../src/common/security/client-field.decorator';
import { FieldMaskInterceptor } from '../src/common/security/field-mask.interceptor';

/**
 * THE WIRING, which is the half that closes the defect class.
 *
 * Marking a field on its DTO fixes the arithmetic of masking. It does not fix
 * the failure mode: if the decision to mask is still a hand-written call per
 * surface, the class survives the migration intact — moved from `applyMask` to
 * `maskByShape`, same opt-in, same forgetting.
 *
 * What these assert is that the call is gone. Nothing below names a surface. The
 * only question the interceptor asks is whether the request carried an ADMIN
 * principal, which `AdminGuard` answers on every route without being asked.
 *
 * The portal case is not hypothetical: exposure 8 turned on it. The identity
 * projections in `ib-overview.service.ts` are the same shape as the admin one
 * and are CORRECTLY unmasked, because a partner is reading their own network
 * and an administrator's field mask has no standing there.
 */

class OwnerDto {
  @ApiProperty() id: string = '';
  @ClientField('client.email') @ApiProperty() email: string = '';
  @ApiProperty() firstName: string = '';
}

class RowDto {
  @ApiProperty() id: string = '';
  @ApiProperty({ type: OwnerDto }) user: OwnerDto = new OwnerDto();
}

class Controller {
  @ApiOkResponse({ type: RowDto })
  declared(): unknown {
    return undefined;
  }

  /** No `@ApiOkResponse` — the blind spot, asserted rather than assumed. */
  undeclared(): unknown {
    return undefined;
  }
}

interface ResponseShape {
  id: string;
  user: { id: string; email?: string; firstName?: string };
}

const ROW = (): ResponseShape => ({
  id: 'w1',
  user: { id: 'u1', email: 'a@x.test', firstName: 'Alpha' },
});

function contextFor(handlerName: 'declared' | 'undeclared', request: unknown): ExecutionContext {
  /*
   * The handler is read as a METADATA CARRIER and never called — the
   * interceptor asks it what `@ApiOkResponse` it declares. `unbound-method`
   * guards against losing `this` when a method is passed around to be invoked,
   * which is exactly what does not happen here.
   */
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const handler = Controller.prototype[handlerName];
  return {
    getType: () => 'http',
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const handlerReturning = (body: unknown): CallHandler => ({ handle: () => of(body) });

async function run(
  handlerName: 'declared' | 'undeclared',
  request: unknown,
  body: unknown,
): Promise<ResponseShape> {
  const result: unknown = await lastValueFrom(
    new FieldMaskInterceptor().intercept(contextFor(handlerName, request), handlerReturning(body)),
  );
  return result as ResponseShape;
}

const MASKED_ADMIN = { admin: { fieldMask: ['client.email'] } };

describe('the field-mask interceptor', () => {
  it('masks an ADMIN response with no call at the surface', () => {
    /*
     * The whole claim. `RowDto` is never mentioned by the interceptor, no
     * service was involved, and nothing here opted in — the response is masked
     * because the request carried an administrator who hides that field.
     */
    return run('declared', MASKED_ADMIN, ROW()).then((masked) => {
      expect('email' in masked.user).toBe(false);
      // Non-vacuous: it is a mask, not an emptied response.
      expect(masked.user.firstName).toBe('Alpha');
      expect(masked.id).toBe('w1');
    });
  });

  it('leaves a PORTAL response alone, on the same shape', async () => {
    /*
     * Exposure 8's lesson, pinned. A partner reading their own network reaches
     * the same DTO through a controller that never sets `req.admin`. The portal
     * is not on an exemption list — it is structurally outside, because it
     * carries no admin principal at all.
     */
    const body = ROW();
    const passed = await run('declared', { user: { id: 'u1' } }, body);

    expect(passed).toBe(body);
    expect(passed.user.email).toBe('a@x.test');
  });

  it('leaves an UNMASKED administrator alone', async () => {
    const body = ROW();
    expect(await run('declared', { admin: { fieldMask: [] } }, body)).toBe(body);
  });

  it('cannot mask a response whose shape is undeclared, and says so here', async () => {
    /*
     * Asserted so it is a known property rather than a surprise found later.
     * This is exactly the blind spot that hid two of the nine exposures, and it
     * is why `response-shape-coverage.spec.ts` exists to stop the undeclared set
     * growing. A route without a DTO is not protected by this mechanism.
     */
    const body = ROW();
    const passed = await run('undeclared', MASKED_ADMIN, body);

    expect(passed).toBe(body);
    expect(passed.user.email).toBe('a@x.test');
  });

  it('is a NO-OP for a field nobody has marked yet', async () => {
    /*
     * The property that makes it safe to wire before a single surface is
     * migrated: an administrator hiding `client.phone`, which no DTO field
     * carries `@ClientField('client.phone')` for, gets the response untouched.
     * `applyMask` keeps doing the work; this does nothing until a field says so.
     */
    const body = ROW();
    const passed = await run('declared', { admin: { fieldMask: ['client.phone'] } }, body);

    expect(passed).toBe(body);
    expect(passed.user.email).toBe('a@x.test');
  });
});
