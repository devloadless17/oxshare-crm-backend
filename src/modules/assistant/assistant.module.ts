import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { IdentityModule } from '../identity/identity.module';
import { AdminAssistantController } from './admin-assistant.controller';
import { AnswerRunner } from './answer-runner';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { LLM_PROVIDER } from './llm/llm-provider';
import { OpenAiProvider } from './llm/openai.provider';
import { ASSISTANT_TOOLS, ToolRegistry, type AssistantTool } from './tools/tool-registry';

/**
 * The client portal's AI assistant (0187).
 *
 * The seams that let it grow without a rewrite are bound here:
 * - `LLM_PROVIDER`: which model answers.
 * - `ASSISTANT_TOOLS`: what it may look up. v1 binds none: it knows nothing
 *   about the client. Personal read-only tools join this list, and each reads
 *   the client from the session context and never from its arguments.
 */
@Module({
  imports: [AdminAuthModule, IdentityModule],
  controllers: [AssistantController, AdminAssistantController],
  providers: [
    AssistantService,
    AnswerRunner,
    ToolRegistry,
    { provide: LLM_PROVIDER, useClass: OpenAiProvider },
    { provide: ASSISTANT_TOOLS, useValue: [] satisfies AssistantTool[] },
  ],
})
export class AssistantModule {}
