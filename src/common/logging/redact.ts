/**
 * Strips secrets and PII out of anything on its way to a log.
 *
 * PLATFORM-CONVENTIONS R-6.3. The never-log list was a list — a rule enforced by
 * everyone remembering it on every `logger.log()` for the life of the project.
 * One `logger.log(dto)` on a KYC submission puts a passport number into the log
 * store permanently, including whatever aggregator or error tracker it ships to,
 * and no code review catches that reliably.
 *
 * So it is enforced at the sink instead. Anything serialized by JsonLogger goes
 * through here, whoever wrote the call and whenever they wrote it.
 *
 * Two rules, both deliberate:
 *
 *  - Redaction is by FIELD NAME, matched loosely (case-insensitive, substring).
 *    A name-based rule catches `passwordHash`, `refresh_token` and
 *    `X-OxShare-CSRF` without anyone enumerating them, and over-redacting a log
 *    line costs nothing while under-redacting one cannot be undone.
 *  - The value is replaced with a marker, never dropped. A log that says
 *    `password: [REDACTED]` is debuggable — you can see the field was present
 *    and populated. A log with the field silently missing looks like a bug in
 *    the code that built it.
 */

/**
 * Field names whose values never reach a log.
 *
 * Matched as case-insensitive substrings, so `token` covers `accessToken`,
 * `refresh_token`, `emailVerificationToken` and `X-Bridge-Token` at once.
 */
const SENSITIVE_FIELDS = [
  // Credentials.
  'password',
  'passwordhash',
  'token',
  'secret',
  'authorization',
  'cookie',
  'csrf',
  'otp',
  'apikey',
  // A PKCE code_verifier (Google sign-in, 0180).
  'verifier',
  'api_key',
  // Identity documents and the PII around them (§8.5, R-6.3).
  'documentnumber',
  'document_number',
  'idnumber',
  'id_number',
  'passport',
  'nationalid',
  'national_id',
  'dateofbirth',
  'date_of_birth',
  'dob',
  'address',
  'phone',
  'iban',
  'accountnumber',
  'account_number',
  'cardnumber',
  'card_number',
] as const;

export const REDACTED = '[REDACTED]';

/** How deep to walk before giving up — cycles and huge payloads both end here. */
const MAX_DEPTH = 6;

function isSensitive(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_FIELDS.some((field) => normalised.includes(field.replace(/[-_]/g, '')));
}

/**
 * Returns a copy safe to serialize.
 *
 * Never mutates its input: this runs on live domain objects on their way past,
 * and a logger that quietly blanked a field on the object it was handed would
 * be a spectacular source of bugs.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1));
  }

  // An Error carries a message and a stack, both worth keeping, and neither is
  // enumerable — a plain object spread would silently produce `{}`.
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSensitive(key) ? REDACTED : redact(entry, depth + 1);
    }
    return output;
  }

  return value;
}

/**
 * Whether a bare string looks like a credential.
 *
 * Structured objects are handled by field name, but plenty of logging is
 * `logger.log(\`token: \${token}\`)`. This catches the shapes that are
 * unmistakable — a JWT, a long hex or base64url run — without touching ordinary
 * prose. Conservative on purpose: a false positive redacts a log line, and a
 * false negative leaks a credential, so the thresholds sit where only
 * machine-generated values reach them.
 */
export function redactSecretsInText(text: string): string {
  return (
    text
      // JWTs: three base64url segments. Unambiguous, and the highest-value leak.
      .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, REDACTED)
      // Long hex runs — HMAC signatures, sha256 hashes, raw secrets.
      .replace(/\b[a-f0-9]{40,}\b/gi, REDACTED)
  );
}

/**
 * A request path safe to log — R-6.3.
 *
 * The query string is where credentials travel by URL, and this system puts two
 * of them there: `GET /auth/verify-email?token=…` and the password-reset link.
 * Both were being logged verbatim in four places, the worst of which is the
 * request-id middleware — it stores the path in the async-local context, and
 * `JsonLogger` stamps that on EVERY line of the request, so one reset request
 * wrote its token into the log repeatedly.
 *
 * A log file is a different security boundary from a database: it is shipped to
 * aggregators, read by more people, retained longer and rarely encrypted at
 * rest. A single-use token sitting in it is a credential in the least protected
 * place we have.
 *
 * Parameter NAMES are kept and only sensitive VALUES are replaced, rather than
 * dropping the query string wholesale. `?page=3&status=pending` is exactly what
 * makes a 500 diagnosable, and a log that omits it trades one problem for
 * another — the next person just adds the URL back.
 */
/**
 * Query parameters that are credentials on the Google sign-in routes ONLY —
 * matched exactly and only there, because elsewhere they are ordinary filters
 * (`?state=pending` on the transaction list) worth keeping in a log. The
 * callback carries an authorization `code` and its `state`; the start carries
 * an `invite` token.
 */
const GOOGLE_FLOW_PATH = /\/admin\/auth\/google\//i;
const GOOGLE_FLOW_PARAMS = new Set(['code', 'state', 'invite']);

export function safeLogPath(url: string): string {
  const split = url.indexOf('?');
  if (split === -1) return url;

  const path = url.slice(0, split);
  const params = new URLSearchParams(url.slice(split + 1));

  /*
   * Assembled by hand rather than through `URLSearchParams.toString()`, which
   * would percent-encode the marker into `%5BREDACTED%5D`. This string is read
   * by a human in a log, not parsed, so it should look like what it means.
   */
  const googleFlow = GOOGLE_FLOW_PATH.test(path);
  const parts: string[] = [];
  for (const [key, value] of params) {
    const hidden = isSensitive(key) || (googleFlow && GOOGLE_FLOW_PARAMS.has(key.toLowerCase()));
    parts.push(`${key}=${hidden ? REDACTED : value}`);
  }

  return parts.length > 0 ? `${path}?${parts.join('&')}` : path;
}
