"use client";

import { useCallback, useEffect, useState } from "react";
import { useClientConfig, type ClientConfig } from "@/components/providers/AppConfig";
import { api, ApiRequestError, errorMessage, isAbort } from "./api";

interface PollState<T> {
  /** URL the data belongs to — stale data from a previous URL is never shown. */
  key: string | null;
  data: T | null;
  error: ApiRequestError | null;
  /** Client clock at the last response; use it as "now" for timeAgo so renders stay pure. */
  fetchedAt: number | null;
}

export interface Polled<T> {
  data: T | null;
  error: ApiRequestError | null;
  fetchedAt: number | null;
  loading: boolean;
  refresh: () => void;
  mutate: (update: (prev: T) => T) => void;
}

/**
 * GET `url` now (even in a background tab, so a page opened behind the current one isn't left on skeletons) and
 * then every `intervalMs` while the tab is visible. Keeps the last good data on transient errors, stops polling on
 * 404, and refetches as soon as the tab becomes visible again. Pass `null` to disable.
 */
export function usePolled<T>(url: string | null, intervalMs = 5000): Polled<T> {
  const [state, setState] = useState<PollState<T>>({ key: null, data: null, error: null, fetchedAt: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight: AbortController | null = null;
    let first = true;

    const run = async () => {
      clearTimeout(timer);
      // hidden: only the first load goes out; visibilitychange resumes polling
      if (!alive || stopped || (document.hidden && !first)) return;
      first = false;
      inflight?.abort();
      const ctrl = new AbortController();
      inflight = ctrl;
      try {
        const data = await api<T>(url, { signal: ctrl.signal });
        if (alive) setState({ key: url, data, error: null, fetchedAt: Date.now() });
      } catch (err) {
        if (!alive || isAbort(err)) return;
        const e = err instanceof ApiRequestError ? err : new ApiRequestError(errorMessage(err), 0);
        if (e.status === 404) stopped = true;
        setState((s) => ({ key: url, data: s.key === url ? s.data : null, error: e, fetchedAt: Date.now() }));
      } finally {
        if (alive && !stopped && inflight === ctrl) timer = setTimeout(run, intervalMs);
      }
    };

    const onVisibility = () => {
      if (!document.hidden) void run();
    };
    timer = setTimeout(run, 0);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearTimeout(timer);
      inflight?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [url, intervalMs, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const mutate = useCallback(
    (update: (prev: T) => T) =>
      setState((s) => (s.key === url && s.data !== null ? { ...s, data: update(s.data) } : s)),
    [url],
  );

  const current = state.key === url;
  const data = current ? state.data : null;
  const error = current ? state.error : null;
  return {
    data,
    error,
    fetchedAt: current ? state.fetchedAt : null,
    loading: url !== null && data === null && error === null,
    refresh,
    mutate,
  };
}

// ── App config ─────────────────────────────────────────────────────────────

/**
 * App settings, rendered by the server in the root layout (never a client-side "paper" placeholder), plus the
 * copy engine heartbeat polled from /api/config.
 */
export function useAppConfig(): { config: ClientConfig } {
  return { config: useClientConfig() };
}
