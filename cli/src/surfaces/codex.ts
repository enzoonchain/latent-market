/**
 * Codex surface — lifecycle turn hooks in ~/.codex/hooks.json.
 *
 * Codex has no status-line command hook, so we register command hooks on the
 * turn lifecycle. Each invokes a LOCAL bundle —
 * `node ~/.latent-protocol/bin/codex-hook.mjs <event> --agent <id>` — never
 * `npx`: hooks.json's command runs on every turn, and `npx …latent-protocol`
 * re-resolves (and on a cold cache re-clones + rebuilds) the package every
 * time. `init` copies the bundled hook runtime in once.
 *
 * Event names are the OFFICIAL Codex CLI hook events (learn.chatgpt.com/docs/
 * hooks): a turn starts with `UserPromptSubmit` and ends with `Stop`. There is
 * no `TurnStart` / `TurnEnd` in the CLI hooks.json schema — those come from the
 * Codex app-server / IDE JSON-RPC protocol, covered by the VS Code / Cursor
 * extension surface instead. Writing them here would silently never fire.
 *
 * hooks.json edits go through json-settings.ts: we refuse to write a file we
 * cannot parse, keep one pristine `.latent-protocol.bak`, and (for Claude's
 * JSONC) preserve comments. Legacy `npx …` entries from older installs are
 * recognised and migrated.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { binDir } from "../config.js";
import { distPath } from "../pkg.js";
import {
  ensureBackup,
  hasBackup,
  readSettings,
  restoreFromBackup,
  setPath,
} from "./json-settings.js";

/** Host event key → our hook event name. Official Codex events only. */
const EVENTS: Record<string, string> = {
  SessionStart: "session-start",
  UserPromptSubmit: "turn-start",
  Stop: "turn-end",
  SessionEnd: "session-end",
};

/** The shared turn-hook bundle (handles every agent via `--agent`). Lives
 *  under dist/claude/ because the Claude surface bundles it; it is not
 *  Claude-specific. */
const HOOK_BUNDLE = distPath("claude", "hook.mjs");
const STAGED_HOOK_NAME = "codex-hook.mjs";

export interface CodexAgentDef {
  id: "codex";
  name: string;
  homeEnv: string;
  homeRel: string;
  binaries: string[];
}

export const CODEX_AGENTS: CodexAgentDef[] = [
  { id: "codex", name: "Codex", homeEnv: "CODEX_HOME", homeRel: ".codex", binaries: ["codex"] },
];

function which(bin: string): boolean {
  const res = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
  return res.status === 0 && Boolean((res.stdout || "").trim());
}

function agentHome(a: CodexAgentDef): string {
  return process.env[a.homeEnv] || join(homedir(), a.homeRel);
}

function hooksPath(a: CodexAgentDef): string {
  return join(agentHome(a), "hooks.json");
}

export function codexDetected(a: CodexAgentDef): boolean {
  return existsSync(agentHome(a)) || a.binaries.some(which);
}

function stagedHook(): string {
  return join(binDir(), STAGED_HOOK_NAME);
}

function hookCommand(agentId: string, event: string): string {
  return `node "${stagedHook()}" ${event} --agent ${agentId}`;
}

/** A hook-group entry that belongs to us — current bundle or legacy npx. */
function isOurHookCommand(cmd: string): boolean {
  return (
    cmd.includes("latent-protocol hook") ||
    cmd.includes("latent hook") ||
    /latent-protocol[/\\]bin[/\\]codex-hook\.mjs/.test(cmd)
  );
}

function hookGroup(agentId: string, event: string): unknown {
  return { hooks: [{ type: "command", command: hookCommand(agentId, event), timeout: 10 }] };
}

function stripOurs(arr: unknown[]): unknown[] {
  return arr.filter((entry) => {
    const hooks = (entry as { hooks?: { command?: string }[] })?.hooks;
    if (!Array.isArray(hooks)) return true;
    return !hooks.some((h) => isOurHookCommand(String(h?.command ?? "")));
  });
}

/** Copy the bundled hook runtime into ~/.latent-protocol/bin/. Returns the
 *  path, or null when the package has no bundle (running from source). */
function stageHook(): string | null {
  if (!existsSync(HOOK_BUNDLE)) return null;
  mkdirSync(binDir(), { recursive: true });
  copyFileSync(HOOK_BUNDLE, stagedHook());
  return stagedHook();
}

export function installCodexAgent(a: CodexAgentDef): string {
  const path = hooksPath(a);
  const before = readSettings(path);
  if (before.unparseable) {
    return `⚠️  ${a.name}: ${path} is not valid JSON — left untouched. Fix it, then re-run init.`;
  }

  const staged = stageHook();
  if (!staged) {
    return `⚠️  ${a.name}: runtime bundle missing — run \`npm run build\` in cli/ first.`;
  }

  mkdirSync(agentHome(a), { recursive: true });
  ensureBackup(path, before.raw);

  let raw = before.raw ?? "{}\n";
  const existing = (before.data?.hooks as Record<string, unknown[]>) ?? {};
  for (const [hostEvent, ourEvent] of Object.entries(EVENTS)) {
    const kept = Array.isArray(existing[hostEvent]) ? stripOurs(existing[hostEvent]) : [];
    raw = setPath(raw, ["hooks", hostEvent], [...kept, hookGroup(a.id, ourEvent)]);
  }
  writeFileSync(path, raw, "utf8");
  return (
    `✅ ${a.name} turn hooks → ${path}\n` +
    `   runtime: ${staged}\n` +
    `   backup:  ${path}.latent-protocol.bak\n` +
    `   (SessionStart/UserPromptSubmit/Stop/SessionEnd → node codex-hook.mjs … --agent ${a.id})`
  );
}

export function uninstallCodexAgent(a: CodexAgentDef): string {
  const path = hooksPath(a);

  if (hasBackup(path)) {
    const r = restoreFromBackup(path);
    if (r.restored) {
      cleanStagedHookIfUnused();
      return `✅ ${a.name}: restored ${path} from the pristine backup.`;
    }
  }

  if (!existsSync(path)) return `ℹ️  ${a.name}: no hooks.json; nothing to remove.`;
  const { raw, data, unparseable } = readSettings(path);
  if (unparseable || raw === null) {
    return `⚠️  ${a.name}: ${path} is not valid JSON — left untouched. Remove our hooks by hand.`;
  }

  let next = raw;
  let changed = false;
  const hooks = (data?.hooks as Record<string, unknown[]>) ?? {};
  let remaining = Object.keys(hooks).length;
  for (const hostEvent of Object.keys(EVENTS)) {
    if (!Array.isArray(hooks[hostEvent])) continue;
    const cleaned = stripOurs(hooks[hostEvent]);
    if (cleaned.length === hooks[hostEvent].length) continue;
    changed = true;
    if (cleaned.length) {
      next = setPath(next, ["hooks", hostEvent], cleaned);
    } else {
      next = setPath(next, ["hooks", hostEvent], undefined);
      remaining -= 1;
    }
  }
  if (remaining === 0 && "hooks" in (data ?? {})) next = setPath(next, ["hooks"], undefined);

  if (!changed) return `ℹ️  ${a.name}: no Latent hooks found.`;
  writeFileSync(path, next, "utf8");
  cleanStagedHookIfUnused();
  return `✅ ${a.name}: removed Latent turn hooks from ${path}`;
}

/** Remove the staged codex-hook.mjs only when no Codex-family agent still
 *  references it. */
function cleanStagedHookIfUnused(): void {
  const stillUsed = CODEX_AGENTS.some((a) => {
    const { raw } = readSettings(hooksPath(a));
    return raw != null && raw.includes(STAGED_HOOK_NAME);
  });
  if (stillUsed) return;
  const p = stagedHook();
  if (existsSync(p)) {
    try {
      rmSync(p);
    } catch {
      /* best effort */
    }
  }
}

export function codexStatus(a: CodexAgentDef): string {
  if (!codexDetected(a)) return `${a.name}: not detected`;
  const { raw, unparseable } = readSettings(hooksPath(a));
  if (unparseable) return `${a.name}: detected, hooks.json not parseable (${agentHome(a)})`;
  const patched = raw != null && (raw.includes(STAGED_HOOK_NAME) || /latent(-protocol)? hook/.test(raw));
  return `${a.name}: ${patched ? "patched (turn hooks)" : "detected, not patched"} (${agentHome(a)})`;
}

/** Install every detected Codex-family agent. */
export function installCodexFamily(): string {
  const present = CODEX_AGENTS.filter(codexDetected);
  if (!present.length) return "ℹ️  No Codex install detected — skipped.";
  return present.map(installCodexAgent).join("\n");
}

export function uninstallCodexFamily(): string {
  const present = CODEX_AGENTS.filter(codexDetected);
  if (!present.length) return "ℹ️  No Codex install detected; nothing to remove.";
  return present.map(uninstallCodexAgent).join("\n");
}

export function codexFamilyStatus(): string[] {
  return CODEX_AGENTS.filter(codexDetected).map(codexStatus);
}

export function codexFamilyDetectionRows(): [string, string, string][] {
  return CODEX_AGENTS.map((a) => [
    a.name,
    codexDetected(a) ? (a.binaries.some(which) ? "detected+bin" : "detected") : "not found",
    agentHome(a),
  ]);
}
