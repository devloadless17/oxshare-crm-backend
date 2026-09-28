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
`NestMiddleware` mounted with `forRoutes('*')`, Express reports `req.path` _relative to the mount_
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
data" — the admin equivalents take a `userId` filter precisely because they _are_ gated.

- **`GET /trading/accounts`** (`modules/trading/`) — the client's own accounts, live before demo,
  unpaginated because a client holds a handful rather than a growing log. Returns `balance` (the
  CRM-held figure a transfer credits) and deliberately **no equity, margin or open positions**:
  there is no MT5 bridge, nothing here holds them, and a fabricated equity beside a real login is
  the most expensive kind of wrong number on a trading product. `GET /trading/accounts/transferable`
  narrows to live+active for the transfer screen — it shapes what is _offered_; `TransfersService`
  still owns the refusal.
- **`GET /ib/overview`** (`modules/ib/ib-overview.service.ts`) — the partner dashboard: earnings,
  commission wallets, referred clients, direct sub-partners. It carries **NO TERMS AT ALL** since
  0112: a rung with a `rateValue` led it until 0102, then a named programme with its tier ladder
  until 0112, and both were removed on the same reasoning — a partner's rate card is a commercial
  arrangement the broker publishes, and a portal copy of it goes stale the day the desk
  renegotiates, with the partner reading the stale one. What is left is what only this system knows.
  404s for a non-partner, because zeroes across the board would render as a partner dashboard
  belonging to somebody who is not one.
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
Sub-partners on the dashboard are **direct only** — one hop. That used to match the payout logic
exactly, because resolution stopped at L2; since 0102 it does not, and the reason has changed rather
than lapsed. FR-IB-17 gives a parent visibility of its sub-tree **earnings**, not a roster, and a
successful partner's sub-tree is unbounded — rendering it whole is a page that gets slower as
somebody succeeds. What they are owed from the whole tree is in `earnings`, which sums accruals at
every depth.

## The commission engine (`modules/ib/commission*`)

Rebuilt after migration 0028 deleted the original. It is **not** a restore: that one computed from
MT5 `deals` (spread × volume) through an `ib_programs` table, and both are gone with the bridge —
rebuilding against them would be an engine that can never run.

This one computes from what the system actually has: an **ingested MT5 deal**, attributed by
`users.referred_by_ib_user_id`, split by each earner's **LEVEL** in the partner tree (`ib_levels`,
keyed on `ib_accounts.level`).

**WHAT it computes on is the level's own `revenue_basis`, defaulting to MT5's charged commission
+ swap.**

It was `trading_settings.ib_revenue_basis` for a while, on the reasoning that FR-IB-16 asks for
the agreed method to be *configured*. The control went in 0104 with the rest of the IB block on
that form: commission is configured on the Commission Levels page, and a Trading-settings field
that re-prices every partner is a second place for two answers to disagree. Every deployment was
already on the default, so removing the choice moved nobody's money.

The spread-markup arithmetic stays in `brokerRevenueFor`, reachable by changing one line — see
"The spread markup drives money ONLY when an operator says so" below, which is still the argument
anyone proposing that change has to answer.

### Terms come from the LEVEL a partner stands on (0112)

⚠️ **This REVERSES 0102 and deviates from the FSD, deliberately and on an explicit instruction.**
FR-IB-06 commits to "an administrable catalogue of named IB programs (a tier ladder)", each partner
"assigned to exactly one named program". That catalogue is gone from the live path. The decision is
recorded in migration 0112's header rather than left as a contradiction.

`ib_accounts.level` is NOT NULL, and one `ib_levels` row carries everything about a rung:

| column                                        | meaning                                                    |
| --------------------------------------------- | ---------------------------------------------------------- |
| `level`                                       | the rung, and the row's whole identity — UNIQUE            |
| `commission_mode` + `rate` / `amount_per_lot` | what the **partner** earns, as a % or as money per lot     |
| `rebate_mode` + `rate` / `amount_per_lot`     | what goes back to the **trading client**, same two shapes  |
| `revenue_basis`                               | WHICH revenue a percentage here is a share of (FR-IB-16)   |
| `enabled`                                     | a disabled rung pays nobody standing on it                 |

**The rate is keyed on the earner's POSITION, not on the trade's depth.** A partner with no parent
deals with the broker directly and is level 1; a partner they recruit is level 2. A level 1 partner
earns their level 1 term on everything that reaches them, however deep it sits.

That is the behaviour 0102 removed, and it is what "static per lot for the main partner, percent for
the partner under him" actually describes.

⚠️ **THE TRADE-OFF, STATED PLAINLY, BECAUSE SOMEBODY WILL CALL IT A BUG.** Recruiting a partner
LOWERS what they earn on their own clients. A level 1 partner on 30% who is then placed under
somebody becomes level 2 and earns level 2's rate — 8%, say — on the clients they introduced
themselves, not just on business from below them. Under programmes the rate was keyed on DEPTH, so
an introducer was always paid the depth-1 tier whatever rung they occupied, and that asymmetry was
the whole reason 0102 moved to depth. 0112 moves back on an explicit instruction.

`test/ib-end-to-end.spec.ts > who earns from whom, in a two-level tree` pins both halves, and its
comment is worth reading before changing anything here: the `@n` in an accrual is `depth`, and on a
sub-partner's own client the depth and the rung run OPPOSITE — `omar@1=8` is "the introducer, paid
his rung 2 rate". Reading the depth as the rung is the mistake, and an earlier version of that
assertion made it.

**The chain walk is UNCHANGED**, which is why the two rules the business stated hold by
construction rather than by a rate: `resolveChain` climbs `parent_ib_user_id` upward from the
client's introducer, so a sub-partner never appears in the chain for their parent's own clients —
and a parent always appears in the chain for clients introduced beneath them.

**The three programme "modes" are gone.** `commission_only` / `rebate_only` / `hybrid` were a label
describing which of two numbers were set, and the numbers say that themselves: a zero commission
pays no partner, a zero rebate returns nothing to the client, both set pays both.

⚠️ **`trading_settings.ib_max_levels` NO LONGER CAPS ANYTHING (0113), and this section used to
say it was the cap.**

Precisely: the COLUMN is still there — `select column_name from information_schema.columns` lists
it — and nothing on the live path reads it. The control left the Trading settings tab and the
enforcement left `IbLevelsService.create`. It is a dead column, like `admins.role`, not a dropped
one; do not go looking for the migration that removed it.

It was "Maximum commission levels" (0105), defaulting to 2, and it went for the reason the other
four IB settings went: adding a third rung meant first raising a number on a DIFFERENT screen,
which is a second place standing between an operator and a decision the IB Levels page already
expresses — remove the rung and it stops paying. `test/ib-applications.spec.ts` carries the note
in full, under a heading reading "THERE IS NO CONFIGURABLE CEILING ANY MORE".

Committed scope is still TWO — Feature List Rev 9, IB-17: *"no level beyond L2"* — and it is now
expressed by which rungs EXIST rather than by a ceiling above them.

Three bounds, and they are not the same thing:

| bound | value | what it is |
| ----- | ----- | ---------- |
| `trading_settings.ib_max_total_payout_pct` | 100 | COST — the most ONE TRADE may pay out across every percentage leg |
| `trading_settings.ib_max_payout_per_lot` | 50 | COST — the same, in the units per-lot terms are quoted in (0111) |
| `ib_levels_level_range` / `MAX_CHAIN_DEPTH` | 1..10 | STRUCTURE and CYCLE GUARD — what the column holds, and where the walk stops |

The first two bound how MUCH and the last how DEEP, and they fail differently: an over-deep rung is
refused at SAVE time on the levels form, an over-budget chain is refused at ACCRUAL time and the
deal defers on the 0092 backoff. Neither truncates or scales anything already agreed.

⚠️ **The two COST ceilings are no longer on any form (0112).** They are still stored, still
defaulted, and still read by `checkPlausible` on every accrual — they are the unit-error backstop
that stops a rate meaning 70× rather than 70% accruing seventy times the revenue. What went is the
control, on an explicit instruction. `UpdateTradingSettingsDto` and `TradingSettingsWrite` no longer
carry them, which is the whole mechanism by which a PUT leaves the stored values alone: `setTrading`
spreads exactly the keys it is given.

`common/ib-levels.ts` still carries the normalising helper the setting used, and its own header
records that the number "used to be `MAX_CHAIN_DEPTH = 2`". Nothing on the live path reads a
configured ceiling any more.

**Removing a RUNG truncates nothing that is already owed.** An existing level 3 keeps paying, because an
operator adjusting a limit must not silently restate money that is owed. Only the next CREATE past
the new ceiling is refused. That is a deliberate difference from the programme catalogue this
replaced, where the next EDIT of a too-deep ladder was refused too: a programme's ladder was
re-validated as a whole on every save, while a rung is one row — and re-refusing an edit to level 3
would leave an operator unable to correct a rate that is still paying.

**A partner deeper than the ladder reaches earns nothing**, and `calculate` says so per trade with
the rung named. `ib_accounts.level` deliberately carries NO foreign key to `ib_levels`: a tree may
legitimately run deeper than the broker pays, and a FK would make appointing that partner impossible
rather than making them earn nothing.

#### The programme tables are NOT dropped, and that is not hesitation

`ib_accruals.program_id` records WHICH TERMS PAID every commission accrued before 0112 — on rows
that have already credited real wallets. Dropping `ib_programs` would take that record with it,
leaving a ledger of amounts nobody can explain. New accruals record `level_id` instead, and both
columns are nullable so a row carries exactly the one that priced it. `ib_accounts.program_id` is
kept nullable for the same reason.

Nothing reads either to decide a NEW payout. `admin/ib-programs`, `IbProgramsService` and the
programme DTOs are deleted; `ib.programs.*` were remapped to `ib.levels.*` by 0112, mirroring the
remap 0104 made in the other direction.

**The share ceiling is a plain CHECK again** (`ib_levels_share_fits`), not the deferred constraint
trigger the programmes needed: a level's two terms live on ONE row, so there is no half-written
state for it to see. It bounds ONE RUNG's commission plus rebate, which is narrower than it looks —
on a single trade the earners stand on different rungs, so the per-trade guarantee is
`checkPlausible` alone, which REFUSES an over-payment rather than scaling it.

⚠️ **A CHECK that evaluates to NULL PASSES in Postgres.** `ib_levels_commission_shape` carries
`IS NOT NULL` beside its `>= 0` for exactly that reason — `amount > 0` alone accepts a per-lot term
with no amount at all. The same trap 0111 hit, caught by `ib-schema-constraints.spec.ts` rather than
by review.

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

| stuck row                                            | must stay unprocessed because                      | how it re-enters                              |
| ---------------------------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| an OPEN leg                                          | its revenue is paid by the close that consumes it  | `unconsumedLegs`, when the close arrives      |
| an ORPHAN — a login no `trading_accounts` row claims | the account may be linked minutes from now         | the join, the moment it is linked             |
| a REFUSED deal                                       | the money is owed; a refusal is a settings mistake | `commission_retry_after`, on a backoff (0092) |

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

### A partner's LEVEL can be changed, and their approval does not ask for it

`PATCH /admin/ib/partners/:userId/level` (`ib.partners.edit`, audited as `ib.level_change` with the
rung on both sides). It replaced `/program` in 0112 and, before that, an earlier `/level` route that
0102 removed — the route has come back with the reason: a rung decides terms again.

**A partner's level is DERIVED at approval, not chosen.** `IbApplicationsService.approve` reads the
parent's level and writes one deeper, capped at the structural ceiling — so approval carries no
commercial decision at all, and `ApproveIbApplicationDto.programId` is gone. The picker went from
the admin approve dialog with it.

**So why is it editable?** Because "one deeper than your recruiter" is right in the ordinary case
and cannot be right in every one: a partner whose recruiter is later cut loose to deal direct, or
one the broker has agreed to treat as a main partner despite sitting under another. Without this the
number was decided once by the shape of the tree on one particular afternoon.

It refuses a DISABLED or UNCONFIGURED rung, and the first is the other half of an existing
guarantee: `IbLevelsService.update` refuses to disable a rung partners stand on, so without this
refusal an operator could route around it by moving people ONTO a disabled row.

⚠️ **It does NOT move anybody beneath them.** A level is one partner's position, and their
sub-partners keep the rungs they were approved on — cascading would re-price an unbounded number of
people from one operator's edit of somebody else's row. Moving a subtree is a series of decisions,
each audited.

A change applies to the next trade only. Accruals record the rate AND the rung that priced them
(`ib_accruals.rate_value`, `ib_accruals.level_id`), so nothing already credited is restated — which
is why this is an ordinary update rather than an operation that has to reason about history.


### The client's rebate is an accrual row, not a direct credit

`ib_accruals.kind` is `commission` or `rebate`. A rebate row is produced by the same trade, matures
through the same settlement window, and is made idempotent by the same key — which is why it is a
row rather than a payment made at accrual time, the one payout that would skip the window a
reversal needs.

On a rebate row `ib_user_id` is the partner whose RUNG **produced** it (attribution) and
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

### A deposit is refused AT THE DOOR, and the percentage code is gone

`accrueForDeposit` paid a share of the client's own money — $700 to a partner on a $1,000 deposit
at 70%, out of the broker's funds, while the client kept the right to withdraw all $1,000. It was
abandoned correctly, but the abandonment rested on nothing calling it, and the percentage
implementation was still sitting there for whoever wired it up next.

`calculate` would have declined the term, so re-wiring could not have paid — it would have resolved
the chain, loaded programmes, written nothing and returned 0. **Silently**, which is exactly what
"nobody was owed anything" looks like, so whoever wired it would go find the deposit branch inside
`calculate` and delete the one thing standing between them and the original bug.

So the implementation is deleted and the entry point throws `CommissionRefusedError` naming CPA as
the model they actually want. Not `isLiveRevenueFeed`, because a deposit is not a revenue feed at
all — flipping `LIVE_REVENUE_FEED` to `position` must never make this payable.
`accrueForSettledDeposit` still swallows it per its no-throw contract, so the deposit itself stands.

### The Trading form carries ONE bound now (0103, 0104, 0106, 0112)

Four controls lived there and each decided what partners are PAID: `ib_max_revenue_share_pct`
("Maximum paid to partners"), `ib_commission_hold_hours`, `ib_accrual_start` and
`ib_revenue_basis`. All four went in 0103/0104.

| was                        | is now                                                                |
| -------------------------- | --------------------------------------------------------------------- |
| `ib_max_revenue_share_pct` | `ib_max_total_payout_pct` (0106) — a REFUSAL, not the pro-rata scaler |
| `ib_commission_hold_hours` | `IB_COMMISSION_HOLD_HOURS`                                            |
| `ib_accrual_start`         | `IB_ACCRUAL_START`                                                    |
| `ib_revenue_basis`         | `ib_levels.revenue_basis` — FR-IB-16 puts it with the TERMS           |

**Nothing of the IB block remains on that form (0113).** The last survivor was `ib_max_levels`,
which for a while passed the test the other four failed:
CONSTRAINS the Commission Levels page rather than restating it. A rate belongs to one partner's
agreement; a bound belongs to the platform.

⚠️ **The two payout ceilings left the FORM in 0112, not the system.** `ib_max_total_payout_pct` and
`ib_max_payout_per_lot` are still columns, still defaulted (100% and $50 a lot), and still read by
`checkPlausible` on every accrual — they are the unit-error backstop that stops a rate meaning 70×
rather than 70% accruing seventy times the revenue. Removing the controls was an explicit
instruction. The DTOs and `TradingSettingsWrite` no longer declare them, which is exactly how a PUT
leaves the stored values alone: `setTrading` spreads only the keys it is given, so a column absent
from that interface is one the upsert never mentions. **Adding either back as an OPTIONAL field
would be worse than useless** — Drizzle writes `undefined` as NULL, and a NOT NULL column would
refuse the whole save.

**The ceiling is NOT the old broker cap returning.** That one summed every leg and scaled them all
pro rata to fit, then paid immediately — so a partner quietly received less than their terms
promised, on every trade, with nothing saying so. The accrual row recorded the scaled amount as if
the rate had produced it. The new one REFUSES: the deal defers on the 0092 backoff with the reason
on the row, `COMMISSION_CEILING_BREACH` pages, and it pays in full once the rates are corrected.

**Why a per-rung ceiling cannot do this job.** `ib_levels_share_fits` bounds ONE RUNG's commission
plus rebate to 100%. The earners on a single trade stand on DIFFERENT rungs, each inside its own
limit and together over the broker's — which is exactly what shipped under the programme catalogue
it replaced: 60% at depth 1 and 40% at depth 2 paid out the entire revenue and nothing refused it,
because `checkPlausible` only ever refused a total ABOVE the revenue and 100% is not above it.

**Nothing else about the backlog guard changed**, which is what made dropping its column safe.


### The backlog is a DECISION — `IB_ACCRUAL_START`

`mt5_deals` has been filled by ingestion since long before anything read it, so the first run of
the engine faces months of historical trades and, left alone, pays partners for every one of them
at once. That is not a bug in a job designed to be safe to re-run; it is a commercial decision no
deployment had ever been asked to make.

| value           | meaning                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| _(unset)_       | an AGED backlog (>48h of unprocessed TRADE deals) **stops the run** — nothing paid, nothing discarded |
| `<ISO instant>` | pay from there on; older deals are marked decided and accrue nothing                                  |
| `all`           | pay the whole backlog, deliberately                                                                   |

48 hours because the sweep runs 24 behind the push feed — a deal arriving late is not history, and
a shorter grace would hold the engine shut on every ordinary catch-up. Deliberately **not**
defaulted to "today": a default is a decision nobody made, and this one does not reverse by
deploying — money paid to a partner for a trade nobody meant to pay for comes back by conversation.
An unparseable value falls back to UNSET rather than to "nothing is in scope", because the second
would mark every trade decided and discard the commission permanently.

The holding state alerts and logs on every run and is never throttled: it does not resolve itself,
and a deployment can sit in it indefinitely with no other symptom — "no commission yet" looks
exactly like "no trades yet".

### A dealer-cancelled trade is DETECTED here and REVERSED by a person

`isTradeAction` has always excluded `DEAL_BUY_CANCELED` / `DEAL_SELL_CANCELED`, so a cancellation
accrues nothing. That says nothing whatever about the accrual already written against the trade it
cancels — which was marked done like any other non-trade row while a partner kept earnings from a
trade that did not happen, with **nothing anywhere saying so**.

Two halves, and the split is deliberate:

|                  |                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Detection**    | `DealCommissionService.reportClawback` — on a cancellation, looks for accruals on that position and raises `COMMISSION_CLAWBACK_REQUIRED` (notify) naming how many are already CREDITED |
| **The decision** | `POST /admin/ib/accruals/:id/reverse` (`ib.commissions.reverse`, audited `ib.accrual_reverse`)                                                                                          |

**Nothing reverses automatically, and that is the rule rather than an omission.** A reversal takes
money out of somebody's wallet; a feed must not do that because a code arrived, and a broker
re-sending a day of deals must not empty a partner's balance as a side effect.

`reverseAccrual` is what finally SETS `ib_accrual_status = 'reversed'` — a value the enum and the
admin DTO have published since the table existed while nothing anywhere wrote it, leaving
hand-written SQL against an append-only ledger as the only remedy.

- **`pending` → free.** The money never moved; a status change and nothing else. That asymmetry is
  what the settlement window buys, and it is visible in one `if`.
- **`confirmed` → a compensating entry.** `ledger_entries` is append-only, so a clawback is a new
  row and never an edit. `adjustment`, not a negative `commission`: entry types are what reports sum
  by, and a negative commission row nets against real earnings, shrinking a lifetime figure with no
  line explaining why.
- **`LEDGER_REFERENCE.accrualReversal`, keyed on the accrual id.** A _different_ reference type from
  the credit — reusing `accrual` makes the debit look like a replay and
  `ledger_entries_wallet_reference_uq` drops it in silence, so the desk sees success and the partner
  keeps the money. The _same id_ is the idempotency: one accrual reverses once, and a double-click
  cannot debit twice.
- **A rebate is taken back from the CLIENT.** Same rule as `confirmPending`: on a rebate row
  `ib_user_id` is attribution, `client_user_id` is who was paid. Debiting `ib_user_id` balances
  perfectly and takes it from the introducer.
- **It REFUSES when the money is gone**, and the row stays `confirmed`. `wallets_balance_non_negative`
  is a CHECK constraint, so no `allowOverdraft` exists to route around it — a negative wallet is a
  debt the CRM cannot collect or display. Marking it `reversed` on a failed debit is the one lie
  this table must never tell: the desk would stop chasing it.

`test/ib-accrual-reversal.spec.ts` and `test/deal-cancellation-clawback.spec.ts` pin both halves.
The quiet case is pinned hardest: a cancellation on a position that never accrued must raise
**nothing**, or the alarm fires constantly, gets muted, and takes the real cases with it.

### Three refusals worth knowing about

- **A partner standing past the end of the ladder earns nothing**, and the log names the rung. An
  UNCONFIGURED rung and a ZERO rate are reported differently on purpose: "that rung is not on the
  ladder" is a level to add, "it pays nothing there" is a rate to correct, and one message for both
  sends an operator to the wrong screen.
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
- Resolution walks the WHOLE chain and each earner is paid by the rung they stand on. A single
  `parent_ib_user_id`, no closure table, and **one recursive CTE** (`loadChain`) rather than a loop
  of round trips — bounded by `MAX_CHAIN_DEPTH` and by a `path` array that stops a cycle inside
  Postgres rather than after the rows come back.

Both layers now take the db by constructor injection. `store/*.store.ts` classes use
`@Inject(DRIZZLE_DB)`; the four money services (`wallet`, `transactions`, `commission`,
`programs`) do the same and use Drizzle inline — they previously called the module-level
`getDb()` singleton from inside each method, and a lint rule now blocks importing it here.
Not extracting a _store layer_ for money is deliberate: §11 requires those tests to run against
**real Postgres via Testcontainers**, so a fake-substitution seam would buy them nothing, while
moving `FOR UPDATE` across a new boundary would cost real risk. `database/db.ts` exports an
`Executor` type so a store method can join a caller's transaction.

> **`test/di-wiring.spec.ts` does not exist.** This section claimed it resolved each money
> service from the real module graph — a thing the hand-constructed money specs genuinely
> cannot do, and a real gap rather than a wording slip. What covers the graph today is
> incidental: the HTTP specs boot the whole `AppModule`, so a constructor dependency Nest
> cannot resolve fails all of them at once. That is a backstop, not a test of the thing.

## The spread markup drives money ONLY when an operator says so (ADM-07, FR-IB-16, 0095/0101)

`trading_products.spread_markup_per_lot` is the broker's markup per standard lot, in the account
currency. It is on the PRODUCT because **the product IS the tier** — `trading_accounts.tier` is
inert and labelled dead precisely because "a tier would be a second name for the same thing", and a
`tiers` table would recreate the name that column was retired for.

**Until 0101 nothing read it, and the reason is still the right one.** The FSD calls commission
"spread-based" (FR-IB-04, FR-IB-16) while the engine computes on `commission + swap`, because MT5
reports no per-deal spread revenue — there is neither a figure to compute from nor a figure to check
a result against. Migration 0095 recorded the conclusion that follows: wiring the markup into the
base "changes what every partner is paid on every future trade", and **that needs a person, not a
column**.

So the gap between the specification and the system was never missing arithmetic, and it is not
missing arithmetic now: `brokerRevenueFor` can compute on the markup, and nothing asks it to.

`trading_settings.ib_revenue_basis` was that owner for three migrations (0101 → 0104). It offered:

| value                    | the base a partner's rate applies to                               |
| ------------------------ | ------------------------------------------------------------------ |
| `commission_swap`        | MT5's charged commission + swap. **The default, and what shipped** |
| `spread`                 | lots × the product's `spread_markup_per_lot`                       |
| `commission_swap_spread` | both, summed                                                       |

It became a constant in 0104 — not because the setting was wrong, but because it was on the wrong
SCREEN. Commission is configured on the Commission Levels page, and a Trading-settings field that
re-prices every partner is a second place for two answers to disagree.

**It is `ib_levels.revenue_basis` now**, which is what FR-IB-16 asked for all along — "configure the
exact commission and rebate mathematics ... through the IB program catalogue". It was
`ib_programs.revenue_basis` from 0106 until 0112 moved it onto the rung with every other term. Not a
constant, and not a platform switch: the base is HALF of what a partner agreed to, since "30% of the
spread markup" and "30% of commission and swap" are different contracts.

So the broker's revenue is computed PER EARNER. `deal-commission.service.ts` prices all three bases
from the same legs and lot count and hands `calculate` a `revenueByBasis` map; each partner's leg is
a percentage of the figure their OWN RUNG names. A chain may legitimately mix them.

**A basis the caller could not price is OMITTED from the map, never stored as zero.** Zero is a
price; absent means "no answer" — an account linked to no product, under a basis that needs one — and
`calculate` REFUSES that leg rather than falling back to a different revenue. Substituting one would
pay the partner on terms nobody agreed to, at a number that looks entirely ordinary on the accrual
row. That distinction is the whole reason `spreadMarkupPerLot` is `string | null`.

**The map is optional and its absence is the old behaviour.** Without it every leg prices on the
single `grossAmount`, which is what every caller with one revenue figure still wants and what every
in-memory test constructs. Every deployment defaults to `commission_swap`, so 0106 moved nobody's
money.

Two rules survive it, and each still closes a door:

- **The default is the status quo.** `test/deal-commission.spec.ts` pins it directly: an account
  linked to a product with a 7.50 markup, trading 2 lots, still accrues on the 10.00 of charges
  alone. If that assertion ever fails, a deployment somewhere has been re-priced.
- **Every call site must state the basis AND the markup.** `brokerRevenueFor` takes both as required
  arguments, so the dormant `positions.service.ts` path cannot inherit different pricing by omission
  the day somebody flips `LIVE_REVENUE_FEED`. Two paths paying two different amounts for one trade
  is the exact failure `brokerRevenueOf` was extracted into a function to prevent.

**Wiring the markup back in is a one-line change and must not be made as one.** It changes what
every partner is paid on every future trade. The ORDER trap below is the reason it needs a person.

### Where each half lives, and why the split is not arbitrary

`common/revenue-basis.ts` holds the VOCABULARY — the union, the list, the narrowing. Four layers
need to name a basis and two of them (`common/`, `store/`) are forbidden by lint from importing
`modules/`. `modules/trading/broker-revenue.ts` holds the ARITHMETIC, beside the sign convention it
has to honour. Naming a thing is not computing with it.

### ⚠️ The ORDER, which is irreversible — read this before changing that line

Like `IB_ACCRUAL_START`, the basis decides only deals NOT YET DECIDED — a row carrying
`commission_processed_at` is never revisited.

The trap: under `'spread'`, a product whose markup is still 0 produces zero revenue, and a
zero-revenue deal is **marked done rather than retried**, because MT5's amounts are final the moment
they are reported. **Switching the basis before the markups are populated drains the queue paying
nothing, permanently, and switching back recovers none of it.** Nothing can detect the mistake,
because a zero markup is also a legitimate raw-spread product. The admin form says so, conditionally,
beside the control; migration 0101 says why.

**An account linked to NO product is refused, not priced at zero.** That distinction is the whole
reason `spreadMarkupPerLot` is `string | null` rather than defaulting: zero is a price, `null` is a
configuration hole. A refusal defers the deal on the 0092 backoff with the reason on the row, so the
money stays owed and one relinked account pays it on the next run.

**It is not a mirror of MT5, and that was checked rather than assumed.** The Manager API the bridge
ships has no per-GROUP markup at all. It has `AskMarkup`, `BidMarkup`, `SpreadDiff` and
`SpreadBalance` on `IMTConGroupSymbol`: per group **and symbol**, in **points**, split by side. A
product maps to one or more groups and a group covers every symbol it trades, so the honest mirror of
one product is group × symbol × 2 values in points — and converting any of it to currency-per-lot
needs each symbol's `ContractSize` and `TickValue` at a price, which is a calculation that moves with
the market, not a reading. There is no single MT5 number this column could copy, so it is not
competing with one: it is the DESK's figure. Per-symbol truth, if ever wanted, is a different table
`(group, symbol, ask_markup, bid_markup)` fed by a bridge endpoint that does not exist — additive to
this, not a replacement.

A decimal **string** end to end, like every `NUMERIC(28,8)` here, with `@ApiProperty({ type:
'string' })` so the generated frontend type says `string`. **Omitting the markup on the product PUT
keeps the stored value**: that endpoint is a full replace, so a caller predating the field would
otherwise zero a negotiated markup every time somebody renamed a product — and now that the markup
can drive money, that would silently stop paying on it.

## `TRUSTED_PROXY_HOPS` is watched at RUNTIME, not just stated at boot

One number decides which `X-Forwarded-For` entry is believed, and three controls key on it: the
RBAC-08 allowlist, the rate limiter, and the audit trail. `main.ts` prints it on every boot — but a
boot line describes the moment it was written, and the failure this actually has is a CDN put in
front months later by somebody who does not know the variable exists. Nothing restarts and nothing
errors; every control just starts reading the CDN's address.

`common/security/proxy-depth.ts` counts the shape of each request and reports a STANDING
disagreement — ~90% of a 200-request sample, never a single request, because anyone can put anything
in that header and a detector that believed one request would be steerable by the party it defends
against. Consistently deeper than configured means a proxy was added (`notify`); consistently
shallower means we trust further left than our infrastructure reaches, into caller-supplied text, so
an allowlist can be walked through (`page`). It reports and changes nothing — inferring the hop
count from traffic is the same "trust the header" mistake `client-ip.ts` refuses.

## The snapshot carries MORE than a balance (0099)

`ingestSnapshot` mirrors `balance`, `credit`, `mt5_group` and `leverage` — all four from one read,
all four under the same `balance_synced_at` staleness guard, because they describe one instant. A
fresher read already stored means every one of them is stale, not just the balance.

`group` and `leverage` were being **sent, accepted, and discarded**: the bridge put them on every
snapshot, the DTO documented them, `trading_accounts` had columns — and they were written only at
account CREATION and never again. A broker moving an account between groups, or changing its
leverage in the manager terminal, was invisible for ever, with the console rendering the value from
the day the account was opened and nothing marking it as old.

**Absent ≠ null.** All three extra fields are optional on the wire, so a read that did not ask for
them leaves what is stored alone. Blanking a known group because one snapshot was silent is worse
than the staleness it replaces.

### What may be mirrored, and what may never be

The line is not usefulness — it is whether a stored copy stops being true a second later.

|                                              |                                                                   |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `balance`, `credit`, `group`, `leverage`     | move on a DISCRETE event: a trade, a dealer action, a broker edit |
| `equity`, `margin`, `marginFree`, `floating` | recomputed from live prices on every tick                         |

The second row is available **only** through `/accounts/:id/live` and is deliberately absent from
every table. `credit` earns its column because it is discrete — and because `floating` is defined
as equity − balance − **credit**, so without it a client's tradeable position could not be shown on
a list without one live MT5 call per row, which is the read the mirror exists to avoid.

**`credit` is never summed into `balance`.** It is not the client's money to withdraw, and a balance
that quietly included bonus credit would overstate what a withdrawal can pay out.

### The live endpoints are throttled and write through

`/trading/accounts/:id/live` and `/:id/positions` carry **12/min per client**, not the global 120.
Every call takes the single MT5 session lock. Per CLIENT rather than per account, because the cost
is the lock and the lock does not care which login is read.

`snapshotMine` also writes its result through `recordFromOperation`. That read just paid for the
most expensive thing the bridge does; rendering it once and discarding it left the mirror beside it
minutes older, so the next screen showed the stale one.

### The account screen is PUSHED now, and those two routes are the fallback

`POST /trading/accounts/:id/watch` says "this client is looking at this account". It registers a
LEASE on the bridge, which reads the watched accounts on its own loop and posts each reading to
`POST /webhooks/mt5/live` → `Mt5LiveService` → `pg_notify('mt5_live')` → `RealtimeGateway` →
`account.live` in room `client:<userId>`.

**Why the direction had to flip.** Polling scaled with VIEWERS × RATE and every request took the
one session lock — which is what the 12/min cap is for, and why a livelier screen could not be
bought by lowering the interval. Watching scales with ACCOUNTS BEING WATCHED: ten people on one
account is one read, not ten.

Four things that are easy to get wrong here:

- **The watch route does NOT take the session lock**, which is why it is throttled at 60/min rather
  than 12. It registers a name and returns. Applying the tight cap would throttle a heartbeating
  screen straight back into the polling this replaces.
- **`watching: false` is an ordinary answer** — no MT5 login, bridge full, bridge unreachable — and
  the portal's response to all three is identical: keep polling. `watchMine` therefore SWALLOWS a
  bridge failure where every other bridge call re-throws. Nobody asked for this; the screen
  volunteered that it was open.
- **Nothing on the live path is stored.** `Mt5LiveDto` carries equity, margin and floating, which
  `Mt5AccountSnapshotDto` deliberately refuses — that refusal is about STORING them, and this is
  routed and forgotten. It does not touch the balance mirror either: that column is the sweep's,
  guarded on read times, and writing it several times a second per watched account would be a write
  storm for a number the sweep already maintains.
- **`mt5_live` is a third channel on the gateway's ONE listening connection**, and the first
  high-rate one. `pg_notify` refuses a payload over 8000 bytes, so `Mt5LivePublisher` drops the
  positions array rather than the whole event when it will not fit — the same optional-field
  contract `NotificationEvent.params` carries. A consumer must read an absent array as "ask
  separately", never as "no open positions".

**How live it actually is depends on the broker's read latency**, which this repo has never measured
in one place — `BridgeOptions` says ~285ms idle, `mt5-bridge.client.ts` says ~2.5s through the CRM.
`GET /admin/live` on the bridge now reports it continuously. Read that before tuning anything.

### The sweep STREAMS its deals

`StreamDealsAsync` hands the sweep one login at a time. The list form materialised a rolling 24-hour
window across every account — the platform's entire trading day in memory, rebuilt every five
minutes, 288 times a day. The MT5 calls are identical either way; only the peak moves, from the
whole estate to the largest single account. `GetDealsAsync` remains, implemented on top of the
stream, for the bounded callers (the diagnostic endpoint, the probe).

## Scheduled jobs: ONE INSTANCE RUNS EACH (migration 0098)

`@Cron` fires on **every** instance. Correctness survives that and always has — every money job here
is idempotent by construction and says so in its own docblock: the accrual is guarded by
`ib_accruals_source_earner_uq`, the confirm credit by `ledger_entries_wallet_reference_uq`, a
transfer resume by the transfer id being the bridge's own idempotency key.

What does not survive is the COST. Four replicas are four drains of the same commission queue,
contending on the same rows to reach the outcome one of them would have reached alone — and the
drain budgets make each run long enough to overlap the next tick. Correct-but-quadruple is what
stops a platform scaling horizontally, which is the only way it reaches the size this one is
planned for.

`JobLeaseService.run(name, ttlMs, work)` takes a row in `job_leases` and runs the work only if it
got it. Five jobs are leased — the two commission drains, `payments.resumeTransfers`,
`rival.reconcile` and `wallet.reconcile`. The other three (`notifications.prune`, `security.sweep`,
`mt5.groupSync`) are cheap and idempotent, so a duplicate run costs less than the coordination
would.

- **A lease row, not `pg_try_advisory_lock`.** The advisory lock is SESSION-scoped, and behind a
  connection pool the unlock can land on a different pooled connection than the lock — leaving it
  held until that connection recycles, a hang with no trace in any application log. A row with an
  expiry is one SELECT to inspect, names its holder, and heals itself.
- **`expires_at` is a CRASH BACKSTOP, not the release path.** A job that ends sets it to `now()`, so
  the next tick is never blocked by work that already finished. It must exceed the job's own time
  budget — every caller passes double — or a second instance starts while the first is still
  draining, which is the duplicate run this removes.
- **It FAILS OPEN.** If the lease cannot be taken the job runs anyway. The alternative turns a
  database blip into "no commission was paid today", which is far worse than duplicate work — and
  it is only safe _because_ the jobs tolerate running twice. **That ordering is the whole design:
  this is an optimisation, and an optimisation that becomes load-bearing is a single point of
  failure nobody designed.**

`test/job-lease.spec.ts` pins all of it against real Postgres, including the fail-open path and the
`WHERE expires_at < now()` predicate — without which the upsert always wins, every instance takes
the lease from every other one on every tick, and the table looks busy while coordinating nothing.

## The bridge push surface is ONE REQUEST PER ACCOUNT, and needs its own limit

`POST /webhooks/mt5/accounts` takes a single snapshot, and the bridge's sweep calls it once per
account every `SweepIntervalSeconds` (300). The global throttle is **120/min** — sized for a human
clicking a console — so a server with more than ~120 accounts exhausted a person's budget about
eight seconds into every sweep.

That was **data loss, not slowness**, because of the other side:
`AccountSyncWorker.DeliverAsync` treated any 4xx as permanent and did not retry. Right for 400 and
404, catastrophic for 429. Snapshots past the budget were DROPPED, and since the sweep pushes in a
stable order it was the same tail every round — a permanent blind spot in the mirror, widening as
the broker opens accounts, announced by nothing louder than one warning per account.

Both halves are fixed, and each alone would have left the failure reachable:

|        |                                                                                            |
| ------ | ------------------------------------------------------------------------------------------ |
| CRM    | `@Throttle({ default: { limit: 6_000, ttl: 60_000 } })` on `Mt5WebhooksController`         |
| bridge | 429 and 408 are transient — retried, and logged as RATE LIMITED rather than as a rejection |

**Raised, never `@SkipThrottle`.** `BridgeSecretGuard` is what protects this surface, so the limit
is not the control — but a ceiling still bounds a leaked secret and a bridge wedged in a retry
loop. 6000/min is ~100/s against ~16/s observed, and is past this design's own ceiling anyway: at
16/s a 300s sweep cannot push more than ~4,800 accounts before the next one starts, whatever the
limit says.

**Beyond that the answer is a BATCH endpoint, not a bigger number.** One request per account is
what does not scale — at 100k accounts the sweep is 333 req/s sustained, and if the CRM owns 1k of
them, 99% of it is discarded after two queries. Neither webhook batches today. `test/bridge-webhook-throttling.spec.ts`
asserts the limit clears the sweep rate by an order of magnitude rather than merely existing,
because inheriting the global limit by omission is exactly how this happened.

**Snapshots deliberately have no outbox, unlike deals.** A deal is a financial event that must
never be lost, so `OutboxDispatcher` persists it in SQLite and retries until the CRM takes it. A
balance snapshot is re-read every sweep, and a superseded one must NOT be delivered later — the
staleness guard would reject it anyway. Fire-and-forget is correct here; what was wrong was
dropping the CURRENT one and calling it a rejection.

## The trading-account balance mirror has THREE writers and one rule

`trading_accounts.balance` mirrors MT5 (0081) and MT5 is the authority. Three paths write it —
`ingestSnapshot` (the sweep), `recordFromOperation`, and `TransfersService.settle` — and every one
of them must stamp `balance_synced_at` with **the moment MT5 was ASKED**, then refuse to move a
figure read more recently than its own.

The transfer path used to stamp `settledAt` — "now" — and compare nothing. That loses data: the
executor reads at T1, the sweep reads a fresher figure at T2 and writes it, then settle writes the
T1 figure stamped T3 and wins. The mirror goes backwards while its timestamp says forwards, which
is worse than stale — every other writer then trusts a number that is not a read time. It now takes
`balanceReadAt` from the executor, which stamps it **before** calling the bridge: the earliest
instant the figure could describe. Erring early costs a skipped write the sweep repairs; erring
late lets a stale figure overwrite a newer one. A skipped write is SUCCESS and must never throw —
the money has already moved and the wallet leg is posted in the same transaction.

### The mirror never vetoes a settlement, and never computes

`settle` writes MT5's figure or **nothing**. It used to have a second path: when the balance could
not be read back, it computed `balance ± amount` and guarded the result with `>= 0`, throwing when
that failed. The throw rolled back the wallet leg beside it, so the money had left the trading
account and arrived nowhere, with the transfer left `pending` — the one state nothing distinguishes
from a transfer still waiting on the bridge.

That guard read as overdraw protection and could not have been. `settle` is reachable **only**
through a bridge call that already succeeded, and MT5 checks the real balance before it moves
anything, so the account was never short — the MIRROR was, which is a thing a mirror is allowed to
be. A non-authoritative copy vetoing a fact the authority has already established is an inversion,
and it charged the client for a failed HTTP read.

Both halves are now settled the way the column's own schema comment always demanded — _"nothing here
computes it"_, _"anything that adds to this column reintroduces the bug"_:

|                          | before                                | now                                                 |
| ------------------------ | ------------------------------------- | --------------------------------------------------- |
| balance unreadable       | compute `balance ± amount`, unstamped | write nothing; keep the figure **and its real age** |
| computed figure negative | throw, rolling back the wallet leg    | cannot arise — there is no computed figure          |
| overdraw check           | `settle`, after MT5 moved the money   | `request`, before anything moves                    |

`settle`'s own `@param` had described the correct behaviour all along — "the column is then left
alone rather than computed, because a known-stale figure beats a confident wrong one" — while the
code computed anyway. **When this file's doc and its code disagree about a money rule, the doc is
evidence, not decoration.**

The `request`-time check counts **in-flight** pending transfers against the balance, because a check
reading only the column is defeated by clicking twice. It takes no `FOR UPDATE`: `settle` locks
transfer → wallet → `trading_accounts`, so an account lock here would invert that order and deadlock
the two paths. It is advisory by construction anyway — the mirror can be stale in either direction
and **MT5 is still the gate**. Erring against a stale-low mirror costs a client one retry after the
next snapshot; erring the other way costs a support ticket about money in neither place.

## Realtime — a second listener, on purpose

The WebSocket does **not** run on :3001. `REALTIME_ENGINE=uws` (the default) runs Socket.IO on
uWebSockets.js, which owns its own TCP listener, so the socket is on **`REALTIME_PORT`, 3003**.
`REALTIME_ENGINE=node` attaches it to the API port instead and is the one-variable revert.
`common/realtime/realtime-io.adapter.ts` is the entire seam — nothing above it knows which engine
is running.

**In production the realtime origin must share the API's HOSTNAME.** Cookies ignore the port, so a
different port is fine; `__Host-` cookies are host-scoped by design, so a realtime _subdomain_
would receive no cookie and every handshake would be refused with nothing to explain why. Route
`wss://api…` to the realtime port at the ingress.

`modules/notifications/realtime.gateway.ts` holds the rooms (`admin:<id>` / `client:<id>` — the
kind is part of the name so two audiences cannot collide on a shared uuid) and the Postgres
`LISTEN`. **The bus is the database, not the application**: `pg_notify` fires from an AFTER INSERT
trigger (migration 0047) and is delivered only on COMMIT, so a rolled-back money transaction
cannot announce itself. That also removes the need for a Redis adapter — every instance LISTENs.

**Four channels share that one listening connection**, separated by `message.channel`:
`notification_created` (a bell row landed), `notification_changed` (one of a reader's rows was
READ or RESOLVED — migration 0140; the payload names a room and nothing else, and the browser
re-reads), `resource_changed` (a shared admin queue moved), and `mt5_live` (live MT5 figures for an
account somebody has on screen). A channel per feature would cost a
permanent Postgres connection each. `mt5_live` is the odd one out and worth knowing about: it is
high-rate, it carries real data rather than a hint, and it is published from a plain `SELECT
pg_notify` rather than a trigger — it describes an observation the bridge already made, so there is
no transaction to hold it until. Because it carries data, the ROOM is the authorization: it is
resolved from the account's owner before publishing, never from anything the socket or the bridge
said.

`realtime.principal.ts` authenticates the handshake by calling `AdminAuthenticator.authenticate`
and `JwtStrategy.validate` — the same objects the HTTP guards use. Do not re-implement those
checks for sockets; that is how two authorization paths drift until one is missing an enforcement
point. Sockets close at token expiry (15-minute ceiling) so the reconnect re-authenticates.

## Admin notifications are TASKS (migration 0140, D-78)

The owner's rule, from the broker buying the platform: an admin notification means "you must
HANDLE something", it is scoped to the reader's clients always, and it disappears when the reader
opens it — and for EVERY admin the moment anybody handles the item. Read these before touching
`modules/notifications`, the dispatch port, or any item table's status column:

- **`common/notifications/admin-notification-catalogue.ts` is the one list** of what may ring an
  admin's bell. The PERMISSION comes from it (any one of a kind's keys qualifies), never from the
  call site. Before adding a kind, name what the recipient must DO; if nothing, it is not a
  notification. The frontend's display map is keyed by the same enum (typegen), so it cannot lag.
- **`notifyAdmins({ kind, params, dedupeKey?, subject: { id, clientId } })`** — the subject is
  mandatory. Post-commit and never throws, like before; the insert locks the item `FOR SHARE` and
  re-checks it is still open (`stillOpen`), so an item decided before the fan-out landed rings
  nobody. `notify()` writes CLIENT rows only — an admin row without a subject is refused by type and
  by `notifications_admin_subject_ck`.
- **Handled is decided by TRIGGERS on the item tables**, not by code: `transactions` (leaves
  `pending`, becomes terminal, or `rival_needs_attention` clears), `kyc_submissions` (leaves
  submitted/under_review, or is deleted — claim/release do NOT resolve), `ib_applications`,
  `transfers`, `ib_accruals` (reversed). `resolve_admin_notifications` catches everything it could
  raise and WARNs: a bell can never roll back the decision it describes. `resolved_by` is set only
  when the ending UPDATE itself wrote the reviewer — a cancel or a system settle leaves it blank
  rather than crediting the approver. **A new path that moves one of these items needs no bell
  code** — which is the point.
- **Scope is applied on READ.** `NotificationsStore.adminVisibility` (recipient, the kinds the
  admin can act on NOW, `clientScopePredicate` over `subject_user_id`) is ANDed into the list, the
  badge summary and every marker; out of scope reads as not found. The client's name is joined at
  read time and masked by the RBAC-03 interceptor; `params` still carries no identity
  (`notification-params-no-pii.spec.ts`), because the socket and the client feed are unmasked.
- **Inbox** = unread AND unresolved; **History** = everything, with `resolution`. Markers: read,
  unread (the undo), read-all (`category?`, `upTo` — never past the newest row shown),
  read-subject (the reader opened the item itself).
- **An attention task ends with "Mark resolved"** — `PATCH /admin/transactions/:id/attention/resolve`
  (a note, audited `transaction.attention_resolve`); it moves no money, it clears the flag, and the
  trigger ends the task. `GET /admin/transactions` carries `needsAttention`/`attentionReason` per row
  and takes `attention=true` (list, summary and export alike, through the one predicate builder) —
  where the deposit task links.
- **Retention**: admin rows a year, client rows 90 days (`RETENTION_DAYS`).
- ⚠️ **0140/0141 numbering**: HazimeHsen's commission-types migration was `0140` with the SAME
  journal `when` as this one before the merge renumbered it `0141`. A database that ran HIS 0140
  before the merge has watermark `1789139298747` and would silently SKIP this migration. Repair:
  delete that `drizzle.__drizzle_migrations` row, then `db:migrate` (his 0141 is re-runnable).

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

⚠️ **`docker compose down -v` INVALIDATES `r2:reconcile`'s premise, and the script
will be right to scream.** Uploaded documents live in the R2 BUCKET; their registry
rows live in `stored_objects`, which is in the volume. The bucket is not. So wiping
the dev database leaves the registry empty and the bucket still holding every
document any dev run ever uploaded — and `r2:reconcile`, which diffs both ways,
reports every object as an orphan. That output is CORRECT and reads as a
catastrophe.

Two things follow. A zero in `stored_objects` after a reset is empty **by design,
not by failure** — know which you are looking at before investigating. And those
objects are now unreferenced forever and still billed: small at dev volumes, but it
compounds across resets, so a reset has a storage cost rather than being free. If
the bucket is ever to be pruned, the moment is immediately after a reset, when
everything in it is orphaned by definition; later the decision stops being trivial
because new uploads are interleaved with old orphans.

The dev database was reset this way on 10 Sep 2026.

## KYC: the identity core (migration 0147, 26 Sep 2026)

The rules are cross-repo and live in `../CLAUDE.md` ("The identity core is the PLATFORM's"). Where
they live here:

| file | owns |
|---|---|
| `common/kyc/identity-core.ts` | the pure seam: `IDENTITY_FIELDS`, the tiers, `CORE_STEPS`, reserved slugs and names, `newCustomSlug`, label normalising |
| `store/kyc-config.store.ts` | injects the identity into Personal Information on READ, strips it on WRITE; the `ETag` version |
| `modules/admin/kyc-config-integrity.ts` | every refusal, keyed `steps.i[.fields.j]` — run by EVERY config write |
| `modules/compliance/kyc-step-state.ts` | the one judge; `approvalBlockers` is what approval re-asks |
| `modules/compliance/kyc-review-layout.ts` | the review's `layout`, from `form_snapshot` then the config |
| `KycService.requestReverification` | `POST /admin/kyc/:id/reverify` — level 0, the stamp, its own email |
| `kyc_field_labels` (0148) | every question's name, written by `setSteps` and never deleted — so an answer to a question since removed is named in the review, not printed as its key |

- **`If-Match` is optional on `PUT /admin/kyc-config`.** The builder always sends it; a caller that
  omits it gets last-write-wins, which is what the e2e restore relies on. Sent and stale, it is 409
  `KYC_CONFIG_STALE`, decided under `pg_advisory_xact_lock`.
- ⚠️ **The version never comes back as it was sent, in production.** Caddy's `encode zstd gzip`
  appends the encoding to a strong ETag it compresses (`"<digest>-zstd"` to a browser) and does not
  strip it from `If-Match`. Compared as sent, EVERY production save answered 409 "someone else
  changed this form" (reported 28 Sep 2026; localhost has no proxy, so no test saw it). `If-Match`
  is read with `versionFromIfMatch` (`common/http/if-match.ts`), which FINDS the digest inside
  whatever a proxy wrapped around it. Pinned by `if-match.spec.ts` and the If-Match block of
  `test/kyc-config-round-trip.spec.ts`. Any new strong ETag used for `If-Match` goes through it.
- **Approval re-asks the judge, so an e2e fixture must satisfy it.** `fixtureEvidence` in `seed.ts` gives the
  review pool and the fresh client placeholder page paths. They are never real objects, and the file route
  answers 404 for them.
- Pinned by `common/kyc/identity-core.spec.ts`, `kyc-config-integrity.spec.ts`,
  `test/migration-0147-kyc-identity-core.spec.ts` and `test/kyc-reverification.spec.ts`.

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
  `config/permissions.json` (which _is_ wired, via `admin-rbac.service.ts`). The dep is kept
  only as a marker for the unbuilt ARCHITECTURE §2 item — same for `bullmq`/`ioredis` and §9.
- `src/workers/` is a placeholder with no worker code.
- Seeds re-run on every boot in dev and are idempotent.
