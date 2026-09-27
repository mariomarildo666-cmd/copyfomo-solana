#!/usr/bin/env bash
# shellcheck disable=SC2319 # each probe's exit status is captured on purpose (st=$? right after it)
# copyfomo-status [--lines N]: services, release, health endpoints, key checks, disk, database, backups, logs.
# Read-only, prints no secret.

SELF_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=deploy/lib.sh
source "$SELF_DIR/lib.sh"
# A status report shows everything it can: it does not stop (or complain) at the first failing probe.
set +e
trap - ERR

LINES=50
while (($#)); do
  case $1 in
    --lines | -n) LINES=${2:?}; shift 2 ;;
    -h | --help) sed -n '2,3p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ $LINES =~ ^[0-9]+$ ]] || die "--lines needs a number"
cf_require_root

DOMAIN=$(cf_conf_get DOMAIN)
mark() { if [[ $1 == 0 ]]; then printf '%sok%s  ' "$C_G" "$C_0"; else printf '%sBAD%s ' "$C_R" "$C_0"; fi; }

step "copyfomo on $(hostname -s): https://${DOMAIN:-?}, mode $(cf_env_get "$CF_WEB_ENV" COPYFOMO_MODE)"
rel=$(cf_current_release)
if [[ -n $rel ]]; then
  sha=$(cf_release_sha "$rel")
  log "release   $(basename "$rel")  $(cf_git log -1 --format='%h %s (%cr)' "$sha" 2>/dev/null | cut -c1-90)"
  prev=$(readlink -e "$CF_PREVIOUS" 2>/dev/null)
  [[ -n $prev ]] && log "previous  $(basename "$prev")  (copyfomo-update --rollback)"
else
  log "release   none yet"
fi

step "Services"
for u in "$CF_WEB_UNIT" "$CF_WORKER_UNIT" caddy.service copyfomo-backup.timer fail2ban.service; do
  state=$(systemctl is-active "$u" 2>/dev/null)
  since=$(systemctl show -p ActiveEnterTimestamp --value "$u" 2>/dev/null)
  restarts=$(systemctl show -p NRestarts --value "$u" 2>/dev/null)
  [[ $state == active ]]
  st=$?
  printf '    %s%-24s %-10s since %s%s\n' "$(mark $st)" "$u" "$state" "${since:-?}" "${restarts:+, restarts $restarts}"
done
log "next backup: $(systemctl show -p NextElapseUSecRealtime --value copyfomo-backup.timer 2>/dev/null)"

step "Health"
cfg=$(curl -fsS -m 5 "$CF_WEB_URL/api/config" 2>/dev/null)
if [[ -n $cfg ]]; then
  printf '    %s/api/config   %s\n' "$(mark 0)" "$(jq -c '{mode, workerOnline, onchainRanking, copyVenue, platformFeeBps}' <<<"$cfg")"
  [[ $(jq -r .workerOnline <<<"$cfg") == true ]] || warn "workerOnline=false: the worker heartbeat is older than 60 s"
else
  printf '    %s/api/config   no answer from %s\n' "$(mark 1)" "$CF_WEB_URL"
fi
idx=$(curl -fsS -m 5 "$CF_WEB_URL/api/indexer" 2>/dev/null)
if [[ -n $idx ]]; then
  printf '    %s/api/indexer  %s\n' "$(mark 0)" "$(jq -c 'del(.. | nulls)' <<<"$idx" | cut -c1-400)"
else
  printf '    %s/api/indexer  no answer\n' "$(mark 1)"
fi
if [[ -n $DOMAIN ]]; then
  https=$(curl -s -m 10 -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/config")
  rc=$?
  ((rc == 0)) || https="no answer (curl exit $rc: 60 = certificate not issued/trusted yet, 7 = Caddy down)"
  [[ $https == 200 ]]
  st=$?
  printf '    %shttps://%s via Caddy: %s\n' "$(mark $st)" "$DOMAIN" "$https"
  exp=$(echo | timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -enddate -issuer 2>/dev/null | paste -sd' ' -)
  [[ -n $exp ]] && log "certificate: $exp"
fi

step "Keys and secrets"
cf_seal_pair_ok
st=$?
printf '    %sseal key pair (web.env public ↔ worker.env private)\n' "$(mark $st)"
[[ $(stat -c '%a %U:%G' "$CF_WORKER_ENV" 2>/dev/null) == '600 root:root' ]]
st=$?
printf '    %sworker.env is root:root 0600 (%s)\n' "$(mark $st)" "$(stat -c '%a %U:%G' "$CF_WORKER_ENV" 2>/dev/null)"
if grep -q '^[[:space:]]*WALLET_SEAL_PRIVATE_KEY' "$CF_WEB_ENV" 2>/dev/null; then st=1; else st=0; fi
printf '    %sno private key in web.env\n' "$(mark $st)"
web_pid=$(systemctl show -p MainPID --value "$CF_WEB_UNIT" 2>/dev/null)
if [[ -n $web_pid && $web_pid != 0 ]]; then
  if tr '\0' '\n' <"/proc/$web_pid/environ" 2>/dev/null | grep -q '^WALLET_SEAL_PRIVATE_KEY='; then st=1; else st=0; fi
  printf '    %sno private key in the web process environment\n' "$(mark $st)"
fi
stray=$(find "$CF_ROOT/releases" -maxdepth 2 -name '.env*' ! -name '.env.example' 2>/dev/null | head -5)
[[ -z $stray ]]
st=$?
printf '    %sno .env files under %s%s\n' "$(mark $st)" "$CF_ROOT" "${stray:+: $stray}"

step "Disk, memory, database, backups"
df -h / "$CF_DATA" 2>/dev/null | awk 'NR == 1 || !seen[$1]++' | sed 's/^/    /'
free -h | sed 's/^/    /'
if [[ -f $CF_DB ]]; then
  log "database: $(du -ch "$CF_DB"* 2>/dev/null | tail -1 | cut -f1) ($(find "$CF_DATA" -maxdepth 1 -name 'copyfomo.db*' -printf '%f ' | sed 's/ $//'))"
  counts=$(cf_sqlite -readonly "$CF_DB" "SELECT (SELECT count(*) FROM Agent) || ' agents (' || (SELECT count(*) FROM Agent WHERE mode = 'live') || ' live), ' || (SELECT count(*) FROM CopyTrade) || ' copy trades';" 2>/dev/null)
  [[ -n $counts ]] && log "          $counts"
else
  log "database: none yet"
fi
last=$(find "$CF_BACKUPS" -maxdepth 1 -name 'copyfomo-*.db.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
if [[ -n $last ]]; then
  age_h=$((($(date +%s) - $(stat -c %Y "$last")) / 3600))
  ((age_h < 26))
  st=$?
  printf '    %slast backup %s (%s, %sh ago); %s backups, %s total\n' "$(mark $st)" "$(basename "$last")" \
    "$(du -h "$last" | cut -f1)" "$age_h" "$(find "$CF_BACKUPS" -maxdepth 1 -name 'copyfomo-*.db.gz' | wc -l)" \
    "$(du -sh "$CF_BACKUPS" | cut -f1)"
else
  printf '    %sno backup yet (copyfomo-backup)\n' "$(mark 1)"
fi
timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes
st=$?
printf '    %sclock synchronized (NTP)\n' "$(mark $st)"

step "Off-server copies (copyfomo-offsite status)"
ESCROW_OK=0
if cf_offsite_key_ok; then
  ESCROW_OK=1
  at=$(cf_env_get "$CF_OFFSITE" KEY_ESCROW_AT)
  printf '    %sworker.env: an off-server copy of the current key was proven %s\n' "$(mark 0)" \
    "$([[ $at =~ ^[0-9]+$ ]] && date -u -d "@$at" +%Y-%m-%dT%H:%MZ)"
else
  printf '    %sworker.env: NO off-server copy of the current key is confirmed (copyfomo-offsite key-check)\n' "$(mark 1)"
fi
age_h=$(cf_offsite_backup_age_h)
if [[ -n $age_h ]]; then
  ((age_h < 26))
  st=$?
  printf '    %snewest backup verified off the server: %s (taken %sh ago)\n' "$(mark $st)" \
    "$(cf_env_get "$CF_OFFSITE" LAST_PULL_NAME)" "$age_h"
else
  printf '    %sno backup has been copied off the server yet (deploy/pull-backups.ps1 on your PC)\n' "$(mark 1)"
fi

step "Last $LINES log lines (web + worker)"
journalctl -u "$CF_WEB_UNIT" -u "$CF_WORKER_UNIT" -n "$LINES" --no-pager -o short-iso | sed 's/^/    /'
if ((ESCROW_OK == 0)); then
  printf '\n%s!! No off-server copy of %s is confirmed. If this server is lost, every agent wallet is lost.%s\n' "$C_R" "$CF_WORKER_ENV" "$C_0"
  printf '%s!! Copy it off, then prove it: copyfomo-offsite key-check (deploy/README.md §8). Live mode is refused until then.%s\n' "$C_R" "$C_0"
fi
exit 0
