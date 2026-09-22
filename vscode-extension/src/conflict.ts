/**
 * Hook conflict detection — warn when another tool owns the same hooks.
 *
 * Latent patches two shared targets that other tools may also claim:
 *  - `~/.claude/settings.json` → statusLine (claude-cli)
 *  - Claude Code / Codex webview bundles (bundle patcher)
 *
 * If two tools are active on one target, they overwrite each other. This
 * module detects that BEFORE patching and tells the user clearly. Detection is
 * generic — any statusLine that isn't Latent's, any marker-delimited block in
 * a bundle that isn't ours — so it needs no list of other products.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findAgentBundles } from "./patcher.js";

export interface ConflictCheck {
  hasConflict: boolean;
  target: string;
  message: string;
}

/** Check `~/.claude/settings.json` statusLine for a foreign hook. */
export function checkClaudeCliConflict(): ConflictCheck {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  try {
    const raw = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw);
    const statusLine: string = settings?.statusLine?.command || "";

    if (!statusLine) {
      return { hasConflict: false, target: "claude-cli", message: "No statusLine hook set." };
    }
    if (/latent/i.test(statusLine)) {
      return { hasConflict: false, target: "claude-cli", message: "Latent owns the statusLine hook." };
    }
    const shown = statusLine.length > 60 ? `${statusLine.slice(0, 57)}…` : statusLine;
    return {
      hasConflict: true,
      target: "claude-cli",
      message: `Another tool owns the Claude CLI statusLine (${shown}). Let Latent take over? It is restored when you remove the Latent hook.`,
    };
  } catch {
    return { hasConflict: false, target: "claude-cli", message: "No Claude CLI settings found." };
  }
}

/** A `/* NAME-START *\/` block injected into a bundle by some patcher. */
const INJECTED_BLOCK = /\/\*\s*([A-Z][A-Z0-9_-]*)-START\s*\*\//g;

/** Check if a bundle already carries another tool's injected block. */
export function checkBundleConflict(bundleContent: string): ConflictCheck {
  const foreign = [...bundleContent.matchAll(INJECTED_BLOCK)]
    .map((m) => m[1])
    .filter((name) => !name.startsWith("LATENT"));
  if (foreign.length > 0) {
    return {
      hasConflict: true,
      target: "bundle",
      message: "Another tool has patched this agent bundle. Enabling Latent replaces that patch (a backup is kept).",
    };
  }
  if (bundleContent.includes("LATENT-START")) {
    return { hasConflict: false, target: "bundle", message: "Latent patch is active." };
  }
  return { hasConflict: false, target: "bundle", message: "Clean bundle." };
}

/** Run all conflict checks and return a summary. */
export function runAllChecks(): ConflictCheck[] {
  const results: ConflictCheck[] = [checkClaudeCliConflict()];
  for (const b of findAgentBundles()) {
    try {
      const r = checkBundleConflict(readFileSync(b.bundlePath, "utf8"));
      if (r.hasConflict) results.push({ ...r, message: `${b.agent}: ${r.message}` });
    } catch {
      // unreadable bundle — nothing to report
    }
  }
  return results;
}
