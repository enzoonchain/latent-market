/**
 * Hook conflict detection — warn when another extension owns the same hooks.
 *
 * Both Latent and Kickbacks patch the same targets:
 *  - `~/.claude/settings.json` → statusLine (claude-cli)
 *  - Claude Code / Codex webview bundles (bundle patcher)
 *
 * If both are active, they overwrite each other. This module detects the
 * conflict BEFORE patching and tells the user clearly.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ConflictCheck {
  hasConflict: boolean;
  conflictingExtension?: string;
  target: string;
  message: string;
}

/** Known extension IDs that hook the same surfaces. */
const COMPETITORS = [
  "kickbacksai.kickbacks-ai",
  "codebacks.codebacks",
];

/** Check if a competitor extension is installed. */
export function findCompetitorExtensions(cursorExtensionsDir?: string): string[] {
  const found: string[] = [];
  const dirs = [
    cursorExtensionsDir || join(homedir(), ".cursor", "extensions"),
    join(homedir(), ".vscode", "extensions"),
  ];
  for (const dir of dirs) {
    try {
      const { readdirSync } = require("node:fs");
      const entries = readdirSync(dir);
      for (const entry of entries) {
        for (const comp of COMPETITORS) {
          if (entry.startsWith(comp)) {
            found.push(entry);
          }
        }
      }
    } catch {
      // dir doesn't exist — fine
    }
  }
  return found;
}

/** Check `~/.claude/settings.json` statusLine for foreign hooks. */
export function checkClaudeCliConflict(): ConflictCheck {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  try {
    const raw = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw);
    const statusLine = settings?.statusLine?.command || "";

    if (statusLine.includes("latent")) {
      return { hasConflict: false, target: "claude-cli", message: "Latent owns the statusLine hook." };
    }
    if (statusLine.includes("kickbacks")) {
      return {
        hasConflict: true,
        conflictingExtension: "kickbacks",
        target: "claude-cli",
        message: "Kickbacks owns the Claude CLI statusLine hook. Enable Latent to take over? (Backup will be created.)",
      };
    }
    if (statusLine.includes("codebacks")) {
      return {
        hasConflict: true,
        conflictingExtension: "codebacks",
        target: "claude-cli",
        message: "CodeBacks owns the Claude CLI statusLine hook. Enable Latent to take over? (Backup will be created.)",
      };
    }
    return { hasConflict: false, target: "claude-cli", message: "No foreign statusLine hook detected." };
  } catch {
    return { hasConflict: false, target: "claude-cli", message: "No Claude CLI settings found." };
  }
}

/** Check if a bundle is already patched by a competitor. */
export function checkBundleConflict(bundleContent: string): ConflictCheck {
  if (bundleContent.includes("LATENT-START")) {
    return { hasConflict: false, target: "bundle", message: "Latent patch is active." };
  }
  if (bundleContent.includes("VIBE-ADS-START") || bundleContent.includes("KICKBACKS")) {
    return {
      hasConflict: true,
      conflictingExtension: "kickbacks",
      target: "bundle",
      message: "Kickbacks has patched this agent bundle. Enabling Latent will replace the Kickbacks patch (a backup will be kept).",
    };
  }
  if (bundleContent.includes("CODEBACKS")) {
    return {
      hasConflict: true,
      conflictingExtension: "codebacks",
      target: "bundle",
      message: "CodeBacks has patched this agent bundle. Enabling Latent will replace it (a backup will be kept).",
    };
  }
  return { hasConflict: false, target: "bundle", message: "Clean bundle." };
}

/** Run all conflict checks and return a summary. */
export function runAllChecks(): ConflictCheck[] {
  const results: ConflictCheck[] = [];
  results.push(checkClaudeCliConflict());

  const competitors = findCompetitorExtensions();
  if (competitors.length > 0) {
    results.push({
      hasConflict: true,
      conflictingExtension: competitors[0],
      target: "installed-extensions",
      message: `Competitor extension(s) found: ${competitors.join(", ")}. They may fight over the same hooks.`,
    });
  }

  return results;
}
