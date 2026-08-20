import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AddIpAllowlistRuleDto {
  @ApiProperty({
    description: 'IPv4 address or CIDR range. A bare address is stored as /32.',
    example: '203.0.113.0/24',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(43)
  cidr: string;

  @ApiProperty({
    description: 'Why this rule exists — an unlabelled list becomes unmaintainable.',
    example: 'Beirut office',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label: string;
}
