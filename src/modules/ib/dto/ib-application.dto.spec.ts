import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateIbApplicationDto } from './ib-application.dto';

/**
 * The APPLY request's shape, validated the way the global ValidationPipe
 * validates it — because the pipe runs BEFORE the service, and it once
 * disagreed with it.
 *
 * The pipe checks only the SHAPE: a present `agencyId` must be a UUID. The
 * REQUIREMENT (every applicant names one since 13 Oct 2026) is the service's,
 * so a missing one is refused with "Choose the partner programme you are
 * applying for" rather than "agencyId must be a UUID".
 */
describe('CreateIbApplicationDto', () => {
  it('leaves a missing agency to the service, which words the refusal', async () => {
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
   * you are applying for").
   */
  it('still refuses a value that is not a UUID', async () => {
    const errors = await validate(
      plainToInstance(CreateIbApplicationDto, { agencyId: 'agency-one' }),
    );
    expect(errors.map((e) => e.property)).toContain('agencyId');
  });
});
