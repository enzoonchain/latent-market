/**
 * Agent-bundle patcher (advanced / invasive path).
 *
 * Locates an installed Claude Code / Codex (ChatGPT) editor extension, and —
 * only when the user opts in — appends the LATENT block to its webview bundle so
 * the sponsor line renders inside the agent's own spinner. Every change is
 * reversible: a pristine `.latent-backup` is written before the first edit, the
 * block is marker-delimited, and `restore()` puts the original bytes back and
 * removes the CSP relaxation.
 *
 * This modifies a third-party signed extension and relaxes its webview CSP to
 * reach the 127.0.0.1 loopback — the CSP usually lives in a separate host file
 * from the webview bundle (see CSP_META_ANCHOR), so both get patched. It is off
 * by default and gated behind an explicit command / setting.
 */
import { existsSync, readdirSync, readFileSync, renameSync, copyFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export function findAgentBundles(): AgentBundle[] {
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
      const bundle = findBundleJs(extDir);
      if (bundle) {
        const cspHost = findCspHostJs(extDir);
        out.push({ agent, extDir, bundlePath: bundle, cspHostPath: cspHost && cspHost !== bundle ? cspHost : null });
        seen.add(agent);
      }
    }
  }
  return out;
}

export function isPatched(bundlePath: string): boolean {
  try {
    return readFileSync(bundlePath, "utf8").includes(MARK_START);
  } catch {
    return false;
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
  let out = content.replace(/(?<!\/)connect-src(?!\/)([^;"`]*)/g, (m, rest) =>
    rest.includes("127.0.0.1") ? m : `connect-src${rest} http://127.0.0.1:*`,
  );
  // Some builds only set default-src 'none' — add a connect-src alongside it.
  out = out.replace(/default-src 'none'/g, "default-src 'none'; connect-src http://127.0.0.1:*");
  return out;
}

/** Relax the separate CSP host file. Best effort: a failure here must not fail
 *  the bundle patch — the block still fails open without its loopback. */
function patchCspHostFile(hostPath: string): void {
  try {
    const backup = hostPath + BACKUP_SUFFIX;
    if (!existsSync(backup)) copyFileSync(hostPath, backup);
    // From pristine every time: relaxCsp's default-src rule is not idempotent.
    const pristine = readFileSync(backup, "utf8");
    const relaxed = relaxCsp(pristine);
    if (relaxed !== pristine) writeFileSync(hostPath, relaxed);
  } catch {
    /* best effort */
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
    const original = readFileSync(bundle.bundlePath, "utf8");
    if (!VERB_ANCHORS.some((v) => original.includes(v)) && !VERB_ANCHORS.some((v) => stripLatentBlock(original).includes(v))) {
      return "incompatible";
    }

    const backup = bundle.bundlePath + BACKUP_SUFFIX;
    if (!existsSync(backup)) {
      // Fossil: a live file that already carries our block has no pristine copy.
      // Strip only our marker and keep that as the backup, then patch from it.
      const seed = original.includes(MARK_START) ? stripLatentBlock(original) : original;
      writeFileSync(backup, seed);
    }

    // Start from pristine so re-patching never stacks blocks.
    const pristine = readFileSync(backup, "utf8");
    const relaxed = relaxCsp(pristine);
    writeFileSync(bundle.bundlePath, relaxed + "\n" + block + "\n");
    if (bundle.cspHostPath) patchCspHostFile(bundle.cspHostPath);
    return "patched";
  } catch {
    return "error";
  }
}

export function restore(bundle: AgentBundle): boolean {
  const ok = restoreFile(bundle.bundlePath);
  // Best effort, and kept out of the return value so it can't hide a
  // successful bundle restore from the caller's count.
  if (bundle.cspHostPath) restoreFile(bundle.cspHostPath);
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
    renameSync(backup, path);
    return true;
  } catch {
    return false;
  }
}
