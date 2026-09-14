/** Config bridge: VS Code settings overlaid on ~/.latent-protocol/config.json. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
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

/**
 * Stable per-install identifier, shared with every other surface (Claude
 * Code, Codex/MiMo, OpenClaw, and the Python adapters all read/write this
 * same file). Not a secret — a correlation signal so the server can cap per
 * physical machine, not only per (free, instantly-mintable) wallet.
 * Best-effort: never throws.
 */
export function deviceId(): string {
  try {
    const existing = readFileSync(DEVICE_ID_FILE, "utf8").trim();
    if (existing) return existing;
  } catch {
    // fall through to create
  }
  const id = randomBytes(16).toString("hex");
  try {
    mkdirSync(join(homedir(), ".latent-protocol"), { recursive: true });
    writeFileSync(DEVICE_ID_FILE, id, { flag: "wx" });
    return id;
  } catch {
    try {
      const winner = readFileSync(DEVICE_ID_FILE, "utf8").trim();
      if (winner) return winner;
    } catch {
      // FS unavailable — fall back to this call's in-memory id.
    }
    return id;
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
