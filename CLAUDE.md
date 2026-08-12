# oxshare-crm-backend

> Cross-repo context — doc authority, ports, auth cookies, the `/api` rewrite, the §6 money
> rules, and the quality-gate machinery — lives in `../CLAUDE.md`. This file is only what is
> specific to this repo. If the two disagree, `../CLAUDE.md` wins on facts about the system
> and this file wins on conventions inside this directory.

NestJS 11 API on **:3001**. Every route is served under **`/v1`** — `main.ts` calls
`applyApiPrefix()` (`src/common/api-prefix.ts`), which sets the global prefix and excludes only
the health probes. Routes still carry no `/api`; that prefix belongs to the frontends' own-origin
rewrite, which now targets `http://localhost:3001/v1/:path*`.

**Anything that decides something from `req.path` must strip the prefix with `stripApiPrefix()`,
never match a literal.** `CsrfGuard` matched `'/admin'` directly, so introducing `/v1` silently
disarmed anti-forgery checking on every admin write — the guard took the portal branch, found no
portal cookie, and concluded there was nothing to protect.

## Layer map

```
src/main.ts          helmet, cookieParser, global ValidationPipe, CORS, Swagger at /api/docs
src/app.module.ts    ConfigModule(validate), ScheduleModule, Throttler, APP_FILTER, APP_GUARD
src/common/          errors/domain-errors.ts · filters/all-exceptions.filter.ts
                     logging/{json.logger,request-context} · middleware/request-id.middleware
src/config/          env.validation.ts (zod, refuses boot on bad config) · permissions.json
src/database/        schema.ts · db.ts · seed.ts · migrations/  ← NEVER hand-edit migrations
src/store/           *.store.ts — injectable Drizzle repositories, @Global() StoreModule
src/modules/<name>/  controller + service(s) + dto/ + guards/ + strategies/
test/                *.spec.ts — the four ARCHITECTURE §11 money acceptance tests
```

Files are kebab-case with a dot-suffix role: `admin-auth.service.ts`, `jwt-auth.guard.ts`,
`users.store.ts`. Modules are flat — no `application/`/`domain/`/`infra/` layering.

## Errors: throw domain, map once

Services and stores throw the `DomainError` subclasses from `common/errors/domain-errors.ts`
(`NotFoundError`, `ValidationError`, `AuthenticationError`, `AuthorizationError`,
`ConflictError`, `MoneyRuleError`) and never import HTTP types. `AllExceptionsFilter` is the
single mapping point and emits `{ statusCode, code, message, requestId, timestamp, path }`.

`HttpException` is legitimate **only at the transport edge** — controllers, guards, strategies,
pipes, filters. Lint enforces this: it is a `no-restricted-imports` error inside `*.service.ts`,
`store/**` and `commission.ts`. Adding a new failure mode means adding a `DomainError` subclass
with a `code`, not a new HTTP throw.

## The two client-facing reads added for the portal

Both are authenticated but **not** permission-gated, so the owner comes from the session and
**never** from a parameter (R-4.4). That is the entire distance between "my data" and "anyone's
data" — the admin equivalents take a `userId` filter precisely because they *are* gated.

- **`GET /trading/accounts`** (`modules/trading/`) — the client's own accounts, live before demo,
  unpaginated because a client holds a handful rather than a growing log. Returns `balance` (the
  CRM-held figure a transfer credits) and deliberately **no equity, margin or open positions**:
  there is no MT5 bridge, nothing here holds them, and a fabricated equity beside a real login is
  the most expensive kind of wrong number on a trading product. `GET /trading/accounts/transferable`
  narrows to live+active for the transfer screen — it shapes what is *offered*; `TransfersService`
  still owns the refusal.
- **`GET /ib/overview`** (`modules/ib/ib-overview.service.ts`) — the partner dashboard: level and
  rate, earnings, referred clients, direct sub-partners. 404s for a non-partner, because zeroes
  across the board would render as a partner dashboard belonging to somebody who is not one.
- **`GET /trading/positions`** — open (default) or closed trades. See the empty-table note below.
- **`GET /dashboard`** (`modules/trading/dashboard.service.ts`) — wallets, recent transactions,
  trading accounts, open positions and five counts, in ONE request. One rather than six because
  these are read in a single glance: a balance from one instant beside a transaction list from
  another is a screen that contradicts itself, and six requests give the portal six ways to
  half-fail. Every figure is `count()`-ed from a table; the screen it replaces carried hardcoded
  zeros for "trading accounts" and "pending transactions", so a client holding three read 0.

### `positions` is created EMPTY on purpose (migration 0041)

Nothing writes to it. There is no MT5 bridge, so no ingestion path exists and no row can appear by
any route the app offers. It exists so the portal renders against a **real query returning zero
rows** rather than a hardcoded empty state that would need rewriting the day a feed lands.

That distinction has cost this codebase twice: a screen showing a fixed "nothing here" is
indistinguishable from one whose query genuinely found nothing — the accounts page once told a
client with three live accounts they had none, and the wallet showed `$0.00` to somebody holding
$700. A real table makes "no open positions" an answer the database gave.

**When the bridge lands** it owns the INSERT/UPDATE and owes this table the idempotency
`positions_account_ticket_uq` provides — scoped to the account, because a ticket is only unique
within the server that issued it.

`close_price`, `closed_at` and `profit` are nullable because they do not exist while a trade is
open; defaulting them to zero would make an open position look like a closed one that broke even.
`profit` is the **realised** result only. Unrealised P/L is deliberately absent everywhere — it
changes on every tick, so a stored copy is stale the moment it is written.

Referred clients come from `users.referred_by_ib_user_id` (written at registration) and carry
**no email address**: a partner is owed attribution, not their referrals' contact details.
Sub-partners are **direct only** — one hop — because payout resolution stops at a single
`parent_ib_id`, and showing a deep tree would display a structure the payout logic does not honour.

## The commission engine (`modules/ib/commission*`)

Rebuilt after migration 0028 deleted the original. It is **not** a restore: that one computed from
MT5 `deals` (spread × volume) through an `ib_programs` table, and both are gone with the bridge —
rebuilding against them would be an engine that can never run.

This one computes from what the system actually has: a **client deposit**, attributed by
`users.referred_by_ib_user_id`, split along the `ib_levels` ladder.

```
deposit settles → accrueForDeposit → ib_accruals (pending, no money moved)
hourly @Cron    → confirmPending   → wallet credit + status=confirmed
```

- **`commission.ts` is a pure seam** — no Nest, no Drizzle, no `store/`. `resolveChain`,
  `calculate` and `checkPlausible` live there so every boundary case is one assertion.
  `commission.spec.ts` covers them and was mutation-checked.
- **Two steps, deliberately.** A commission is earned at one moment and payable at another.
  Crediting at accrual time makes it irreversible before the revenue behind it settles.
- **Every step is idempotent via DB constraints**, never check-then-insert:
  `ib_accruals_source_earner_uq` absorbs a replayed accrual,
  `ledger_entries_wallet_reference_uq` absorbs a replayed credit. Safe under at-least-once
  delivery, which is what makes the `@Cron` → BullMQ move a no-op later.
- The confirm credit is keyed on the **accrual id**, not the transaction — one deposit can pay two
  partners, and keying on the transaction would make the L2 credit look like a replay of the L1's
  and silently drop it.

### Three refusals worth knowing about

- **`per_lot` levels accrue nothing on a deposit.** The rate is an amount per standard lot and a
  deposit has no lot count, so there is no honest number. It refuses with a logged reason rather
  than treating the rate as a percentage — which would pay a plausible wrong figure.
- **A suspended partner earns nothing AND breaks the chain.** Their parent does not keep collecting
  through them; suspension is a decision about the whole subtree.
- **`checkPlausible` refuses a total exceeding the revenue it is a share of.** That is the unit-error
  backstop: a rate meaning 70× rather than 70% would otherwise accrue seventy times the deposit.
  It refuses rather than clamping, so the deposit stays re-accruable once the rate is fixed.

### `earnings.engineLive` is a READ, not a constant

`CommissionService.isEngineLive()` asks whether any **confirmed** accrual exists. It flips true on
its own the first time the pipeline pays somebody — no code change, and no risk of reading false
while real money moves. Deliberately not `lifetime !== '0'`, which is per-partner and would tell a
brand-new partner on a working platform that nothing is being calculated.

### The wiring is a PORT, not a module import

`TransactionsService` injects `COMMISSION_ACCRUAL`
(`common/provisioning/commission-accrual.port.ts`) rather than importing `IbModule` — both modules
depend on `WalletModule`, so a direct import is a cycle. Same recipe `WalletModule` uses to expose
`WALLET_PROVISIONING` to identity, `@Global()` included.

The port contract is **idempotent and never throws**, and the no-throw half is load-bearing: by the
time it runs the client's deposit has already credited. A commission failure must not roll that
back. A missing accrual is recoverable by re-running; a reversed deposit is a support incident.

**Migrations are hand-written from 0027 onwards** (see the header of `0040_ib_accruals.sql`): the
committed drizzle snapshots stop at 0026, so `drizzle-kit generate` diffs against a stale baseline
and prompts to rename a dozen unrelated enums. Write the SQL to match `schema.ts` and add the
journal entry by hand.

## Money code — read ARCHITECTURE §6 and §8.6 first

`src/modules/wallet/`, `src/modules/partners/`, `src/modules/payments/`.

- **`money.ts` and `commission.ts` are pure seams.** No Nest, no Drizzle, no `database/`, no
  `store/` — lint blocks those imports. `resolveChain`, `calculate`, `wouldCreateCycle` and
  `availableAt` live there precisely so they are unit-testable without a container.
- **Never coerce.** `Number()`, `parseFloat` and `parseInt` are lint errors in these modules.
  Every monetary value is a `NUMERIC(28,8)` column, a decimal.js `Decimal` in code, and a
  **string** across the API boundary.
- **The write shape is fixed:** `SELECT … FOR UPDATE` → compute → `INSERT ledger_entry` (with
  `balance_after`) → `UPDATE wallets`, in one transaction. Do not split it across a new layer.
- **Idempotency lives in DB constraints**, never check-then-insert.
- **`ledger_entries` is append-only** — a TRIGGER rejects UPDATE/DELETE. Corrections are
  compensating rows.
- Resolution stops at **L2**: a single `parent_ib_id`, no closure table, no recursive CTE.

Both layers now take the db by constructor injection. `store/*.store.ts` classes use
`@Inject(DRIZZLE_DB)`; the four money services (`wallet`, `transactions`, `commission`,
`programs`) do the same and use Drizzle inline — they previously called the module-level
`getDb()` singleton from inside each method, and a lint rule now blocks importing it here.
Not extracting a *store layer* for money is deliberate: §11 requires those tests to run against
**real Postgres via Testcontainers**, so a fake-substitution seam would buy them nothing, while
moving `FOR UPDATE` across a new boundary would cost real risk. `test/di-wiring.spec.ts` resolves
each money service from the real module graph, which the hand-constructed money specs cannot. `database/db.ts` exports an `Executor` type so a store method can join a
caller's transaction.

## Realtime — a second listener, on purpose

The WebSocket does **not** run on :3001. `REALTIME_ENGINE=uws` (the default) runs Socket.IO on
uWebSockets.js, which owns its own TCP listener, so the socket is on **`REALTIME_PORT`, 3003**.
`REALTIME_ENGINE=node` attaches it to the API port instead and is the one-variable revert.
`common/realtime/realtime-io.adapter.ts` is the entire seam — nothing above it knows which engine
is running.

**In production the realtime origin must share the API's HOSTNAME.** Cookies ignore the port, so a
different port is fine; `__Host-` cookies are host-scoped by design, so a realtime *subdomain*
would receive no cookie and every handshake would be refused with nothing to explain why. Route
`wss://api…` to the realtime port at the ingress.

`modules/notifications/realtime.gateway.ts` holds the rooms (`admin:<id>` / `client:<id>` — the
kind is part of the name so two audiences cannot collide on a shared uuid) and the Postgres
`LISTEN`. **The bus is the database, not the application**: `pg_notify` fires from an AFTER INSERT
trigger (migration 0047) and is delivered only on COMMIT, so a rolled-back money transaction
cannot announce itself. That also removes the need for a Redis adapter — every instance LISTENs.

`realtime.principal.ts` authenticates the handshake by calling `AdminAuthenticator.authenticate`
and `JwtStrategy.validate` — the same objects the HTTP guards use. Do not re-implement those
checks for sockets; that is how two authorization paths drift until one is missing an enforcement
point. Sockets close at token expiry (15-minute ceiling) so the reconnect re-authenticates.

## Validation

The global `ValidationPipe` (`whitelist`, `transform`) only validates where a **DTO class**
exists to reflect on — a `@Body()` typed as an inline object literal is validated by nothing.
So: request DTOs live in `<module>/dto/*.dto.ts`, as classes, with class-validator decorators
**paired with** `@ApiProperty`. `modules/identity/dto/auth.dto.ts` is the reference.

`@ApiProperty` is not optional decoration — it is what puts the shape into
`/api/docs-json`, which both frontends generate their types from. Money fields need an
explicit `{ type: 'string', example: '12.50000000' }` so the generated type says `string` and
says why.

## Tests

`npm test` → Vitest, 350 tests. `vitest.config.mts` sets `fileParallelism: false`
**deliberately** — the money tests must observe each other's concurrency. Testcontainers starts
a real Postgres 16 and runs the committed migrations; nothing is mocked.

Requires Docker: `docker compose up -d` first. The suite takes minutes by design, which is why
the Claude `Stop` hook skips it here and CI owns it. Run it by hand before any money commit.

## Gotchas specific to this repo

- **Don't run `src/database/migrate.ts` or `run-migrate.js`** — they need `dotenv`/`bcrypt`,
  which are not dependencies, and force Neon-style SSL.
- `@casl/ability` is installed with **0 imports**; real enforcement is `PermissionsGuard` plus
  `config/permissions.json` (which *is* wired, via `admin-rbac.service.ts`). The dep is kept
  only as a marker for the unbuilt ARCHITECTURE §2 item — same for `bullmq`/`ioredis` and §9.
- `src/workers/` is a placeholder with no worker code.
- Seeds re-run on every boot in dev and are idempotent.
