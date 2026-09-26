"use client";

// Build an agent: Traders → Rules → Fund → Review → Create. The signed-in wallet owns the agent and is the only
// place withdrawals can go, so there is no payout field. Live mode: creating returns an unsigned deposit
// transfer and the wallet pops up to sign it right away (AgentBorn). Paper mode: the amount is credited as
// simulated SOL on creation.
//
// Layout (mockup v2): the mint hero banner (The Original + The Copy), a pill stepper, the step card, and the live
// preview card on the right once the page is wide enough (container queries on the page, not the viewport).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CreateAgentInput, CreateAgentResult, TraderLookupDTO } from "@/lib/types";
import { HeroBanner } from "@/components/ui/HeroBanner";
import { Icon } from "@/components/ui/icons";
import { Button, Panel, cn } from "@/components/ui/primitives";
import { useSession } from "@/components/wallet/session";
import { AGENT_NAME_RE, toAgentName } from "../address";
import { api, ApiRequestError, errorMessage } from "../api";
import {
  CopyRulesEditor,
  DEFAULT_RULES,
  draftFromRules,
  MAX_SLIPPAGE_BPS,
  parseRulesDraft,
  type RuleErrors,
  type RuleField,
  type RulesDraft,
} from "../CopyRules";
import { checkDepositAmount } from "../deposit/amount";
import { useWalletBalance } from "../deposit/AmountPicker";
import { Notice } from "../Field";
import { useAppConfig } from "../hooks";
import { isCopyable, setPicks, usePicks, type CopyableTrader } from "../picks";
import { traderName } from "../TraderIdentity";
import { lookupMissText, type AddResult, type LookupNote } from "../TraderLookup";
import { AgentBorn } from "./AgentBorn";
import { DeskPreview } from "./DeskPreview";
import { StepFund } from "./StepFund";
import { StepReview } from "./StepReview";
import { StepTraders, type Entry } from "./StepTraders";

const STEPS = [
  { short: "Traders", heading: "Who does it copy?" },
  { short: "Rules", heading: "How does it size?" },
  { short: "Fund", heading: "Fund it" },
  { short: "Review", heading: "Check it, then grow it" },
] as const;
const FUND = 2;
const LAST = STEPS.length - 1;

const RULE_FIELDS: readonly RuleField[] = ["sizingMode", "fixedSol", "maxPerTradeSol", "slippageBps", "copySells"];

/** Which wizard step owns a server-side validation field. */
function stepForField(key: string): number {
  if (key === "traders" || key.startsWith("traders.") || key.startsWith("traders[")) return 0;
  if ((RULE_FIELDS as readonly string[]).includes(key)) return 1;
  if (key === "depositSol") return FUND;
  return LAST; // name + anything unexpected
}

function resolveEntry(key: string, query: string, res: TraderLookupDTO): Entry {
  const { trader, note } = res;
  if (!trader || !isCopyable(trader)) return { key, state: "error", query, error: lookupMissText(query) };
  return { key, state: "ok", trader, note };
}

function omit(obj: Record<string, string>, pred: (k: string) => boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) if (!pred(k)) out[k] = v;
  return out;
}

const pickEntry = (t: CopyableTrader): Entry => ({ key: t.wallet, state: "ok", trader: t, note: null });

export function CreateWizard({ initialQueries }: { initialQueries: string[] }) {
  const { config: cfg } = useAppConfig();
  const session = useSession();
  const max = cfg.maxTradersPerAgent;

  // Without ?t=, the wizard starts from the traders picked on the leaderboard (until the user edits the list).
  const picks = usePicks();
  const [touched, setTouched] = useState(initialQueries.length > 0);
  const [ownEntries, setOwnEntries] = useState<Entry[]>(() =>
    initialQueries.map((q): Entry => ({ key: q, state: "loading", query: q })),
  );
  const fromPicks = !touched;
  const entries = useMemo(() => (fromPicks ? picks.map(pickEntry) : ownEntries), [fromPicks, picks, ownEntries]);
  const editEntries = (fn: (prev: Entry[]) => Entry[]) => {
    const base = entries;
    setTouched(true);
    setOwnEntries((prev) => fn(fromPicks ? base : prev));
  };

  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(0);
  const [attempted, setAttempted] = useState<boolean[]>(() => STEPS.map(() => false));
  const [draft, setDraft] = useState<RulesDraft>(() => draftFromRules(DEFAULT_RULES));
  const [depositRaw, setDepositRaw] = useState(() => String(cfg.mode === "paper" ? cfg.paperStartSol : 1));
  const [nameInput, setNameInput] = useState<string | null>(null); // null → auto name
  const [ack, setAck] = useState(false);
  const [serverFields, setServerFields] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ res: CreateAgentResult; depositSol: number } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const balance = useWalletBalance(cfg.mode === "live" && step >= FUND && !result);

  const lookup = useCallback((key: string, query: string) => {
    api<TraderLookupDTO>(`/api/traders/lookup?q=${encodeURIComponent(query)}`).then(
      (res) =>
        setOwnEntries((prev) => {
          const next = resolveEntry(key, query, res);
          const dupe =
            next.state === "ok" &&
            prev.some((e) => e.key !== key && e.state === "ok" && e.trader.wallet === next.trader.wallet);
          return dupe ? prev.filter((e) => e.key !== key) : prev.map((e) => (e.key === key ? next : e));
        }),
      (err: unknown) =>
        setOwnEntries((prev) =>
          prev.map((e): Entry => (e.key === key ? { key, state: "error", query, error: errorMessage(err) } : e)),
        ),
    );
  }, []);

  useEffect(() => {
    initialQueries.forEach((q) => lookup(q, q));
  }, [initialQueries, lookup]);

  const traders = useMemo(() => entries.flatMap((e) => (e.state === "ok" ? [e.trader] : [])), [entries]);
  const resolving = entries.some((e) => e.state === "loading");

  // Keep the /traders picker in sync so "browse the leaderboard" round-trips (only once the list is ours).
  useEffect(() => {
    if (result || resolving || fromPicks) return;
    setPicks(traders);
  }, [traders, resolving, result, fromPicks]);

  const first = traders[0];
  const autoName = first ? toAgentName(first.handle ?? first.wallet.slice(0, 8)) : "";
  const name = nameInput ?? autoName;
  const maxSlippageBps = cfg.mode === "live" ? cfg.maxLiveSlippageBps : MAX_SLIPPAGE_BPS;
  const parsedRules = parseRulesDraft(draft, maxSlippageBps);
  const deposit = checkDepositAmount({ raw: depositRaw, mode: cfg.mode, minSol: cfg.minDepositSol, walletSol: balance.sol });

  // ── validation (client errors appear after a step was attempted; server errors always) ──
  const serverTraders = Object.entries(serverFields).find(([k]) => stepForField(k) === 0)?.[1] ?? null;
  const clientTraders =
    entries.length === 0
      ? "Add at least one trader."
      : resolving
        ? "Still resolving traders — one moment."
        : entries.some((e) => e.state === "error")
          ? "Remove the traders that didn't resolve."
          : traders.length > max
            ? `Max ${max} traders per agent.`
            : null;
  const clientFund = !session.wallet ? "Sign in with your wallet first." : deposit.error;
  const clientName = name && !AGENT_NAME_RE.test(name) ? "Use a–z, 0–9, . _ - only (max 24)." : null;
  const clientAck = ack ? null : "Tick the box to confirm.";

  const clientInvalid = [Boolean(clientTraders), !parsedRules.rules, Boolean(clientFund), Boolean(clientName || clientAck)];
  const shownClient = (i: number, msg: string | null) => (attempted[i] ? msg : null);

  const ruleServerErrors: RuleErrors = {};
  for (const f of RULE_FIELDS) if (serverFields[f]) ruleServerErrors[f] = serverFields[f];

  function go(i: number) {
    setStep(i);
    setFurthest((f) => Math.max(f, i));
    headingRef.current?.focus();
  }

  function markAttempted(i: number) {
    setAttempted((a) => a.map((v, j) => v || j === i));
  }

  function next() {
    markAttempted(step);
    if (clientInvalid[step]) return;
    go(Math.min(LAST, step + 1));
  }

  function clearServer(pred: (k: string) => boolean) {
    setServerFields((f) => omit(f, pred));
  }

  function addTrader(t: CopyableTrader, note: LookupNote): AddResult {
    if (entries.some((e) => e.key === t.wallet || (e.state === "ok" && e.trader.wallet === t.wallet))) return "duplicate";
    if (entries.length >= max) return "full";
    editEntries((prev) => [...prev, { key: t.wallet, state: "ok", trader: t, note }]);
    clearServer((k) => stepForField(k) === 0);
    return "added";
  }

  function removeEntry(key: string) {
    editEntries((prev) => prev.filter((e) => e.key !== key));
    clearServer((k) => stepForField(k) === 0);
  }

  function retryEntry(key: string) {
    const entry = entries.find((e) => e.key === key);
    if (!entry || entry.state !== "error") return;
    editEntries((prev) => prev.map((e): Entry => (e.key === key ? { key, state: "loading", query: entry.query } : e)));
    lookup(key, entry.query);
  }

  async function create() {
    const firstInvalid = clientInvalid.findIndex(Boolean);
    if (firstInvalid !== -1 || !parsedRules.rules || deposit.amount === null) {
      const target = firstInvalid === -1 ? FUND : firstInvalid;
      setAttempted((a) => a.map((v, j) => v || j <= target));
      if (target !== step) go(target);
      return;
    }
    const rules = parsedRules.rules;
    const body: CreateAgentInput = {
      name: name || undefined,
      // Wallets only: the server takes labels from its own data, never from the client.
      traders: traders.map((t) => ({ wallet: t.wallet })),
      sizingMode: rules.sizingMode,
      fixedSol: rules.fixedSol,
      maxPerTradeSol: rules.maxPerTradeSol,
      slippageBps: rules.slippageBps,
      copySells: rules.copySells,
      depositSol: deposit.amount,
    };

    setBusy(true);
    setGeneralError(null);
    try {
      const res = await api<CreateAgentResult>("/api/agents", { method: "POST", body });
      setPicks([]);
      setResult({ res, depositSol: deposit.amount });
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        void session.refresh();
        setGeneralError("Your sign-in expired. Sign in again on the Fund step.");
        go(FUND);
      } else if (err instanceof ApiRequestError && err.fields) {
        const fields = err.fields;
        const unmapped = Object.keys(fields).filter((k) => stepForField(k) === LAST && k !== "name");
        setServerFields(fields);
        setGeneralError(
          unmapped.length
            ? unmapped.map((k) => fields[k]).join(" · ")
            : "Some answers need fixing — see the highlighted fields.",
        );
        const target = Math.min(...Object.keys(fields).map(stepForField));
        if (target !== step) go(target);
      } else {
        setGeneralError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="page @container">
        <AgentBorn result={result.res} depositSol={result.depositSol} />
      </div>
    );
  }

  const leadName = first ? traderName(first) : "the trader";

  return (
    <div className="page @container gap-4 app:gap-5">
      <HeroBanner id="create-title" title={["Build", "an agent"]} robots={["the-original", "the-copy"]} compact>
        Pick who to copy, set the size, fund it from your wallet in one click. Your agent gets its own Solana wallet
        and mirrors their{cfg.copyVenue === "fomo" ? " FOMO" : ""} trades the moment they land on-chain.
      </HeroBanner>

      <nav aria-label="Wizard steps">
        <ol className="flex items-center gap-1 rounded-full border border-hairline bg-card p-1.5 shadow-pill">
          {STEPS.map((s, i) => {
            const reachable = i <= furthest;
            const current = i === step;
            // A check only for steps already passed that are still valid (going back can break one).
            const done = !current && i < furthest && !clientInvalid[i];
            return (
              <li key={s.short} className={cn("min-w-0", current ? "flex-[1.7] app:flex-1" : "flex-1")}>
                <button
                  type="button"
                  onClick={() => reachable && go(i)}
                  disabled={!reachable}
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "flex h-11 w-full min-w-0 items-center justify-center gap-2 rounded-full px-2 text-[13px]",
                    "transition-[background-color,color,box-shadow] duration-150 ease-out-soft app:h-10 app:px-3",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default",
                    current
                      ? "bg-ink font-bold text-on-ink shadow-ink"
                      : reachable
                        ? "font-semibold text-text-2 hover:bg-card-2 hover:text-text"
                        : "font-semibold text-muted",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-bold tabular-nums",
                      current
                        ? "bg-mint-400 text-ink"
                        : done
                          ? "bg-mint-600 text-on-ink"
                          : reachable
                            ? "border border-border-strong bg-card text-text-2"
                            : "bg-card-2 text-muted",
                    )}
                  >
                    {done ? <Icon name="check" size={13} strokeWidth={3} /> : i + 1}
                  </span>
                  <span className={cn("truncate", !current && "max-app:sr-only")}>{s.short}</span>
                  {done ? <span className="sr-only"> (done)</span> : null}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="grid grid-cols-1 gap-4 app:gap-5 @4xl:grid-cols-[minmax(0,1fr)_292px] @4xl:items-start">
        <Panel className="p-5 app:p-7" aria-labelledby="wizard-step-heading">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11.5px] font-bold uppercase tracking-[0.08em] text-mint-700">
              Step {step + 1} of {STEPS.length}
            </p>
            <span aria-hidden className="flex items-center gap-1">
              {STEPS.map((s, i) => (
                <span
                  key={s.short}
                  className={cn(
                    "h-1.5 rounded-full transition-[width,background-color] duration-200",
                    i === step ? "w-5 bg-mint-500" : i < step ? "w-1.5 bg-mint-300" : "w-1.5 bg-border-strong",
                  )}
                />
              ))}
            </span>
          </div>
          <h2
            id="wizard-step-heading"
            ref={headingRef}
            tabIndex={-1}
            className="mt-2 text-[24px] font-extrabold leading-tight tracking-[-0.03em] text-text outline-none app:text-[28px]"
          >
            {STEPS[step].heading}
          </h2>

          <div className="mt-6">
            {step === 0 ? (
              <StepTraders
                entries={entries}
                max={max}
                error={serverTraders ?? shownClient(0, clientTraders)}
                copyVenue={cfg.copyVenue}
                onAdd={addTrader}
                onRemove={removeEntry}
                onRetry={retryEntry}
              />
            ) : step === 1 ? (
              <CopyRulesEditor
                idPrefix="wizard"
                draft={draft}
                onChange={(d) => {
                  setDraft(d);
                  clearServer((k) => stepForField(k) === 1);
                }}
                errors={attempted[1] ? { ...parsedRules.errors, ...ruleServerErrors } : ruleServerErrors}
                traderName={leadName}
                exampleBalanceSol={deposit.amount ?? cfg.paperStartSol}
                maxSlippageBps={maxSlippageBps}
              />
            ) : step === FUND ? (
              <StepFund
                mode={cfg.mode}
                minDepositSol={cfg.minDepositSol}
                value={depositRaw}
                onChange={(v) => {
                  setDepositRaw(v);
                  clearServer((k) => k === "depositSol");
                }}
                error={serverFields.depositSol ?? (session.wallet ? shownClient(FUND, deposit.error) : null)}
                walletSol={balance.sol}
                walletLoading={balance.loading}
                walletError={balance.error}
                signInError={session.wallet ? null : shownClient(FUND, clientFund)}
              />
            ) : parsedRules.rules ? (
              <StepReview
                traders={traders}
                rules={parsedRules.rules}
                owner={session.wallet}
                depositSol={deposit.amount}
                name={name}
                autoName={autoName}
                onName={(v) => {
                  setNameInput(v);
                  clearServer((k) => k === "name");
                }}
                nameError={serverFields.name ?? shownClient(LAST, clientName)}
                mode={cfg.mode}
                copyVenue={cfg.copyVenue}
                minDepositSol={cfg.minDepositSol}
                platformFeeBps={cfg.platformFeeBps}
                ack={ack}
                onAck={setAck}
                ackError={shownClient(LAST, clientAck)}
                generalError={generalError}
              />
            ) : (
              <Notice tone="down">Copy rules need fixing first — go back to step 2.</Notice>
            )}
          </div>

          <div className="mt-8 flex items-center justify-between gap-3 border-t border-border pt-5">
            {step > 0 ? (
              <Button variant="ghost" icon="arrow-left" className="-ml-2" onClick={() => go(step - 1)}>
                Back
              </Button>
            ) : (
              <span />
            )}
            {step < LAST ? (
              // Signed out on the Fund step, Next can't go anywhere yet: it looks disabled, but a click still
              // explains why (the "Sign in with your wallet first." error under the sign-in card).
              <Button
                variant="ink"
                iconEnd="arrow"
                className={cn("min-w-28", step === FUND && !session.wallet && "opacity-45 shadow-none")}
                onClick={next}
              >
                Next
              </Button>
            ) : (
              <Button variant="ink" size="lg" icon={busy ? undefined : "sparkle"} onClick={create} disabled={busy} aria-busy={busy}>
                {busy ? "Growing…" : cfg.mode === "live" ? "Create & fund" : "Create agent"}
              </Button>
            )}
          </div>
        </Panel>

        <aside className="@4xl:sticky @4xl:top-6">
          <DeskPreview
            traders={traders}
            rules={parsedRules.rules}
            name={name}
            owner={session.wallet}
            depositSol={deposit.amount}
            mode={cfg.mode}
          />
        </aside>
      </div>
    </div>
  );
}
