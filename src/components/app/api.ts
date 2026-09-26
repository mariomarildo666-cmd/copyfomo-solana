// Browser-side fetch helpers for the /api/* contract (ARCHITECTURE.md).
// Every UI request goes through here so errors come back in one shape.

import type { ApiError } from "@/lib/types";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly fields?: Record<string, string>;
  /** The parsed error body, for routes that attach more than `error` (409 open command, 428 step-up). */
  readonly body: unknown;

  constructor(message: string, status: number, fields?: Record<string, string>, body: unknown = null) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.fields = fields;
    this.body = body;
  }
}

function isApiError(v: unknown): v is ApiError {
  return typeof v === "object" && v !== null && typeof (v as { error?: unknown }).error === "string";
}

function cleanFields(v: unknown): Record<string, string> | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, msg] of Object.entries(v)) if (typeof msg === "string") out[k] = msg;
  return Object.keys(out).length ? out : undefined;
}

const STATUS_FALLBACK: Record<number, string> = {
  401: "Sign in with your wallet first.",
  403: "The signed-in wallet doesn't own this agent.",
  404: "Not found.",
  429: "Slow down — too many requests. Try again in a few minutes.",
};

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Typed JSON request against our own API. The response shape is the contract in
 * src/lib/types.ts; the server owns validation, so we trust the success body.
 * Owner routes authenticate with the HttpOnly session cookie, which same-origin fetches send by default.
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiRequestError("Network error — check your connection.", 0);
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    if (isApiError(payload)) {
      throw new ApiRequestError(payload.error, res.status, cleanFields(payload.fields), payload);
    }
    throw new ApiRequestError(STATUS_FALLBACK[res.status] ?? `Request failed (HTTP ${res.status}).`, res.status);
  }
  if (payload === null) throw new ApiRequestError("Empty response from server.", res.status);
  return payload as T;
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * The server's message, plus the field-level reasons when it only said "invalid input" (zod 400s), so the
 * user sees "at least 0.0001 SOL" instead of a bare "invalid input".
 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const reasons = err.fields ? Object.values(err.fields).filter(Boolean) : [];
    if (reasons.length && /^invalid input$/i.test(err.message.trim())) return reasons.join(" · ");
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
