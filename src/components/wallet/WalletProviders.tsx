"use client";

// Solana wallet plumbing for the whole app.
//  - Wallets: the empty `wallets` list means Wallet Standard auto-detection only (Phantom, Solflare, Backpack…
//    register themselves; Android browsers also get the Mobile Wallet Adapter). No per-wallet packages.
//  - No ConnectionProvider: the browser never talks to an RPC node. Deposits are built and relayed by our API.
//  - The picker is wallet-adapter-react-ui's WalletModal, restyled in globals.css (its stylesheet isn't loaded).

import { WalletProvider } from "@solana/wallet-adapter-react";
import { useWalletModal, WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import type { Adapter, WalletError } from "@solana/wallet-adapter-base";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { SessionProvider } from "./session";

/** The modal's close button is an unlabelled icon; name it for screen readers once the modal is open. */
function ModalA11y() {
  const { visible } = useWalletModal();
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      document.querySelector(".wallet-adapter-modal-button-close")?.setAttribute("aria-label", "Close wallet picker");
    }, 0);
    return () => clearTimeout(t);
  }, [visible]);
  return null;
}

export function WalletProviders({ initialWallet, children }: { initialWallet: string | null; children: ReactNode }) {
  const wallets = useMemo<Adapter[]>(() => [], []);
  const [connectError, setConnectError] = useState<unknown>(null);

  const onError = useCallback((error: WalletError) => {
    // Signing errors are handled where the signature was requested; connection errors go to the session,
    // which shows them only when the user started that connection.
    if (/Connection|NotReady|WindowClosed|WindowBlocked|Timeout|Load/.test(error.name)) setConnectError(error);
  }, []);
  const consume = useCallback(() => setConnectError(null), []);

  return (
    <WalletProvider wallets={wallets} autoConnect onError={onError} localStorageKey="copyfomo:wallet">
      <WalletModalProvider>
        <ModalA11y />
        <SessionProvider initialWallet={initialWallet} connectError={connectError} onConsumeConnectError={consume}>
          {children}
        </SessionProvider>
      </WalletModalProvider>
    </WalletProvider>
  );
}
