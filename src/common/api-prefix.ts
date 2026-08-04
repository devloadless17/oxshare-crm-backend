/**
 * The API's version prefix, in one place — PLATFORM-CONVENTIONS R-2.1.
 *
 * Three things must agree about this: `main.ts` (what the server serves),
 * `scripts/gen-openapi.mjs` (what the frontends generate their types from), and
 * `test/openapi-routes.spec.ts` (what the route snapshot asserts). If any of
 * them construct their own prefix, they can drift — and the failure is silent
 * in the worst direction: the document says one thing, the server serves
 * another, and the frontends type-check happily against the document.
 *
 * That is not hypothetical here. `VALIDATION_PIPE_OPTIONS` exists for exactly
 * this reason, and its comment records the same lesson: the validation spec used
 * to build its own pipe, so it would have kept passing if someone flipped
 * `forbidNonWhitelisted` off in main.ts. A test that defines the thing it
 * guards guards nothing.
 */
import type { INestApplication } from '@nestjs/common';

export const API_VERSION_PREFIX = 'v1';

/**
 * Routes served WITHOUT the version prefix.
 *
 * Only the health probes. A load balancer or uptime check should not have to
 * track API versions to ask whether the process is alive, and a readiness probe
 * that 404s during a version migration is an outage manufactured by the
 * monitoring rather than detected by it.
 */
export const UNVERSIONED_ROUTES = ['health', 'health/ready'] as const;

/** Apply the prefix. Called by main.ts, the OpenAPI generator, and the spec. */
export function applyApiPrefix(app: INestApplication): void {
  app.setGlobalPrefix(API_VERSION_PREFIX, { exclude: [...UNVERSIONED_ROUTES] });
}
