// HTTP helpers shared by API route handlers (json / handle / HttpError) and by the lib
// modules that call upstream services (fetchJson). No Next.js imports: the worker imports
// this file in plain Node.

import { ZodError, type ZodType, type ZodTypeDef } from "zod";
import type { ApiError } from "./types";

export class HttpError extends Error {
  status: number;
  fields?: Record<string, string>;
  headers?: Record<string, string>;

  constructor(status: number, message: string, fields?: Record<string, string>, headers?: Record<string, string>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.fields = fields;
    this.headers = headers;
  }
}

export function json<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, init);
}

/** Parse a request body as JSON; malformed JSON becomes a 400 instead of a 500. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/** Next.js signals redirect/notFound/dynamic-bailout/postpone with special errors that must propagate. */
function isFrameworkSignal(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ("digest" in err && typeof (err as { digest: unknown }).digest === "string") return true;
  if ("$$typeof" in err && (err as { $$typeof: unknown }).$$typeof === Symbol.for("react.postpone")) return true;
  if (err instanceof Error && "cause" in err && err.cause !== err) return isFrameworkSignal(err.cause);
  return false;
}

function isZodError(err: unknown): err is ZodError {
  return err instanceof ZodError || (err instanceof Error && err.name === "ZodError" && Array.isArray((err as ZodError).issues));
}

export function zodFields(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

type DefaultCtx = { params: Promise<Record<string, string>> };

/**
 * Wraps a route handler: ZodError → 400 {error:"invalid input", fields}, HttpError → its status,
 * anything else → 500 {error:"internal error"} (logged). Generic over the request/context types so
 * `ctx: RouteContext<'/api/agents/[id]'>` annotations flow through to Next's route type check.
 */
export function handle<R extends Request = Request, C = DefaultCtx>(
  fn: (req: R, ctx: C) => Promise<Response>,
): (req: R, ctx: C) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (isFrameworkSignal(err)) throw err;
      if (isZodError(err)) {
        return json<ApiError>({ error: "invalid input", fields: zodFields(err) }, { status: 400 });
      }
      if (err instanceof HttpError) {
        const body: ApiError = err.fields ? { error: err.message, fields: err.fields } : { error: err.message };
        return json<ApiError>(body, { status: err.status, headers: err.headers });
      }
      console.error(`[api] ${req.method} ${safePath(req.url)} failed:`, err);
      return json<ApiError>({ error: "internal error" }, { status: 500 });
    }
  };
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// ── Upstream calls ──────────────────────────────────────────────────────────

/** A non-2xx or unparseable response from an upstream API (Jupiter, FOMO…). */
export class UpstreamError extends Error {
  status: number | null;
  /**
   * 429 / 503 only: how long the upstream asked us to wait, from `Retry-After` (seconds or HTTP date) or Jupiter's
   * `x-ratelimit-reset` (unix seconds). null when it gave no hint.
   */
  retryAfterMs: number | null;
  constructor(message: string, status: number | null, retryAfterMs: number | null = null) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Wait hint from rate-limit headers (Retry-After, x-ratelimit-reset), capped at 5 minutes. */
export function retryAfterMsFrom(headers: Headers, now: number = Date.now()): number | null {
  const cap = (ms: number) => Math.min(Math.max(0, Math.ceil(ms)), 300_000);
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    if (/^\d+(\.\d+)?$/.test(retryAfter)) return cap(Number(retryAfter) * 1000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return cap(at - now);
  }
  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (reset && /^\d+(\.\d+)?$/.test(reset)) {
    const n = Number(reset);
    // Unix seconds (or ms) when large, else a delta in seconds.
    if (n > 1e12) return cap(n - now);
    if (n > 1e9) return cap(n * 1000 - now);
    return cap(n * 1000);
  }
  return null;
}

export interface FetchJsonOptions {
  /** Short service label for error messages, e.g. "jupiter quote". */
  label: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

function snippet(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * fetch → status check → JSON parse → zod validation. Every failure throws an UpstreamError whose
 * message carries the label, HTTP status and a short body snippet.
 */
export async function fetchJson<Out, In = Out>(
  url: string,
  schema: ZodType<Out, ZodTypeDef, In>,
  opts: FetchJsonOptions,
): Promise<{ data: Out; raw: unknown }> {
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      cache: "no-store",
    });
  } catch (err) {
    const reason = err instanceof Error ? (err.name === "TimeoutError" ? "timed out" : err.message) : String(err);
    throw new UpstreamError(`${opts.label}: request failed (${reason})`, null);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const hint = res.status === 429 || res.status === 503 ? retryAfterMsFrom(res.headers) : null;
    throw new UpstreamError(`${opts.label}: HTTP ${res.status} ${snippet(text)}`, res.status, hint);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UpstreamError(`${opts.label}: invalid JSON (HTTP ${res.status}) ${snippet(text)}`, res.status);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "unknown";
    throw new UpstreamError(`${opts.label}: unexpected response shape (${where})`, res.status);
  }
  return { data: parsed.data, raw };
}
