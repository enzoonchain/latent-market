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

export type StatsPeriod = "today" | "all";

export interface PeriodStats {
  earned: number;
  earnedImpressions: number;
  earnedClicks: number;
  earnedBoost: number;
  impressions: number;
  clicks: number;
  ctrBps: number;
  avgPerImpression: number;
}

export interface WalletStats {
  today: PeriodStats & { dailyCap: number; capUsed24h: number };
  all: PeriodStats & {
    balance: number;
    paidOut: number;
    payoutPending: number;
    activeDays: number;
    firstEarnedAt: string | null;
  };
  holder: {
    lastCloseDay: number | null;
    lastCloseCredit: number;
    lastCloseBlocks: number;
    cumulativeCredit: number;
    blocksAllocated: number;
    keptBlocks: number;
  } | null;
  tier: number | null;
}

type Raw = Record<string, unknown>;

function period(p: Raw): PeriodStats {
  return {
    earned: num(p.earned),
    earnedImpressions: num(p.earned_impressions),
    earnedClicks: num(p.earned_clicks),
    earnedBoost: num(p.earned_boost),
    impressions: num(p.impressions),
    clicks: num(p.clicks),
    ctrBps: num(p.ctr_bps),
    avgPerImpression: num(p.avg_per_impression),
  };
}

/** `GET /earnings/{wallet}/stats`: today (UTC day) and all time in one call.
 * null on an older server without the route — callers fall back to the summary. */
export async function fetchWalletStats(serverUrl: string, wallet: string): Promise<WalletStats | null> {
  try {
    const r = await fetch(`${serverUrl}/earnings/${encodeURIComponent(wallet)}/stats`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { today?: Raw; all?: Raw; holder?: Raw | null; account?: Raw | null };
    if (!j.today || !j.all) return null;
    const h = j.holder;
    return {
      today: { ...period(j.today), dailyCap: num(j.today.daily_cap), capUsed24h: num(j.today.cap_used_24h) },
      all: {
        ...period(j.all),
        balance: num(j.all.balance),
        paidOut: num(j.all.paid_out),
        payoutPending: num(j.all.payout_pending),
        activeDays: num(j.all.active_days),
        firstEarnedAt: typeof j.all.first_earned_at === "string" ? j.all.first_earned_at : null,
      },
      holder: h
        ? {
            lastCloseDay: h.last_close_day === null || h.last_close_day === undefined ? null : num(h.last_close_day),
            lastCloseCredit: num(h.last_close_credit),
            lastCloseBlocks: num(h.last_close_blocks),
            cumulativeCredit: num(h.cumulative_credit),
            blocksAllocated: num(h.blocks_allocated),
            keptBlocks: num(h.kept_blocks),
          }
        : null,
      tier: j.account && j.account.linked ? num(j.account.tier) : null,
    };
  } catch {
    return null;
  }
}

export interface StatCell {
  label: string;
  value: string;
}

const usd = (n: number, dp = 2) => `$${n.toFixed(dp)}`;
const count = (n: number) => Math.round(n).toLocaleString("en-US");
const blocks = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const ctr = (bps: number) => `${(bps / 100).toFixed(1)}%`;

/** The panel's stat tiles for one period, plus the earned breakdown line. */
export function statCells(s: WalletStats, p: StatsPeriod): { cells: StatCell[]; breakdown: string } {
  const src = p === "today" ? s.today : s.all;
  const parts = [`impressions ${usd(src.earnedImpressions, 4)}`, `clicks ${usd(src.earnedClicks, 4)}`];
  if (src.earnedBoost > 0) parts.push(`boost ${usd(src.earnedBoost, 4)}`);
  const breakdown = `Earned from ${parts.join(" · ")}`;
  const perImp = { label: "Avg per impression", value: usd(src.avgPerImpression, 5) };
  const clicks = { label: "Clicks · CTR", value: `${count(src.clicks)} · ${ctr(src.ctrBps)}` };
  if (p === "today") {
    const cells: StatCell[] = [
      { label: "Earned today", value: usd(s.today.earned, 4) },
      { label: "Impressions today", value: count(s.today.impressions) },
      clicks,
      { label: "Daily cap (24h)", value: `${count(s.today.capUsed24h)} / ${count(s.today.dailyCap)}` },
      perImp,
    ];
    if (s.holder && s.holder.lastCloseDay !== null) {
      cells.push({
        label: `Holder credit · day ${s.holder.lastCloseDay} · ${blocks(s.holder.lastCloseBlocks)} blocks`,
        value: usd(s.holder.lastCloseCredit, 4),
      });
    }
    return { cells, breakdown };
  }
  const cells: StatCell[] = [
    { label: "Total earned", value: usd(s.all.earned) },
    { label: s.all.payoutPending > 0 ? `Paid out · ${usd(s.all.payoutPending)} pending` : "Total paid out", value: usd(s.all.paidOut) },
    { label: "Total impressions", value: count(s.all.impressions) },
    clicks,
    perImp,
    { label: "Active days", value: count(s.all.activeDays) },
  ];
  if (s.holder) {
    cells.push({ label: "Holder credit (total)", value: usd(s.holder.cumulativeCredit, 4) });
    cells.push({
      label: s.holder.keptBlocks > 0 ? `Blocks · ${count(s.holder.keptBlocks)} kept` : "Blocks allocated",
      value: blocks(s.holder.blocksAllocated),
    });
  }
  return { cells, breakdown };
}
