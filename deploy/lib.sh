# shellcheck shell=bash disable=SC2034
# (SC2034: the CF_* constants are used by the scripts that source this file.)
# copyfomo deploy kit: shared helpers, sourced by setup.sh, update.sh, backup.sh, restore.sh, status.sh,
# set-mode.sh and offsite.sh. Installed to /usr/local/lib/copyfomo by setup.sh (and refreshed from the repo by
# copyfomo-update); deploy/MANIFEST lists what gets installed.
#
# NEVER add `set -x` to this kit: several functions hold secrets in shell variables and xtrace would print them.
# Secrets never go on a command line either (argv is world-readable in /proc): they travel over stdin or through
# files that only root can read.
#
# Root never opens, moves or re-owns a path inside a directory the copyfomo user can write (/var/lib/copyfomo,
# the release directories) by name: it goes through the copyfomo user (cf_as) or through an O_NOFOLLOW file
# descriptor (cf_db_fix_perms, cf_cat_nofollow). Otherwise a symlink planted there by a compromised web process
# or build script would make root chown, chmod or read a file of its choosing (e.g. worker.env).

set -Eeuo pipefail
umask 027
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C.UTF-8
export DEBIAN_FRONTEND=noninteractive
# Ubuntu's needrestart: list services that need a restart instead of restarting them in the middle of a run.
export NEEDRESTART_MODE=l

# ── Layout (see deploy/README.md) ────────────────────────────────────────────────────────────────────────
CF_APP_USER=copyfomo                          # web process + builds; owns the releases and the database
CF_WORKER_USER=copyfomo-worker                # worker process; the only one that receives the seal private key
CF_GROUP=copyfomo                             # shared by both users (database access)
CF_ROOT=/opt/copyfomo
CF_REPO_GIT=$CF_ROOT/repo.git                 # root-only bare clone, fetched with the GitHub deploy key
CF_RELEASES=$CF_ROOT/releases                 # one directory per built commit
CF_CURRENT=$CF_ROOT/current                   # symlink → the running release
CF_PREVIOUS=$CF_ROOT/previous                 # symlink → the release before it (copyfomo-update --rollback)
CF_DATA=/var/lib/copyfomo
CF_DB=$CF_DATA/copyfomo.db
CF_DB_FILES=(copyfomo.db copyfomo.db-wal copyfomo.db-shm copyfomo.db-journal)   # names inside $CF_DATA
CF_ETC=/etc/copyfomo
CF_WEB_ENV=$CF_ETC/web.env
CF_WORKER_ENV=$CF_ETC/worker.env
CF_CONF=$CF_ETC/deploy.conf
CF_OFFSITE=$CF_ETC/offsite.state              # what copyfomo-offsite confirmed was copied off the server
CF_BACKUPS=/var/backups/copyfomo
CF_HOME=/var/cache/copyfomo                   # $HOME of the copyfomo user (npm cache)
CF_KIT=/usr/local/lib/copyfomo
CF_DEPLOY_KEY=/root/.ssh/copyfomo_github_deploy
CF_KNOWN_HOSTS=/root/.ssh/copyfomo_github_known_hosts
CF_WEB_UNIT=copyfomo-web.service
CF_WORKER_UNIT=copyfomo-worker.service
CF_WEB_URL=http://127.0.0.1:3000
CF_KEEP_RELEASES=3

# ── Output ───────────────────────────────────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_B=$'\e[1m' C_R=$'\e[31m' C_G=$'\e[32m' C_Y=$'\e[33m' C_D=$'\e[2m' C_0=$'\e[0m'
else
  C_B='' C_R='' C_G='' C_Y='' C_D='' C_0=''
fi
step() { printf '\n%s==> %s%s\n' "$C_B" "$*" "$C_0"; }
log() { printf '    %s\n' "$*"; }
ok() { printf '    %sok%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '    %sWARN%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die() {
  printf '\n%sFATAL%s %s\n' "$C_R" "$C_0" "$*" >&2
  exit 1
}

cf_require_root() { [[ $EUID -eq 0 ]] || die "run this as root"; }

# Failure context (BASH_COMMAND is the unexpanded source text, so it never contains a secret value).
trap 'printf "%s    failed: %s (%s:%s)%s\n" "$C_D" "$BASH_COMMAND" "${BASH_SOURCE[0]##*/}" "$LINENO" "$C_0" >&2' ERR

# Set by cf_detach for the script it runs as a service: that script reports its exit status there. Not passed on
# to the scripts it calls (backup.sh...), which would overwrite it.
CF_STATUS_FILE_OWN=${CF_STATUS_FILE:-}
unset CF_STATUS_FILE

# If a script stops the worker (update, set-mode, restore) and then fails, bring the worker back on whatever
# release `current` points at: a stopped worker copies nothing, and it is the only process that can sell.
CF_WORKER_STOPPED=0
CF_WEB_STOPPED=0
CF_CLEANUP=()
CF_PENDING_RELEASE=''   # a built release not (yet) switched to: removed on exit unless it became `current`
cf_on_exit() {
  local rc=$? p
  set +e
  for p in "${CF_CLEANUP[@]}"; do [[ -n $p ]] && rm -rf --one-file-system -- "$p" 2>/dev/null; done
  if [[ $CF_WEB_STOPPED == 1 ]]; then
    warn "stopped before the end: starting $CF_WEB_UNIT again"
    systemctl start "$CF_WEB_UNIT" || warn "could not start the web: journalctl -u $CF_WEB_UNIT -n 100"
  fi
  if [[ $CF_WORKER_STOPPED == 1 ]]; then
    warn "stopped before the end: starting $CF_WORKER_UNIT again (release $(readlink -e "$CF_CURRENT" 2>/dev/null || echo '?'))"
    systemctl start "$CF_WORKER_UNIT" || warn "could not start the worker: journalctl -u $CF_WORKER_UNIT -n 100"
  fi
  if [[ -n $CF_PENDING_RELEASE && -d $CF_PENDING_RELEASE && $(readlink -e "$CF_CURRENT" 2>/dev/null) != "$CF_PENDING_RELEASE" ]]; then
    warn "removing the release that was not deployed: $CF_PENDING_RELEASE"
    rm -rf --one-file-system -- "$CF_PENDING_RELEASE"
  fi
  [[ -n $CF_STATUS_FILE_OWN ]] && printf '%s\n' "$rc" >"$CF_STATUS_FILE_OWN" 2>/dev/null
  exit "$rc"
}
trap cf_on_exit EXIT
trap 'die "interrupted"' INT TERM HUP

# cf_lock <name> [wait-seconds]: one deploy operation at a time (update, set-mode, restore, setup).
cf_lock() {
  local name=$1 wait=${2:-0}
  exec {CF_LOCK_FD}>"/run/lock/copyfomo-$name.lock"
  flock -w "$wait" "$CF_LOCK_FD" || die "another copyfomo '$name' operation is running (/run/lock/copyfomo-$name.lock)"
}
cf_unlock() {
  if [[ -n ${CF_LOCK_FD:-} ]]; then exec {CF_LOCK_FD}>&-; fi
  CF_LOCK_FD=''
}

# cf_detach <name> <script> [args...]: run <script> as the transient systemd service copyfomo-<name> and follow its
# log here. A dropped SSH connection (SIGHUP) or Ctrl-C then only stops the following: the operation itself (a
# schema change, a restore) is never killed halfway. Exits with the script's status. Returns at once, so the caller
# continues in this session, when it is already the service, with CF_NO_DETACH=1, or without systemd.
# Call it before cf_lock (or after cf_unlock): the service takes the lock itself.
cf_detach() {
  local name=$1 script=$2 unit start rc=0 tail_pid status_file state
  shift 2
  [[ -z ${CF_DETACHED:-} && ${CF_NO_DETACH:-0} != 1 && -d /run/systemd/system ]] || return 0
  if ! command -v systemd-run >/dev/null || ! systemd-run --help 2>/dev/null | grep -q -- '--expand-environment'; then
    warn "this systemd-run cannot run the operation detached: it runs in this SSH session (use tmux)"
    return 0
  fi
  unit=copyfomo-$name
  case $(cf_unit_state "$unit.service") in
    active | activating | deactivating | reloading) die "$unit is already running: follow it with  journalctl -u $unit -f -o cat" ;;
  esac
  status_file=/run/copyfomo-$name.status
  rm -f "$status_file"
  start=$(date +%s)
  log "running as the systemd service $unit: a dropped SSH connection or Ctrl-C does not stop it"
  log "follow it again with:  journalctl -u $unit -f -o cat"
  journalctl -u "$unit" -f --since "@$start" -o cat --no-pager &
  tail_pid=$!
  # shellcheck disable=SC2064 # expand now: the locals are gone when a signal arrives after this function
  trap "kill $tail_pid 2>/dev/null; printf '\n    stopped following; %s keeps running (journalctl -u %s -f -o cat)\n' '$unit' '$unit' >&2; exit 130" INT
  # shellcheck disable=SC2064
  trap "kill $tail_pid 2>/dev/null; exit 129" HUP TERM
  systemd-run --unit="$unit" --description="copyfomo $name" --quiet --wait --collect --service-type=exec \
    --expand-environment=no -p CPUWeight=20 -p IOWeight=20 \
    --setenv=CF_DETACHED=1 --setenv=HOME=/root --setenv="CF_STATUS_FILE=$status_file" \
    --setenv="SSH_CONNECTION=${SSH_CONNECTION:-}" -- "$script" "$@" || rc=$?
  # systemd-run can lose its connection to systemd (an apt upgrade of systemd re-executes it) while the service
  # goes on: wait for the service itself, then take the status the script wrote.
  while :; do
    state=$(cf_unit_state "$unit.service")
    [[ $state == active || $state == activating || $state == deactivating || $state == reloading ]] || break
    sleep 2
  done
  [[ -s $status_file ]] && rc=$(<"$status_file")
  rm -f "$status_file"
  sleep 1
  kill "$tail_pid" 2>/dev/null || true
  wait "$tail_pid" 2>/dev/null || true
  trap 'die "interrupted"' INT TERM HUP
  if [[ $rc != 0 ]]; then
    printf '\n    %s exited with status %s. Full log:  journalctl -u %s --since @%s -o cat\n' "$unit" "$rc" "$unit" "$start" >&2
  fi
  exit "$rc"
}

# ── Env files ────────────────────────────────────────────────────────────────────────────────────────────
# Our env files (web.env, worker.env, deploy.conf, offsite.state) hold one KEY=value per line, never quoted,
# never with an inline comment: systemd's EnvironmentFile reads them literally.

# cf_env_get <file> <KEY>: print the value (last assignment wins), nothing if absent. Use only as $(...).
cf_env_get() {
  local file=$1 key=$2 line val=''
  [[ -r $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == "$key="* ]] && val=${line#*=}
  done <"$file"
  printf '%s' "$val"
}

# A value is safe for an unquoted systemd EnvironmentFile line: printable, no whitespace, quote, backslash,
# dollar or backtick (systemd would unescape or expand those differently from the dotenv file it came from).
cf_env_value_ok() {
  [[ $1 =~ ^[[:print:]]*$ ]] || return 1
  case $1 in
    *[[:space:]]* | *\"* | *\'* | *\\* | *\$* | *\`*) return 1 ;;
  esac
  return 0
}

# cf_parse_dotenv <file> <assoc-array-name>: read a dotenv-style file (like the dev .env): skips comments and
# blank lines, accepts `export KEY=...`, strips CR, surrounding quotes and unquoted ` # comments`.
cf_parse_dotenv() {
  local file=$1 line key val
  local -n _cf_out=$2
  local re_kv='^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$'
  local re_dq='^"([^"]*)"[[:space:]]*(#.*)?$'
  local re_sq="^'([^']*)'[[:space:]]*(#.*)?\$"
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    line=${line#"${line%%[![:space:]]*}"}
    [[ -z $line || $line == \#* ]] && continue
    line=${line#export }
    if [[ ! $line =~ $re_kv ]]; then
      warn "$file: ignoring a line that is not KEY=value"
      continue
    fi
    key=${BASH_REMATCH[1]}
    val=${BASH_REMATCH[2]}
    val=${val#"${val%%[![:space:]]*}"}
    if [[ $val =~ $re_dq || $val =~ $re_sq ]]; then
      val=${BASH_REMATCH[1]}
    else
      [[ $val == \#* ]] && val=''
      val=${val%%[[:space:]]#*}
      val=${val%"${val##*[![:space:]]}"}
    fi
    _cf_out[$key]=$val
  done <"$file"
  return 0
}

# cf_write_file_atomic <dest> <mode> <owner:group>: content from stdin. Permissions are set before any byte is
# written, and the file is replaced with a rename, so readers never see a partial or over-permissive file.
cf_write_file_atomic() {
  local dest=$1 mode=$2 owner=$3 tmp
  tmp=$(mktemp "$dest.XXXXXX")
  chmod "$mode" "$tmp"
  chown "$owner" "$tmp"
  if ! cat >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$dest"
}

# cf_env_set <file> <KEY> <value>: replace (or append) one line, keeping the file's owner and mode.
cf_env_set() {
  local file=$1 key=$2 val=$3 mode owner
  cf_env_value_ok "$val" || die "refusing to write $key: its value has whitespace, quotes, \\, \$ or a backtick"
  mode=$(stat -c '%a' "$file")
  owner=$(stat -c '%u:%g' "$file")
  {
    local line found=0
    while IFS= read -r line || [[ -n $line ]]; do
      if [[ $line == "$key="* ]]; then
        [[ $found == 1 ]] || printf '%s=%s\n' "$key" "$val"
        found=1
      else
        printf '%s\n' "$line"
      fi
    done <"$file"
    [[ $found == 1 ]] || printf '%s=%s\n' "$key" "$val"
  } | cf_write_file_atomic "$file" "$mode" "$owner"
}

# cf_load_env_array <file> <array-name>: append the KEY=value lines of one of our env files (for `env -i`).
cf_load_env_array() {
  local file=$1 line
  local -n _cf_arr=$2
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && _cf_arr+=("$line")
  done <"$file"
  return 0
}

cf_conf_get() { cf_env_get "$CF_CONF" "$1"; }

# ── Off-server copies (copyfomo-offsite) ─────────────────────────────────────────────────────────────────
# offsite.state (root:root 0600, no secrets): KEY_ESCROW_PUB = the seal PUBLIC key whose private half the operator
# proved to hold off the server; LAST_PULL_* = the newest database backup verified on the operator's PC.
cf_offsite_set() {
  if [[ ! -f $CF_OFFSITE ]]; then
    printf '# copyfomo-offsite state (root only, no secrets). Written by copyfomo-offsite.\n' |
      cf_write_file_atomic "$CF_OFFSITE" 0600 root:root
  fi
  cf_env_set "$CF_OFFSITE" "$1" "$2"
}

# 0 when the operator proved (copyfomo-offsite key-check) an off-server copy of the CURRENT seal private key.
cf_offsite_key_ok() {
  local pub
  pub=$(cf_env_get "$CF_WEB_ENV" WALLET_SEAL_PUBLIC_KEY)
  [[ -n $pub && $(cf_env_get "$CF_OFFSITE" KEY_ESCROW_PUB) == "$pub" ]]
}

# Hours since the newest backup that is verified off the server was TAKEN (not pulled); nothing when there is none.
cf_offsite_backup_age_h() {
  local at
  at=$(cf_env_get "$CF_OFFSITE" LAST_PULL_BACKUP_AT)
  [[ $at =~ ^[0-9]+$ ]] || return 0
  printf '%s' $((($(date +%s) - at) / 3600))
}

# ── Seal keys (x25519, base64 of the 32 raw bytes — the format of src/lib/crypto.ts) ─────────────────────────
# Only trusted inline code runs here (root + /usr/bin/node, no project code); keys move over stdin/stdout.

# Prints "<public>\n<private>\n". Capture it with mapfile, never let it reach the terminal.
cf_seal_generate() {
  node -e '
    const c = require("node:crypto");
    const { publicKey, privateKey } = c.generateKeyPairSync("x25519");
    const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    const priv = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64");
    process.stdout.write(pub + "\n" + priv + "\n");'
}

# stdin: a base64 private key → stdout: its base64 public key. Fails on anything that is not a 32-byte key.
cf_seal_pub_from_priv() {
  node -e '
    const c = require("node:crypto");
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const t = s.trim();
      const raw = Buffer.from(t, /[-_]/.test(t) ? "base64url" : "base64");
      if (raw.length !== 32) { console.error("not a base64 32-byte x25519 private key"); process.exit(1); }
      const k = c.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), raw]), format: "der", type: "pkcs8" });
      process.stdout.write(c.createPublicKey(k).export({ format: "der", type: "spki" }).subarray(-32).toString("base64"));
    });'
}

# 0 when worker.env's private key and web.env's public key are one pair.
cf_seal_pair_ok() {
  local priv pub derived
  priv=$(cf_env_get "$CF_WORKER_ENV" WALLET_SEAL_PRIVATE_KEY)
  pub=$(cf_env_get "$CF_WEB_ENV" WALLET_SEAL_PUBLIC_KEY)
  [[ -n $priv && -n $pub ]] || return 1
  derived=$(printf '%s' "$priv" | cf_seal_pub_from_priv 2>/dev/null) || return 1
  [[ $derived == "$pub" ]]
}

cf_random_secret() { node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'; }

# 0 when $1 is a base58 string that decodes to exactly 32 bytes (a Solana address). Public data only.
cf_is_solana_address() {
  [[ $1 =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || return 1
  node -e '
    const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz", s = process.argv[1];
    let n = 0n; for (const ch of s) n = n * 58n + BigInt(A.indexOf(ch));
    let len = 0; while (n > 0n) { len++; n /= 256n; }
    for (const ch of s) { if (ch !== "1") break; len++; }
    process.exit(len === 32 ? 0 : 1);' "$1"
}

# ── Running things as the service users ──────────────────────────────────────────────────────────────────
# cf_as <user> <dir> [NAME=value...] <command...>: clean environment, no new privileges, no PAM session.
cf_as() {
  local user=$1 dir=$2
  shift 2
  setpriv --no-new-privs --reuid="$user" --regid="$CF_GROUP" --init-groups -- env -i -C "$dir" "$@"
}

# cf_as_build: cf_as at low CPU and IO priority. npm ci and next build can use every core for minutes; the live
# worker (copy latency, confirmation polling) keeps priority meanwhile.
cf_as_build() {
  local user=$1 dir=$2
  shift 2
  nice -n 10 ionice -c 2 -n 7 setpriv --no-new-privs --reuid="$user" --regid="$CF_GROUP" --init-groups -- env -i -C "$dir" "$@"
}

# cf_build_env <array-name>: the environment of npm ci, prisma and next build. Only NODE_ENV, DATABASE_URL and the
# NEXT_PUBLIC_* values from web.env, never the provider keys or SESSION_SECRET: `next build` would inline any
# variable that a module reachable from client code references statically, so a secret it never sees can never
# end up in public JS. (The app reads its secrets at run time; the seal private key is never in web.env anyway.)
cf_build_env() {
  local -n _cf_env=$1
  local line
  _cf_env=()
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^(NODE_ENV|DATABASE_URL|NEXT_PUBLIC_[A-Z0-9_]+)= ]] && _cf_env+=("$line")
  done <"$CF_WEB_ENV"
  _cf_env+=(
    "HOME=$CF_HOME" "PATH=/usr/bin:/bin" "LANG=C.UTF-8" "CI=1"
    "NEXT_TELEMETRY_DISABLED=1" "CHECKPOINT_DISABLE=1" "PRISMA_HIDE_UPDATE_MESSAGE=1"
    "npm_config_update_notifier=false" "npm_config_fund=false" "npm_config_audit=false"
  )
}

# cf_sqlite <db> <sql-or-dot-command...>: sqlite3 as the copyfomo user (so -wal/-shm files keep its ownership).
cf_sqlite() {
  cf_as "$CF_APP_USER" "$CF_DATA" "HOME=$CF_HOME" PATH=/usr/bin:/bin sqlite3 -batch -bail "$@"
}

# cf_db_fix_perms: copyfomo:copyfomo 0660 on the database files, so web (copyfomo) and worker (copyfomo-worker,
# group copyfomo) can both open them. $CF_DATA is writable by the copyfomo user, so each file is opened with
# O_NOFOLLOW and changed through that descriptor (fchown/fchmod): a symlink, a hard link to another file or a
# special file planted there is refused, never followed.
cf_db_fix_perms() {
  python3 - "$CF_DATA" "$CF_APP_USER" "$CF_WORKER_USER" "$CF_GROUP" "${CF_DB_FILES[@]}" <<'PY'
import grp, os, pwd, stat, sys

data, app, worker, group, *names = sys.argv[1:]
app_uid, worker_uid = pwd.getpwnam(app).pw_uid, pwd.getpwnam(worker).pw_uid
gid = grp.getgrnam(group).gr_gid
flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOCTTY | os.O_CLOEXEC
dfd = os.open(data, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
problems = []
for name in names:
    try:
        fd = os.open(name, flags, dir_fd=dfd)
    except FileNotFoundError:
        continue
    except OSError as e:
        problems.append(f"{data}/{name}: {e.strerror} (a symlink?)")
        continue
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            problems.append(f"{data}/{name}: not a regular file")
        elif st.st_nlink != 1:
            problems.append(f"{data}/{name}: {st.st_nlink} hard links")
        elif st.st_uid not in (0, app_uid, worker_uid):
            problems.append(f"{data}/{name}: owned by uid {st.st_uid}")
        else:
            os.fchown(fd, app_uid, gid)
            os.fchmod(fd, 0o660)
    finally:
        os.close(fd)
os.close(dfd)
if problems:
    print("refusing to change owner or mode (inspect the files by hand):", *problems, sep="\n    ", file=sys.stderr)
    sys.exit(1)
PY
}

# cf_cat_nofollow <file>: copy a regular, single-link file to stdout without following a symlink as its last
# component (root reading a backup file whose directory another user may be able to write).
cf_cat_nofollow() {
  python3 - "$1" <<'PY'
import os, shutil, stat, sys

path = sys.argv[1]
try:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOCTTY | os.O_CLOEXEC)
except OSError as e:
    sys.exit(f"{path}: {e.strerror}")
st = os.fstat(fd)
if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
    sys.exit(f"{path}: not a regular file with a single link")
os.set_blocking(fd, True)
with os.fdopen(fd, "rb") as src:
    shutil.copyfileobj(src, sys.stdout.buffer, 1 << 20)
PY
}

# ── Releases ─────────────────────────────────────────────────────────────────────────────────────────────
cf_current_release() { readlink -e "$CF_CURRENT" 2>/dev/null || true; }

# cf_release_sha <release-dir>: its REVISION (a commit sha), read as the copyfomo user who wrote it, or nothing.
cf_release_sha() {
  local r=$1 sha
  [[ -n $r && -d $r ]] || return 0
  sha=$(cf_as "$CF_APP_USER" "$r" PATH=/usr/bin:/bin head -c 64 REVISION 2>/dev/null || true)
  sha=${sha%%$'\n'*}
  [[ $sha =~ ^[0-9a-f]{40}$ ]] && printf '%s' "$sha"
  return 0
}
cf_current_sha() { cf_release_sha "$(cf_current_release)"; }

cf_git() { git -C "$CF_REPO_GIT" "$@"; }

# cf_resolve_ref <branch|tag|sha> → full commit sha from the local bare clone (after a fetch).
cf_resolve_ref() {
  local ref=$1 sha cand
  for cand in "refs/remotes/origin/$ref" "refs/tags/$ref" "$ref"; do
    if sha=$(cf_git rev-parse --verify --quiet "$cand^{commit}" 2>/dev/null); then
      printf '%s' "$sha"
      return 0
    fi
  done
  return 1
}

cf_fetch() {
  local out
  if ! out=$(cf_git fetch --prune --quiet origin 2>&1); then
    printf '%s\n' "$out" >&2
    return 1
  fi
}

# No .env* file may exist in a release: Next.js and Prisma would load it over the systemd environment.
cf_scrub_env_files() {
  local dir=$1 f
  while IFS= read -r -d '' f; do
    warn "removing $f (configuration lives in /etc/copyfomo only)"
    rm -f -- "$f"
  done < <(find "$dir" -maxdepth 1 -name '.env*' ! -name '.env.example' -print0)
}

# cf_build_release <sha>: new release directory from the root-owned bare clone, then npm ci + prisma generate
# + next build as the copyfomo user, at low priority. Prints the release path on stdout; everything else goes to
# stderr. The running release is never touched, so a failed build leaves the site exactly as it was.
cf_build_release() {
  local sha=$1 rel
  local -a envv
  rel=$CF_RELEASES/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}
  install -d -o "$CF_APP_USER" -g "$CF_GROUP" -m 0750 "$rel"
  {
    log "release $rel"
    cf_build_env envv &&
      cf_git archive --format=tar "$sha" | cf_as "$CF_APP_USER" "$rel" PATH=/usr/bin:/bin tar -x -f - &&
      printf '%s\n' "$sha" | cf_as "$CF_APP_USER" "$rel" PATH=/usr/bin:/bin tee REVISION >/dev/null &&
      cf_scrub_env_files "$rel" &&
      log "npm ci (all dependencies: the worker runs through tsx, a devDependency)" &&
      cf_as_build "$CF_APP_USER" "$rel" "${envv[@]}" npm ci --include=dev --no-audit --no-fund --loglevel=warn &&
      log "prisma generate" &&
      cf_as_build "$CF_APP_USER" "$rel" "${envv[@]}" node_modules/.bin/prisma generate &&
      log "next build (low priority: the worker keeps running meanwhile)" &&
      cf_as_build "$CF_APP_USER" "$rel" "${envv[@]}" npm run build &&
      [[ -s $rel/.next/BUILD_ID ]] &&
      cf_scrub_env_files "$rel" &&
      # Turbopack snapshots the build environment into .next/cache; the running server does not need it.
      cf_as "$CF_APP_USER" "$rel" PATH=/usr/bin:/bin rm -rf .next/cache
  } >&2 || {
    warn "build of ${sha:0:12} failed; removing $rel (the running release is untouched)"
    rm -rf --one-file-system -- "$rel"
    return 1
  }
  printf '%s' "$rel"
}

# cf_db_push <release>: apply the release's Prisma schema (never with --accept-data-loss: Prisma refuses
# destructive changes and this returns non-zero), then make sure both services can open the database.
# Run it with web and worker stopped: on SQLite a push may rebuild a table in several separate statements.
cf_db_push() {
  local rel=$1
  local -a envv
  cf_build_env envv
  install -d -o "$CF_APP_USER" -g "$CF_GROUP" -m 2770 "$CF_DATA"
  cf_as "$CF_APP_USER" "$rel" "${envv[@]}" node_modules/.bin/prisma db push --skip-generate || return 1
  cf_db_fix_perms || return 1
  cf_sqlite "$CF_DB" 'PRAGMA journal_mode=WAL;' >/dev/null || return 1
  cf_db_fix_perms
}

# cf_set_link <link> <target>: replace a symlink atomically.
cf_set_link() {
  ln -sfn "$2" "$1.tmp.$$"
  mv -Tf "$1.tmp.$$" "$1"
}

cf_switch_current() {
  local rel=$1 old
  old=$(cf_current_release)
  cf_set_link "$CF_CURRENT" "$rel"
  if [[ -n $old && $old != "$rel" ]]; then
    cf_set_link "$CF_PREVIOUS" "$old"
  fi
}

cf_prune_releases() {
  local cur prev d n=0
  cur=$(cf_current_release)
  prev=$(readlink -e "$CF_PREVIOUS" 2>/dev/null || true)
  while IFS= read -r d; do
    n=$((n + 1))
    ((n <= CF_KEEP_RELEASES)) && continue
    [[ $CF_RELEASES/$d == "$cur" || $CF_RELEASES/$d == "$prev" ]] && continue
    log "pruning old release $d"
    rm -rf --one-file-system -- "${CF_RELEASES:?}/$d"
  done < <(find "$CF_RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%P\n' | sort -r)
  return 0
}

# ── Kit (these scripts, units, templates) ────────────────────────────────────────────────────────────────
# What is installed comes from the MANIFEST of the kit being installed (not from this file), so a new commit
# can add, rename or drop files. Only listed files are installed: never an env/secrets file left next to them.

# cf_manifest <kit-dir> [kind...]: the paths of that kit's MANIFEST entries of those kinds (all by default).
# Use it as $(...) and check the status: it dies on a missing MANIFEST or a malformed line.
cf_manifest() {
  local dir=$1 kind path rest
  shift
  [[ -f $dir/MANIFEST ]] || die "deploy kit incomplete: $dir/MANIFEST is missing"
  while read -r kind path rest || [[ -n $kind ]]; do
    kind=${kind%$'\r'} path=${path%$'\r'}
    [[ -z $kind || $kind == \#* ]] && continue
    [[ $kind =~ ^(cmd|file|unit|enable)$ && $path =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)?$ && $path != *..* && -z $rest ]] ||
      die "bad line in $dir/MANIFEST: $kind $path $rest"
    [[ $kind != cmd || ($path != */* && $path == *.sh) ]] || die "bad cmd in $dir/MANIFEST: $path"
    [[ ($kind != unit && $kind != enable) || $path =~ ^systemd/[A-Za-z0-9_.-]+\.(service|timer)$ ]] ||
      die "bad unit in $dir/MANIFEST: $path"
    if (($# == 0)) || [[ " $* " == *" $kind "* ]]; then printf '%s\n' "$path"; fi
  done <"$dir/MANIFEST"
}

# cf_install_kit <source-dir>: atomically replace /usr/local/lib/copyfomo and the copyfomo-* commands.
cf_install_kit() {
  local src=$1 new f link txt
  local -a files cmds
  txt=$(cf_manifest "$src") || die "cannot read the deploy kit's MANIFEST in $src"
  mapfile -t files <<<"$txt"
  txt=$(cf_manifest "$src" cmd) || die "cannot read the deploy kit's MANIFEST in $src"
  mapfile -t cmds <<<"$txt"
  ((${#files[@]} > 1 && ${#cmds[@]} > 0)) || die "the deploy kit's MANIFEST in $src lists nothing to install"
  for f in "${files[@]}"; do [[ -f $src/$f && ! -L $src/$f ]] || die "deploy kit incomplete: $src/$f is missing"; done
  new=$(mktemp -d "$CF_KIT.new.XXXXXX")
  CF_CLEANUP+=("$new")
  for f in "${files[@]}"; do install -D -m 0644 -o root -g root "$src/$f" "$new/$f"; done
  for f in "${cmds[@]}"; do chmod 0755 "$new/$f"; done
  find "$new" -type d -exec chmod 0755 {} +
  if [[ -d $CF_KIT ]]; then mv -T "$CF_KIT" "$CF_KIT.old.$$"; fi
  mv -T "$new" "$CF_KIT"
  rm -rf "$CF_KIT.old.$$"
  for f in "${cmds[@]}"; do ln -sfn "$CF_KIT/$f" "/usr/local/sbin/copyfomo-${f%.sh}"; done
  # Commands a newer kit dropped.
  for link in /usr/local/sbin/copyfomo-*; do
    [[ -L $link && ! -e $link && $(readlink "$link") == "$CF_KIT/"* ]] && rm -f -- "$link"
  done
  return 0
}

# cf_kit_commands: the installed copyfomo-* command names, for messages.
cf_kit_commands() {
  local txt
  txt=$(cf_manifest "$CF_KIT" cmd 2>/dev/null) || return 0
  sed -e 's/\.sh$//' -e 's/^/copyfomo-/' <<<"$txt" | paste -sd' ' -
}

# cf_refresh_kit_from_git <sha>: install the kit shipped in that commit (from the root-owned bare clone, never
# from a release directory the copyfomo user can write).
cf_refresh_kit_from_git() {
  local sha=$1 tmp
  if ! cf_git cat-file -e "$sha:deploy/MANIFEST" 2>/dev/null; then
    warn "commit ${sha:0:12} has no deploy/MANIFEST (no kit, or an older one): keeping the installed kit"
    return 0
  fi
  tmp=$(mktemp -d)
  CF_CLEANUP+=("$tmp")
  cf_git archive --format=tar "$sha" deploy | tar -x -f - -C "$tmp" --strip-components=1
  cf_install_kit "$tmp"
}

# cf_install_units: copy the kit's unit files; daemon-reload only when one changed; enable the `enable` ones.
cf_install_units() {
  local u changed=0 txt
  local -a units enable
  txt=$(cf_manifest "$CF_KIT" unit enable) || die "cannot read $CF_KIT/MANIFEST"
  mapfile -t units <<<"$txt"
  txt=$(cf_manifest "$CF_KIT" enable) || die "cannot read $CF_KIT/MANIFEST"
  mapfile -t enable <<<"$txt"
  for u in "${units[@]}"; do
    [[ -n $u ]] || continue
    if ! cmp -s "$CF_KIT/$u" "/etc/systemd/system/${u##*/}"; then
      install -m 0644 -o root -g root "$CF_KIT/$u" "/etc/systemd/system/${u##*/}"
      changed=1
    fi
  done
  if [[ $changed == 1 ]]; then
    systemctl daemon-reload
    ok "systemd units installed"
  fi
  [[ -n ${enable[0]:-} ]] && systemctl enable --quiet "${enable[@]##*/}"
  return 0
}

# cf_render_caddyfile <domain> <email> <www:yes|no> → stdout. Inputs are validated by the callers.
cf_render_caddyfile() {
  local domain=$1 email=$2 www=$3 email_line=''
  [[ -n $email ]] && email_line="email $email"
  if [[ $www == yes ]]; then
    sed -e "s|__DOMAIN__|$domain|g" -e "s|__EMAIL_LINE__|$email_line|" "$CF_KIT/Caddyfile.tmpl"
  else
    sed -e '/^# BEGIN www$/,/^# END www$/d' -e "s|__DOMAIN__|$domain|g" -e "s|__EMAIL_LINE__|$email_line|" "$CF_KIT/Caddyfile.tmpl"
  fi
}

# cf_apply_caddyfile: render, validate, install and reload Caddy when the file changed. A hand-edited
# /etc/caddy/Caddyfile is kept aside (with a warning) before it is replaced: the template is the only source.
cf_apply_caddyfile() {
  local domain email www tmp out stamp=/etc/caddy/.copyfomo-rendered.sha256 keep
  domain=$(cf_conf_get DOMAIN)
  email=$(cf_conf_get EMAIL)
  www=$(cf_conf_get WWW)
  [[ -n $domain ]] || die "no DOMAIN in $CF_CONF"
  tmp=$(mktemp)
  CF_CLEANUP+=("$tmp")
  cf_render_caddyfile "$domain" "$email" "${www:-yes}" >"$tmp"
  if ! out=$(caddy validate --adapter caddyfile --config "$tmp" 2>&1); then
    printf '%s\n' "$out" >&2
    die "the rendered Caddyfile does not validate"
  fi
  if ! cmp -s "$tmp" /etc/caddy/Caddyfile; then
    if [[ -f /etc/caddy/Caddyfile && -f $stamp && $(sha256sum /etc/caddy/Caddyfile | cut -d' ' -f1) != "$(<"$stamp")" ]]; then
      keep=/etc/caddy/Caddyfile.local-edit.$(date -u +%Y%m%dT%H%M%SZ)
      cp -p /etc/caddy/Caddyfile "$keep"
      warn "/etc/caddy/Caddyfile was edited by hand: it is replaced by the rendered deploy/Caddyfile.tmpl (your version: $keep). Put changes in the template."
    fi
    install -m 0644 -o root -g root "$tmp" /etc/caddy/Caddyfile
    if systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl restart caddy; fi
    ok "Caddy configured for $domain"
  fi
  sha256sum /etc/caddy/Caddyfile | cut -d' ' -f1 >"$stamp"
  systemctl enable --quiet caddy
  systemctl is-active --quiet caddy || systemctl start caddy
}

# ── Services ─────────────────────────────────────────────────────────────────────────────────────────────
# cf_wait_http <url> <seconds>
cf_wait_http() {
  local url=$1 end=$((SECONDS + ${2:-60}))
  while ((SECONDS < end)); do
    curl -fsS -m 3 -o /dev/null "$url" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

cf_unit_state() { systemctl show -p ActiveState --value "$1" 2>/dev/null || true; }

# Stop the worker if it runs (also while it is in a restart loop). systemctl stop blocks until the process has
# exited: SIGTERM → the worker drains in-flight sends (≤ ~165 s) → exit, or SIGKILL at TimeoutStopSec.
cf_worker_stop() {
  case $(cf_unit_state "$CF_WORKER_UNIT") in
    active | activating | reloading | deactivating)
      CF_WORKER_STOPPED=1
      log "stopping the worker (SIGTERM: it lets in-flight swaps settle, up to ~3 min)…"
      systemctl stop "$CF_WORKER_UNIT"
      ok "worker stopped"
      ;;
  esac
  return 0
}

# Stop the web if it runs. Meanwhile Caddy holds requests for up to 20 s, then answers "copyfomo is restarting".
cf_web_stop() {
  case $(cf_unit_state "$CF_WEB_UNIT") in
    active | activating | reloading | deactivating)
      CF_WEB_STOPPED=1
      systemctl stop "$CF_WEB_UNIT"
      ok "web stopped"
      ;;
  esac
  return 0
}

# cf_worker_start [timeout]: start it and wait until it is up: a fresh worker:heartbeat in the database, written
# in the mode web.env asks for (independent of LOG_LEVEL), or its "[worker] running" log line. Fails early on a
# FATAL line or a crash loop.
cf_worker_start() {
  local since_ms end restarts0 logs mode beat now_us
  mode=$(cf_env_get "$CF_WEB_ENV" COPYFOMO_MODE)
  [[ $mode == live ]] || mode=paper
  now_us=${EPOCHREALTIME/[.,]/}
  since_ms=$((10#$now_us / 1000))
  systemctl start "$CF_WORKER_UNIT"
  CF_WORKER_STOPPED=0
  restarts0=$(systemctl show -p NRestarts --value "$CF_WORKER_UNIT" 2>/dev/null || echo 0)
  end=$((SECONDS + ${1:-180}))
  while ((SECONDS < end)); do
    beat=''
    if [[ -f $CF_DB ]]; then
      beat=$(cf_sqlite -cmd '.timeout 2000' "$CF_DB" "SELECT count(*) FROM Kv WHERE key = 'worker:heartbeat' AND updatedAt >= $since_ms AND json_extract(value, '\$.mode') = '$mode';" 2>/dev/null || true)
    fi
    logs=$(journalctl -u "$CF_WORKER_UNIT" --since "@$((since_ms / 1000))" -o cat --no-pager 2>/dev/null || true)
    if [[ $beat == 1 ]] || grep -q '\[worker\] running' <<<"$logs"; then
      ok "worker running ($mode mode)"
      return 0
    fi
    if grep -q 'FATAL' <<<"$logs" || (($(systemctl show -p NRestarts --value "$CF_WORKER_UNIT" 2>/dev/null || echo 0) > restarts0 + 1)); then
      grep -A8 -m1 'FATAL' <<<"$logs" >&2 || tail -n 25 <<<"$logs" >&2
      return 1
    fi
    sleep 2
  done
  warn "the worker wrote no $mode heartbeat within ${1:-180}s: journalctl -u $CF_WORKER_UNIT -n 100"
  return 1
}

cf_web_restart() {
  systemctl restart "$CF_WEB_UNIT"
  CF_WEB_STOPPED=0
  if cf_wait_http "$CF_WEB_URL/api/config" "${1:-90}"; then
    ok "web answering on $CF_WEB_URL"
    return 0
  fi
  journalctl -u "$CF_WEB_UNIT" -n 30 --no-pager -o cat >&2 || true
  return 1
}

# The mode the running web reports (public /api/config).
cf_live_mode() { curl -fsS -m 5 "$CF_WEB_URL/api/config" 2>/dev/null | jq -r '.mode // empty' 2>/dev/null || true; }

# ── Deploy one commit (setup.sh and update.sh) ───────────────────────────────────────────────────────────
# cf_deploy_sha <sha> <refresh-kit:yes|no>
#   build (site keeps running, low priority) → [kit] → stop worker, then web → backup → prisma db push → units
#   → switch → start web (health-checked; on failure `current` AND `previous` go back and the new release is
#   deleted) → start worker → prune.
cf_deploy_sha() {
  local sha=$1 refresh_kit=$2 rel old old_prev
  old=$(cf_current_release)
  old_prev=$(readlink -e "$CF_PREVIOUS" 2>/dev/null || true)
  step "Building ${sha:0:12} (the running site is not touched until this succeeds)"
  rel=$(cf_build_release "$sha") || die "build failed: nothing was changed, the previous release is still running"
  CF_PENDING_RELEASE=$rel
  ok "built $rel"

  [[ $refresh_kit == yes ]] && cf_refresh_kit_from_git "$sha"

  step "Switching to ${sha:0:12}"
  cf_worker_stop
  # The web stops too: on SQLite, prisma db push may rebuild a table (copy, drop, rename) in separate statements,
  # and a web write in between (a new agent's sealed key) would be lost. The backup is then exactly the database
  # the new schema is applied to.
  cf_web_stop
  if [[ -f $CF_DB ]]; then
    "$CF_KIT/backup.sh" --label pre-update || die "pre-update backup failed: nothing was changed"
  fi
  log "prisma db push"
  cf_db_push "$rel" || die "prisma db push failed (a destructive schema change needs a manual migration; see deploy/README.md). Code not switched"
  cf_install_units
  cf_switch_current "$rel"
  if ! cf_web_restart 90; then
    if [[ -n $old && -d $old ]]; then
      warn "the new web release does not answer: switching back to $old"
      cf_set_link "$CF_CURRENT" "$old"
      if [[ -n $old_prev ]]; then cf_set_link "$CF_PREVIOUS" "$old_prev"; else rm -f "$CF_PREVIOUS"; fi
      cf_web_restart 90 || warn "the previous release does not answer either"
    fi
    die "web health check failed for ${sha:0:12}; its release is deleted (the database schema stays pushed; additive changes are harmless)"
  fi
  CF_PENDING_RELEASE=''
  cf_worker_start 180 || die "worker did not start cleanly on ${sha:0:12}: check the log above, then fix or run: copyfomo-update --rollback"
  cf_prune_releases
  ok "now running ${sha:0:12} ($rel)"
}
