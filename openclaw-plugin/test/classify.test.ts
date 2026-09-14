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
    expect(category).not.toContain(secrets);
    expect(["frontend-ui", "backend", "general"]).toContain(category);
  });
});
