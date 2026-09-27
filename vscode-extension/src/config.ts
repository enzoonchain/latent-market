/** Config bridge: VS Code settings overlaid on ~/.latent-protocol/config.json. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

export interface LatentConfig {
  wallet: string;
  server: string;
  enabled: boolean;
  rotateSeconds: number;
  patchAgentBundles: boolean;
}

function sharedConfig(): { wallet?: string; server?: string; enabled?: boolean } {
  try {
    const p = join(homedir(), ".latent-protocol", "config.json");
    return JSON.parse(readFileSync(p, "utf8")) as {
      wallet?: string;
      server?: string;
      enabled?: boolean;
    };
  } catch {
    return {};
  }
}

const DEVICE_ID_FILE = join(homedir(), ".latent-protocol", "device_id");
const DEVICE_CREDENTIAL_RE = /^[0-9a-f]{32}\.\d+\.[A-Za-z0-9_-]+$/i;

/** Server-issued credential, or "" when the file is missing or still a local hex. */
export function deviceId(): string {
  try {
    const existing = readFileSync(DEVICE_ID_FILE, "utf8").trim();
    if (DEVICE_CREDENTIAL_RE.test(existing)) return existing;
  } catch {
    // missing file
  }
  return "";
}

/** Register once with the ad server and store the credential next to the other surfaces. */
export async function ensureDeviceCredential(server: string): Promise<string> {
  const current = deviceId();
  if (current) return current;
  const base = server.replace(/\/+$/, "");
  let credential = "";
  try {
    const res = await fetch(`${base}/device/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3000),
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

export function loadConfig(): LatentConfig {
  const s = vscode.workspace.getConfiguration("latent");
  const shared = sharedConfig();
  return {
    wallet: (s.get<string>("wallet") || shared.wallet || "").trim(),
    server: (s.get<string>("server") || shared.server || "https://api.latentprotocol.xyz").replace(
      /\/+$/,
      "",
    ),
    enabled: s.get<boolean>("enabled", true) && shared.enabled !== false,
    rotateSeconds: Math.max(3, s.get<number>("rotateSeconds", 10)),
    patchAgentBundles: s.get<boolean>("patchAgentBundles", false),
  };
}
