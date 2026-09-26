"use client";

import { useState } from "react";
import type { Mode } from "@/lib/types";
import { solscanAccount } from "@/lib/format";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icons";
import { buttonClass } from "@/components/ui/primitives";
import { CopyButton } from "./CopyButton";
import { Notice } from "./Field";
import { QrCode } from "./QrCode";

/** 44 px touch targets on phones, 36 px from the tablet frame up. */
const smallBtn = buttonClass("outline", "md");

/**
 * The agent wallet address.
 *  - live: the deposit address — big, copyable, scannable, linked to Solscan.
 *  - paper: the agent is funded with simulated SOL only. Real SOL sent to its wallet is never tracked and can't be
 *    withdrawn from the app, so the address is NOT presented as something to fund: a warning, no QR, no copy
 *    button, and the address itself behind a disclosure.
 */
export function DepositAddress({
  address,
  mode,
  qrOpenByDefault = false,
  size = "lg",
  idPrefix,
}: {
  address: string;
  mode: Mode;
  qrOpenByDefault?: boolean;
  size?: "md" | "lg";
  idPrefix: string;
}) {
  const [qr, setQr] = useState(qrOpenByDefault && mode === "live");
  const qrId = `${idPrefix}-qr`;

  if (mode === "paper") {
    return (
      <div className="flex flex-col gap-3">
        <Notice tone="down" title="Paper agent · do not send real SOL">
          This agent trades simulated SOL only. Real SOL sent to its wallet isn&apos;t tracked and can&apos;t be withdrawn
          from the app.
        </Notice>
        <details className="group rounded-card-sm border border-border bg-card-2 px-3.5 py-2.5">
          <summary className="-my-1 flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-btn text-[12px] font-semibold text-muted app:min-h-9 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
            <Icon name="chev-right" size={14} strokeWidth={2.2} className="transition-transform duration-150 group-open:rotate-90" />
            Show the agent&apos;s wallet address (paper · do not fund)
          </summary>
          <p className="mt-2 select-all break-all font-mono text-[12px] font-medium text-text-2">{address}</p>
          <a
            href={solscanAccount(address)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 inline-flex min-h-10 items-center gap-1 text-[12px] font-semibold text-muted underline decoration-border-strong underline-offset-2 hover:text-text focus-visible:outline-2 focus-visible:outline-focus app:min-h-8"
          >
            View on Solscan <Icon name="external" size={12} strokeWidth={2} />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </details>
      </div>
    );
  }

  return (
    <div>
      <p className="text-[11.5px] font-bold uppercase tracking-[0.08em] text-muted">Deposit address</p>
      <p
        className={cn(
          "mt-2 select-all break-all font-mono font-semibold leading-snug text-text",
          size === "lg" ? "text-[15px] sm:text-[19px]" : "text-[13.5px] sm:text-[15px]",
        )}
      >
        {address}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CopyButton text={address} label="Copy" what="deposit address" size="md" />
        <button type="button" className={smallBtn} aria-expanded={qr} aria-controls={qrId} onClick={() => setQr((v) => !v)}>
          <Icon name="qr" strokeWidth={2} /> {qr ? "Hide QR" : "QR"}
        </button>
        <a href={solscanAccount(address)} target="_blank" rel="noopener noreferrer" className={smallBtn}>
          Solscan <Icon name="external" strokeWidth={2} />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </div>
      {qr ? (
        <div id={qrId} className="mt-4">
          <QrCode value={address} label={`QR code for deposit address ${address}`} size={168} />
        </div>
      ) : null}
    </div>
  );
}
