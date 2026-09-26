"use client";

import { useState } from "react";
import type { AgentDTO, CommandDTO } from "@/lib/types";
import { Icon } from "@/components/ui/icons";
import { Button, buttonClass } from "@/components/ui/primitives";
import { errorMessage } from "../api";
import { FieldError } from "../Field";
import { CommandStatusView } from "./CommandStatus";
import { agentPath, conflictCommand, isOpen, useCommand, type OwnerApi } from "./ownerApi";

function SectionTitle({ children }: { children: string }) {
  return <h3 className="text-[11.5px] font-bold uppercase tracking-[0.08em] text-muted">{children}</h3>;
}

export function ControlsSection({
  agent,
  ownerApi,
  onAgent,
  positionsCount,
  workerOnline,
}: {
  agent: AgentDTO;
  ownerApi: OwnerApi;
  onAgent: (a: AgentDTO) => void;
  positionsCount: number;
  workerOnline: boolean | null;
}) {
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const close = useCommand(agent.id, ownerApi, "close_all");
  const closing = close.command !== null && isOpen(close.command.status);

  const canToggle = agent.status === "active" || agent.status === "paused";
  const active = agent.status === "active";

  async function toggle() {
    const status = agent.status === "active" ? "paused" : "active";
    setToggleBusy(true);
    setToggleError(null);
    try {
      const res = await ownerApi<{ agent: AgentDTO }>(agentPath(agent.id), { method: "PATCH", body: { status } });
      onAgent(res.agent);
    } catch (err) {
      setToggleError(errorMessage(err));
    } finally {
      setToggleBusy(false);
    }
  }

  async function closeAll() {
    setCloseBusy(true);
    setCloseError(null);
    try {
      const res = await ownerApi<{ command: CommandDTO }>(agentPath(agent.id, "/close-all"), { method: "POST" });
      close.setCommand(res.command);
      setConfirmClose(false);
    } catch (err) {
      const open = conflictCommand(err);
      if (open) {
        // One is already running (another tab or device): follow that one instead.
        close.setCommand(open);
        setConfirmClose(false);
      } else {
        setCloseError(errorMessage(err));
      }
    } finally {
      setCloseBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-card-sm border border-border bg-card-2 p-3.5">
        <SectionTitle>Copying</SectionTitle>
        {canToggle ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
            <Button
              variant={active ? "outline" : "ink"}
              icon={active ? "pause" : "play"}
              onClick={toggle}
              disabled={toggleBusy}
              aria-busy={toggleBusy}
            >
              {active ? "Pause copying" : "Resume copying"}
            </Button>
            <p className="min-w-0 flex-1 basis-56 text-[12.5px] leading-snug text-muted">
              {active ? "Paused agents keep their positions but ignore new trades." : "Paused. New trades are ignored until you resume."}
            </p>
          </div>
        ) : (
          <p className="text-[13px] leading-snug text-muted">
            {agent.status === "awaiting_deposit"
              ? "Fund the agent first (Top up, in the balance card). Pause and resume unlock once it's active."
              : "This agent is stopped for good. Build a new one to copy again."}
          </p>
        )}
        <FieldError>{toggleError}</FieldError>
      </section>

      <section className="flex flex-col gap-3 rounded-card-sm border border-border bg-card-2 p-3.5">
        <SectionTitle>Close all positions</SectionTitle>
        <p className="text-[12.5px] leading-snug text-muted">
          Sells every open position into SOL at market, right now. SOL stays in the agent wallet.
        </p>
        {confirmClose ? (
          <div className="flex flex-col gap-3 rounded-card-sm border border-down/30 bg-down-bg p-3.5">
            <p className="flex items-start gap-2 text-[13px] font-semibold text-text">
              <Icon name="alert" size={16} strokeWidth={2} className="mt-px shrink-0 text-down" />
              <span>
                Sell all {positionsCount} position{positionsCount === 1 ? "" : "s"} now? This can&apos;t be undone.
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" onClick={closeAll} disabled={closeBusy} aria-busy={closeBusy}>
                {closeBusy ? "Sending…" : "Yes, close all"}
              </Button>
              <button type="button" className={buttonClass("ghost")} onClick={() => setConfirmClose(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className={buttonClass("danger-soft", "md", "w-fit")}
            onClick={() => setConfirmClose(true)}
            disabled={positionsCount === 0 || closing}
          >
            {positionsCount === 0 ? "No open positions" : closing ? "Closing…" : "Close all positions"}
          </button>
        )}
        <FieldError>{closeError}</FieldError>
        {close.command ? (
          <CommandStatusView command={close.command} pollError={close.pollError} workerOnline={workerOnline} title="Close all" />
        ) : null}
      </section>
    </div>
  );
}
