// Small browser hooks shared by the landing / floor / feed islands.

import { useCallback, useEffect, useState, useSyncExternalStore, type RefObject } from "react";

/** Wall clock that re-renders every `intervalMs`, so "12s ago" labels stay fresh. */
export function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Media query match; `serverValue` is used for SSR and hydration, then the real value. */
export function useMediaQuery(query: string, serverValue = false): boolean {
  // Stable per query, so React doesn't resubscribe on every render.
  const subscribe = useCallback(
    (cb: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => serverValue);
}

export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => !document.hidden,
    () => true,
  );
}

/** True while the element is (at least partly) on screen. Defaults to true before measuring. */
export function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? true));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

/** A step counter that advances every `stepMs` while `running` is true. */
export function useStepper(stepMs: number, running: boolean): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setStep((s) => s + 1), stepMs);
    return () => clearInterval(t);
  }, [stepMs, running]);
  return step;
}
