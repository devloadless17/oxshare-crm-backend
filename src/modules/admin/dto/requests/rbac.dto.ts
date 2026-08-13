import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

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

  /**
   * RBAC-03: client fields holders of this role may not see.
   *
   * On the ROLE because masking is a property of the JOB — "support agents do
   * not see phone numbers" is the same kind of statement as "support agents
   * cannot approve withdrawals", and belongs beside it. Per-person exceptions
   * go on the admin (`UpdateAdminDto.maskedFields`), which inherits from here
   * by default.
   */
  @ApiPropertyOptional({
    type: [String],
    example: ['client.phone', 'client.email'],
    description: 'Field keys from GET /admin/client-fields. Empty means nothing is hidden.',
  })
  @IsArray()
  @IsOptional()
  maskedFields?: string[];
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

  /** RBAC-03 — see `RoleDto.maskedFields`. */
  @ApiPropertyOptional({
    type: [String],
    description: 'Field keys from GET /admin/client-fields. Empty means nothing is hidden.',
  })
  @IsArray()
  @IsOptional()
  maskedFields?: string[];
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

  /**
   * RBAC-03 per-person mask OVERRIDE. Keys from `GET /admin/client-fields`.
   *
   * Three distinct values, and the difference matters:
   *   - omitted → do not touch this admin's mask;
   *   - `null`  → clear the override, go back to inheriting the role;
   *   - `[]`    → explicitly mask nothing for this person, ignoring the role.
   *
   * Nullable rather than merely optional because "inherit the role" is the
   * common case and has to be expressible, not just the initial state.
   */
  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    description:
      'Client fields this administrator may not see. null clears the override and inherits ' +
      'the role; [] explicitly masks nothing.',
  })
  @IsArray()
  @IsOptional()
  maskedFields?: string[] | null;

  /**
   * RBAC-03 territory: the client tags this administrator may see.
   *
   * An EMPTY ARRAY MEANS UNRESTRICTED, not "sees nothing" — the RBAC-08 / D-10
   * precedent, so a deploy cannot blind every existing sub-admin. Any screen
   * offering this control has to say so in words; it is not inferable.
   */
  @ApiPropertyOptional({
    type: [String],
    description:
      'Client tag ids. An EMPTY ARRAY means unrestricted (every client), not none — see D-10.',
  })
  @IsArray()
  @IsOptional()
  scopedTagIds?: string[];

  @ApiPropertyOptional({
    description:
      'D-60 — sees the intake pool: clients with no tag assignments yet. Meaningful only for a scoped admin.',
  })
  @IsBoolean()
  @IsOptional()
  seesUntriaged?: boolean;
}

/**
 * Deliberately its OWN route and DTO rather than a `status` field on
 * UpdateAdminDto.
 *
 * Suspension carries a different permission (`users.suspend`, not `users.edit`)
 * and different invariants, and folding it into the general patch would mean one
 * endpoint whose required permission depends on which keys the body happens to
 * carry. That is the kind of guard that is correct on the day it is written and
 * wrong after the next field is added.
 */
export class AdminStatusDto {
  @ApiProperty({ enum: ['active', 'suspended'] })
  @IsIn(['active', 'suspended'])
  status: 'active' | 'suspended';
}
