#!/usr/bin/env bash
# copyfomo-offsite: records, verifiably, that what opens every agent wallet also exists OFF this server:
# /etc/copyfomo/worker.env (the seal private key) and the database backups. copyfomo-set-mode live requires both,
# copyfomo-status and copyfomo-backup warn when they are missing or stale.
#
#   copyfomo-offsite key-check      prove you hold a correct copy of worker.env: send the file on stdin, or run it
#                                   with ssh -t and paste the key when asked (hidden). It is compared with the
#                                   server's key and never stored or printed.
#   copyfomo-offsite list           the backups on this server as "<file> <sha256>", newest first
#   copyfomo-offsite pulled <file> <sha256>
#                                   record that <file> was copied off the server and its sha256 verified there
#                                   (deploy/pull-backups.ps1 runs this after checking the copy on your PC)
#   copyfomo-offsite status         what is confirmed, and how old it is (the default)
#
# A provider snapshot is NOT an off-server copy: it sits in the same provider account as the server. Keep
# worker.env in a password manager or encrypted storage, apart from the database backups.

SELF_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=deploy/lib.sh
source "$SELF_DIR/lib.sh"

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

CMD=${1:-status}
(($#)) && shift
case $CMD in -h | --help) usage; exit 0 ;; esac
cf_require_root
[[ -f $CF_WEB_ENV ]] || die "copyfomo is not set up on this server: run setup.sh first"

BACKUP_RE='^copyfomo-([0-9]{8})T([0-9]{2})([0-9]{2})([0-9]{2})Z-[a-z0-9-]{1,32}\.db\.gz$'

key_check() {
  local server_priv given='' line n=0 re_key='^[A-Za-z0-9+/_-]{42,44}={0,2}$'
  (($# == 0)) || die "usage: copyfomo-offsite key-check < copyfomo-worker.env"
  server_priv=$(cf_env_get "$CF_WORKER_ENV" WALLET_SEAL_PRIVATE_KEY)
  [[ -n $server_priv ]] || die "$CF_WORKER_ENV has no WALLET_SEAL_PRIVATE_KEY"
  cf_seal_pair_ok || die "the seal key pair on this server does not match (web.env public vs worker.env private): see copyfomo-status first"
  if [[ -t 0 ]]; then
    read -r -s -p "    Paste WALLET_SEAL_PRIVATE_KEY (the value or the whole line) from your off-server copy, then Enter: " line
    printf '\n'
    line=${line%$'\r'}
    line=${line#export }
    line=${line#WALLET_SEAL_PRIVATE_KEY=}
    given=$line
  else
    # A worker.env copy (any line endings, comments, `export`, quotes), or just the key.
    while IFS= read -r line || [[ -n $line ]]; do
      n=$((n + 1))
      ((n <= 200)) || break
      line=${line%$'\r'}
      line=${line#"${line%%[![:space:]]*}"}
      line=${line%"${line##*[![:space:]]}"}
      [[ -z $line || $line == \#* ]] && continue
      line=${line#export }
      if [[ $line == WALLET_SEAL_PRIVATE_KEY=* ]]; then
        given=${line#*=}
      elif [[ -z $given && $line =~ $re_key ]]; then
        given=$line
      fi
    done
  fi
  given=${given#\"} given=${given%\"} given=${given#\'} given=${given%\'}
  [[ -n $given ]] || die "no WALLET_SEAL_PRIVATE_KEY in the input (send your copy of worker.env on stdin)"
  if [[ $given != "$server_priv" ]]; then
    unset given server_priv
    die "that is NOT the key in $CF_WORKER_ENV: your off-server copy is wrong or stale. Copy the file again (deploy/README.md §8), store it, and re-check."
  fi
  unset given server_priv line
  cf_offsite_set KEY_ESCROW_PUB "$(cf_env_get "$CF_WEB_ENV" WALLET_SEAL_PUBLIC_KEY)"
  cf_offsite_set KEY_ESCROW_AT "$(date +%s)"
  ok "your off-server copy of worker.env holds this server's seal key (recorded; the key was not stored or printed)"
}

list_backups() {
  local f sum _
  (($# == 0)) || die "usage: copyfomo-offsite list"
  [[ -d $CF_BACKUPS ]] || return 0
  while IFS= read -r f; do
    [[ $f =~ $BACKUP_RE && -f $CF_BACKUPS/$f.sha256 ]] || continue
    read -r sum _ <"$CF_BACKUPS/$f.sha256" || true
    [[ $sum =~ ^[0-9a-f]{64}$ ]] && printf '%s %s\n' "$f" "$sum"
  done < <(find "$CF_BACKUPS" -maxdepth 1 -type f -name 'copyfomo-*.db.gz' -printf '%T@ %f\n' | sort -rn | cut -d' ' -f2-)
  return 0
}

pulled() {
  local f=${1:-} sum=${2:-} have _ taken prev
  (($# == 2)) || die "usage: copyfomo-offsite pulled <file> <sha256>"
  [[ $f =~ $BACKUP_RE ]] || die "not a backup file name: $f"
  taken=$(date -u -d "${BASH_REMATCH[1]} ${BASH_REMATCH[2]}:${BASH_REMATCH[3]}:${BASH_REMATCH[4]}" +%s) || die "bad timestamp in $f"
  [[ $sum =~ ^[0-9a-f]{64}$ ]] || die "not a sha256: $sum"
  [[ -f $CF_BACKUPS/$f && -f $CF_BACKUPS/$f.sha256 ]] || die "no backup $f on this server"
  read -r have _ <"$CF_BACKUPS/$f.sha256" || true
  [[ $have == "$sum" ]] || die "sha256 mismatch for $f: the off-server copy is not this server's backup"
  prev=$(cf_env_get "$CF_OFFSITE" LAST_PULL_BACKUP_AT)
  if [[ $prev =~ ^[0-9]+$ ]] && ((prev > taken)); then
    ok "$f verified off the server (a newer one already was: $(cf_env_get "$CF_OFFSITE" LAST_PULL_NAME))"
    return 0
  fi
  cf_offsite_set LAST_PULL_NAME "$f"
  cf_offsite_set LAST_PULL_BACKUP_AT "$taken"
  cf_offsite_set LAST_PULL_AT "$(date +%s)"
  ok "$f is verified off the server (taken $((($(date +%s) - taken) / 3600))h ago)"
}

status() {
  local at age_h
  (($# == 0)) || die "usage: copyfomo-offsite status"
  if cf_offsite_key_ok; then
    at=$(cf_env_get "$CF_OFFSITE" KEY_ESCROW_AT)
    ok "worker.env: an off-server copy of the current key was proven $([[ $at =~ ^[0-9]+$ ]] && date -u -d "@$at" +%Y-%m-%dT%H:%MZ)"
  else
    warn "worker.env: NO off-server copy of the current seal key is confirmed. Copy it off, then: copyfomo-offsite key-check"
  fi
  age_h=$(cf_offsite_backup_age_h)
  if [[ -z $age_h ]]; then
    warn "database: no backup has been copied off the server yet (deploy/pull-backups.ps1 on your PC)"
  elif ((age_h >= 26)); then
    warn "database: the newest backup copied off the server ($(cf_env_get "$CF_OFFSITE" LAST_PULL_NAME)) was taken ${age_h}h ago"
  else
    ok "database: newest backup copied off the server: $(cf_env_get "$CF_OFFSITE" LAST_PULL_NAME) (taken ${age_h}h ago)"
  fi
}

case $CMD in
  key-check) cf_lock offsite 30; key_check "$@" ;;
  list) list_backups "$@" ;;
  pulled) cf_lock offsite 30; pulled "$@" ;;
  status) status "$@" ;;
  *) usage >&2; die "unknown command: $CMD" ;;
esac
