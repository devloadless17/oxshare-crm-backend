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
): Record<string, unknown> {
  return {
    kind: 'client.crash',
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
