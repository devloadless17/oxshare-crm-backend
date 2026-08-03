import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsString } from 'class-validator';

// Request DTOs for the client-facing KYC surface.
//
// These are new, not moved: `POST /kyc/step` and `POST /kyc/upload` took a
// `@Body()` typed as an inline object literal and a bare `@Body('field')`
// string. The global ValidationPipe can only validate a body it can reflect a
// DTO *class* off, so both routes were completely unvalidated — `{}` reached
// `kyc.saveStep(userId, undefined, undefined)`.

export class SaveKycStepDto {
  /**
   * The step slug from `GET /kyc/config`, e.g. 'personal' | 'document' |
   * 'selfie' | 'address'. Validated as a non-empty string rather than an enum
   * because the step set is configurable data (the admin KYC builder can add
   * custom steps), so a hardcoded enum here would reject a valid new step.
   */
  @ApiProperty({ example: 'personal' })
  @IsString()
  @IsNotEmpty()
  step: string;

  /**
   * Field values for the step, keyed by the field `name`s in the step config.
   *
   * `@IsObject()` matters beyond documentation: with `whitelist: true` the pipe
   * strips properties that carry no validation decorator, so an undecorated
   * `data` would arrive as `undefined` and silently save an empty step.
   */
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { firstName: 'John', lastName: 'Doe' },
  })
  @IsObject()
  data: Record<string, unknown>;
}

export class UploadKycFileDto {
  @ApiProperty({
    description: 'Which slot this file fills.',
    example: 'doc_front',
  })
  @IsString()
  @IsNotEmpty()
  field: string;
}
