/**
 * MiMo Code — removal only.
 *
 * Older releases installed a native plugin (plugins/latent-protocol.ts) that
 * appended the ad to the model's response text (`experimental.text.complete`).
 * We no longer ship surfaces that rewrite an LLM call or its output, so `init`
 * never installs it; `init` and `uninstall` remove a copy left behind.
 *
 * Home resolution mirrors scanners/codex.ts's MiMo entry: MIMO_HOME first,
 * else the first existing candidate among the layouts real installs use.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const PLUGIN_FILE = "latent-protocol.ts";
const MARKER = "LATENT_PROTOCOL_MIMO_PLUGIN";
const HOME_ENV = "MIMO_HOME";
const HOME_RELS = [join(".config", "mimocode"), ".mimocode", ".mimo"];

function which(bin: string): boolean {
  const res = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
  return res.status === 0 && Boolean((res.stdout || "").trim());
}

/** First existing candidate wins; falls back to the primary (XDG) layout. */
export function mimoConfigDir(): string {
  const fromEnv = process.env[HOME_ENV];
  if (fromEnv) return fromEnv;
  for (const rel of HOME_RELS) {
    const path = join(homedir(), rel);
    if (existsSync(path)) return path;
  }
  return join(homedir(), HOME_RELS[0]!);
}

export function mimoPluginPath(): string {
  return join(mimoConfigDir(), "plugins", PLUGIN_FILE);
}

export function mimoDetected(): boolean {
  return existsSync(mimoConfigDir()) || which("mimo");
}

/** True when an older release's plugin is still on disk. */
export function mimoLegacyInstalled(): boolean {
  try {
    return readFileSync(mimoPluginPath(), "utf8").includes(MARKER);
  } catch {
    return false;
  }
}

export function uninstallMimo(): string {
  const target = mimoPluginPath();
  if (!existsSync(target)) return "ℹ️  MiMo: no Latent plugin found; nothing to remove.";
  try {
    if (!readFileSync(target, "utf8").includes(MARKER)) {
      return `⚠️  MiMo: ${target} is not a Latent-managed plugin; left untouched.`;
    }
    rmSync(target);
    return `✅ MiMo: removed ${target}`;
  } catch {
    return `⚠️  MiMo: could not remove ${target}; remove it manually.`;
  }
}

export function mimoStatus(): string {
  if (!mimoDetected()) return "MiMo: not detected";
  return mimoLegacyInstalled()
    ? `MiMo: ⚠️  old plugin present (${mimoPluginPath()}) — run init or uninstall to remove it`
    : "MiMo: detected, not supported (no ad surface)";
}
