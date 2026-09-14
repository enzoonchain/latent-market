import { describe, it, expect } from "vitest";
import { sanitizeAdText } from "../src/lib/sanitize.js";

describe("sanitizeAdText", () => {
  it("strips ESC/CSI/OSC sequences", () => {
    expect(sanitizeAdText("\x1b[2J\x1b[Hpwned")).toBe("pwned");
    expect(sanitizeAdText("\x1b]0;evil title\x07visible")).toBe("visible");
  });

  it("strips raw control chars even without a recognised escape sequence", () => {
    expect(sanitizeAdText("a\x01\x02\x9bz")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  it("strips bidi override / isolate codepoints", () => {
    const withBidi = "safe‮text‬";
    expect(sanitizeAdText(withBidi)).toBe("safetext");
  });

  it("collapses whitespace and clamps with an ellipsis", () => {
    expect(sanitizeAdText("a   b\n\nc")).toBe("a b c");
    const long = sanitizeAdText("x".repeat(200), 10);
    expect(long.length).toBeLessThanOrEqual(10);
    expect(long.endsWith("…")).toBe(true);
  });

  it("preserves plain unicode text unchanged", () => {
    expect(sanitizeAdText("Café — 50% off")).toBe("Café — 50% off");
  });

  it("returns empty string for nullish input", () => {
    expect(sanitizeAdText(null)).toBe("");
    expect(sanitizeAdText(undefined)).toBe("");
  });
});
