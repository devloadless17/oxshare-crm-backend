import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EVERY ADMIN ROUTE DECLARES THE SHAPE OF WHAT IT RETURNS.
 *
 * ## Why this is the masking census, and not a stance decorator
 *
 * RBAC-03 masking is opt-in per response, and it has now failed nine times. The
 * instrument that found four of those in a day is mechanical: resolve each admin
 * route's declared response schema, look for client-owned fields — email, name,
 * phone — and compare that against the services which actually call `applyMask`.
 * Twenty routes returned client-shaped fields with no mask; twelve were the
 * operator's own record and correctly exempt, and eight were real.
 *
 * That instrument has exactly one blind spot, and it is this file's subject: a
 * route declaring NO response schema presents no field to ask about. Two of the
 * nine exposures lived there — the wallet CSV, and the address handed back by
 * opening a trading account — and both were invisible to a scan that had already
 * been run over the whole surface and reported it clean.
 *
 * So the guarantee worth enforcing is not "every route states a masking stance",
 * which is 170 sentences nobody will keep true. It is:
 *
 *     no route may return JSON whose shape is undeclared,
 *     and the set of existing exceptions may not grow.
 *
 * That is one line of work per new endpoint, it is owed anyway — both frontends
 * generate their types from these schemas — and it is the prerequisite for
 * masking by shape (`mask-by-shape.ts`), which cannot protect a response whose
 * type nothing declares.
 *
 * ## What this file reads
 *
 * The committed `openapi.json`, produced by Nest's own Swagger scanner, rather
 * than this file's own reflection. `openapi-routes.spec.ts` already pins that
 * document against the live route table, so a stale document fails there first
 * and cannot make this one pass by describing a smaller API than exists.
 */

const SPEC = join(__dirname, '..', 'openapi.json');

interface OpenApiDocument {
  paths: Record<string, Record<string, { responses?: unknown }>>;
}

const VERBS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** `GET /admin/clients/:id`, matching the shape the exemption lists are written in. */
function signature(verb: string, path: string): string {
  return `${verb.toUpperCase()} ${path.replace(/^\/v1\//, '/').replace(/\{(\w+)\}/g, ':$1')}`;
}

/** Admin-surface routes, plus the upload routes that serve client documents. */
const governed = (path: string) => path.startsWith('/v1/admin') || path.startsWith('/v1/uploads');

function routesWithoutAResponseSchema(): string[] {
  const doc = JSON.parse(readFileSync(SPEC, 'utf8')) as OpenApiDocument;
  const found: string[] = [];

  for (const [path, operations] of Object.entries(doc.paths)) {
    if (!governed(path)) continue;
    for (const verb of VERBS) {
      const operation = operations[verb];
      if (!operation) continue;
      const declaresASchema = /#\/components\/schemas\//.test(
        JSON.stringify(operation.responses ?? {}),
      );
      if (!declaresASchema) found.push(signature(verb, path));
    }
  }
  return found.sort();
}

/**
 * Routes that return no JSON body, and therefore declare no response schema.
 *
 * Listed rather than pattern-matched, because "it looks like an export" is the
 * kind of rule that quietly grows to cover a route that is not one.
 */
const NO_JSON_BODY: readonly string[] = [
  // A 204 and nothing else.
  'DELETE /admin/agencies/:id',
  'DELETE /admin/currencies/:code',
  'DELETE /admin/external-links/:id',
  'DELETE /admin/ib-commission-types/:id',
  'DELETE /admin/ib-levels/:level',
  'DELETE /admin/kyc-config/steps/:id',
  'DELETE /admin/leverages/:ratio',
  'DELETE /admin/products/:id',
  'DELETE /admin/tags/:id',
  'DELETE /admin/wallets/:id',
  // A byte stream — a CSV or a stored file. A response interceptor cannot mask
  // a stream, which is exactly why every export masks its ROWS before they are
  // serialised (`AdminExportService`), and why that is not an inconsistency.
  'GET /admin/admin-users/export',
  'GET /admin/audit-log/export',
  'GET /admin/clients/export',
  'GET /admin/currencies/export',
  'GET /admin/deposits/export',
  'GET /admin/ib/accruals/export',
  'GET /admin/ib/applications/export',
  'GET /admin/ib/partners/export',
  'GET /admin/kyc/export',
  'GET /admin/ledger/export',
  'GET /admin/payment-methods/export',
  'GET /admin/roles/export',
  'GET /admin/tags/export',
  'GET /admin/trading-accounts/export',
  'GET /admin/transactions/export',
  'GET /admin/wallets/export',
  'GET /admin/withdrawals/export',
  'GET /uploads/admin-avatars/:file',
  'GET /uploads/avatars/:file',
  'GET /uploads/deposit-proofs/:file',
  'GET /uploads/kyc/:file',
  'GET /uploads/payment-logos/:file',
];

/**
 * Routes returning JSON with NO declared shape — the census's blind spot.
 *
 * The list is frozen so that a NEW undeclared route fails this suite rather than
 * joining them silently: the wallet CSV and the trading-account create both
 * leaked from inside a list exactly like this one, and both were invisible to a
 * scan that reads declared schemas.
 *
 * The way OFF this list is to give the route a response DTO, not to add a line.
 *
 * ⚠️ THIS COMMENT USED TO SAY "every one has been read by hand and carries no
 * client-owned field", AND THAT WAS FALSE OF THE FIRST THREE.
 *
 * `/admin/ib/{accruals,applications,partners}` all return client email, first
 * name and last name — the accrual ledger returns two people's. Because they
 * declare no shape, `FieldMaskInterceptor` passed them through untouched, so
 * every one of them handed a reviewer whose role hides `client.email` exactly
 * the field their own screens withheld. Every OTHER route in that controller
 * declares a shape, which is what made the three invisible: nothing looked
 * unusual about them except the absence.
 *
 * The sentence is worth recording rather than quietly deleting, because it is
 * what kept anyone from re-checking. A reassuring line above a list is read
 * instead of the list.
 *
 * They are masked EXPLICITLY now — `ib-list-mask.dto.ts`, called from the
 * controller, the same way the CSV exports mask rows the interceptor cannot
 * reach — and `field-masking-http.spec.ts` asserts all three over real HTTP.
 * They stay on this list because they still declare no shape: the leak is
 * closed, the typing gap is not, and pretending otherwise would repeat exactly
 * the mistake above. Giving them real response DTOs remains the way off.
 */
const AUDITED_WITHOUT_A_SHAPE: readonly string[] = [
  // ⚠️ These two DO carry client-owned fields. See the note above: masked
  // explicitly in the controller, not by the interceptor. The third,
  // `GET /admin/ib/partners`, left this list the way the note says to: it
  // declares `IbPartnerListResponseDto` since the Partners page returned.
  'GET /admin/ib/accruals',
  'GET /admin/ib/applications',
  'GET /admin/kyc-config',
  'GET /admin/mt5/groups',
  'GET /admin/trading-accounts/:id/live',
  'POST /admin/ib/accruals/:id/reverse',
  'POST /admin/kyc-config/reset',
  'POST /admin/kyc-config/steps',
  'POST /admin/wallets',
  'PUT /admin/kyc-config',
  'PUT /admin/kyc-config/steps/:id',
];

describe('the response-shape census', () => {
  it('finds a meaningful number of routes, so it cannot pass vacuously', () => {
    /*
     * The R-4.2 lesson, and it applies with force here: every assertion below is
     * "the undeclared set is no bigger than this". If the document moved, or the
     * path prefix changed, an empty scan satisfies all of them while examining
     * nothing at all.
     */
    const doc = JSON.parse(readFileSync(SPEC, 'utf8')) as OpenApiDocument;
    const admin = Object.keys(doc.paths).filter(governed);
    expect(
      admin.length,
      'the scan found almost no admin routes — check the prefix',
    ).toBeGreaterThan(100);
  });

  it('lets no NEW route return JSON without a declared shape', () => {
    /*
     * The load-bearing assertion. A new undeclared JSON route is invisible to
     * the field-level census, un-typed for both frontends, and unprotectable by
     * masking-by-shape — so it fails here, on the day it is written, rather than
     * being found leaking later by somebody reading services by hand.
     */
    const undeclared = routesWithoutAResponseSchema();
    const known = new Set([...NO_JSON_BODY, ...AUDITED_WITHOUT_A_SHAPE]);
    const added = undeclared.filter((route) => !known.has(route));

    expect(
      added,
      'These routes return JSON with no declared response type. Give each one a ' +
        'response DTO and @ApiOkResponse({ type: ... }) — do NOT add it to the ' +
        `exemption list, which is frozen at its audited contents:\n${added
          .map((r) => `  ${r}`)
          .join('\n')}`,
    ).toEqual([]);
  });

  it('keeps the exemption lists honest — no entry outlives its route', () => {
    /*
     * The other direction, and the reason it matters: an exemption for a route
     * that has since been given a DTO (or deleted) is a line that looks like
     * due diligence and protects nothing. Left alone, the list decays into
     * exactly the "n/a" register the declare-or-explain convention exists to
     * prevent.
     */
    const undeclared = new Set(routesWithoutAResponseSchema());
    const stale = [...NO_JSON_BODY, ...AUDITED_WITHOUT_A_SHAPE].filter((r) => !undeclared.has(r));

    expect(
      stale,
      `These are exempted but now declare a shape, or no longer exist. Delete ` +
        `them from the list:\n${stale.map((r) => `  ${r}`).join('\n')}`,
    ).toEqual([]);
  });

  it('holds the audited-JSON list at its reviewed size', () => {
    /*
     * Named separately from the assertion above because these two lists carry
     * different promises. A stream cannot be masked and never will be. A JSON
     * route with no shape is a gap somebody has read and cleared BY HAND — nine
     * exposures say hand-checking is what runs out — so the count is pinned, and
     * it may go DOWN as routes gain DTOs and never up.
     */
    /*
     * EXACTLY the list's length, not a ceiling above it. The cap stood at 13
     * over a 12-entry list, so one route could join without anything turning
     * red. `PATCH /admin/clients/:id/status` left on 28 Sep 2026 when it gained
     * `ClientAccountDto` (it had answered masked fields in the clear). Lower
     * this with every route that gains a shape; never raise it.
     */
    expect(
      AUDITED_WITHOUT_A_SHAPE.length,
      'this list may only shrink — a new entry means a route was exempted rather than typed',
    ).toBeLessThanOrEqual(11);
  });
});
