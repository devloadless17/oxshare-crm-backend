import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

// Request DTOs for role and admin-user management.
// See the note in ./auth.dto.ts for why these moved out of the controller.
//
// Permission keys are validated against the catalog in config/permissions.json by
// AdminRbacService, not here: the set is data, and a decorator cannot see it. The
// service also enforces the anti-escalation invariant (an admin may not grant a
// permission it does not itself hold) — a missing `await` on that check shipped
// once, which is why test/rbac.spec.ts exists.

export class RoleDto {
  @ApiProperty({ example: 'KYC Reviewer' })
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    type: [String],
    example: ['kyc.view', 'kyc.review'],
    description: 'Permission keys from GET /admin/permissions.',
  })
  @IsArray()
  permissions: string[];
}

export class UpdateRoleDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsOptional()
  permissions?: string[];
}

export class UpdateAdminDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: 'Reassign to an existing role.' })
  @IsString()
  @IsOptional()
  roleId?: string;

  @ApiPropertyOptional({ type: [String], description: 'Direct permission grants.' })
  @IsArray()
  @IsOptional()
  permissions?: string[];
}
