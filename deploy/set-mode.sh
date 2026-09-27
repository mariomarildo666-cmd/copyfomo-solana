#!/usr/bin/env bash
# copyfomo-set-mode paper|live [--yes]
#
# Flips COPYFOMO_MODE in /etc/copyfomo/web.env and restarts both services (worker stopped gracefully first,
# then web, then worker). Live is refused unless PLATFORM_FEE_WALLET is a valid address, JUPITER_API_KEY is set
# with an https://api.jup.ag URL, the seal key pair matches, an off-server copy of worker.env was proven
# (copyfomo-offsite key-check) and a database backup taken in the last 48 h was verified off the server
# (deploy/pull-backups.ps1). If the worker refuses to start in the new mode, the previous mode is restored.
#
# An agent's mode is fixed when it is created. A paper worker IGNORES live agents: going back to paper while
# live agents hold positions means nothing sells them. Close or withdraw them first.

SELF_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=deploy/lib.sh
source "$SELF_DIR/lib.sh"

MODE='' YES=0
while (($#)); do
  case $1 in
    paper | live) MODE=$1; shift ;;
    --yes) YES=1; shift ;;
    -h | --help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "usage: copyfomo-set-mode paper|live [--yes]" ;;
  esac
done
[[ -n $MODE ]] || die "usage: copyfomo-set-mode paper|live [--yes]"

cf_require_root
[[ -f $CF_WEB_ENV ]] || die "copyfomo is not set up on this server: run setup.sh first"
cf_lock deploy

OLD=$(cf_env_get "$CF_WEB_ENV" COPYFOMO_MODE)
OLD=${OLD:-paper}
if [[ $OLD == "$MODE" ]]; then
  ok "already in $MODE mode"
  exit 0
fi

step "Checks for $MODE mode"
if [[ $MODE == live ]]; then
  problems=()
  fee_wallet=$(cf_env_get "$CF_WEB_ENV" PLATFORM_FEE_WALLET)
  jup_url=$(cf_env_get "$CF_WEB_ENV" JUPITER_API_URL)
  jup_key_set=no
  [[ -n $(cf_env_get "$CF_WEB_ENV" JUPITER_API_KEY) ]] && jup_key_set=yes
  rpc_host=$(cf_env_get "$CF_WEB_ENV" SOLANA_RPC_URL | sed -E 's#^[a-z]+://([^/?]+).*#\1#')
  if [[ -z $fee_wallet ]]; then
    problems+=("PLATFORM_FEE_WALLET is empty (the live fee is swept there)")
  elif ! cf_is_solana_address "$fee_wallet"; then
    problems+=("PLATFORM_FEE_WALLET is not a valid Solana address: $fee_wallet")
  fi
  [[ $jup_key_set == yes ]] || problems+=("JUPITER_API_KEY is empty (portal.jup.ag)")
  [[ $jup_url =~ ^https://api\.jup\.ag/?$ ]] || problems+=("JUPITER_API_URL must be https://api.jup.ag (is '${jup_url:-<empty: lite-api default>}')")
  cf_seal_pair_ok || problems+=("the seal key pair is missing or does not match (web.env public key vs worker.env private key)")
  # Real money only once losing this server cannot lose it: the key AND a recent database backup must be
  # verifiably off the server (deploy/README.md §8).
  cf_offsite_key_ok ||
    problems+=("no off-server copy of $CF_WORKER_ENV is confirmed: copy it off, then prove it with  copyfomo-offsite key-check  (deploy/README.md §8)")
  backup_age_h=$(cf_offsite_backup_age_h)
  if [[ -z $backup_age_h ]]; then
    problems+=("no database backup has been copied off the server: run deploy/pull-backups.ps1 on your PC (deploy/README.md §8)")
  elif ((backup_age_h > 48)); then
    problems+=("the newest database backup copied off the server is ${backup_age_h}h old (max 48): run deploy/pull-backups.ps1 on your PC")
  fi
  if ((${#problems[@]})); then
    for p in "${problems[@]}"; do warn "$p"; done
    die "live mode refused. Fix $CF_WEB_ENV (or import a secrets file with setup.sh), then retry."
  fi
  [[ -n $rpc_host && $rpc_host != api.mainnet-beta.solana.com ]] ||
    warn "SOLANA_RPC_URL is the public mainnet RPC: use a paid RPC (Helius) for real trading"
  [[ -n $(cf_env_get "$CF_WEB_ENV" HELIUS_API_KEY) ]] || warn "HELIUS_API_KEY is empty: no FOMO leaderboard indexing"
  cat <<EOF
    Fee wallet:   $fee_wallet   (live fees are swept here: make sure it is yours, fund it with >= 0.001 SOL)
    Fee:          $(cf_env_get "$CF_WEB_ENV" PLATFORM_FEE_BPS) bps of the realized profit of each winning sell
    Jupiter:      $jup_url (key set)
    RPC host:     ${rpc_host:-<public default>}
    Real SOL moves from now on for every NEW agent. Existing paper agents stay paper.
EOF
else
  live_agents=0
  [[ -f $CF_DB ]] && live_agents=$(cf_sqlite -cmd '.timeout 10000' "$CF_DB" "SELECT count(*) FROM Agent WHERE mode = 'live' AND status != 'stopped';" 2>/dev/null || echo '?')
  [[ $live_agents =~ ^[0-9]+$ ]] || warn "could not count the live agents in $CF_DB: check that none is still running before going back to paper"
  if [[ $live_agents =~ ^[0-9]+$ ]] && ((live_agents > 0)); then
    warn "$live_agents live agent(s) are not stopped. A paper worker ignores them: their positions are not sold and withdrawals are not processed."
  fi
fi

if ((YES == 0)); then
  [[ -t 0 ]] || die "pass --yes to confirm (no terminal to ask on)"
  read -r -p "    Switch copyfomo from $OLD to $MODE? Type ${MODE^^}: " answer
  [[ $answer == "${MODE^^}" ]] || die "aborted"
fi

step "Switching $OLD → $MODE"
"$CF_KIT/backup.sh" --label pre-mode-change || die "backup failed: mode not changed"
cf_worker_stop
cf_env_set "$CF_WEB_ENV" COPYFOMO_MODE "$MODE"
revert() {
  warn "$1: going back to $OLD mode"
  cf_worker_stop
  cf_env_set "$CF_WEB_ENV" COPYFOMO_MODE "$OLD"
  cf_web_restart 90 || true
  cf_worker_start 180 || true
  die "$MODE mode NOT enabled (still $OLD)"
}
cf_web_restart 90 || revert "the web did not come back in $MODE mode"
[[ $(cf_live_mode) == "$MODE" ]] || revert "the web reports mode '$(cf_live_mode)'"
cf_worker_start 180 || revert "the worker refused to run in $MODE mode (see the log above)"
if [[ $MODE == live ]]; then
  journalctl -u "$CF_WORKER_UNIT" -n 200 -o cat --no-pager | grep -E 'seal key pair ok|PLATFORM_FEE_WALLET holds no SOL' | tail -n 2 | sed 's/^/    /' || true
fi
ok "copyfomo is in $MODE mode"
