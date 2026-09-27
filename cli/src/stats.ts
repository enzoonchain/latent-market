/**
 * Earnings stats block for `latent stats` / `latent status`.
 *
 * `GET /earnings/{wallet}/stats` returns today (UTC calendar day) and all
 * time side by side; the period switch only picks which half is printed.
 */
import type { HoldingStatus } from "./holding.js";

export type StatsPeriod = "today" | "all";

export interface PeriodStats {
  earned: number;
  earned_impressions: number;
  earned_clicks: number;
  earned_boost: number;
  impressions: number;
  clicks: number;
  ctr_bps: number;
  avg_per_impression: number;
}

export interface TodayStats extends PeriodStats {
  daily_cap: number;
  /** The serving cap is a rolling 24 hours, not the calendar day. */
  cap_used_24h: number;
}

export interface AllTimeStats extends PeriodStats {
  balance: number;
  paid_out: number;
  payout_pending: number;
  active_days: number;
  first_earned_at: string | null;
}

export interface HolderStats {
  last_close_day: number | null;
  last_close_credit: number;
  last_close_blocks: number;
  cumulative_credit: number;
  blocks_allocated: number;
  kept_blocks: number;
}

export interface WalletStats {
  wallet: string;
  today: TodayStats;
  all: AllTimeStats;
  holder: HolderStats | null;
  account: (HoldingStatus & { linked: boolean }) | null;
}

export function parsePeriod(v: unknown): StatsPeriod | null {
  if (v === "today" || v === "day" || v === "daily") return "today";
  if (v === "all" || v === "total" || v === "all-time") return "all";
  return null;
}

const usd = (n: number, dp = 4) => `$${(Number.isFinite(n) ? n : 0).toFixed(dp)}`;
const int = (n: number) => Math.round(n || 0).toLocaleString("en-US");
const blocks = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const pct = (bps: number) => `${((bps || 0) / 100).toFixed(1)}%`;

function earnedLine(p: PeriodStats): string {
  const parts = [`impressions ${usd(p.earned_impressions)}`, `clicks ${usd(p.earned_clicks)}`];
  if (p.earned_boost > 0) parts.push(`boost ${usd(p.earned_boost)}`);
  return `  Earned:       ${usd(p.earned)}  (${parts.join(" · ")})`;
}

function activityLines(p: PeriodStats): string[] {
  return [
    `  Impressions:  ${int(p.impressions)}  ·  Clicks: ${int(p.clicks)}  ·  CTR ${pct(p.ctr_bps)}`,
    `  Per impression: ${usd(p.avg_per_impression, 5)} average`,
  ];
}

/** The stats block for one period, header first. */
export function formatStats(s: WalletStats, period: StatsPeriod): string[] {
  const other = period === "today" ? "--all" : "--today";
  if (period === "today") {
    const t = s.today;
    const lines = [
      `Stats — today (UTC)                 switch: latent-protocol stats ${other}`,
      earnedLine(t),
      ...activityLines(t),
      `  Daily cap:    ${int(t.cap_used_24h)} / ${int(t.daily_cap)} impressions in the last 24h`,
    ];
    const h = s.holder;
    if (h && h.last_close_day !== null) {
      lines.push(
        `  Holder:       ${usd(h.last_close_credit)} credit, ${blocks(h.last_close_blocks)} blocks on block day ${h.last_close_day}`,
      );
    }
    return lines;
  }
  const a = s.all;
  const lines = [
    `Stats — all time                    switch: latent-protocol stats ${other}`,
    earnedLine(a),
    `  Balance:      ${usd(a.balance)}  ·  Paid out ${usd(a.paid_out)}` +
      (a.payout_pending > 0 ? `  ·  Payout pending ${usd(a.payout_pending)}` : ""),
    ...activityLines(a),
  ];
  if (a.active_days > 0) {
    const since = a.first_earned_at ? ` since ${a.first_earned_at.slice(0, 10)}` : "";
    lines.push(`  Active days:  ${int(a.active_days)}${since}`);
  }
  const h = s.holder;
  if (h) {
    lines.push(
      `  Holder:       ${usd(h.cumulative_credit)} credit · ${blocks(h.blocks_allocated)} blocks allocated` +
        (h.kept_blocks > 0 ? ` · ${int(h.kept_blocks)} kept` : ""),
    );
  }
  return lines;
}

export async function getWalletStats(wallet: string, server: string): Promise<WalletStats | null> {
  const base = server.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/earnings/${encodeURIComponent(wallet)}/stats`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null; // older server without the stats route
    const j = (await res.json()) as WalletStats;
    return j && j.today && j.all ? j : null;
  } catch {
    return null;
  }
}
