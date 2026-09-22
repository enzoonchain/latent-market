import { describe, it, expect } from "vitest";
import { buildCursorBlock, CURSOR_MARK_START, CURSOR_MARK_END } from "../src/cursor-block.js";

describe("buildCursorBlock", () => {
  const block = buildCursorBlock("http://127.0.0.1:5123/cb/tok123", 10, "web-dev");

  it("contains LATENT markers", () => {
    expect(block).toContain(CURSOR_MARK_START);
    expect(block).toContain(CURSOR_MARK_END);
  });

  it("bakes in the loopback config", () => {
    expect(block).toContain("http://127.0.0.1:5123/cb/tok123");
    expect(block).toContain("web-dev");
  });

  it("uses sendBeacon with text/plain for CORS safety", () => {
    expect(block).toContain("sendBeacon");
    expect(block).toContain("text/plain");
  });

  it("detects Cursor busy state via codicon-debug-stop", () => {
    expect(block).toContain("codicon-debug-stop");
  });

  it("has fallback busy detection via data-streaming", () => {
    expect(block).toContain("data-streaming");
  });

  it("reports viewability funnel events", () => {
    expect(block).toContain("impression_viewable");
    expect(block).toContain("view_tick");
    expect(block).toContain("view_threshold_met");
  });

  it("is idempotent (guards against double-eval)", () => {
    expect(block).toContain("__latentCursorBoot");
  });

  it("wraps in an IIFE", () => {
    expect(block).toContain("(function()");
    expect(block).toContain("})();");
  });
});
