/**
 * "Sign in with Google" for the ADMIN console — what the environment says, in
 * one place.
 *
 * Read twice: by `env.validation.ts` at boot, to refuse a half-configured
 * deployment, and by `GoogleOauthConfig` at runtime, to decide whether the
 * feature is on. One function, so the two can never disagree about what "on"
 * means or which redirect URI Google was told about.
 *
 * The feature is OFF unless BOTH the client id and the client secret are set.
 * One without the other is a mistake, not a configuration, and boot refuses it.
 */

/** The callback route, relative to the API's public origin. */
export const GOOGLE_CALLBACK_PATH = '/v1/admin/auth/google/callback';

export interface GoogleOauthSettings {
  clientId: string;
  clientSecret: string;
  /** Registered at Google VERBATIM — an exact string match, scheme and port included. */
  redirectUri: string;
  /**
   * Lower-cased Google Workspace domains. Empty means any verified Google
   * account may TRY — it still has to match an administrator to get anywhere.
   */
  allowedDomains: string[];
  /**
   * The flow cookie's Path: the redirect URI's directory, so the browser
   * returns the cookie to the callback and to nothing else on this host.
   */
  cookiePath: string;
}

export type GoogleOauthResolution =
  | { status: 'disabled' }
  | { status: 'enabled'; settings: GoogleOauthSettings }
  | { status: 'invalid'; problem: string };

type EnvLike = Record<string, unknown>;

function text(env: EnvLike, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** `bbcorp.trade, Example.com` → `['bbcorp.trade', 'example.com']`. */
export function parseAllowedDomains(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d !== ''),
    ),
  ];
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function resolveGoogleOauth(env: EnvLike): GoogleOauthResolution {
  const clientId = text(env, 'GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = text(env, 'GOOGLE_OAUTH_CLIENT_SECRET');

  if (!clientId && !clientSecret) return { status: 'disabled' };
  if (!clientId || !clientSecret) {
    return {
      status: 'invalid',
      problem:
        `${clientId ? 'GOOGLE_OAUTH_CLIENT_SECRET' : 'GOOGLE_OAUTH_CLIENT_ID'} is missing. ` +
        'Google sign-in needs BOTH the OAuth client id and its secret; set both to turn it on, ' +
        'or neither to leave it off. Half a credential is a mistake rather than a configuration.',
    };
  }

  /*
   * NOT derived from a request's Host header: Google redirects the browser to
   * exactly this string, so it has to be something the operator configured.
   */
  const explicit = text(env, 'GOOGLE_OAUTH_REDIRECT_URI');
  const apiPublic = text(env, 'API_PUBLIC_URL');
  const redirectUri =
    explicit ?? (apiPublic ? `${apiPublic.replace(/\/+$/, '')}${GOOGLE_CALLBACK_PATH}` : undefined);
  if (!redirectUri) {
    return {
      status: 'invalid',
      problem:
        'Google sign-in is enabled but there is no redirect URI: set GOOGLE_OAUTH_REDIRECT_URI, ' +
        `or API_PUBLIC_URL so it can default to <API_PUBLIC_URL>${GOOGLE_CALLBACK_PATH}. It must ` +
        'be the exact URI registered on the Google OAuth client.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return {
      status: 'invalid',
      problem: `GOOGLE_OAUTH_REDIRECT_URI is not an absolute URL: "${redirectUri}".`,
    };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      status: 'invalid',
      problem: `GOOGLE_OAUTH_REDIRECT_URI must use http or https, not "${parsed.protocol}".`,
    };
  }
  if (parsed.search || parsed.hash) {
    return {
      status: 'invalid',
      problem: 'GOOGLE_OAUTH_REDIRECT_URI must not carry a query string or a fragment.',
    };
  }
  /*
   * The route is fixed, so a redirect URI pointing anywhere else is a typo that
   * would only surface as "state" errors on every sign-in. The PREFIX may vary
   * (a proxy mounting the API under a path), the tail may not.
   */
  if (!parsed.pathname.endsWith('/admin/auth/google/callback')) {
    return {
      status: 'invalid',
      problem:
        `GOOGLE_OAUTH_REDIRECT_URI must end in /admin/auth/google/callback (the API serves it at ` +
        `${GOOGLE_CALLBACK_PATH}); "${redirectUri}" does not.`,
    };
  }

  const allowedDomains = parseAllowedDomains(text(env, 'GOOGLE_OAUTH_ALLOWED_DOMAINS'));
  const badDomain = allowedDomains.find((d) => !DOMAIN.test(d));
  if (badDomain) {
    return {
      status: 'invalid',
      problem:
        `GOOGLE_OAUTH_ALLOWED_DOMAINS holds "${badDomain}", which is not a domain name. ` +
        'Give bare domains separated by commas, e.g. "bbcorp.trade" — no @, no scheme.',
    };
  }

  return {
    status: 'enabled',
    settings: {
      clientId,
      clientSecret,
      redirectUri,
      allowedDomains,
      cookiePath: parsed.pathname.slice(0, parsed.pathname.length - '/callback'.length),
    },
  };
}
