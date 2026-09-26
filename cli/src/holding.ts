/**
 * Holding tier and viewer boost for `latent status` (block system, E7.5).
 *
 * The server computes the tier at each daily close from the 7-day average
 * LATENT balance of every wallet linked to your login, and scales the boost
 * to the day's treasury budget. This only fetches and formats it.
 */

export interface HoldingStatus {
  linked: boolean;
  tier: number;
  twab_tokens: string;
  tier_thresholds: string[];
  boost_bps: number;
  boost_daily_cap: number;
  effective_scale_bps: number;
  effective_boost_bps: number;
}

const TOKEN_UNIT = BigInt("1000000000000000000");

/** Token base units (18 decimals) → whole tokens, with thousands separators. */
export function formatTokens(units: string): string {
  let whole: bigint;
  try {
    whole = BigInt(units) / TOKEN_UNIT;
  } catch {
    return "0";
  }
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

export function formatHolding(s: HoldingStatus): string[] {
  if (!s.linked) {
    return [
      "  Tier:    none — this wallet is not linked to a Latent login",
      "           link it on the dashboard to count its LATENT toward your tier",
    ];
  }
  const lines = [`  Tier:    ${s.tier === 0 ? "none" : s.tier} (7-day average ${formatTokens(s.twab_tokens)} LATENT)`];
  const next = s.tier_thresholds[s.tier];
  if (next) lines.push(`           next tier at ${formatTokens(next)} LATENT`);
  if (!s.boost_bps) {
    lines.push("  Boost:   not active yet");
    return lines;
  }
  lines.push(`  Boost:   +${pct(s.effective_boost_bps)} today on your first ${s.boost_daily_cap} impressions a day`);
  if (s.effective_scale_bps < 10_000) {
    lines.push(`           (tier boost +${pct(s.boost_bps)}, scaled to ${pct(s.effective_scale_bps)} by the day's budget)`);
  }
  return lines;
}

export async function getHoldingStatus(wallet: string, server: string): Promise<HoldingStatus | null> {
  const base = server.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/accounts/status?wallet=${encodeURIComponent(wallet)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null; // older server or block system not deployed
    return (await res.json()) as HoldingStatus;
  } catch {
    return null;
  }
}
