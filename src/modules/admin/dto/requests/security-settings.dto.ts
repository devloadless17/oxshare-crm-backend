import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetSecuritySwitchDto {
  @ApiProperty({
    description:
      'Whether the control is in force. Turning one OFF is audited and alerted — see ' +
      'AdminSecuritySettingsController.',
  })
  @IsBoolean()
  enabled: boolean;
}

/** One security control, as the admin screen sees it. */
export class SecuritySwitchDto {
  @ApiProperty({ example: 'withdrawal_otp', description: 'Stable machine key. Never renamed.' })
  key: string;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty({ example: 'Email confirmation code on every client withdrawal' })
  label: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The admin who last changed it. Null while it has never been changed.',
  })
  updatedBy: string | null;

  @ApiProperty()
  updatedAt: Date;
}
