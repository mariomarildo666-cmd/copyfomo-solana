import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { cookies } from "next/headers";
import { LIVE_MAX_SLIPPAGE_BPS } from "@/app/api/_lib/schemas";
import { config } from "@/lib/config";
import { decodeSessionToken, sessionCookieName } from "@/lib/session";
import { AppConfigProvider, type ClientConfig } from "@/components/providers/AppConfig";
import { Shell } from "@/components/shell/Shell";
import { WalletProviders } from "@/components/wallet/WalletProviders";
import "./globals.css";

// Body: Plus Jakarta Sans (variable 200–800, with italics for the hero headline). globals.css turns its "calt"
// feature off ("0x" would render as "0×"). Mono: JetBrains Mono for addresses and numbers.
const jakarta = Plus_Jakarta_Sans({ variable: "--font-jakarta", subsets: ["latin"], style: ["normal", "italic"], display: "swap" });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], weight: ["500", "600"], display: "swap" });

export const metadata: Metadata = {
  title: {
    default: "copyfomo — copy the top of FOMO",
    template: "%s · copyfomo",
  },
  description:
    "Pick the best traders on FOMO. copyfomo spins up an agent with its own Solana wallet that mirrors their trades 1:1, the moment they land on-chain.",
};

export const viewport: Viewport = {
  themeColor: "#eef1f3",
  // the phone shell pads its fixed tab bar with env(safe-area-inset-bottom)
  viewportFit: "cover",
};

/**
 * Public settings, picked field by field (never spread `config`: it holds keys). Rendered per request (the
 * cookie read below makes every page dynamic), so the mode in the HTML is the running server's, not the
 * build machine's.
 */
function clientConfig(): ClientConfig {
  return {
    mode: config.mode,
    onchainRanking: config.heliusApiKey !== "" && config.fomoIndexer,
    copyVenue: config.copyVenue,
    workerOnline: null,
    minDepositSol: config.minDepositSol,
    paperStartSol: config.paperStartSol,
    maxTradersPerAgent: config.maxTradersPerAgent,
    platformFeeBps: config.platformFeeBps,
    maxLiveSlippageBps: LIVE_MAX_SLIPPAGE_BPS,
    // the site's X account and token: public by construction (src/lib/project.ts)
    project: config.project,
  };
}

/** The signed-in wallet from the session cookie (same check the API runs), so the first paint knows it. */
async function sessionWallet(): Promise<string | null> {
  try {
    const token = (await cookies()).get(sessionCookieName())?.value;
    return token ? decodeSessionToken(token) : null;
  } catch {
    return null;
  }
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const wallet = await sessionWallet();
  return (
    <html lang="en" className={`${jakarta.variable} ${jetbrains.variable} antialiased`}>
      <body>
        <AppConfigProvider initial={clientConfig()}>
          <WalletProviders initialWallet={wallet}>
            <Shell>{children}</Shell>
          </WalletProviders>
        </AppConfigProvider>
      </body>
    </html>
  );
}
