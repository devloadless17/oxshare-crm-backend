import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/* ── Requests ─────────────────────────────────────────────────────────────── */

export class AssistantAskDto {
  @ApiPropertyOptional({
    description: 'Continue this conversation; omit to start a new one.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  question!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      "The client's id for this question, reused by its retries: a question already received is refused (409 ASSISTANT_DUPLICATE), never asked twice.",
  })
  @IsOptional()
  @IsUUID()
  requestId?: string;
}

export const FEEDBACK_REASONS = ['wrong', 'not_helpful', 'off_topic', 'other'] as const;

export class AssistantFeedbackDto {
  @ApiProperty({
    enum: [1, -1],
    nullable: true,
    description: '1 helpful, -1 not helpful, null clears it.',
  })
  @IsOptional()
  @IsIn([1, -1, null])
  rating!: 1 | -1 | null;

  @ApiPropertyOptional({ enum: FEEDBACK_REASONS, description: 'Why it was not helpful.' })
  @IsOptional()
  @IsIn(FEEDBACK_REASONS)
  reason?: (typeof FEEDBACK_REASONS)[number];
}

export class UpdateAssistantSettingsDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;

  @ApiProperty({
    minimum: 1,
    maximum: 1000,
    description: 'Answers one client may get per UTC day.',
  })
  @IsInt()
  @Min(1)
  @Max(1000)
  dailyMessageLimit!: number;

  @ApiProperty({
    minimum: 1,
    maximum: 10000000,
    description: 'Answers the whole platform may give per UTC day: the spend ceiling.',
  })
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  globalDailyMessageLimit!: number;
}

/* ── Responses ────────────────────────────────────────────────────────────── */

export class AssistantConfigDto {
  @ApiProperty() available!: boolean;

  @ApiProperty({
    enum: ['not_configured', 'disabled', 'kyc_required'],
    nullable: true,
    description:
      'Why it is unavailable. `kyc_required` shows a locked launcher; the others hide it.',
  })
  reason!: 'not_configured' | 'disabled' | 'kyc_required' | null;

  @ApiProperty() dailyLimit!: number;
  @ApiProperty() usedToday!: number;
  @ApiProperty({ format: 'date-time' }) resetsAt!: string;
  @ApiProperty() maxQuestionLength!: number;
}

export class AssistantConversationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) lastMessageAt!: string;
}

export class AssistantConversationListDto {
  @ApiProperty({ type: [AssistantConversationDto] }) items!: AssistantConversationDto[];
}

export class AssistantMessageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['user', 'assistant'] }) role!: 'user' | 'assistant';
  @ApiProperty() content!: string;

  @ApiProperty({
    enum: ['streaming', 'complete', 'aborted', 'failed', 'refused', 'interrupted'],
  })
  status!: 'streaming' | 'complete' | 'aborted' | 'failed' | 'refused' | 'interrupted';

  @ApiProperty({ type: [String] }) followups!: string[];
  @ApiProperty({ enum: [1, -1], nullable: true }) feedback!: 1 | -1 | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class AssistantThreadDto {
  @ApiProperty({ type: AssistantConversationDto }) conversation!: AssistantConversationDto;
  @ApiProperty({ type: [AssistantMessageDto] }) messages!: AssistantMessageDto[];
}

@NoClientFields("platform-wide counts of the assistant's answers and tokens, about no client")
export class AssistantUsageDto {
  @ApiProperty() answers!: number;
  @ApiProperty() inputTokens!: number;
  @ApiProperty() cachedTokens!: number;
  @ApiProperty() outputTokens!: number;
}

@NoClientFields("the assistant's platform switch and limits, about no client")
export class AdminAssistantSettingsDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty() dailyMessageLimit!: number;
  @ApiProperty() globalDailyMessageLimit!: number;
  @ApiProperty({ description: 'False when OPENAI_API_KEY is not set: the assistant stays off.' })
  keyConfigured!: boolean;
  @ApiProperty() model!: string;
  @ApiProperty({ type: AssistantUsageDto, description: 'Since midnight UTC.' })
  today!: AssistantUsageDto;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) updatedAt!: string | null;
}
