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
  /** Inlined raster icon from the loopback. Anything else is dropped. */
  iconUrl?: string;
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
    ? `<a class="open" href="${escapeHtml(clickHref)}" rel="noreferrer">Open</a>`
    : "";
  const shownUrl = ad && isSafeHttpUrl(ad.url) ? escapeHtml(ad.url) : "";
  const icon =
    ad?.iconUrl && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(ad.iconUrl)
      ? `<img alt="" src="${escapeHtml(ad.iconUrl)}">`
      : "";
  const body = ad
    ? `<div class="ad"><div class="row">${icon}<div class="txt">${escapeHtml(
        sanitizeText(ad.text, 200),
      )}</div></div>${shownUrl ? `<div class="url">${shownUrl}</div>` : ""}${link}<div class="tag">Sponsored</div></div>`
    : `<div class="idle">No sponsor right now — you still earn while your agent thinks.</div>`;
  const styleSrc = cspSource ? `${cspSource} 'unsafe-inline'` : "'unsafe-inline'";
  const imgSrc = `${cspSource ? `${cspSource} ` : ""}data:`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${styleSrc}; img-src ${imgSrc}">
  <style>
    body{font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)}
    .ad{border:1px solid var(--vscode-widget-border,rgba(128,128,128,.35));border-radius:8px;padding:10px}
    .row{display:flex;align-items:center;gap:8px}
    img{width:16px;height:16px;border-radius:4px;object-fit:cover;flex:none}
    .tag{margin-top:8px;font-size:10px;opacity:.6}
    .txt{font-size:13px;line-height:1.35}
    .url{margin:8px 0;font-size:11px;line-height:1.4;word-break:break-all;user-select:text;color:var(--vscode-textLink-foreground)}
    a.open{display:inline-block;margin-top:8px;text-decoration:none;border-radius:999px;padding:3px 10px;font-size:12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
    .wallet{margin-top:14px;font-size:11px;opacity:.6}
    .idle{font-size:12px;opacity:.7}
  </style></head><body>${body}<div class="wallet">Earnings wallet: ${escapeHtml(w)}</div></body></html>`;
}
