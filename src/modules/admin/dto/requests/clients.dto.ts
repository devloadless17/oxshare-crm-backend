import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

// Request DTO for the client list actions.
// See the note in ./auth.dto.ts for why this moved out of the controller.

const CLIENT_STATUSES = ['active', 'suspended'] as const;

export class ClientStatusDto {
  @ApiProperty({
    enum: CLIENT_STATUSES,
    description: 'Suspending blocks sign-in but preserves the client and their ledger history.',
  })
  @IsIn(CLIENT_STATUSES)
  status: (typeof CLIENT_STATUSES)[number];
}
