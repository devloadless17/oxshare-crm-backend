import type { ClientErrorReportDto } from './dto/client-error-report.dto';

const EMAIL = /[^\s@"'<>()]+@[^\s@"'<>()]+\.[a-z]{2,}/gi;
// Long digit runs: phone numbers, card-like numbers, codes typed into a form.
const DIGIT_RUN = /\d{6,}/g;

/** A message or stack with anything person-shaped blanked out. */
export function scrub(text: string): string {
  return text.replace(EMAIL, '[email]').replace(DIGIT_RUN, '[digits]');
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
    stack: dto.stack ? scrub(dto.stack) : undefined,
    userAgent: userAgent?.slice(0, 300),
  };
}
