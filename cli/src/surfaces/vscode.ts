/**
 * VS Code / Cursor surface — the Latent sponsored-spinner extension, shipped as
 * a VSIX. `init` installs it through the editor's own CLI
 * (`code --install-extension`, works for Cursor's `cursor` binary too).
 *
 * The VSIX comes from GitHub Releases so the npm bundle stays self-contained;
 * override the URL with LATENT_VSIX_URL (CI, mirrors, air-gapped installs).
 */
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectVscode, VSCODE_EXTENSION_ID } from "../scanners/vscode.js";

const VSIX_URL =
  process.env.LATENT_VSIX_URL ??
  "https://github.com/enzoonchain/latent-market/releases/latest/download/latent-protocol-vscode.vsix";

export function vscodeExtensionId(): string {
  return VSCODE_EXTENSION_ID;
}

export function vscodeConfigDir(): string {
  return detectVscode().extensionsDir ?? join(process.cwd(), ".latent-vscode");
}

export function vscodeDetected(): boolean {
  return detectVscode().editor !== null;
}

export async function installVscode(): Promise<string> {
  const det = detectVscode();
  if (!det.editor || !det.bin) {
    return "❌ VS Code / Cursor not found — install the editor first.";
  }
  if (det.installed) {
    return `✅ ${VSCODE_EXTENSION_ID} already installed in ${det.extensionsDir}`;
  }

  const tmp = mkdtempSync(join(tmpdir(), "latent-vsix-"));
  const vsixPath = join(tmp, "latent-protocol-vscode.vsix");
  try {
    execSync(`curl -fsSL "${VSIX_URL}" -o "${vsixPath}"`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!existsSync(vsixPath)) {
      return `❌ Failed to download VSIX from ${VSIX_URL}`;
    }
    execSync(`"${det.bin}" --install-extension "${vsixPath}" --force`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return `✅ ${VSCODE_EXTENSION_ID} installed → ${
      det.extensionsDir ?? det.editor
    }`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `❌ VSIX install failed: ${msg}`;
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export async function uninstallVscode(): Promise<string> {
  const det = detectVscode();
  if (!det.editor || !det.bin) {
    return "❌ VS Code / Cursor not found.";
  }
  try {
    execSync(`"${det.bin}" --uninstall-extension ${VSCODE_EXTENSION_ID}`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return `🗑  ${VSCODE_EXTENSION_ID} uninstalled.`;
  } catch {
    return `⚠️  ${VSCODE_EXTENSION_ID} not found in ${det.editor}.`;
  }
}

export function vscodeStatus(): string {
  const det = detectVscode();
  if (!det.editor) return "VS Code / Cursor: not detected";
  const label = det.editor === "cursor" ? "Cursor" : "VS Code";
  return det.installed
    ? `VS Code / Cursor (${label}): installed (${det.extensionsDir ?? "?"})`
    : `VS Code / Cursor (${label}): detected, not installed (${det.bin ?? "?"})`;
}
