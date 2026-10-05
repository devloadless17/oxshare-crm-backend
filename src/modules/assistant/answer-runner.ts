import { Inject, Injectable, Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import type { Locale } from '../../common/i18n/locale';
import { AssistantStore, type AssistantAnswerOutcome } from '../../store/assistant.store';
import { FollowupSplitter } from './followups';
import { buildInstructions, languageOf } from './knowledge/system-prompt';
import {
  LLM_PROVIDER,
  LlmUpstreamError,
  type LlmEvent,
  type LlmFinish,
  type LlmItem,
  type LlmProvider,
  type LlmRequest,
} from './llm/llm-provider';
import { ToolRegistry } from './tools/tool-registry';

/** Everything decided before the stream opened. Built by `AssistantService.prepare*`. */
export interface PreparedAnswer {
  clientId: number;
  locale: Locale;
  conversationId: string;
  assistantMessageId: string;
  /** True when this answer started the conversation. */
  created: boolean;
  /** The thread sent to the model, ending with the question being answered. */
  items: LlmItem[];
  /** The question being answered, for moderation. */
  question: string;
  endUserKey: string;
  /** Answers left today after this one. */
  remainingToday: number;
}

/**
 * Where the answer goes: the SSE stream, in production. Writes after the client
 * has gone are dropped by the sink, never thrown.
 */
export interface AnswerSink {
  meta(data: { conversationId: string; messageId: string; created: boolean }): void;
  delta(text: string): void;
  followups(questions: string[]): void;
  done(data: { messageId: string; finish: LlmFinish | 'refused'; remainingToday: number }): void;
  error(code: AnswerErrorCode): void;
}

export type AnswerErrorCode = 'UPSTREAM' | 'TIMEOUT' | 'INTERNAL';

/** Output cap per model turn: room for a thorough answer, a bound on any single one's cost. */
const MAX_OUTPUT_TOKENS = 1_200;
/** Model → tools → model rounds. v1 offers no tools, so one round is the norm. */
const MAX_ROUNDS = 4;
/** The longest one answer may take, end to end. */
const ANSWER_DEADLINE_MS = 90_000;
/** Moderation is a gate, but a slow one must not hold every answer: past this it fails open. */
const MODERATION_TIMEOUT_MS = 4_000;
/** The most shutdown waits for stopped answers to record themselves before the pool closes. */
const SHUTDOWN_WAIT_MS = 10_000;

/** For a flagged question: a polite no, without explaining the rules behind it. */
const REFUSAL: Record<Locale, string> = {
  en: "Sorry, I can't help with that one. Is there anything about trading I can help you with?",
  ar: 'عذراً، لا يمكنني المساعدة في هذا. هل هناك ما يمكنني مساعدتك به في التداول؟',
};

class Refused extends Error {}

/**
 * Writes one answer: moderation in parallel with the model, the tool loop, the
 * follow-up split, and ONE record of what happened, whatever happened.
 *
 * `run` never throws. By the time it starts, the response is a 200 event
 * stream, so every failure becomes an `error` event plus a closed row. The
 * one thing guaranteed is that the `streaming` row is always closed: an open
 * one is what blocks the client's next question.
 *
 * On shutdown (every deploy) answers still being written are stopped and
 * recorded as FAILED, which is free. An answer may run 90 s and the container
 * gets 30: left alone, the open streams held the old API up past its grace
 * period, and the killed rows were charged as `interrupted`.
 */
@Injectable()
export class AnswerRunner implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Assistant');
  private readonly stopping = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly tools: ToolRegistry,
    private readonly store: AssistantStore,
  ) {}

  /** Nest calls this before it closes the HTTP server, so each stopped stream ends cleanly. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping.abort();
    if (this.inFlight.size === 0) return;
    this.logger.log(`Shutting down: stopping ${this.inFlight.size} answer(s) being written.`);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => (timer = setTimeout(resolve, SHUTDOWN_WAIT_MS))),
    ]);
    clearTimeout(timer);
  }

  async run(prepared: PreparedAnswer, sink: AnswerSink, clientGone: AbortSignal): Promise<void> {
    const running = this.answer(prepared, sink, clientGone);
    this.inFlight.add(running);
    try {
      await running;
    } finally {
      this.inFlight.delete(running);
    }
  }

  private async answer(
    prepared: PreparedAnswer,
    sink: AnswerSink,
    clientGone: AbortSignal,
  ): Promise<void> {
    /*
     * The client left while the question was being prepared: close the row, call
     * nothing. FAILED, not aborted: nothing was asked and nothing given, so it
     * uses up none of their questions (an answer stopped part-way does).
     */
    if (clientGone.aborted || this.stopping.signal.aborted) {
      await this.store
        .finishAnswer(prepared.assistantMessageId, { content: '', status: 'failed' })
        .catch(() => undefined);
      if (!clientGone.aborted) sink.error('UPSTREAM');
      return;
    }
    const startedAt = Date.now();
    const answerLanguage = languageOf(prepared.question, prepared.locale);
    const timedOut = AbortSignal.timeout(ANSWER_DEADLINE_MS);
    const stopping = this.stopping.signal;
    const signal = AbortSignal.any([clientGone, timedOut, stopping]);
    const splitter = new FollowupSplitter();
    const usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };

    let text = '';
    let ttftMs: number | null = null;
    let finish: LlmFinish | 'refused' = 'stop';
    let outcome: AssistantAnswerOutcome['status'] = 'complete';
    let followups: string[] = [];

    /*
     * Moderation runs WHILE the model starts, and is awaited only at the first
     * moment anything would reach the client. A clean question therefore costs
     * no latency, and a flagged one shows nothing but the refusal. It fails
     * OPEN: a moderation outage must not take the assistant down, and the
     * model's own rules still apply.
     */
    const moderation = this.llm
      .moderate(
        prepared.question,
        AbortSignal.any([signal, AbortSignal.timeout(MODERATION_TIMEOUT_MS)]),
      )
      .catch(() => false);
    let cleared = false;
    const ensureAllowed = async () => {
      if (cleared) return;
      if (await moderation) throw new Refused();
      cleared = true;
    };
    const emit = async (visible: string) => {
      if (!visible) return;
      await ensureAllowed();
      ttftMs ??= Date.now() - startedAt;
      text += visible;
      sink.delta(visible);
    };

    sink.meta({
      conversationId: prepared.conversationId,
      messageId: prepared.assistantMessageId,
      created: prepared.created,
    });

    try {
      const items = [...prepared.items];
      const instructions = buildInstructions(answerLanguage);
      const toolSpecs = this.tools.specs();

      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const calls: Extract<LlmEvent, { type: 'tool_call' }>[] = [];
        const request: LlmRequest = {
          instructions,
          items,
          tools: toolSpecs,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          endUserKey: prepared.endUserKey,
          signal,
        };
        for await (const event of this.streamWithOneRetry(request, () => text.length > 0)) {
          if (event.type === 'text') {
            await emit(splitter.push(event.delta));
          } else if (event.type === 'tool_call') {
            calls.push(event);
          } else {
            usage.inputTokens += event.usage.inputTokens;
            usage.cachedTokens += event.usage.cachedTokens;
            usage.outputTokens += event.usage.outputTokens;
            finish = event.finish;
          }
        }
        if (calls.length === 0) break;

        await ensureAllowed();
        for (const call of calls) {
          items.push({
            kind: 'tool_call',
            callId: call.callId,
            name: call.name,
            arguments: call.arguments,
          });
          const output = await this.tools.execute(
            { clientId: prepared.clientId, locale: prepared.locale },
            call.name,
            call.arguments,
          );
          items.push({ kind: 'tool_result', callId: call.callId, output });
        }
      }

      // Defensive: a provider that ended quietly on abort must not count as finished.
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      const tail = splitter.finish();
      await emit(tail.text);
      // Moderation gates EVERY answer, even one that showed no text at all.
      await ensureAllowed();
      /*
       * An answer with no visible text gave the client nothing: hidden reasoning
       * spent the output budget, or the stream carried nothing we show. It is a
       * failure (free, with Try again), never a blank answer charged as complete.
       */
      if (text.trim().length === 0) {
        throw new LlmUpstreamError(`The model returned no text (finish: ${finish}).`, false);
      }
      followups = tail.followups;
      if (followups.length > 0) sink.followups(followups);
      sink.done({
        messageId: prepared.assistantMessageId,
        finish,
        remainingToday: prepared.remainingToday,
      });
    } catch (error) {
      if (error instanceof Refused) {
        outcome = 'refused';
        finish = 'refused';
        text = REFUSAL[answerLanguage];
        sink.delta(text);
        sink.done({
          messageId: prepared.assistantMessageId,
          finish,
          remainingToday: prepared.remainingToday,
        });
      } else if (clientGone.aborted) {
        // The client closed the panel or pressed Stop: keep what they saw.
        outcome = 'aborted';
      } else if (stopping.aborted) {
        // A deploy, not the client: free, and the portal offers Try again.
        outcome = 'failed';
        sink.error('UPSTREAM');
      } else if (timedOut.aborted) {
        outcome = text ? 'aborted' : 'failed';
        sink.error('TIMEOUT');
      } else {
        outcome = 'failed';
        /*
         * The vendor's own message is logged (a bad key, a quota, a model name
         * the account cannot use), because without it an outage reads only as
         * "UPSTREAM". It carries neither the key nor the conversation.
         */
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof LlmUpstreamError) {
          this.logger.warn(`Answer ${prepared.assistantMessageId}: the model failed: ${reason}`);
        } else {
          this.logger.error(`Answer ${prepared.assistantMessageId} failed: ${reason}`);
        }
        sink.error(error instanceof LlmUpstreamError ? 'UPSTREAM' : 'INTERNAL');
      }
    } finally {
      const latencyMs = Date.now() - startedAt;
      await this.store
        .finishAnswer(prepared.assistantMessageId, {
          content: text.trimEnd(),
          status: outcome,
          followups: followups.length > 0 ? followups : null,
          model: this.llm.model,
          ...usage,
          ttftMs,
          latencyMs,
        })
        .catch((error: unknown) =>
          this.logger.error(
            `Could not close answer ${prepared.assistantMessageId}; it retires as interrupted: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      // One line per answer: what it cost and how it felt. Never the content.
      this.logger.log(
        `answer ${outcome} model=${this.llm.model} in=${usage.inputTokens} cached=${usage.cachedTokens} ` +
          `out=${usage.outputTokens} ttft=${ttftMs ?? '-'}ms total=${latencyMs}ms`,
      );
    }
  }

  /**
   * One model turn, retried ONCE on a retryable vendor failure, and only while
   * nothing has reached the client. Retrying after text has been shown would
   * show it twice.
   */
  private async *streamWithOneRetry(
    request: LlmRequest,
    anythingShown: () => boolean,
  ): AsyncIterable<LlmEvent> {
    let yielded = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        for await (const event of this.llm.stream(request)) {
          yielded = true;
          yield event;
        }
        return;
      } catch (error) {
        const retry =
          attempt === 0 &&
          !yielded &&
          !anythingShown() &&
          !request.signal.aborted &&
          error instanceof LlmUpstreamError &&
          error.retryable;
        if (!retry) throw error;
        await sleep(400 + Math.floor(Math.random() * 500), request.signal);
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });
}
