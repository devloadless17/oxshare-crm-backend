#!/usr/bin/env bash
# Only the CDN may reach this server's web ports (80, 443).
#
# Behind Cloudflare the public names resolve to Cloudflare, but the server's own
# address still answers anyone who knows it: a caller there skips every protection
# the CDN gives. This closes that door. SSH (22) and the WireGuard door are not
# touched, so administration and the MT5 bridge work exactly as before.
#
# THE SAME FILE RUNS ON BOTH SERVERS (backend and frontends). Copy it there, run as root:
#
#   origin-firewall.sh apply <public-host>...   close the door, ON TRIAL for 5 minutes
#   origin-firewall.sh confirm                  keep it: survives reboots, refreshes daily
#   origin-firewall.sh remove                   open the door again (one command, any time)
#   origin-firewall.sh refresh                  add any range Cloudflare has published since
#   origin-firewall.sh status                   what is in force
#
# WHY IT IS BUILT THIS WAY
#
#  - Docker publishes ports AROUND ufw: a `ufw deny 443` looks right and blocks
#    nothing. IPv4 to a published port is forwarded, and the one chain Docker leaves
#    to us there is DOCKER-USER. IPv6 reaches Docker's userland proxy through INPUT.
#    Both are covered; getting only one is a door left open.
#  - Rules match the ORIGINAL destination port (`--ctorigdstport`), because by
#    DOCKER-USER the packet has already been rewritten to the container's address.
#    They match only NEW connections arriving on the public interface, so a
#    container's own outbound HTTPS (payment providers, R2, OpenAI) is never judged.
#  - `apply` is a TRIAL. It checks the public hosts still answer through the CDN and
#    removes itself at once if they do not; and whatever happens it removes itself
#    after five minutes unless `confirm` is run. A mistake cannot leave the site shut.
#  - The list only ever GROWS on its own. A range Cloudflare adds is admitted within
#    a day (`refresh`, daily); a range is never removed automatically, so a failed or
#    truncated download cannot lock clients out. The ranges below are the fallback
#    when the download fails.
#  - No extra package: plain iptables/ip6tables chains, one rule per range.
#
# Renewal of Caddy's certificate is unaffected: Let's Encrypt's HTTP check arrives
# through the CDN. A check that connects STRAIGHT to this server's 443 from outside
# stops working by design; read the certificate from the server itself instead.
set -euo pipefail

CHAIN=OXSHARE-WEB
STATE_DIR=/etc/oxshare
ENABLED=$STATE_DIR/origin-firewall.enabled
SELF=/usr/local/sbin/oxshare-origin-firewall
UNIT=oxshare-origin-firewall
REVERT_UNIT=oxshare-origin-firewall-revert
TRIAL_SECONDS=300

FALLBACK_V4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18
108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17
162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
FALLBACK_V6="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32
2a06:98c0::/29 2c0f:f248::/32"

log() { echo "origin-firewall: $*"; }
die() { echo "origin-firewall: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"

wan() { ip -4 route show default | awk '{print $5; exit}'; }

# Cloudflare's published ranges for one family, or nothing if the answer is not a
# plausible list (too short, or anything that is not an address range).
published() { # <4|6>
  local body
  body=$(curl -fsS --max-time 15 "https://www.cloudflare.com/ips-v$1" 2>/dev/null) || return 0
  body=$(printf '%s\n' "$body" | tr -d '\r' | grep -E '^[0-9a-fA-F:.]+/[0-9]{1,3}$' || true)
  [ "$(printf '%s\n' "$body" | grep -c /)" -ge 5 ] || return 0
  printf '%s\n' "$body"
}

# Admit every known range in one family: the fallback list plus what is published now.
admit() { # <iptables|ip6tables> <4|6> <fallback>
  local ipt=$1 range added=0
  for range in $3 $(published "$2"); do
    if ! "$ipt" -C "$CHAIN" -s "$range" -j RETURN 2>/dev/null; then
      "$ipt" -I "$CHAIN" 1 -s "$range" -j RETURN
      added=$((added + 1))
    fi
  done
  log "$ipt: $("$ipt" -S "$CHAIN" | grep -c -- '-j RETURN') ranges admitted ($added new)"
}

# The chain: admitted ranges RETURN (carry on to Docker's own rules), everyone else is dropped.
ensure_chain() { # <iptables|ip6tables> <4|6> <fallback>
  local ipt=$1
  "$ipt" -N "$CHAIN" 2>/dev/null || true
  "$ipt" -C "$CHAIN" -j DROP 2>/dev/null || "$ipt" -A "$CHAIN" -j DROP
  admit "$@"
}

jump() { # <iptables|ip6tables> <-I|-D> <parent chain> <rule...>
  local ipt=$1 op=$2 parent=$3; shift 3
  if [ "$op" = -I ]; then
    "$ipt" -C "$parent" "$@" -j "$CHAIN" 2>/dev/null || "$ipt" -I "$parent" 1 "$@" -j "$CHAIN"
  else
    while "$ipt" -C "$parent" "$@" -j "$CHAIN" 2>/dev/null; do "$ipt" -D "$parent" "$@" -j "$CHAIN"; done
  fi
}

# Every place a new web connection from the internet is judged.
jumps() { # <-I|-D>
  local op=$1 dev; dev=$(wan); [ -n "$dev" ] || die "no default route: cannot tell the public interface"
  # IPv4: forwarded to the container, so DOCKER-USER, by the port the caller dialled.
  if iptables -S DOCKER-USER >/dev/null 2>&1; then
    jump iptables "$op" DOCKER-USER -i "$dev" -p tcp -m conntrack --ctstate NEW --ctorigdstport 80
    jump iptables "$op" DOCKER-USER -i "$dev" -p tcp -m conntrack --ctstate NEW --ctorigdstport 443
    jump iptables "$op" DOCKER-USER -i "$dev" -p udp -m conntrack --ctstate NEW --ctorigdstport 443
  elif [ "$op" = -I ]; then
    die "no DOCKER-USER chain: is Docker running?"
  fi
  # IPv4 and IPv6 that reach a listener on the host itself (Docker's userland proxy).
  local ipt
  for ipt in iptables ip6tables; do
    jump "$ipt" "$op" INPUT -i "$dev" -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW
    jump "$ipt" "$op" INPUT -i "$dev" -p udp --dport 443 -m conntrack --ctstate NEW
  done
}

install_rules() {
  ensure_chain iptables 4 "$FALLBACK_V4"
  ensure_chain ip6tables 6 "$FALLBACK_V6"
  jumps -I
}

remove_rules() {
  jumps -D
  local ipt
  for ipt in iptables ip6tables; do
    "$ipt" -F "$CHAIN" 2>/dev/null || true
    "$ipt" -X "$CHAIN" 2>/dev/null || true
  done
}

have_systemd() { [ -z "${ORIGIN_FW_NO_SYSTEMD:-}" ] && command -v systemctl >/dev/null 2>&1; }

# The public hosts must still answer THROUGH the CDN: anything but a real HTTP
# status (000 = no answer, 52x = the CDN cannot reach us) means we shut it out.
answers() { # <host>
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$1/" || true)
  case "$code" in 000 | 52?) log "https://$1 answers $code"; return 1 ;; *) log "https://$1 answers $code"; return 0 ;; esac
}

cmd_apply() {
  [ $# -ge 1 ] || die "apply needs the public host(s) this server serves, to check they still answer"
  if have_systemd; then
    systemctl stop "$REVERT_UNIT.timer" "$REVERT_UNIT.service" 2>/dev/null || true
    install -m 755 "$0" "$SELF"
    systemd-run --quiet --unit "$REVERT_UNIT" --on-active="$TRIAL_SECONDS" "$SELF" remove
  fi
  install_rules
  sleep 3
  local host ok=1
  for host in "$@"; do answers "$host" || ok=0; done
  if [ "$ok" = 0 ]; then
    cmd_remove
    die "a public host stopped answering, so the rules were REMOVED. Nothing is closed."
  fi
  log "ON TRIAL: the door is closed and the hosts answer through the CDN."
  log "It reopens by itself in $((TRIAL_SECONDS / 60)) minutes unless you run: $SELF confirm"
}

cmd_confirm() {
  iptables -S "$CHAIN" >/dev/null 2>&1 || die "nothing to confirm: run apply first"
  mkdir -p "$STATE_DIR" && date -u +%FT%TZ > "$ENABLED"
  have_systemd || { log "kept (no systemd: not installed for reboots)"; return; }
  systemctl stop "$REVERT_UNIT.timer" "$REVERT_UNIT.service" 2>/dev/null || true
  cat > "/etc/systemd/system/$UNIT.service" <<EOF
[Unit]
Description=OxShare: only the CDN reaches ports 80 and 443
After=docker.service network-online.target
Wants=network-online.target
ConditionPathExists=$ENABLED

[Service]
Type=oneshot
ExecStart=$SELF refresh

[Install]
WantedBy=multi-user.target
EOF
  cat > "/etc/systemd/system/$UNIT.timer" <<EOF
[Unit]
Description=OxShare: admit ranges the CDN has published since (daily)

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --quiet "$UNIT.service" "$UNIT.timer"
  systemctl start "$UNIT.timer"
  log "kept: restored after a reboot, and refreshed daily."
}

# Also what a reboot runs: only while the door is meant to be closed.
cmd_refresh() {
  [ -e "$ENABLED" ] || { log "not enabled: nothing to do"; return; }
  install_rules
}

cmd_remove() {
  remove_rules
  rm -f "$ENABLED"
  if have_systemd; then
    systemctl disable --quiet --now "$UNIT.timer" "$UNIT.service" 2>/dev/null || true
    rm -f "/etc/systemd/system/$UNIT.service" "/etc/systemd/system/$UNIT.timer"
    systemctl daemon-reload
    # Not the revert unit itself: this may BE the revert unit running.
    systemctl stop "$REVERT_UNIT.timer" 2>/dev/null || true
  fi
  log "removed: ports 80 and 443 answer everyone again."
}

cmd_status() {
  if iptables -S "$CHAIN" >/dev/null 2>&1; then
    log "IN FORCE$([ -e "$ENABLED" ] && echo ", kept since $(cat "$ENABLED")" || echo ", ON TRIAL (not confirmed)")"
    log "IPv4 ranges: $(iptables -S "$CHAIN" | grep -c -- '-j RETURN') | IPv6 ranges: $(ip6tables -S "$CHAIN" | grep -c -- '-j RETURN')"
    log "dropped so far: $(iptables -nvL "$CHAIN" | awk '$3 == "DROP" {print $1}') IPv4, $(ip6tables -nvL "$CHAIN" | awk '$3 == "DROP" {print $1}') IPv6 connections"
  else
    log "not in force: ports 80 and 443 answer everyone."
  fi
}

case "${1:-}" in
  apply) shift; cmd_apply "$@" ;;
  confirm) cmd_confirm ;;
  refresh) cmd_refresh ;;
  remove) cmd_remove ;;
  status) cmd_status ;;
  *) die "usage: $0 apply <public-host>... | confirm | refresh | remove | status" ;;
esac
