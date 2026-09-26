"use client";

// Wallet sign-in state for the whole app.
//
//  - `wallet` is the SIGNED-IN wallet: an HttpOnly session cookie the server set after verifying a signed
//    challenge (POST /api/auth/nonce → wallet.signMessage → POST /api/auth/verify). The root layout reads the
//    cookie, so the first render already knows it. It owns agents and receives withdrawals.
//  - `connected` is the wallet the adapter is connected to right now. It can differ (the user switched
//    accounts in the extension); signing a deposit needs both to match.
//
// Connecting through our buttons chains straight into sign-in, so "Connect" is one flow for the user.

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import bs58 from "bs58";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { SessionDTO, SignInChallengeDTO } from "@/lib/types";
import { api, ApiRequestError } from "@/components/app/api";
import { NoWalletModal } from "./NoWalletModal";
import { walletErrorMessage } from "./walletErrors";

export interface SessionState {
  /** The signed-in wallet (session cookie), or null. */
  wallet: string | null;
  /** The wallet the adapter is connected to right now, or null. */
  connected: string | null;
  /** A wallet is connected but it is not the signed-in one. */
  mismatch: boolean;
  /** Wallet Standard wallets detected in this browser (plus the mobile adapter on Android). */
  walletsAvailable: boolean;
  /** Connecting or signing in right now. */
  busy: "connecting" | "signing" | null;
  error: string | null;
  /** Bumps on every sign-in / sign-out, so owner views can refetch. */
  epoch: number;
  /** Open the wallet picker, then sign in (or sign in right away when a wallet is connected). */
  connectAndSignIn: () => void;
  /** Open the wallet picker without signing in (the session stays as it is), e.g. to sign a deposit. */
  connectWallet: () => void;
  signOut: () => Promise<void>;
  clearError: () => void;
  /** Re-read the session from the server (e.g. after a 401 from an owner route). */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

const noopSubscribe = () => () => undefined;

export function SessionProvider({
  initialWallet,
  connectError,
  onConsumeConnectError,
  children,
}: {
  initialWallet: string | null;
  /** Last wallet connection error reported by the WalletProvider (user rejected, wallet locked…). */
  connectError: unknown;
  onConsumeConnectError: () => void;
  children: ReactNode;
}) {
  const { publicKey, connected: isConnected, connecting, signMessage, disconnect, wallets } = useWallet();
  const { setVisible } = useWalletModal();
  // false on the server and while hydrating, true after: the server never sees any wallet, while a phone browser
  // can already list the Mobile Wallet Adapter on its first render (a hydration mismatch otherwise).
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  /** "Connect" was pressed with no Wallet Standard wallet installed: the install-links dialog is open. */
  const [noWallet, setNoWallet] = useState(false);
  const closeNoWallet = useCallback(() => setNoWallet(false), []);
  const [wallet, setWallet] = useState<string | null>(initialWallet);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  /** Set when the user asked to connect through us: the next connection continues into sign-in. */
  const wantSignIn = useRef(false);
  const signingRef = useRef(false);

  const connectedKey = isConnected && publicKey ? publicKey.toBase58() : null;

  const walletRef = useRef(wallet);
  useEffect(() => {
    walletRef.current = wallet;
  }, [wallet]);

  const refresh = useCallback(async () => {
    try {
      const me = await api<SessionDTO>("/api/auth/me");
      if (me.wallet !== walletRef.current) {
        setWallet(me.wallet);
        setEpoch((e) => e + 1);
      }
    } catch {
      // keep what we have; the next owner request will tell
    }
  }, []);

  const signIn = useCallback(
    async (key: string) => {
      if (signingRef.current) return;
      if (!signMessage) {
        setError("This wallet can't sign messages, so it can't sign in. Try Phantom, Solflare or Backpack.");
        return;
      }
      signingRef.current = true;
      setSigning(true);
      setError(null);
      try {
        const challenge = await api<SignInChallengeDTO>("/api/auth/nonce", { method: "POST", body: { wallet: key } });
        const signature = await signMessage(new TextEncoder().encode(challenge.message));
        const session = await api<SessionDTO>("/api/auth/verify", {
          method: "POST",
          body: { wallet: key, message: challenge.message, signature: bs58.encode(signature) },
        });
        setWallet(session.wallet);
        setEpoch((e) => e + 1);
      } catch (err) {
        setError(err instanceof ApiRequestError ? `Sign-in failed: ${err.message}` : walletErrorMessage(err, "sign"));
      } finally {
        signingRef.current = false;
        setSigning(false);
      }
    },
    [signMessage],
  );

  // A connection the user started through us continues into sign-in.
  useEffect(() => {
    if (!wantSignIn.current || !connectedKey) return;
    if (connectedKey === wallet) {
      wantSignIn.current = false; // already signed in as this wallet (reconnected to sign something)
      return;
    }
    // The wallet just connected (an external event): ask for the sign-in signature on the next tick.
    const t = setTimeout(() => {
      if (!wantSignIn.current) return;
      wantSignIn.current = false;
      void signIn(connectedKey);
    }, 0);
    return () => clearTimeout(t);
  }, [connectedKey, wallet, signIn]);

  // Surface connection failures only for connections the user started (silent auto-connects stay silent).
  useEffect(() => {
    if (!connectError) return;
    if (wantSignIn.current) {
      wantSignIn.current = false;
      setError(walletErrorMessage(connectError, "connect"));
    }
    onConsumeConnectError();
  }, [connectError, onConsumeConnectError]);

  const connectAndSignIn = useCallback(() => {
    setError(null);
    if (connectedKey) {
      if (connectedKey !== wallet) void signIn(connectedKey);
      return;
    }
    if (wallets.length === 0) {
      // The library picker has nothing to offer without an installed wallet: show install links instead.
      setNoWallet(true);
      return;
    }
    wantSignIn.current = true;
    setVisible(true);
  }, [connectedKey, wallet, wallets.length, signIn, setVisible]);

  const connectWallet = useCallback(() => {
    setError(null);
    if (connectedKey) return;
    if (wallets.length === 0) {
      setNoWallet(true);
      return;
    }
    wantSignIn.current = false;
    setVisible(true);
  }, [connectedKey, wallets.length, setVisible]);

  const signOut = useCallback(async () => {
    wantSignIn.current = false;
    setError(null);
    try {
      await api<unknown>("/api/auth/logout", { method: "POST" });
    } catch {
      // the cookie may already be gone; sign out locally regardless
    }
    setWallet(null);
    setEpoch((e) => e + 1);
    await disconnect().catch(() => undefined);
  }, [disconnect]);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<SessionState>(
    () => ({
      wallet,
      connected: connectedKey,
      mismatch: Boolean(wallet && connectedKey && wallet !== connectedKey),
      walletsAvailable: hydrated && wallets.length > 0,
      busy: signing ? "signing" : connecting ? "connecting" : null,
      error,
      epoch,
      connectAndSignIn,
      connectWallet,
      signOut,
      clearError,
      refresh,
    }),
    [wallet, connectedKey, hydrated, wallets.length, signing, connecting, error, epoch, connectAndSignIn, connectWallet, signOut, clearError, refresh],
  );

  return (
    <SessionContext.Provider value={value}>
      {children}
      <NoWalletModal open={noWallet} onClose={closeNoWallet} />
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession must be used inside <WalletProviders> (root layout)");
  return s;
}
