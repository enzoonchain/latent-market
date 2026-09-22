/**
 * Claude CLI hook installer — points `~/.claude/settings.json`'s statusLine at
 * the Latent statusline runtime, from the extension, so a VS Code-first user
 * can turn on the Claude Code surface without leaving the editor.
 *
 * Ownership model (what this file may touch):
 *  - A Latent statusLine the CLI already installed (`npx latent-protocol init`)
 *    is the CLI's. We report it as installed and never rewrite or remove it —
 *    `latent uninstall` owns that one.
 *  - We only ever remove a statusLine *we* wrote, proven by an ownership marker
 *    (`~/.latent-protocol/vscode-cli-hook.json`) that records the exact command
 *    we wrote and the statusLine it replaced. Removal puts that previous value
 *    back — never a whole-file backup copy, which would silently discard every
 *    settings change the user made in between.
 *  - A foreign statusLine (Kickbacks, CodeBacks, the user's own) is replaced
 *    only when the caller passes `force` after asking the user.
 *
 * The command is `node "<~/.latent-protocol/bin/statusline.mjs>"` — the
 * runtime the CLI stages — never `npx`, which re-resolves the package on every
 * status-line refresh and corrupts the npx cache under concurrent runs.
 *
 * Edits are minimal jsonc-parser edits: comments/formatting survive, and an
 * unparseable settings.json is refused rather than clobbered.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

interface StatusLine {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface OwnershipMarker {
  command: string;
  previous: StatusLine | null;
}

function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function markerPath(): string {
  return join(homedir(), ".latent-protocol", "vscode-cli-hook.json");
}

/** The runtime `latent init` stages for Claude Code. */
export function statuslineRuntimePath(): string {
  return join(homedir(), ".latent-protocol", "bin", "statusline.mjs");
}

export function extensionStatuslineCommand(): string {
  return `node "${statuslineRuntimePath()}"`;
}

/** Any statusLine command that belongs to Latent (CLI- or extension-written). */
export function isLatentCommand(cmd: string | undefined): boolean {
  return !!cmd && /latent/i.test(cmd);
}

type Loaded = { ok: true; text: string; statusLine: StatusLine | null } | { ok: false };

function loadSettings(): Loaded {
  const p = claudeSettingsPath();
  if (!existsSync(p)) return { ok: true, text: "", statusLine: null };
  try {
    const text = readFileSync(p, "utf8");
    const errors: ParseError[] = [];
    const data = parse(text, errors, { allowTrailingComma: true }) as
      | { statusLine?: StatusLine }
      | undefined;
    if (errors.length || (text.trim() && (data === null || typeof data !== "object"))) {
      return { ok: false };
    }
    return { ok: true, text, statusLine: data?.statusLine ?? null };
  } catch {
    return { ok: false };
  }
}

function writeStatusLine(text: string, value: StatusLine | undefined): void {
  const base = text.trim() ? text : "{}\n";
  const edits = modify(base, ["statusLine"], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  writeFileSync(claudeSettingsPath(), applyEdits(base, edits));
}

function readMarker(): OwnershipMarker | null {
  try {
    const m = JSON.parse(readFileSync(markerPath(), "utf8")) as OwnershipMarker;
    return typeof m?.command === "string" ? m : null;
  } catch {
    return null;
  }
}

function writeMarker(m: OwnershipMarker): void {
  mkdirSync(join(homedir(), ".latent-protocol"), { recursive: true });
  writeFileSync(markerPath(), JSON.stringify(m, null, 2));
}

function dropMarker(): void {
  try {
    rmSync(markerPath(), { force: true });
  } catch {
    /* best-effort */
  }
}

export function isLatentHookInstalled(): boolean {
  const s = loadSettings();
  return s.ok && isLatentCommand(s.statusLine?.command);
}

export type InstallResult = "installed" | "already-installed" | "conflict" | "needs-cli" | "error";

/**
 * @param force replace a foreign (non-Latent) statusLine — only after the user
 *   confirmed; without it a foreign hook yields "conflict" and nothing is written.
 */
export function installClaudeCliHook(force = false): InstallResult {
  try {
    const s = loadSettings();
    if (!s.ok) return "error";
    if (isLatentCommand(s.statusLine?.command)) return "already-installed";
    if (s.statusLine && !force) return "conflict";
    if (!existsSync(statuslineRuntimePath())) return "needs-cli";

    const command = extensionStatuslineCommand();
    // Record ownership + what we replaced BEFORE touching settings, so a crash
    // between the two writes can still be undone.
    writeMarker({ command, previous: s.statusLine });
    writeStatusLine(s.text, { type: "command", command });
    return "installed";
  } catch {
    return "error";
  }
}

export type RemoveResult = "removed" | "not-installed" | "error";

/** Remove the statusLine only if the extension wrote it (marker-proven). */
export function removeClaudeCliHook(): RemoveResult {
  try {
    const marker = readMarker();
    if (!marker) return "not-installed";
    const s = loadSettings();
    if (!s.ok) return "error";
    if (s.statusLine?.command !== marker.command) {
      // Someone (the CLI, the user, a competitor) rewrote it since — not ours
      // to remove any more.
      dropMarker();
      return "not-installed";
    }
    writeStatusLine(s.text, marker.previous ?? undefined);
    dropMarker();
    return "removed";
  } catch {
    return "error";
  }
}
