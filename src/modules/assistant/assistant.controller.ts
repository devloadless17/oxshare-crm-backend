import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { requestLocale } from '../../common/i18n/locale';
import type { AssistantMessageRow } from '../../store/assistant.store';
import type { User } from '../../store/users.store';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { AnswerRunner, type PreparedAnswer } from './answer-runner';
import { AssistantService } from './assistant.service';
import {
  AssistantAskDto,
  AssistantConfigDto,
  AssistantConversationListDto,
  AssistantFeedbackDto,
  AssistantMessageDto,
  AssistantThreadDto,
} from './dto/assistant.dto';
import { SseAnswerSink } from './sse-answer-sink';

const STREAM_DESCRIPTION =
  'A `text/event-stream`: `meta`, then `delta` events, then `followups` and `done`, or ' +
  '`error`. Every refusal (switched off, not verified, a limit, busy) is an ordinary JSON ' +
  'error BEFORE the stream opens.';

/**
 * The portal assistant (0187). The client is always the SESSION's (R-4.4):
 * nothing here takes a client id, and a conversation that is not the
 * caller's reads exactly like one that does not exist.
 */
@ApiTags('assistant')
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@Controller('assistant')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly runner: AnswerRunner,
  ) {}

  @Get('config')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Whether the assistant is available to this client, and their allowance',
    description:
      'Never refuses: an unverified client gets `available: false, reason: "kyc_required"`, so ' +
      'the portal can show a locked launcher instead of an error.',
  })
  @ApiOkResponse({ type: AssistantConfigDto })
  async config(@Req() req: Request & { user: User }): Promise<AssistantConfigDto> {
    const view = await this.assistant.config(req.user.id);
    return { ...view, resetsAt: view.resetsAt.toISOString() };
  }

  @Get('conversations')
  @ApiCookieAuth()
  @ApiOperation({ summary: "The client's recent conversations, newest first" })
  @ApiOkResponse({ type: AssistantConversationListDto })
  async list(@Req() req: Request & { user: User }): Promise<AssistantConversationListDto> {
    const rows = await this.assistant.listConversations(req.user.id);
    return {
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt.toISOString(),
        lastMessageAt: row.lastMessageAt.toISOString(),
      })),
    };
  }

  @Get('conversations/:id')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'One conversation with its messages, oldest first' })
  @ApiOkResponse({ type: AssistantThreadDto })
  async thread(
    @Req() req: Request & { user: User },
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AssistantThreadDto> {
    const { conversation, messages } = await this.assistant.conversation(req.user.id, id);
    return {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt.toISOString(),
        lastMessageAt: conversation.lastMessageAt.toISOString(),
      },
      messages: messages.map(messageDto),
    };
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Delete a conversation and its messages, for good' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  async remove(
    @Req() req: Request & { user: User },
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.assistant.deleteConversation(req.user.id, id);
  }

  @Post('ask')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiCookieAuth()
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Ask a question; the answer streams back',
    description: STREAM_DESCRIPTION,
  })
  @ApiOkResponse({ description: 'The answer, as Server-Sent Events.' })
  async ask(
    @Req() req: Request & { user: User },
    @Body() dto: AssistantAskDto,
    @Res() res: Response,
  ): Promise<void> {
    const clientGone = watchClient(res);
    const prepared = await this.assistant.prepareQuestion(req.user.id, requestLocale(), {
      conversationId: dto.conversationId ?? null,
      question: dto.question,
      requestId: dto.requestId ?? null,
    });
    await this.stream(prepared, res, clientGone);
  }

  @Post('conversations/:id/regenerate')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiCookieAuth()
  @ApiProduces('text/event-stream')
  @ApiOperation({
    summary: 'Answer the last question again, replacing the previous answer',
    description: `Counts against the daily allowance like a question. ${STREAM_DESCRIPTION}`,
  })
  @ApiOkResponse({ description: 'The new answer, as Server-Sent Events.' })
  async regenerate(
    @Req() req: Request & { user: User },
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const clientGone = watchClient(res);
    const prepared = await this.assistant.prepareRegenerate(req.user.id, requestLocale(), id);
    await this.stream(prepared, res, clientGone);
  }

  @Put('messages/:id/feedback')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Rate an answer as helpful or not (null clears the rating)' })
  @ApiNoContentResponse({ description: 'Recorded.' })
  async feedback(
    @Req() req: Request & { user: User },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssistantFeedbackDto,
  ): Promise<void> {
    await this.assistant.setFeedback(req.user.id, id, dto.rating ?? null, dto.reason ?? null);
  }

  /**
   * Opens the stream only now, after every refusal has had its chance to be a
   * JSON error. A client that left during preparation still gets its answer
   * row closed (as aborted) by the runner, without a model call.
   */
  private async stream(
    prepared: PreparedAnswer,
    res: Response,
    clientGone: AbortSignal,
  ): Promise<void> {
    const sink = new SseAnswerSink(res);
    if (!clientGone.aborted) sink.open();
    try {
      await this.runner.run(prepared, sink, clientGone);
    } finally {
      sink.close();
    }
  }
}

/**
 * Aborts when the client goes away. Attached BEFORE the question is prepared:
 * a client that leaves during preparation (a timeout, a closed tab) would
 * otherwise go unnoticed, and its answer would be written, and paid for, for nobody.
 */
function watchClient(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  if (res.destroyed) controller.abort();
  return controller.signal;
}

function messageDto(row: AssistantMessageRow): AssistantMessageDto {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    followups: row.followups ?? [],
    sources: row.sources ?? [],
    feedback: row.feedback === 1 || row.feedback === -1 ? row.feedback : null,
    createdAt: row.createdAt.toISOString(),
  };
}
