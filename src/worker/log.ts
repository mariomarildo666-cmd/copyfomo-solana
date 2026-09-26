// Tiny leveled logger for the worker: `2026-09-26T12:00:00.000Z INFO  [watcher] msg key=value`.
// LOG_LEVEL=debug|info|warn|error (default info). Never pass secrets in `fields`.

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

const threshold = ORDER[envLevel()];

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Same scope, with extra tags on every line (e.g. agent / trader). */
  child(tags: LogFields): Logger;
}

function formatValue(v: string | number | boolean | null): string {
  if (typeof v === "string") return /[\s="]/.test(v) || v === "" ? JSON.stringify(v) : v;
  return String(v);
}

function formatFields(fields: LogFields): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function logger(scope: string, tags: LogFields = {}): Logger {
  const emit = (level: Level, msg: string, fields?: LogFields) => {
    if (ORDER[level] < threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${formatFields({ ...tags, ...fields })}`;
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (more) => logger(scope, { ...tags, ...more }),
  };
}

/** Short, single-line error text for logs and human-readable `reason` columns. */
export function errText(err: unknown, max = 180): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  const oneLine = (raw ?? "unknown error").replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** RPC URLs often carry an API key in the query string; never print it. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, "***");
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<invalid url>";
  }
}
