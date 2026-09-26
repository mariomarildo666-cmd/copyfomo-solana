// Wallet adapter errors → one short, human sentence. Pure (no React, no wallet imports) so it is unit-tested.

type Action = "connect" | "sign" | "transaction";

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

function innerCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const own = (err as { code?: unknown }).code;
  if (typeof own === "number") return own;
  const inner = (err as { error?: unknown }).error;
  if (typeof inner === "object" && inner !== null) {
    const code = (inner as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return null;
}

/**
 * True when the user said no in their wallet (EIP-1193 style code 4001, or the usual wording wallets use:
 * "User rejected the request", "Transaction cancelled", "Plugin closed", "Approval denied"…).
 */
export function isUserRejection(err: unknown): boolean {
  if (innerCode(err) === 4001) return true;
  const name = err instanceof Error ? err.name : "";
  if (name === "WalletWindowClosedError") return true;
  const text = `${messageOf(err)} ${messageOf((err as { error?: unknown } | null)?.error)}`;
  return /reject|denied|declin|cancel|closed|user abort/i.test(text);
}

export function walletErrorMessage(err: unknown, action: Action): string {
  if (isUserRejection(err)) {
    if (action === "connect") return "Connection request declined in your wallet.";
    if (action === "sign") return "Sign-in declined in your wallet. Nothing was sent.";
    return "You declined the transfer in your wallet. No SOL moved.";
  }
  const name = err instanceof Error ? err.name : "";
  if (name === "WalletNotReadyError") return "That wallet isn't installed in this browser.";
  if (name === "WalletNotConnectedError") return "Your wallet disconnected. Connect it again and retry.";
  if (name === "WalletTimeoutError") return "Your wallet didn't answer in time. Unlock it and retry.";
  const detail = messageOf(err).trim();
  const what = action === "connect" ? "Couldn't connect your wallet" : action === "sign" ? "Your wallet couldn't sign in" : "Your wallet couldn't sign the transfer";
  return detail ? `${what}: ${detail.slice(0, 140)}` : `${what}. Unlock it and try again.`;
}
