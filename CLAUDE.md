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
never match a literal.** And in a **middleware** it must not read `req.path` at all: inside a
`NestMiddleware` mounted with `forRoutes('*')`, Express reports `req.path` *relative to the mount*
— it is `"/"` for every request. Use `req.originalUrl`. `CsrfEchoMiddleware` read `req.path`,
classified every admin request as portal, and echoed no anti-forgery token, so every cross-host
admin write failed 403 (17164fd). Guards are unaffected — they run inside the route handler and
see the full path. A unit test that hands a middleware a literal full `path` will pass while
production fails; build the request as Express does. `CsrfGuard` matched `'/admin'` directly, so introducing `/v1` silently
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

This one computes from what the system actually has: an **ingested MT5 deal**, attributed by
`users.referred_by_ib_user_id`, split by the earner's **named programme** (`ib_programs`).

### Programmes carry the rates; the ladder carries placement (migration 0084)

FR-IB-06 asks for "a named program driving commission/rebate" per partner, which a rung-keyed rate
cannot express — every level-1 partner was paid identically and there was nowhere at all to put a
client rebate. So `ib_accounts.program_id` is NOT NULL and `ib_programs` carries:

| column | meaning |
|---|---|
| `level1Rate` | what the holder earns from their **own** clients |
| `level2Rate` | what they earn from a **sub-partner's** clients |
| `rebateRate` | what goes back to the **trading client** |
| `mode` | `commission_only` / `rebate_only` / `hybrid` — which legs pay |

**The rates are keyed on DEPTH, not on the rung.** A level-2 partner who introduced the client
themselves is paid `level1Rate`; under the old model they took the level-2 rate for business they
had brought in. `ib_levels` keeps the rung's name and its enabled flag, and its `rateValue` now
decides nothing — do not read it as what anybody earns.

Migration 0084 seeded a **Default** programme from the live ladder and backfilled every partner
onto it, so no rate moved. A fresh database seeds 0/0, which is what an empty ladder already meant:
`calculate` skips terms that pay nothing and says so.

### Commission is earned on a CLOSED POSITION, and on nothing else

FR-IB-04: computed "on the closing of a deal — never on its opening". Three gates enforce it, and
each closes a different door:

1. `isTradeAction` — a balance, credit, correction, bonus or dividend is not a trade. Deposits and
   withdrawals reach MT5 as balance deals, so this is what keeps them out.
2. `isClosingEntry` — an OPENING deal accrues nothing. It is left UNPROCESSED rather than marked
   done, because its revenue is real and is paid by the close that consumes it.
3. `calculate` refuses `source: 'deposit'` outright, whatever the rate.

**A deal that cannot be accrued is excluded in the QUERY, never skipped in the loop.** The batch is
bounded and drained oldest-first, so anything left unmarked owns the FRONT of it until something
changes — and one batch's worth means no payable deal is ever reached again. Commission stops for
everybody, with nothing but one ordinary log line to show for it, and the failure gets worse the
busier the platform is. That is the worst shape a money job can have, and it had **three** doors:

| stuck row | must stay unprocessed because | how it re-enters |
|---|---|---|
| an OPEN leg | its revenue is paid by the close that consumes it | `unconsumedLegs`, when the close arrives |
| an ORPHAN — a login no `trading_accounts` row claims | the account may be linked minutes from now | the join, the moment it is linked |
| a REFUSED deal | the money is owed; a refusal is a settings mistake | `commission_retry_after`, on a backoff (0092) |

The first two need no column — a join and a position id already find them. A refusal has nothing in
the row to recognise it by, so 0092 gives it `commission_attempts` / `commission_retry_after` /
`commission_last_error`: a minute, then two, four, up to an hour, and an hour forever after. It
never gives up, because abandoning a refused deal turns a mistyped rate into permanently lost
commission — the exact failure §12.4's refusal exists to avoid. What the cap buys is that a hundred
permanently-stuck deals cost ONE batch an hour instead of every batch forever.

**Making them harmless makes them silent, which is why the alarm is part of the same change.** A
stuck deal used to jam a visible queue; now it sits quietly, harming nothing and paying nobody, and
it is not in `examined` at all. `ALERT_KINDS.COMMISSION_QUEUE_STALLED` is what replaces the symptom
— raised past 10 refused or 200 unlinked, repeating hourly, and its window resets when the condition
clears so a second incident is not silenced by the first one's fix. `accruePending` therefore
returns `orphaned` and `deferred` as BACKLOGS rather than batch tallies: a batch never contains one
of these any more, so a per-batch count would be permanently zero.

`test/deal-commission.spec.ts` pins each door with a batch limit of two;
`test/deal-commission-alerting.spec.ts` pins the alarm. Both were verified by deliberately breaking
the filter each one covers.

**A close pays on the whole position, not on its own row.** MT5 splits a round turn's charges
across the legs however the broker configured it — all on the open, all on the close, or half each
— so paying the closing row alone would silently pay nothing on the most common configuration
there is. `unconsumedLegs` sums the position's deals that no accrual has taken yet, and every leg
it sums is marked processed with the close. That is what makes a PARTIAL close correct: the first
close takes the opener plus itself, the second takes only itself, nothing counted twice or lost.

Scoped by `login` as well as `mt5_position_id`: position ids are unique per SERVER, not per
account, and a cross-account match would pay one client's partner out of another client's trade.

The deposit path (`accrueForSettledDeposit` → `accrueForDeposit`) has **no callers** — only
`positions.service.ts` injects the port, and it calls `accrueForClosedPosition`. It is kept,
unwired and `@deprecated`, because CPA is a real model that triggers on a deposit: a FIXED amount
per qualified client, never a percentage. `test/deal-commission.spec.ts` pins all of the above.

### A partner's programme can be changed, and that is what makes the catalogue real

`PATCH /admin/ib/partners/:userId/program` (`ib.partners.edit`, audited as `ib.program_change`
with the programme on both sides). Without it the terms were written once at approval, always to
whichever programme sorted first, and never again — an operator could build Gold, Silver and
Platinum and assign nobody, while two of this module's own refusals told them to "move them to
another programme first".

It refuses a DISABLED programme, and that is the other half of an existing guarantee:
`IbProgramsService.update` refuses to disable a programme partners stand on, so without this
refusal an operator could route around it by moving people ONTO a disabled row.

A change applies to the next trade only. Accruals record the rate they were calculated at, so
nothing already credited is restated — which is why this is an ordinary update rather than an
operation that has to reason about history.

### The client's rebate is an accrual row, not a direct credit

`ib_accruals.kind` is `commission` or `rebate`. A rebate row is produced by the same trade, matures
through the same settlement window, and is made idempotent by the same key — which is why it is a
row rather than a payment made at accrual time, the one payout that would skip the window a
reversal needs.

On a rebate row `ib_user_id` is the partner whose programme **produced** it (attribution) and
`client_user_id` is who is **paid**. `confirmPending` branches on `kind`: a commission credits the
partner's `commission` wallet as `entry_type = 'commission'`; a rebate credits the CLIENT's `main`
wallet as `entry_type = 'rebate'`. Reading `ib_user_id` as the beneficiary balances perfectly and
pays the introducer their own client's rebate.

`kind` is part of `ib_accruals_source_earner_uq` for the same reason — without it the two rows
collide on (source, source_id, ib_user_id) and the ON CONFLICT drops the rebate in silence, which
is indistinguishable from a rebate nobody configured. `test/ib-rebate.spec.ts` pins all of it.

**`EARNING_ENTRY_TYPES` no longer includes `rebate`.** A partner is also a client and may have been
introduced by somebody else; counting their own rebates as partner income inflates a lifetime
figure they get paid against.

```
deal ingested → accrueForDeal   → ib_accruals × N (pending, no money moved)
                                   — one per earner, plus the client's rebate
hourly @Cron  → confirmPending   → commission → partner's commission wallet
                                   rebate     → client's main wallet
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

## Object storage — R2, and the two rules that keep it honest

Uploads (KYC documents, avatars, payment logos) live in a **private Cloudflare R2
bucket**, not on this host. `common/uploads/` owns the whole thing:

```
storage/storage-driver.ts   the port — no Nest, no fs, no aws-sdk
storage/{r2,disk,fake}.*    the three implementations
storage/storage-key.ts      the key scheme, as pure functions
storage/http-range.ts       Range + If-None-Match, shared by disk and fake
stored-files.service.ts     validation, quota, checksum, registry — the only caller
stream-object.ts            the response: 206, 304, disconnect, mid-stream failure
```

**1. `STORAGE_DRIVER` is stated, never inferred.** It defaults to `r2` and
`env.validation.ts` refuses to boot without the `R2_*` block; `disk` must be set
explicitly and is refused outright in production. "Use R2 if configured, else disk" is
a silent downgrade — one typo and every identity document goes to a container
filesystem with nothing reporting it (D-62).

**2. Reads fall back, writes never do.** A read misses R2 and then tries local disk,
because documents uploaded before the move are still there and there is no backfill.
A write that cannot reach R2 **fails loudly**: falling back would scatter documents
across two providers with no record of which is which.

Two things that are not obvious and cost time to rediscover:

- **`responseChecksumValidation: 'WHEN_REQUIRED'` is load-bearing.** R2 returns the
  WHOLE-object checksum on a partial response and the SDK compares it against the
  range received, so every range read fails — which is every multi-page PDF in the
  review queue. Found by `npm run r2:verify`; re-run it after any aws-sdk upgrade.
- **The key mirrors the URL.** DB `uploads/kyc/x.jpg` → route `/v1/uploads/kyc/x.jpg`
  → key `kyc/x.jpg`. That mirror is why the R2 move needed no frontend change and no
  data migration; break it and both come back. `storage-key.spec.ts` pins it.

`stored_objects` (migration 0064) records every file — checksum, size, owner,
uploader. It is additive: the JSONB references in `kyc_submissions` are untouched.

**Scripts, neither in CI** (both cost billed requests): `npm run r2:verify` proves the
credentials in one round trip; `npm run r2:reconcile` diffs the bucket against the
registry both ways. The live driver contract is `R2_LIVE_TEST=1 npx vitest run
src/common/uploads/storage/storage-driver.spec.ts` — the same spec the fake and disk
drivers run, which is what makes the fake trustworthy in CI.

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

`npm test` → Vitest. **No test touches Cloudflare R2** — `vitest.config.mts` sets
`STORAGE_DRIVER=disk` and the unit suites use `test/storage-stub.ts` (an in-memory
driver). Keep it that way: a suite that bills a live account per run is one somebody
disables. `vitest.config.mts` sets `fileParallelism: false`
**deliberately** — the money tests must observe each other's concurrency. Testcontainers starts
a real Postgres 16 and runs the committed migrations; nothing is mocked.

Requires Docker: `docker compose up -d` first. The suite takes minutes by design, which is why
the Claude `Stop` hook skips it here and CI owns it. Run it by hand before any money commit.

## Gotchas specific to this repo

- **A RENUMBERED migration poisons every database that applied the old number, silently.**
  drizzle-kit applies only migrations whose journal `when` exceeds the highest `created_at` in
  `drizzle.__drizzle_migrations`, and it stores the journal's `when` as that `created_at`. So when
  a migration is renumbered upstream and its `when` is hand-lowered to fit the sequence — which is
  what 0091's own header describes — any database that already applied it keeps a watermark AHEAD
  of every entry in the journal, and skips everything from then on. `npm run db:migrate` prints
  "migrations applied successfully" and applies nothing. This is the same silent-success failure
  `drizzle.config.ts` documents, through a second door: it cost this dev database 0090
  (`wallets.wallet_number`) and 0092 before anyone noticed.
  **Check `count(*)` in `drizzle.__drizzle_migrations` against the journal's entry count** — they
  must be equal. To repair, DELETE the bookkeeping row whose `created_at` matches no journal entry
  and re-run `db:migrate`; the renumbered migration re-applies, which is why one that is renumbered
  must also be made re-runnable (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before
  `ADD`), exactly as 0091 was. Do NOT fix it by inflating the new migration's `when`: that rescues
  the machine in front of you and re-arms the trap for everyone whose database is in the same state.
- **Don't run `src/database/migrate.ts` or `run-migrate.js`** — they need `dotenv`/`bcrypt`,
  which are not dependencies, and force Neon-style SSL.
- `@casl/ability` is installed with **0 imports**; real enforcement is `PermissionsGuard` plus
  `config/permissions.json` (which *is* wired, via `admin-rbac.service.ts`). The dep is kept
  only as a marker for the unbuilt ARCHITECTURE §2 item — same for `bullmq`/`ioredis` and §9.
- `src/workers/` is a placeholder with no worker code.
- Seeds re-run on every boot in dev and are idempotent.
