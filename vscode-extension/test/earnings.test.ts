import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchEarnings } from "../src/earnings.js";

const stub = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

afterEach(() => vi.unstubAllGlobals());

describe("fetchEarnings", () => {
  it("returns the real balance on 200", async () => {
    stub(200, { balance: 1.2345, tier: "gold" });
    expect(await fetchEarnings("https://s", "0xabc")).toEqual({
      kind: "ok",
      balance: 1.2345,
      totalEarned: 0,
      impressions: 0,
      clicks: 0,
      tier: "gold",
    });
  });

  it("treats 401 (unsigned read, server #100) as private — not $0.00", async () => {
    stub(401, { detail: "ownership proof: missing signature" });
    expect(await fetchEarnings("https://s", "0xabc")).toEqual({ kind: "auth" });
  });

  it("treats 5xx and a balance-less body as errors", async () => {
    stub(500, {});
    expect((await fetchEarnings("https://s", "0xabc")).kind).toBe("error");
    stub(200, { detail: "x" });
    expect((await fetchEarnings("https://s", "0xabc")).kind).toBe("error");
  });

  it("treats a network failure as an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect((await fetchEarnings("https://s", "0xabc")).kind).toBe("error");
  });
});
