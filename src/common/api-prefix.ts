/**
 * The API's version prefix, in one place — PLATFORM-CONVENTIONS R-2.1.
 *
 * FOUR things must agree about this: `main.ts` (what the server serves),
 * `scripts/gen-openapi.mjs` (what the frontends generate their types from),
 * `test/openapi-routes.spec.ts` (what the route snapshot asserts), and anything
 * that makes a DECISION from the request path — `CsrfGuard` above all. If any
 * of them construct their own prefix, they can drift — and the failure is
 * silent in the worst direction: the document says one thing, the server serves
 * another, and the frontends type-check happily against the document.
 *
 * That is not hypothetical here. `VALIDATION_PIPE_OPTIONS` exists for exactly
 * this reason, and its comment records the same lesson: the validation spec used
 * to build its own pipe, so it would have kept passing if someone flipped
 * `forbidNonWhitelisted` off in main.ts. A test that defines the thing it
 * guards guards nothing.
 *
 * The fourth entry was added after it happened. `CsrfGuard` matched
 * `req.path.startsWith('/admin')` against a literal, so introducing this prefix
 * turned every admin path into `/v1/admin/...`, the test went false, the guard
 * took the portal branch, found no portal cookie and waved every admin write
 * through with no anti-forgery check at all. Match on `stripApiPrefix()`, never
 * on a literal.
 */
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';

export const API_VERSION_PREFIX = 'v1';

/**
 * The HTTP adapter every entry point must build the app with — `main.ts` and
 * `test/http-setup.ts` alike.
 *
 * IT EXISTS FOR ONE SETTING, and the setting is a security control.
 *
 * Express matches routes case-INSENSITIVELY by default while `req.path`
 * preserves the caller's casing, so a route can match while a guard's path test
 * misses. `GET /v1/Admin/clients` reached the admin controller and returned 200
 * with the RBAC-08 IP allowlist skipped and the admin branch of `CsrfGuard`
 * disarmed — both decided their surface with a case-sensitive
 * `startsWith('/admin')`. Session cookies are `path: '/'`, so authentication
 * still succeeded: one uppercase letter restored the entire admin surface from
 * a network the allowlist denies. `isAdminSurface()` below fixes the guards;
 * this makes the varied path stop being a route at all.
 *
 * WHY HERE rather than `app.set(...)` in the bootstrap, and why on an instance
 * we build ourselves: Express 5 realises its router the first time anything
 * touches it, and reads this setting once, at that moment. Two placements that
 * look correct are silent no-ops, both verified against the installed versions:
 *
 *   - `app.set(...)` in `main.ts` below `app.use(helmet())` — the first `use`
 *     already realised the router. Varied path still serves.
 *   - `new ExpressAdapter()` then `.getInstance().set(...)` — the adapter's own
 *     constructor realises it. Varied path still serves; the setting reads back
 *     as `true`, which is what makes this one genuinely deceptive.
 *
 * Only configuring a FRESH `express()` before handing it to the adapter works.
 * No error and no warning distinguishes the three, so the correct one lives in
 * a named function that both entry points call and nobody has to re-derive.
 *
 * This is why `express` is a direct dependency rather than a transitive one:
 * the code depends on its routing behaviour directly, and the version is pinned
 * exactly because that behaviour is what the guarantee rests on.
 */
export function createHttpAdapter(): ExpressAdapter {
  const instance = express();
  instance.set('case sensitive routing', true);
  return new ExpressAdapter(instance);
}

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
export function applyApiPrefix(app: NestExpressApplication): void {
  app.setGlobalPrefix(API_VERSION_PREFIX, { exclude: [...UNVERSIONED_ROUTES] });
}

/**
 * A request path with the version prefix removed, for code that must decide
 * something from the ROUTE rather than from the URL as served.
 *
 * Use this anywhere a path is compared against a known route. The unversioned
 * health probes pass through untouched, so one call site handles both.
 *
 * The prefix is matched CASE-INSENSITIVELY, and that is a security property
 * rather than a nicety — see `isAdminSurface` below for what it cost.
 * Casing in the rest of the path is preserved, because this returns a path,
 * not a decision.
 */
export function stripApiPrefix(path: string): string {
  const prefix = `/${API_VERSION_PREFIX}`;
  const head = path.slice(0, prefix.length).toLowerCase();
  if (head !== prefix) return path;
  if (path.length === prefix.length) return '/';
  return path[prefix.length] === '/' ? path.slice(prefix.length) : path;
}

/**
 * Whether a request is on the ADMIN surface — the single definition, because
 * two guards make security decisions from it and they must never disagree.
 *
 * CASE-INSENSITIVE, and this is the whole point of the function existing.
 *
 * Express routes case-INSENSITIVELY by default (`case sensitive routing` is off
 * and Nest never sets it), while `req.path` preserves whatever the caller sent.
 * So `GET /v1/Admin/clients` reached the admin controller and returned 200,
 * while both guards' `stripApiPrefix(req.path).startsWith('/admin')` evaluated
 * FALSE. `IpAllowlistGuard` skipped the check entirely — RBAC-08 defeated by
 * one uppercase letter, from any network, with cookies that are `path: '/'` and
 * therefore still sent. `CsrfGuard` took the portal branch, found no portal
 * cookie and waved the write through: the exact incident recorded above,
 * reachable again by a route it did not think to normalise.
 *
 * `createHttpAdapter()` above also makes the varied path 404 at the router, so
 * it never reaches a guard at all. Both fixes are kept deliberately: the router
 * setting is one line someone could drop while tidying Express config — and, as
 * its comment records, two plausible placements of it are silent no-ops — while
 * this function makes the guards correct on their own terms regardless.
 */
export function isAdminSurface(path: string): boolean {
  return stripApiPrefix(path).toLowerCase().startsWith('/admin');
}
