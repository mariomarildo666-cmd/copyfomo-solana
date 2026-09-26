// How the platform fee is described in the UI. The fee itself is computed by the engine (src/lib/fees.ts):
// `platformFeeBps` of the realized profit on each winning copy sell; losing sells, buys, deposits and
// withdrawals pay nothing. Pure: unit-tested.

/** "5%" for 500 bps, "2.5%" for 250. */
export function feePct(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** "5% of profit on each winning trade" (or "No platform fee" when the operator set 0). */
export function feeLine(bps: number): string {
  return bps > 0 ? `${feePct(bps)} of profit on each winning trade` : "No platform fee";
}

/** The longer sentence for FAQs and reviews. */
export function feeExplainer(bps: number): string {
  if (bps <= 0) return "copyfomo charges no platform fee right now.";
  return `copyfomo takes ${feePct(bps)} of the profit on each winning copy sell, and nothing else: losing or break-even sells, buys, deposits and withdrawals are free.`;
}
