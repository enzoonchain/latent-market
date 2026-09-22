import { describe, it, expect } from "vitest";
import { checkBundleConflict, checkClaudeCliConflict, runAllChecks } from "../src/conflict.js";

describe("checkBundleConflict", () => {
  it("detects clean bundle", () => {
    const r = checkBundleConflict("var x = 1; console.log('hello');");
    expect(r.hasConflict).toBe(false);
  });

  it("detects Latent's own patch", () => {
    const r = checkBundleConflict("/* LATENT-START */ var x = 1; /* LATENT-END */");
    expect(r.hasConflict).toBe(false);
  });

  it("detects another tool's injected block, without naming it", () => {
    const r = checkBundleConflict("/* OTHER-ADS-START */ var x = 1; /* OTHER-ADS-END */");
    expect(r.hasConflict).toBe(true);
    expect(r.message).toMatch(/Another tool/);
  });

  it("flags a foreign block even next to Latent's own", () => {
    const r = checkBundleConflict("/* LATENT-START */ a /* LATENT-END */ /* FOO-START */ b /* FOO-END */");
    expect(r.hasConflict).toBe(true);
  });

  it("ignores lowercase or unrelated comments", () => {
    expect(checkBundleConflict("/* build-start */ var x;").hasConflict).toBe(false);
    expect(checkBundleConflict("// START here").hasConflict).toBe(false);
  });
});

describe("checkClaudeCliConflict", () => {
  it("returns a result without throwing", () => {
    const r = checkClaudeCliConflict();
    expect(r).toHaveProperty("hasConflict");
    expect(r).toHaveProperty("message");
    expect(r.target).toBe("claude-cli");
  });
});

describe("runAllChecks", () => {
  it("returns an array of checks", () => {
    const results = runAllChecks();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r).toHaveProperty("hasConflict");
      expect(r).toHaveProperty("message");
    }
  });
});
