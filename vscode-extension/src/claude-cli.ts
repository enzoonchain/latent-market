/**
 * Claude CLI hook installer — writes the Latent statusLine command into
 * `~/.claude/settings.json`.
 *
 * This mirrors what `npx latent-protocol init` does, but runs from the
 * extension so a VS Code-only user (no CLI) gets the full funnel.
 *
 * Ownership model: if the CLI already installed the hook, we leave it alone.
 * If a competitor owns it, we ask via `conflict.ts` before overwriting.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");

interface ClaudeSettings {
  statusLine?: {
    type?: string;
    command?: string;
  };
  [key: string]: unknown;
}

export function isLatentHookInstalled(): boolean {
  try {
    const raw = readFileSync(CLAUDE_SETTINGS, "utf8");
    const settings = JSON.parse(raw) as ClaudeSettings;
    return settings.statusLine?.command?.includes("latent") ?? false;
  } catch {
    return false;
  }
}

export function installClaudeCliHook(): "installed" | "already-installed" | "error" {
  try {
    mkdirSync(join(homedir(), ".claude"), { recursive: true });

    let settings: ClaudeSettings = {};
    if (existsSync(CLAUDE_SETTINGS)) {
      // Backup before modifying
      copyFileSync(CLAUDE_SETTINGS, CLAUDE_SETTINGS + ".latent-backup");
      settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")) as ClaudeSettings;
    }

    if (settings.statusLine?.command?.includes("latent")) {
      return "already-installed";
    }

    settings.statusLine = {
      type: "command",
      command: "npx -y latent-protocol statusline",
    };

    writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
    return "installed";
  } catch {
    return "error";
  }
}

export function removeClaudeCliHook(): "removed" | "not-installed" | "error" {
  try {
    if (!existsSync(CLAUDE_SETTINGS)) return "not-installed";
    const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")) as ClaudeSettings;
    if (!settings.statusLine?.command?.includes("latent")) return "not-installed";

    // Restore from backup if available
    const backupPath = CLAUDE_SETTINGS + ".latent-backup";
    if (existsSync(backupPath)) {
      copyFileSync(backupPath, CLAUDE_SETTINGS);
    } else {
      delete settings.statusLine;
      writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
    }
    return "removed";
  } catch {
    return "error";
  }
}
