#!/usr/bin/env bash
# copyfomo-backup [--label nightly|pre-update|manual|...]
#
# Consistent ONLINE backup of the SQLite database while web and worker keep running: `VACUUM INTO` copies one
# read-transaction snapshot (correct in WAL mode, unlike copying copyfomo.db + -wal files), then the copy is
# checked (PRAGMA quick_check), gzipped and stored in /var/backups/copyfomo (root-only) with a .sha256 file.
# Retention: backups older than 14 days are deleted, but the 7 newest are always kept.
#
# The database holds the SEALED agent keys. They are useless without WALLET_SEAL_PRIVATE_KEY
# (/etc/copyfomo/worker.env), and that key is useless without the database: keep off-server copies of BOTH,
# stored separately. These backups sit on the server's own disk: deploy/pull-backups.ps1 (on your PC) copies
# them off and records it (copyfomo-offsite). See deploy/README.md §8.

SELF_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=deploy/lib.sh
source "$SELF_DIR/lib.sh"

LABEL=manual
while (($#)); do
  case $1 in
    --label) LABEL=${2:?--label needs a value}; shift 2 ;;
    -h | --help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ $LABEL =~ ^[a-z0-9-]{1,32}$ ]] || die "--label: lowercase letters, digits and dashes only"
RETAIN_DAYS=14
KEEP_MIN=7

cf_require_root
cf_lock backup 900
if [[ ! -f $CF_DB ]]; then
  log "no database at $CF_DB yet: nothing to back up"
  exit 0
fi
install -d -m 0700 -o root -g root "$CF_BACKUPS"

ts=$(date -u +%Y%m%dT%H%M%SZ)
name=copyfomo-$ts-$LABEL.db.gz
# The snapshot is written by the copyfomo user next to the database (same filesystem, same owner), so SQLite
# never creates root-owned -wal/-shm files the services could not open.
stage=$(cf_as "$CF_APP_USER" "$CF_DATA" PATH=/usr/bin:/bin mktemp -d "$CF_DATA/.backup.XXXXXX")
CF_CLEANUP+=("$stage" "$CF_BACKUPS/.$name.partial")

cf_sqlite -cmd '.timeout 60000' "$CF_DB" "VACUUM INTO '$stage/copyfomo.db';"
check=$(cf_sqlite "$stage/copyfomo.db" 'PRAGMA quick_check;')
[[ $check == ok ]] || die "the snapshot failed quick_check: $check"
agents=$(cf_sqlite "$stage/copyfomo.db" 'SELECT count(*) FROM Agent;' 2>/dev/null || echo '?')

# The copyfomo user reads the snapshot and root only compresses the stream: root never opens a path inside a
# directory that user controls (a symlink there could otherwise make root copy worker.env into the backup).
cf_as "$CF_APP_USER" "$stage" PATH=/usr/bin:/bin cat copyfomo.db | gzip -6 -c >"$CF_BACKUPS/.$name.partial"
gzip -t "$CF_BACKUPS/.$name.partial"
chmod 0600 "$CF_BACKUPS/.$name.partial"
mv -f "$CF_BACKUPS/.$name.partial" "$CF_BACKUPS/$name"
(cd "$CF_BACKUPS" && sha256sum "$name" >"$name.sha256" && chmod 0600 "$name.sha256")
rm -rf --one-file-system -- "$stage"
ok "backup $CF_BACKUPS/$name ($(du -h "$CF_BACKUPS/$name" | cut -f1), $agents agents)"

# Retention: never delete one of the $KEEP_MIN newest backups, even if the timer was off for weeks.
mapfile -t all < <(find "$CF_BACKUPS" -maxdepth 1 -type f -name 'copyfomo-*.db.gz' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
removed=0
for ((i = KEEP_MIN; i < ${#all[@]}; i++)); do
  if [[ -n $(find "${all[i]}" -mmin +$((RETAIN_DAYS * 24 * 60))) ]]; then
    rm -f -- "${all[i]}" "${all[i]}.sha256"
    removed=$((removed + 1))
  fi
done
((removed == 0)) || log "removed $removed backup(s) older than $RETAIN_DAYS days"
age_h=$(cf_offsite_backup_age_h)
if [[ -z $age_h ]]; then
  warn "no backup has been copied off this server yet: run deploy/pull-backups.ps1 on your PC (deploy/README.md §8)"
elif ((age_h >= 26)); then
  warn "the newest backup copied off this server is ${age_h}h old: is deploy/pull-backups.ps1 still running daily on your PC?"
fi
