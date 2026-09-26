"use client";

// App settings for every client component. The root layout renders them on the server from `config` (so the
// mode shown in the first HTML is always the real one, never a "paper" placeholder), and this provider only
// polls /api/config for what changes at runtime: whether the copy engine is online.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppConfigDTO } from "@/lib/types";

/** AppConfigDTO, except workerOnline is null until the first /api/config answer. */
export type ClientConfig = Omit<AppConfigDTO, "workerOnline"> & { workerOnline: boolean | null };

const ConfigContext = createContext<ClientConfig | null>(null);

const POLL_MS = 30_000;

function isConfig(v: unknown): v is Partial<AppConfigDTO> {
  return typeof v === "object" && v !== null && (v as { mode?: unknown }).mode !== undefined;
}

export function AppConfigProvider({ initial, children }: { initial: ClientConfig; children: ReactNode }) {
  const [workerOnline, setWorkerOnline] = useState<boolean | null>(initial.workerOnline);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (document.hidden) {
        timer = setTimeout(load, POLL_MS);
        return;
      }
      try {
        const res = await fetch("/api/config", { cache: "no-store", headers: { accept: "application/json" } });
        const body: unknown = res.ok ? await res.json() : null;
        // Static settings come from the server render; only the heartbeat is taken from the poll.
        if (alive && isConfig(body) && typeof body.workerOnline === "boolean") setWorkerOnline(body.workerOnline);
      } catch {
        // keep the last known value; "…" is shown until the first answer
      }
      if (alive) timer = setTimeout(load, POLL_MS);
    };
    // A page opened in a background tab would otherwise show "…" until the next 30 s tick once it is shown.
    const onVisible = () => {
      if (document.hidden || !alive) return;
      clearTimeout(timer);
      void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const value = useMemo(() => ({ ...initial, workerOnline }), [initial, workerOnline]);
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

/** The app settings. Always defined inside the root layout. */
export function useClientConfig(): ClientConfig {
  const cfg = useContext(ConfigContext);
  if (!cfg) throw new Error("useClientConfig must be used inside <AppConfigProvider> (root layout)");
  return cfg;
}
