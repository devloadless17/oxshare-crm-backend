import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

// Request DTOs for the admin auth + invite surface.
//
// These were declared inline inside admin.controller.ts. Two problems with that:
// the controller grew to 717 lines, and — because they carried no @ApiProperty —
// every one of them generated into /api/docs-json as `Record<string, never>`.
// The admin app therefore hand-wrote the request shapes it sends, which is the
// exact drift the generated types exist to prevent (API-CONTRACTS Part C).
//
// class-validator decorators are paired with @ApiProperty on every field, per
// modules/identity/dto/auth.dto.ts. The global ValidationPipe can only validate
// a @Body() that has a DTO *class* to reflect on, so these are load-bearing for
// input validation as well as for documentation.

export class AdminLoginDto {
  @ApiProperty({ example: 'admin@oxshare.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'admin123' })
  @IsString()
  password: string;
}

export class InviteDto {
  @ApiProperty({ example: 'new.admin@oxshare.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'Jane Doe' })
  @IsString()
  name: string;

  /** Assign an existing role. Mutually exclusive in practice with `permissions`. */
  @ApiPropertyOptional({ description: 'Existing role id to assign on acceptance.' })
  @IsString()
  @IsOptional()
  roleId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Explicit permission keys, when not assigning a role.',
  })
  @IsArray()
  @IsOptional()
  permissions?: string[];
}

export class AcceptInviteDto {
  @ApiProperty({ description: 'Single-use token from the invitation email.' })
  @IsString()
  token: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;
}
