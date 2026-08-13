/**
 * "Open this client's wallets" — the capability, without the module behind it.
 *
 * ## Why a port rather than an import
 *
 * `AuthService` opens a client's wallets on registration. Importing
 * `WalletModule` to do it recreates the identity ↔ wallet cycle that
 * `identity.module.ts` records as "cheap to add and expensive to notice".
 *
 * Providing `WalletProvisioningService` from the @Global `StoreModule` was
 * tried first and is worse: `store/`, `common/`, `config/` and `database/` are
 * depended UPON by modules and never the reverse, so it fails the layering lint
 * rule — correctly. That rule's own message names the fix: "invert with an
 * interface".
 *
 * So identity depends on this DECLARATION, which lives in `common/` where both
 * sides may reach it, and `WalletModule` binds the implementation. The edge
 * runs module → common, like every other shared piece.
 *
 * An event bus would also have worked. It would have meant adding
 * `@nestjs/event-emitter` for one call site, which is a larger change than the
 * problem.
 */
export interface WalletProvisioningPort {
  /**
   * A wallet in every enabled currency. Idempotent, and NEVER throws.
   *
   * The no-throw contract is the important half. A registration that fails
   * after the user row is committed leaves an account nobody can sign into and
   * nobody can re-create, because the address is taken — so an implementation
   * logs and returns rather than propagating.
   */
  openAllEnabledWallets(userId: string): Promise<void>;
}

/*
 * ── Why the currency BACKFILL is not on this port ────────────────────────────
 *
 * Enabling a currency opens that wallet for every existing client, and the
 * obvious home for it was another method here — `CurrenciesService` would inject
 * the same token `AuthService` does.
 *
 * It does not work, and it fails in the worst way. `WalletModule` imports
 * `CurrenciesModule` (provisioning asks it which currencies are enabled), so
 * binding the currency side to a token `WalletModule` provides closes the loop.
 * `WalletModule` being `@Global()` makes the token VISIBLE but does not make the
 * instantiation orderable: Nest hung on `createApplicationContext` with no
 * error and no stack — just an unsettled promise and a process that exits when
 * the event loop drains.
 *
 * The backfill lives on `WalletsStore` instead, in the `@Global()` `StoreModule`
 * that both sides already depend upon, so it adds no edge in either direction.
 * The port stays for the one capability that genuinely needs the wallet MODULE's
 * knowledge of enabled currencies.
 */

/**
 * Injection token.
 *
 * A `Symbol` rather than the interface name: an interface is erased at compile
 * time and cannot be a Nest token, and a string token would collide silently
 * with any other module that picked the same words.
 */
export const WALLET_PROVISIONING = Symbol('WALLET_PROVISIONING');
