import { describe, it, expect } from "vitest";
import { thinkingLine, formatFooter, isSafeUrl } from "../src/lib/footer.js";
import type { Ad } from "../src/lib/ad-client.js";

const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

describe("thinkingLine", () => {
  it("sanitizes ANSI/control-char injection in ad body and CTA text", () => {
    const ad: Ad = {
      ad_id: "1",
      body: "\x1b[2J\x1b[H PWNED",
      cta_text: "\x1b]0;evil\x07Click",
    };
    const line = thinkingLine(ad, "https://acme.example");
    expect(CTRL.test(line)).toBe(false);
    expect(line).toContain("PWNED"); // sanitized but not silently dropped
  });

  it("never emits an http:// or javascript: URL as a clickable target", () => {
    const ad: Ad = { ad_id: "1", body: "hi" };
    const line = thinkingLine(ad, "javascript:alert(1)");
    expect(line).not.toContain("javascript:alert(1)");
  });
});

describe("formatFooter", () => {
  it("sanitizes ad copy before it's appended to an outgoing chat message", () => {
    const ad: Ad = {
      ad_id: "1",
      body: "buy now\x1b[31m\x9b1m",
      cta_text: "go",
      earn_amount: 0.05,
    };
    const out = formatFooter(ad, "https://acme.example");
    expect(CTRL.test(out)).toBe(false);
  });
});

describe("isSafeUrl", () => {
  it("rejects non-https and control-char-bearing URLs", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("http://acme.example")).toBe(false);
    expect(isSafeUrl("https://acme.example/\x1b")).toBe(false);
    expect(isSafeUrl("https://acme.example")).toBe(true);
  });
});
