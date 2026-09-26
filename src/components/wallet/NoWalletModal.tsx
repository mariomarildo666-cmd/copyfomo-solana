"use client";

// The wallet picker's empty state. wallet-adapter-react-ui's WalletModal has nothing to offer when no Wallet
// Standard wallet is installed (a title and an illustration, no way forward), so "Connect wallet" opens this
// instead: same look (the .wallet-adapter-modal rules in globals.css), with install links.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { RobotTile } from "@/components/bots/RobotTile";
import { Icon } from "@/components/ui/icons";

export const WALLET_INSTALL_LINKS = [
  { href: "https://phantom.com/download", label: "Phantom" },
  { href: "https://solflare.com/download", label: "Solflare" },
  { href: "https://backpack.app/downloads", label: "Backpack" },
] as const;

export function NoWalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      // Keep focus inside the dialog.
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>("a[href], button");
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="no-wallet-title"
      aria-describedby="no-wallet-desc"
      className="wallet-adapter-modal wallet-adapter-modal-fade-in"
    >
      <div className="wallet-adapter-modal-container">
        <div className="wallet-adapter-modal-wrapper">
          <button ref={closeRef} type="button" onClick={onClose} className="wallet-adapter-modal-button-close" aria-label="Close">
            <svg width="14" height="14" aria-hidden>
              <path d="M14 12.461 8.3 6.772l5.234-5.233L12.006 0 6.772 5.234 1.54 0 0 1.539l5.234 5.233L0 12.006l1.539 1.528L6.772 8.3l5.69 5.7L14 12.461z" />
            </svg>
          </button>
          <RobotTile name="juno" size="md" tone="mint" className="mb-3" />
          <h1 id="no-wallet-title" className="wallet-adapter-modal-title">
            You&apos;ll need a Solana wallet
          </h1>
          <p id="no-wallet-desc" className="mb-4 text-[13px] leading-relaxed text-muted">
            No Solana wallet was found in this browser. Install one, then reload this page. On a phone, open copyfomo in
            your wallet app&apos;s built-in browser.
          </p>
          <ul className="wallet-adapter-modal-list">
            {WALLET_INSTALL_LINKS.map((l) => (
              <li key={l.href}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Install ${l.label} (opens in a new tab)`}
                  className="wallet-adapter-button"
                >
                  {l.label}
                  <span aria-hidden>Install ↗</span>
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-4 flex items-start gap-1.5 text-[12px] leading-snug text-muted">
            <Icon name="shield" size={14} className="mt-px shrink-0 text-mint-700" />
            Signing in only proves you own the wallet: it sends no transaction and costs nothing.
          </p>
        </div>
      </div>
      <div className="wallet-adapter-modal-overlay" onMouseDown={onClose} aria-hidden />
    </div>,
    document.body,
  );
}
