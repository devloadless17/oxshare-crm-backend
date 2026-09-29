import { ApiProperty } from '@nestjs/swagger';
import { NoClientFields } from '../../../../common/security/client-field.decorator';

/** What the MT5 bridge reads from the CRM once a minute (Settings → Scheduled jobs, 0167). */
@NoClientFields('job timings for the MT5 bridge; no client data')
export class BridgeJobSettingsDto {
  @ApiProperty({
    example: 300,
    description: 'Seconds between the bridge deal sweeps (and its balance sync rounds).',
  })
  sweepIntervalSeconds: number;
}
