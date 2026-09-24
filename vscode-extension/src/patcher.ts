/**
 * Agent-bundle patcher (advanced / invasive path).
 *
 * Locates an installed Claude Code / Codex (ChatGPT) editor extension, and —
 * only when the user opts in — installs the LATENT block so the sponsor line
 * renders inside the agent's own spinner. Claude Code gets the block appended
 * to webview/index.js. Codex gets it spliced into the thinking-shimmer
 * renderer (the function that paints loading-shimmer-pure-text), which is the
 * function the panel actually calls. Every change is reversible: a pristine
 * `.latent-backup` is written before the first edit, the block is
 * marker-delimited, and `restore()` puts the original bytes back and removes
 * the CSP relaxation.
 *
 * This modifies a third-party signed extension and relaxes CSP only inside the
 * webview bundle, so the sponsor script can reach the 127.0.0.1 loopback. The
 * extension host module (`package.json` `main`, usually `extension.js`) is
 * never rewritten: a syntax error there kills Claude Code and Codex together.
 * It is off by default and gated behind an explicit command / setting.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MARK_START, MARK_END } from "./block.js";

const BACKUP_SUFFIX = ".latent-backup";

/** Spinner "verb anchors" — presence confirms a known/compatible webview build. */
const VERB_ANCHORS = ["Discombobulating", "Clauding", "Reticulating", "Flibbertigibbeting", "Thinking"];

/**
 * Anchor for the file that actually emits the webview's CSP. In Claude Code
 * (checked against 2.1.278) the webview bundle carries no real CSP string: the
 * `<meta http-equiv="Content-Security-Policy">` tag is an HTML template inside
 * the extension's host file (`extension.js`), which has none of the spinner
 * verbs, so relaxing only the bundle leaves the loopback blocked by
 * `default-src 'none'`.
 */
const CSP_META_ANCHOR = 'http-equiv="Content-Security-Policy"';

/** True when `node --check` accepts the source. A failed check means the file must not be written. */
export function jsParses(content: string): boolean {
  const file = join(tmpdir(), `latent-syntax-${process.pid}-${Math.random().toString(16).slice(2)}.js`);
  try {
    writeFileSync(file, content);
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    return result.status === 0;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

/** `package.json` `main`, or `extension.js` when the manifest is missing. */
function extensionMainPath(extDir: string): string {
  const fallback = join(extDir, "extension.js");
  try {
    const pkg = JSON.parse(readFileSync(join(extDir, "package.json"), "utf8")) as { main?: unknown };
    if (typeof pkg.main === "string" && pkg.main.length > 0) return resolve(extDir, pkg.main);
  } catch {
    /* no manifest */
  }
  return resolve(fallback);
}

function isExtensionHostModule(extDir: string, filePath: string): boolean {
  return resolve(filePath) === extensionMainPath(extDir);
}

/** A CSP file that is the extension host entry must not be patched. */
function safeCspHost(extDir: string, bundlePath: string, cspHost: string | null): string | null {
  if (!cspHost || cspHost === bundlePath) return null;
  if (isExtensionHostModule(extDir, cspHost)) return null;
  return cspHost;
}

/**
 * Put a previously patched host module back, once. A backup that does not
 * parse is left in place so a bad snapshot cannot overwrite a good file.
 */
export function releaseExtensionHost(extDir: string): void {
  const host = extensionMainPath(extDir);
  if (!existsSync(host)) return;
  const backup = host + BACKUP_SUFFIX;
  if (existsSync(backup)) {
    let saved = "";
    try {
      saved = readFileSync(backup, "utf8");
    } catch {
      return;
    }
    if (!jsParses(saved)) return;
    try {
      const live = readFileSync(host, "utf8");
      if (live !== saved) writeFileSync(host, saved);
      unlinkSync(backup);
    } catch {
      /* leave both files */
    }
    return;
  }
  try {
    const live = readFileSync(host, "utf8");
    if (!live.includes(MARK_START)) return;
    const stripped = stripLatentBlock(live);
    if (stripped !== live && jsParses(stripped)) writeFileSync(host, stripped);
  } catch {
    /* ignore */
  }
}

export type AgentKind = "claude-code" | "codex";

export interface AgentBundle {
  agent: AgentKind;
  extDir: string;
  bundlePath: string;
  /** File carrying the webview's CSP <meta> tag, when separate from bundlePath. */
  cspHostPath: string | null;
}

function extensionRoots(): string[] {
  const h = homedir();
  return [
    join(h, ".vscode", "extensions"),
    join(h, ".vscode-insiders", "extensions"),
    join(h, ".vscode-server", "extensions"),
    join(h, ".cursor", "extensions"),
    join(h, ".cursor-server", "extensions"),
  ].filter(existsSync);
}

function agentFor(dirName: string): AgentKind | null {
  const n = dirName.toLowerCase();
  if (n.startsWith("anthropic.claude-code")) return "claude-code";
  if (n.startsWith("openai.chatgpt") || n.startsWith("openai.codex")) return "codex";
  return null;
}

/** Recursively find a .js file containing any of `anchors` (bounded depth). */
function findFileWithAnchor(dir: string, anchors: readonly string[], depth = 0): string | null {
  if (depth > 5) return null;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const subdirs: string[] = [];
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules") continue;
      subdirs.push(p);
    } else if (name.endsWith(".js") && st.size < 12_000_000) {
      try {
        const head = readFileSync(p, "utf8");
        if (anchors.some((v) => head.includes(v))) return p;
      } catch {
        /* ignore */
      }
    }
  }
  for (const sd of subdirs) {
    const hit = findFileWithAnchor(sd, anchors, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function findBundleJs(dir: string): string | null {
  return findFileWithAnchor(dir, VERB_ANCHORS);
}

/** Like findFileWithAnchor, but every anchor must occur in the same file. */
function findFileWithAllAnchors(dir: string, anchors: readonly string[], depth = 0): string | null {
  if (depth > 5) return null;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const subdirs: string[] = [];
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules") continue;
      subdirs.push(p);
    } else if (name.endsWith(".js") && st.size < 16_000_000) {
      try {
        const head = readFileSync(p, "utf8");
        if (anchors.every((v) => head.includes(v))) return p;
      } catch {
        /* ignore */
      }
    }
  }
  for (const sd of subdirs) {
    const hit = findFileWithAllAnchors(sd, anchors, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function findCspHostJs(dir: string): string | null {
  return findFileWithAnchor(dir, [CSP_META_ANCHOR]);
}

/** Compare `name-x.y.z` extension-dir names by their numeric version suffix
 *  (falls back to lexical order for anything that isn't dotted numbers) so
 *  e.g. "1.10.0" sorts after "1.9.0" instead of before it. */
function compareVersionDirs(a: string, b: string): number {
  const va = a.match(/(\d+(?:\.\d+)*)$/)?.[1];
  const vb = b.match(/(\d+(?:\.\d+)*)$/)?.[1];
  if (va && vb) {
    const pa = va.split(".").map(Number);
    const pb = vb.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Claude Code's chat UI is `webview/index.js`. The host `extension.js` also
 * contains the substring "Thinking" (`thinkingDisplayExplicit`), so a scan for
 * spinner verbs selects the host and the sponsor script never runs in the
 * panel. CSP for that panel lives in `extension.js` too, and rewriting that
 * file crashes the extension host, so it is left alone.
 */
export function claudeBundle(extDir: string): Pick<AgentBundle, "bundlePath" | "cspHostPath"> | null {
  const bundlePath = join(extDir, "webview", "index.js");
  if (!existsSync(bundlePath)) return null;
  return { bundlePath, cspHostPath: null };
}

/**
 * Codex (openai.chatgpt) paints its thinking row from the function that emits
 * both `loading-shimmer-pure-text` and the `cadencedShimmer` class. That file
 * is the bundle. The word "Thinking" also appears in locale chunks; those are
 * not the renderer.
 */
export function codexBundle(extDir: string): Pick<AgentBundle, "bundlePath" | "cspHostPath"> | null {
  const bundlePath = findFileWithAllAnchors(extDir, ["loading-shimmer-pure-text", "cadencedShimmer"]);
  if (!bundlePath) return null;
  const cspHost = findCspHostJs(extDir);
  return { bundlePath, cspHostPath: safeCspHost(extDir, bundlePath, cspHost) };
}

const TAIL_BYTES = 64 * 1024;
let bundleCache: { stamp: string; bundles: AgentBundle[] } | null = null;

function discoveryStamp(): string {
  const parts: string[] = [];
  for (const root of extensionRoots()) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    parts.push(root + "\0" + names.filter((n) => agentFor(n)).sort().join("\0"));
  }
  return parts.join("\n");
}

export function fileStamp(path: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** The sponsor block is appended, so the marker lives in the tail. */
export function tailIncludes(path: string, needle: string): boolean {
  let fd: number | null = null;
  try {
    const st = statSync(path);
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    return buf.toString("utf8").includes(needle);
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function findAgentBundles(): AgentBundle[] {
  const stamp = discoveryStamp();
  if (bundleCache?.stamp === stamp && bundleCache.bundles.every((b) => existsSync(b.bundlePath))) {
    return bundleCache.bundles;
  }
  const bundles = locateAgentBundles();
  bundleCache = { stamp, bundles };
  return bundles;
}

function locateAgentBundles(): AgentBundle[] {
  const out: AgentBundle[] = [];
  const seen = new Set<AgentKind>();
  for (const root of extensionRoots()) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root);
    } catch {
      continue;
    }
    // Newest version dir wins.
    for (const name of dirs.sort(compareVersionDirs).reverse()) {
      const agent = agentFor(name);
      if (!agent || seen.has(agent)) continue;
      const extDir = join(root, name);
      if (agent === "claude-code") {
        const hit = claudeBundle(extDir);
        if (!hit) continue;
        out.push({ agent, extDir, bundlePath: hit.bundlePath, cspHostPath: hit.cspHostPath });
        seen.add(agent);
        continue;
      }
      if (agent === "codex") {
        const hit = codexBundle(extDir);
        if (!hit) continue;
        out.push({ agent, extDir, bundlePath: hit.bundlePath, cspHostPath: hit.cspHostPath });
        seen.add(agent);
        continue;
      }
      const bundle = findBundleJs(extDir);
      if (bundle) {
        const cspHost = findCspHostJs(extDir);
        out.push({ agent, extDir, bundlePath: bundle, cspHostPath: safeCspHost(extDir, bundle, cspHost) });
        seen.add(agent);
      }
    }
  }
  return out;
}

/** Tail fast-path, then the whole file. The Codex block sits inside the
 *  shimmer function, not at the end of the bundle. */
export function fileIncludes(path: string, needle: string): boolean {
  if (tailIncludes(path, needle)) return true;
  try {
    const st = statSync(path);
    if (st.size > 16_000_000) return false;
    return readFileSync(path, "utf8").includes(needle);
  } catch {
    return false;
  }
}

export function isPatched(bundlePath: string): boolean {
  return fileIncludes(bundlePath, MARK_START);
}

const LOOPBACK_CONNECT = "connect-src http://127.0.0.1:*; ";

/**
 * Claude's chat webview blocks fetch via the CSP meta tags in `extension.js`.
 * Claude 2.1.282 renamed the directive variables, so match the meta tag itself
 * instead of one minified assignment. Leave every other `connect-src` alone,
 * including Monaco's `/connect-src/` tokenizer and Codex's template literal.
 */
export function relaxClaudeCspMetas(content: string): string {
  return content.replace(
    /(<meta http-equiv="Content-Security-Policy" content="default-src 'none'; )(?!connect-src )/g,
    `$1${LOOPBACK_CONNECT}`,
  );
}

/** One write of Claude's host module when the loopback allowance is missing. */
export function patchClaudeHostCsp(extDir: string): "patched" | "unchanged" | "error" {
  const host = extensionMainPath(extDir);
  if (!existsSync(host)) return "unchanged";
  try {
    const original = readFileSync(host, "utf8");
    const next = relaxClaudeCspMetas(original);
    if (next === original) return "unchanged";
    if (!jsParses(original) || !jsParses(next)) return "error";
    const backup = host + BACKUP_SUFFIX;
    if (!existsSync(backup)) writeFileSync(backup, original);
    writeFileSync(host, next);
    return "patched";
  } catch {
    return "error";
  }
}

/** Add a 127.0.0.1 loopback allowance to any CSP connect-src in the bundle. */
export function relaxCsp(content: string): string {
  // Broaden explicit connect-src directives. Directives are ';'-terminated
  // and legitimately contain single-quoted keyword sources (e.g. 'self'),
  // so only stop at ';' or the string-literal delimiters ("/`) — stopping
  // at "'" too would truncate before 'self' and splice a malformed token
  // (e.g. "http://127.0.0.1:*'self'") into the CSP.
  //
  // The (?<!\/)…(?!\/) guard skips a bare /connect-src/ regex literal. Claude
  // Code's webview ships one (Monaco's CSP syntax tokenizer:
  // `[/connect-src/,"string.quote"]`); matching it spliced " http://…" into
  // the regex and left a SyntaxError that broke the whole webview on load.
  // Stop at `$` as well as quotes. Codex builds the directive as
  // `connect-src ${n.join(" ")}`; consuming through the `$` splices the
  // allowance into the template expression and leaves a SyntaxError.
  let out = content.replace(/(?<!\/)connect-src(?!\/)([^;"`$]*)/g, (m, rest, offset) => {
    if (rest.includes("127.0.0.1")) return m;
    const next = content[offset + m.length];
    // Keep the allowance a separate CSP token when the rest of the directive
    // is a ${...} interpolation (`connect-src ${n.join(" ")}`).
    const glue = next === "$" ? " " : "";
    return `connect-src${rest} http://127.0.0.1:*${glue}`;
  });
  // A lone `default-src 'none'` that already sits in a longer policy (a ';'
  // follows before the string ends) gets its own connect-src. A short
  // `"default-src 'none'"` next to a real connect-src directive — Codex's
  // CSP array — is left alone, or the earlier directive would shadow it.
  out = out.replace(
    /default-src 'none'(?=[^"'`;]*;)/g,
    "default-src 'none'; connect-src http://127.0.0.1:*",
  );
  return out;
}

/** Relax a CSP file that is not the extension host entry. Skip the write when
 *  the result does not parse, or when the only backup is already broken. */
function patchCspHostFile(extDir: string, hostPath: string): void {
  if (isExtensionHostModule(extDir, hostPath)) return;
  try {
    const original = readFileSync(hostPath, "utf8");
    const pristine = readPristine(hostPath, original);
    if (pristine === null) return;
    const relaxed = relaxCsp(stripLatentBlock(pristine));
    if (!jsParses(relaxed)) return;
    if (relaxed !== original) writeFileSync(hostPath, relaxed);
  } catch {
    /* best effort */
  }
}

/** Backup that parses, or the live file when that parses. Null when neither does. */
function readPristine(path: string, original: string): string | null {
  const backup = path + BACKUP_SUFFIX;
  if (existsSync(backup)) {
    try {
      const saved = readFileSync(backup, "utf8");
      if (jsParses(saved)) return saved;
    } catch {
      /* fall through to the live file */
    }
  }
  const seed = original.includes(MARK_START) ? stripLatentBlock(original) : original;
  if (!jsParses(seed)) return null;
  try {
    writeFileSync(backup, seed);
  } catch {
    /* a missing backup must not block a parseable live patch */
  }
  return seed;
}

const SHIMMER_TEXT = "loading-shimmer-pure-text";
const SHIMMER_CLASS = "cadencedShimmer";

/**
 * Splice the sponsor block into the function that paints the live thinking
 * shimmer — the one whose body contains both the loading-shimmer text class
 * and cadencedShimmer. Sibling rows mention loading-shimmer-pure-text alone
 * and are left untouched. Returns null when this build has no such function.
 */
export function injectCodexShimmer(content: string, block: string): string | null {
  const stripped = stripLatentBlock(content);
  const open = findShimmerBodyOpen(stripped);
  if (open < 0) return null;
  return stripped.slice(0, open + 1) + block + stripped.slice(open + 1);
}

function findShimmerBodyOpen(content: string): number {
  let from = 0;
  while (from < content.length) {
    const hit = content.indexOf(SHIMMER_TEXT, from);
    if (hit < 0) return -1;
    let scan = hit;
    while (scan > 0) {
      const fn = content.lastIndexOf("function ", scan);
      if (fn < 0) break;
      const open = content.indexOf("{", fn);
      if (open > fn && open < hit) {
        const nextFn = content.indexOf("function ", open + 1);
        const end = nextFn === -1 ? Math.min(content.length, open + 6000) : nextFn;
        const body = content.slice(open, end);
        if (body.includes(SHIMMER_TEXT) && body.includes(SHIMMER_CLASS)) return open;
      }
      scan = fn - 1;
    }
    from = hit + SHIMMER_TEXT.length;
  }
  return -1;
}

/** A previous locator appended the block to whichever chunk contained the
 *  word "Thinking". Those backups are not the shimmer bundle; put them back. */
function retireStaleBundles(extDir: string, keep: readonly string[]): void {
  const backups: string[] = [];
  collectBackups(extDir, 0, backups);
  for (const backup of backups) {
    const js = backup.slice(0, -BACKUP_SUFFIX.length);
    if (keep.includes(js)) continue;
    restoreFile(js);
  }
}

function collectBackups(dir: string, depth: number, out: string[]): void {
  if (depth > 6) return;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) collectBackups(p, depth + 1, out);
    else if (name.endsWith(".js" + BACKUP_SUFFIX)) out.push(p);
  }
}

/** Drop our marker block. Foreign markers (e.g. VIBE-ADS) are left in place. */
export function stripLatentBlock(content: string): string {
  const s = content.indexOf(MARK_START);
  const e = content.indexOf(MARK_END);
  if (s === -1 || e === -1 || e < s) return content;
  return (content.slice(0, s) + content.slice(e + MARK_END.length)).replace(/\n{3,}/g, "\n\n");
}

export function patch(bundle: AgentBundle, block: string): "patched" | "incompatible" | "error" {
  try {
    releaseExtensionHost(bundle.extDir);
    const cspHostPath =
      bundle.cspHostPath && !isExtensionHostModule(bundle.extDir, bundle.cspHostPath) ? bundle.cspHostPath : null;
    const original = readFileSync(bundle.bundlePath, "utf8");
    const pristine = readPristine(bundle.bundlePath, original);
    if (pristine === null) return "error";

    if (bundle.agent === "codex") {
      const injected = injectCodexShimmer(pristine, block);
      if (!injected) return "incompatible";
      if (!jsParses(injected)) return "error";
      writeFileSync(bundle.bundlePath, injected);
      if (cspHostPath) patchCspHostFile(bundle.extDir, cspHostPath);
      retireStaleBundles(bundle.extDir, [bundle.bundlePath, cspHostPath].filter((p): p is string => !!p));
      return "patched";
    }

    if (!VERB_ANCHORS.some((v) => pristine.includes(v)) && !VERB_ANCHORS.some((v) => original.includes(v))) {
      return "incompatible";
    }
    const next = relaxCsp(pristine) + "\n" + block + "\n";
    if (!jsParses(next)) return "error";
    writeFileSync(bundle.bundlePath, next);
    if (cspHostPath) patchCspHostFile(bundle.extDir, cspHostPath);
    if (bundle.agent === "claude-code") patchClaudeHostCsp(bundle.extDir);
    return "patched";
  } catch {
    return "error";
  }
}

export function restore(bundle: AgentBundle): boolean {
  const ok = restoreFile(bundle.bundlePath);
  // Best effort, and kept out of the return value so it can't hide a
  // successful bundle restore from the caller's count.
  if (bundle.cspHostPath && !isExtensionHostModule(bundle.extDir, bundle.cspHostPath)) restoreFile(bundle.cspHostPath);
  releaseExtensionHost(bundle.extDir);
  if (bundle.agent === "codex") {
    retireStaleBundles(bundle.extDir, [bundle.bundlePath, bundle.cspHostPath].filter((p): p is string => !!p));
  }
  return ok;
}

function restoreFile(path: string): boolean {
  const backup = path + BACKUP_SUFFIX;
  if (!existsSync(backup)) {
    // No backup: best-effort strip of our marked block (bundle only — the CSP
    // host file carries no marker).
    try {
      const c = readFileSync(path, "utf8");
      const s = c.indexOf(MARK_START);
      const e = c.indexOf(MARK_END);
      if (s !== -1 && e !== -1 && e > s) {
        writeFileSync(path, (c.slice(0, s) + c.slice(e + MARK_END.length)).replace(/\n{3,}/g, "\n\n"));
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }
  try {
    const saved = readFileSync(backup, "utf8");
    if (!jsParses(saved)) return false;
    renameSync(backup, path);
    return true;
  } catch {
    return false;
  }
}
