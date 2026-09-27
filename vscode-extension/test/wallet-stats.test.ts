import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchWalletStats, statCells } from "../src/earnings.js";

const body = {
  today: { earned: 0.0412, earned_impressions: 0.0375, earned_clicks: 0.0025, earned_boost: 0.0012,
    impressions: 42, clicks: 3, ctr_bps: 714, avg_per_impression: 0.000893, daily_cap: 100, cap_used_24h: 57 },
  all: { earned: 3.2104, earned_impressions: 2.95, earned_clicks: 0.21, earned_boost: 0,
    impressions: 3312, clicks: 118, ctr_bps: 356, avg_per_impression: 0.000891, balance: 0.8421,
    paid_out: 2.3683, payout_pending: 0.5, active_days: 23, first_earned_at: "2026-09-02T10:11:12+00:00" },
  holder: { last_close_day: 4, last_close_credit: 0.1375, last_close_blocks: 2.5, cumulative_credit: 0.6121,
    blocks_allocated: 9.75, kept_blocks: 1 },
  account: { linked: true, tier: 2 },
};

const stub = (status: number, b: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(b), { status })));

afterEach(() => vi.unstubAllGlobals());

describe("fetchWalletStats", () => {
  it("maps both periods, the holder and the tier", async () => {
    stub(200, body);
    const s = await fetchWalletStats("https://s", "0xabc");
    expect(s?.today.capUsed24h).toBe(57);
    expect(s?.all.paidOut).toBe(2.3683);
    expect(s?.holder?.lastCloseDay).toBe(4);
    expect(s?.tier).toBe(2);
  });

  it("is null on an older server (404) or a malformed body", async () => {
    stub(404, {});
    expect(await fetchWalletStats("https://s", "0xabc")).toBeNull();
    stub(200, { balance: 1 });
    expect(await fetchWalletStats("https://s", "0xabc")).toBeNull();
  });

  it("an unlinked wallet has no tier", async () => {
    stub(200, { ...body, account: { linked: false, tier: 0 }, holder: null });
    const s = await fetchWalletStats("https://s", "0xabc");
    expect(s?.tier).toBeNull();
    expect(s?.holder).toBeNull();
  });
});

describe("statCells", () => {
  it("today: day totals, rolling cap and the last close's holder credit", async () => {
    stub(200, body);
    const s = (await fetchWalletStats("https://s", "0xabc"))!;
    const { cells, breakdown } = statCells(s, "today");
    const map = Object.fromEntries(cells.map((c) => [c.label, c.value]));
    expect(map["Earned today"]).toBe("$0.0412");
    expect(map["Clicks · CTR"]).toBe("3 · 7.1%");
    expect(map["Daily cap (24h)"]).toBe("57 / 100");
    expect(map["Holder credit · day 4 · 2.50 blocks"]).toBe("$0.1375");
    expect(breakdown).toContain("boost $0.0012");
  });

  it("all time: payouts with pending, active days, holder totals", async () => {
    stub(200, body);
    const s = (await fetchWalletStats("https://s", "0xabc"))!;
    const { cells, breakdown } = statCells(s, "all");
    const map = Object.fromEntries(cells.map((c) => [c.label, c.value]));
    expect(map["Total earned"]).toBe("$3.21");
    expect(map["Paid out · $0.50 pending"]).toBe("$2.37");
    expect(map["Active days"]).toBe("23");
    expect(map["Blocks · 1 kept"]).toBe("9.75");
    expect(breakdown).not.toContain("boost"); // none earned all time in this fixture
  });
});
