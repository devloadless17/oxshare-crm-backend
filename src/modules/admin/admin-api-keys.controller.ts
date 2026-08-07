import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { ApiKeysService } from './api-keys.service';
import { AuthenticatedAdmin, MasterAdminGuard } from './guards/admin.guard';
import { NotClientScoped } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';
import { CreateApiKeyDto } from './dto/requests/api-keys.dto';
import { ApiKeyDto, IssuedApiKeyDto } from './dto/responses.dto';
import type { ApiKeyListRow, ApiKeyRow } from '../../store/api-keys.store';

/**
 * Machine credentials for the admin API.
 *
 * ── MASTER ADMIN ONLY, and that is not conservatism ────────────────────────
 *
 * Issuing a key creates a credential that reaches the admin API with no login,
 * no session lifetime and no browser — and `assertGrantable` means it can carry
 * any permission its creator holds. That places it in the same category as
 * `admin-security-settings.controller.ts` and the SMTP form: powers that should
 * not be delegatable at all, because making one a permission key means somebody
 * eventually grants it to a role called "Operations".
 *
 * The anti-escalation check still runs underneath, so this is belt and braces
 * rather than the only control. A master admin issuing a key is the intended
 * path; a sub-admin issuing one is not a path at all.
 */
/*
 * `@NotClientScoped` is declared PER METHOD below, not once on the class.
 *
 * It was on the class, which reads better and does not work:
 * `client-scope-coverage.spec.ts` resolves the stance from the HANDLER's
 * metadata, so a class-level declaration is invisible to it and all three routes
 * were reported as saying nothing about client scoping. Every other controller
 * in this codebase — 104 declarations — is method-level, so this was the odd one
 * out rather than the scanner being narrow.
 *
 * Worth stating rather than silently fixing: the check is not pedantry. It is
 * the thing that notices a route reading client-owned rows without a scope
 * predicate, and a stance it cannot see is the same as no stance at all.
 */
@ApiTags('admin')
@Controller('admin/api-keys')
@UseGuards(MasterAdminGuard)
@ApiCookieAuth()
export class AdminApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @NotClientScoped('Machine credentials for the admin API; contains no client data.')
  @ApiOperation({
    summary: 'Every API key, newest first (master admin only)',
    description:
      'Includes revoked and expired keys. The secret is never returned — `prefix` is the ' +
      'non-secret leading characters, which is what makes two keys distinguishable on screen.',
  })
  @ApiOkResponse({ type: [ApiKeyDto] })
  async list(): Promise<ApiKeyDto[]> {
    const rows = await this.apiKeys.list();
    return rows.map(toDto);
  }

  /**
   * Issue a key, and return the plaintext ONCE.
   *
   * Rate limited because each call mints a standing credential: ten an hour is
   * far more than an operator configuring integrations needs, and few enough
   * that a compromised admin session cannot quietly manufacture a hundred keys
   * to survive its own revocation.
   */
  @Post()
  @NotClientScoped('Issues a machine credential; reads no client-owned rows.')
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  @ApiOperation({
    summary: 'Issue a new API key (master admin only)',
    description:
      'The response carries the plaintext key, and it is the ONLY time it is ever available: ' +
      'only a SHA-256 hash is stored, so it cannot be shown again or recovered. An admin may ' +
      'only grant permissions they hold themselves.',
  })
  @ApiCreatedResponse({ type: IssuedApiKeyDto })
  @Audited('api_key.create')
  async create(
    @Body() dto: CreateApiKeyDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ): Promise<IssuedApiKeyDto> {
    const { row, plaintext } = await this.apiKeys.create(req.admin, {
      name: dto.name,
      permissions: dto.permissions,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    });
    return { key: toDto(row), plaintext };
  }

  /**
   * Revoke a key. Immediate — the guard reads `revoked_at` on every request.
   *
   * DELETE, but the row is kept: the audit trail points at this id, and
   * "revoked last Tuesday" is what somebody investigating an incident needs.
   * Revoking an already-revoked key succeeds rather than erroring, because the
   * caller's intent is already satisfied.
   */
  @Delete(':id')
  @NotClientScoped('Revokes a machine credential; reads no client-owned rows.')
  @ApiOperation({ summary: 'Revoke an API key (master admin only)' })
  @ApiOkResponse({ type: ApiKeyDto })
  @Audited('api_key.revoke')
  async revoke(
    @Param('id') id: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ): Promise<ApiKeyDto> {
    return toDto(await this.apiKeys.revoke(req.admin, id));
  }
}

/**
 * Row to wire shape. Dates become ISO strings, and NOTHING secret is carried —
 * `secretHash` is absent from the DTO rather than filtered here, so a future
 * field added to the row cannot leak by being spread into a response.
 */
function toDto(row: ApiKeyRow | ApiKeyListRow): ApiKeyDto {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    permissions: row.permissions,
    createdByName: 'createdByName' in row ? row.createdByName : null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
