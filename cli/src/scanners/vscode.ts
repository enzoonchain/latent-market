import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_SCAN_DAYS, type AgentScanResult } from "./types.js";

export type EditorKind = "vscode" | "cursor";

export interface EditorInstall {
  editor: EditorKind;
  /** The editor's CLI (`cursor` / `code`), or null when only its data dir exists. */
  bin: string | null;
  extensionsDir: string | null;
  installed: boolean;
}

export interface VscodeDetection {
  editor: EditorKind | null;
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

interface EditorSpec {
  /** Commands looked up on PATH. */
  commands: string[];
  /** App-bundle CLIs — macOS installs don't put `cursor`/`code` on PATH by default. */
  appBins: (home: string) => string[];
  extensionsDir: (home: string, bin: string | null) => string;
}

const EDITORS: Record<EditorKind, EditorSpec> = {
  cursor: {
    commands: ["cursor"],
    appBins: (home) => [
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      join(home, "Applications", "Cursor.app", "Contents", "Resources", "app", "bin", "cursor"),
    ],
    extensionsDir: (home) => join(home, ".cursor", "extensions"),
  },
  vscode: {
    commands: ["code", "code-insiders"],
    appBins: (home) => [
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      join(home, "Applications", "Visual Studio Code.app", "Contents", "Resources", "app", "bin", "code"),
    ],
    extensionsDir: (home, bin) =>
      join(home, bin && /insiders/i.test(bin) ? ".vscode-insiders" : ".vscode", "extensions"),
  },
};

function onPath(cmd: string): string | null {
  // cmd is one of the fixed names above — never user input.
  const res = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  const out = (res.stdout || "").trim();
  return res.status === 0 && out ? out : null;
}

function findBin(spec: EditorSpec, home: string): string | null {
  for (const cmd of spec.commands) {
    const hit = onPath(cmd);
    if (hit) return hit;
  }
  return spec.appBins(home).find((p) => existsSync(p)) ?? null;
}

function extensionInstalledIn(dir: string | null): boolean {
  if (!dir) return false;
  try {
    return readdirSync(dir).some(isLatentExtensionDir);
  } catch {
    return false;
  }
}

/**
 * Every Cursor / VS Code install on this machine. An editor counts as present
 * when its CLI resolves (PATH or app bundle) or its extensions dir exists —
 * the latter alone can't be installed into, but is still reported.
 */
export function detectEditors(): EditorInstall[] {
  const home = homedir();
  const out: EditorInstall[] = [];
  for (const editor of ["cursor", "vscode"] as const) {
    const spec = EDITORS[editor];
    const bin = findBin(spec, home);
    const dir = spec.extensionsDir(home, bin);
    const extensionsDir = existsSync(dir) ? dir : null;
    if (!bin && !extensionsDir) continue;
    out.push({ editor, bin, extensionsDir, installed: extensionInstalledIn(extensionsDir) });
  }
  return out;
}

/** The primary editor (first one with a usable CLI), for single-row summaries. */
export function detectVscode(): VscodeDetection {
  const all = detectEditors();
  const primary = all.find((e) => e.bin) ?? all[0];
  if (!primary) return { editor: null, bin: null, extensionsDir: null, installed: false };
  return { ...primary };
}

/**
 * VS Code / Cursor is an ad *surface*, not a chat-log source — there are no
 * local transcripts to bill from. The row exists so the prelaunch scan lists
 * the editor; counts stay zero by design.
 */
export function scanVscode(_days = DEFAULT_SCAN_DAYS): AgentScanResult {
  const all = detectEditors();
  const det = detectVscode();
  return {
    agent: det.editor === "cursor" ? "cursor" : "vscode",
    label: "VS Code / Cursor",
    detected: all.length > 0,
    sessions: 0,
    userTurns: 0,
    thinkingStates: 0,
    billableSlots: 0,
    detail:
      all.length === 0
        ? "editor not found"
        : `extension surface (${all.map((e) => e.editor).join(", ")}) — nothing to scan locally`,
  };
}
