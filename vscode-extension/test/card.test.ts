import { describe, it, expect } from "vitest";
import { cardHtml } from "../src/card.js";
import { isSafeHttpUrl, sanitizeText } from "../src/urlsafe.js";

// Control chars minus the newlines/tabs our own HTML template contains.
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

describe("isSafeHttpUrl", () => {
  it("accepts only well-formed https URLs", () => {
    expect(isSafeHttpUrl("https://acme.example/x?y=1")).toBe(true);
    expect(isSafeHttpUrl("HTTPS://acme.example")).toBe(true);
  });
  it("rejects javascript:/data:/http:/malformed", () => {
    for (const u of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "http://acme.example",
      "vbscript:x",
      "  https://acme.example",
      "https://acme.example/\x1b",
      "not a url",
      "",
      null,
      undefined,
      123,
    ]) {
      expect(isSafeHttpUrl(u as unknown)).toBe(false);
    }
  });
});

describe("cardHtml", () => {
  it("never emits an <a href> for a non-https url", () => {
    for (const url of ["javascript:alert(document.cookie)", "data:text/html,x", "http://e.x"]) {
      const html = cardHtml({ text: "hi", url }, "0xabc0000000000000000000000000000000000000");
      expect(html).not.toMatch(/<a\s+href=/i);
      expect(html.toLowerCase()).not.toContain("javascript:");
      expect(html).not.toContain("data:text/html");
    }
  });

  it("renders an <a href> for an https url, HTML-escaped", () => {
    const html = cardHtml({ text: "Try Acme", url: 'https://acme.example/x?a="b"&c=<d>' }, "0xabc");
    expect(html).toMatch(/<a href="https:\/\/acme\.example\/x\?a=&quot;b&quot;&amp;c=&lt;d&gt;"/);
  });

  it("prefers the loopback /click chain over the raw cta_url", () => {
    const html = cardHtml(
      { text: "Try Acme", url: "https://acme.example", clickHref: "http://127.0.0.1:5123/cb/t/click?adId=a1" },
      "0xabc",
    );
    expect(html).toMatch(/<a href="http:\/\/127\.0\.0\.1:5123\/cb\/t\/click\?adId=a1"/);
  });

  it("ignores a non-loopback clickHref (injection guard)", () => {
    const html = cardHtml(
      { text: "Try Acme", url: "javascript:alert(1)", clickHref: "https://evil.example/steal" },
      "0xabc",
    );
    expect(html).not.toMatch(/<a\s+href=/i);
  });

  it("HTML-escapes and control-strips the ad text", () => {
    const html = cardHtml(
      { text: "<img src=x onerror=alert(1)>\x1b[2J\x9b31m", url: "" },
      "0xabc",
    );
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(CTRL.test(html)).toBe(false);
  });

  it("carries a restrictive CSP meta", () => {
    const html = cardHtml(null, "", "vscode-webview://abc");
    expect(html).toMatch(/Content-Security-Policy/);
    expect(html).toMatch(/default-src 'none'/);
  });
});

describe("sanitizeText", () => {
  it("strips control chars + bidi, clamps", () => {
    expect(CTRL.test(sanitizeText("a\x1b[31mbc"))).toBe(false);
    expect(sanitizeText("x".repeat(100), 10).length).toBeLessThanOrEqual(10);
    expect(sanitizeText("plain ok")).toBe("plain ok");
  });
});
