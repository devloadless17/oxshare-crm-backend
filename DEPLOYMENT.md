# Deploying the backend

Push to **`production`** → the backend is live. `main` is the integration branch and
never deploys; PRs and pushes to `main` stop at the `verify` job. There is nothing
else to operate: `.github/workflows/ci.yml` tests, builds one image, ships it to the
VPS over SSH, migrates, recreates the stack and health-gates the release.

```
push to production
      │
   verify        type-check · lint · §11 money tests · build · contract check
      │
   build         docker image → Docker Hub, tagged :latest and :<commit sha>
      │
   deploy        render .env from secrets → scp compose+Caddyfile+.env →
                 pull → migrate (one transaction) → up -d → health gate →
                 assert uWS actually loaded
```

Rollback: on the VPS, edit `IMAGE_TAG` in `~/oxshare-crm-backend/.env` to the previous
commit SHA and `docker compose -f docker-compose.prod.yml up -d` — the previous image is
kept on the machine for exactly this. (Migrations are not rolled back; write a
compensating migration if a schema change must be undone.)

## Where the frontends must live — a hard requirement, not a preference

**The frontends and this API must be served from SIBLING SUBDOMAINS of one
registrable domain.** `admin.example.com` + `api.example.com` is correct;
`admin.vercel.app` + `api.example.com` is not, and neither is any pairing whose
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
- Preview deployments on random hostnames (Vercel previews, for instance) are
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

Verified working 18 Aug 2026: `oxshareadmin.loadless.site` and
`oxshareportal.loadless.site` against `aipp.loadless.site` — login 200, foreign
origin 403, and a `/realtime` namespace connection accepted (`40/realtime,{...}`)
using only the cookies the login returned.

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

| Secret | What |
|---|---|
| `DOCKER_USERNAME` | Docker Hub username. The image is pushed to `<username>/oxshare-crm-backend`. |
| `DOCKER_SECRET` | Docker Hub access token (Account Settings → Security → New access token). |
| `VPS_HOST` | `2.24.160.189` (Hostinger `srv1802477`, Ubuntu 24.04, Docker + Compose v2 already installed). |
| `VPS_USER` | `deploy` — already exists on the box, key-only, in the `docker` group. |
| `VPS_SSH_KEY_B64` | The `deploy` user's private key, **base64-encoded to a single line**: `base64 -w0 <keyfile>`. Single-line because a pasted multi-line key gets its newlines mangled. |
| `VPS_PORT` | Optional. SSH port, default 22. |
| `API_DOMAIN` | The API's domain, with an **A record pointing at `2.24.160.189`** (grey-cloud / DNS-only if the DNS is on Cloudflare). Caddy issues the certificate itself over HTTP-01 — the record must be live before the first deploy. |
| `ACME_EMAIL` | Where Let's Encrypt sends certificate expiry notices. |

### Application

Every one of these is load-bearing: `src/config/env.validation.ts` refuses to boot the
production container without them.

| Secret | Constraint |
|---|---|
| `POSTGRES_PASSWORD` | Only `A-Z a-z 0-9 . _ ~ -` (it is interpolated into `DATABASE_URL`). Generate: `openssl rand -hex 32`. |
| `ADMIN_JWT_SECRET` | ≥ 32 chars. `openssl rand -base64 48`. |
| `ADMIN_JWT_REFRESH_SECRET` | ≥ 32 chars, **different from the other three**. |
| `JWT_ACCESS_SECRET` | ≥ 32 chars, different. |
| `JWT_REFRESH_SECRET` | ≥ 32 chars, different. The validator throws on any duplicate among the four — a reused secret makes a token minted for one surface valid on the other. |
| `APP_ENCRYPTION_KEY` | ≥ 32 chars. Seals secrets stored via the settings screens (the SMTP relay password, API keys). **Never rotate it casually**: a changed key means stored ciphertexts stop decrypting. |
| `PORTAL_URL` | `https://…`, **no trailing slash** (compared to the browser's `Origin` header by exact string equality — a slash kills every WebSocket handshake silently). |
| `ADMIN_URL` | Same rules. These two decide CORS *and* cookie security — both must be the real Vercel-served domains. |
| `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET` | All four. Production refuses `STORAGE_DRIVER=disk` outright, so there is no running without R2. |
| `RIVAL_BASE_URL` `RIVAL_API_KEY` `RIVAL_WEBHOOK_KEY` | Optional — omit until Rival credentials exist. |

**There is no `SMTP_*` secret, deliberately.** Mail is configured by an administrator
on **Settings → Email** and stored (password encrypted under `APP_ENCRYPTION_KEY`) in
the database. Until that is done the app runs, logs a loud warning at boot, and any
attempt to send refuses with `MAIL_NOT_CONFIGURED` — it does not silently fail.

## The VPS, once

Docker, Compose v2 and the `deploy` user already exist. What remains:

1. Point the `API_DOMAIN` A record at `2.24.160.189`. Ports 80 and 443 TCP are open;
   nothing else needs to be reachable — Postgres, Redis and the API itself are never
   published.
2. **Confirm the box is clean** before the first push (verified 14 Aug 2026 — all of
   these came back empty):

```bash
ssh deploy@2.24.160.189

docker ps -a          # expect: no containers
docker volume ls      # expect: no volumes
docker images         # expect: no images
docker network ls     # expect: only bridge / host / none
ls ~                  # expect: only dotfiles — no leftover deploy directories
df -h /               # expect: ~44G free
free -h               # 3.8G RAM — postgres+redis+api+caddy fit comfortably
ss -ltnp              # expect: only sshd — ports 80/443 free for Caddy
```

Anything left from a previous project: `docker rm -f` the container, `docker volume rm`
the volume, delete its deploy directory, and make sure its repo's deploy workflow is
disabled so nothing redeploys onto this host unexpectedly.

Everything under `~/oxshare-crm-backend/` on the VPS is owned by the pipeline —
`docker-compose.prod.yml`, `Caddyfile` and `.env` are overwritten on every deploy.
Change them by changing the repo or the secrets, not by editing the box.

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
2. **Settings → Email** — configure the SMTP relay and use *Send test message*.
   Nothing is delivered until this is done: no invites, no verification links, no KYC
   decisions. The API logs `NO MAIL SERVER IS CONFIGURED` at every boot until then.
3. Only now invite the other admins — invites arrive by mail.

`role: 'master_admin'` is set explicitly and is **not** the dead column
`admin.guard.ts` describes: `admin-reset.ts` reads it twice, and the second reading is
what stops a peer resetting this account's password. See the comment in the script.

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
