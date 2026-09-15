/**
 * Grok Build (https://github.com/xai-org/grok-build) status-line surface.
 *
 * Grok's idle inventory is `[ui.status_line]` in `~/.grok/config.toml` (or
 * `$GROK_HOME/config.toml`). A `type = "command"` row pipes JSON to a script
 * and paints stdout — the same contract as Claude Code's statusLine, so we
 * reuse the staged `statusline.mjs` bundle. We do **not** install Stop hooks:
 * Grok treats Stop `additionalContext` as a keep-working gate.
 *
 * A repo-local `.grok/config.toml` cannot set the status line (Grok strips
 * it). Only the user file is patched.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_GROK, binDir } from "../config.js";
import { distPath } from "../pkg.js";
import {
  BACKUP_SUFFIX,
  ensureBackup,
  hasBackup,
  restoreFromBackup,
} from "./json-settings.js";
import { findTable, parseTableValues, removeTable, upsertTable } from "./toml-table.js";

const TABLE = "ui.status_line";
const DEFAULT_REFRESH = 10;
const RUNTIME = "statusline.mjs";

export function grokHome(home = homedir()): string {
  return process.env.GROK_HOME || join(home, ".grok");
}

export function grokConfigPath(home = homedir()): string {
  return join(grokHome(home), "config.toml");
}

/** True if this machine looks like it runs Grok Build (home dir, not PATH). */
export function grokDetected(home = homedir()): boolean {
  const dir = grokHome(home);
  return existsSync(join(dir, "config.toml")) || existsSync(join(dir, "version.json"));
}

function bundledStatusline(): string {
  return distPath("claude", RUNTIME);
}

function installedStatusline(): string {
  return join(binDir(), RUNTIME);
}

function hasBundledRuntime(): boolean {
  return existsSync(bundledStatusline());
}

function stageRuntime(): string | null {
  if (!hasBundledRuntime()) return null;
  const dir = binDir();
  mkdirSync(dir, { recursive: true });
  copyFileSync(bundledStatusline(), installedStatusline());
  return dir;
}

function statuslineCommand(): string {
  // LATENT_AGENT so impressions bill under `grok`, not claude-code.
  // Quoted path so spaces survive `sh -c` (Grok runs a shell line).
  return `LATENT_AGENT=${AGENT_GROK} node "${installedStatusline()}"`;
}

export function isOurGrokCommand(cmd: string): boolean {
  return /latent-protocol[/\\]bin[/\\]statusline\.mjs/.test(cmd);
}

function readConfig(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function tableValues(src: string): Record<string, string> {
  const found = findTable(src, TABLE);
  if (!found) return {};
  return parseTableValues(found.body);
}

/** True when the user file already points our staged statusline. */
export function grokPatched(home = homedir()): boolean {
  const src = readConfig(grokConfigPath(home));
  if (src == null) return false;
  return isOurGrokCommand(tableValues(src).command ?? "");
}

export function installGrok(opts: { refreshInterval?: number } = {}): string {
  const refresh = opts.refreshInterval ?? DEFAULT_REFRESH;
  const cfgPath = grokConfigPath();
  if (!grokDetected()) {
    return "ℹ️  Grok Build not detected; skipped.";
  }

  const staged = stageRuntime();
  if (!staged) {
    return (
      "⚠️  Grok: runtime bundle missing — run `npm run build` in cli/ first.\n" +
      "   (Published installs always have it; this only happens running from source.)"
    );
  }

  mkdirSync(dirname(cfgPath), { recursive: true });
  const before = readConfig(cfgPath);
  ensureBackup(cfgPath, before);

  const existing = before ?? "";
  const vals = tableValues(existing);
  if (vals.type && !isOurGrokCommand(vals.command ?? "")) {
    // builtin / disabled / a user's own command — do not clobber.
    return (
      `⚠️  Grok: ${cfgPath} already has [ui.status_line] (type=${vals.type}` +
      (vals.command ? `, command=${vals.command}` : "") +
      "). Left untouched.\n" +
      "   Disable or remove that table, then re-run init to install the Latent row."
    );
  }

  const next = upsertTable(existing, TABLE, {
    type: "command",
    command: statuslineCommand(),
    refresh_interval: refresh,
    padding: 0,
  });
  writeFileSync(cfgPath, next, "utf8");
  return (
    `✅ Grok Build status line → ${cfgPath}\n` +
    `   runtime: ${installedStatusline()}\n` +
    `   backup:  ${cfgPath}${BACKUP_SUFFIX}\n` +
    `   command: ${statuslineCommand()} (refresh ${refresh}s)\n` +
    "   Restart Grok to apply (config.toml is read at startup)."
  );
}

export function uninstallGrok(): string {
  const cfgPath = grokConfigPath();

  if (hasBackup(cfgPath)) {
    const r = restoreFromBackup(cfgPath);
    if (r.restored) {
      return `✅ Restored ${cfgPath} from the pristine backup.`;
    }
  }

  const src = readConfig(cfgPath);
  if (src == null) {
    return "ℹ️  No Grok config.toml found; nothing to remove.";
  }
  const vals = tableValues(src);
  if (!isOurGrokCommand(vals.command ?? "")) {
    return "ℹ️  No Latent Grok status line found; nothing to remove.";
  }
  writeFileSync(cfgPath, removeTable(src, TABLE), "utf8");
  return `✅ Removed Latent [ui.status_line] from ${cfgPath}`;
}

export function grokStatus(): string {
  if (!grokDetected()) return "Grok Build: not detected";
  const cfgPath = grokConfigPath();
  const src = readConfig(cfgPath);
  if (src == null) return "Grok Build: detected, no config.toml";
  const vals = tableValues(src);
  if (isOurGrokCommand(vals.command ?? "")) {
    return `Grok Build: patched (${vals.command})`;
  }
  return "Grok Build: detected, not patched";
}
