import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export const DEFAULT_SERVER = "https://api.latentprotocol.xyz";

/** Retired Railway hostnames — auto-migrated to DEFAULT_SERVER on init/resolve. */
export const DEPRECATED_SERVERS = new Set([
  "https://agent-kickbacks-production.up.railway.app",
  "https://ad-server-production-bffc.up.railway.app",
]);

export function canonicalizeServer(url: string): string {
  const normalized = url.replace(/\/+$/, "");
  return DEPRECATED_SERVERS.has(normalized) ? DEFAULT_SERVER : normalized;
}

/**
 * Canonical host-agent identifier for Claude Code.
 *
 * Every surface of one agent must report the same `agent` value, or the ad
 * server sees two unrelated agents and splits targeting and reporting in half.
 * Claude Code has two surfaces — the status line and the turn hooks — so the
 * name lives here rather than as a literal in each of them.
 */
export const AGENT_CLAUDE_CODE = "claude-code";

/** Host-agent identifier for Grok Build's status-line surface. */
export const AGENT_GROK = "grok";

/** Resolved at call time so HOME overrides (tests / sudo) are respected. */
export function configDir(): string {
  return join(homedir(), ".latent-protocol");
}

export function configFile(): string {
  return join(configDir(), "config.json");
}

/**
 * Where `init` drops the self-contained runtime bundles (statusline.mjs,
 * hook.mjs) that the Claude Code surface points its settings.json at.
 *
 * Runtime surfaces must never shell out to `npx` — a status line that
 * re-resolves a git dependency every few seconds thrashes the npm cache and
 * times out. The bundles here are plain `node <file>` targets instead.
 */
export function binDir(): string {
  return join(configDir(), "bin");
}

export function cacheFile(): string {
  return join(configDir(), "statusline_cache.json");
}

export function deviceIdFile(): string {
  return join(configDir(), "device_id");
}

/**
 * Stable per-install identifier, shared across every surface (Claude Code,
 * Codex/MiMo, OpenClaw, the VS Code extension, and the Python adapters all
 * read/write the same `~/.latent-protocol/device_id` file). Not a secret —
 * just a correlation signal so the server can rate-limit/cap per physical
 * machine, not only per (free, instantly-mintable) wallet.
 *
 * Best-effort: never throws. A read/write failure just means this call sends
 * no device_id — ad serving must never depend on this file existing.
 */
export function deviceId(): string {
  try {
    const existing = readFileSync(deviceIdFile(), "utf8").trim();
    if (existing) return existing;
  } catch {
    // fall through to create
  }
  const id = randomBytes(16).toString("hex");
  try {
    mkdirSync(configDir(), { recursive: true });
    // Exclusive create: if another surface's process wins the race, this
    // throws EEXIST and we fall through to re-read its winning value below.
    writeFileSync(deviceIdFile(), id, { flag: "wx" });
    return id;
  } catch {
    try {
      const winner = readFileSync(deviceIdFile(), "utf8").trim();
      if (winner) return winner;
    } catch {
      // FS unavailable — fall back to this call's in-memory id rather than
      // block ad serving. Not persisted, so a future call may mint another;
      // acceptable, this is a soft signal, not an identity guarantee.
    }
    return id;
  }
}

/** @deprecated use configDir() — kept for status output compatibility */
export const CONFIG_DIR = join(homedir(), ".latent-protocol");
/** @deprecated use configFile() */
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
/** @deprecated use cacheFile() */
export const CACHE_FILE = join(CONFIG_DIR, "statusline_cache.json");

export interface LatentConfig {
  wallet?: string;
  enabled?: boolean;
  frequency?: number;
  server?: string;
  min_payout?: number;
  categories?: string;
  /** Cached path to hermes-webui static/ (auto-detected by init). */
  hermes_webui_static?: string;
  /** prelaunch = wallet + scan only; live = ads enabled. */
  mode?: "prelaunch" | "live";
  /** Claude Code only: the turn-start hook keeps settings.json `spinnerVerbs`
   *  in sync with the current ad. Set true by `init` when `claude --version`
   *  confirms support (CC >= 2.1.143); false when a pre-2.1.143 CLI is
   *  positively detected. Undefined ⇒ never resolved ⇒ hook leaves it alone. */
  spinner_verbs?: boolean;
  /** ISO timestamp when POST /prelaunch/register succeeded. */
  prelaunch_registered_at?: string;
}

export function loadConfig(): LatentConfig {
  try {
    return JSON.parse(readFileSync(configFile(), "utf8")) as LatentConfig;
  } catch {
    return {};
  }
}

export function saveConfig(data: Partial<LatentConfig>): LatentConfig {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const next = { ...loadConfig(), ...data };
  writeFileSync(configFile(), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function resolveServer(cfg: LatentConfig = loadConfig()): string {
  const raw = cfg.server || process.env.ADS_SERVER || DEFAULT_SERVER;
  return canonicalizeServer(raw);
}

export function resolveWallet(cfg: LatentConfig = loadConfig()): string {
  return cfg.wallet || process.env.ADS_WALLET || "";
}

export function isEnabled(cfg: LatentConfig = loadConfig()): boolean {
  const env = process.env.ADS_ENABLED;
  if (env !== undefined) {
    return !["false", "0", "no"].includes(env.toLowerCase());
  }
  return cfg.enabled !== false;
}
