/**
 * Codex — removal only.
 *
 * Older releases registered turn hooks in ~/.codex/hooks.json that ran
 * `node ~/.latent-protocol/bin/codex-hook.mjs <event> --agent codex`; on
 * `UserPromptSubmit` that returned the ad as `additionalContext`, i.e. into the
 * model's prompt. We no longer ship surfaces that rewrite an LLM call, so
 * `init` never installs them; `init` and `uninstall` strip ours (current
 * bundle or legacy `npx` entries) and delete the staged runtime.
 *
 * hooks.json edits go through json-settings.ts: we refuse to write a file we
 * cannot parse, and restore the pristine `.latent-protocol.bak` when one
 * exists.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { binDir } from "../config.js";
import { hasBackup, readSettings, restoreFromBackup, setPath } from "./json-settings.js";

/** Codex hook events older releases wrote into. */
const HOST_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"];

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

/** A hook-group entry that belongs to us — current bundle or legacy npx. */
function isOurHookCommand(cmd: string): boolean {
  return (
    cmd.includes("latent-protocol hook") ||
    cmd.includes("latent hook") ||
    /latent-protocol[/\\]bin[/\\]codex-hook\.mjs/.test(cmd)
  );
}

function stripOurs(arr: unknown[]): unknown[] {
  return arr.filter((entry) => {
    const hooks = (entry as { hooks?: { command?: string }[] })?.hooks;
    if (!Array.isArray(hooks)) return true;
    return !hooks.some((h) => isOurHookCommand(String(h?.command ?? "")));
  });
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
  for (const hostEvent of HOST_EVENTS) {
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

function ourHooksPresent(a: CodexAgentDef): boolean {
  const { raw } = readSettings(hooksPath(a));
  return raw != null && (raw.includes(STAGED_HOOK_NAME) || /latent(-protocol)? hook/.test(raw));
}

/** True when an older release's turn hooks are still in a hooks.json. */
export function codexLegacyInstalled(): boolean {
  return CODEX_AGENTS.some((a) => codexDetected(a) && ourHooksPresent(a));
}

export function codexStatus(a: CodexAgentDef): string {
  if (!codexDetected(a)) return `${a.name}: not detected`;
  const { unparseable } = readSettings(hooksPath(a));
  if (unparseable) return `${a.name}: detected, hooks.json not parseable (${agentHome(a)})`;
  return ourHooksPresent(a)
    ? `${a.name}: ⚠️  old turn hooks present (${hooksPath(a)}) — run init or uninstall to remove them`
    : `${a.name}: detected, not supported (no ad surface)`;
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
