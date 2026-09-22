/**
 * Hermes WebUI (nesquena/hermes-webui) surface — installed through the
 * WebUI's own extension system (docs/EXTENSIONS.md), never by editing its
 * source tree:
 *
 * - The ad script ships as a WebUI extension in the managed extension dir
 *   (`STATE_DIR/extensions/latent-ads/manifest.json`), recorded in
 *   `STATE_DIR/extension-install-manifest.json` exactly like a gallery
 *   install, so Settings → Extensions shows it and can disable it.
 * - The browser calls the Latent API directly. The only thing widened is
 *   CSP `connect-src`, through the documented `HERMES_WEBUI_CSP_CONNECT_EXTRA`
 *   knob in the WebUI's `.env` (loaded by start.sh / ctl.sh / bootstrap.py).
 *
 * Older releases patched server.py / api/auth.py / api/routes.py to add an
 * unauthenticated proxy and exempted any path containing "/api/latent/" from
 * auth and CSRF. `removeLegacyWebuiPatches` strips every one of those edits;
 * init and uninstall both run it.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { templatePath } from "../pkg.js";

export const EXTENSION_ID = "latent-ads";
export const EXTENSION_VERSION = "1.0.0";
export const CSP_CONNECT_EXTRA_KEY = "HERMES_WEBUI_CSP_CONNECT_EXTRA";
const CSP_ENV_COMMENT = "# Latent Protocol: allow WebUI browser fetches to the ad API";
const INSTALL_MANIFEST = "extension-install-manifest.json";
const EXTENSION_FILES = ["manifest.json", "latent-ads.js", "latent-ads.css"];

/** Origin only (no path) for CSP connect-src allowlisting. */
export function apiOrigin(server: string): string {
  try {
    return new URL(server).origin;
  } catch {
    return server.replace(/\/+$/, "");
  }
}

// ── .env helpers ──────────────────────────────────────────────────────────

function readEnvValue(envPath: string, key: string): string | undefined {
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*(.*)$`));
      if (m) return unquote((m[1] ?? "").trim());
    }
  } catch {
    // no .env
  }
  return undefined;
}

function unquote(val: string): string {
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

/** Add `origin` to HERMES_WEBUI_CSP_CONNECT_EXTRA in `envPath` (idempotent). */
export function upsertCspConnectExtra(
  envPath: string,
  origin: string,
): { ok: true; path: string; created: boolean } | { ok: false; error: string } {
  if (!/^https?:\/\/[^/\s]+$/i.test(origin)) {
    return { ok: false, error: `invalid CSP origin: ${origin}` };
  }
  try {
    mkdirSync(dirname(envPath), { recursive: true });
    const existed = existsSync(envPath);
    const raw = existed ? readFileSync(envPath, "utf8") : "";
    const lines = raw.length ? raw.split(/\r?\n/) : [];
    let found = false;
    const next = lines.map((line) => {
      const m = line.match(new RegExp(`^(export\\s+)?${CSP_CONNECT_EXTRA_KEY}\\s*=\\s*(.*)$`));
      if (!m) return line;
      found = true;
      const parts = unquote((m[2] ?? "").trim()).split(/\s+/).filter(Boolean);
      if (!parts.includes(origin)) parts.push(origin);
      return `${m[1] ? "export " : ""}${CSP_CONNECT_EXTRA_KEY}=${parts.join(" ")}`;
    });
    if (!found) {
      if (next.length && next[next.length - 1] !== "") next.push("");
      next.push(CSP_ENV_COMMENT, `${CSP_CONNECT_EXTRA_KEY}=${origin}`);
    }
    let out = next.join("\n");
    if (!out.endsWith("\n")) out += "\n";
    // .env holds secrets (WebUI password, provider keys) — keep it private.
    writeFileSync(envPath, out, { encoding: "utf8", mode: 0o600 });
    chmodSync(envPath, 0o600); // `mode` only applies when the file is created
    return { ok: true, path: envPath, created: !existed };
  } catch (err) {
    return { ok: false, error: `cannot update ${envPath}: ${errMsg(err)}` };
  }
}

/** Remove `origins` from HERMES_WEBUI_CSP_CONNECT_EXTRA; drops the line (and
 *  our comment) when nothing else is left. Returns whether the file changed. */
export function removeCspConnectExtra(envPath: string, origins: string[]): boolean {
  if (!existsSync(envPath)) return false;
  const raw = readFileSync(envPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(new RegExp(`^(export\\s+)?${CSP_CONNECT_EXTRA_KEY}\\s*=\\s*(.*)$`));
    if (!m) {
      out.push(line);
      continue;
    }
    const parts = unquote((m[2] ?? "").trim()).split(/\s+/).filter(Boolean);
    const kept = parts.filter((p) => !origins.includes(p));
    if (kept.length === parts.length) {
      out.push(line);
      continue;
    }
    changed = true;
    if (kept.length) {
      out.push(`${m[1] ? "export " : ""}${CSP_CONNECT_EXTRA_KEY}=${kept.join(" ")}`);
    } else if (out[out.length - 1] === CSP_ENV_COMMENT) {
      out.pop();
      // upsert separated our block with one blank line; drop it too when the
      // block was the tail of the file.
      const restIsBlank = lines.slice(i + 1).every((l) => l === "");
      if (restIsBlank && out[out.length - 1] === "") out.pop();
    }
  }
  if (!changed) return false;
  const next = out.join("\n");
  if (next.trim() === "") rmSync(envPath, { force: true }); // only ever held our entry
  else writeFileSync(envPath, next, { encoding: "utf8", mode: 0o600 });
  return true;
}

// ── Paths ─────────────────────────────────────────────────────────────────

export interface WebuiPaths {
  webuiRoot: string;
  stateDir: string;
  extensionRoot: string;
  envPath: string;
}

/** Same resolution the WebUI uses: env (then its .env) for
 *  HERMES_WEBUI_STATE_DIR / HERMES_WEBUI_EXTENSION_DIR, else the managed
 *  defaults under ~/.hermes/webui. */
export function webuiPaths(staticDir: string, home = homedir()): WebuiPaths {
  const webuiRoot = dirname(staticDir);
  const envPath = join(webuiRoot, ".env");
  const expand = (p: string) => (p.startsWith("~/") ? join(home, p.slice(2)) : p);
  const stateDir = expand(
    process.env.HERMES_WEBUI_STATE_DIR ||
      readEnvValue(envPath, "HERMES_WEBUI_STATE_DIR") ||
      join(home, ".hermes", "webui"),
  );
  const extensionRoot = expand(
    process.env.HERMES_WEBUI_EXTENSION_DIR ||
      readEnvValue(envPath, "HERMES_WEBUI_EXTENSION_DIR") ||
      join(stateDir, "extensions"),
  );
  return { webuiRoot, stateDir, extensionRoot, envPath };
}

// ── Extension install ─────────────────────────────────────────────────────

function templateOnce(source: string, token: string, value: string): string {
  const count = source.split(token).length - 1;
  if (count !== 1) throw new Error(`expected exactly one ${token} placeholder, found ${count}`);
  return source.replace(token, () => value);
}

/** Renders the extension script with JSON-encoded config (never interpolated). */
export function renderExtensionScript(opts: {
  server: string;
  wallet: string;
  deviceId?: string;
  frequency?: number;
}): string {
  const raw = readFileSync(join(templatePath("hermes-webui-extension"), "latent-ads.js"), "utf8");
  const wallet = /^0x[0-9a-fA-F]{40}$/.test(opts.wallet) ? opts.wallet : "";
  const device = /^[0-9a-f]{8,64}$/i.test(opts.deviceId ?? "") ? opts.deviceId! : "";
  const frequency = Math.max(1, Math.floor(Number(opts.frequency) || 1));
  let js = templateOnce(raw, "__SERVER__", JSON.stringify(opts.server.replace(/\/+$/, "")));
  js = templateOnce(js, "__WALLET__", JSON.stringify(wallet));
  js = templateOnce(js, "__DEVICE_ID__", JSON.stringify(device));
  js = templateOnce(js, "__FREQUENCY__", String(frequency));
  return js;
}

function writeAtomic(path: string, data: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  renameSync(tmp, path);
}

function loadInstallManifest(path: string): { version: number; installed: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.installed && typeof parsed.installed === "object") {
      return { version: 1, ...parsed };
    }
  } catch {
    // missing / malformed → start fresh, like the WebUI does
  }
  return { version: 1, installed: {} };
}

export function installWebuiExtension(opts: {
  staticDir: string;
  server: string;
  wallet: string;
  deviceId?: string;
  frequency?: number;
  home?: string;
}): { ok: true; dir: string; csp: string } | { ok: false; error: string } {
  const paths = webuiPaths(opts.staticDir, opts.home);
  const dir = join(paths.extensionRoot, EXTENSION_ID);
  try {
    const tpl = templatePath("hermes-webui-extension");
    writeAtomic(join(dir, "manifest.json"), readFileSync(join(tpl, "manifest.json"), "utf8"));
    writeAtomic(join(dir, "latent-ads.css"), readFileSync(join(tpl, "latent-ads.css"), "utf8"));
    writeAtomic(join(dir, "latent-ads.js"), renderExtensionScript(opts));

    const recordPath = join(paths.stateDir, INSTALL_MANIFEST);
    const record = loadInstallManifest(recordPath);
    record.installed[EXTENSION_ID] = {
      version: EXTENSION_VERSION,
      files: EXTENSION_FILES,
      installed_at: new Date().toISOString(),
    };
    writeAtomic(recordPath, JSON.stringify(record, null, 2));
  } catch (err) {
    return { ok: false, error: `cannot install WebUI extension: ${errMsg(err)}` };
  }

  const origin = apiOrigin(opts.server);
  const csp = upsertCspConnectExtra(paths.envPath, origin);
  return {
    ok: true,
    dir,
    csp: csp.ok ? `${CSP_CONNECT_EXTRA_KEY} += ${origin} (${csp.path})` : `⚠️  ${csp.error}`,
  };
}

export function uninstallWebuiExtension(opts: {
  staticDir: string;
  server: string;
  home?: string;
}): string[] {
  const paths = webuiPaths(opts.staticDir, opts.home);
  const lines: string[] = [];
  const dir = join(paths.extensionRoot, EXTENSION_ID);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    lines.push(`✅ Removed WebUI extension ${dir}`);
  }
  const recordPath = join(paths.stateDir, INSTALL_MANIFEST);
  if (existsSync(recordPath)) {
    const record = loadInstallManifest(recordPath);
    if (EXTENSION_ID in record.installed) {
      delete record.installed[EXTENSION_ID];
      writeAtomic(recordPath, JSON.stringify(record, null, 2));
      lines.push(`✅ Unregistered ${EXTENSION_ID} in ${recordPath}`);
    }
  }
  if (removeCspConnectExtra(paths.envPath, [apiOrigin(opts.server)])) {
    lines.push(`✅ Removed the Latent origin from ${CSP_CONNECT_EXTRA_KEY} in ${paths.envPath}`);
  }
  return lines;
}

export function webuiExtensionInstalled(staticDir: string, home?: string): boolean {
  const paths = webuiPaths(staticDir, home);
  return (
    existsSync(join(paths.extensionRoot, EXTENSION_ID, "manifest.json")) &&
    EXTENSION_ID in loadInstallManifest(join(paths.stateDir, INSTALL_MANIFEST)).installed
  );
}

// ── Legacy cleanup (security) ─────────────────────────────────────────────

const LEGACY_MARKED_BLOCKS: [string, string][] = [
  ["# latent-protocol-proxy-begin", "# latent-protocol-proxy-end"],
  ["# latent-protocol-auth-exempt-begin", "# latent-protocol-auth-exempt-end"],
  ["# latent-protocol-auth-shadow-begin", "# latent-protocol-auth-shadow-end"],
  ["# latent-protocol-pre-auth-begin", "# latent-protocol-pre-auth-end"],
  ["# latent-protocol-csrf-exempt-begin", "# latent-protocol-csrf-exempt-end"],
  ["# latent-protocol-nuclear-begin", "# latent-protocol-nuclear-end"],
];
const LEGACY_PROXY_MARKER = "# latent-protocol-proxy";
const LEGACY_INDEX_MARKER = "<!-- latent-protocol-webui-patch -->";
const LEGACY_CSP_SOURCE_MARKER = "# latent-protocol-csp-connect";
const LEGACY_CTL_MARKER = "# latent-protocol-csp-connect-ctl";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove one inserted block. Insertions were always `<block>\n` placed at a
 *  line boundary (after a matched line, or before one), so removing exactly
 *  the block's own lines restores the original bytes. */
function stripBlock(src: string, begin: string, end: string): string {
  // The nuclear wrap was inserted as `<block>\n\n` before `if __name__…`.
  const trailing = begin.includes("nuclear") ? "\\n\\n?" : "\\n";
  return src.replace(
    new RegExp(`[ \\t]*${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}[^\\n]*${trailing}`, "g"),
    "",
  );
}

/** Undo the old CSP source edits: the rewritten f-string needle, the appended
 *  `_CSP_CONNECT_BASE` line, and an inline connect-src append of `origin`. */
function stripCspSource(src: string, origins: string[]): string {
  let out = src.replace(
    new RegExp(`\\n${escapeRe(LEGACY_CSP_SOURCE_MARKER)}\\n_CSP_CONNECT_BASE = _CSP_CONNECT_BASE \\+ "[^"]*"\\n`, "g"),
    "\n",
  );
  out = out.replace(/https:\/\/cdn\.jsdelivr\.net https?:\/\/[^\s{"']+\{extra_connect_src\}/g, "https://cdn.jsdelivr.net{extra_connect_src}");
  for (const origin of origins) {
    out = out.replace(
      new RegExp(`(connect-src[^"'\\n]*https://cdn\\.jsdelivr\\.net) ${escapeRe(origin)}`, "g"),
      "$1",
    );
  }
  return out;
}

function stripIndexPatch(html: string): string {
  const i = html.indexOf(LEGACY_INDEX_MARKER);
  if (i < 0) return html;
  const end = html.indexOf("</script>", i);
  if (end < 0) return html;
  let start = i;
  if (html[start - 1] === "\n") start -= 1;
  let stop = end + "</script>".length;
  if (html[stop] === "\n") stop += 1;
  return html.slice(0, start) + html.slice(stop);
}

/**
 * Strip every source edit older releases made to a WebUI checkout. Safe to run
 * on an unpatched tree (no-op). Returns one line per file it cleaned.
 */
export function removeLegacyWebuiPatches(staticDir: string, origins: string[]): string[] {
  const root = dirname(staticDir);
  const cleaned: string[] = [];
  const edit = (path: string, fn: (src: string) => string) => {
    if (!existsSync(path)) return;
    const src = readFileSync(path, "utf8");
    const next = fn(src);
    if (next !== src) {
      writeFileSync(path, next, "utf8");
      cleaned.push(path);
    }
  };
  const blocks = (src: string) =>
    LEGACY_MARKED_BLOCKS.reduce((acc, [b, e]) => stripBlock(acc, b, e), src);

  edit(join(root, "server.py"), (s) => stripCspSource(blocks(s), origins));
  edit(join(root, "api", "auth.py"), blocks);
  edit(join(root, "api", "routes.py"), blocks);
  edit(join(root, "api", "helpers.py"), (s) => stripCspSource(s, origins));
  edit(join(root, "helpers.py"), (s) => stripCspSource(s, origins));
  edit(join(root, "ctl.sh"), (s) =>
    s.replace(new RegExp(`${escapeRe(LEGACY_CTL_MARKER)}\\nexport ${CSP_CONNECT_EXTRA_KEY}=.*\\n`, "g"), ""),
  );
  edit(join(staticDir, "index.html"), stripIndexPatch);

  const proxy = join(root, "api", "latent_ads_proxy.py");
  if (existsSync(proxy) && readFileSync(proxy, "utf8").includes(LEGACY_PROXY_MARKER)) {
    rmSync(proxy, { force: true });
    cleaned.push(`${proxy} (deleted)`);
  }
  return cleaned;
}

/** True if any legacy source edit is still present. */
export function hasLegacyWebuiPatches(staticDir: string): boolean {
  const root = dirname(staticDir);
  const files = [
    join(root, "server.py"),
    join(root, "api", "auth.py"),
    join(root, "api", "routes.py"),
    join(root, "api", "latent_ads_proxy.py"),
    join(staticDir, "index.html"),
  ];
  return files.some((f) => {
    try {
      const s = readFileSync(f, "utf8");
      return s.includes("# latent-protocol-") || s.includes(LEGACY_INDEX_MARKER);
    } catch {
      return false;
    }
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
