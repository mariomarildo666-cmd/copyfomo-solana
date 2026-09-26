"use client";

// Account controls: the Connect / account control of the shell (the sidebar's wallet row and the phone top bar's
// pill), and the inline sign-in block pages show where signing in matters (wizard, owner desk, "Your agents").

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { shortAddr } from "@/lib/format";
import { RobotTile } from "@/components/bots/RobotTile";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icons";
import { buttonClass } from "@/components/ui/primitives";
import { useSession } from "./session";

const INSTALL_LINKS = [
  { href: "https://phantom.com", label: "Phantom" },
  { href: "https://solflare.com", label: "Solflare" },
  { href: "https://backpack.app", label: "Backpack" },
];

function InstallHelp({ className }: { className?: string }) {
  return (
    <p className={cn("text-[12px] leading-snug text-text-2", className)}>
      Get a Solana wallet:{" "}
      {INSTALL_LINKS.map((l, i) => (
        <span key={l.href}>
          {i ? " · " : ""}
          <a
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-text underline decoration-border-strong underline-offset-2 hover:text-mint-700 hover:decoration-mint-400"
          >
            {l.label}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </span>
      ))}
    </p>
  );
}

function buttonLabel(s: ReturnType<typeof useSession>, short = false): ReactNode {
  if (s.busy === "signing") return "Check your wallet…";
  if (s.busy === "connecting") return "Connecting…";
  if (s.connected && s.connected !== s.wallet) {
    if (short) return "Sign in";
    return (
      <>
        Sign in · <span className="font-mono text-[0.95em] font-medium">{shortAddr(s.connected)}</span>
      </>
    );
  }
  if (short) {
    return (
      <>
        <span className="max-[379px]:hidden">Connect wallet</span>
        <span className="min-[380px]:hidden">Connect</span>
      </>
    );
  }
  return "Connect wallet";
}

/**
 * The shell's account control.
 *  - default: the sidebar's wallet row (robot avatar, short address, menu opening upwards). In the ≤ 1060 px
 *    icon rail it collapses to the avatar (or the wallet icon when signed out).
 *  - `compact`: the phone top bar's pill (menu opening downwards).
 */
export function WalletAccount({ compact = false }: { compact?: boolean }) {
  const s = useSession();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  if (!s.wallet) {
    return (
      <div className={cn("flex flex-col gap-1.5", compact ? "items-end" : "w-full")}>
        <button
          type="button"
          onClick={s.connectAndSignIn}
          disabled={s.busy !== null}
          aria-busy={s.busy !== null}
          className={cn(
            "flex items-center justify-center gap-2 bg-ink font-bold text-on-ink shadow-ink transition-[background-color,transform] duration-150",
            "hover:-translate-y-px hover:bg-ink-hover active:translate-y-0 disabled:pointer-events-none disabled:opacity-60",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
            // an ink pill, like every other primary button
            compact ? "h-10 whitespace-nowrap rounded-full px-[15px] text-[12.5px]" : "h-11 w-full rounded-full text-[13.5px] max-side:px-0",
          )}
        >
          {compact ? null : <Icon name="wallet" size={16} strokeWidth={2} />}
          <span className={compact ? undefined : "max-side:sr-only"}>{buttonLabel(s, compact)}</span>
        </button>
        {s.error && !compact ? (
          <p role="alert" className="px-1 text-[11.5px] leading-snug text-down max-side:sr-only">
            {s.error}
          </p>
        ) : null}
        {!compact && !s.walletsAvailable && s.error ? <InstallHelp className="px-1 max-side:sr-only" /> : null}
        {s.error && compact ? (
          <p role="alert" className="sr-only">
            {s.error}
          </p>
        ) : null}
      </div>
    );
  }

  const item =
    "flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13px] font-semibold text-text-2 transition-colors duration-150 hover:bg-card-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus";
  const label = `Wallet ${shortAddr(s.wallet)}, signed in${s.mismatch ? ", your wallet switched accounts" : ""}. Account menu`;

  return (
    <div ref={rootRef} className={cn("relative", compact ? "" : "w-full")}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center bg-card text-left text-text shadow-pill ring-1 ring-inset ring-hairline transition-shadow duration-150",
          "hover:shadow-[0_8px_18px_-10px_rgb(20_38_48/0.3)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
          compact
            ? "h-10 gap-[7px] rounded-full pl-1 pr-3 text-[12px]"
            : "w-full gap-2 rounded-[13px] py-2 pl-2 pr-2 max-side:justify-center max-side:px-0",
        )}
      >
        <RobotTile seed={s.wallet} size="2xs" shape="circle" loading="eager" />
        {compact ? (
          <span className="font-mono font-medium">{shortAddr(s.wallet)}</span>
        ) : (
          <span className="flex min-w-0 flex-1 flex-col gap-px max-side:hidden">
            <b className="truncate font-mono text-[12px] font-semibold tracking-[-0.02em]">{shortAddr(s.wallet)}</b>
            <small className="flex items-center gap-[5px] text-[11px] font-medium text-muted">
              <i aria-hidden className={cn("size-1.5 rounded-full", s.mismatch ? "bg-paper-dot" : "bg-mint-500")} />
              {s.mismatch ? "Wallet switched" : "Signed in"}
            </small>
          </span>
        )}
        {s.mismatch ? (
          <span
            aria-hidden
            className="grid size-4 shrink-0 place-items-center rounded-full bg-paper-dot text-[10px] font-extrabold text-ink max-side:absolute max-side:right-1 max-side:top-1"
            title="Your wallet switched accounts"
          >
            !
          </span>
        ) : null}
        {compact ? null : <Icon name="updown" size={15} className="shrink-0 text-icon max-side:hidden" />}
      </button>

      {open ? (
        <div
          id={menuId}
          className={cn(
            "absolute z-50 flex w-64 flex-col gap-0.5 rounded-[16px] bg-card p-2 text-text shadow-float animate-rise",
            compact ? "right-0 top-[calc(100%+8px)]" : "bottom-[calc(100%+8px)] left-0",
          )}
        >
          <p className="px-2.5 pb-1 pt-1.5 text-[12px] font-semibold text-muted">Signed in as</p>
          <p className="break-all px-2.5 pb-2 font-mono text-[11.5px] font-medium leading-snug text-text-2">{s.wallet}</p>
          {s.mismatch && s.connected ? (
            <div className="mb-1 rounded-[12px] border border-paper-border bg-paper-bg p-2.5">
              <p className="text-[12px] leading-snug text-paper-ink">
                Your wallet is now on <span className="font-mono font-medium">{shortAddr(s.connected)}</span>. Your agents belong to{" "}
                <span className="font-mono font-medium">{shortAddr(s.wallet)}</span>.
              </p>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  s.connectAndSignIn();
                }}
                className="mt-2 text-[12px] font-bold text-paper-ink underline decoration-paper-dot underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
              >
                Sign in as {shortAddr(s.connected)}
              </button>
            </div>
          ) : null}
          <Link href="/agents" className={item} onClick={() => setOpen(false)}>
            <Icon name="bot" size={16} className="text-icon" />
            Your agents
          </Link>
          <button
            type="button"
            className={item}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(s.wallet ?? "");
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            <Icon name={copied ? "check" : "copy"} size={16} className={copied ? "text-mint-700" : "text-icon"} />
            {copied ? "Copied" : "Copy address"}
            <span className="sr-only" aria-live="polite">
              {copied ? "Address copied" : ""}
            </span>
          </button>
          <button
            type="button"
            className={cn(item, "text-down hover:bg-down-bg hover:text-down")}
            onClick={() => {
              setOpen(false);
              void s.signOut();
            }}
          >
            <Icon name="logout" size={16} />
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Sign-in block (one look everywhere: a dashed card): `children` says why signing in matters here. Render it when
 * signed out. `centered`: a full-width empty state (a page whose whole content needs the wallet, e.g. /agents).
 */
export function SignInPanel({
  title = "Sign in with your wallet",
  children,
  centered = false,
  className,
}: {
  title?: string;
  children?: ReactNode;
  centered?: boolean;
  className?: string;
}) {
  const s = useSession();
  if (centered) {
    return (
      <div className={cn("flex flex-col items-center gap-3 rounded-card-sm border border-dashed border-border-strong bg-card px-5 py-10 text-center", className)}>
        <RobotTile name="minty" size="lg" tone="mint" mood={s.busy === "signing" ? "thinking" : undefined} />
        <p className="mt-1 text-[17px] font-bold tracking-[-0.015em] text-text">{title}</p>
        {children ? <div className="max-w-md text-[13.5px] leading-relaxed text-muted">{children}</div> : null}
        <button
          type="button"
          onClick={s.connectAndSignIn}
          disabled={s.busy !== null}
          aria-busy={s.busy !== null}
          className={buttonClass("ink", "md", "mt-1")}
        >
          <Icon name="wallet" size={15} strokeWidth={2} />
          {buttonLabel(s)}
        </button>
        <p className="max-w-xs text-[12px] leading-snug text-muted">
          Signing in proves you own the wallet. It sends no transaction and costs nothing.
        </p>
        {s.error ? (
          <p role="alert" className="flex items-start gap-1.5 text-[12px] font-medium leading-snug text-down">
            <Icon name="x" size={14} strokeWidth={2.4} className="mt-px" />
            {s.error}
          </p>
        ) : null}
        {!s.walletsAvailable ? <InstallHelp /> : null}
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-3 rounded-card-sm border border-dashed border-border-strong bg-card p-4", className)}>
      <div className="flex items-start gap-3">
        <RobotTile name="minty" size="md" tone="mint" mood={s.busy === "signing" ? "thinking" : undefined} />
        <div className="min-w-0 pt-1">
          <p className="text-[15px] font-bold tracking-[-0.01em] text-text">{title}</p>
          {children ? <div className="mt-1 text-[13px] leading-snug text-muted">{children}</div> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={s.connectAndSignIn}
          disabled={s.busy !== null}
          aria-busy={s.busy !== null}
          className={buttonClass("ink", "md")}
        >
          <Icon name="wallet" size={15} strokeWidth={2} />
          {buttonLabel(s)}
        </button>
        <p className="max-w-xs text-[11.5px] leading-snug text-muted">
          Signing in proves you own the wallet. It sends no transaction and costs nothing.
        </p>
      </div>
      {s.error ? (
        <p role="alert" className="flex items-start gap-1.5 text-[12px] font-medium leading-snug text-down">
          <Icon name="x" size={14} strokeWidth={2.4} className="mt-px" />
          {s.error}
        </p>
      ) : null}
      {!s.walletsAvailable ? <InstallHelp /> : null}
    </div>
  );
}
