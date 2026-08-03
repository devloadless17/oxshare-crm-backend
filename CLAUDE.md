# oxshare-crm-backend

> Cross-repo context — doc authority, ports, auth cookies, the `/api` rewrite, the §6 money
> rules, and the quality-gate machinery — lives in `../CLAUDE.md`. This file is only what is
> specific to this repo. If the two disagree, `../CLAUDE.md` wins on facts about the system
> and this file wins on conventions inside this directory.

NestJS 11 API on **:3001**. Routes carry **no `/api` and no `/v1`** — `main.ts` calls neither
`setGlobalPrefix()` nor `enableVersioning()`, so the `version: '1'` on a few controllers is inert.

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

`npm test` → Vitest, 75 tests. `vitest.config.mts` sets `fileParallelism: false`
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
