#!/usr/bin/env bash
# copyfomo: idempotent provisioning of one Ubuntu 24.04 server (run as root). Full walkthrough: deploy/README.md.
#
#   bash setup.sh --domain copyfomo.example [--email you@example.com] [--no-www | --www]
#                 [--repo git@github.com:OWNER/REPO.git] [--branch main] [--secrets /root/copyfomo.secrets.env]
#                 [--rebuild] [--skip upgrade,swap,ufw,fail2ban]
#
# Safe to re-run at any time (after a failure, to import rotated provider keys, to change the domain):
#   - never rotates WALLET_SEAL_PUBLIC_KEY / WALLET_SEAL_PRIVATE_KEY / SESSION_SECRET (rotation would orphan every
#     agent wallet), and refuses to generate a new seal key pair while the database holds agents (or cannot be read);
#   - keeps every value in /etc/copyfomo/web.env, the mode included;
#   - rebuilds only when the target commit or the domain changed (or with --rebuild).
# It runs as the systemd service copyfomo-setup and this terminal follows its log: a dropped SSH connection or
# Ctrl-C does not stop it (journalctl -u copyfomo-setup -f -o cat to follow it again; CF_NO_DETACH=1 runs in place).
# --skip is for test containers/VMs (e.g. WSL): it skips those provisioning steps, nothing else.

SELF_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=deploy/lib.sh
source "$SELF_DIR/lib.sh"

DEFAULT_REPO=git@github.com:mariomarildo666-cmd/copyfomo.git

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

ARGS=("$@")
DOMAIN='' EMAIL='' REPO_URL='' BRANCH='' WWW='' SECRETS=/root/copyfomo.secrets.env REBUILD=0 SKIP=','
while (($#)); do
  case $1 in
    --domain) DOMAIN=${2:?--domain needs a value}; shift 2 ;;
    --email) EMAIL=${2:?--email needs a value}; shift 2 ;;
    --repo) REPO_URL=${2:?--repo needs a value}; shift 2 ;;
    --branch) BRANCH=${2:?--branch needs a value}; shift 2 ;;
    --secrets) SECRETS=${2:?--secrets needs a value}; shift 2 ;;
    --no-www) WWW=no; shift ;;
    --www) WWW=yes; shift ;; # the choice is remembered in deploy.conf; this turns a previous --no-www back off
    --rebuild) REBUILD=1; shift ;;
    --skip) SKIP=",${2:?--skip needs a value},"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done
skipped() { [[ $SKIP == *",$1,"* ]]; }

cf_require_root
cf_detach setup "$SELF_DIR/setup.sh" "${ARGS[@]}"
cf_lock deploy

# Values from a previous run fill in whatever this run does not pass.
PREV_DOMAIN=$(cf_conf_get DOMAIN)
DOMAIN=${DOMAIN:-$PREV_DOMAIN}
EMAIL=${EMAIL:-$(cf_conf_get EMAIL)}
REPO_URL=${REPO_URL:-$(cf_conf_get REPO_URL)}
REPO_URL=${REPO_URL:-$DEFAULT_REPO}
BRANCH=${BRANCH:-$(cf_conf_get BRANCH)}
BRANCH=${BRANCH:-main}
PREV_WWW=$(cf_conf_get WWW)
WWW=${WWW:-${PREV_WWW:-yes}}

DOMAIN=${DOMAIN,,}
[[ -n $DOMAIN ]] || { usage >&2; die "--domain is required on the first run"; }
[[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "not a domain name: $DOMAIN"
[[ $DOMAIN != www.* ]] || die "pass the bare domain (without www.): setup adds the www → $DOMAIN redirect itself"
[[ -z $EMAIL || $EMAIL =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "not an email address: $EMAIL"
[[ $BRANCH =~ ^[A-Za-z0-9._/-]+$ ]] || die "bad branch name: $BRANCH"
[[ $REPO_URL =~ ^(git@github\.com:[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?|https://[^[:space:]]+|/[^[:space:]]+|file://[^[:space:]]+)$ ]] ||
  die "unsupported --repo: $REPO_URL (git@github.com:OWNER/REPO.git, an https URL or a local path)"
GITHUB_SLUG=''
if [[ $REPO_URL =~ ^git@github\.com:([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)$ ]]; then
  GITHUB_SLUG=${BASH_REMATCH[1]%.git}
fi

step "copyfomo setup: $DOMAIN (repo $REPO_URL, branch $BRANCH)"
SERVER_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}' || true)
SERVER_IP=${SERVER_IP:-<server-ip>}
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ ${ID:-} == ubuntu ]] || die "this kit targets Ubuntu (found ${PRETTY_NAME:-unknown})"
  [[ ${VERSION_ID:-} == 24.04 ]] || warn "written for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}: continuing"
fi
command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || die "systemd is not running here"

apt_get() { apt-get -y -q -o Acquire::Retries=3 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"; }

# ── 1. Packages ──────────────────────────────────────────────────────────────────────────────────────────
step "System packages"
apt_get update
if skipped upgrade; then
  warn "skipping apt full-upgrade (--skip upgrade)"
else
  apt_get full-upgrade
fi
apt_get install ca-certificates curl gnupg git sqlite3 jq build-essential openssh-client util-linux iproute2 \
  python3 ufw fail2ban python3-systemd unattended-upgrades
ok "base packages"

# Security updates install themselves (Ubuntu's unattended-upgrades default: the -security pocket only).
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now --quiet unattended-upgrades.service 2>/dev/null || true
ok "unattended security upgrades"
# The worker compares local time with block times: keep the clock synced.
timedatectl set-ntp true 2>/dev/null || warn "could not enable NTP time sync (timedatectl set-ntp true)"

# ── 2. Swap ──────────────────────────────────────────────────────────────────────────────────────────────
step "Swap"
if skipped swap; then
  warn "skipping swap (--skip swap)"
elif [[ -n $(swapon --noheadings --show 2>/dev/null) ]]; then
  ok "swap already active: $(swapon --noheadings --show=NAME,SIZE | tr -s ' ' | paste -sd, -)"
else
  # A run interrupted between creating the file and mkswap leaves a /swapfile that is not a swap area: recreate it
  # instead of failing at swapon on every later run.
  if [[ -e /swapfile && $(blkid -p -o value -s TYPE /swapfile 2>/dev/null || true) != swap ]]; then
    warn "/swapfile exists but is not a swap area (an interrupted run?): recreating it"
    rm -f /swapfile
  fi
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 0600 /swapfile
    mkswap -q /swapfile
  fi
  swapon /swapfile || die "swapon /swapfile failed (see dmesg); remove /swapfile and re-run, or --skip swap"
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  echo 'vm.swappiness=10' >/etc/sysctl.d/90-copyfomo-swap.conf
  sysctl -q -p /etc/sysctl.d/90-copyfomo-swap.conf || true
  ok "2 GB swapfile enabled (a next build next to the running services can exceed 4 GB)"
fi

# ── 3. Firewall ──────────────────────────────────────────────────────────────────────────────────────────
step "Firewall (ufw)"
if skipped ufw; then
  warn "skipping ufw (--skip ufw)"
else
  # SSH ports to keep open: 22, whatever sshd's effective config says, the Port lines of its config files (in case
  # `sshd -T` fails), and the port this very session came in on. ufw is enabled only when one of them is
  # confirmed listening, so a wrong guess can never lock out the next login.
  ssh_ports=$(
    {
      sshd -T 2>/dev/null | awk '$1 == "port" {print $2}'
      cat /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | awk 'tolower($1) == "port" {print $2}'
      awk '{print $4}' <<<"${SSH_CONNECTION:-}"
    } | grep -E '^[0-9]{1,5}$' | sort -un | paste -sd' ' - || true
  )
  # shellcheck disable=SC2086 # split the port list on purpose
  ssh_ports=$(printf '%s\n' 22 $ssh_ports | sort -un | paste -sd' ' -)
  listening=" $(ss -Hltn 2>/dev/null | awk '{n = split($4, a, ":"); print a[n]}' | sort -un | paste -sd' ' - || true) "
  confirmed=''
  for p in $ssh_ports; do [[ $listening == *" $p "* ]] && confirmed+=" $p"; done
  if [[ -z $confirmed ]]; then
    warn "none of the SSH ports ($ssh_ports) is confirmed listening (listening:${listening% }): ufw NOT enabled, so the next SSH login cannot be locked out. Check sshd, then re-run setup."
  else
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null
    for p in $ssh_ports; do ufw allow "$p/tcp" comment ssh >/dev/null; done
    ufw allow 80/tcp comment 'http: ACME + redirect' >/dev/null
    ufw allow 443/tcp comment https >/dev/null
    ufw allow 443/udp comment 'http/3' >/dev/null
    ufw --force enable >/dev/null
    ok "ufw: deny incoming except ssh ($ssh_ports; listening:$confirmed), 80, 443 (tcp+udp)"
  fi
fi

# ── 4. fail2ban ──────────────────────────────────────────────────────────────────────────────────────────
step "fail2ban"
if skipped fail2ban; then
  warn "skipping fail2ban (--skip fail2ban)"
else
  cat >/etc/fail2ban/jail.d/copyfomo-sshd.local <<'EOF'
# copyfomo setup.sh: ban SSH brute force. Reads the systemd journal (no dependency on /var/log/auth.log).
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
  systemctl enable --quiet fail2ban
  if systemctl restart fail2ban; then
    ok "fail2ban sshd jail (5 failures in 10 min → 1 h ban)"
  else
    warn "fail2ban did not start: journalctl -u fail2ban -n 50 (continuing: SSH keys still protect the server)"
  fi
fi
if sshd -T 2>/dev/null | grep -qi '^passwordauthentication yes'; then
  warn "SSH still accepts passwords: set 'PasswordAuthentication no' once your key login works"
fi

# ── 5. Node.js 24 (NodeSource) and Caddy (official repo) ─────────────────────────────────────────────────
step "Node.js 24 LTS and Caddy"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
chmod 0644 /etc/apt/keyrings/nodesource.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
  >/etc/apt/sources.list.d/nodesource.list
printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' >/etc/apt/preferences.d/nodesource
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt_get update
apt_get install nodejs caddy
[[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || die "expected Node 24, got $(node -v)"
ok "node $(node -v), npm $(npm -v), $(caddy version | cut -d' ' -f1 | sed 's/^/caddy /')"

# ── 6. Users and directories ─────────────────────────────────────────────────────────────────────────────
step "Users and directories"
getent group "$CF_GROUP" >/dev/null || groupadd --system "$CF_GROUP"
id -u "$CF_APP_USER" &>/dev/null ||
  useradd --system --gid "$CF_GROUP" --home-dir "$CF_HOME" --no-create-home --shell /usr/sbin/nologin \
    --comment 'copyfomo web and builds' "$CF_APP_USER"
id -u "$CF_WORKER_USER" &>/dev/null ||
  useradd --system --gid "$CF_GROUP" --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin \
    --comment 'copyfomo worker (holds the seal key)' "$CF_WORKER_USER"
install -d -m 0755 -o root -g root "$CF_ROOT" "$CF_RELEASES"
# setgid + group-writable: the web (copyfomo) and the worker (copyfomo-worker) share the SQLite files.
install -d -m 2770 -o "$CF_APP_USER" -g "$CF_GROUP" "$CF_DATA"
install -d -m 0750 -o root -g "$CF_GROUP" "$CF_ETC"
install -d -m 0700 -o root -g root "$CF_BACKUPS"
install -d -m 0750 -o "$CF_APP_USER" -g "$CF_GROUP" "$CF_HOME"
ok "users $CF_APP_USER (web, builds) and $CF_WORKER_USER (worker); $CF_ROOT, $CF_DATA, $CF_ETC, $CF_BACKUPS"

# ── 7. Deploy kit → /usr/local/lib/copyfomo + copyfomo-* commands ───────────────────────────────────────
step "Deploy kit"
if [[ $SELF_DIR != "$CF_KIT" ]]; then
  cf_install_kit "$SELF_DIR"
  ok "installed to $CF_KIT (commands: $(cf_kit_commands))"
else
  ok "running from $CF_KIT"
fi

{
  echo "# copyfomo deploy settings (setup.sh). Plain KEY=value; read by the copyfomo-* commands."
  echo "DOMAIN=$DOMAIN"
  echo "EMAIL=$EMAIL"
  echo "WWW=$WWW"
  echo "REPO_URL=$REPO_URL"
  echo "BRANCH=$BRANCH"
} | cf_write_file_atomic "$CF_CONF" 0640 "root:$CF_GROUP"

# ── 8. Environment: web.env + worker.env ─────────────────────────────────────────────────────────────────
step "Environment (/etc/copyfomo)"
MANAGED_FROM_SECRETS=(WALLET_SEAL_PUBLIC_KEY WALLET_SEAL_PRIVATE_KEY SESSION_SECRET DATABASE_URL NEXT_PUBLIC_SITE_URL
  NODE_ENV TRUSTED_IP_SOURCE TRUSTED_PROXY_HOPS COPYFOMO_MODE)
is_managed() {
  local k
  for k in "${MANAGED_FROM_SECRETS[@]}"; do [[ $1 == "$k" ]] && return 0; done
  return 1
}

if [[ -f $CF_WEB_ENV ]] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?WALLET_SEAL_PRIVATE_KEY[[:space:]]*=' "$CF_WEB_ENV"; then
  die "$CF_WEB_ENV contains WALLET_SEAL_PRIVATE_KEY. It must live ONLY in $CF_WORKER_ENV. Move it there by hand (keep a copy!), then re-run."
fi

NEW_SEAL_KEYS=0
SEAL_PUB=''
existing_priv=$(cf_env_get "$CF_WORKER_ENV" WALLET_SEAL_PRIVATE_KEY)
existing_pub=$(cf_env_get "$CF_WEB_ENV" WALLET_SEAL_PUBLIC_KEY)
if [[ -n $existing_priv ]]; then
  SEAL_PUB=$(printf '%s' "$existing_priv" | cf_seal_pub_from_priv) ||
    die "WALLET_SEAL_PRIVATE_KEY in $CF_WORKER_ENV is not a usable x25519 key. Restore the file from your off-server copy."
  if [[ -n $existing_pub && $existing_pub != "$SEAL_PUB" ]]; then
    die "WALLET_SEAL_PUBLIC_KEY in $CF_WEB_ENV does not pair with the private key in $CF_WORKER_ENV. Agents are sealed to the public key: restore the matching worker.env from your off-server copy. Nothing was changed."
  fi
  chown root:root "$CF_WORKER_ENV"
  chmod 0600 "$CF_WORKER_ENV"
  ok "seal key pair kept (never rotated)"
elif [[ -n $existing_pub ]]; then
  die "$CF_WEB_ENV has WALLET_SEAL_PUBLIC_KEY but $CF_WORKER_ENV has no WALLET_SEAL_PRIVATE_KEY. Without it no agent wallet can be opened. Restore worker.env from your off-server copy (root:root 0600) and re-run. Nothing was changed."
else
  # Fail closed: a new pair is generated only when the database is known to hold no agent. Opened read-write as
  # the copyfomo user (with a busy timeout) so SQLite can recover a -wal left by a crash; a read-only connection
  # could not, and an unreadable database must never count as "no agents".
  if [[ -e $CF_DB || -L $CF_DB ]]; then
    agents=''
    has_agent=$(cf_sqlite -cmd '.timeout 10000' "$CF_DB" "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'Agent';" 2>&1 || true)
    if [[ $has_agent == 0 ]]; then
      agents=0
    elif [[ $has_agent == 1 ]]; then
      agents=$(cf_sqlite -cmd '.timeout 10000' "$CF_DB" 'SELECT count(*) FROM Agent;' 2>&1 || true)
    else
      agents=$has_agent
    fi
    if [[ ! $agents =~ ^[0-9]+$ ]]; then
      die "cannot read $CF_DB ($(head -c 200 <<<"$agents")), so it cannot be verified to hold no agents, and a new seal key pair would strand theirs. Restore $CF_WORKER_ENV and $CF_WEB_ENV from your off-server copies; or, only if this database is known to hold no agent wallet, move it aside yourself (mkdir /root/db-aside && mv $CF_DB* /root/db-aside/) and re-run. Nothing was changed."
    fi
    if ((agents > 0)); then
      die "the database holds $agents agent(s) but there is no seal key pair. A new pair could never open their wallets. Restore $CF_WORKER_ENV and $CF_WEB_ENV from your off-server copies. Nothing was changed."
    fi
  fi
  mapfile -t seal_pair < <(cf_seal_generate)
  [[ ${#seal_pair[@]} -eq 2 && ${#seal_pair[0]} -eq 44 && ${#seal_pair[1]} -eq 44 ]] || die "seal key generation failed"
  SEAL_PUB=${seal_pair[0]}
  {
    echo "# /etc/copyfomo/worker.env: copyfomo WORKER ONLY. root:root 0600; systemd reads it and passes it to"
    echo "# copyfomo-worker.service alone. Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(hostname -s)."
    echo "#"
    echo "# LOSING THIS KEY = EVERY AGENT WALLET'S FUNDS ARE UNRECOVERABLE. Copy this file OFF the server now"
    echo "# (password manager / encrypted storage, separate from the database backups). Never rotate it, never put it"
    echo "# in web.env, in git, or in a chat."
    printf 'WALLET_SEAL_PRIVATE_KEY=%s\n' "${seal_pair[1]}"
  } | cf_write_file_atomic "$CF_WORKER_ENV" 0600 root:root
  unset seal_pair
  # Read back through the same path the checks use.
  [[ $(cf_env_get "$CF_WORKER_ENV" WALLET_SEAL_PRIVATE_KEY | cf_seal_pub_from_priv) == "$SEAL_PUB" ]] || die "seal key write-back check failed"
  NEW_SEAL_KEYS=1
  ok "generated a NEW seal key pair: private key → $CF_WORKER_ENV (root-only, not printed)"
fi
unset existing_priv

SESSION_SECRET_VALUE=$(cf_env_get "$CF_WEB_ENV" SESSION_SECRET)
if [[ -z $SESSION_SECRET_VALUE ]]; then
  SESSION_SECRET_VALUE=$(cf_random_secret)
  ok "generated SESSION_SECRET (not printed)"
fi

declare -A CUR=() SEC=() SEEN=()
[[ -f $CF_WEB_ENV ]] && cf_parse_dotenv "$CF_WEB_ENV" CUR
IMPORTED=0
if [[ -f $SECRETS ]]; then
  [[ $(stat -c '%a' "$SECRETS") =~ [0-7][0-7]0$ ]] || warn "$SECRETS was readable by other users; it is deleted after the import anyway"
  cf_parse_dotenv "$SECRETS" SEC
  IMPORTED=1
else
  [[ -f $CF_WEB_ENV ]] || warn "no $SECRETS: web.env gets defaults only (no Helius/Jupiter keys, no fee wallet). Upload it and re-run setup."
fi

mode_now=${CUR[COPYFOMO_MODE]:-paper}
[[ $mode_now == paper || $mode_now == live ]] || die "COPYFOMO_MODE in $CF_WEB_ENV must be paper or live (is '$mode_now')"
declare -A FORCED=(
  [NODE_ENV]=production
  [DATABASE_URL]="file:$CF_DB"
  [NEXT_PUBLIC_SITE_URL]="https://$DOMAIN"
  [TRUSTED_IP_SOURCE]=xff
  [TRUSTED_PROXY_HOPS]=1
  [WALLET_SEAL_PUBLIC_KEY]="$SEAL_PUB"
  [SESSION_SECRET]="$SESSION_SECRET_VALUE"
  [COPYFOMO_MODE]="$mode_now"
)
# This kit supports exactly one proxy in front of the web: Caddy, which overwrites X-Forwarded-For. A different
# value (e.g. set for a CDN) is reset, loudly: with a CDN in front the rate limits would need a different setup
# that this kit does not provide (deploy/README.md §10).
for k in TRUSTED_IP_SOURCE TRUSTED_PROXY_HOPS; do
  if [[ -n ${CUR[$k]+x} && ${CUR[$k]} != "${FORCED[$k]}" ]]; then
    warn "$k was '${CUR[$k]}' in $CF_WEB_ENV: reset to '${FORCED[$k]}' (this kit supports Caddy as the only proxy; see deploy/README.md §10)"
  fi
done
for k in "${!SEC[@]}"; do
  if is_managed "$k"; then
    [[ -n ${SEC[$k]} ]] && warn "ignoring $k from $SECRETS: it is generated or managed on the server"
    unset "SEC[$k]"
  elif [[ ! $k =~ ^[A-Z][A-Z0-9_]*$ ]]; then
    warn "ignoring '$k' from $SECRETS: not an UPPER_CASE setting name"
    unset "SEC[$k]"
  elif [[ -z ${SEC[$k]} ]]; then
    unset "SEC[$k]"
  fi
done

render_web_env() {
  local line key def val re='^([A-Z_][A-Z0-9_]*)=(.*)$'
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line =~ $re ]]; then
      key=${BASH_REMATCH[1]} def=${BASH_REMATCH[2]}
      if [[ -n ${FORCED[$key]+x} ]]; then val=${FORCED[$key]}
      elif [[ -n ${SEC[$key]+x} ]]; then val=${SEC[$key]}
      elif [[ -n ${CUR[$key]+x} ]]; then val=${CUR[$key]}
      else val=$def; fi
      cf_env_value_ok "$val" || die "the value of $key has whitespace, quotes, \\, \$ or a backtick: fix it in $SECRETS or $CF_WEB_ENV"
      printf '%s=%s\n' "$key" "$val"
      SEEN[$key]=1
    else
      printf '%s\n' "${line//__DOMAIN__/$DOMAIN}"
    fi
  done <"$CF_KIT/web.env.tmpl"
  local -a extra=()
  for key in "${!SEC[@]}" "${!CUR[@]}"; do
    [[ -n ${SEEN[$key]+x} ]] && continue
    [[ $key =~ ^[A-Z][A-Z0-9_]*$ && $key != WALLET_SEAL_PRIVATE_KEY ]] || continue
    SEEN[$key]=1
    extra+=("$key")
  done
  if ((${#extra[@]})); then
    printf '\n# ── Other settings (kept across setup runs) ──────────────────────────────────────────────────────────\n'
    for key in $(printf '%s\n' "${extra[@]}" | sort); do
      if [[ -n ${SEC[$key]+x} ]]; then val=${SEC[$key]}; else val=${CUR[$key]}; fi
      cf_env_value_ok "$val" || die "the value of $key has whitespace, quotes, \\, \$ or a backtick"
      printf '%s=%s\n' "$key" "$val"
    done
  fi
}

old_env_sum=$(sha256sum "$CF_WEB_ENV" 2>/dev/null | cut -d' ' -f1 || true)
web_env_new=$(render_web_env)
printf '%s\n' "$web_env_new" | cf_write_file_atomic "$CF_WEB_ENV" 0640 "root:$CF_GROUP"
unset web_env_new SESSION_SECRET_VALUE
grep -q '^WALLET_SEAL_PRIVATE_KEY=' "$CF_WEB_ENV" && die "internal error: private key in web.env"
new_env_sum=$(sha256sum "$CF_WEB_ENV" | cut -d' ' -f1)
ENV_CHANGED=0
[[ $old_env_sum != "$new_env_sum" ]] && ENV_CHANGED=1
if ((IMPORTED)); then
  ok "imported ${#SEC[@]} setting(s) from $SECRETS: $(printf '%s\n' "${!SEC[@]}" | sort | paste -sd' ' -)"
  shred -u "$SECRETS" 2>/dev/null || rm -f "$SECRETS"
  ok "deleted $SECRETS (the values now live in $CF_WEB_ENV)"
fi
ok "$CF_WEB_ENV (root:$CF_GROUP 0640, mode=$mode_now) and $CF_WORKER_ENV (root:root 0600)"
fee_wallet=$(cf_env_get "$CF_WEB_ENV" PLATFORM_FEE_WALLET)
if [[ -n $fee_wallet ]]; then
  cf_is_solana_address "$fee_wallet" || die "PLATFORM_FEE_WALLET is not a valid Solana address: $fee_wallet"
  ok "PLATFORM_FEE_WALLET = $fee_wallet (public address: check it is yours)"
else
  warn "PLATFORM_FEE_WALLET is empty: fine for paper mode, required before going live"
fi

# ── 9. Source: root-only bare clone fetched with a read-only GitHub deploy key ───────────────────────────
step "Source code"
install -d -m 0700 /root/.ssh
install -m 0644 "$CF_KIT/github_known_hosts" "$CF_KNOWN_HOSTS"
if [[ ! -f $CF_DEPLOY_KEY ]]; then
  ssh-keygen -q -t ed25519 -N '' -C "copyfomo-deploy@$(hostname -s)" -f "$CF_DEPLOY_KEY"
  ok "generated the GitHub deploy key $CF_DEPLOY_KEY"
fi
if [[ ! -d $CF_REPO_GIT ]]; then
  git init -q --bare "$CF_REPO_GIT"
  chmod 0700 "$CF_REPO_GIT"
fi
if cf_git remote get-url origin &>/dev/null; then cf_git remote set-url origin "$REPO_URL"; else cf_git remote add origin "$REPO_URL"; fi
cf_git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
if [[ $REPO_URL == git@github.com:* ]]; then
  cf_git config core.sshCommand "ssh -i $CF_DEPLOY_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$CF_KNOWN_HOSTS -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20"
else
  cf_git config --unset core.sshCommand 2>/dev/null || true
fi

if ! fetch_err=$(cf_git fetch --prune --quiet origin 2>&1); then
  if [[ -n $GITHUB_SLUG ]] && grep -qiE 'permission denied|repository not found|could not read from remote' <<<"$fetch_err"; then
    cat <<EOF

${C_Y}The server's GitHub deploy key is not authorized for $GITHUB_SLUG yet.${C_0}
Everything before this step is done; re-running setup.sh continues from here.

Public key (safe to share: the private half never leaves $CF_DEPLOY_KEY):

    $(cat "$CF_DEPLOY_KEY.pub")

On your PC, in PowerShell or Git Bash where 'gh auth status' shows you logged in, run:

    scp -i ~/.ssh/copyfomo_deploy root@$SERVER_IP:$CF_DEPLOY_KEY.pub .
    gh repo deploy-key add copyfomo_github_deploy.pub --repo $GITHUB_SLUG --title "copyfomo-prod $(hostname -s)"

gh adds deploy keys READ-ONLY (never pass --allow-write). Then run this setup command again.
EOF
    exit 3
  fi
  printf '%s\n' "$fetch_err" >&2
  die "git fetch from $REPO_URL failed"
fi
TARGET_SHA=$(cf_resolve_ref "$BRANCH") || die "branch '$BRANCH' not found in $REPO_URL"
ok "origin/$BRANCH = ${TARGET_SHA:0:12} $(cf_git log -1 --format=%s "$TARGET_SHA" | cut -c1-72)"
if ! cf_git cat-file -e "$TARGET_SHA:deploy/lib.sh" 2>/dev/null; then
  warn "origin/$BRANCH has no deploy/ directory yet: commit and push deploy/ so copyfomo-update can keep the kit in sync"
fi

# ── 10. Build + database + services ──────────────────────────────────────────────────────────────────────
CURRENT_SHA=$(cf_current_sha)
if [[ -n $CURRENT_SHA && $CURRENT_SHA == "$TARGET_SHA" && $REBUILD == 0 && $DOMAIN == "${PREV_DOMAIN:-$DOMAIN}" ]]; then
  step "Services (already running ${CURRENT_SHA:0:12}; no rebuild)"
  cf_install_units
  if [[ $ENV_CHANGED == 1 ]] || ! systemctl is-active --quiet "$CF_WEB_UNIT"; then
    [[ $ENV_CHANGED == 1 ]] && log "web.env changed: restarting both services"
    cf_worker_stop
    cf_web_restart 90 || die "the web does not answer on $CF_WEB_URL"
    cf_worker_start 180 || die "the worker did not start cleanly"
  elif ! systemctl is-active --quiet "$CF_WORKER_UNIT"; then
    cf_worker_start 180 || die "the worker did not start cleanly"
  else
    ok "web and worker running"
  fi
else
  [[ -n $PREV_DOMAIN && $DOMAIN != "$PREV_DOMAIN" ]] && log "domain changed ($PREV_DOMAIN → $DOMAIN): rebuilding (NEXT_PUBLIC_SITE_URL is compiled in)"
  cf_deploy_sha "$TARGET_SHA" no
fi
systemctl enable --now --quiet copyfomo-backup.timer
ok "nightly backup timer: $(systemctl show -p NextElapseUSecRealtime --value copyfomo-backup.timer 2>/dev/null || echo scheduled)"

# ── 11. Caddy ────────────────────────────────────────────────────────────────────────────────────────────
step "Caddy (HTTPS for $DOMAIN)"
cf_apply_caddyfile
dns_v4=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | paste -sd' ' - || true)
local_v4=$(ip -4 -o addr show scope global 2>/dev/null | awk '{sub(/\/.*/, "", $4); print $4}' | sort -u | paste -sd' ' - || true)
if [[ -z $dns_v4 ]]; then
  warn "$DOMAIN does not resolve yet: create the DNS A record (see README). Caddy keeps retrying the certificate."
elif ! grep -qwF -f <(tr ' ' '\n' <<<"$dns_v4") <<<"$local_v4"; then
  warn "$DOMAIN resolves to $dns_v4 but this server has $local_v4: fix the A record unless a reserved/floating IP is in front"
else
  ok "$DOMAIN → $dns_v4 (this server)"
fi

# ── Done ─────────────────────────────────────────────────────────────────────────────────────────────────
step "Done"
cat <<EOF
    Site:      https://$DOMAIN  (mode: $(cf_env_get "$CF_WEB_ENV" COPYFOMO_MODE); certificate may take a minute after DNS resolves)
    Status:    copyfomo-status
    Update:    copyfomo-update            (after pushing to $BRANCH)
    Go live:   copyfomo-set-mode live     (after the checks in deploy/README.md)
    Backups:   /var/backups/copyfomo, nightly + before every update. They are on THIS disk: pull them to your
               PC daily with deploy/pull-backups.ps1 (copyfomo-offsite status shows the last verified copy).
EOF
# Repeated on every run until the operator proved an off-server copy of the CURRENT key (copyfomo-offsite).
if ! cf_offsite_key_ok; then
  if ((NEW_SEAL_KEYS)); then
    printf '\n%sACTION REQUIRED: a new seal key pair was generated. Copy it off this server NOW, and keep it forever.%s\n' "$C_Y" "$C_0"
  else
    printf '\n%sACTION REQUIRED: no off-server copy of %s is confirmed yet.%s\n' "$C_Y" "$CF_WORKER_ENV" "$C_0"
  fi
  cat <<EOF
On your PC (PowerShell):
    scp -i \$HOME\\.ssh\\copyfomo_deploy root@$SERVER_IP:$CF_WORKER_ENV \$HOME\\copyfomo-worker.env
    scp -i \$HOME\\.ssh\\copyfomo_deploy root@$SERVER_IP:$CF_WEB_ENV \$HOME\\copyfomo-web.env
Store both in a password manager / encrypted storage (not in git, not next to the DB backups), then prove the
copy is right (it is compared with the server's key, never stored or printed):
    Get-Content -Raw \$HOME\\copyfomo-worker.env | ssh -i \$HOME\\.ssh\\copyfomo_deploy root@$SERVER_IP copyfomo-offsite key-check
Once the check passes and both files are in that storage, remove loose plaintext copies from the PC.
copyfomo-set-mode live refuses until this check passes. If this server and your copy are both lost, every agent
wallet's funds are unrecoverable; a provider snapshot is not such a copy.
EOF
fi
