"use client";

import { useState } from "react";
import type { AgentDTO, UpdateAgentInput } from "@/lib/types";
import { traderLabel } from "@/lib/format";
import { Button, buttonClass } from "@/components/ui/primitives";
import { ApiRequestError, errorMessage } from "../api";
import { CopyRulesEditor, draftFromRules, MAX_SLIPPAGE_BPS, parseRulesDraft, type CopyRules, type RuleErrors, type RulesDraft } from "../CopyRules";
import { useClientConfig } from "@/components/providers/AppConfig";
import { FieldError } from "../Field";
import { StatusLine } from "./bits";
import { agentPath, stepUpChallenge, StepUpError, useStepUpSigner, type OwnerApi } from "./ownerApi";

export function rulesOf(a: AgentDTO): CopyRules {
  return {
    sizingMode: a.sizingMode,
    fixedSol: a.fixedSol,
    maxPerTradeSol: a.maxPerTradeSol,
    slippageBps: a.slippageBps,
    copySells: a.copySells,
  };
}

function sameRules(a: CopyRules, b: CopyRules): boolean {
  return (
    a.sizingMode === b.sizingMode &&
    a.maxPerTradeSol === b.maxPerTradeSol &&
    a.slippageBps === b.slippageBps &&
    a.copySells === b.copySells &&
    (a.sizingMode !== "fixed" || a.fixedSol === b.fixedSol)
  );
}

const RULE_KEYS = ["sizingMode", "fixedSol", "maxPerTradeSol", "slippageBps", "copySells"] as const;

export function RulesSection({ agent, ownerApi, onAgent }: { agent: AgentDTO; ownerApi: OwnerApi; onAgent: (a: AgentDTO) => void }) {
  // Seeded once: polling must never clobber an edit in progress.
  const [draft, setDraft] = useState<RulesDraft>(() => draftFromRules(rulesOf(agent)));
  const [serverErrors, setServerErrors] = useState<RuleErrors>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const signStepUp = useStepUpSigner(agent.ownerWallet);

  const { maxLiveSlippageBps } = useClientConfig();
  const maxSlippageBps = agent.mode === "live" ? maxLiveSlippageBps : MAX_SLIPPAGE_BPS;
  const parsed = parseRulesDraft(draft, maxSlippageBps);
  const saved = rulesOf(agent);
  const dirty = !parsed.rules || !sameRules(parsed.rules, saved);
  const stopped = agent.status === "stopped";

  async function save() {
    if (!parsed.rules) return;
    const body: UpdateAgentInput = { ...parsed.rules };
    setBusy(true);
    setMsg(null);
    setServerErrors({});
    try {
      let res: { agent: AgentDTO };
      try {
        res = await ownerApi<{ agent: AgentDTO }>(agentPath(agent.id), { method: "PATCH", body });
      } catch (err) {
        // Live agents: raising size / slippage or changing sizing needs the owner's wallet to sign the change.
        const challenge = stepUpChallenge(err);
        if (!challenge) throw err;
        setMsg({ tone: "info", text: "This raises what a live agent can spend: confirm it in your wallet (a message, no transaction)." });
        const confirm = await signStepUp(challenge);
        res = await ownerApi<{ agent: AgentDTO }>(agentPath(agent.id), { method: "PATCH", body: { ...body, confirm } });
      }
      onAgent(res.agent);
      setDraft(draftFromRules(rulesOf(res.agent)));
      setMsg({ tone: "ok", text: "Saved. Applies from the next copied trade." });
    } catch (err) {
      if (err instanceof StepUpError) {
        setMsg({ tone: "err", text: err.message });
        return;
      }
      if (err instanceof ApiRequestError && err.fields) {
        const next: RuleErrors = {};
        for (const k of RULE_KEYS) if (err.fields[k]) next[k] = err.fields[k];
        setServerErrors(next);
      }
      setMsg({ tone: "err", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <CopyRulesEditor
        idPrefix="owner-rules"
        draft={draft}
        onChange={(d) => {
          setDraft(d);
          setServerErrors({});
          setMsg(null);
        }}
        errors={serverErrors}
        traderName={agent.traders[0] ? traderLabel(agent.traders[0]) : "the trader"}
        exampleBalanceSol={agent.balanceSol > 0 ? agent.balanceSol : 5}
        disabled={stopped || busy}
        maxSlippageBps={maxSlippageBps}
      />
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button variant="ink" icon="check" onClick={save} disabled={!dirty || !parsed.rules || busy || stopped} aria-busy={busy}>
          {busy ? "Saving…" : "Save rules"}
        </Button>
        {dirty ? (
          <button
            type="button"
            className={buttonClass("ghost")}
            onClick={() => {
              setDraft(draftFromRules(saved));
              setServerErrors({});
              setMsg(null);
            }}
          >
            Reset
          </button>
        ) : (
          <span className="text-[12px] font-medium text-muted">No unsaved changes</span>
        )}
      </div>
      {msg?.tone === "ok" ? (
        <StatusLine tone="up">{msg.text}</StatusLine>
      ) : msg?.tone === "info" ? (
        <StatusLine tone="warn">{msg.text}</StatusLine>
      ) : (
        <FieldError>{msg?.text}</FieldError>
      )}
    </div>
  );
}
