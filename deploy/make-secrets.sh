#!/usr/bin/env bash
# deploy/make-secrets.sh: run on YOUR PC (Git Bash), not on the server.
# Builds the file setup.sh imports (/root/copyfomo.secrets.env) from your local .env:
#
#   bash deploy/make-secrets.sh [--env .env] [--out ~/copyfomo.secrets.env] [--fee-wallet <address>]
#
# Copies every non-empty setting EXCEPT the ones production must not inherit from dev: WALLET_SEAL_* and
# SESSION_SECRET (generated fresh on the server), DATABASE_URL, NEXT_PUBLIC_SITE_URL, NODE_ENV,
# TRUSTED_IP_SOURCE, TRUSTED_PROXY_HOPS (set by setup), COPYFOMO_MODE (copyfomo-set-mode).
# Prints setting NAMES only, plus the public values worth checking (fee wallet, Helius plan, Jupiter URL).

set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE=$here/../.env
OUT=$HOME/copyfomo.secrets.env
FEE_WALLET=''
while (($#)); do
  case $1 in
    --env) ENV_FILE=${2:?}; shift 2 ;;
    --out) OUT=${2:?}; shift 2 ;;
    --fee-wallet) FEE_WALLET=${2:?}; shift 2 ;;
    -h | --help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
[[ -f $ENV_FILE ]] || { echo "no $ENV_FILE" >&2; exit 1; }

SKIP=' WALLET_SEAL_PUBLIC_KEY WALLET_SEAL_PRIVATE_KEY SESSION_SECRET DATABASE_URL NEXT_PUBLIC_SITE_URL NODE_ENV TRUSTED_IP_SOURCE TRUSTED_PROXY_HOPS COPYFOMO_MODE '

declare -A VAL=()
declare -a ORDER=()
re_kv='^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$'
re_dq='^"([^"]*)"[[:space:]]*(#.*)?$'
re_sq="^'([^']*)'[[:space:]]*(#.*)?\$"
while IFS= read -r line || [[ -n $line ]]; do
  line=${line%$'\r'}
  line=${line#"${line%%[![:space:]]*}"}
  [[ -z $line || $line == \#* ]] && continue
  line=${line#export }
  [[ $line =~ $re_kv ]] || continue
  key=${BASH_REMATCH[1]} val=${BASH_REMATCH[2]}
  val=${val#"${val%%[![:space:]]*}"}
  if [[ $val =~ $re_dq || $val =~ $re_sq ]]; then
    val=${BASH_REMATCH[1]}
  else
    [[ $val == \#* ]] && val=''
    val=${val%%[[:space:]]#*}
    val=${val%"${val##*[![:space:]]}"}
  fi
  [[ -z ${VAL[$key]+x} ]] && ORDER+=("$key")
  VAL[$key]=$val
done <"$ENV_FILE"

if [[ -n $FEE_WALLET ]]; then
  [[ -z ${VAL[PLATFORM_FEE_WALLET]+x} ]] && ORDER+=(PLATFORM_FEE_WALLET)
  VAL[PLATFORM_FEE_WALLET]=$FEE_WALLET
fi

written=() skipped=() bad=()
body="# copyfomo.secrets.env, generated $(date -u +%Y-%m-%dT%H:%M:%SZ) from $(basename "$ENV_FILE") by deploy/make-secrets.sh.
# Upload to /root/copyfomo.secrets.env; setup.sh imports it into /etc/copyfomo/web.env, then deletes it."
for key in "${ORDER[@]}"; do
  val=${VAL[$key]}
  if [[ $SKIP == *" $key "* ]]; then
    skipped+=("$key")
    continue
  fi
  [[ -n $val ]] || continue
  case $val in
    *[[:space:]]* | *\"* | *\'* | *\\* | *\$* | *\`*) bad+=("$key"); continue ;;
  esac
  body+=$'\n'"$key=$val"
  written+=("$key")
done
((${#bad[@]} == 0)) || { echo "these values contain spaces, quotes, \\, \$ or a backtick; fix them in $ENV_FILE: ${bad[*]}" >&2; exit 1; }

fee=${VAL[PLATFORM_FEE_WALLET]:-}
if [[ -n $fee && ! $fee =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]]; then
  echo "PLATFORM_FEE_WALLET is not a base58 Solana address" >&2
  exit 1
fi

umask 077
printf '%s\n' "$body" >"$OUT"
chmod 600 "$OUT" 2>/dev/null || true

echo "wrote ${#written[@]} settings to $OUT:"
printf '  %s\n' "${written[@]}"
((${#skipped[@]} == 0)) || echo "left out (generated or managed on the server): ${skipped[*]}"
echo
echo "check these public values:"
echo "  PLATFORM_FEE_WALLET = ${fee:-<empty: required before going live>}"
echo "  HELIUS_PLAN         = ${VAL[HELIUS_PLAN]:-<empty: free>}"
echo "  JUPITER_API_URL     = ${VAL[JUPITER_API_URL]:-<empty: lite-api, paper only>}"
[[ -n ${VAL[JUPITER_API_KEY]:-} ]] || echo "  JUPITER_API_KEY     = <empty: required before going live>"
[[ -n ${VAL[HELIUS_API_KEY]:-} ]] || echo "  HELIUS_API_KEY      = <empty: no FOMO leaderboard indexing>"
echo
echo "next: scp -i ~/.ssh/copyfomo_deploy \"$OUT\" root@<server-ip>:/root/copyfomo.secrets.env"
