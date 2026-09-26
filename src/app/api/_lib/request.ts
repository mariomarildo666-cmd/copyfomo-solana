// Request plumbing shared by every /api route: dynamic-rendering opt-out, JSON body / query parsing
// and no-store JSON responses. Validation errors surface as ZodError, which `handle()` maps to 400.

import { connection, type NextRequest } from "next/server";
import type { ZodType, ZodTypeDef } from "zod";
import { handle, HttpError, json } from "@/lib/http";
import { isValidSolanaAddress } from "@/lib/solana";

/** Our bodies are a few hundred bytes (a signed deposit transaction is < 2 KB); anything near this is abuse. */
export const MAX_BODY_BYTES = 32 * 1024;

type DefaultCtx = { params: Promise<Record<string, string>> };

/**
 * `handle()` for GET handlers. `connection()` keeps Next from prerendering a GET at build time
 * (e.g. /api/config reads nothing from the request), with or without Cache Components.
 */
export function getHandler<C = DefaultCtx>(
  fn: (req: NextRequest, ctx: C) => Promise<Response>,
): (req: NextRequest, ctx: C) => Promise<Response> {
  return handle<NextRequest, C>(async (req, ctx) => {
    await markDynamic();
    return fn(req, ctx);
  });
}

/**
 * `connection()`, except when there is no Next.js request scope at all (a handler called from plain Node, e.g.
 * the route tests): Next throws E251 there, and there is nothing to prerender anyway.
 */
async function markDynamic(): Promise<void> {
  try {
    await connection();
  } catch (err) {
    if ((err as { __NEXT_ERROR_CODE?: unknown } | null)?.__NEXT_ERROR_CODE === "E251") return;
    throw err;
  }
}

/** JSON response that no browser, proxy or CDN may cache (sessions, balances, live state). */
export function ok<T>(data: T, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return json<T>(data, { status, headers: { "cache-control": "no-store", ...extraHeaders } });
}

/** `ok()` plus one Set-Cookie header (session sign-in / sign-out). */
export function okWithCookie<T>(data: T, setCookie: string, status = 200): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("set-cookie", setCookie);
  return json<T>(data, { status, headers });
}

/**
 * Public, identical-for-everyone JSON a shared cache (CDN) may keep for `sMaxAge` seconds and serve stale
 * for `swr` more while it refetches. Only for data with no per-user or secret content (the leaderboard).
 */
export function okShared<T>(data: T, sMaxAge: number, swr: number): Response {
  return json<T>(data, {
    status: 200,
    headers: { "cache-control": `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}` },
  });
}

const tooLarge = () => new HttpError(413, "request body too large");

/**
 * Read the body as UTF-8 text, never buffering more than `max` bytes (finding F28). A declared
 * content-length above the cap is refused before reading; a chunked body (no content-length) is read chunk by
 * chunk and the stream is cancelled on the first byte past the cap. Invalid UTF-8 is a 400.
 */
export async function readBodyText(req: Request, max = MAX_BODY_BYTES): Promise<string> {
  const declaredRaw = req.headers.get("content-length");
  if (declaredRaw !== null) {
    const declared = Number(declaredRaw);
    if (Number.isFinite(declared) && declared > max) throw tooLarge();
  }
  const body = req.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel("request body too large").catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "could not read request body");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released / cancelled */
    }
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "request body is not valid UTF-8");
  }
}

/**
 * Read and validate a JSON body. Requires `content-type: application/json` whenever a body is
 * present, so cross-site "simple" form posts can't reach our handlers without a CORS preflight.
 * `optional`: an empty body parses as `{}` (for endpoints like close-all that take no input).
 * The body is capped at MAX_BODY_BYTES while it streams in (never buffered past the cap).
 */
export async function parseBody<Out, In = Out>(
  req: Request,
  schema: ZodType<Out, ZodTypeDef, In>,
  opts: { optional?: boolean } = {},
): Promise<Out> {
  const text = await readBodyText(req);

  if (text.trim() === "") {
    if (opts.optional) return schema.parse({});
    throw new HttpError(400, "request body is required");
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType.trim())) {
    throw new HttpError(415, "content-type must be application/json");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  return schema.parse(raw);
}

/** Validate the query string. Repeated keys keep the last value; empty values count as absent. */
export function parseQuery<Out, In = Out>(req: NextRequest, schema: ZodType<Out, ZodTypeDef, In>): Out {
  const raw: Record<string, string> = {};
  for (const [key, value] of req.nextUrl.searchParams) {
    if (value.trim() === "") delete raw[key];
    else raw[key] = value;
  }
  return schema.parse(raw);
}

/** Route params are free text from the URL; anything that can't be an id or slug is simply not found. */
export function agentRef(id: string): string {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(id)) throw new HttpError(404, "agent not found");
  return id;
}

/** A trader route param: a base58 Solana address, else not found (never echoed back). */
export function walletRef(wallet: string): string {
  const w = wallet.trim();
  if (!isValidSolanaAddress(w)) throw new HttpError(404, "trader not found");
  return w;
}

/**
 * Run an upstream call (Solana RPC / Helius) for a route: HttpErrors pass through, anything else (network,
 * rate limit, throttled budget) becomes a 503 with `message`, logged without URLs.
 */
export async function upstream<T>(what: string, message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.warn(`[api] ${what} failed: ${err instanceof Error ? err.name : "error"}`);
    throw new HttpError(503, message, undefined, { "retry-after": "5" });
  }
}
