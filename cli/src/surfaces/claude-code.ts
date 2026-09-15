import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_CLAUDE_CODE, binDir, saveConfig } from "../config.js";
import { distPath } from "../pkg.js";
import { detectAgents } from "../detect.js";
import {
  describeParseErrors,
  ensureBackup,
  hasBackup,
  readSettings,
  restoreFromBackup,
  setPath,
} from "./json-settings.js";
import {
  SPINNER_TAGLINE,
  isOurSpinnerVerbs,
} from "./claude-spinner.js";
import { grokPatched } from "./grok.js";

/**
 * Legacy statusLine commands we still recognise so a re-install or `uninstall`
 * cleans them up. Newer installs never write any of these — the status line is
 * a local `node <bundle>` invocation now (see `statuslineCommand`).
 */
const LEGACY_STATUSLINE_COMMANDS = new Set([
  "npx --yes latent-protocol statusline",
  "npx -y latent-protocol statusline",
  "npx --yes github:enzoonchain/latent-protocol statusline",
  "npx -y github:enzoonchain/latent-protocol statusline",
  "npx --yes latent statusline",
  "npx -y latent statusline",
  "latent-protocol statusline",
  "latent statusline",
  "latent-statusline",
]);

// 10s to match the CodeBacks rotation cadence (adcache ROTATE_MS / vsix default).
const DEFAULT_REFRESH = 10;

/** Claude Code lifecycle events we hook → our turn-hook event name. */
const HOOK_EVENTS: Record<string, string> = {
  SessionStart: "session-start",
  UserPromptSubmit: "turn-start",
  Stop: "turn-end",
  SessionEnd: "session-end",
};

/** Bundled runtime scripts shipped in the package (built by scripts/bundle.mjs). */
const RUNTIME_FILES = { statusline: "statusline.mjs", hook: "hook.mjs" } as const;
type RuntimeName = keyof typeof RUNTIME_FILES;

function bundledRuntime(name: RuntimeName): string {
  return distPath("claude", RUNTIME_FILES[name]);
}

function installedRuntime(name: RuntimeName): string {
  return join(binDir(), RUNTIME_FILES[name]);
}

function hasBundledRuntime(): boolean {
  return existsSync(bundledRuntime("statusline")) && existsSync(bundledRuntime("hook"));
}

/** `node "<abs>"` — quote so paths with spaces survive the shell. */
function nodeInvocation(script: string, extra = ""): string {
  return `node "${script}"${extra ? ` ${extra}` : ""}`;
}

function statuslineCommand(): string {
  return nodeInvocation(installedRuntime("statusline"));
}

function hookCommand(event: string): string {
  return nodeInvocation(installedRuntime("hook"), `${event} --agent ${AGENT_CLAUDE_CODE}`);
}

/** Any statusLine command — current or legacy — that belongs to us. */
function isOurStatuslineCommand(cmd: string): boolean {
  return (
    LEGACY_STATUSLINE_COMMANDS.has(cmd) ||
    /latent-protocol[/\\]bin[/\\]statusline\.mjs/.test(cmd)
  );
}

/** Any hook command — current or legacy — that belongs to us. */
function isOurHookCommand(cmd: string): boolean {
  return (
    cmd.includes("latent-protocol hook") ||
    cmd.includes("latent hook") ||
    /latent-protocol[/\\]bin[/\\]hook\.mjs/.test(cmd)
  );
}

interface HookGroup {
  hooks?: { command?: string }[];
}

function hookGroup(event: string): HookGroup {
  return { hooks: [{ type: "command", command: hookCommand(event), timeout: 10 }] as never };
}

/** Drop any hook-group entries that are ours (current or legacy). */
function stripOurHooks(arr: unknown[]): unknown[] {
  return arr.filter((entry) => {
    const hooks = (entry as HookGroup)?.hooks;
    if (!Array.isArray(hooks)) return true;
    return !hooks.some((h) => isOurHookCommand(String(h?.command ?? "")));
  });
}

function statuslineOf(data: Record<string, unknown> | null): { command?: string } | null {
  const sl = data?.statusLine;
  return sl && typeof sl === "object" ? (sl as { command?: string }) : null;
}

/**
 * Copy the bundled runtime into ~/.latent-protocol/bin/ so settings.json can
 * point a bare `node` at it. Returns the install dir, or null when the package
 * has no bundle (running straight from `src/` without a build).
 */
function stageRuntime(): string | null {
  if (!hasBundledRuntime()) return null;
  const dir = binDir();
  mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(RUNTIME_FILES) as RuntimeName[]) {
    copyFileSync(bundledRuntime(name), installedRuntime(name));
  }
  return dir;
}

function cleanRuntimeDir(): void {
  // Grok reuses statusline.mjs — don't yank it out from under a live row.
  if (grokPatched()) return;
  for (const name of Object.keys(RUNTIME_FILES) as RuntimeName[]) {
    const p = installedRuntime(name);
    if (existsSync(p)) {
      try {
        rmSync(p);
      } catch {
        /* best effort */
      }
    }
  }
}

export interface InstallOptions {
  refreshInterval?: number;
  /** Write the settings.json `spinnerVerbs` surface too. Default true
   *  (fail-open); pass false when a pre-2.1.143 `claude` CLI is detected. */
  spinnerVerbs?: boolean;
}

export function installClaudeCode(opts: InstallOptions = {}): string {
  const refreshInterval = opts.refreshInterval ?? DEFAULT_REFRESH;
  const spinnerVerbs = opts.spinnerVerbs ?? true;
  const { paths } = detectAgents();
  const settingsPath = paths.claudeSettings;

  const before = readSettings(settingsPath);
  if (before.unparseable) {
    return (
      `⚠️  Claude Code: ${settingsPath} is not valid JSON — left untouched.\n` +
      `   ${describeParseErrors(before.raw ?? "")}\n` +
      "   Fix the syntax error there, then re-run init."
    );
  }

  const staged = stageRuntime();
  if (!staged) {
    return (
      "⚠️  Claude Code: runtime bundle missing — run `npm run build` in cli/ first.\n" +
      "   (Published installs always have it; this only happens running from source.)"
    );
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  ensureBackup(settingsPath, before.raw);

  let raw = before.raw ?? "{}\n";
  raw = setPath(raw, ["statusLine"], {
    type: "command",
    command: statuslineCommand(),
    refreshInterval,
    padding: 0,
  });

  const existingHooks = (before.data?.hooks as Record<string, unknown[]>) ?? {};
  for (const [event, ourEvent] of Object.entries(HOOK_EVENTS)) {
    const existing = Array.isArray(existingHooks[event]) ? existingHooks[event] : [];
    raw = setPath(raw, ["hooks", event], [...stripOurHooks(existing), hookGroup(ourEvent)]);
  }

  // spinnerVerbs: seed it (or evict a stale one of ours) — but never touch a
  // `spinnerVerbs` the user set themselves. The turn-start hook keeps it in
  // sync with the live ad from here on (gated on config.spinner_verbs).
  const userOwnsSpinner =
    before.data != null &&
    "spinnerVerbs" in before.data &&
    !isOurSpinnerVerbs(before.data.spinnerVerbs);
  let spinnerLine = "not touched (user-set)";
  if (!userOwnsSpinner) {
    if (spinnerVerbs) {
      raw = setPath(raw, ["spinnerVerbs"], { mode: "replace", verbs: [SPINNER_TAGLINE] });
      spinnerLine = "seeded (hook keeps it in sync with the live ad)";
    } else if (before.data != null && "spinnerVerbs" in before.data) {
      raw = setPath(raw, ["spinnerVerbs"], undefined);
      spinnerLine = "removed (CLI < 2.1.143)";
    } else {
      spinnerLine = "skipped (CLI < 2.1.143)";
    }
  }
  saveConfig({ spinner_verbs: userOwnsSpinner ? false : spinnerVerbs });

  writeFileSync(settingsPath, raw, "utf8");
  return (
    `✅ Claude Code statusLine + turn hooks → ${settingsPath}\n` +
    `   runtime: ${staged}/ (statusline.mjs, hook.mjs)\n` +
    `   backup:  ${settingsPath}.latent-protocol.bak\n` +
    `   statusLine:   ${statuslineCommand()} (refresh ${refreshInterval}s)\n` +
    `   spinnerVerbs: ${spinnerLine}\n` +
    "   hooks: SessionStart/UserPromptSubmit/Stop/SessionEnd → node hook.mjs … --agent claude-code\n" +
    "   Restart Claude Code to apply."
  );
}

export function uninstallClaudeCode(): string {
  const { paths } = detectAgents();
  const settingsPath = paths.claudeSettings;

  // Prefer a byte-exact revert from the pristine backup init wrote.
  if (hasBackup(settingsPath)) {
    const r = restoreFromBackup(settingsPath);
    if (r.restored) {
      cleanRuntimeDir();
      return `✅ Restored ${settingsPath} from the pristine backup; removed staged runtime.`;
    }
  }

  if (!existsSync(settingsPath)) {
    return "ℹ️  No Claude Code settings.json found; nothing to remove.";
  }
  const { raw, data, unparseable } = readSettings(settingsPath);
  if (unparseable || raw === null) {
    return `⚠️  ${settingsPath} is not valid JSON — left untouched. Remove our statusLine/hooks by hand.`;
  }

  let next = raw;
  let changed = false;

  const sl = statuslineOf(data);
  if (sl && isOurStatuslineCommand(String(sl.command ?? ""))) {
    next = setPath(next, ["statusLine"], undefined);
    changed = true;
  }

  if (data != null && "spinnerVerbs" in data && isOurSpinnerVerbs(data.spinnerVerbs)) {
    next = setPath(next, ["spinnerVerbs"], undefined);
    changed = true;
  }

  const hooks = (data?.hooks as Record<string, unknown[]>) ?? {};
  let remainingHookEvents = Object.keys(hooks).length;
  for (const event of Object.keys(HOOK_EVENTS)) {
    if (!Array.isArray(hooks[event])) continue;
    const cleaned = stripOurHooks(hooks[event]);
    if (cleaned.length === hooks[event].length) continue;
    changed = true;
    if (cleaned.length) {
      next = setPath(next, ["hooks", event], cleaned);
    } else {
      next = setPath(next, ["hooks", event], undefined);
      remainingHookEvents -= 1;
    }
  }
  if (remainingHookEvents === 0 && "hooks" in (data ?? {})) {
    next = setPath(next, ["hooks"], undefined);
  }

  if (!changed) return "ℹ️  No Latent Protocol statusLine/hooks found; nothing to remove.";
  writeFileSync(settingsPath, next, "utf8");
  cleanRuntimeDir();
  return `✅ Removed Latent statusLine + turn hooks from ${settingsPath}`;
}

export function claudeCodeStatus(): string {
  const { paths, claudeCode } = detectAgents();
  if (!claudeCode) return "Claude Code: not detected";
  const { data, unparseable } = readSettings(paths.claudeSettings);
  if (unparseable) return "Claude Code: detected, settings.json not parseable";
  const sl = statuslineOf(data);
  if (sl && isOurStatuslineCommand(String(sl.command ?? ""))) {
    return `Claude Code: patched (${sl.command})`;
  }
  return "Claude Code: detected, not patched";
}
