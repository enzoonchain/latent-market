import { describe, it, expect } from "vitest";
import { buildBlock, MARK_START, MARK_END } from "../src/block.js";

describe("buildBlock", () => {
  const block = buildBlock("http://127.0.0.1:5123/cb/tok123", 10, "ml");

  it("contains LATENT markers", () => {
    expect(block).toContain(MARK_START);
    expect(block).toContain(MARK_END);
  });

  it("bakes in the loopback config", () => {
    expect(block).toContain("http://127.0.0.1:5123/cb/tok123");
    expect(block).toContain("ml");
  });

  it("is idempotent (guards against double-eval)", () => {
    expect(block).toContain("__latentActive");
    expect(block).toContain("&pane=");
  });

  it("paints on document.body and does not mutate the spinner row", () => {
    expect(block).toContain("document.body");
    expect(block).toContain("position:fixed");
    expect(block).not.toContain("MutationObserver");
    expect(block).not.toContain("s.appendChild");
  });

  it("wraps in a fail-open IIFE", () => {
    expect(block).toContain("(function()");
    expect(block).toContain("})();");
    expect(block).toContain("fail open");
  });

  it("bills exactly one signed impression per ad cycle", () => {
    expect(block).toContain("/impression");
    expect(block).toContain("displayedMs");
    expect(block).toContain("token: ad.token");
    // one-bill-per-cycle guard
    expect(block).toContain("billed");
  });

  it("sends the impression at the view threshold or with honest dwell at cycle end", () => {
    expect(block).toContain("MIN_VIEW_MS = 10000");
    expect(block).toContain("view_threshold_met");
    expect(block).toContain("error_impression");
  });

  it("reports the viewability funnel through the loopback", () => {
    expect(block).toContain("impression_rendered");
    expect(block).toContain("impression_viewable");
    expect(block).toContain("view_tick");
    expect(block).toContain("/metric");
  });

  it("makes the click a real anchor through the loopback /click chain", () => {
    expect(block).toContain("createElement('a')");
    expect(block).toContain("clickHref");
    expect(block).toContain("/click");
    // href guard: only the loopback chain is ever set as the anchor href
    expect(block).toContain("http://127.0.0.1");
    expect(block).toContain("isLoopback");
  });

  it("keeps the fetch click twin best-effort with keepalive", () => {
    expect(block).toContain("keepalive: true");
    expect(block).toContain("surface: 'spinner'");
  });

  it("only ever talks to the baked loopback base", () => {
    // No absolute ad-server hosts may appear — everything goes through CFG.base.
    expect(block).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)[a-z]/i);
  });

  it("sanitizes rendered text", () => {
    expect(block).toContain("clean(");
  });
});

describe("buildBlock output", () => {
  const block = buildBlock("http://127.0.0.1:5123/cb/tok123", 10, "ml");

  it("is valid JavaScript", () => {
    expect(() => new Function(block)).not.toThrow();
  });

  it("only treats a real 127.0.0.1:<port>/ URL as the loopback click chain", () => {
    const src = block.match(/function isLoopback\(v\)\{[^}]*\}/)?.[0];
    expect(src).toBeTruthy();
    const isLoopback = new Function(`${src}; return isLoopback;`)() as (v: string) => boolean;
    expect(isLoopback("http://127.0.0.1:5123/cb/tok/click?adId=1")).toBe(true);
    expect(isLoopback("http://127.0.0.1.evil.com/x")).toBe(false);
    expect(isLoopback("javascript:alert(1)")).toBe(false);
  });

  it("is valid JavaScript once injected", () => {
    const body = block.slice(block.indexOf(MARK_START) + MARK_START.length, block.indexOf(MARK_END));
    expect(() => new Function(body)).not.toThrow();
  });

  it("uses a quiet trailing tag, no emoji", () => {
    expect(block).toContain("\u00b7 Sponsored");
    expect(block).not.toMatch(/\u{1F4A1}|\u{1F4B0}/u);
  });

  it("only swaps the spinner glyph for an inlined raster data: icon", () => {
    const src = block.match(/function isDataImage\(v\)\{ return (\/.*\/)\.test/)![1];
    const re = new Function(`return ${src}`)() as RegExp;
    expect(re.test("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(re.test("https://tracker.example/pixel.png")).toBe(false);
    expect(re.test("data:image/svg+xml;base64,PHN2Zy8+")).toBe(false);
    expect(re.test('data:image/png;base64,AAAA")/**/;x')).toBe(false);
    expect(block).toContain("restoreGlyph()");
  });
});
