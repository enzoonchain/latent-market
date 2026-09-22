/**
 * Cursor workbench patcher — installs the `cursor-block.ts` overlay.
 *
 * Cursor's workbench doesn't run code appended to a bundle, so the overlay
 * ships as a sibling file (`latent-cursor-block.js`) next to `workbench.html`,
 * loaded by one marker-delimited `<script src>` tag. The workbench CSP already
 * allows it: `script-src 'self'` covers the sibling file and `connect-src
 * http:` covers the 127.0.0.1 loopback — so unlike the agent-bundle patcher,
 * no CSP relaxation is needed. The block only uses textContent, so the
 * workbench's Trusted Types policy is untouched too.
 *
 * Reversible: a pristine `workbench.html.latent-backup` is kept, and the path
 * of every patched workbench is recorded in `~/.latent-protocol/` so the
 * `vscode:uninstall` hook (a plain node process with no `vscode.env.appRoot`)
 * can still find and restore it.
 *
 * Cursor verifies its install checksums; while patched it may show a
 * "your installation appears to be corrupt" notice. A Cursor update replaces
 * workbench.html, which silently drops the patch — `patchWorkbench` is
 * idempotent and re-run on startup.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const WB_MARK_START = "<!-- LATENT-CURSOR-START -->";
export const WB_MARK_END = "<!-- LATENT-CURSOR-END -->";
export const WB_BLOCK_FILE = "latent-cursor-block.js";
const BACKUP_SUFFIX = ".latent-backup";

const WORKBENCH_CANDIDATES = [
  "out/vs/code/electron-sandbox/workbench/workbench.html",
  "out/vs/code/electron-browser/workbench/workbench.html",
];

function registryPath(): string {
  return join(homedir(), ".latent-protocol", "cursor-workbench.json");
}

export function findWorkbenchHtml(appRoot: string): string | null {
  for (const rel of WORKBENCH_CANDIDATES) {
    const p = join(appRoot, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

function readRegistry(): string[] {
  try {
    const v = JSON.parse(readFileSync(registryPath(), "utf8")) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeRegistry(paths: string[]): void {
  try {
    mkdirSync(join(homedir(), ".latent-protocol"), { recursive: true });
    writeFileSync(registryPath(), JSON.stringify([...new Set(paths)], null, 2));
  } catch {
    /* best-effort */
  }
}

function stripTag(html: string): string {
  const s = html.indexOf(WB_MARK_START);
  const e = html.indexOf(WB_MARK_END);
  if (s === -1 || e === -1 || e < s) return html;
  return html.slice(0, s).replace(/\n[ \t]*$/, "") + html.slice(e + WB_MARK_END.length);
}

/** Insert our tag right after the workbench bootstrap script (or before </html>). */
export function injectTag(html: string): string {
  const clean = stripTag(html);
  const tag = `\n\t${WB_MARK_START}<script src="./${WB_BLOCK_FILE}"></script>${WB_MARK_END}`;
  const boot = clean.match(/<script src="\.\/workbench\.js"[^>]*><\/script>/);
  if (boot && boot.index !== undefined) {
    const at = boot.index + boot[0].length;
    return clean.slice(0, at) + tag + clean.slice(at);
  }
  const close = clean.lastIndexOf("</html>");
  return close === -1 ? clean + tag + "\n" : clean.slice(0, close) + tag.trimStart() + "\n" + clean.slice(close);
}

export function isWorkbenchPatched(htmlPath: string): boolean {
  try {
    return readFileSync(htmlPath, "utf8").includes(WB_MARK_START);
  } catch {
    return false;
  }
}

export function patchWorkbench(htmlPath: string, blockJs: string): "patched" | "error" {
  try {
    const backup = htmlPath + BACKUP_SUFFIX;
    const current = readFileSync(htmlPath, "utf8");
    // A Cursor update writes a fresh workbench.html; refresh the backup from
    // it (tag stripped) so restore never rolls Cursor back to an old build.
    if (!existsSync(backup) || !current.includes(WB_MARK_START)) {
      writeFileSync(backup, stripTag(current));
    }
    writeFileSync(join(dirname(htmlPath), WB_BLOCK_FILE), blockJs);
    writeFileSync(htmlPath, injectTag(readFileSync(backup, "utf8")));
    writeRegistry([...readRegistry(), htmlPath]);
    return "patched";
  } catch {
    return "error";
  }
}

export function restoreWorkbench(htmlPath: string): boolean {
  try {
    const backup = htmlPath + BACKUP_SUFFIX;
    if (existsSync(backup)) {
      copyFileSync(backup, htmlPath);
      rmSync(backup, { force: true });
    } else if (existsSync(htmlPath)) {
      writeFileSync(htmlPath, stripTag(readFileSync(htmlPath, "utf8")));
    }
    rmSync(join(dirname(htmlPath), WB_BLOCK_FILE), { force: true });
    writeRegistry(readRegistry().filter((p) => p !== htmlPath));
    return true;
  } catch {
    return false;
  }
}

/** Restore every workbench we ever patched (uninstall path — no appRoot needed). */
export function restoreAllWorkbenches(): void {
  for (const p of readRegistry()) restoreWorkbench(p);
}
