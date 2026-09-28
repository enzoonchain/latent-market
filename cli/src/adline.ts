import { sanitizeAdText } from "./sanitize.js";

const WORD = /[\p{L}\p{N}]/u;
const LEAD_SEP = /^[\s\-:–—]+/;

function clampField(value: string, max: number): string {
  const t = value.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function dedupeBrand(brand: string, body: string): string {
  let t = body.trim();
  const b = brand.trim();
  if (!b) return t;
  const lb = b.toLowerCase();
  while (t.toLowerCase().startsWith(lb)) {
    const after = t.charAt(b.length);
    if (after !== "" && WORD.test(after)) break;
    const rest = t.slice(b.length).replace(LEAD_SEP, "");
    if (rest === t) break;
    t = rest;
    if (t === "") break;
  }
  return t;
}

/** `Brand — body`. Brand ≤ 30, body ≤ 60. */
export function composeAdLine(title?: string | null, body?: string | null): string {
  const brandRaw = sanitizeAdText(title, 0);
  const bodyRaw = sanitizeAdText(body, 0);
  const line = clampField(dedupeBrand(brandRaw, bodyRaw), 60);
  const brand = clampField(brandRaw, 30);
  if (brand && line) return `${brand} — ${line}`;
  return brand || line;
}

/** Host, path, and query. The https scheme stays off the visible line. */
export function displayUrl(url: string): string {
  return url.startsWith("https://") ? url.slice("https://".length) : "";
}
