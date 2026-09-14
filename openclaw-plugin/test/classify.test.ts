import { describe, it, expect } from "vitest";
import { classifyMessage } from "../src/lib/classify.js";

describe("classifyMessage", () => {
  it("picks the category with the most keyword hits", () => {
    expect(classifyMessage("help me fix this react component's tsx props")).toBe("frontend-ui");
    expect(classifyMessage("write a fastapi endpoint with jwt auth middleware")).toBe("backend");
    expect(classifyMessage("optimize this postgres query and add an index")).toBe("databases");
    expect(classifyMessage("deploy this docker container to kubernetes via terraform")).toBe(
      "devops-infra",
    );
    expect(classifyMessage("write solidity for an erc20 token on base")).toBe("web3-crypto");
  });

  it("falls back to general with no keyword hits", () => {
    expect(classifyMessage("what's a good name for my cat")).toBe("general");
    expect(classifyMessage("")).toBe("general");
    expect(classifyMessage(null)).toBe("general");
    expect(classifyMessage(undefined)).toBe("general");
  });

  it("never needs the raw message to leave the caller — output is always one of the fixed slugs", () => {
    const secrets = "sk-live-abc123 my ssn is 000-00-0000, prompt: react app with a fastapi backend";
    const category = classifyMessage(secrets);
    // The real guarantee: the output is always one of the ~9 fixed slugs,
    // never a derivative of the input (a substring/prefix/hash of it would
    // still technically satisfy `not.toContain(secrets)` without meeting
    // the actual privacy invariant, so assert membership in the fixed set
    // directly instead).
    const ALL_SLUGS = [
      "frontend-ui", "backend", "databases", "devops-infra",
      "ai-ml", "web3-crypto", "mobile", "data-eng", "general",
    ];
    expect(ALL_SLUGS).toContain(category);
    expect(category.length).toBeLessThan(20);
  });

  it("repeated occurrences of the same keyword all count (lookahead boundary regression)", () => {
    // A consumed trailing boundary would eat the single space between two
    // adjacent occurrences of the same word, undercounting hits.
    expect(classifyMessage("docker docker docker deploy")).toBe("devops-infra");
  });
});
