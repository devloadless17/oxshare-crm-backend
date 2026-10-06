# OxShare production infrastructure

The one page to read before changing anything about WHERE or HOW the system runs.
Step-by-step procedures live in each repo's `DEPLOYMENT.md`; this page is the map.
Last verified end to end: 6 Oct 2026.

## The shape

```
                              the internet (HTTPS only)
         ┌───────────────────────────┬──────────────────────────┐
 admin-dashboard.oxshare.com   portal.oxshare.com       api-admin.oxshare.com
         └──────────┬────────────────┘                          │
                    ▼                                           ▼
   FRONTENDS SERVER  31.97.52.63 (Paris)       BACKEND SERVER  187.7.64.167 (Düsseldorf)
   ssh oxshare-web                             ssh oxshare-api
   Caddy :80 :443 (tcp + udp/HTTP3)            Caddy :80 :443 (tcp + udp/HTTP3)
     ├─ admin_blue | admin_green  :3002          + 10.8.0.1:8080  (the bridge's door, tunnel only)
     └─ portal_blue | portal_green :3000         ├─ api_blue | api_green  :3001 (+ realtime :3003)
                                                 ├─ postgres 16   (never published)
                                                 └─ redis 7       (never published)
                                                            │
                                         WireGuard tunnel, UDP 51820, both directions
                                              10.8.0.1  ⇄  10.8.0.2
                                                            │
                                           MT5 BRIDGE SERVER  169.58.194.0 (Contabo, Windows)
                                           Mt5Bridge.Api.exe on 127.0.0.1 + 10.8.0.2 :5055
                                                            │ MT5 Web API
                                                            ▼
                                                  the broker's MT5 server
```

- **Browsers talk to both servers directly**: pages from the frontends server, data from the API.
  The frontends server never calls the backend server (verified: no server-side API calls).
- **The bridge is reachable only through the tunnel.** The backend calls it at
  `http://10.8.0.2:5055`; it posts deals and balances back to `http://10.8.0.1:8080`. Neither address
  exists on the internet, and `/v1/webhooks/mt5/*` answers 404 on the public API host.
- **Every release is zero-downtime** (blue-green, below), on both Linux servers.

## Servers

| Role       | Provider / plan                                    | IP             | OS                  | Access                                               | Runs                                                |
| ---------- | -------------------------------------------------- | -------------- | ------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| Backend    | Hostinger KVM 2 (2 vCPU, 8 GB), Düsseldorf         | `187.7.64.167` | Ubuntu 26.04        | `ssh oxshare-api` (deploy) · `ssh root@187.7.64.167` | Caddy, API (blue/green), Postgres, Redis, WireGuard |
| Frontends  | Hostinger KVM 2 (2 vCPU, 8 GB), Paris              | `31.97.52.63`  | Ubuntu 26.04        | `ssh oxshare-web` (deploy) · `ssh root@31.97.52.63`  | Caddy, admin + portal (blue/green each)             |
| MT5 bridge | Contabo Cloud VPS 4, "Hub Europe" (Lauterbourg FR) | `169.58.194.0` | Windows Server 2022 | Remote Desktop · Contabo VNC console                 | Mt5Bridge.Api.exe, WireGuard                        |

Both Linux servers are built by `deploy/provision-server.sh` (backend repo, `ROLE=api|web`), which is
DEPLOY-PLAYBOOK §2–§3 as code: updates, 2 GB swap, Docker with log rotation, the `deploy` user (key
only, docker group), UFW, fail2ban, unattended security upgrades, and for the backend WireGuard plus
Docker ordered after it. SSH: the `deploy` user takes keys only; `root` keeps password AND key (the
playbook's "never locked out" rule, with fail2ban guarding it). Keys: `~/.ssh/id_ed25519` (you) and
`~/.ssh/oxshare_deploy` (GitHub Actions).

## Domains and DNS

| Name                          | Record     | Points to      |
| ----------------------------- | ---------- | -------------- |
| `api-admin.oxshare.com`       | A, TTL 300 | `187.7.64.167` |
| `admin-dashboard.oxshare.com` | A, TTL 300 | `31.97.52.63`  |
| `portal.oxshare.com`          | A, TTL 300 | `31.97.52.63`  |

- The domain is **registered at GoDaddy** (renewal due 23 Jan 2031) and its **DNS is hosted at
  Hostinger** (`ns1/ns2.dns-parking.com`), so records are edited in the buyer's Hostinger account.
  It is NOT Cloudflare and nothing is proxied, which is what `TRUSTED_PROXY_HOPS=1` assumes.
- **All three names must stay on ONE registrable domain** (`oxshare.com`): the sessions are
  `__Host-` cookies with `SameSite=Lax` (backend DEPLOYMENT.md, "Where the frontends must live").
- No AAAA (IPv6) records, no CAA, no DNSSEC.

### Certificates

Caddy obtains and renews all three by itself (Let's Encrypt, 90-day certificates). Let's Encrypt
tells it WHEN to renew (ARI): about 30 days before expiry, and earlier if Let's Encrypt ever
revokes certificates. The first renewal is scheduled for 4–5 Dec 2026. A failed attempt is retried
with backoff, and Caddy falls back to ZeroSSL if Let's Encrypt is down.

Renewal stops only if one of these breaks, so never break them:

| Needed for renewal                                    | Broken by                                    |
| ----------------------------------------------------- | -------------------------------------------- |
| The name still points at its server                   | a DNS edit at Hostinger                      |
| Ports 80 and 443 open to the internet                 | a UFW/compose/Hostinger firewall change      |
| The `caddy_data` volume (certificates + ACME account) | `docker compose down -v`, `docker volume rm` |
| Caddy running                                         | (release.sh recreates it if it is not)       |

**The alarm**: `.github/workflows/certificate-watch.yml` checks all three certificates and the
API's health from outside every day at 06:17 UTC, and fails (GitHub emails the repository admins)
when any certificate has under 21 days left — three weeks before a browser would refuse it.
Let's Encrypt no longer sends expiry emails, so this is the only warning. To look by hand:
`docker logs oxshare_caddy 2>&1 | grep -E "renewal info|certificate obtained"` (`oxshare_web_caddy`
on the frontends server).

## Who can reach what

| Server           | Open to the internet                                              | Open to one source only                                 | Never reachable                                                           |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Backend          | 22, 80, 443/tcp, 443/udp                                          | UDP 51820 from `169.58.194.0` (WireGuard)               | API 3001/3003, Postgres, Redis; `10.8.0.1:8080` exists only on the tunnel |
| Frontends        | 22, 80, 443/tcp, 443/udp                                          | —                                                       | the apps (3000/3002)                                                      |
| Bridge (Windows) | (today also 80/443 for the old API, and 3389 RDP: see open items) | TCP 5055 from `10.8.0.1`; UDP 51820 from `187.7.64.167` | the bridge never listens on a public address                              |

The real boundary on the Linux servers is compose, not UFW: Docker bypasses UFW for published
ports, so **only Caddy publishes ports** (DEPLOY-PLAYBOOK §2). Locks that stack behind the network:
the bridge requires `X-Bridge-Key` on every call, the backend requires `X-Bridge-Secret` on every
bridge post, admins need an authenticator code, and the admin console can be limited to an IP
allowlist (Network access page).

## How code reaches production

**CI on `main`, CI + CD on `production`** (the owner's rule, 6 Oct 2026). A push to `main` only verifies:
audit, types, format, lint, build and the contract in one job, and the tests split into parallel shards
(backend 12, admin 3, portal 2), merged so the coverage floors and the every-file-ran check still judge
the whole suite. A push to `production` runs the same verification AND builds the Docker image at the
same time; the deploy starts only when both have passed, so nothing reaches a server unverified. The
image is tagged with the commit (`<repo>:<sha>`), so a rollback names exactly what it returns to.

| Repo                     | Push to `main`                   | Push to `production`                                                                | Server    |
| ------------------------ | -------------------------------- | ----------------------------------------------------------------------------------- | --------- |
| `oxshare-crm-backend`    | verify (checks ∥ 12 test shards) | verify ∥ build → deploy `loadless/oxshare-crm-backend:<sha>` via `release.sh`       | backend   |
| `oxshare-crm-admin`      | verify (checks ∥ 3 test shards)  | verify ∥ build (API origin baked in) → deploy `loadless/oxshare-crm-admin:<sha>`    | frontends |
| `oxshare-crm-client`     | verify (checks ∥ 2 test shards)  | verify ∥ build → deploy `loadless/oxshare-crm-portal:<sha>` (portal only)           | frontends |
| `oxshare-crm-mt5-bridge` | —                                | the Windows task "OxShare Deploy" polls every 2 min, builds and restarts the bridge | bridge    |

- Release flow: merge to `main` and let it go green, then push the same code to `production`; that run
  verifies again and deploys. Release the backend first when the frontends need its new routes.
- Pipelines: `.github/workflows/ci.yml` in each repo (DEPLOY-PLAYBOOK §1). `workflow_dispatch` redeploys.
- `deploy.ps1` on Windows still contains the old backend block, switched off (`$deployBackend = $false`).

## Zero downtime, and rollback

A release starts the new version in the idle colour BESIDE the live one, waits for its health check,
validates Caddy's config, switches Caddy with a graceful reload, and only then stops the old version,
which finishes its in-flight requests. A version that never becomes healthy is stopped and the live
one carries on. For the API, the new version's migrations run first, while the old one serves, so
**every migration must suit the previous release too** (add first; stop using; drop in a later
release).

Rehearsed under continuous traffic on the real servers: 734/734 and 531/531 requests during
releases, and broken releases that never received traffic (3949/3949 and 1230/1230 from the live
version).

| Do                   | Command                                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| Roll the API back    | `ssh oxshare-api` → `cd oxshare-crm-backend && bash release.sh rollback`             |
| Roll a frontend back | `ssh oxshare-web` → `cd oxshare-web && bash release.sh rollback admin` (or `portal`) |
| See what is live     | `bash release.sh status` in the same directory                                       |

Rollback keeps the database as it is (migrations are forward-only).

## Where every setting lives

**GitHub secrets** (Settings → Secrets and variables → Actions):

| Repo          | Secrets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| backend       | `DOCKER_USERNAME` `DOCKER_SECRET` `VPS_HOST` `VPS_USER` `VPS_SSH_KEY_B64` `API_DOMAIN` `ACME_EMAIL` `POSTGRES_PASSWORD` `ADMIN_JWT_SECRET` `ADMIN_JWT_REFRESH_SECRET` `JWT_ACCESS_SECRET` `JWT_REFRESH_SECRET` `APP_ENCRYPTION_KEY` `PORTAL_URL` `ADMIN_URL` `R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET` `MT5_BRIDGE_API_KEY` `MT5_BRIDGE_SECRET` `MT5_BRIDGE_TIMEOUT_MS` `OPENAI_API_KEY` `IB_ACCRUAL_START` `BOOTSTRAP_ADMIN_EMAIL` `BOOTSTRAP_ADMIN_PASSWORD` |
| admin, client | `DOCKER_USERNAME` `DOCKER_SECRET` `VPS_HOST` `VPS_USER` `VPS_SSH_KEY_B64` `ADMIN_DOMAIN` `PORTAL_DOMAIN` `ACME_EMAIL` `API_ORIGIN` (+ `CROSS_REPO_TOKEN` for CI)                                                                                                                                                                                                                                                                                                                           |

Variable `DOCKER_HUB_ALLOW_PUBLIC=true` (all three): the temporary override that lets the build push
to a public Docker Hub repository. Delete it once the three repositories are private.

**On the servers** (written by the pipelines; change the repo or the secrets, not the box):

| Where                             | Files                                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| backend `~/oxshare-crm-backend/`  | `docker-compose.prod.yml`, `Caddyfile`, `release.sh`, `.env` (rendered from secrets on every deploy), `release.env` (live colour + tags), `active-api.caddy`                                      |
| frontends `~/oxshare-web/`        | `docker-compose.yml`, `Caddyfile`, `release.sh` (twin), `.env` (domains), `release.env`, `active-admin.caddy`, `active-portal.caddy`                                                              |
| backend `/etc/wireguard/wg0.conf` | the tunnel (root only, key inline). `docker.service.d/after-wireguard.conf` starts Docker after it                                                                                                |
| Windows `C:\OxShare\`             | `start-bridge.ps1` (binds 127.0.0.1 + 10.8.0.2, waits for the tunnel), `deploy.ps1`, logs                                                                                                         |
| Windows, the bridge               | `appsettings.Production.json`: `Mt5:*` (the MT5 server and manager login), `Crm:BaseUrl` (`http://10.8.0.1:8080`), `Crm:Secret` (= `MT5_BRIDGE_SECRET`), `Bridge:ApiKey` (= `MT5_BRIDGE_API_KEY`) |
| Windows, WireGuard                | tunnel `oxshare-backend`: `10.8.0.2/32`, ListenPort 51820, peer `187.7.64.167:51820`                                                                                                              |

**In the database** (set in the admin console, sealed with `APP_ENCRYPTION_KEY` where secret): email
relay (Settings → Email), payment providers (System → Payment providers), scheduled job timings,
the KYC form, countries, roles, the IP allowlist.

**Outside**: Docker Hub (`loadless`), Cloudflare R2 (`oxshare-crm-production`; dev keeps
`oxshare-crm-local`), OpenAI, 3pay (whitelists the backend's IP), Rival, Let's Encrypt (automatic).

## Changing things safely

| Change                   | Where                                                                                                                | Then                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Release code             | push / merge to `production`                                                                                         | the pipeline does the rest                                                                                       |
| Roll back                | `release.sh rollback`                                                                                                | (above)                                                                                                          |
| A JWT secret             | GitHub secret                                                                                                        | redeploy the backend; everybody signs in again                                                                   |
| `APP_ENCRYPTION_KEY`     | GitHub secret                                                                                                        | **never casually**: stored provider and SMTP secrets stop decrypting and must be re-entered                      |
| `POSTGRES_PASSWORD`      | the database FIRST (`ALTER USER oxshare PASSWORD '…'` inside the postgres container), then the secret, then redeploy | Postgres reads the variable only when it creates its data volume, so changing the secret alone locks the API out |
| R2 or OpenAI keys        | provider dashboard → GitHub secret                                                                                   | redeploy the backend                                                                                             |
| The bridge key or secret | GitHub secret AND the bridge's `appsettings.Production.json`, together                                               | redeploy the backend and restart the bridge                                                                      |
| Docker Hub token         | Docker Hub → GitHub secret                                                                                           | next deploy uses it                                                                                              |
| A domain                 | DNS + secrets (backend DEPLOYMENT.md, "Changing the domain")                                                         | redeploy the backend, then rebuild both frontends; update `HOSTS` in `certificate-watch.yml`                     |
| Replace or add a server  | backend DEPLOYMENT.md, "Replacing a server"                                                                          | one script + secrets + DNS                                                                                       |
| More capacity            | backend DEPLOYMENT.md, "How this scales"                                                                             | a bigger Hostinger plan first                                                                                    |
| The broker upgrades MT5  | the bridge repo's `docs/DLL-UPGRADE.md`                                                                              | bridge only                                                                                                      |

## Open items (6 Oct 2026)

- [ ] Docker Hub: make `loadless/oxshare-crm-*` private, then delete `DOCKER_HUB_ALLOW_PUBLIC`; make
      the old `alialahmad/oxshare-crm-backend` private or delete it.
- [ ] Set the bridge's `Crm:BaseUrl` to `http://10.8.0.1:8080` and restart it, so deals and
      balances reach the new backend.
- [ ] Admin console on the new system: the email relay (Settings → Email: client sign-up codes need
      it), payment providers (Rival, 3pay), and the first administrator's authenticator.
- [ ] 3pay: whitelist `187.7.64.167`; point Rival's and 3pay's webhooks at `https://api-admin.oxshare.com`.
- [ ] Rotate what was shared in chat during the move: the R2 key, the OpenAI key, the bridge key and
      secret, the three Docker Hub tokens.
- [ ] Nightly offsite database backups with a tested restore, uptime monitoring, and an alert when
      the tunnel or the bridge stops answering (DEPLOY-PLAYBOOK §10).
- [ ] Contabo: stop and remove the old API, Caddy and Postgres (tasks "OxShare API" / "OxShare
      Caddy"), close 80/443 there, and limit RDP 3389 to known IPs.
- [ ] DNS hardening (optional): a CAA record `0 issue "letsencrypt.org"`, and DNSSEC in Hostinger.
- [ ] The browser E2E suites in both frontends cannot sign an admin in since 0191 (authenticator codes).
