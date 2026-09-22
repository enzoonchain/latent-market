/**
 * VS Code / Cursor surface — the Latent sponsored-spinner extension, shipped as
 * a VSIX. `init` installs it through each detected editor's own CLI
 * (`cursor` / `code --install-extension`).
 *
 * The VSIX comes from GitHub Releases so the npm bundle stays self-contained:
 * the newest non-draft `vscode-v*` release that carries a
 * `latent-protocol-vscode.vsix` asset (built by .github/workflows/vscode-release.yml).
 * Not `releases/latest` — that is whichever release was published last, which
 * is usually a `cli-v*` one with no VSIX. The download is checked against the
 * release's `.sha256` asset when present.
 *
 * Override with LATENT_VSIX_URL (CI, mirrors, air-gapped installs; also
 * accepts a local file path) and optionally LATENT_VSIX_SHA256.
 *
 * No shell: the download is a fetch, the editor CLI runs via execFileSync.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectEditors,
  VSCODE_EXTENSION_ID,
  type EditorInstall,
} from "../scanners/vscode.js";

export const VSIX_ASSET = "latent-protocol-vscode.vsix";
const RELEASES_API = "https://api.github.com/repos/enzoonchain/latent-market/releases?per_page=30";

export interface VsixSource {
  url: string;
  sha256Url?: string;
  tag?: string;
}

interface GhRelease {
  tag_name?: string;
  draft?: boolean;
  assets?: { name?: string; browser_download_url?: string }[];
}

/** Pick the newest usable VSIX from a GitHub releases listing (newest first). */
export function pickVsixRelease(releases: GhRelease[]): VsixSource | null {
  for (const r of releases) {
    if (r.draft || !r.tag_name?.startsWith("vscode-v")) continue;
    const vsix = r.assets?.find((a) => a.name === VSIX_ASSET)?.browser_download_url;
    if (!vsix) continue;
    const sha = r.assets?.find((a) => a.name === `${VSIX_ASSET}.sha256`)?.browser_download_url;
    return { url: vsix, sha256Url: sha, tag: r.tag_name };
  }
  return null;
}

async function resolveVsix(): Promise<VsixSource | string> {
  const override = process.env.LATENT_VSIX_URL;
  if (override) return { url: override };
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return `GitHub releases lookup failed (HTTP ${res.status})`;
    const src = pickVsixRelease((await res.json()) as GhRelease[]);
    return src ?? "no vscode-v* release with a VSIX has been published yet";
  } catch (err) {
    return `GitHub releases lookup failed (${err instanceof Error ? err.message : String(err)})`;
  }
}

async function fetchBytes(url: string): Promise<Buffer> {
  if (!/^https?:\/\//i.test(url)) return readFileSync(url); // local path override
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function expectedSha(src: VsixSource): Promise<string | null> {
  const pinned = process.env.LATENT_VSIX_SHA256;
  if (pinned) return pinned.trim().toLowerCase();
  if (!src.sha256Url) return null;
  return (await fetchBytes(src.sha256Url)).toString("utf8").trim().split(/\s+/)[0].toLowerCase();
}

export function vscodeExtensionId(): string {
  return VSCODE_EXTENSION_ID;
}

export function vscodeDetected(): boolean {
  return detectEditors().length > 0;
}

const label = (e: EditorInstall) => (e.editor === "cursor" ? "Cursor" : "VS Code");

const noCliHint = (e: EditorInstall) =>
  e.editor === "cursor"
    ? "Cursor: found, but no `cursor` CLI — Command Palette → “Shell Command: Install 'cursor' command”, then re-run init."
    : "VS Code: found, but no `code` CLI — Command Palette → “Shell Command: Install 'code' command in PATH”, then re-run init.";

export async function installVscode(): Promise<string> {
  const editors = detectEditors();
  if (editors.length === 0) {
    return "❌ VS Code / Cursor not found — install the editor first.";
  }
  const lines: string[] = [];
  const todo: EditorInstall[] = [];
  for (const e of editors) {
    if (e.installed) lines.push(`✅ ${label(e)}: ${VSCODE_EXTENSION_ID} already installed`);
    else if (!e.bin) lines.push(`⚠️  ${noCliHint(e)}`);
    else todo.push(e);
  }
  if (todo.length === 0) return lines.join("\n");

  const src = await resolveVsix();
  if (typeof src === "string") {
    lines.push(`❌ VS Code / Cursor extension not installed: ${src}.`);
    return lines.join("\n");
  }

  const tmp = mkdtempSync(join(tmpdir(), "latent-vsix-"));
  const vsixPath = join(tmp, VSIX_ASSET);
  try {
    const bytes = await fetchBytes(src.url);
    const want = await expectedSha(src);
    const got = createHash("sha256").update(bytes).digest("hex");
    if (want && want !== got) {
      lines.push(`❌ VSIX checksum mismatch (${src.tag ?? src.url}) — not installing.`);
      return lines.join("\n");
    }
    writeFileSync(vsixPath, bytes);
    for (const e of todo) {
      try {
        execFileSync(e.bin!, ["--install-extension", vsixPath, "--force"], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        });
        lines.push(`✅ ${label(e)}: ${VSCODE_EXTENSION_ID} installed${src.tag ? ` (${src.tag})` : ""}`);
      } catch (err) {
        lines.push(`❌ ${label(e)}: install failed — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
  } catch (err) {
    lines.push(`❌ VSIX download failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  return lines.join("\n");
}

export async function uninstallVscode(): Promise<string> {
  const editors = detectEditors().filter((e) => e.installed);
  if (editors.length === 0) return "VS Code / Cursor extension: not installed — nothing to remove.";
  const lines: string[] = [];
  for (const e of editors) {
    if (!e.bin) {
      lines.push(`⚠️  ${label(e)}: extension present but no editor CLI — remove it from the Extensions view.`);
      continue;
    }
    try {
      execFileSync(e.bin, ["--uninstall-extension", VSCODE_EXTENSION_ID], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      lines.push(`🗑  ${label(e)}: ${VSCODE_EXTENSION_ID} uninstalled.`);
    } catch {
      lines.push(`⚠️  ${label(e)}: could not uninstall ${VSCODE_EXTENSION_ID}.`);
    }
  }
  return lines.join("\n");
}

export function vscodeStatus(): string {
  const editors = detectEditors();
  if (editors.length === 0) return "VS Code / Cursor: not detected";
  return editors
    .map((e) =>
      e.installed
        ? `VS Code / Cursor (${label(e)}): installed (${e.extensionsDir ?? "?"})`
        : `VS Code / Cursor (${label(e)}): detected, not installed (${e.bin ?? "no CLI"})`,
    )
    .join("\n  ");
}
