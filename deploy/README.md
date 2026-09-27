# copyfomo deploy kit (one Ubuntu 24.04 server)

One VPS runs everything: **Caddy** (automatic HTTPS) → **Next.js web** on `127.0.0.1:3000` + the **worker**, both
on one SQLite database. The worker holds the key that opens every agent wallet, so this is real money: read
[Keys and backups](#8-keys-and-backups-read-this) before you go live.

| Command (on the server) | What it does |
|---|---|
| `copyfomo-setup` | Provisioning, idempotent. First run: `bash /root/copyfomo-deploy/setup.sh --domain …` |
| `copyfomo-update [--ref X] [--rollback]` | Deploy the latest commit safely: build aside → backup → migrate → switch → restart |
| `copyfomo-status` | Services, health endpoints, key checks, disk, DB size, backups, off-server copies, last 50 log lines |
| `copyfomo-set-mode paper\|live` | Flip the mode (live is refused unless the fee wallet, Jupiter key and off-server copies are in place) |
| `copyfomo-backup` | Database backup now (also runs nightly and before every update) |
| `copyfomo-restore <file>` | Put a backup back (keeping the current database aside) and bring it to the running schema |
| `copyfomo-offsite key-check\|status` | Prove your off-server copy of `worker.env`; show what is safely off the server |

`copyfomo-setup`, `copyfomo-update` and `copyfomo-restore` (after its confirmation) run as a systemd service
(`copyfomo-setup`, `copyfomo-update`, `copyfomo-restore`) and your terminal only follows the log: a dropped SSH
connection or Ctrl-C never stops them halfway through a schema change. Follow one again with
`journalctl -u copyfomo-update -f -o cat`.

## What gets installed

| Path | Content | Owner, mode |
|---|---|---|
| `/opt/copyfomo/repo.git` | bare clone, fetched with a **read-only** GitHub deploy key | root, 0700 |
| `/opt/copyfomo/releases/<time>-<sha>/` | one built checkout per deployed commit (3 kept) | copyfomo, 0750 |
| `/opt/copyfomo/current`, `previous` | symlinks to the running and the previous release | root |
| `/var/lib/copyfomo/copyfomo.db` | the SQLite database (WAL) | copyfomo:copyfomo 0660, dir 2770 |
| `/etc/copyfomo/web.env` | environment of web **and** worker (no private key) | root:copyfomo 0640 |
| `/etc/copyfomo/worker.env` | `WALLET_SEAL_PRIVATE_KEY` only | **root:root 0600** |
| `/etc/copyfomo/deploy.conf` | domain, email, repo, branch | root:copyfomo 0640 |
| `/etc/copyfomo/offsite.state` | what `copyfomo-offsite` verified (public key, backup names; no secret) | root:root 0600 |
| `/var/backups/copyfomo/` | `copyfomo-<time>-<label>.db.gz` + `.sha256` | root, 0700 |
| `/usr/local/lib/copyfomo/`, `/usr/local/sbin/copyfomo-*` | this kit (the files `deploy/MANIFEST` lists) | root |
| `/etc/caddy/Caddyfile` | rendered from `Caddyfile.tmpl` | root, 0644 |
| `/root/.ssh/copyfomo_github_deploy` | GitHub deploy key | root, 0600 |

Services: `copyfomo-web` (user `copyfomo`), `copyfomo-worker` (user `copyfomo-worker`), `caddy`,
`copyfomo-backup.timer`. Firewall: only SSH, 80, 443 open; fail2ban on SSH; unattended security upgrades; 2 GB swap.

**Two service users.** The web runs as `copyfomo`, the worker as `copyfomo-worker` (both in group `copyfomo` for
the database). `worker.env` is root-only: systemd reads it and hands the key to the worker alone, so a compromised
web process can read neither the file nor the worker's environment or memory. This is what the project README asks
for ("run web and worker as different OS users"). Both units are sandboxed (read-only system, no capabilities,
syscall filter, private /tmp); the web can write only `/var/lib/copyfomo`, so it cannot change the code the worker
runs. The kit's root commands never follow a symlink there (they act through the `copyfomo` user or through
`O_NOFOLLOW` file descriptors), and builds get only `NODE_ENV`, `DATABASE_URL` and `NEXT_PUBLIC_*`, never the
provider keys. `copyfomo-status` checks all of this.

## 0. On your PC first

- `gh auth status` shows you logged in (with access to `mariomarildo666-cmd/copyfomo`), and `ssh`/`scp` work.
- The server key exists: `~/.ssh/copyfomo_deploy` (if not: `ssh-keygen -t ed25519 -f ~/.ssh/copyfomo_deploy -C copyfomo-deploy`).
- **The kit is committed and pushed** (`deploy/`, `.gitattributes`, `.gitignore`): `copyfomo-update` installs the
  kit that ships in the deployed commit, and step 4 uploads it from git.

In the commands below, `SERVER` is the server's IPv4 address. They are written for PowerShell (Windows); in Git
Bash write `~/.ssh/...` instead of `$HOME\.ssh\...`.

## 1. Create the server

- **Hetzner Cloud**: Ubuntu 24.04, 2–4 vCPU / 4 GB (e.g. CX32 or CPX21), IPv4 + IPv6, SSH key `copyfomo_deploy.pub`.
- **DigitalOcean**: Droplet, Ubuntu 24.04 x64, 2 vCPU / 4 GB, SSH key `copyfomo_deploy.pub`, tick IPv6 if you want an AAAA record.
- Provider backups/snapshots are a good extra layer, **not** an off-server copy (step 8): they live in the same
  provider account as the server.
- First login, to accept the host key: `ssh -i $HOME\.ssh\copyfomo_deploy root@SERVER`.

## 2. DNS

At the domain's DNS provider (TTL 300):

| Type | Name | Value |
|---|---|---|
| A | `@` | server IPv4 |
| A | `www` | server IPv4 |
| AAAA | `@` | server IPv6 (only if the server has one) |
| AAAA | `www` | server IPv6 (same) |

- Let's Encrypt prefers IPv6 when an AAAA record exists: never publish an AAAA the server does not answer on.
- Cloudflare: **DNS only** (grey cloud). This kit supports Caddy as the only proxy (see §10).
- No `www`? Skip those records and add `--no-www` to the setup command.
- Wait until `nslookup your-domain` returns the server IP. Setup warns if it does not; Caddy keeps retrying.

## 3. The secrets file (on your PC, Git Bash, in the repo)

```bash
bash deploy/make-secrets.sh        # reads .env, writes ~/copyfomo.secrets.env
```

It copies every setting of your `.env` **except** the ones production must not inherit from dev (seal keys,
`SESSION_SECRET`, `DATABASE_URL`, `NEXT_PUBLIC_SITE_URL`, `COPYFOMO_MODE`, …: the server generates or manages
those) and prints only setting names, plus the public values to check. `PLATFORM_FEE_WALLET` must read
`BXffVxEnMnqNfYwAb8Warkfy6hsMNSBjhTnD2MB5qCMx` (the fee wallet); `--fee-wallet <address>` overrides it.
The format is in `deploy/secrets.env.example`.

## 4. Upload and run setup

The kit is uploaded from the pushed commit (`git archive`), so the server gets exactly what `copyfomo-update` will
later install, with LF line endings whatever your checkout uses. In PowerShell, in the repo:

```powershell
git archive --format=tar -o "$HOME\copyfomo-deploy.tar" origin/main deploy
scp -i $HOME\.ssh\copyfomo_deploy "$HOME\copyfomo-deploy.tar" "$HOME\copyfomo.secrets.env" root@SERVER:/root/
ssh -i $HOME\.ssh\copyfomo_deploy root@SERVER "rm -rf /root/copyfomo-deploy && mkdir /root/copyfomo-deploy && tar -x -f /root/copyfomo-deploy.tar -C /root/copyfomo-deploy --strip-components=1 && chmod 600 /root/copyfomo.secrets.env"
ssh -t -i $HOME\.ssh\copyfomo_deploy root@SERVER "bash /root/copyfomo-deploy/setup.sh --domain YOUR-DOMAIN --email you@example.com"
```

Setup takes 5–15 minutes: packages and upgrades, swap, ufw, fail2ban, Node 24 (NodeSource), Caddy (official
repo), users and directories, `/etc/copyfomo/web.env` + `worker.env` (fresh seal key pair and `SESSION_SECRET`
generated **on the server**, never printed; `COPYFOMO_MODE=paper`), then it imports and **deletes** the secrets file.
It runs as the `copyfomo-setup` service: if the SSH connection drops it keeps going (`journalctl -u copyfomo-setup
-f -o cat` to watch again); if it fails, re-run the same command.

**The first run stops at the GitHub deploy key** (exit code 3) and prints the key plus two commands. Run them on
your PC:

```powershell
scp -i $HOME\.ssh\copyfomo_deploy root@SERVER:/root/.ssh/copyfomo_github_deploy.pub .
gh repo deploy-key add copyfomo_github_deploy.pub --repo mariomarildo666-cmd/copyfomo --title "copyfomo-prod <hostname>"
```

`gh` adds deploy keys **read-only** (never add `--allow-write`). Then run the same `setup.sh` command again. It
clones, builds as the `copyfomo` user at low priority (`npm ci`, `prisma generate`, `next build`), pushes the
schema, installs the systemd units, starts web then worker, writes the Caddyfile and starts the backup timer.

**At the end it prints "ACTION REQUIRED": copy the two env files off the server and prove it** (section 8). Setup
and `copyfomo-status` keep saying so until `copyfomo-offsite key-check` passed.

## 5. Check it

```powershell
ssh -i $HOME\.ssh\copyfomo_deploy root@SERVER copyfomo-status
```

Every line should say `ok`: web, worker, caddy, timer; `/api/config` with `"workerOnline":true`; `https://…` via
Caddy 200 with a Let's Encrypt certificate; the key checks; the off-server copies (after step 8). Then open
`https://YOUR-DOMAIN`, sign in with a wallet and create a paper agent. Live logs: `journalctl -u copyfomo-worker -f`
(web: `-u copyfomo-web`, Caddy: `-u caddy`).

## 6. Updating

Push to `main`, then:

```powershell
ssh -t -i $HOME\.ssh\copyfomo_deploy root@SERVER copyfomo-update
```

1. fetches `origin/main` and builds it in a **new** release directory at low CPU/IO priority while the site keeps
   running: a failed `npm ci` / `next build` changes nothing;
2. installs the kit and units shipped in that commit (the files its `deploy/MANIFEST` lists);
3. stops the worker gracefully (SIGTERM → it waits for in-flight swaps, up to ~3 minutes), then the web;
4. backs up the database (`pre-update`);
5. `prisma db push` with both services stopped (on SQLite a push can rebuild a table in several steps). A
   destructive schema change is **refused** (no `--accept-data-loss`): the update stops there and both services
   restart on the old code;
6. switches `current`, starts the web and waits for `/api/config`; if the new release does not answer it switches
   `current` and `previous` back and deletes the failed release;
7. starts the worker and waits for its heartbeat in the database (whatever `LOG_LEVEL` is), then keeps the last 3
   releases.

The site answers "copyfomo is restarting" during steps 4–6 (usually seconds). Copying pauses for steps 3–7. Buys
the worker misses meanwhile are not copied later (buys older than 90 s never are); sells are still copied up to
6 h late.

- `copyfomo-update --ref <sha|tag>`: deploy a specific commit. `--force`: rebuild the running commit.
- `copyfomo-update --rollback`: back to the previous release (code only; the database schema stays).

## 7. Going live

Checklist, in order:

1. The site ran in paper mode for a while and everything works (sign-in, create, copy, withdraw).
2. `PLATFORM_FEE_WALLET` = `BXffVxEnMnqNfYwAb8Warkfy6hsMNSBjhTnD2MB5qCMx`, holding **≥ 0.001 SOL** (a 0-lamport
   recipient rejects small fee sweeps).
3. `JUPITER_API_URL=https://api.jup.ag` and a `JUPITER_API_KEY` (portal.jup.ag).
4. A paid Helius plan for real traffic (`HELIUS_PLAN`, `SOLANA_RPC_URL`, `SOLANA_WS_URL`).
5. `worker.env` copied off the server **and proven** (`copyfomo-offsite key-check`), and a database backup from
   the last 48 h pulled to your PC by `deploy/pull-backups.ps1` (section 8).

```powershell
ssh -t -i $HOME\.ssh\copyfomo_deploy root@SERVER copyfomo-set-mode live      # type LIVE to confirm
```

It re-checks 2, 3 and 5 and the seal key pair (and refuses while any is missing), shows the fee wallet, backs up,
restarts worker (gracefully) and web, and **goes back to paper by itself** if the worker refuses live mode (its
FATAL message is printed). Then do a tiny real test with each wallet app you support: a live agent with the
minimum deposit (0.05 SOL), one copied trade, a withdrawal back to the wallet.

An agent's mode is fixed at creation. **Going back to paper (`copyfomo-set-mode paper`) with live agents still
running is dangerous**: a paper worker ignores live agents, so their positions are not sold and withdrawals are
not processed. Close and withdraw them first (the command warns and counts them).

## 8. Keys and backups (read this)

Two things together open every agent wallet: the **database** (sealed agent keys) and
**`WALLET_SEAL_PRIVATE_KEY`** (`/etc/copyfomo/worker.env`). Both are generated and kept on this one server, and
its backups sit on its own disk: **a lost server loses everything that was not copied off it.**

- **Lose either one and the SOL in every agent wallet is unrecoverable**, for you and for the owners.
- **Leak both and anyone can drain every agent wallet.** Store them apart.
- A provider snapshot or backup is **not** an off-server copy: it is in the same provider account as the server.

**The key: once, right after the first setup.** It never changes. Copy both env files into a password manager or
encrypted storage (not git, not a chat, not the folder with the database backups), then prove the copy is right:

```powershell
scp -i $HOME\.ssh\copyfomo_deploy root@SERVER:/etc/copyfomo/worker.env $HOME\copyfomo-worker.env
scp -i $HOME\.ssh\copyfomo_deploy root@SERVER:/etc/copyfomo/web.env $HOME\copyfomo-web.env
# store both in the password manager, then:
Get-Content -Raw $HOME\copyfomo-worker.env | ssh -i $HOME\.ssh\copyfomo_deploy root@SERVER copyfomo-offsite key-check
```

`key-check` compares what you send with the server's key (it is never stored or printed) and records that an
off-server copy of **this** key exists. To check the copy in your password manager instead, run
`ssh -t … root@SERVER copyfomo-offsite key-check` and paste the key (hidden). Once it passes and the files are in
that storage, remove loose plaintext copies from the PC. `copyfomo-set-mode live` refuses until it passed, and
`copyfomo-status` and setup keep warning.

- Never run `npm run keys:gen -- --force` on the server, never delete or regenerate `worker.env`, never paste the
  key into `web.env` (the web refuses to start with it). `setup.sh` never rotates it and refuses to create a new
  pair while the database holds agents, or when it cannot read the database to check.

**Database backups.** `copyfomo-backup` takes a consistent online snapshot (`VACUUM INTO`: one read transaction,
correct with WAL while both services keep writing), checks it (`PRAGMA quick_check`), gzips it with a `.sha256`.
It runs nightly at 03:30 UTC (`copyfomo-backup.timer`) and before every update, rollback and mode change. Backups
older than 14 days are deleted on the server, but the 7 newest are always kept.

**Pull them to your PC daily** with `deploy/pull-backups.ps1`: it downloads every backup it does not have yet,
checks each sha256, keeps them all (it never deletes anything on the PC), and records the newest verified one on
the server (`copyfomo-offsite pulled`). `copyfomo-status` and every backup warn when the newest backup that is
safely off the server is older than 26 h; `copyfomo-set-mode live` refuses above 48 h. Once by hand, then as a
daily Task Scheduler job (it runs while you are logged in; the SSH key must work without a passphrase prompt):

```powershell
ssh -i $HOME\.ssh\copyfomo_deploy root@SERVER copyfomo-backup     # right after the first setup there is none yet
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\GM\Desktop\copyfomo\deploy\pull-backups.ps1 -Server SERVER

$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\Users\GM\Desktop\copyfomo\deploy\pull-backups.ps1" -Server SERVER'
$trigger = New-ScheduledTaskTrigger -Daily -At 09:00
Register-ScheduledTask -TaskName 'copyfomo backups' -Action $action -Trigger $trigger
```

Backups land in `$HOME\copyfomo-backups` (`-Dest D:\somewhere` to change it; keep it apart from `worker.env`).

### Restore on the same server

```bash
ls -lt /var/backups/copyfomo/
copyfomo-restore /var/backups/copyfomo/copyfomo-20260101T033012Z-nightly.db.gz     # type RESTORE
```

It checks the file (sha256, gzip, `PRAGMA integrity_check`), lists agents that exist now but not in the backup
and **refuses** unless `--force` (their sealed keys would leave the running system), stops worker and web, moves
the current database to `/var/lib/copyfomo/pre-restore-<time>/` (kept, never deleted), installs the backup,
applies the **running release's schema** to it (`prisma db push`: a backup from before an update lacks the new
columns), and starts web then worker (the worker settles in-flight transactions from the chain). If the schema
push is refused, the previous database is put back. A backup from a *newer* release than the running one: deploy
that release first (`copyfomo-update --ref <sha>`), or pass `--skip-schema`.

A backup from your PC: `scp` it to `/root/` first, then `copyfomo-restore /root/<file>`. To undo a restore:
`copyfomo-restore /var/lib/copyfomo/pre-restore-<time>/copyfomo.db` (its `-wal` file is read too).

### Server lost: rebuild on a new one

1. Create the server and point DNS at it (steps 1–2).
2. **Before running setup**, put the saved env files back, so setup keeps them instead of generating a new pair:

   ```powershell
   ssh -i $HOME\.ssh\copyfomo_deploy root@NEW "install -d -m 0750 /etc/copyfomo"
   scp -i $HOME\.ssh\copyfomo_deploy $HOME\copyfomo-worker.env root@NEW:/etc/copyfomo/worker.env
   scp -i $HOME\.ssh\copyfomo_deploy $HOME\copyfomo-web.env root@NEW:/etc/copyfomo/web.env
   ssh -i $HOME\.ssh\copyfomo_deploy root@NEW "chmod 0600 /etc/copyfomo/worker.env"
   ```

3. Run setup (step 4; the new server needs its own deploy key, the old one can be deleted on GitHub).
4. Upload the newest database backup from your PC to `/root/` and `copyfomo-restore /root/<file>` (it brings the
   backup up to the schema of the release setup deployed).
5. Run `copyfomo-offsite key-check` again (the new server has no record of it) and point `pull-backups.ps1` at
   the new address.

If setup already generated a new pair on the new server, stop both services, put the saved `worker.env` in place,
set `WALLET_SEAL_PUBLIC_KEY` in `web.env` back to the saved value, then restore (only safe while no agent was
created on the new pair).

## 9. Rotating Helius or Jupiter keys

The RPC URLs contain the Helius key: rotate `HELIUS_API_KEY`, `SOLANA_RPC_URL` and `SOLANA_WS_URL` together.

- **From your PC**: write a file with only the changed lines (same format as step 3), upload it to
  `/root/copyfomo.secrets.env`, run `copyfomo-setup`. It imports the values, deletes the file and restarts both
  services (worker gracefully).
- **On the server**: `nano /etc/copyfomo/web.env` (one `KEY=value` per line, no quotes, no spaces), then
  `systemctl restart copyfomo-web copyfomo-worker`.

Then revoke the old key at the provider and check `copyfomo-status`. Never rotate `WALLET_SEAL_*`.
`SESSION_SECRET` can be rotated if it leaked (delete its line and run `copyfomo-setup`): everyone is signed out.

The GitHub deploy key: keys added with `gh` are tied to your gh login; if that token is revoked GitHub removes the
key and `copyfomo-update` fails at the fetch. Re-add it with the same `gh repo deploy-key add` command.

## 10. Notes

- **Client IPs: Caddy is the only proxy this kit supports.** Caddy is the edge and replaces any client-sent
  `X-Forwarded-For` with the real address, and the web listens on 127.0.0.1 only, hence `TRUSTED_IP_SOURCE=xff`,
  `TRUSTED_PROXY_HOPS=1`. Setup resets both to these values (with a warning if they differed), and setup and
  `copyfomo-update` re-render `/etc/caddy/Caddyfile` from `deploy/Caddyfile.tmpl` (a hand-edited copy is kept as
  `Caddyfile.local-edit.<time>` with a warning). **Do not put a CDN or proxy (Cloudflare orange cloud) in front**:
  the rate limits would see the CDN's addresses instead of the clients'. That setup needs Caddy `trusted_proxies`
  and a matching `TRUSTED_IP_SOURCE`, i.e. changes to this kit, not to the server.
- **SQLite**: the project README recommends Postgres for production. On one server with one web and one worker,
  SQLite (WAL) is fine; above ~500 tracked wallets consider Postgres.
- **OS updates**: security updates install automatically. Node and Caddy come from their own repositories:
  `apt update && apt upgrade`, then `systemctl restart copyfomo-web copyfomo-worker caddy`. Reboot when
  `/var/run/reboot-required` exists (services start by themselves).
- **Settings changes** (`web.env`): restart both services. `NEXT_PUBLIC_*` values are compiled in: change the
  domain with `copyfomo-setup --domain new.example` (it rebuilds).
- **Testing the kit** in a container or WSL: `setup.sh --skip upgrade,swap,ufw,fail2ban` skips those steps;
  `CF_NO_DETACH=1` runs setup/update/restore in the terminal instead of as a service.

## 11. Troubleshooting

| Symptom | Look at |
|---|---|
| Setup stops at the deploy key (exit 3) | step 4: add the key with `gh`, re-run |
| SSH dropped during setup/update/restore | it kept running: `journalctl -u copyfomo-setup -f -o cat` (or `copyfomo-update`, `copyfomo-restore`) |
| "copyfomo-update is already running" | one is still going: follow it with `journalctl -u copyfomo-update -f -o cat` |
| No certificate / browser TLS error | DNS (step 2); `journalctl -u caddy -n 100`; ports 80 and 443 reachable |
| Page says "copyfomo is restarting" | during an update/restore that is expected for seconds; otherwise `journalctl -u copyfomo-web -n 100` |
| `workerOnline: false` | `journalctl -u copyfomo-worker -n 200`; FATAL lines explain live-mode refusals |
| Update: "prisma db push failed" | a destructive schema change; the old release still runs. Make it additive, or migrate by hand after a backup |
| Update: build failed | the old release still runs; fix and push, then `copyfomo-update` |
| Build fails in `next/font/google` | the build downloads the Google fonts: a network hiccup; run `copyfomo-update` again |
| Build killed (out of memory) | `swapon --show` should list the 2 GB swapfile; use a 4 GB server |
| "refusing to change owner or mode" | something replaced a database file in `/var/lib/copyfomo` with a symlink/link: inspect it, do not "fix" it blindly |
| Setup: "cannot read … to verify it holds no agents" | restore `worker.env` + `web.env` from your off-server copy; never let setup generate a new pair next to a database with agents |
| Live mode refused: "no off-server copy …" | section 8: `copyfomo-offsite key-check`, `pull-backups.ps1` |
| ufw "NOT enabled" | no SSH port was confirmed listening; check `ss -ltn` and sshd, re-run setup |
