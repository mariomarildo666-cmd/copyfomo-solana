// Sets up copyfomo's secrets without ever printing a private value:
//   npm run keys:gen
//     - WALLET_SEAL_PUBLIC_KEY  → .env         (web + worker; the web process seals new agent keys with it)
//     - WALLET_SEAL_PRIVATE_KEY → .env.worker  (worker only; Next.js never loads this file; created mode 0600)
//     - SESSION_SECRET          → .env         (web; wallet sign-in cookie HMAC), only when missing
//   npm run keys:gen -- --stdout   print the two seal-key lines instead of writing files (for a secrets manager;
//                                  never run it where the output is logged)
//   npm run keys:gen -- --force    ROTATE the seal keys. Every existing agent's sealed secret becomes unreadable:
//                                  back up the old pair first, and only do this when no live agent holds funds.
// It refuses to overwrite an existing seal key without --force.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSealKeypair } from "../src/lib/crypto";

const args = new Set(process.argv.slice(2));
const root = process.cwd();
const ENV = join(root, ".env");
const ENV_WORKER = join(root, ".env.worker");

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function currentValue(text: string, name: string): string {
  const m = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, "m"));
  if (!m) return "";
  return m[1]!.replace(/\s+#.*$/, "").trim().replace(/^"(.*)"$/, "$1");
}

/** Replace `NAME=...` (commented-out lines stay) or append it. */
function setLine(text: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const re = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return `${text}${text === "" || text.endsWith("\n") ? "" : eol}${line}${eol}`;
}

const pair = generateSealKeypair();

if (args.has("--stdout")) {
  console.log(`WALLET_SEAL_PUBLIC_KEY=${pair.publicKey}`);
  console.log(`WALLET_SEAL_PRIVATE_KEY=${pair.privateKey}`);
  console.error("\nPut the PUBLIC key on the web host and the worker, the PRIVATE key on the worker ONLY (.env.worker).");
  process.exit(0);
}

let env = read(ENV);
let worker = read(ENV_WORKER);
const force = args.has("--force");

function writeWorker(text: string): void {
  writeFileSync(ENV_WORKER, text, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(ENV_WORKER, 0o600);
  } catch {
    /* Windows: permissions are ACL-based */
  }
}

// Migrate an old setup (private key pasted into .env): move it to .env.worker, verified before .env changes.
const legacyPriv = currentValue(env, "WALLET_SEAL_PRIVATE_KEY");
if (legacyPriv && !force) {
  if (currentValue(worker, "WALLET_SEAL_PRIVATE_KEY") === "") {
    if (worker === "") worker = "# Worker-only secrets. Loaded by `npm run worker` after .env; Next.js never reads this file.\n";
    worker = setLine(worker, "WALLET_SEAL_PRIVATE_KEY", legacyPriv);
    writeWorker(worker);
  }
  if (currentValue(read(ENV_WORKER), "WALLET_SEAL_PRIVATE_KEY") === legacyPriv) {
    env = env.replace(/^\s*WALLET_SEAL_PRIVATE_KEY\s*=.*$/m, "# WALLET_SEAL_PRIVATE_KEY lives in .env.worker (worker only)");
    console.log("Moved WALLET_SEAL_PRIVATE_KEY from .env to .env.worker (the web process must never load it).");
  } else {
    console.error(".env.worker already holds a DIFFERENT private key; left .env untouched. Resolve it by hand.");
    process.exit(1);
  }
}

const hasPub = currentValue(env, "WALLET_SEAL_PUBLIC_KEY") !== "";
const hasPriv = currentValue(worker, "WALLET_SEAL_PRIVATE_KEY") !== "" || currentValue(env, "WALLET_SEAL_PRIVATE_KEY") !== "";

if ((hasPub || hasPriv) && !force) {
  console.log("Seal keys are already configured; nothing rotated (use --force to rotate, which orphans existing agents).");
} else {
  if (force && (hasPub || hasPriv)) console.warn("ROTATING seal keys: agents sealed with the old key can no longer be opened.");
  env = setLine(env, "WALLET_SEAL_PUBLIC_KEY", pair.publicKey);
  // Never leave a private key in .env (Next.js loads it into the web process and its build cache).
  env = env.replace(/^\s*WALLET_SEAL_PRIVATE_KEY\s*=.*$/m, "# WALLET_SEAL_PRIVATE_KEY lives in .env.worker (worker only)");
  if (worker === "") {
    worker =
      "# Worker-only secrets. Loaded by `npm run worker` after .env; Next.js never reads this file.\n" +
      "# Never copy it to the web host, into a Docker image or a build environment.\n";
  }
  worker = setLine(worker, "WALLET_SEAL_PRIVATE_KEY", pair.privateKey);
  writeWorker(worker);
  console.log(`WALLET_SEAL_PUBLIC_KEY=${pair.publicKey}  (written to .env)`);
  console.log("WALLET_SEAL_PRIVATE_KEY written to .env.worker (not printed). Keep that file on the worker host only.");
}

if (currentValue(env, "SESSION_SECRET") === "") {
  env = setLine(env, "SESSION_SECRET", randomBytes(32).toString("base64url"));
  console.log("SESSION_SECRET written to .env (not printed).");
}

writeFileSync(ENV, env, "utf8");
