import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateIbApplicationDto } from './ib-application.dto';

/**
 * The APPLY request's shape, validated the way the global ValidationPipe
 * validates it — because the pipe runs BEFORE the service, and it once
 * disagreed with it.
 *
 * `apply()` welcomes an introduced applicant with no `agencyId` (their
 * programme is inherited and the field is ignored), and the portal
 * deliberately sends `{}` for them. A bare `@IsUUID()` on the DTO refused
 * that shape at the transport edge with "agencyId must be a UUID", so every
 * client under a partner was blocked from applying by a validator the rule
 * never reached. These pin the contract from the pipe's side.
 */
describe('CreateIbApplicationDto', () => {
  it('accepts the empty shape an introduced applicant sends', async () => {
    const errors = await validate(plainToInstance(CreateIbApplicationDto, {}));
    expect(errors).toEqual([]);
  });

  it('accepts a direct applicant naming an agency', async () => {
    const errors = await validate(
      plainToInstance(CreateIbApplicationDto, {
        agencyId: '2e9b463e-7bb8-4f13-9a54-1f0a4f9c8d21',
      }),
    );
    expect(errors).toEqual([]);
  });

  /*
   * Present-but-garbage is still refused: optional relaxes ABSENCE, not shape.
   * The requirement itself lives in the service ("Choose the partner programme
   * you are applying for"), which knows whether an introducer supplies the
   * answer — the pipe cannot.
   */
  it('still refuses a value that is not a UUID', async () => {
    const errors = await validate(
      plainToInstance(CreateIbApplicationDto, { agencyId: 'agency-one' }),
    );
    expect(errors.map((e) => e.property)).toContain('agencyId');
  });
});
