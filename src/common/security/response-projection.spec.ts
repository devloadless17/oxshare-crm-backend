import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { projectByShape } from './response-projection';

/*
 * Shapes declared exactly as the real DTOs declare them — `@ApiProperty` is
 * both what Swagger publishes and what the projection reads, so a test shape
 * built any other way would test a different mechanism.
 */

class AccountDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty({ type: [String] }) maskedFields: string[];
}

class TagDto {
  @ApiProperty() id: string;
  @ApiProperty() label: string;
}

class ProfileDto {
  @ApiProperty() id: string;
  @ApiProperty({ type: TagDto }) primaryTag: TagDto;
  @ApiProperty({ type: [TagDto] }) tags: TagDto[];
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  details?: Record<string, unknown>;
  @ApiProperty() createdAt: Date;
}

class BaseDto {
  @ApiProperty() id: string;
}
class ChildDto extends BaseDto {
  @ApiProperty() name: string;
}

class Undecorated {
  id!: string;
}

describe('projectByShape', () => {
  it('removes the referrer leak: a raw row answered under an account shape', () => {
    const row = {
      id: 'u-1',
      email: 'a@b.test',
      maskedFields: [],
      passwordHash: '$2b$12$secret',
      passwordResetTokenHash: 'abc',
    };
    const { value, undeclared } = projectByShape(AccountDto, row);

    expect(value).toEqual({ id: 'u-1', email: 'a@b.test', maskedFields: [] });
    expect(undeclared.sort()).toEqual(['passwordHash', 'passwordResetTokenHash']);
    // Non-mutating: the row may be shared with an audit write.
    expect(row).toHaveProperty('passwordHash');
  });

  it('returns the SAME object when everything is declared — the common path costs no copy', () => {
    const body = { id: 'u-1', email: 'a@b.test', maskedFields: [] };
    const { value, undeclared } = projectByShape(AccountDto, body);
    expect(value).toBe(body);
    expect(undeclared).toEqual([]);
  });

  it('walks nested shapes and arrays, naming where each stray key was', () => {
    const { value, undeclared } = projectByShape(ProfileDto, {
      id: 'p-1',
      primaryTag: { id: 't-1', label: 'A', internal: true },
      tags: [
        { id: 't-1', label: 'A' },
        { id: 't-2', label: 'B', assignedBy: 'admin-uuid' },
      ],
      createdAt: new Date('2026-09-28T00:00:00Z'),
    });

    expect(undeclared.sort()).toEqual(['primaryTag.internal', 'tags[].assignedBy']);
    expect(value).toEqual({
      id: 'p-1',
      primaryTag: { id: 't-1', label: 'A' },
      tags: [
        { id: 't-1', label: 'A' },
        { id: 't-2', label: 'B' },
      ],
      createdAt: new Date('2026-09-28T00:00:00Z'),
    });
  });

  it('passes a declared free-form map through whole — its keys are data, not shape', () => {
    const details = { anything: 1, nested: { deeper: true } };
    const { value, undeclared } = projectByShape(ProfileDto, {
      id: 'p-1',
      primaryTag: { id: 't', label: 'l' },
      tags: [],
      details,
      createdAt: new Date(),
    });
    expect(undeclared).toEqual([]);
    expect((value as { details: unknown }).details).toBe(details);
  });

  it('keeps properties a shape inherits from its parent', () => {
    const { value, undeclared } = projectByShape(ChildDto, { id: 'c-1', name: 'n', extra: 1 });
    expect(value).toEqual({ id: 'c-1', name: 'n' });
    expect(undeclared).toEqual(['extra']);
  });

  it('projects every element of a top-level array', () => {
    const { value, undeclared } = projectByShape(TagDto, [
      { id: 't-1', label: 'A', leak: 1 },
      { id: 't-2', label: 'B' },
    ]);
    expect(value).toEqual([
      { id: 't-1', label: 'A' },
      { id: 't-2', label: 'B' },
    ]);
    expect(undeclared).toEqual(['[].leak']);
  });

  it('leaves a class with no declared properties alone — there is nothing to hold it to', () => {
    const body = { id: 'x', anything: 'else' };
    const { value, undeclared } = projectByShape(Undecorated, body);
    expect(value).toBe(body);
    expect(undeclared).toEqual([]);
  });

  it('passes primitives, null and undefined through', () => {
    expect(projectByShape(AccountDto, null).value).toBeNull();
    expect(projectByShape(AccountDto, undefined).value).toBeUndefined();
    expect(projectByShape(AccountDto, 'text').value).toBe('text');
  });
});
