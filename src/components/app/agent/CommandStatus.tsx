"use client";

import type { CommandDTO } from "@/lib/types";
import { solscanTx, timeAgo } from "@/lib/format";
import { Icon } from "@/components/ui/icons";
import { Pill, cn } from "@/components/ui/primitives";
import { describeResult } from "./commandResult";

const LABEL: Record<CommandDTO["status"], { text: string; tone: "warn" | "info" | "up" | "down" }> = {
  pending: { text: "Queued", tone: "warn" },
  running: { text: "Running", tone: "info" },
  done: { text: "Done", tone: "up" },
  failed: { text: "Failed", tone: "down" },
};

export function CommandStatusView({
  command,
  pollError,
  workerOnline,
  title,
}: {
  command: CommandDTO;
  pollError: string | null;
  workerOnline: boolean | null;
  title: string;
}) {
  const { lines, errors, signatures, problems, pendingOnChain } = describeResult(command.result);
  // A transfer that was sent but not confirmed yet is settled by the worker from the chain: not a failure.
  const confirming = command.status === "failed" && pendingOnChain;
  const open = command.status === "pending" || command.status === "running" || confirming;
  // "Done" only when everything asked for happened; otherwise say so in amber (never a plain green Done).
  const partial = command.status === "done" && problems.length > 0;
  const s = confirming
    ? { text: "Sent — confirming", tone: "info" as const }
    : partial
      ? { text: "Done with problems", tone: "warn" as const }
      : LABEL[command.status];
  return (
    <div
      role="status"
      className={cn(
        "rounded-card-sm border p-3.5",
        command.status === "failed" && !confirming
          ? "border-down/30 bg-down-bg"
          : partial
            ? "border-paper-border bg-paper-bg"
            : command.status === "done"
              ? "border-up/25 bg-up-bg"
              : "border-border bg-card",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13.5px] font-bold text-text">{title}</p>
        <Pill tone={s.tone} dot={open}>
          {s.text}
        </Pill>
      </div>
      <p className="mt-1 text-[11.5px] font-medium text-muted">
        queued {timeAgo(command.createdAt)}
        {command.doneAt ? ` · finished ${timeAgo(command.doneAt)}` : ""}
      </p>
      {confirming ? (
        <p className="mt-2 text-[12.5px] leading-snug text-text-2">
          The transfer was sent and is still confirming on-chain. The copy engine settles it from the chain and updates
          this within minutes — don&apos;t send another one yet.
        </p>
      ) : open ? (
        <p className="mt-2 text-[12.5px] leading-snug text-text-2">
          The copy engine picks this up within a few seconds{workerOnline === false ? " — but it looks offline right now, so this waits until it's back" : ""}.
        </p>
      ) : null}
      {problems.length ? (
        <ul className="mt-2 space-y-1 text-[13px] font-medium leading-snug text-warn">
          {problems.map((p) => (
            <li key={p} className="flex gap-1.5">
              <Icon name="alert" size={14} strokeWidth={2.2} className="mt-0.5 shrink-0" />
              {p}
            </li>
          ))}
          {partial ? (
            <li className="text-[12px] font-normal text-muted">Check the positions below, then try again or close them from Controls.</li>
          ) : null}
        </ul>
      ) : null}
      {errors.length ? (
        <ul className="mt-2 space-y-0.5 font-mono text-[11.5px] text-down" aria-label="Errors">
          {errors.map((e, i) => (
            <li key={i} className="flex gap-1.5 break-words">
              <Icon name="x" size={12} strokeWidth={2.6} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{e}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {lines.length ? (
        <ul className="mt-2 space-y-0.5 font-mono text-[11.5px] text-text-2">
          {lines.map((l, i) => (
            <li key={i} className="break-words">
              {l}
            </li>
          ))}
        </ul>
      ) : null}
      {signatures.length ? (
        <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {signatures.map((sig) => (
            <a
              key={sig}
              href={solscanTx(sig)}
              target="_blank"
              rel="noopener noreferrer"
              className="relative inline-flex items-center gap-1 font-mono text-[11.5px] font-medium text-mint-700 underline after:absolute after:inset-x-0 after:-inset-y-3 decoration-mint-300 underline-offset-2"
            >
              {sig.slice(0, 8)}…
              <Icon name="external" size={11} strokeWidth={2.2} />
              <span className="sr-only"> (Solscan, opens in a new tab)</span>
            </a>
          ))}
        </p>
      ) : null}
      {pollError ? <p className="mt-2 text-[11.5px] font-medium text-warn">Status check failed ({pollError}). Retrying…</p> : null}
    </div>
  );
}
