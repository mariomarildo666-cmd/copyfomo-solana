#!/usr/bin/env bash
# copyfomo-restore <backup.db.gz|backup.db> [--yes] [--force] [--skip-schema]
#
# Replaces the live database with a backup (from /var/backups/copyfomo, or a file you uploaded):
#   verify (sha256 + gzip + PRAGMA integrity_check) → compare agents → confirm → stop worker (graceful) and web
#   → move the current database aside to /var/lib/copyfomo/pre-restore-<time>/ (kept, never deleted) → install
#   the backup → prisma db push with the RUNNING release's schema (a backup taken before an update lacks its new
#   columns) → start web, then worker. The worker settles in-flight transactions from the chain on start.
#   If the schema push is refused or fails, the previous database is put back and nothing changes.
#   --skip-schema: install the backup as it is (e.g. a backup from a NEWER release than the running one).
# After the confirmation it runs as the systemd service copyfomo-restore (a dropped SSH connection cannot stop it).
#
# DANGER: agents created after the backup are not in it. Their sealed wallet keys exist only in the current
# database (which is kept aside, not deleted). The restore refuses to drop such agents unless you pass --force.
# The seal key pair (/etc/copyfomo/worker.env) must be the one these agents were sealed with.

SELF_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=deploy/lib.sh
source "$SELF_DIR/lib.sh"

SRC='' YES=0 FORCE=0 SKIP_SCHEMA=0
while (($#)); do
  case $1 in
    --yes) YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --skip-schema) SKIP_SCHEMA=1; shift ;;
    -h | --help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown argument: $1" ;;
    *) [[ -z $SRC ]] || die "one backup file only"; SRC=$1; shift ;;
  esac
done
[[ -n $SRC ]] || die "usage: copyfomo-restore <backup.db.gz|backup.db> [--yes] [--force] [--skip-schema]  (backups: ls -lt $CF_BACKUPS)"
# Absolute path with its DIRECTORY resolved but not its last component: a symlink there is refused below instead
# of being followed.
SRC_ABS=$(realpath -s -- "$SRC")
SRC=$(readlink -f -- "$(dirname -- "$SRC_ABS")")/$(basename -- "$SRC_ABS")
[[ -f $SRC && ! -L $SRC ]] || die "no such file (or a symlink): $SRC"

cf_require_root
[[ -f $CF_WEB_ENV ]] || die "copyfomo is not set up on this server: run setup.sh first"
if [[ -n ${CF_DETACHED:-} ]]; then cf_lock deploy 120; else cf_lock deploy; fi
REL=$(cf_current_release)
[[ -n $REL ]] || die "no release is deployed (run setup.sh first): the restored database needs its schema"

# Who reads the backup: root only when every directory above it belongs to root and nobody else can write it
# (/root, /var/backups/copyfomo), and then without following a symlink. Anywhere else (e.g.
# /var/lib/copyfomo/pre-restore-*, which the web user can write) the copyfomo user reads it, so nothing planted
# there can make root read a file of its choosing (such as worker.env) into the copyfomo-owned staging copy.
root_only_dirs() {
  local d=$1 m
  while :; do
    m=$(stat -c '%u %a' -- "$d") || return 1
    [[ ${m%% *} == 0 ]] && (((8#${m#* } & 8#022) == 0)) || return 1
    [[ $d == / ]] && return 0
    d=$(dirname -- "$d")
  done
}
READER=$CF_APP_USER
root_only_dirs "$(dirname -- "$SRC")" && READER=root
read_file() {
  if [[ $READER == root ]]; then
    cf_cat_nofollow "$1"
  else
    cf_as "$CF_APP_USER" / PATH=/usr/bin:/bin cat -- "$1"
  fi
}

step "Checking $SRC"
if [[ -f $SRC.sha256 ]]; then
  want=$(read_file "$SRC.sha256" | head -c 64) || die "cannot read $SRC.sha256"
  have=$(read_file "$SRC" | sha256sum | cut -d' ' -f1) || die "cannot read $SRC"
  [[ $want =~ ^[0-9a-f]{64}$ && $have == "$want" ]] || die "checksum mismatch: $SRC.sha256"
  ok "sha256 matches"
fi
stage=$(cf_as "$CF_APP_USER" "$CF_DATA" PATH=/usr/bin:/bin mktemp -d "$CF_DATA/.restore.XXXXXX")
CF_CLEANUP+=("$stage")
if [[ $SRC == *.gz ]]; then
  read_file "$SRC" | gzip -dc | cf_as "$CF_APP_USER" "$stage" PATH=/usr/bin:/bin tee copyfomo.db >/dev/null ||
    die "cannot read $SRC as $READER, or it is not a valid gzip file (upload backups to /root/)"
elif [[ $READER != root || -e $SRC-wal ]]; then
  # E.g. a pre-restore copy that still has its WAL beside it: copying the .db alone would drop the transactions
  # in the WAL, so let SQLite (as the copyfomo user) read both and write one consistent file.
  cf_sqlite "$SRC" "VACUUM INTO '$stage/copyfomo.db';" ||
    die "could not read $SRC (with its -wal) as $CF_APP_USER (move both files under $CF_DATA first)"
else
  read_file "$SRC" | cf_as "$CF_APP_USER" "$stage" PATH=/usr/bin:/bin tee copyfomo.db >/dev/null || die "cannot read $SRC"
fi
check=$(cf_sqlite "$stage/copyfomo.db" 'PRAGMA integrity_check;' 2>&1 || true)
[[ $check == ok ]] || die "the backup fails integrity_check: $(head -c 300 <<<"$check")"
backup_agents=$(cf_sqlite "$stage/copyfomo.db" 'SELECT count(*) FROM Agent;')
ok "integrity ok, $backup_agents agent(s)"

# Agents in the live database that the backup does not have (their sealed keys would leave the live DB).
missing=''
if [[ -f $CF_DB ]]; then
  missing=$(cf_sqlite -cmd '.timeout 10000' "$CF_DB" "ATTACH '$stage/copyfomo.db' AS b; SELECT a.depositAddress || '  ' || a.mode || '  ' || a.status FROM main.Agent a WHERE a.depositAddress NOT IN (SELECT depositAddress FROM b.Agent);") ||
    die "could not compare the live database with the backup"
  live_agents=$(cf_sqlite -cmd '.timeout 10000' "$CF_DB" 'SELECT count(*) FROM Agent;' 2>/dev/null || echo '?')
  log "live database: $live_agents agent(s)"
fi
if [[ -n $missing ]]; then
  warn "these agents exist in the live database but NOT in the backup (deposit address, mode, status):"
  sed 's/^/        /' <<<"$missing" >&2
  if ((FORCE == 0)); then
    die "refusing: their sealed wallet keys would disappear from the running system. Pick a newer backup, or pass --force (the current database is kept in $CF_DATA/pre-restore-*/ either way)."
  fi
  warn "--force: continuing; recover those keys later from the pre-restore copy"
fi

if ((YES == 0)); then
  [[ -t 0 ]] || die "pass --yes to confirm (no terminal to ask on)"
  read -r -p "    Replace the live database with $(basename "$SRC")? Type RESTORE: " answer
  [[ $answer == RESTORE ]] || die "aborted"
fi

# From here on the live database is replaced and migrated: run it as a systemd service, so a dropped SSH
# connection cannot stop it halfway. The service re-runs the checks above, then continues here.
if [[ -z ${CF_DETACHED:-} ]]; then
  args=("$SRC" --yes)
  ((FORCE)) && args+=(--force)
  ((SKIP_SCHEMA)) && args+=(--skip-schema)
  cf_unlock
  cf_detach restore "$SELF_DIR/restore.sh" "${args[@]}"
  cf_lock deploy # not detached (no usable systemd-run): continue in this session
fi

step "Restoring"
cf_worker_stop
cf_web_stop
# Every move in $CF_DATA runs as the copyfomo user (root never renames paths in a directory that user controls).
data_as() { cf_as "$CF_APP_USER" "$CF_DATA" PATH=/usr/bin:/bin "$@"; }
aside=$CF_DATA/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)
data_as mkdir -m 2770 -- "$aside"
moved=()
for n in "${CF_DB_FILES[@]}"; do
  if [[ -e $CF_DATA/$n || -L $CF_DATA/$n ]]; then
    data_as mv -f -- "$n" "$aside/$n"
    moved+=("$n")
  fi
done
ok "previous database kept in $aside"
# put_back: remove the restored copy and move the previous database back (the backup file itself is untouched).
put_back() {
  local n
  warn "putting the previous database back from $aside"
  for n in "${CF_DB_FILES[@]}"; do data_as rm -f -- "$n" || true; done
  for n in "${moved[@]}"; do data_as mv -f -- "$aside/$n" "$n" || warn "could not move $aside/$n back: do it by hand"; done
  cf_db_fix_perms || true
}
data_as mv -f -- "$stage/copyfomo.db" "$CF_DB"
if ((SKIP_SCHEMA)); then
  warn "--skip-schema: the backup keeps its own schema (it must match the running release $(basename "$REL"))"
  if ! { cf_db_fix_perms && cf_sqlite "$CF_DB" 'PRAGMA journal_mode=WAL;' >/dev/null && cf_db_fix_perms; }; then
    put_back
    die "could not prepare the restored database; the previous one is back in place"
  fi
else
  log "prisma db push: bring the backup up to the schema of the running release $(basename "$REL")"
  if ! cf_db_push "$REL"; then
    put_back
    die "prisma db push refused or failed on the restored database; the previous database is back in place (the services restart on it). If the backup comes from a NEWER release than the running one, deploy that release first (copyfomo-update --ref <sha>) or re-run with --skip-schema."
  fi
fi
cf_web_restart 90 || die "the web does not answer after the restore: journalctl -u $CF_WEB_UNIT -n 100"
cf_worker_start 180 || die "the worker did not start cleanly after the restore"
ok "restored $(basename "$SRC"). Check the site, then: copyfomo-status"
