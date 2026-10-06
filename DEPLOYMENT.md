# Deploying the backend

> The whole production setup on one page (servers, network, every setting, how to change it):
> [INFRASTRUCTURE.md](INFRASTRUCTURE.md). This file is the backend's procedures.

> ## A push to `production` deploys to the Linux backend server
>
> |            |                                                                                                                                                                                                                                                                                                             |
> | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Server     | Hostinger KVM 2, **Düsseldorf**, `187.7.64.167` (`ssh oxshare-api`), Ubuntu 26.04, provisioned per DEPLOY-PLAYBOOK §2–§3 on 5 Oct 2026                                                                                                                                                                      |
> | Stack      | Caddy (the only published ports: 80, 443, 443/udp) → `api` (:3001, realtime :3003) + `postgres` + `redis`, all `docker-compose.prod.yml`                                                                                                                                                                    |
> | MT5 bridge | Alone on the Contabo Windows server, reached through a **WireGuard tunnel** in BOTH directions: the backend calls `http://10.8.0.2:5055`, the bridge posts back to `http://10.8.0.1:8080` (its `Crm:BaseUrl`). Neither is reachable from the internet; `/v1/webhooks/mt5/*` answers 404 on the public site. |
> | Pipeline   | `.github/workflows/ci.yml`: **build once on `main`, promote on `production`** (main: checks ∥ build → promote `tree-<content key>`; production: deploy that verified image in ~2 min, zero downtime via `deploy/release.sh`). See INFRASTRUCTURE.md.                                                        |
> | Rollback   | `ssh oxshare-api`, `cd oxshare-crm-backend && bash release.sh rollback`: the same zero-downtime switch back to the previous version, whose image is kept. Migrations are forward-only, so they are not reversed.                                                                                            |

## Where the frontends must live — a hard requirement, not a preference

**The frontends and this API must be served from SIBLING SUBDOMAINS of one
registrable domain.** `admin.example.com` + `api.example.com` is correct;
`admin.example.net` + `api.example.com` is not, and neither is any pairing whose
parent domains differ.

This is not stylistic. Sessions are httpOnly `__Host-` cookies, which browsers
scope to exactly one hostname, and `SameSite=Lax` sends a cookie only on a
SAME-SITE request. The frontends therefore call this API **directly** from the
browser rather than through a same-origin proxy: that is what makes the API's own
host set the cookie, which in turn is what lets the realtime WebSocket — which
cannot go through a proxy, because it must stay open — present that cookie when
it dials the same host.

Get this wrong and the failure is quiet and specific: **HTTP works, login works,
and realtime silently never connects.** Every handshake is refused with a
`logger.warn` and nothing else, because the socket reaches a host the browser
holds no cookie for. It cost a full day to diagnose the first time (18 Aug 2026);
the note exists so it costs nobody a second one.

Consequences to plan for:

- `PORTAL_URL` / `ADMIN_URL` must be the EXACT browser origins — scheme + host, no
  trailing slash. They are compared by string equality for CORS, for the CSRF
  origin check and for the WebSocket handshake.
- Preview deployments on a hosting provider's random hostnames are
  cross-site and will be refused on every authenticated write. That is the guard
  working, not a bug. Give previews their own backend or accept the limit.
- The frontends read the API origin from `NEXT_PUBLIC_API_BASE_URL`, which also
  feeds their CSP `connect-src` and `img-src`. A value that disagrees with reality
  blocks requests SILENTLY — a CSP refusal on an `<img>` just renders the
  fallback.
- If a future host genuinely cannot satisfy this (the client insists on split
  domains), the supported alternative is ticket-based socket auth: mint a
  short-lived single-use token from an authenticated endpoint and pass it in the
  handshake. It works under any topology and costs the `__Host-` guarantee,
  because a token in JavaScript is a token XSS can steal. Not built; decide
  deliberately before promising it.

Verified on the live domains 6 Oct 2026 (65 browser checks): `admin-dashboard.oxshare.com` and
`portal.oxshare.com` against `api-admin.oxshare.com`: sign-in on both, foreign origin 403, a real
cross-site attack page created nothing, and a `/realtime` connection admitted (`40/realtime,{...}`)
using only the cookies the sign-in returned.

## GitHub secrets

Settings → Secrets and variables → Actions. The deploy job validates all of these
**on the runner** before touching the server, so a missing or malformed one fails in
seconds with a message naming it — not as a container crash-loop twenty minutes later.

### Infrastructure

Host-specific behaviour this pipeline already encodes: the runner polls TCP before
SSHing (the host's edge DDoS scrubbing intermittently drops shared-runner IPs), Caddy
is explicitly reloaded after each deploy, every remote `compose exec` ends in
`</dev/null`, and **HTTP/3 is on** — UDP/443 delivery to this VPS was measured
end-to-end (containerized UDP listener on 443/udp, probed from the public
internet, 17 Aug 2026).

| Secret            | What                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOCKER_USERNAME` | Docker Hub username. The image is pushed to `<username>/oxshare-crm-backend`, which **must exist and be PRIVATE** first: the build refuses a public or missing repository (it was found public on 5 Oct 2026). |
| `DOCKER_SECRET`   | Docker Hub access token (Account Settings → Security → New access token).                                                                                                                                      |
| `VPS_HOST`        | `187.7.64.167` (Hostinger `srv2036531`, Düsseldorf, Ubuntu 26.04, Docker 29 + Compose, provisioned 5 Oct 2026).                                                                                                |
| `VPS_USER`        | `deploy` — already exists on the box, key-only, in the `docker` group.                                                                                                                                         |
| `VPS_SSH_KEY_B64` | `base64 -w0 ~/.ssh/oxshare_deploy \| clip.exe` (DEPLOY-PLAYBOOK §4): the CI key already authorised for `deploy` on both new servers. Single-line because a pasted multi-line key gets its newlines mangled.    |
| `VPS_PORT`        | Optional. SSH port, default 22.                                                                                                                                                                                |
| `API_DOMAIN`      | The API's domain (`api.<buyer-domain>`), with an **A record pointing at `187.7.64.167`** (DNS-only if on Cloudflare). Caddy issues the certificate itself over HTTP-01, so the record must be live first.      |
| `ACME_EMAIL`      | Where Let's Encrypt sends certificate expiry notices.                                                                                                                                                          |

### Application

Every one of these is load-bearing: `src/config/env.validation.ts` refuses to boot the
production container without them.

| Secret                                                                 | Constraint                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_PASSWORD`                                                    | Only `A-Z a-z 0-9 . _ ~ -` (it is interpolated into `DATABASE_URL`). Generate: `openssl rand -hex 32`.                                                                                                                   |
| `ADMIN_JWT_SECRET`                                                     | ≥ 32 chars. `openssl rand -base64 48`.                                                                                                                                                                                   |
| `ADMIN_JWT_REFRESH_SECRET`                                             | ≥ 32 chars, **different from the other three**.                                                                                                                                                                          |
| `JWT_ACCESS_SECRET`                                                    | ≥ 32 chars, different.                                                                                                                                                                                                   |
| `JWT_REFRESH_SECRET`                                                   | ≥ 32 chars, different. The validator throws on any duplicate among the four — a reused secret makes a token minted for one surface valid on the other.                                                                   |
| `APP_ENCRYPTION_KEY`                                                   | ≥ 32 chars. Seals secrets stored via the settings screens (the SMTP relay password, API keys). **Never rotate it casually**: a changed key means stored ciphertexts stop decrypting.                                     |
| `PORTAL_URL`                                                           | `https://…`, **no trailing slash** (compared to the browser's `Origin` header by exact string equality — a slash kills every WebSocket handshake silently).                                                              |
| `ADMIN_URL`                                                            | Same rules. These two decide CORS _and_ cookie security: the real `https://admin.<domain>` and `https://portal.<domain>` the frontends server serves.                                                                    |
| `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET`  | All four. Production refuses `STORAGE_DRIVER=disk` outright, so there is no running without R2.                                                                                                                          |
| `RIVAL_BASE_URL` `RIVAL_API_KEY` `RIVAL_WEBHOOK_KEY`                   | Optional. Rival is configured on its `payment_providers` row (System → Payment providers); these apply only while that row was never saved.                                                                              |
| `MT5_BRIDGE_API_KEY` `MT5_BRIDGE_SECRET`                               | **Required.** The bridge's `Bridge__ApiKey` and `Crm__Secret`, agreed with HazimeHsen (rotate both, here AND on the bridge, if they are ever shared). The URL is NOT a secret: it is the tunnel, `http://10.8.0.2:5055`. |
| `MT5_BRIDGE_TIMEOUT_MS` `MT5_BRIDGE_READ_TIMEOUT_MS`                   | Optional. Production used `MT5_BRIDGE_TIMEOUT_MS=30000`.                                                                                                                                                                 |
| `OPENAI_API_KEY` `OPENAI_MODEL`                                        | Optional. The portal assistant; without a key it answers 503. Use a DEDICATED OpenAI project with a monthly budget.                                                                                                      |
| `IB_ACCRUAL_START`                                                     | **Carry the production value over** (`all` on 5 Oct 2026). A commercial decision: unset holds an aged commission backlog unpaid until somebody decides.                                                                  |
| `COMMISSION_MAX_PER_DEAL` `COMMISSION_MAX_SHARE_OF_DEAL` `DB_POOL_MAX` | Optional; omit for the defaults.                                                                                                                                                                                         |

**There is no `SMTP_*` secret, deliberately.** Mail is configured by an administrator
on **Settings → Email** and stored (password encrypted under `APP_ENCRYPTION_KEY`) in
the database. Until that is done the app runs, logs a loud warning at boot, and any
attempt to send refuses with `MAIL_NOT_CONFIGURED` — it does not silently fail.

## The server, once

Done on 5 Oct 2026 (DEPLOY-PLAYBOOK §2–§3): updates + reboot, 2 GB swap, Docker with
log rotation, the `deploy` user (keys `id_ed25519` + `oxshare_deploy`), UFW allowing
22, 80, 443 and 443/udp, fail2ban, unattended security upgrades. UDP/443 delivery was
measured, so HTTP/3 stays on. WireGuard (`wg-quick@wg0`, `10.8.0.1/24`, UDP 51820
allowed **from the Contabo IP only**) is up, and a systemd drop-in
(`/etc/systemd/system/docker.service.d/after-wireguard.conf`) starts Docker after it, because
Caddy binds the bridge's door on `10.8.0.1:8080`; its `[Peer]` is added once the bridge's
public key arrives.

```bash
ssh oxshare-api                 # deploy@187.7.64.167, no password
sudo wg show                    # (as root) the tunnel: a recent handshake = bridge reachable
curl -s http://10.8.0.2:5055/health/ready     # from the server, once the peer is in
```

Everything under `~/oxshare-crm-backend/` is owned by the pipeline:
`docker-compose.prod.yml`, `Caddyfile` and `.env` are overwritten on every deploy. Change
them by changing the repo or the secrets, never by editing the box.

## The first administrator

Production skips the dev seeds — `runSeeds()` plants the whole e2e cohort
(`e2e@`, `e2e-kyc@`, `e2e-restricted@` and a batch of `@oxshare-e2e.test` clients)
and must never touch a live database. A fresh database therefore has no admin, and
the invite flow needs a signed-in admin to send an invite.

**Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` as repository secrets and
this needs no manual step at all.** Every deploy runs `scripts/bootstrap-admin.mjs`
after the migrations: it creates one `Administrator` role holding all 67 catalog keys
and one `master_admin` account, and does nothing whatsoever if that email already
exists. Idempotency is by database constraint — unique role name, unique admin email —
so it never resets a password, never re-widens a role an operator has narrowed, and
never resurrects an account somebody deleted.

That is what makes rebuilding this VPS, or moving to a different one, a pure
`git push`: new server, empty volume, and the admin exists when the deploy finishes.
The password must be at least 12 characters; the script refuses shorter ones rather
than leaving a guessable credential on the only account holding every permission.

Omit the two secrets and the deploy prints that it is skipping the bootstrap. To do it
by hand instead:

```bash
ssh <user>@<vps>
cd oxshare-crm-backend
read -rsp 'Admin password: ' PW && echo      # not echoed, not in shell history
docker compose -f docker-compose.prod.yml run --rm \
  -e BOOTSTRAP_ADMIN_EMAIL='you@company.com' \
  -e BOOTSTRAP_ADMIN_PASSWORD="$PW" \
  api node scripts/bootstrap-admin.mjs
unset PW
```

Then, in this order:

1. Sign in at the admin app and **change that password** — it lives in a repository
   secret and in the VPS `.env`, which is the wrong home for a standing credential.
2. **Settings → Email** — configure the SMTP relay and use _Send test message_.
   Nothing is delivered until this is done: no invites, no verification links, no KYC
   decisions. The API logs `NO MAIL SERVER IS CONFIGURED` at every boot until then.
3. Only now invite the other admins — invites arrive by mail.

`role: 'master_admin'` is set explicitly and is **not** the dead column
`admin.guard.ts` describes: `admin-reset.ts` reads it twice, and the second reading is
what stops a peer resetting this account's password. See the comment in the script.

## Auth, sessions and anti-forgery — the verified matrix (21 Aug 2026)

Recorded because the cross-host anti-forgery failure cost a day, and because the
next person who sees `failed anti-forgery validation` should know exactly which
behaviours are already proven so they look only at what is new.

**Why it could not reproduce locally, and so was missed.** Cookies ignore the
PORT, so on a dev machine the admin app (`:3002`) and the API (`:3001`) share
one cookie jar: the page reads the real CSRF cookie and never needs the echoed
`X-OxShare-CSRF` header. Cross-host the page CANNOT read the cookie and depends
on the echo entirely — and `CsrfEchoMiddleware` read `req.path`, which inside a
`forRoutes('*')` middleware is `"/"` for every request, so it classified every
admin request as portal and echoed nothing (fixed 17164fd; HTTP-level regression
test 7265a4d boots the real app and asserts the header over the wire). A second,
independent bug — the per-refresh rotation race — is 96e3af0. Both were real.

**What was exercised against the fixed build, and the result.** API level with
curl; journeys in a real browser (Playwright) against both apps.

| Area             | Case                                                                                                     | Result                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| CSRF guard       | correct request (cookie + header + origin)                                                               | 201                                                                                  |
|                  | missing header / wrong header / foreign origin / no origin+referer                                       | 403 each                                                                             |
|                  | header present but no session cookie                                                                     | 401 (nothing to forge)                                                               |
|                  | GET needs no CSRF                                                                                        | 200                                                                                  |
| Sessions         | logout → old cookie on /me                                                                               | 401; cookies cleared; browser-BACK lands on /login                                   |
|                  | refresh rotates the refresh token; new session works                                                     | 200                                                                                  |
|                  | replay of a rotated token INSIDE the 30s grace                                                           | accepted as a retry (by design, `RETRY_GRACE_MS`)                                    |
|                  | replay of a rotated token OUTSIDE the grace                                                              | 401, and the whole family is revoked (live session → 401)                            |
|                  | two tabs refresh simultaneously                                                                          | loser gets `401 SESSION_SUPERSEDED`, frontend retries once, both tabs stay signed in |
|                  | expired access token                                                                                     | 401 → silent refresh 200 → write with the PRE-refresh CSRF token 201                 |
| Surfaces         | admin cookie on portal routes                                                                            | 401 (isolated)                                                                       |
|                  | admin + portal sessions in ONE jar (both cookie sets present)                                            | admin writes 201, also after refresh; portal writes 200                              |
| Browser (admin)  | write after login / after HARD REFRESH / after nav×3+refresh / in tab 2 / back in tab 1 / after re-login | 201 each                                                                             |
|                  | logout in tab 1 → tab 2 untouched                                                                        | tab 2 lands on /login (session-channel sync)                                         |
| Browser (portal) | write after login / after hard refresh / after nav+refresh                                               | 200 each, CSRF header learned every time                                             |

**The one thing that is a design choice, not a gap:** a rotated refresh token
replayed within 30 seconds is honoured as a retry rather than treated as theft,
because a dropped response is far more common than a stolen token and treating
it as theft would sign out a user whose network blinked. Outside that window
reuse revokes the family. `refresh-reuse.spec.ts` pins both halves.

## The database: start again empty, or restore a dump

Both run on `oxshare-api`, in `~/oxshare-crm-backend`, as `deploy`. Read the live colour first:

```bash
cd ~/oxshare-crm-backend && . ./release.env      # ACTIVE=blue|green, BLUE_TAG, GREEN_TAG
C="docker compose -f docker-compose.prod.yml --env-file .env --env-file release.env"
TAG=$([ "$ACTIVE" = blue ] && echo "$BLUE_TAG" || echo "$GREEN_TAG")
```

**Start again from an EMPTY database** (everything is deleted: clients, money, settings, admins):

```bash
$C stop api_$ACTIVE
$C exec -T postgres sh -c 'dropdb -U oxshare oxshare && createdb -U oxshare oxshare' </dev/null
bash release.sh deploy "$TAG"       # migrates the empty database, recreates the bootstrap admin, switches over
```

The bootstrap admin comes back with `BOOTSTRAP_ADMIN_PASSWORD` (change that secret first if the
password was ever shared) and must scan a new authenticator QR code. Everything set in the console is
gone too: email (Settings → Email), payment providers, the KYC form, roles. Client numbering restarts
at #1000000. Documents already uploaded stay in the R2 bucket, unreferenced.

**Restore a dump** (`pg_dump -Fc` from another server, copied here with `scp`):

```bash
$C stop api_$ACTIVE
$C exec -T postgres sh -c 'dropdb -U oxshare oxshare && createdb -U oxshare oxshare' </dev/null
$C exec -T postgres pg_restore -U oxshare -d oxshare -j 2 --no-owner < oxshare.dump
bash release.sh deploy "$TAG"
```

`-j 2` stays inside the 1 GB `/dev/shm` (SERVER-CONCEPTS §7a). Compare row counts AND the number of
indexes with the source: a restore that runs short of shared memory reports "errors ignored on
restore" and silently skips indexes while every row is present. The dump must come from Postgres 16
or older, and `APP_ENCRYPTION_KEY` must be the source's, or every stored provider and email secret
stops decrypting.

## The Windows bridge server (Contabo, `169.58.194.0`)

It runs ONLY the MT5 bridge (`Mt5Bridge.Api.exe`, HazimeHsen's repo), started by Windows
**scheduled tasks** that run scripts in `C:\OxShare\`:

| Task           | Script             | What it is                                                                                                                                                                                     |
| -------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OxShare Bridge | `start-bridge.ps1` | **Keep.** Starts the bridge on `127.0.0.1:5055` and `10.8.0.2:5055` only (never `0.0.0.0`); waits for the tunnel at boot.                                                                      |
| OxShare Deploy | `deploy.ps1`       | **Keep.** Releases the BRIDGE from git every 2 minutes. Its old-backend block must be switched off, `finally` included: that block restarts the old API whenever nothing answers on 8080/8081. |
| OxShare API    | `start-api.ps1`    | The old backend. Disable and remove (INFRASTRUCTURE.md, open items).                                                                                                                           |
| OxShare Caddy  | `start-caddy.ps1`  | Served the old API on 80/443. Disable and remove, then close 80/443 in the Windows firewall.                                                                                                   |

**The tunnel**, WireGuard for Windows, tunnel `oxshare-backend`:

```
[Interface]
PrivateKey = (generated by the app; never leaves the server)
Address = 10.8.0.2/32
ListenPort = 51820

[Peer]
PublicKey = <the backend server's key: /etc/wireguard/wg0.pub>
Endpoint = 187.7.64.167:51820
AllowedIPs = 10.8.0.1/32
PersistentKeepalive = 25
```

Both sides know each other's address, so a restart on either side reconnects in seconds.

**Windows Firewall**: inbound UDP 51820 from `187.7.64.167` only; inbound TCP 5055 from
`10.8.0.1` only; RDP 3389 from known IPs only (Contabo's VNC console is the fallback). Nothing
else inbound once the old API and Caddy are off.

**Bridge settings that name the backend** (`Crm:*` in its configuration): `Crm:BaseUrl =
http://10.8.0.1:8080` (the tunnel), `Crm:Secret` = this repo's `MT5_BRIDGE_SECRET`, and
`Bridge:ApiKey` = `MT5_BRIDGE_API_KEY`. A change on one side needs the same change on the other.

## Replacing a server, or adding one

Everything a server needs is in this repo, the secrets and DNS:

1. `ssh-copy-id -i ~/.ssh/id_ed25519.pub root@<new-ip>` (the root password from the provider).
2. Provision it (idempotent, safe to re-run):
   ```bash
   ssh root@<new-ip> "ROLE=api ADMIN_KEY='$(cat ~/.ssh/id_ed25519.pub)' \
     CI_KEY='$(cat ~/.ssh/oxshare_deploy.pub)' BRIDGE_IP=169.58.194.0 \
     BRIDGE_PUBKEY='<the bridge tunnel public key>' bash -s" < deploy/provision-server.sh
   ```
   `ROLE=web` for the frontends server (no `BRIDGE_*`). Reboot if it says so, then run the
   HTTP/3 check (DEPLOY-PLAYBOOK §7).
3. A new BACKEND server prints a NEW WireGuard public key: put it in the Windows tunnel's
   `[Peer] PublicKey` and its IP in `Endpoint`, and in the Windows firewall's UDP 51820 rule.
4. Update the `VPS_HOST` secret, `~/.ssh/config`, the DNS record, and for the backend the
   3pay IP whitelist. Push `production` (or re-run the workflow): the pipeline does the rest.
5. Data: a new backend server starts with an empty database; restore the latest dump
   ("The database" above).

## Changing the domain

Nothing in the code names a domain, so it is secrets, DNS and a redeploy:

1. DNS on the new domain (TTL 300): `api` → `187.7.64.167`, `admin` and `portal` → `31.97.52.63`.
2. Backend secrets: `API_DOMAIN`, `PORTAL_URL`, `ADMIN_URL`. Frontend secrets (both repos):
   `ADMIN_DOMAIN`, `PORTAL_DOMAIN`, `API_ORIGIN`.
3. Redeploy the backend, then BOTH frontends (`workflow_dispatch`). The frontends must be
   REBUILT, because the API origin is baked into their images; a restart changes nothing.
4. Point Rival's and 3pay's webhook URLs at the new API domain.
5. Sessions are cookies bound to the old API host, so everybody signs in again once.

The bridge is untouched: it talks to the backend through the tunnel, not by name.

## How this scales

Sized for launch, with a clear path:

- **Up first.** Each Hostinger server can move to a bigger plan (KVM 4, KVM 8) in hPanel
  without being rebuilt. Postgres's settings in `docker-compose.prod.yml` are sized for 8 GB;
  raise `shared_buffers` (25% of RAM) and `effective_cache_size` (60–70%) with it.
- **Out, when needed.** The API can run as several instances: every scheduled job takes a
  database lease (`job_leases`), and realtime fans out through Postgres `LISTEN/NOTIFY`, so no
  instance is special. Several API containers behind this Caddy work as-is.
- **The bridge stays ONE instance**: its idempotency store and outbox are SQLite on that
  server. Running two would let one balance operation run twice. High availability for the
  bridge means moving those stores to Postgres first (its README says the same).
- **The database** is the last step: a managed Postgres with point-in-time recovery, or a
  read replica for reporting, when one server's Postgres is no longer enough.

## Verifying a release

```bash
curl https://<API_DOMAIN>/health            # 200 — liveness
curl https://<API_DOMAIN>/health/ready      # 200, postgres + storage both up
curl https://<API_DOMAIN>/api/docs          # 404 — Swagger is production-gated; a 200 means NODE_ENV didn't land
curl -i "https://<API_DOMAIN>/socket.io/?EIO=4&transport=polling"   # 200 — realtime reachable through Caddy
```

The deploy job already asserts the uWS native binary loaded (a load failure would
silently fall back to the Node engine on :3001, leaving :3003 dead while `/health`
stays green — the one failure the health gate cannot see).

## Things that will bite if changed casually

- **The compose service must stay named `postgres`** — `src/database/db.ts` disables
  TLS for that hostname; any other name makes the API demand a certificate the
  container doesn't have.
- **`TRUSTED_PROXY_HOPS=1`** is rendered into `.env` and is correct for exactly one
  Caddy directly on the internet. Orange-clouding the domain in Cloudflare requires
  raising it to 2, or the rate limiter, RBAC-08 allowlist and audit trail all read
  Cloudflare's address as the client.
- **The `caddy_data` volume holds the certificates and the ACME account.** Deleting it
  forces re-issuance, which Let's Encrypt rate-limits per week.
- **`oxshare_uploads` holds any pre-R2 documents** (reads fall back to disk; there is
  no backfill). Don't drop it just because storage is R2.
