#!/usr/bin/env bash
# copyfomo-update: deploy the latest commit of the configured branch (or --ref), fail-safe.
#
#   copyfomo-update                 fetch origin/<branch>, build, back up, migrate, switch, restart
#   copyfomo-update --ref <sha|tag|branch>
#   copyfomo-update --force         rebuild and redeploy even if that commit is already running
#   copyfomo-update --rollback      go back to the previous release (the database is NOT rolled back)
#
# Order: fetch → build a NEW release directory at low priority while the site keeps running (a failed build
#   changes nothing) → install the kit/units shipped in that commit → stop the worker gracefully (in-flight swaps
#   settle), then the web → backup → prisma db push (destructive changes are refused) → switch `current` → start
#   web (health-checked; switched back, failed release deleted, if it does not answer) → start worker → prune
#   old releases (keeps 3).
# It runs as the systemd service copyfomo-update and this terminal follows its log: a dropped SSH connection or
# Ctrl-C does not stop it halfway (journalctl -u copyfomo-update -f -o cat to follow it again).

SELF_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=deploy/lib.sh
source "$SELF_DIR/lib.sh"

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

ARGS=("$@")
REF='' FORCE=0 ROLLBACK=0
while (($#)); do
  case $1 in
    --ref) REF=${2:?--ref needs a value}; shift 2 ;;
    --force) FORCE=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

cf_require_root
[[ -f $CF_CONF && -f $CF_WEB_ENV ]] || die "copyfomo is not set up on this server: run setup.sh first"
cf_detach update "$SELF_DIR/update.sh" "${ARGS[@]}"
cf_lock deploy

if ((ROLLBACK)); then
  cur=$(cf_current_release)
  prev=$(readlink -e "$CF_PREVIOUS" 2>/dev/null || true)
  [[ -n $prev && -d $prev && $prev != "$cur" ]] || die "no previous release to roll back to"
  step "Rolling back: $(basename "$cur") → $(basename "$prev")"
  warn "the database schema is not rolled back (prisma db push changes are additive; restore a backup if needed)"
  cf_worker_stop
  "$CF_KIT/backup.sh" --label pre-rollback || die "backup failed: nothing was changed"
  cf_switch_current "$prev"
  if ! cf_web_restart 90; then
    warn "the previous release does not answer: switching back to $(basename "$cur")"
    cf_switch_current "$cur"
    cf_web_restart 90 || true
    die "rollback failed"
  fi
  cf_worker_start 180 || die "the worker did not start cleanly after the rollback"
  ok "rolled back to $(basename "$prev") ($(cf_release_sha "$prev" | cut -c1-12))"
  exit 0
fi

BRANCH=$(cf_conf_get BRANCH)
BRANCH=${BRANCH:-main}
REF=${REF:-$BRANCH}
[[ $REF =~ ^[A-Za-z0-9._/-]+$ ]] || die "bad --ref: $REF"

step "Fetching $(cf_conf_get REPO_URL)"
cf_fetch || die "git fetch failed (deploy key revoked? network?). Nothing was changed."
TARGET_SHA=$(cf_resolve_ref "$REF") || die "'$REF' is not a branch, tag or commit of the repository"
CURRENT_SHA=$(cf_current_sha)
if [[ $TARGET_SHA == "$CURRENT_SHA" && $FORCE == 0 ]]; then
  ok "already running ${TARGET_SHA:0:12} ($REF). Use --force to rebuild anyway."
  exit 0
fi
if [[ -n $CURRENT_SHA ]] && cf_git merge-base --is-ancestor "$CURRENT_SHA" "$TARGET_SHA" 2>/dev/null; then
  log "changes ${CURRENT_SHA:0:12}..${TARGET_SHA:0:12}:"
  cf_git log --oneline --no-decorate "$CURRENT_SHA..$TARGET_SHA" | head -n 30 | sed 's/^/      /'
else
  log "target ${TARGET_SHA:0:12}: $(cf_git log -1 --format=%s "$TARGET_SHA")"
fi

cf_deploy_sha "$TARGET_SHA" yes
# The template may have changed with the kit.
cf_apply_caddyfile

step "Done"
curl -fsS -m 5 "$CF_WEB_URL/api/config" | jq -c '{mode, workerOnline, onchainRanking}' 2>/dev/null | sed 's/^/    \/api\/config: /' || true
