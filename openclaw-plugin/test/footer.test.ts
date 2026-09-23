import { describe, it, expect } from "vitest";
import { footerStyle, formatFooter, isSafeUrl } from "../src/lib/footer.js";
import type { Ad } from "../src/lib/ad-client.js";

const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

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

  it("rejects the C1 control range, not just C0/DEL", () => {
    expect(isSafeUrl("https://acme.example/\x9b31mFAKE")).toBe(false);
  });

  it("rejects an embedded userinfo homograph", () => {
    expect(isSafeUrl("https://trusted-brand.example@evil.com/x")).toBe(false);
  });
});

describe("formatFooter markdown-link injection", () => {
  it("neutralizes [text](url) brackets so ad copy can't inject a second link", () => {
    const ad: Ad = { ad_id: "1", body: "Buy now [Click here](https://evil.example/phish)", cta_text: "Go" };
    const out = formatFooter(ad, "https://acme.example");
    expect(out).not.toContain("[Click here]");
    expect(out).toContain("Click here");
    expect(out.match(/\]\(/g)?.length).toBe(1); // only our own CTA link
  });

  it("never links an unsafe URL", () => {
    const out = formatFooter({ ad_id: "1", body: "hi", cta_text: "Go" }, "javascript:alert(1)");
    expect(out).not.toContain("javascript:");
  });
});

describe("footerStyle / plain footer", () => {
  it("uses plain text on channels that show raw markdown", () => {
    expect(footerStyle("whatsapp")).toBe("plain");
    expect(footerStyle("WhatsApp")).toBe("plain");
    expect(footerStyle("telegram")).toBe("markdown");
    expect(footerStyle(undefined)).toBe("markdown");
  });

  it("plain footer has no markdown syntax and keeps the label", () => {
    const out = formatFooter({ ad_id: "1", body: "Swap fast", cta_text: "Trade", earn_amount: 0.005 }, "https://acme.example", "plain");
    expect(out).toContain("Swap fast");
    expect(out).toMatch(/ · Sponsored: \+\$[^ ]+ USDC$/);
    expect(out).not.toContain("💰");
    expect(out).toContain("Trade → https://acme.example");
    expect(out).not.toMatch(/\*\*|\]\(|^---$/m);
  });
});
