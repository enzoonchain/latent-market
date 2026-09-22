/**
 * The sidebar "ad card" HTML. Pure (no `vscode` import) so it can be unit
 * tested. Advertiser `text` / `url` are untrusted: the body is HTML-escaped
 * and control-stripped, and a link is rendered ONLY for a real `https://` URL
 * (`escapeHtml` alone does not stop a `javascript:` href, and this webview
 * would run it).
 */
import { isSafeHttpUrl, sanitizeText } from "./urlsafe.js";

export interface CardAd {
  text: string;
  url: string;
  /** Loopback /click 302-chain URL (credits the click, redirects on to the
   * advertiser). Set by the loopback /ad route — never carries secrets. */
  clickHref?: string;
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c,
  );
}

export function cardHtml(ad: CardAd | null, wallet: string, cspSource = ""): string {
  const w = wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "not set";
  // Prefer the loopback /click 302 chain (it credits the click and redirects
  // on to the advertiser); fall back to the raw https cta_url. A link is
  // rendered only for the loopback chain or a real `https://` URL.
  const clickHref =
    ad?.clickHref && /^http:\/\/127\.0\.0\.1:\d+\//.test(ad.clickHref)
      ? ad.clickHref
      : ad && isSafeHttpUrl(ad.url)
        ? ad.url
        : "";
  const link = clickHref
    ? `<a href="${escapeHtml(clickHref)}" rel="noreferrer">Learn more →</a>`
    : "";
  const body = ad
    ? `<div class="ad"><div class="tag">💡 Sponsored</div><div class="txt">${escapeHtml(
        sanitizeText(ad.text, 200),
      )}</div>${link}</div>`
    : `<div class="idle">No sponsor right now — you still earn while your agent thinks.</div>`;
  const styleSrc = cspSource ? `${cspSource} 'unsafe-inline'` : "'unsafe-inline'";
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${styleSrc}; img-src ${cspSource || "'none'"}">
  <style>
    body{font-family:var(--vscode-font-family);padding:10px;color:var(--vscode-foreground)}
    .tag{font-size:11px;opacity:.7;text-transform:uppercase;letter-spacing:.05em}
    .txt{margin:6px 0;font-size:13px}
    a{color:var(--vscode-textLink-foreground)}
    .wallet{margin-top:14px;font-size:11px;opacity:.6}
    .idle{font-size:12px;opacity:.7}
  </style></head><body>${body}<div class="wallet">Earnings wallet: ${escapeHtml(w)}</div></body></html>`;
}
