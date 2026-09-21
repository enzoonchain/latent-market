/**
 * MiMo Code surface — a native plugin, not a Codex-family hooks.json entry.
 *
 * MiMo discovers TypeScript plugins under its own config directory rather than
 * reading a hooks.json like Codex does (confirmed against a real local MiMo
 * install — see cli/templates/mimo-plugin/). The plugin is a single,
 * dependency-free file: MiMo transpiles it in its own runtime with no module
 * resolution across sibling files, so it must not import the CLI bundle or
 * any other package file.
 *
 * Home resolution mirrors scanners/codex.ts's MiMo entry: MIMO_HOME first,
 * else the first existing candidate among the layouts real installs use.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { templatePath } from "../pkg.js";

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

export function resolveMimoPluginTemplate(): string | null {
  const p = templatePath("mimo-plugin", PLUGIN_FILE);
  return existsSync(p) ? p : null;
}

export function installMimo(): string {
  const source = resolveMimoPluginTemplate();
  if (!source) return "⚠️  MiMo: bundled plugin template is missing; reinstall latent-protocol.";
  const target = mimoPluginPath();
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return `✅ MiMo plugin → ${target}\n   Restart MiMo Code to load the sponsored response footer.`;
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
  const target = mimoPluginPath();
  try {
    return readFileSync(target, "utf8").includes(MARKER)
      ? `MiMo: patched (plugin: ${target})`
      : `MiMo: detected, not patched (${mimoConfigDir()})`;
  } catch {
    return `MiMo: detected, not patched (${mimoConfigDir()})`;
  }
}
