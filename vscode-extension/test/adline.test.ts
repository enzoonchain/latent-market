import { describe, expect, it } from "vitest";
import { composeAdLine } from "../src/adline.js";

describe("composeAdLine", () => {
  it("puts the brand in front of the body", () => {
    expect(composeAdLine("Latent", "The ad marketplace for AI agents")).toBe(
      "Latent — The ad marketplace for AI agents",
    );
  });

  it("drops a brand the body already starts with", () => {
    expect(composeAdLine("Latent", "Latent — The ad marketplace")).toBe("Latent — The ad marketplace");
  });

  it("does not eat a longer word that only shares the brand prefix", () => {
    expect(composeAdLine("Acme", "AcmeLabs ships faster")).toBe("Acme — AcmeLabs ships faster");
  });

  it("clamps the body to 60 characters", () => {
    const body = "x".repeat(80);
    const line = composeAdLine("Brand", body);
    expect(line.startsWith("Brand — ")).toBe(true);
    expect(line.length).toBeLessThanOrEqual("Brand — ".length + 60);
    expect(line.endsWith("…")).toBe(true);
  });

  it("returns whichever side exists", () => {
    expect(composeAdLine("", "Only body")).toBe("Only body");
    expect(composeAdLine("Only brand", "")).toBe("Only brand");
  });
});
