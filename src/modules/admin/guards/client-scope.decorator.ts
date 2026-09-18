import { SetMetadata } from '@nestjs/common';

export const CLIENT_SCOPE_KEY = 'client_scope_stance';

export interface ClientScopeStance {
  stance: 'scoped' | 'none';
  note: string;
}

/**
 * This route reads client-owned rows and APPLIES THE SCOPE IN THE QUERY.
 *
 * @param note where the predicate goes — the column and the store method — so a
 *   reviewer can check the claim without reading the whole service.
 */
export const ScopedToClients = (note: string) =>
  SetMetadata<string, ClientScopeStance>(CLIENT_SCOPE_KEY, { stance: 'scoped', note });

/**
 * This route reads NO client-owned rows, stated with the reason.
 *
 * @param reason why there is nothing to scope. Long enough to be a sentence,
 *   because "n/a" is what an exemption list fills up with.
 */
export const NotClientScoped = (reason: string) =>
  SetMetadata<string, ClientScopeStance>(CLIENT_SCOPE_KEY, { stance: 'none', note: reason });

/*
 * WHY THESE EXIST, given the scope predicate already lives in one helper.
 *
 * A helper only runs where somebody remembered to call it, and a route that
 * forgot looks exactly like a route that never needed it — both are just a
 * handler with no extra line. No reviewer reliably tells them apart in a diff,
 * and the consequence of missing it once is a scoped administrator quietly
 * shown client data they were specifically denied, with nothing failing.
 *
 * So the rule is inverted, exactly as R-4.2 inverts it for permissions: every
 * admin route must STATE a stance, and `test/client-scope-coverage.spec.ts`
 * fails CI on any that declares nothing. Forgetting becomes a red build instead
 * of a silent hole.
 *
 * The declaration is only half of it. A route can claim `@ScopedToClients` and
 * not actually scope anything, so `test/client-scope-enforcement.spec.ts` drives
 * scoped routes with an out-of-scope client and requires a 404.
 *
 * Its census READS THIS METADATA at runtime (`test/support/scope-facts.ts`), so
 * a scoped route that names an id in its path must either be driven there or be
 * listed with a reason why its parameter is not a client — a new one in neither
 * set fails that suite.
 *
 * ⚠️ That sentence used to read "its input list is DERIVED FROM THIS METADATA,
 * so a route cannot enter the declared-scoped set without also being exercised",
 * and it was false for as long as it existed: the list was seven hand-written
 * entries against thirty-seven declarations, and the helper written to derive
 * them was exported and never imported — nor could it have been, since it read
 * state only its own spec's `beforeAll` assigns. Recorded rather than quietly
 * corrected, because a decorator's docblock asserting a guarantee is exactly
 * what stops the next person checking for one. Driving the routes it had been
 * promising to drive immediately found two answering 200.
 *
 * This mirrors `@RequirePermissions` / `@AnyAdmin` deliberately. Two mechanisms
 * for "state how this route is protected" would be two lists to keep in step;
 * one shape, twice, is something a reader learns once.
 */
