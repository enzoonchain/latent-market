/**
 * Plugin configuration.
 *
 * OpenClaw validates the user's config against `openclaw.plugin.json`'s
 * `configSchema` and hands the resulting object to the plugin. We merge it with
 * `process.env` fallbacks, `~/.latent-protocol/config.json` (written by
 * `npx latent-protocol init`), and defaults so a single `getConfig(raw)` call
 * is the only config source the hooks ever touch.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PluginConfig {
  wallet: string;
  enabled: boolean;
  frequency: number;
  server: string;
  minPayout: number;
}

const DEFAULT_SERVER = "https://api.latentprotocol.xyz";

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["false", "0", "no"].includes(value.toLowerCase());
}

function envNum(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readLatentConfigFile(): Partial<PluginConfig> {
  const paths = [
    join(homedir(), ".latent-protocol", "config.json"),
    join(homedir(), ".openclaw", "latent-protocol.config.json"),
  ];
  for (const p of paths) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      const out: Partial<PluginConfig> = {};
      if (typeof raw.wallet === "string") out.wallet = raw.wallet;
      if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
      if (typeof raw.frequency === "number") out.frequency = raw.frequency;
      if (typeof raw.server === "string") out.server = raw.server;
      if (typeof raw.min_payout === "number") out.minPayout = raw.min_payout;
      if (typeof raw.minPayout === "number") out.minPayout = raw.minPayout;
      return out;
    } catch {
      // try next
    }
  }
  return {};
}

const DEVICE_ID_FILE = join(homedir(), ".latent-protocol", "device_id");
const DEVICE_CREDENTIAL_RE = /^[0-9a-f]{32}\.\d+\.[A-Za-z0-9_-]+$/i;

/** Server-issued credential shared with the other Latent surfaces. Empty if unset. */
export function deviceId(): string {
  try {
    const existing = readFileSync(DEVICE_ID_FILE, "utf8").trim();
    if (DEVICE_CREDENTIAL_RE.test(existing)) return existing;
  } catch {
    // missing file
  }
  return "";
}

export async function ensureDeviceCredential(server: string): Promise<string> {
  const current = deviceId();
  if (current) return current;
  const base = server.replace(/\/+$/, "");
  let credential = "";
  try {
    const res = await fetch(`${base}/device/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return "";
    const body = (await res.json()) as { credential?: string };
    credential = (body.credential || "").trim();
  } catch {
    return "";
  }
  if (!DEVICE_CREDENTIAL_RE.test(credential)) return "";
  try {
    mkdirSync(join(homedir(), ".latent-protocol"), { recursive: true });
    writeFileSync(DEVICE_ID_FILE, credential, { flag: "wx" });
    return credential;
  } catch {
    const winner = deviceId();
    if (winner) return winner;
    try {
      writeFileSync(DEVICE_ID_FILE, credential);
    } catch {
      return credential;
    }
    return deviceId() || credential;
  }
}

/** Merge the SDK-provided config with env fallbacks and defaults. */
export function getConfig(raw: Partial<PluginConfig> = {}): PluginConfig {
  const file = readLatentConfigFile();
  return {
    wallet: raw.wallet || process.env.ADS_WALLET || file.wallet || "",
    enabled: raw.enabled ?? envBool(process.env.ADS_ENABLED, file.enabled ?? true),
    frequency:
      raw.frequency ??
      envNum(process.env.ADS_FREQUENCY, file.frequency ?? 1),
    server: (
      raw.server ||
      process.env.ADS_SERVER ||
      file.server ||
      DEFAULT_SERVER
    ).replace(/\/+$/, ""),
    minPayout:
      raw.minPayout ??
      envNum(process.env.ADS_MIN_PAYOUT, file.minPayout ?? 5.0),
  };
}
