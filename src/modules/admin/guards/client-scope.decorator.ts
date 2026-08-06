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
 * every scoped route with an out-of-scope client and requires a 404 — and its
 * input list is DERIVED FROM THIS METADATA, so a route cannot enter the
 * "declared scoped" set without also being exercised.
 *
 * This mirrors `@RequirePermissions` / `@AnyAdmin` deliberately. Two mechanisms
 * for "state how this route is protected" would be two lists to keep in step;
 * one shape, twice, is something a reader learns once.
 */
