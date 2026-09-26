// Run: npx tsx --test src/app/api/_lib/request.test.ts
// Body parsing limits (finding F28): a chunked body without content-length must never be buffered past the cap.
import "../../../lib/__testing__/env"; // first: keeps the real .env (keys, RPC URLs) out of this test
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

type Request_ = typeof import("./request");
let r: Request_;
let HttpError: typeof import("@/lib/http").HttpError;
let MAX_DEPOSIT_SOL_LIB: number;
let MAX_DEPOSIT_SOL_API: number;

before(async () => {
  r = await import("./request");
  ({ HttpError } = await import("@/lib/http"));
  ({ MAX_DEPOSIT_SOL: MAX_DEPOSIT_SOL_LIB } = await import("@/lib/deposit"));
  ({ MAX_DEPOSIT_SOL: MAX_DEPOSIT_SOL_API } = await import("./schemas"));
});

function isHttp(status: number) {
  return (err: unknown) => {
    assert.ok(err instanceof HttpError, `expected HttpError, got ${String(err)}`);
    assert.equal(err.status, status);
    return true;
  };
}

/** A streamed (chunked, no content-length) body of `total` bytes in 1 KB chunks that counts what was pulled. */
function streamingRequest(total: number, headers: Record<string, string> = { "content-type": "application/json" }) {
  const chunk = new Uint8Array(1024).fill(0x20);
  const counter = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (counter.pulled >= total) {
        controller.close();
        return;
      }
      counter.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      counter.cancelled = true;
    },
  }, { highWaterMark: 0 }); // pull only when read

  const req = new Request("http://localhost/api/x", { method: "POST", headers, body, duplex: "half" } as RequestInit);
  return { req, counter };
}

test("F28: a chunked body over the cap is refused with 413 while streaming, without reading it all", async () => {
  const { req, counter } = streamingRequest(10 * 1024 * 1024);
  assert.equal(req.headers.get("content-length"), null);
  await assert.rejects(r.parseBody(req, z.object({}).passthrough()), isHttp(413));
  // Stopped at the first chunk past 32 KB (Request may buffer a chunk or two of its own).
  assert.ok(counter.pulled <= r.MAX_BODY_BYTES + 4 * 1024, `pulled ${counter.pulled} bytes`);
  assert.equal(counter.cancelled, true);
});

test("F28: a declared content-length over the cap is refused before reading anything", async () => {
  const { req, counter } = streamingRequest(64 * 1024, { "content-type": "application/json", "content-length": String(64 * 1024) });
  await assert.rejects(r.readBodyText(req), isHttp(413));
  assert.equal(counter.pulled, 0);
});

test("parseBody: JSON under the cap parses; empty optional body is {}; wrong type 415; bad UTF-8 400", async () => {
  const schema = z.object({ a: z.number() }).strict();
  const okReq = new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
  assert.deepEqual(await r.parseBody(okReq, schema), { a: 1 });

  const empty = new Request("http://localhost/x", { method: "POST" });
  assert.deepEqual(await r.parseBody(empty, z.object({}).strict(), { optional: true }), {});
  await assert.rejects(r.parseBody(new Request("http://localhost/x", { method: "POST" }), schema), isHttp(400));

  const form = new Request("http://localhost/x", { method: "POST", headers: { "content-type": "text/plain" }, body: '{"a":1}' });
  await assert.rejects(r.parseBody(form, schema), isHttp(415));

  const badUtf8 = new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
  });
  await assert.rejects(r.parseBody(badUtf8, schema), isHttp(400));

  // Exactly at the cap is fine (bytes, not UTF-16 units: 3-byte characters count 3).
  const atCap = JSON.stringify({ s: "€".repeat(Math.floor((r.MAX_BODY_BYTES - 8) / 3)) });
  assert.ok(Buffer.byteLength(atCap) <= r.MAX_BODY_BYTES);
  const big = new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: atCap });
  assert.equal(typeof (await r.parseBody(big, z.object({ s: z.string() }))).s, "string");
  const over = new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ s: "€".repeat(Math.ceil(r.MAX_BODY_BYTES / 3)) }),
  });
  await assert.rejects(r.parseBody(over, z.object({ s: z.string() })), isHttp(413));
});

test("upstream(): non-HTTP failures become 503, HttpErrors pass through", async () => {
  await assert.rejects(
    r.upstream("x", "try later", async () => {
      throw new Error("ECONNREFUSED https://mainnet.helius-rpc.com/?api-key=secret");
    }),
    (err: unknown) => err instanceof HttpError && err.status === 503 && !err.message.includes("api-key"),
  );
  await assert.rejects(
    r.upstream("x", "try later", async () => {
      throw new HttpError(409, "conflict");
    }),
    isHttp(409),
  );
});

test("schemas: the live deposit ceiling matches lib/deposit", () => {
  assert.equal(MAX_DEPOSIT_SOL_API, MAX_DEPOSIT_SOL_LIB);
});
