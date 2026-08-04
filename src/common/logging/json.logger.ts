import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { currentRequestId } from './request-context';
import { redact, redactSecretsInText } from './redact';

/**
 * One JSON object per log line, with the correlation id attached.
 *
 * The working agreement asks for "structured JSON logging with a correlation
 * id through the request and into queued jobs". Nest's default logger emits
 * coloured, human-shaped, multi-field text that no log aggregator can query:
 * finding every line belonging to one failed withdrawal meant grepping a
 * timestamp range and hoping.
 *
 * Kept as text in development, because a developer reading a terminal is a
 * different consumer from a log pipeline.
 */
export class JsonLogger extends ConsoleLogger {
  private readonly asJson = process.env['NODE_ENV'] === 'production';

  protected override printMessages(
    messages: unknown[],
    context = '',
    logLevel: LogLevel = 'log',
    writeStreamType?: 'stdout' | 'stderr',
  ): void {
    /*
     * Redaction runs in BOTH modes — R-6.3.
     *
     * It would be easy to skip it in development "because it is only a
     * terminal". But a developer's terminal is scrolled through, screenshotted
     * into tickets, and pasted into chat, and dev databases hold real-shaped
     * test PII. More practically: a redaction bug that only appears in
     * production is one nobody sees until it has already leaked.
     */
    const safe = messages.map((message) =>
      typeof message === 'string' ? redactSecretsInText(message) : redact(message),
    );

    if (!this.asJson) {
      super.printMessages(safe, context, logLevel, writeStreamType);
      return;
    }

    for (const message of safe) {
      const line = JSON.stringify({
        level: logLevel,
        time: new Date().toISOString(),
        context: context || undefined,
        requestId: currentRequestId(),
        message,
      });
      process[writeStreamType ?? 'stdout'].write(line + '\n');
    }
  }
}
