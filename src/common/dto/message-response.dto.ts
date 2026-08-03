import { ApiProperty } from '@nestjs/swagger';

/**
 * `{ message }` — the shape of every "it worked, nothing to return" response.
 *
 * Lives in common/ because two modules declared their own class with this name.
 * Swagger keys schemas by class name, so duplicates silently overwrite each other
 * in /api/docs-json and whichever module happened to be registered last won.
 */
export class MessageResponseDto {
  @ApiProperty({ example: 'Logged out.' }) message: string;
}
