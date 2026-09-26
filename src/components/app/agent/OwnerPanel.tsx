"use client";

// The owner desk. Ownership is the signed-in wallet (agent.isOwner is computed by the server per request from
// the session cookie); there is no key to paste. Everyone else sees how to sign in.

import { useMemo, useState } from "react";
import type { AgentDTO } from "@/lib/types";
import { shortAddr } from "@/lib/format";
import { RobotTile } from "@/components/bots/RobotTile";
import { Icon, type IconName } from "@/components/ui/icons";
import { Panel, Pill, buttonClass, cn } from "@/components/ui/primitives";
import { useSession } from "@/components/wallet/session";
import { SignInPanel } from "@/components/wallet/WalletButton";
import { CardTitle } from "./bits";
import { ControlsSection } from "./ControlsSection";
import { makeOwnerApi } from "./ownerApi";
import { RulesSection } from "./RulesSection";
import { WithdrawSection } from "./WithdrawSection";

const TABS = [
  { id: "controls", label: "Controls", short: "Controls", icon: "bot" },
  { id: "rules", label: "Copy rules", short: "Rules", icon: "filter" },
  { id: "withdraw", label: "Withdraw", short: "Withdraw", icon: "wallet" },
] as const satisfies readonly { id: string; label: string; short: string; icon: IconName }[];
type TabId = (typeof TABS)[number]["id"];

export function OwnerPanel({
  agent,
  onAgent,
  positionsCount,
  workerOnline,
}: {
  agent: AgentDTO;
  onAgent: (a: AgentDTO) => void;
  positionsCount: number;
  workerOnline: boolean | null;
}) {
  const anchor = "scroll-mt-[calc(var(--shell-top-inset)+16px)]";
  if (!agent.isOwner) {
    // Signed out, the sign-in card is the whole section (no card-in-card); signed in as someone else, a small card.
    return (
      <section id="owner" className={anchor} aria-labelledby="owner-title">
        <OwnerGate />
      </section>
    );
  }
  return (
    <Panel id="owner" className={cn(anchor, "p-4 app:p-5")} aria-labelledby="owner-title">
      <OwnerControls agent={agent} onAgent={onAgent} positionsCount={positionsCount} workerOnline={workerOnline} />
    </Panel>
  );
}

function OwnerControls({
  agent,
  onAgent,
  positionsCount,
  workerOnline,
}: {
  agent: AgentDTO;
  onAgent: (a: AgentDTO) => void;
  positionsCount: number;
  workerOnline: boolean | null;
}) {
  const [tab, setTab] = useState<TabId>("controls");
  const session = useSession();
  const { refresh } = session;
  const ownerApi = useMemo(() => makeOwnerApi(() => void refresh()), [refresh]);

  return (
    <div>
      <CardTitle
        id="owner-title"
        meta={
          <Pill tone="mint" icon="shield" title={agent.ownerWallet ? `Owned by ${agent.ownerWallet}` : undefined}>
            <span className="font-mono text-[11.5px] font-semibold">{agent.ownerWallet ? shortAddr(agent.ownerWallet) : "owner"}</span>
          </Pill>
        }
      >
        Owner desk
      </CardTitle>

      <div role="group" aria-label="Owner sections" className="mt-4 flex gap-0.5 rounded-full border border-border bg-card-2 p-[3px]">
        {TABS.map((t) => {
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={on}
              aria-controls={`owner-${t.id}`}
              onClick={() => setTab(t.id)}
              className={cn(
                "inline-flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-[13px] font-bold transition-[background-color,color,box-shadow] duration-150 app:h-9",
                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
                on ? "bg-ink text-on-ink shadow-ink" : "text-text-2 hover:bg-card hover:text-text",
              )}
            >
              <Icon name={t.icon} size={14} strokeWidth={2.2} className="shrink-0 max-[380px]:hidden" />
              <span className="truncate sm:hidden">{t.short}</span>
              <span className="hidden truncate sm:inline">{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* All sections stay mounted so drafts and running commands survive tab switches. */}
      <div id="owner-controls" hidden={tab !== "controls"} className="mt-5">
        <ControlsSection agent={agent} ownerApi={ownerApi} onAgent={onAgent} positionsCount={positionsCount} workerOnline={workerOnline} />
      </div>
      <div id="owner-rules" hidden={tab !== "rules"} className="mt-5">
        <RulesSection agent={agent} ownerApi={ownerApi} onAgent={onAgent} />
      </div>
      <div id="owner-withdraw" hidden={tab !== "withdraw"} className="mt-5">
        <WithdrawSection agent={agent} ownerApi={ownerApi} positionsCount={positionsCount} workerOnline={workerOnline} />
      </div>
    </div>
  );
}

function OwnerGate() {
  const session = useSession();
  if (!session.wallet) {
    return (
      <div>
        <h2 id="owner-title" className="sr-only">
          Owner sign-in
        </h2>
        <SignInPanel title="Owner?" className="app:p-5">
          Sign in with the wallet that owns this agent to pause it, change its rules, top it up or withdraw.
        </SignInPanel>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-4 rounded-card border border-hairline bg-card p-4 shadow-card app:p-5">
      <RobotTile seed={session.wallet} variant="agent" size="md" tone="neutral" />
      <div className="flex min-w-0 flex-col gap-2 pt-0.5">
        <h2 id="owner-title" className="text-[17px] font-bold tracking-[-0.015em] text-text">
          Not your agent
        </h2>
        <p className="text-[13px] leading-snug text-muted">
          You&apos;re signed in as <span className="addr text-text">{shortAddr(session.wallet)}</span>, which doesn&apos;t own this
          agent. Owner controls appear for the wallet that created it.
        </p>
        <button
          type="button"
          className={buttonClass("outline", "md", "mt-1 w-fit")}
          onClick={() => void session.signOut()}
        >
          <Icon name="logout" size={14} strokeWidth={2} />
          Switch wallet
        </button>
      </div>
    </div>
  );
}
