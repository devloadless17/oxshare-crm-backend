import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { resolveGoogleOauth, type GoogleOauthSettings } from '../../../config/google-oauth';
import type { DeviceFingerprint } from '../../../common/security/refresh-tokens.service';
import { AdminAuthService } from '../admin-auth.service';
import { GOOGLE_AUTHORIZE_URL, GoogleOidcClient, safeEqual } from './google-oidc.client';
import { GoogleSignInError, type GoogleErrorCode } from './google-sign-in.error';
import {
  GOOGLE_FLOW_TTL_MS,
  googleFlowCookieName,
  googleFlowCookieOptions,
  googleFlowKey,
  openGoogleFlow,
  pkceChallenge,
  randomToken,
  readGoogleFlowCookie,
  safeGoogleNext,
  sealGoogleFlow,
  type GoogleFlowState,
} from './google-flow-cookie';

/**
 * Whether Google sign-in is on, and with what — read from the validated
 * environment through the same `resolveGoogleOauth` boot used. A class of its
 * own so a spec can substitute settings without rebuilding the config module.
 */
@Injectable()
export class GoogleOauthConfig {
  constructor(private readonly config: ConfigService) {}

  settings(): GoogleOauthSettings | null {
    const resolved = resolveGoogleOauth({
      GOOGLE_OAUTH_CLIENT_ID: this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID'),
      GOOGLE_OAUTH_CLIENT_SECRET: this.config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET'),
      GOOGLE_OAUTH_REDIRECT_URI: this.config.get<string>('GOOGLE_OAUTH_REDIRECT_URI'),
      GOOGLE_OAUTH_ALLOWED_DOMAINS: this.config.get<string>('GOOGLE_OAUTH_ALLOWED_DOMAINS'),
      API_PUBLIC_URL: this.config.get<string>('API_PUBLIC_URL'),
    });
    // `invalid` cannot reach here — boot refuses it — but if it ever did, OFF
    // is the safe reading.
    return resolved.status === 'enabled' ? resolved.settings : null;
  }
}

/**
 * The OpenID Connect authorization-code flow with PKCE (S256), run entirely on
 * the API host.
 *
 * Why here and not in the console: in production the console (ADMIN_URL) and
 * the API are different hosts, and the session cookies are `__Host-` cookies
 * of the API host. So the browser goes API → Google → API, the session is set
 * on the API's own response, and only then is it sent back to the console
 * with a 302 — which then cold-loads exactly like a page reload (the
 * anti-forgery token is re-learnt from `/admin/auth/me`'s echoed header).
 */
@Injectable()
export class AdminGoogleAuthService {
  private readonly logger = new Logger(AdminGoogleAuthService.name);

  constructor(
    private readonly google: GoogleOauthConfig,
    private readonly oidc: GoogleOidcClient,
    private readonly auth: AdminAuthService,
    private readonly config: ConfigService,
  ) {}

  isEnabled(): boolean {
    return this.google.settings() !== null;
  }

  private adminUrl(): string {
    return this.config.get<string>('ADMIN_URL', 'http://localhost:3002').replace(/\/+$/, '');
  }

  private flowKey(): Buffer {
    return googleFlowKey(this.config.getOrThrow<string>('ADMIN_JWT_SECRET'));
  }

  /** Where a refusal lands — the invite screen in invite mode, else sign-in. */
  private failureUrl(code: GoogleErrorCode, flow?: GoogleFlowState): string {
    if (flow?.mode === 'invite' && flow.invite) {
      const query = new URLSearchParams({ token: flow.invite, google_error: code });
      return `${this.adminUrl()}/invite/accept?${query.toString()}`;
    }
    const query = new URLSearchParams({ google_error: code });
    if (flow && flow.next !== '/dashboard') query.set('next', flow.next);
    return `${this.adminUrl()}/login?${query.toString()}`;
  }

  /**
   * `GET /admin/auth/google/start` — mint the flow, set its signed cookie and
   * return Google's authorization URL. Returns the console's error URL when
   * the feature is off.
   */
  start(query: { next?: unknown; invite?: unknown }, res: Response): string {
    const settings = this.google.settings();
    if (!settings) return this.failureUrl('disabled');

    const invite =
      typeof query.invite === 'string' && query.invite !== '' && query.invite.length <= 256
        ? query.invite
        : undefined;
    const flow: GoogleFlowState = {
      state: randomToken(),
      nonce: randomToken(),
      verifier: randomToken(),
      mode: invite ? 'invite' : 'login',
      ...(invite ? { invite } : {}),
      next: invite ? '/dashboard' : safeGoogleNext(query.next),
      exp: Date.now() + GOOGLE_FLOW_TTL_MS,
    };
    res.cookie(
      googleFlowCookieName(),
      sealGoogleFlow(flow, this.flowKey()),
      googleFlowCookieOptions(settings.cookiePath, GOOGLE_FLOW_TTL_MS),
    );

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: settings.clientId,
      redirect_uri: settings.redirectUri,
      scope: 'openid email profile',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: pkceChallenge(flow.verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    // A HINT only (it pre-filters Google's account chooser); the ID token's
    // `hd` claim is what is actually enforced.
    if (settings.allowedDomains.length > 0) params.set('hd', settings.allowedDomains[0]);
    return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
  }

  /**
   * `GET /admin/auth/google/callback` — always clears the flow cookie, then
   * returns where the browser goes next: the console on success, or the
   * console with `?google_error=<code>`.
   */
  async callback(
    query: Record<string, unknown>,
    req: Request,
    res: Response,
    device: DeviceFingerprint,
  ): Promise<string> {
    const settings = this.google.settings();
    // Cleared FIRST, whatever happens next: a flow is single-use.
    res.clearCookie(
      googleFlowCookieName(),
      googleFlowCookieOptions(settings?.cookiePath ?? '/v1/admin/auth/google'),
    );
    if (!settings) return this.failureUrl('disabled');

    const opened = openGoogleFlow(
      readGoogleFlowCookie(req.cookies as Record<string, string | undefined> | undefined),
      this.flowKey(),
    );
    const flow = opened.ok ? opened.flow : undefined;

    try {
      // The person said no (or Google refused) — before anything else, but
      // only acted on for a flow this browser really started.
      if (typeof query.error === 'string') {
        return this.failureUrl(flow ? 'cancelled' : 'state', flow);
      }
      if (!opened.ok) return this.failureUrl(opened.reason === 'expired' ? 'expired' : 'state');
      const verifiedFlow = opened.flow;
      if (typeof query.state !== 'string' || !safeEqual(query.state, verifiedFlow.state)) {
        return this.failureUrl('state', verifiedFlow);
      }
      if (typeof query.code !== 'string' || query.code === '' || query.code.length > 2048) {
        return this.failureUrl('exchange', verifiedFlow);
      }

      const idToken = await this.oidc.exchangeCode({
        code: query.code,
        codeVerifier: verifiedFlow.verifier,
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        redirectUri: settings.redirectUri,
      });
      const identity = await this.oidc.verifyIdToken(idToken, {
        clientId: settings.clientId,
        nonce: verifiedFlow.nonce,
        allowedDomains: settings.allowedDomains,
      });

      await this.auth.signInWithGoogle({
        identity,
        mode: verifiedFlow.mode,
        invite: verifiedFlow.invite,
        res,
        req,
        device,
      });
      return `${this.adminUrl()}${verifiedFlow.next}`;
    } catch (error) {
      if (error instanceof GoogleSignInError) {
        this.logger.warn(`Google sign-in refused: ${error.reason}`);
        return this.failureUrl(error.reason, flow);
      }
      this.logger.error(
        `Google sign-in failed unexpectedly: ${error instanceof Error ? error.message : 'unknown'}`,
        error instanceof Error ? error.stack : undefined,
      );
      return this.failureUrl('server', flow);
    }
  }
}
