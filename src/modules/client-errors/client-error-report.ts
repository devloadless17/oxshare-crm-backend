import type { ClientErrorReportDto } from './dto/client-error-report.dto';

const EMAIL = /[^\s@"'<>()]+@[^\s@"'<>()]+\.[a-z]{2,}/gi;
// Long digit runs: phone numbers, card-like numbers, codes typed into a form.
const DIGIT_RUN = /\d{6,}/g;

/** A message or stack with anything person-shaped blanked out. */
export function scrub(text: string): string {
  return text.replace(EMAIL, '[email]').replace(DIGIT_RUN, '[digits]');
}

// A stack FRAME: "    at fn (https://host/chunk.js?dpl=<sha>:31:204567)".
const FRAME = /^\s*at\s/;

/**
 * A stack with the message lines scrubbed and the frames kept whole.
 *
 * The frames are code locations, never a person, and their long numbers (the
 * column in a minified bundle, the build id) are exactly what points at the
 * failing component; blanking them made the first live report unreadable
 * (`chunk.js:31:[digits]`, 16 Oct 2026). Emails are still blanked everywhere.
 */
export function scrubStack(stack: string): string {
  return stack
    .split('\n')
    .map((line) => (FRAME.test(line) ? line.replace(EMAIL, '[email]') : scrub(line)))
    .join('\n');
}

/**
 * A query string or fragment can carry a reset token, a verification code or a
 * search term, so only the path survives, even if a client sent more.
 */
export function pathOnly(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? '';
}

/** The one log line a crash report becomes. */
export function clientErrorLogLine(
  dto: ClientErrorReportDto,
  userAgent: string | undefined,
  receivedAt: Date = new Date(),
): Record<string, unknown> {
  return {
    kind: 'client.crash',
    id: dto.id,
    occurredAt: dto.occurredAt,
    // A report kept on a phone with no connection arrives on its next page
    // load. Say how late, so its log time is not mistaken for the crash's.
    sentLateSeconds: lateBy(dto.occurredAt, receivedAt),
    app: dto.app,
    boundary: dto.boundary,
    path: pathOnly(dto.path),
    build: dto.build,
    digest: dto.digest,
    name: dto.name,
    message: scrub(dto.message),
    stack: dto.stack ? scrubStack(dto.stack) : undefined,
    userAgent: userAgent?.slice(0, 300),
  };
}

/** Seconds between the crash and its arrival, when that is over a minute. */
function lateBy(occurredAt: string | undefined, receivedAt: Date): number | undefined {
  if (!occurredAt) return undefined;
  const at = Date.parse(occurredAt);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.round((receivedAt.getTime() - at) / 1000);
  return seconds > 60 ? seconds : undefined;
}
