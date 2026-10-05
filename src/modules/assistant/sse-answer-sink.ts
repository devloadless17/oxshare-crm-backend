import type { Response } from 'express';
import type { AnswerErrorCode, AnswerSink } from './answer-runner';

/** A comment line every 15 s keeps proxies and load balancers from closing a quiet stream. */
const HEARTBEAT_MS = 15_000;

/**
 * The answer as Server-Sent Events, the provider-neutral protocol the portal reads:
 *
 *     event: meta       {conversationId, messageId, created}
 *     event: delta      {text}
 *     event: followups  {questions}
 *     event: done       {messageId, finish, remainingToday}
 *     event: error      {code}
 *
 * OpenAI's own event shapes never reach the browser, so a vendor change cannot
 * break the widget. New UI capabilities (a card, a confirm button, a tool's
 * progress) arrive as new event names that older portals ignore.
 *
 * Headers are committed by `open()`, which the controller calls only after
 * every refusal has had its chance to be a normal HTTP error. Writes after
 * the client left are dropped, never thrown.
 */
export class SseAnswerSink implements AnswerSink {
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly res: Response) {}

  open(): void {
    this.res.status(200);
    this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // `no-transform` asks every proxy, Caddy's `encode` included, not to
    // compress or buffer the stream. Without it the answer can arrive in one lump.
    this.res.setHeader('Cache-Control', 'no-cache, no-transform');
    this.res.setHeader('X-Accel-Buffering', 'no');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.socket?.setNoDelay(true);
    this.res.flushHeaders();
    this.heartbeat = setInterval(() => this.write(': ping\n\n'), HEARTBEAT_MS);
  }

  meta(data: { conversationId: string; messageId: string; created: boolean }): void {
    this.event('meta', data);
  }

  delta(text: string): void {
    this.event('delta', { text });
  }

  followups(questions: string[]): void {
    this.event('followups', { questions });
  }

  done(data: { messageId: string; finish: string; remainingToday: number }): void {
    this.event('done', data);
  }

  error(code: AnswerErrorCode): void {
    this.event('error', { code });
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (!this.res.writableEnded) this.res.end();
  }

  private event(name: string, data: unknown): void {
    this.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private write(chunk: string): void {
    if (this.res.writableEnded || this.res.destroyed) return;
    this.res.write(chunk);
  }
}
