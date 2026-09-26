"use client";

// Copy-rule controls shared by the create wizard (step 2) and the owner panel (light cards).
// Inputs edit a string draft; parseRulesDraft turns it into numbers + field errors.

import type { ReactNode } from "react";
import type { SizingMode } from "@/lib/types";
import { fmtSol } from "@/lib/format";
import { cn } from "@/components/ui/cn";
import { Icon } from "@/components/ui/icons";
import { SwitchBox } from "@/components/ui/Input";
import { Field, FieldError, inputClass } from "./Field";

export interface CopyRules {
  sizingMode: SizingMode;
  fixedSol: number;
  maxPerTradeSol: number;
  slippageBps: number;
  copySells: boolean;
}

export type RuleField = keyof CopyRules;
export type RuleErrors = Partial<Record<RuleField, string>>;

const SLIPPAGE_PRESETS = ["100", "300", "500"] as const;
type SlippageChoice = (typeof SLIPPAGE_PRESETS)[number] | "custom";

export interface RulesDraft {
  sizingMode: SizingMode;
  fixedSol: string;
  maxPerTradeSol: string;
  slippage: SlippageChoice;
  customBps: string;
  copySells: boolean;
}

/** Mirrors the Agent defaults in prisma/schema.prisma. */
export const DEFAULT_RULES: CopyRules = {
  sizingMode: "mirror",
  fixedSol: 0.1,
  maxPerTradeSol: 1,
  slippageBps: 300,
  copySells: true,
};

export function draftFromRules(r: CopyRules): RulesDraft {
  const preset = SLIPPAGE_PRESETS.find((p) => Number(p) === r.slippageBps);
  return {
    sizingMode: r.sizingMode,
    fixedSol: String(r.fixedSol),
    maxPerTradeSol: String(r.maxPerTradeSol),
    slippage: preset ?? "custom",
    customBps: String(r.slippageBps),
    copySells: r.copySells,
  };
}

function parseNum(s: string): number | null {
  const n = Number(s.trim().replace(",", "."));
  return s.trim() !== "" && Number.isFinite(n) ? n : null;
}

/** Slippage ceiling for paper agents; live agents are capped lower (AppConfigDTO.maxLiveSlippageBps). */
export const MAX_SLIPPAGE_BPS = 5000;

export function parseRulesDraft(d: RulesDraft, maxSlippageBps: number = MAX_SLIPPAGE_BPS): { rules: CopyRules | null; errors: RuleErrors } {
  const errors: RuleErrors = {};

  const maxPerTradeSol = parseNum(d.maxPerTradeSol);
  if (maxPerTradeSol === null) errors.maxPerTradeSol = "Enter a SOL amount.";
  else if (maxPerTradeSol < 0.001) errors.maxPerTradeSol = "At least 0.001 SOL.";

  let fixedSol = parseNum(d.fixedSol);
  if (d.sizingMode === "fixed") {
    if (fixedSol === null) errors.fixedSol = "Enter a SOL amount.";
    else if (fixedSol < 0.001) errors.fixedSol = "At least 0.001 SOL.";
  } else if (fixedSol === null || fixedSol < 0.001) {
    fixedSol = DEFAULT_RULES.fixedSol; // unused by this mode; keep the stored value sane
  }

  const slippageBps = d.slippage === "custom" ? parseNum(d.customBps) : Number(d.slippage);
  if (slippageBps === null || !Number.isInteger(slippageBps)) errors.slippageBps = "Whole number of bps (100 bps = 1%).";
  else if (slippageBps < 10 || slippageBps > maxSlippageBps) {
    errors.slippageBps =
      maxSlippageBps < MAX_SLIPPAGE_BPS
        ? `Live agents: between 10 and ${maxSlippageBps} bps (0.1%–${maxSlippageBps / 100}%).`
        : `Between 10 and ${maxSlippageBps} bps (0.1%–${maxSlippageBps / 100}%).`;
  }

  if (Object.keys(errors).length || maxPerTradeSol === null || fixedSol === null || slippageBps === null) {
    return { rules: null, errors };
  }
  return { rules: { sizingMode: d.sizingMode, fixedSol, maxPerTradeSol, slippageBps, copySells: d.copySells }, errors };
}

const MODES: { value: SizingMode; title: string; blurb: string; badge?: string }[] = [
  { value: "mirror", title: "1:1 mirror", blurb: "Same SOL size as the trader, capped by your max per trade.", badge: "Recommended" },
  { value: "fixed", title: "Fixed size", blurb: "The same SOL amount on every buy, whatever size they go." },
  { value: "proportional", title: "Proportional", blurb: "Same % of balance the trader used. Scales with your deposit." },
];

const EXAMPLE_BUY_SOL = 3;
const EXAMPLE_BUY_FRACTION = 0.1;
const EXAMPLE_SELL_PCT = 40;

/** The live "when X buys…" sentence. Pure, so the dashboard can reuse it too. */
export function rulesPreview(rules: CopyRules, traderName: string, balanceSol: number): { buy: string; sell: string } {
  let intended: number;
  let buy: string;
  if (rules.sizingMode === "mirror") {
    intended = EXAMPLE_BUY_SOL;
    buy = `When ${traderName} buys ${EXAMPLE_BUY_SOL} SOL of $TOKEN, your agent buys`;
  } else if (rules.sizingMode === "fixed") {
    intended = rules.fixedSol;
    buy = `When ${traderName} buys ${EXAMPLE_BUY_SOL} SOL of $TOKEN, your agent buys`;
  } else {
    intended = EXAMPLE_BUY_FRACTION * balanceSol;
    buy = `When ${traderName} puts ${EXAMPLE_BUY_FRACTION * 100}% of their SOL into $TOKEN, your agent puts ${
      EXAMPLE_BUY_FRACTION * 100
    }% of its ${fmtSol(balanceSol)} in:`;
  }
  const size = Math.min(intended, rules.maxPerTradeSol);
  const capped = intended > rules.maxPerTradeSol;
  buy = `${buy} ${fmtSol(size)}${capped ? " (capped)" : ""}.`;
  const sell = rules.copySells
    ? `When ${traderName} sells ${EXAMPLE_SELL_PCT}% of their $TOKEN, your agent sells ${EXAMPLE_SELL_PCT}% of its $TOKEN.`
    : "Sells are not copied. Positions stay open until you close them.";
  return { buy, sell };
}

function RadioCard({
  name,
  value,
  checked,
  onSelect,
  disabled,
  children,
  className,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "relative cursor-pointer rounded-card-sm border bg-card transition-[border-color,background-color,box-shadow] duration-150",
        "border-border hover:border-border-strong has-[input:checked]:border-mint-400 has-[input:checked]:bg-mint-50 has-[input:checked]:shadow-[0_0_0_3px_rgb(47_191_174/0.14)]",
        "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-focus",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        disabled={disabled}
        className="sr-only"
      />
      {children}
    </label>
  );
}

const legendClass = "mb-2 text-[12.5px] font-semibold text-text-2";

export function CopyRulesEditor({
  idPrefix,
  draft,
  onChange,
  errors,
  traderName = "the trader",
  exampleBalanceSol,
  disabled,
  maxSlippageBps = MAX_SLIPPAGE_BPS,
}: {
  idPrefix: string;
  draft: RulesDraft;
  onChange: (next: RulesDraft) => void;
  errors?: RuleErrors;
  traderName?: string;
  /** Balance used by the proportional preview (wallet balance, or a sensible example). */
  exampleBalanceSol: number;
  disabled?: boolean;
  /** Live agents: AppConfigDTO.maxLiveSlippageBps (the server refuses more). */
  maxSlippageBps?: number;
}) {
  const set = <K extends keyof RulesDraft>(key: K, value: RulesDraft[K]) => onChange({ ...draft, [key]: value });
  const parsed = parseRulesDraft(draft, maxSlippageBps);
  const shown = { ...parsed.errors, ...errors };
  const preview = parsed.rules ? rulesPreview(parsed.rules, traderName, exampleBalanceSol) : null;
  const customPct = parseNum(draft.customBps);

  return (
    <div className="flex flex-col gap-6">
      <fieldset disabled={disabled}>
        <legend className={legendClass}>Sizing</legend>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {MODES.map((m) => (
            <RadioCard
              key={m.value}
              name={`${idPrefix}-sizing`}
              value={m.value}
              checked={draft.sizingMode === m.value}
              onSelect={() => set("sizingMode", m.value)}
              className="p-3.5"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-[14px] font-bold leading-none text-text">{m.title}</span>
                <span
                  aria-hidden
                  className={cn(
                    "grid size-[18px] shrink-0 place-items-center rounded-full border-2 transition-colors duration-150",
                    draft.sizingMode === m.value ? "border-mint-700 bg-mint-700" : "border-border-strong bg-card",
                  )}
                >
                  {draft.sizingMode === m.value ? <span className="size-1.5 rounded-full bg-card" /> : null}
                </span>
              </span>
              {m.badge ? (
                <span className="mt-2 inline-block rounded-full border border-mint-200 bg-card px-2 py-0.5 text-[10.5px] font-bold text-mint-800">
                  {m.badge}
                </span>
              ) : null}
              <span className="mt-2 block text-[12.5px] leading-snug text-muted">{m.blurb}</span>
            </RadioCard>
          ))}
        </div>
        <FieldError>{shown.sizingMode}</FieldError>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {draft.sizingMode === "fixed" ? (
          <Field id={`${idPrefix}-fixed`} label="SOL per buy" error={shown.fixedSol} hint="Spent on every copied buy.">
            <SolInput
              id={`${idPrefix}-fixed`}
              value={draft.fixedSol}
              onChange={(v) => set("fixedSol", v)}
              invalid={Boolean(shown.fixedSol)}
              disabled={disabled}
            />
          </Field>
        ) : null}
        <Field
          id={`${idPrefix}-max`}
          label="Max per trade"
          error={shown.maxPerTradeSol}
          hint="Hard ceiling on any single copy buy."
        >
          <SolInput
            id={`${idPrefix}-max`}
            value={draft.maxPerTradeSol}
            onChange={(v) => set("maxPerTradeSol", v)}
            invalid={Boolean(shown.maxPerTradeSol)}
            disabled={disabled}
          />
        </Field>
      </div>

      <fieldset disabled={disabled}>
        <legend className={legendClass}>Slippage</legend>
        <div className="flex flex-wrap gap-2">
          {[...SLIPPAGE_PRESETS, "custom" as const].map((p) => (
            <RadioCard
              key={p}
              name={`${idPrefix}-slippage`}
              value={p}
              checked={draft.slippage === p}
              onSelect={() => set("slippage", p)}
              className="grid h-10 min-w-16 place-items-center rounded-full px-4"
            >
              <span className={cn("text-[13px] font-semibold", draft.slippage === p ? "text-mint-800" : "text-text")}>
                {p === "custom" ? "Custom" : `${Number(p) / 100}%`}
              </span>
            </RadioCard>
          ))}
        </div>
        {draft.slippage === "custom" ? (
          <div className="mt-3 max-w-60">
            <label htmlFor={`${idPrefix}-bps`} className="sr-only">
              Custom slippage in basis points
            </label>
            <div className="relative">
              <input
                id={`${idPrefix}-bps`}
                inputMode="numeric"
                value={draft.customBps}
                onChange={(e) => set("customBps", e.target.value)}
                className={cn(inputClass, "pr-24 font-mono")}
                aria-invalid={Boolean(shown.slippageBps) || undefined}
                aria-describedby={`${idPrefix}-bps-error`}
                disabled={disabled}
              />
              <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[12px] font-semibold text-muted">
                bps{customPct !== null ? ` = ${(customPct / 100).toFixed(2)}%` : ""}
              </span>
            </div>
          </div>
        ) : null}
        <FieldError id={`${idPrefix}-bps-error`}>{shown.slippageBps}</FieldError>
        <p className="mt-1.5 text-[12px] leading-snug text-muted">
          Memecoins move fast. Too tight and copies fail; too loose and you overpay.
          {maxSlippageBps < MAX_SLIPPAGE_BPS ? ` Live agents allow at most ${maxSlippageBps / 100}%.` : ""}
        </p>
      </fieldset>

      <div>
        <label className="flex cursor-pointer items-start gap-3">
          <SwitchBox checked={draft.copySells} onChange={(e) => set("copySells", e.target.checked)} disabled={disabled} className="mt-0.5" />
          <span>
            <span className="block text-[14px] font-bold text-text">Copy sells {draft.copySells ? "· on" : "· off"}</span>
            <span className="mt-1 block text-[12.5px] leading-snug text-muted">
              Partial sells are mirrored by fraction: if they sell 40% of a bag, your agent sells 40% of its bag.
            </span>
          </span>
        </label>
        <FieldError>{shown.copySells}</FieldError>
      </div>

      <div className="rounded-card-sm border border-dashed border-border-strong bg-card-2 p-3.5 text-[13px] leading-relaxed" aria-live="polite">
        <p className="mb-1.5 text-[11.5px] font-bold uppercase tracking-[0.08em] text-muted">Preview</p>
        {preview ? (
          <>
            <p className="flex gap-2 text-text">
              <Icon name="chev-right" size={15} strokeWidth={2.4} className="mt-[3px] shrink-0 text-mint-600" />
              <span>{preview.buy}</span>
            </p>
            <p className="mt-1 flex gap-2 text-text-2">
              <Icon name="chev-right" size={15} strokeWidth={2.4} className="mt-[3px] shrink-0 text-mint-600" />
              <span>{preview.sell}</span>
            </p>
          </>
        ) : (
          <p className="text-muted">Fix the highlighted fields to see a preview.</p>
        )}
      </div>
    </div>
  );
}

function SolInput({
  id,
  value,
  onChange,
  invalid,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(inputClass, "pr-12 font-mono")}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-hint ${id}-error`}
        disabled={disabled}
      />
      <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[12px] font-semibold text-muted">SOL</span>
    </div>
  );
}
