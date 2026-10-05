/**
 * The model, as the assistant sees it — a PORT, in the shape the payments core
 * uses for providers: the orchestrator decides, an adapter translates.
 *
 * Nothing outside `llm/` knows which vendor answers. `openai.provider.ts` is
 * the only file that imports the OpenAI SDK, so changing model or vendor, or
 * adding a fallback, touches one adapter and leaves the conversation logic,
 * the limits, the tools and the stream protocol alone.
 */

/** One item of the conversation sent to the model, in neutral form. */
export type LlmItem =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string }
  | { kind: 'tool_call'; callId: string; name: string; arguments: string }
  | { kind: 'tool_result'; callId: string; output: string };

export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool's input. */
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  instructions: string;
  items: readonly LlmItem[];
  tools: readonly LlmToolSpec[];
  maxOutputTokens: number;
  /**
   * A stable, NON-REVERSIBLE key for the asking client (an HMAC of the Portal
   * ID). The vendor uses it to attribute abuse to one end user rather than to
   * the whole platform. It never carries the Portal ID itself.
   */
  endUserKey: string;
  signal: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export type LlmFinish = 'stop' | 'length' | 'content_filter';

export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string }
  | { type: 'done'; finish: LlmFinish; usage: LlmUsage };

export interface LlmProvider {
  /** The model answers are recorded against. */
  readonly model: string;
  /** False when no credentials are configured: the assistant is then unavailable. */
  isConfigured(): boolean;
  /** One model turn, streamed. Throws `LlmUpstreamError` on a vendor failure. */
  stream(request: LlmRequest): AsyncIterable<LlmEvent>;
  /** True when the text breaks the vendor's usage policies. */
  moderate(text: string, signal: AbortSignal): Promise<boolean>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/**
 * The vendor failed. `retryable` is true for a rate limit, a 5xx or a dropped
 * connection — the cases where asking again is reasonable. The orchestrator
 * retries only before anything has been streamed, so a retry can never repeat
 * text the client has already read.
 */
export class LlmUpstreamError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmUpstreamError';
  }
}
