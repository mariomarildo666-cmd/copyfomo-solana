// wallets.mjs — deterministic, real-looking (random, not real) Solana wallet addresses for seed demos.
// A Solana address is 32 bytes in base58 (43–44 chars). We base58-encode 32 pseudo-random bytes, so the
// strings have the true length/alphabet distribution without pointing at anyone's actual wallet.
import { rng } from './robot.mjs';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}

/** n fake wallet addresses, stable for a given salt */
export function walletSeeds(n = 48, salt = 'copyfomo') {
  const R = rng(`wallets:${salt}`);
  return Array.from({ length: n }, () => base58(Array.from({ length: 32 }, () => Math.floor(R() * 256))));
}

export const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
