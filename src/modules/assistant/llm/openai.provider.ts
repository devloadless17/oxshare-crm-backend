import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';
import type {
  ResponseInputItem,
  ResponseStreamEvent,
  Tool,
} from 'openai/resources/responses/responses';
import {
  LlmUpstreamError,
  type LlmEvent,
  type LlmItem,
  type LlmProvider,
  type LlmRequest,
} from './llm-provider';

/**
 * Fast, cheap and good at short structured answers. Its reasoning effort
 * defaults to none, which is what keeps the first token quick.
 */
export const DEFAULT_MODEL = 'gpt-5.4-mini';
const MODERATION_MODEL = 'omni-moderation-latest';

/**
 * The cache key groups requests that share the long, stable instructions
 * prefix, so OpenAI serves it from cache, at a tenth of the input price. Bump
 * the suffix when the knowledge pack changes shape.
 */
const PROMPT_CACHE_KEY = 'oxshare-assistant-v3';

/**
 * The OpenAI adapter — the only file that imports the SDK.
 *
 * Three settings matter:
 * - `store: false`: OpenAI keeps no copy of the conversation; we hold the
 *   history ourselves.
 * - `maxRetries: 0`: the orchestrator owns retrying, because only it knows
 *   whether text has already reached the client.
 * - The key is never logged, and an error carries OpenAI's message, never the
 *   request.
 */
@Injectable()
export class OpenAiProvider implements LlmProvider {
  readonly model: string;
  private readonly client: OpenAI | null;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('OPENAI_API_KEY');
    this.model = config.get<string>('OPENAI_MODEL') ?? DEFAULT_MODEL;
    this.client = apiKey ? new OpenAI({ apiKey, timeout: 60_000, maxRetries: 0 }) : null;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmEvent> {
    const client = this.requireClient();
    let events: AsyncIterable<ResponseStreamEvent>;
    try {
      events = await client.responses.create(
        {
          model: this.model,
          instructions: request.instructions,
          input: request.items.map(toInput),
          tools: [
            ...request.tools.map((tool): Tool => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              strict: false,
            })),
            // OpenAI runs the search and cites what it read; the model decides when to search.
            ...(request.webSearch
              ? [{ type: 'web_search', search_context_size: 'medium' } satisfies Tool]
              : []),
          ],
          max_output_tokens: request.maxOutputTokens,
          store: false,
          stream: true,
          prompt_cache_key: PROMPT_CACHE_KEY,
          safety_identifier: request.endUserKey,
        },
        { signal: request.signal },
      );
    } catch (error) {
      throw upstream(error, request.signal);
    }

    /*
     * The SDK ends the iteration QUIETLY when the request is aborted (Stop, the
     * client leaving, the deadline): it returns instead of throwing. Without
     * this flag that looked like a finished answer, and a cut-off reply was
     * saved as complete. A stream that ends without its completion event is
     * never a success.
     */
    let finished = false;
    let webSearches = 0;
    try {
      for await (const event of events) {
        switch (event.type) {
          // The model's own refusal is text for the client too; dropped, it left a blank answer.
          case 'response.output_text.delta':
          case 'response.refusal.delta':
            yield { type: 'text', delta: event.delta };
            break;
          case 'response.web_search_call.in_progress':
            yield { type: 'searching' };
            break;
          case 'response.output_text.annotation.added': {
            const source = citedSource(event.annotation);
            if (source) yield { type: 'source', ...source };
            break;
          }
          case 'response.output_item.done':
            if (event.item.type === 'web_search_call') webSearches += 1;
            if (event.item.type === 'function_call') {
              yield {
                type: 'tool_call',
                callId: event.item.call_id,
                name: event.item.name,
                arguments: event.item.arguments,
              };
            }
            break;
          case 'response.completed':
          case 'response.incomplete': {
            const usage = event.response.usage;
            const reason = event.response.incomplete_details?.reason;
            finished = true;
            yield {
              type: 'done',
              finish:
                event.type === 'response.completed'
                  ? 'stop'
                  : reason === 'content_filter'
                    ? 'content_filter'
                    : 'length',
              usage: {
                inputTokens: usage?.input_tokens ?? 0,
                cachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
                outputTokens: usage?.output_tokens ?? 0,
                webSearches,
              },
            };
            return;
          }
          case 'response.failed':
            throw new LlmUpstreamError(
              event.response.error?.message ?? 'The model failed to answer.',
              false,
            );
          case 'error':
            throw new LlmUpstreamError(event.message, false);
          default:
            break;
        }
      }
    } catch (error) {
      throw upstream(error, request.signal);
    }
    if (finished) return;
    if (request.signal.aborted) {
      throw request.signal.reason instanceof Error
        ? request.signal.reason
        : new APIUserAbortError();
    }
    throw new LlmUpstreamError('The model stream ended before the answer was complete.', true);
  }

  async moderate(text: string, signal: AbortSignal): Promise<boolean> {
    const client = this.requireClient();
    try {
      const result = await client.moderations.create(
        { model: MODERATION_MODEL, input: text },
        { signal },
      );
      return result.results.some((r) => r.flagged);
    } catch (error) {
      throw upstream(error, signal);
    }
  }

  private requireClient(): OpenAI {
    if (!this.client) throw new LlmUpstreamError('No OpenAI key is configured.', false);
    return this.client;
  }
}

function toInput(item: LlmItem): ResponseInputItem {
  switch (item.kind) {
    case 'message':
      return { role: item.role, content: item.text };
    case 'tool_call':
      return {
        type: 'function_call',
        call_id: item.callId,
        name: item.name,
        arguments: item.arguments,
      };
    case 'tool_result':
      return { type: 'function_call_output', call_id: item.callId, output: item.output };
  }
}

/**
 * A web page the answer cites, from a `url_citation` annotation. Only http(s)
 * pages, with OpenAI's tracking parameter removed; anything else is dropped.
 */
function citedSource(annotation: unknown): { title: string; url: string } | null {
  if (!annotation || typeof annotation !== 'object') return null;
  const { type, url, title } = annotation as { type?: unknown; url?: unknown; title?: unknown };
  if (type !== 'url_citation' || typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.startsWith('utm_')) parsed.searchParams.delete(key);
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const name = typeof title === 'string' && title.trim() ? title.trim() : host;
  return { title: name.slice(0, 200), url: parsed.toString().slice(0, 2000) };
}

/** Every SDK failure becomes one error type, marked retryable where asking again makes sense. */
function upstream(error: unknown, signal: AbortSignal): Error {
  if (error instanceof LlmUpstreamError) return error;
  // An abort is the client leaving, not a vendor failure: pass it through as is.
  if (error instanceof APIUserAbortError) return error;
  if (error instanceof APIConnectionError) return new LlmUpstreamError(error.message, true);
  if (error instanceof APIError) {
    const { status = 0 } = error as { status?: number };
    return new LlmUpstreamError(error.message, status === 429 || status >= 500);
  }
  if (signal.aborted) return error instanceof Error ? error : new APIUserAbortError();
  /*
   * Anything else is the transport failing beneath the SDK (undici's
   * `terminated` when the connection resets mid-stream). A vendor failure
   * worth one retry, not an internal error.
   */
  return new LlmUpstreamError(error instanceof Error ? error.message : String(error), true);
}
