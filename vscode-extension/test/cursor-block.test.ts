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

  it("renders an icon, an Open button, and a Copy button", () => {
    expect(block).toContain("data-latent-icon");
    expect(block).toContain("data-latent-open");
    expect(block).toContain("data-latent-copy");
    expect(block).toContain('textContent = "Open"');
  });

  it("docks to the composer box instead of the window center", () => {
    expect(block).toContain(".full-input-box");
    expect(block).toContain("composer-toolbar-section");
    expect(block).toContain("data-latent-dock");
    expect(block).toContain("elementsFromPoint");
    expect(block).toContain("/hello?build=");
    expect(block).toContain("earnAmount");
    expect(block).toContain('"+$"');
    expect(block).toContain("getBoundingClientRect");
    expect(block).not.toContain("bottom:72px");
    expect(block).not.toContain("translateX(-50%)");
  });

  it("is idempotent (guards against double-eval)", () => {
    expect(block).toContain("__latentCursorBoot");
  });

  it("wraps in an IIFE", () => {
    expect(block).toContain("(function()");
    expect(block).toContain("})();");
  });
});

describe("buildCursorBlock output", () => {
  const block = buildCursorBlock("http://127.0.0.1:5123/cb/tok123", 10, "web-dev");

  it("is valid JavaScript", () => {
    expect(() => new Function(block)).not.toThrow();
  });

  it("only navigates to the loopback chain or a plain https URL", () => {
    const loop = block.match(/\/\^http:\\\/\\\/127[^\s]*?\\\/\//)?.[0];
    const https = block.match(/\/\^https:\\\/\\\/\[\^\\s\]\+\$\/i/)?.[0];
    expect(loop).toBeTruthy();
    expect(https).toBeTruthy();
    const isLoop = new Function(`return ${loop}`)() as RegExp;
    const isHttps = new Function(`return ${https}`)() as RegExp;
    expect(isLoop.test("http://127.0.0.1:5123/cb/tok/click?adId=1")).toBe(true);
    expect(isLoop.test("http://127.0.0.1.evil.com/x")).toBe(false);
    expect(isHttps.test("https://example.com/a")).toBe(true);
    for (const bad of ["javascript:alert(1)", "vscode://x", "file:///etc/passwd", "http://example.com"]) {
      expect(isHttps.test(bad) || isLoop.test(bad)).toBe(false);
    }
  });
});
