/** One sponsor line: brand, then the product sentence. Shared by the loopback. */

const WORD = /[\p{L}\p{N}]/u;
const LEAD_SEP = /^[\s\-:–—]+/;

export const BRAND_MAX = 30;
export const BODY_MAX = 60;

function clampField(value: string, max: number): string {
  const t = value.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Drop a leading brand (and the separator after it) so the line doesn't say it twice. */
export function dedupeBrand(brand: string, body: string): string {
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

/** `Brand — body`. Brand ≤ 30, body ≤ 60. Empty side is omitted. */
export function composeAdLine(title: unknown, body: unknown): string {
  const brandRaw = typeof title === "string" ? title : "";
  const bodyRaw = typeof body === "string" ? body : "";
  const line = clampField(dedupeBrand(brandRaw, bodyRaw), BODY_MAX);
  const brand = clampField(brandRaw, BRAND_MAX);
  if (brand && line) return `${brand} — ${line}`;
  return brand || line;
}
