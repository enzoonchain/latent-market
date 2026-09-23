/** Advertiser-icon inlining for the agent webviews. No vscode dependency. */

const MAX_INLINE_ICON_BYTES = 150_000;
const INLINE_ICON_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Fetch the advertiser icon and inline it as a data: URI. The agent webviews'
 * CSP only allows `img-src data:`, so a raw https URL would never load there.
 *
 * `image_url` is advertiser-controlled and this runs on the user's machine,
 * so only the ad server's own `/uploads/` images (validated and re-rasterized
 * server-side) are fetched, redirects are refused, and only raster types
 * under the size cap are inlined. Anything else resolves to "" and the
 * spinner keeps its own glyph.
 */
export async function inlineIcon(url: string, serverUrl: string): Promise<string> {
  try {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.origin !== new URL(serverUrl).origin) return "";
    if (!target.pathname.startsWith("/uploads/")) return "";
    const r = await fetch(target, { signal: AbortSignal.timeout(2000), redirect: "error" });
    if (!r.ok) return "";
    const contentType = (r.headers.get("content-type") || "").split(";")[0].trim();
    if (!INLINE_ICON_TYPES.has(contentType)) return "";
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_INLINE_ICON_BYTES) return "";
    return `data:${contentType};base64,${buf.toString("base64")}`;
  } catch {
    return "";
  }
}
