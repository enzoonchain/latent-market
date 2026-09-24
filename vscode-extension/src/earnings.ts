/** Earnings read, kept free of the `vscode` import so it is unit-testable. */

export type EarningsResult =
  | { kind: "ok"; balance: number; totalEarned: number; impressions: number; clicks: number; tier?: string }
  /** 401/403: an older server still requires a signature. The summary route
   * is public; history and payouts are not. */
  | { kind: "auth" }
  | { kind: "error" };

export interface NetworkStats {
  earnedUsdc: number;
  paidOutUsdc: number;
  impressions: number;
  agents: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchEarnings(serverUrl: string, wallet: string): Promise<EarningsResult> {
  try {
    const r = await fetch(`${serverUrl}/earnings/${wallet}`, { signal: AbortSignal.timeout(5000) });
    if (r.status === 401 || r.status === 403) return { kind: "auth" };
    if (!r.ok) return { kind: "error" };
    const j = (await r.json()) as {
      balance?: unknown;
      total_earned?: unknown;
      total_impressions?: unknown;
      total_clicks?: unknown;
      tier?: string;
    };
    const balance = Number(j.balance);
    if (!Number.isFinite(balance)) return { kind: "error" };
    return {
      kind: "ok",
      balance,
      totalEarned: num(j.total_earned),
      impressions: num(j.total_impressions),
      clicks: num(j.total_clicks),
      tier: j.tier,
    };
  } catch {
    return { kind: "error" };
  }
}

/** Public network totals from `GET /stats`. No wallet, no signature. */
export async function fetchNetworkStats(serverUrl: string): Promise<NetworkStats | null> {
  try {
    const r = await fetch(`${serverUrl}/stats`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      earned_usdc?: unknown;
      paid_out_usdc?: unknown;
      impressions?: unknown;
      agents?: unknown;
    };
    return {
      earnedUsdc: num(j.earned_usdc),
      paidOutUsdc: num(j.paid_out_usdc),
      impressions: num(j.impressions),
      agents: num(j.agents),
    };
  } catch {
    return null;
  }
}
