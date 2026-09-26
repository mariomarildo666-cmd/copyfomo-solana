// Client-side data hook for the public /api/* endpoints (landing, floor, feed).
// Polls with setTimeout chaining (never two requests in flight), pauses while the
// tab is hidden, and keeps the last good payload when a poll fails.

import { useCallback, useEffect, useState } from "react";
import type { ApiError, FeedDTO, FloorDTO, LeaderboardDTO } from "@/lib/types";

export type Guard<T> = (v: unknown) => v is T;

export interface ApiState<T> {
  data: T | null;
  /** Last error message. Set alongside stale `data` when a poll fails. */
  error: string | null;
  /** True until the first response (success or failure) arrives. */
  loading: boolean;
  reload: () => void;
}

// ── response guards ───────────────────────────────────────────────────────
// The API owns validation; these only make sure we got the right envelope
// (and not, say, an HTML error page) before rendering it.

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isApiError(v: unknown): v is ApiError {
  return isObj(v) && typeof v.error === "string";
}

export function isFloor(v: unknown): v is FloorDTO {
  return isObj(v) && Array.isArray(v.agents) && isObj(v.stats);
}

export function isFeed(v: unknown): v is FeedDTO {
  return isObj(v) && Array.isArray(v.items);
}

export function isLeaderboard(v: unknown): v is LeaderboardDTO {
  return isObj(v) && Array.isArray(v.traders) && typeof v.source === "string";
}

async function fetchJson<T>(url: string, guard: Guard<T>, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, cache: "no-store", headers: { accept: "application/json" } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new Error(isApiError(body) ? body.error : `Request failed (HTTP ${res.status})`);
  if (!guard(body)) throw new Error("Unexpected response from the server");
  return body;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Fetch `url` once, or every `pollMs` when given. `guard` must be a stable
 * (module-level) function, otherwise the effect restarts every render.
 */
export function useApi<T>(url: string, guard: Guard<T>, pollMs?: number): ApiState<T> {
  const [state, setState] = useState<Omit<ApiState<T>, "reload">>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let stopped = false;
    let loadedOnce = false;

    const schedule = () => {
      if (!pollMs || stopped) return;
      clearTimeout(timer);
      timer = setTimeout(run, pollMs);
    };

    async function run() {
      if (stopped || inFlight) return;
      // Hidden tab: always do the first load, then stop the poll chain;
      // the visibilitychange handler restarts it.
      if (pollMs && document.hidden && loadedOnce) return;
      loadedOnce = true;
      inFlight = true;
      try {
        const data = await fetchJson(url, guard, ctrl.signal);
        if (!stopped) setState({ data, error: null, loading: false });
      } catch (err) {
        if (stopped || isAbort(err)) return;
        const message = err instanceof Error ? err.message : "Network error";
        setState((s) => ({ data: s.data, error: message, loading: false }));
      } finally {
        inFlight = false;
      }
      schedule();
    }

    const onVisibility = () => {
      if (!document.hidden && !inFlight) {
        clearTimeout(timer);
        void run();
      }
    };

    void run();
    if (pollMs) document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      ctrl.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [url, guard, pollMs, nonce]);

  return { ...state, reload };
}
