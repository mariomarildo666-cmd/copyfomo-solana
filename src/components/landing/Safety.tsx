// Safety, stated plainly: how funds are isolated and what can go wrong. No hooks.

import { PixelRobot } from "@/components/bots/PixelRobot";
import { Icon, type IconName } from "@/components/ui/icons";
import { Card, Heading, Kicker } from "@/components/ui/primitives";

const POINTS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "wallet",
    title: "One wallet per agent",
    body: "Every agent gets its own fresh Solana keypair. Nothing is pooled with anyone else's funds.",
  },
  {
    icon: "shield",
    title: "Keys sealed at rest",
    body: "Agent keys are encrypted the moment they are created. The website can't open them; only the copy engine can unseal a key to sign a trade.",
  },
  {
    icon: "logout",
    title: "Withdrawals go one place",
    body: "SOL can only leave to the wallet you signed in with when you created the agent. Nobody can redirect it anywhere else, us included.",
  },
  {
    icon: "target",
    title: "Caps on every copy",
    body: "Max SOL per trade, a slippage limit, a fee reserve that is never spent, and a hard ceiling per copy on top.",
  },
  {
    icon: "sparkle",
    title: "Paper mode first",
    body: "In paper mode fills are simulated against live Jupiter quotes and deposits are simulated too. Paper agents never hold real SOL: don't send any to them.",
  },
  {
    icon: "check",
    title: "Your wallet is the key",
    body: "Sign in by signing a message with your wallet: no password, nothing to lose. Deposits are one transfer you approve in your wallet. Custodial by design: treat the agent like a hot wallet.",
  },
];

export function Safety() {
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Kicker className="mb-1">Safety</Kicker>
          <Heading id="safety-title" size="lg">
            Safety, plainly.
          </Heading>
        </div>
        {/* nova, the guardian angel of the cast */}
        <PixelRobot name="nova" size={64} className="-mt-2 shrink-0" />
      </div>

      <ul className="mt-5 grid gap-x-6 gap-y-5 sm:grid-cols-2">
        {POINTS.map((p) => (
          <li key={p.title} className="flex gap-3">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-icon border border-mint-200 bg-mint-50 text-mint-700">
              <Icon name={p.icon} size={17} strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <h3 className="text-[14px] font-bold leading-tight tracking-[-0.01em] text-text">{p.title}</h3>
              <p className="mt-1 text-[13.5px] leading-relaxed text-text-2">{p.body}</p>
            </div>
          </li>
        ))}
      </ul>

      <div role="note" className="mt-6 rounded-card-sm border border-paper-border bg-paper-bg p-4 sm:p-5">
        <p className="flex items-center gap-2 text-[14px] font-bold text-paper-ink">
          <Icon name="alert" size={16} strokeWidth={2.2} />
          Read this before you deposit
        </p>
        <p className="mt-2 text-[13.5px] leading-relaxed text-text-2">
          Copy-trading memecoins can lose everything. A trader&apos;s past PnL is not a promise. Copies land after the
          original, at a different price, and thin tokens can move hard against you. Only deposit what you can afford to
          lose.
        </p>
      </div>
    </Card>
  );
}
