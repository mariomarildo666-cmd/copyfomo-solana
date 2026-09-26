"use client";

// SOL amount with presets, the owner's wallet balance (live) and the relevant minimum. Light cards.

import { useCallback, useEffect, useState } from "react";
import type { Mode, WalletBalanceDTO } from "@/lib/types";
import { fmtSol } from "@/lib/format";
import { Icon } from "@/components/ui/icons";
import { cn } from "@/components/ui/primitives";
import { useSession } from "@/components/wallet/session";
import { api, errorMessage } from "../api";
import { inputClass } from "../Field";
import { DEPOSIT_PRESETS, parseSol } from "./amount";

/** The signed-in wallet's SOL (GET /api/me/balance, cached 10 s server-side). Live mode only. */
export function useWalletBalance(enabled: boolean) {
  const { wallet } = useSession();
  const [state, setState] = useState<{ key: string | null; sol: number | null; error: string | null }>({
    key: null,
    sol: null,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const key = enabled && wallet ? wallet : null;

  useEffect(() => {
    if (!key) return;
    let alive = true;
    api<WalletBalanceDTO>("/api/me/balance").then(
      (b) => alive && setState({ key, sol: b.sol, error: null }),
      (err: unknown) => alive && setState((s) => ({ key, sol: s.key === key ? s.sol : null, error: errorMessage(err) })),
    );
    return () => {
      alive = false;
    };
  }, [key, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const current = state.key === key;
  return {
    sol: current ? state.sol : null,
    error: current ? state.error : null,
    loading: key !== null && !current,
    refresh,
  };
}

export function AmountPicker({
  id,
  value,
  onChange,
  mode,
  minSol,
  minLabel,
  walletSol,
  walletLoading,
  error,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  mode: Mode;
  minSol: number;
  /** e.g. "activates at" / "minimum top-up". */
  minLabel: string;
  walletSol: number | null;
  walletLoading?: boolean;
  error?: string | null;
  disabled?: boolean;
}) {
  const current = parseSol(value);
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Quick amounts" className="flex flex-wrap gap-2">
        {DEPOSIT_PRESETS.map((p) => {
          const on = current === p;
          return (
            <button
              key={p}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onChange(String(p))}
              className={cn(
                "inline-flex h-10 min-w-16 items-center justify-center gap-1 rounded-full border px-3.5 text-[13px] font-bold tabular-nums",
                "transition-[background-color,border-color,color,box-shadow] duration-150",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-45",
                on
                  ? "border-mint-300 bg-mint-50 text-mint-800 shadow-pill"
                  : "border-border bg-card text-text-2 shadow-mini hover:border-border-strong hover:text-text",
              )}
            >
              {p} <span className={cn("text-[11px] font-semibold", on ? "text-mint-700" : "text-muted")}>SOL</span>
            </button>
          );
        })}
      </div>

      <div>
        <label htmlFor={id} className="mb-1.5 block text-[12.5px] font-semibold text-text-2">
          {mode === "paper" ? "Amount (simulated SOL)" : "Amount"}
        </label>
        <div className="relative max-w-72">
          <input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className={cn(inputClass, "pr-12 font-mono")}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={`${id}-meta ${id}-error`}
          />
          <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[12px] font-semibold text-muted">SOL</span>
        </div>
      </div>

      <p id={`${id}-meta`} className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] font-medium text-muted">
        {mode === "live" ? (
          <span className="inline-flex items-center gap-1">
            <Icon name="wallet" size={13} strokeWidth={2} className="text-icon" />
            your wallet{" "}
            <span className="font-mono font-semibold text-text">{walletLoading ? "…" : walletSol === null ? "—" : fmtSol(walletSol, 4)}</span>
          </span>
        ) : (
          <span className="text-paper-ink">simulated · no SOL leaves your wallet</span>
        )}
        <span>
          {minLabel} <span className="font-mono font-semibold text-text">{fmtSol(minSol, minSol < 0.01 ? 4 : 2)}</span>
        </span>
      </p>
      {error ? (
        <p id={`${id}-error`} role="alert" className="flex items-start gap-1.5 text-[12px] font-medium leading-snug text-down">
          <Icon name="x" size={13} strokeWidth={2.6} className="mt-px shrink-0" />
          {error}
        </p>
      ) : (
        <span id={`${id}-error`} hidden />
      )}
    </div>
  );
}
