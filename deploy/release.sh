#!/usr/bin/env bash
#
# Zero-downtime release of the API on the backend server (blue-green).
#
#   bash release.sh deploy <image tag>    release a new version
#   bash release.sh rollback              go back to the previous version (its image is kept)
#   bash release.sh status
#
# The API runs as TWO services, `api_blue` and `api_green` (docker-compose.prod.yml).
# A release never stops the running version first:
#
#   1. the new version's migrations run, while the old version keeps serving;
#   2. the new version starts BESIDE the old one and must pass its health check;
#   3. Caddy is switched to it with a graceful reload (no connection is dropped);
#   4. the old version gets SIGTERM and up to 30 s to finish what it is handling.
#
# If the new version never becomes healthy, it is stopped and the old one carries on:
# a failed release costs nothing. Because both versions run side by side for a few
# seconds, and the old one keeps serving after the migrations, every migration must
# suit the PREVIOUS release too (add a column first, stop using one, drop it in a later
# release). Scheduled jobs take database leases, so two instances never run one twice.
#
# Runs on the server, in the deploy directory, beside docker-compose.prod.yml, the
# Caddyfile and .env. `release.env` here records which colour is live and each colour's
# image tag; this script is the only writer.
set -euo pipefail
cd "$(dirname "$0")"

touch release.env
chmod 600 release.env # release state belongs to the deploy user alone, like .env
# shellcheck disable=SC1091
. ./release.env
ACTIVE=${ACTIVE:-none}
COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env --env-file release.env)

fail() { echo "::error::$*" >&2; exit 1; }
other() { if [ "$1" = blue ]; then echo green; else echo blue; fi; }
tag_of() { if [ "$1" = blue ]; then echo "${BLUE_TAG:-}"; else echo "${GREEN_TAG:-}"; fi; }
# A release that fails keeps the colour's PREVIOUS tag on record, so a later rollback
# targets the last version that really ran, never the one that was refused.
PREV_TAG=""
forget_failed() { # <colour>
  [ -n "$PREV_TAG" ] || return 0
  if [ "$1" = blue ]; then BLUE_TAG=$PREV_TAG; else GREEN_TAG=$PREV_TAG; fi
  save
}
save() {
  printf 'ACTIVE=%s\nBLUE_TAG=%s\nGREEN_TAG=%s\n' "$ACTIVE" "${BLUE_TAG:-}" "${GREEN_TAG:-}" > release.env.next
  chmod 600 release.env.next
  mv -f release.env.next release.env
}

wait_healthy() { # <container>
  local status=starting
  for _ in $(seq 1 60); do
    status=$(docker inspect --format='{{.State.Health.Status}}' "$1" 2>/dev/null || echo starting)
    [ "$status" = healthy ] && return 0
    sleep 3
  done
  echo "$1 did not become healthy (status=$status)" >&2
  return 1
}

# Caddy reads the live colour from active-api.caddy. Written in place (`cat >`), never
# replaced, because it is bind-mounted as a single file: a new inode would go unseen.
point_caddy_at() { # <colour>
  # The Caddyfile imports this file IN PLACE, with the port as its argument
  # (`import /etc/caddy/active-api.caddy 3001`): Caddy does not share snippets across
  # an import, so the file holds the directive itself. A REFUSED connection never
  # reached the API, so holding and retrying it (up to 10 s) cannot run anything twice.
  cat > active-api.caddy <<EOF
# Written by release.sh: the API version Caddy sends traffic to. Never edit by hand.
reverse_proxy api_$1:{args[0]} {
	lb_try_duration 10s
	lb_try_interval 250ms
}
EOF
  # Validate with Caddy's own parser, using the caddy service's mounts and environment,
  # BEFORE anything is switched: a config Caddy refuses must stop the release while the
  # old version is still serving, never leave Caddy restarting in a loop.
  "${COMPOSE[@]}" run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile </dev/null >/dev/null 2>release-caddy.err \
    || { cat release-caddy.err >&2; return 1; }
  rm -f release-caddy.err
  # A running Caddy reloads gracefully (no connection dropped). One that is missing,
  # stopped or restarting is (re)created with the config just validated.
  if [ "$(docker inspect -f '{{.State.Running}} {{.State.Restarting}}' oxshare_caddy 2>/dev/null)" = "true false" ]; then
    "${COMPOSE[@]}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile </dev/null
  else
    "${COMPOSE[@]}" up -d --force-recreate caddy </dev/null
  fi
}

# Start <colour> beside the live one, switch to it once healthy, then drain the old one.
promote() { # <colour>
  local next="$1" old="$ACTIVE"
  echo "==> Starting api_$next ($(tag_of "$next")) beside the live one ($old)"
  "${COMPOSE[@]}" up -d --no-deps "api_$next" </dev/null
  if ! wait_healthy "oxshare_api_$next"; then
    "${COMPOSE[@]}" logs --tail 80 "api_$next" </dev/null || true
    "${COMPOSE[@]}" stop "api_$next" </dev/null || true
    forget_failed "$next"
    fail "api_$next never became healthy. Nothing was switched: $old is still serving."
  fi
  # uWebSockets.js loads a PREBUILT binary, and a load failure falls back to the Node
  # engine silently, leaving :3003 dead while /health stays green. Assert it before
  # any traffic arrives.
  "${COMPOSE[@]}" exec -T "api_$next" node -e "require('uWebSockets.js')" </dev/null || {
    "${COMPOSE[@]}" stop "api_$next" </dev/null || true
    forget_failed "$next"
    fail "uWebSockets.js failed to load in api_$next. Nothing was switched: $old is still serving."
  }
  echo "==> Switching Caddy to api_$next"
  if ! point_caddy_at "$next"; then
    [ "$old" = none ] || point_caddy_at "$old" || true
    "${COMPOSE[@]}" stop "api_$next" </dev/null || true
    forget_failed "$next"
    fail "Caddy refused the switch to api_$next. Nothing was switched: $old is still serving."
  fi
  ACTIVE=$next
  save
  if [ "$old" != none ] && [ "$old" != "$next" ]; then
    echo "==> Draining api_$old (SIGTERM; in-flight requests finish, up to 30 s)"
    "${COMPOSE[@]}" stop -t 30 "api_$old" </dev/null
  fi
  echo "==> api_$next is live."
}

deploy() { # <image tag>
  local tag="${1:?usage: release.sh deploy <image tag>}" next
  if [ "$ACTIVE" = none ]; then next=blue; else next=$(other "$ACTIVE"); fi
  PREV_TAG=$(tag_of "$next")
  if [ "$next" = blue ]; then BLUE_TAG=$tag; else GREEN_TAG=$tag; fi
  save
  "${COMPOSE[@]}" pull "api_$next" </dev/null

  echo "==> Postgres and Redis"
  "${COMPOSE[@]}" up -d postgres redis </dev/null
  wait_healthy oxshare_postgres

  # The NEW version's migrator, before the new version serves. drizzle-orm applies all
  # pending migrations in one transaction, so an interruption rolls back whole.
  echo "==> Migrations"
  "${COMPOSE[@]}" run --rm --no-deps "api_$next" node scripts/migrate.mjs </dev/null

  # Idempotent by database constraint: on an existing database it touches nothing.
  if [ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ] && [ -n "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
    echo "==> Ensuring the bootstrap administrator exists"
    "${COMPOSE[@]}" run --rm --no-deps -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_PASSWORD \
      "api_$next" node scripts/bootstrap-admin.mjs </dev/null
  fi

  promote "$next"

  # SHA tags are never dangling: keep the two colours' images (live + rollback target).
  local repo
  repo=$(sed -n "s/^IMAGE_REPO='\(.*\)'$/\1/p" .env)
  docker images --format '{{.Repository}}:{{.Tag}}' "$repo" \
    | grep -v -e ':latest$' -e ":${BLUE_TAG:-none}\$" -e ":${GREEN_TAG:-none}\$" \
    | xargs -r docker rmi >/dev/null 2>&1 || true
  docker image prune -f >/dev/null 2>&1 || true
}

rollback() {
  [ "$ACTIVE" != none ] || fail "nothing is live, so there is nothing to roll back from."
  local prev
  prev=$(other "$ACTIVE")
  [ -n "$(tag_of "$prev")" ] || fail "api_$prev has never been released; there is no previous version."
  echo "==> Rolling back to api_$prev ($(tag_of "$prev")). Migrations are NOT reversed (forward-only)."
  promote "$prev"
}

case "${1:-}" in
  deploy) deploy "${2:-}" ;;
  rollback) rollback ;;
  status)
    echo "live: $ACTIVE | blue: ${BLUE_TAG:-never released} | green: ${GREEN_TAG:-never released}"
    "${COMPOSE[@]}" ps </dev/null
    ;;
  *) fail "usage: release.sh deploy <image tag> | rollback | status" ;;
esac
