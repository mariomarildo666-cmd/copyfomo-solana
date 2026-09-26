// Command.result → what the owner reads. The worker writes free-form JSON (`{ ok, … }`) with nested summaries:
//   withdraw:  { ok, mode, amountSol, to, signature, closed: { sold, failed, errors[] }, rent: { … }, stopped?, positionsLeft? }
//   close_all: { ok | error, sold, failed, errors[], rent: { … } }
// Nested objects are flattened ("closed failed: 2"), error strings are listed one by one, and anything that means
// "finished, but not everything you asked for happened" becomes a problem so the UI never shows a plain green
// "Done" for it (finding F38). Pure: unit-tested.

import { fmtSol } from "@/lib/format";

export interface ResultView {
  lines: string[];
  /** Individual error strings ("BONK: no route"). */
  errors: string[];
  /** Real transaction signatures to link. */
  signatures: string[];
  /** Done, but not as asked: positions left unsold, agent still copying, less sent than asked. */
  problems: string[];
  /**
   * A live transfer was broadcast but its confirmation is still open ({ ok: false, pending: true }): the worker
   * settles it from the chain and updates the command. Not a failure; the owner must not retry yet.
   */
  pendingOnChain: boolean;
}

/** Keys holding one or more transaction signatures. */
const SIG_KEY = /(signature|signatures|sig|sigs|txid|txids|tx|txs)$/i;
/** Keys whose number is an amount of SOL ("amountSol", "reclaimedSol") — not "sold" (a count). */
const SOL_KEY = /(^sol$|Sol$|_sol$)/;
/** Keys that are listed as errors. */
const ERROR_KEY = /^(error|errors)$/i;

const looksLikeSig = (s: unknown): s is string => typeof s === "string" && s.length >= 64 && !s.startsWith("paper_");

function humanize(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function walk(obj: Record<string, unknown>, prefix: string, out: ResultView, depth: number): void {
  for (const [k, val] of Object.entries(obj)) {
    if (!prefix && k === "ok") continue; // the status pill already says it
    const label = prefix ? `${prefix} ${humanize(k)}` : humanize(k);

    if (SIG_KEY.test(k)) {
      const list = Array.isArray(val) ? val : [val];
      const sigs = list.filter(looksLikeSig);
      if (sigs.length) {
        out.signatures.push(...sigs);
        continue;
      }
    }
    if (ERROR_KEY.test(k)) {
      const list = Array.isArray(val) ? val : [val];
      const texts = list.filter((e): e is string => typeof e === "string" && e.trim() !== "");
      out.errors.push(...texts.map((t) => (prefix ? `${prefix}: ${t}` : t)));
      if (texts.length || Array.isArray(val)) continue;
    }

    if (typeof val === "number") {
      out.lines.push(`${label}: ${SOL_KEY.test(k) ? fmtSol(val, 4) : val.toLocaleString("en-US")}`);
    } else if (typeof val === "string" || typeof val === "boolean") {
      out.lines.push(`${label}: ${String(val)}`);
    } else if (Array.isArray(val)) {
      out.lines.push(`${label}: ${val.length}`);
    } else if (isPlainObject(val) && depth < 3) {
      walk(val, label, out, depth + 1);
    }
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function describeResult(raw: string | null): ResultView {
  const out: ResultView = { lines: [], errors: [], signatures: [], problems: [], pendingOnChain: false };
  if (!raw) return out;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    out.lines.push(raw);
    return out;
  }
  if (!isPlainObject(v)) {
    out.lines.push(String(v));
    return out;
  }
  walk(v, "", out, 0);

  // Problems: finished, but not everything happened.
  const closed = isPlainObject(v.closed) ? v.closed : null;
  const unsold = num(closed?.failed) ?? (closed ? null : num(v.failed));
  if (unsold !== null && unsold > 0) out.problems.push(`${plural(unsold, "position")} could not be sold and ${unsold === 1 ? "is" : "are"} still open.`);
  const left = num(v.positionsLeft);
  if (left !== null && left > 0 && !(unsold !== null && unsold > 0)) out.problems.push(`${plural(left, "position")} still open.`);
  if (v.stopped === false) out.problems.push("The agent was not stopped: it keeps copying.");
  const requested = num(v.requestedSol);
  const sent = num(v.amountSol);
  if (v.clamped === true && requested !== null && sent !== null) {
    out.problems.push(`Sent ${fmtSol(sent, 4)} instead of the ${fmtSol(requested, 4)} asked: that is all the sale left.`);
  }
  out.pendingOnChain = v.ok === false && v.pending === true;
  // Its "error" only says it is still confirming: the status view explains that instead of a red error.
  if (out.pendingOnChain) out.errors = [];
  return out;
}
