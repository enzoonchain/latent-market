import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { DEFAULT_SCAN_DAYS, type AgentScanResult } from "./types.js";

export interface VscodeDetection {
  editor: "vscode" | "cursor" | null;
  bin: string | null;
  extensionsDir: string | null;
  installed: boolean;
}

/**
 * The extension id is `<publisher>.<name>` from vscode-extension/package.json
 * ("latent-protocol" / "latent-protocol-vscode"). Unpacked installs land in
 * `~/.vscode/extensions/<id>-<version>` (same for ~/.cursor/extensions).
 */
export const VSCODE_EXTENSION_ID = "latent-protocol.latent-protocol-vscode";

/** True if an extensions-dir entry is our extension (any version). */
export function isLatentExtensionDir(entry: string): boolean {
  return (
    entry === VSCODE_EXTENSION_ID ||
    entry.startsWith(`${VSCODE_EXTENSION_ID}-`)
  );
}

function findEditorBin(): { editor: "vscode" | "cursor"; bin: string } | null {
  for (const [editor, cmds] of [
    ["cursor", ["cursor"]],
    ["vscode", ["code", "code-insiders"]],
  ] as const) {
    for (const cmd of cmds) {
      try {
        const bin = execSync(`command -v ${cmd}`, {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        if (bin) return { editor, bin };
      } catch {
        /* not found */
      }
    }
  }
  return null;
}

function findExtensionsDir(editor: "vscode" | "cursor"): string | null {
  const home = homedir();
  const candidates =
    editor === "cursor"
      ? [
          join(home, ".cursor", "extensions"),
          join(home, ".vscode", "extensions"),
        ]
      : [
          join(home, ".vscode", "extensions"),
          join(home, ".vscode-insiders", "extensions"),
        ];
  return candidates.find((d) => existsSync(d)) ?? null;
}

function extensionInstalledIn(dir: string | null): boolean {
  if (!dir) return false;
  try {
    return readdirSync(dir).some(isLatentExtensionDir);
  } catch {
    return false;
  }
}

export function detectVscode(): VscodeDetection {
  const found = findEditorBin();
  const editor = found?.editor ?? null;
  const bin = found?.bin ?? null;
  const extensionsDir = editor ? findExtensionsDir(editor) : null;
  return {
    editor,
    bin,
    extensionsDir,
    installed: extensionInstalledIn(extensionsDir),
  };
}

/**
 * VS Code / Cursor is an ad *surface*, not a chat-log source — there are no
 * local transcripts to bill from. The row exists so the prelaunch scan lists
 * the editor; counts stay zero by design.
 */
export function scanVscode(_days = DEFAULT_SCAN_DAYS): AgentScanResult {
  const det = detectVscode();
  return {
    agent: det.editor === "cursor" ? "cursor" : "vscode",
    label: "VS Code / Cursor",
    detected: det.editor !== null,
    sessions: 0,
    userTurns: 0,
    thinkingStates: 0,
    billableSlots: 0,
    detail:
      det.editor === null
        ? "editor not found"
        : `extension surface (${det.bin ?? "?"}) — nothing to scan locally`,
  };
}
