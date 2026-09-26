"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";

/** QR for a Solana address, rendered client-side as a crisp data URL on a white card. */
export function QrCode({ value, label, size = 176, className }: { value: string; label: string; size?: number; className?: string }) {
  const [img, setImg] = useState<{ value: string; url: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: size * 2,
      color: { dark: "#111416", light: "#ffffff" },
    }).then(
      (url) => alive && setImg({ value, url }),
      () => alive && setFailed(value),
    );
    return () => {
      alive = false;
    };
  }, [value, size]);

  const ready = img?.value === value ? img.url : null;
  return (
    <div
      className={cn("grid place-items-center rounded-card-sm border border-border bg-card p-2 shadow-card", className)}
      style={{ width: size + 18, height: size + 18 }}
    >
      {ready ? (
        // eslint-disable-next-line @next/next/no-img-element -- data URL, nothing to optimize
        <img src={ready} alt={label} width={size} height={size} className="pixelated" />
      ) : failed === value ? (
        <span className="px-3 text-center text-[12px] text-muted">QR unavailable — copy the address instead.</span>
      ) : (
        <span className="size-full rounded-[8px] bg-card-3 animate-blink" role="img" aria-label="Generating QR code" />
      )}
    </div>
  );
}
