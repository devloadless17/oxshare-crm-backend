import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { currentRequestId } from './request-context';

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
    if (!this.asJson) {
      super.printMessages(messages, context, logLevel, writeStreamType);
      return;
    }

    for (const message of messages) {
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
