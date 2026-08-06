import { DocumentBuilder } from '@nestjs/swagger';
import { COOKIE_BASES } from './security/session-cookies';

/**
 * The OpenAPI document's configuration, in ONE place.
 *
 * It was in two: `main.ts` built it for the live `/api/docs`, and
 * `scripts/gen-openapi.mjs` built its own copy for the committed
 * `openapi.json` — the file **both frontends generate their types from**.
 *
 * They drifted, in the direction that matters. `main.ts` was migrated to cookie
 * auth naming the real cookies; the generator was not, and went on declaring
 * `.addBearerAuth()` — a scheme this API never reads — plus a cookie named
 * `access_token`, which `session-cookies.ts` LEGACY_COOKIE_NAMES **actively
 * deletes**. So the contract every frontend type is generated from described a
 * credential that cannot work, on 78 of 90 operations.
 *
 * Nothing caught it because `test/openapi-routes.spec.ts` also built its own
 * `DocumentBuilder`, so it would have kept passing while the real Swagger config
 * regressed. That is the exact failure mode `applyApiPrefix()` and
 * `VALIDATION_PIPE_OPTIONS` were extracted to prevent, and this is the third
 * instance of it.
 *
 * One definition, three readers. A change here reaches the served document, the
 * committed contract and the route-inventory test together, or it reaches none
 * of them.
 */
export function buildSwaggerConfig() {
  return (
    new DocumentBuilder()
      .setTitle('OxShare CRM API')
      .setDescription('Forex/CFD Introducing-Broker CRM — Phase 1')
      .setVersion('1.0')
      /*
       * Cookie auth only, and named from `COOKIE_BASES` rather than as literals.
       *
       * `.addBearerAuth()` advertised a scheme the API does not accept — the
       * session is an httpOnly cookie on both surfaces (R-3.2) — so Swagger's
       * Authorize button configured a credential that could not work, and every
       * generated client described one too.
       */
      .addCookieAuth(COOKIE_BASES.clientAccess, {
        type: 'apiKey',
        in: 'cookie',
        name: COOKIE_BASES.clientAccess,
        description: 'Portal session. Set by POST /v1/auth/login; httpOnly, so not settable here.',
      })
      .addCookieAuth(
        COOKIE_BASES.adminAccess,
        {
          type: 'apiKey',
          in: 'cookie',
          name: COOKIE_BASES.adminAccess,
          description:
            'Admin session. Set by POST /v1/admin/auth/login; httpOnly, so not settable here.',
        },
        'admin',
      )
      .addTag('identity', 'Users, registration, attribution')
      .addTag('trading', 'MT5 accounts, groups, deal ingestion')
      .addTag('wallet', 'Balances, ledger, transactions')
      .addTag('payments', 'Deposits, withdrawals, Whish/USDT')
      .addTag('partners', 'IB programs, commission engine, payouts')
      .addTag('compliance', 'KYC documents, verification levels')
      .addTag('admin', 'Back-office endpoints, RBAC')
      .build()
  );
}
