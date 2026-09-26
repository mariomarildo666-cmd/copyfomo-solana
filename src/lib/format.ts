// Display formatting. Client + server safe (no Node APIs).

export function shortAddr(addr: string | null | undefined, head = 4, tail = 4): string {
  if (!addr) return "—";
  return addr.length <= head + tail + 1 ? addr : `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** Trader display label: @handle, else display name, else short wallet. */
export function traderLabel(t: { handle?: string | null; displayName?: string | null; wallet?: string | null }): string {
  if (t.handle) return `@${t.handle}`;
  if (t.displayName) return t.displayName;
  return shortAddr(t.wallet);
}

/**
 * SOL amounts, one rule everywhere: at least 2 decimals, more only when they carry information. `digits` is the
 * most decimals to show (2 by default; 4 where exact amounts matter: balances you can withdraw, fees, what you
 * sign), and dust below 0.01 always gets up to 4. Trailing zeros past the second decimal are dropped:
 * 5 → "5.00 SOL", 4.6593 (digits 4) → "4.6593 SOL", 0 → "0.00 SOL", 0.0012 → "0.0012 SOL".
 */
export function fmtSol(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const max = Math.max(2, abs > 0 && abs < 0.01 ? 4 : digits);
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: max })} SOL`;
}

export function fmtSignedSol(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtSol(Math.abs(n), digits)}`;
}

export function fmtUsd(n: number | null | undefined, compact = true): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(n);
  const body = compact
    ? abs.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: abs >= 1000 ? 1 : 0 })
    : abs.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return `${sign}$${body}`;
}

export function fmtSignedUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${fmtUsd(n)}`;
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}%`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function timeAgo(iso: string | Date | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function tokenLabel(symbol: string | null | undefined, mint: string): string {
  return symbol ? `$${symbol.replace(/^\$/, "")}` : shortAddr(mint);
}

export function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

export function solscanAccount(addr: string): string {
  return `https://solscan.io/account/${addr}`;
}
