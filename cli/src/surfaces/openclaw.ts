/**
 * OpenClaw surface installer — thinking-state + footer ads across WA/TG/Slack/…
 *
 * Bundled plugin lives at cli/templates/openclaw-plugin (copied from
 * openclaw-plugin/ at build time) or, when running from a git checkout,
 * the sibling ../../openclaw-plugin directory.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { detectAgents } from "../detect.js";
import { loadConfig, resolveServer, resolveWallet } from "../config.js";
import { packageRoot, templatePath } from "../pkg.js";

const PLUGIN_ID = "latent-protocol";

function run(
  cmd: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, { encoding: "utf8", env: process.env });
  return {
    ok: res.status === 0,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

function which(bin: string): string | null {
  const res = run("bash", ["-lc", `command -v ${bin}`]);
  const out = res.stdout.trim();
  return res.ok && out ? out : null;
}

/** Resolve the OpenClaw plugin source directory (with openclaw.plugin.json). */
export function resolveOpenclawPluginSrc(): string | null {
  const candidates = [
    process.env.LATENT_OPENCLAW_PLUGIN,
    // Shipped in the package (bundle- and tsc-layout safe).
    templatePath("openclaw-plugin"),
    // Git checkout: sibling of the package root (cli/ → ../openclaw-plugin).
    join(packageRoot(), "..", "openclaw-plugin"),
    // Monorepo root when cwd is repo.
    join(process.cwd(), "openclaw-plugin"),
    join(process.cwd(), "cli", "templates", "openclaw-plugin"),
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidates) {
    if (existsSync(join(dir, "openclaw.plugin.json"))) return dir;
  }
  return null;
}

function ensurePluginBuilt(src: string): string {
  const distIndex = join(src, "dist", "index.js");
  if (existsSync(distIndex)) return src;

  // Try building in place
  const npmInstall = run("npm", ["install", "--prefix", src, "--include=dev"]);
  const build = run("npm", ["run", "build", "--prefix", src]);
  if (existsSync(distIndex)) return src;

  // Fall back: if templates already include dist, fine; else warn via caller
  void npmInstall;
  void build;
  return src;
}

function writeOpenclawPluginConfig(extDir: string): void {
  const cfg = loadConfig();
  const wallet = resolveWallet(cfg);
  const server = resolveServer(cfg);
  const frequency = cfg.frequency ?? 1;
  const configPath = join(extDir, "latent-protocol.config.json");
  // Also drop a small sidecar many OpenClaw layouts read; primary is
  // `openclaw config set` below. This file helps offline / linked installs.
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        wallet,
        enabled: true,
        frequency,
        server,
        minPayout: cfg.min_payout ?? 5,
      },
      null,
      2,
    ) + "\n",
  );
}

function setOpenclawConfig(wallet: string, server: string, frequency: number): string {
  const lines: string[] = [];
  if (!which("openclaw")) {
    return "ℹ️  openclaw CLI not on PATH — wrote extension files only; enable manually.";
  }

  // Plugin settings live at `plugins.entries.<id>.config` (docs/plugins/manifest.md).
  // `plugins.<id>` is not a config key — writing it makes strict validation fail.
  const attempts = [
    ["config", "set", `plugins.entries.${PLUGIN_ID}.config.wallet`, wallet],
    ["plugins", "config", "set", PLUGIN_ID, "wallet", wallet],
  ];

  let walletSet = false;
  for (const args of attempts) {
    const res = run("openclaw", args);
    if (res.ok) {
      lines.push(`✅ openclaw ${args.join(" ")}`);
      walletSet = true;
      break;
    }
  }
  if (!walletSet) {
    lines.push(
      `⚠️  Could not set wallet via openclaw CLI — set plugins.entries.${PLUGIN_ID}.config.wallet manually.`,
    );
  }

  // Best-effort server / frequency
  for (const [key, val] of [
    [`plugins.entries.${PLUGIN_ID}.config.server`, server],
    [`plugins.entries.${PLUGIN_ID}.config.frequency`, String(frequency)],
  ] as const) {
    run("openclaw", ["config", "set", key, val]);
  }

  const enable = run("openclaw", ["plugins", "enable", PLUGIN_ID]);
  if (enable.ok) lines.push(`✅ openclaw plugins enable ${PLUGIN_ID}`);
  else {
    const alt = run("openclaw", ["plugins", "enable", "@latent-protocol/openclaw-plugin"]);
    if (alt.ok) lines.push("✅ openclaw plugins enable @latent-protocol/openclaw-plugin");
    else lines.push("⚠️  Could not enable plugin via CLI — enable latent-protocol in OpenClaw settings.");
  }

  const restart = run("openclaw", ["gateway", "restart"]);
  if (restart.ok) lines.push("✅ openclaw gateway restart");
  else lines.push("   Restart OpenClaw gateway to load the plugin.");

  return lines.join("\n");
}

export function installOpenclaw(): string {
  const detected = detectAgents();
  if (!detected.openclaw) {
    return "ℹ️  OpenClaw not detected (~/.openclaw missing, no openclaw binary) — skipped.";
  }

  const srcRaw = resolveOpenclawPluginSrc();
  if (!srcRaw) {
    return (
      "⚠️  OpenClaw plugin sources not found in the package.\n" +
      "   Install manually: openclaw plugins install clawhub:latent-protocol"
    );
  }

  const src = ensurePluginBuilt(srcRaw);
  if (!existsSync(join(src, "dist", "index.js"))) {
    return (
      `⚠️  OpenClaw plugin at ${src} has no dist/ — run npm run build there, then re-init.\n` +
      "   Or: openclaw plugins install clawhub:latent-protocol"
    );
  }

  const lines: string[] = [];
  const { paths } = detected;
  mkdirSync(paths.openclawHome, { recursive: true });

  // Always refresh the extension dir first (CLI refuses reinstall if present).
  const dest = join(paths.openclawPlugins, PLUGIN_ID);
  mkdirSync(paths.openclawPlugins, { recursive: true });
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
    lines.push(`ℹ️  Removed existing ${dest} for clean reinstall`);
  }

  const bin = which("openclaw");
  let installed = false;
  if (bin) {
    // Prefer update when tracked; else install --link / plain / copy
    const updated = run("openclaw", ["plugins", "update", PLUGIN_ID]);
    if (updated.ok) {
      lines.push(`✅ openclaw plugins update ${PLUGIN_ID}`);
      installed = true;
    }
    if (!installed) {
      const linked = run("openclaw", ["plugins", "install", src, "--link"]);
      if (linked.ok) {
        lines.push(`✅ openclaw plugins install ${src} --link`);
        installed = true;
      } else {
        const plain = run("openclaw", ["plugins", "install", src]);
        if (plain.ok) {
          lines.push(`✅ openclaw plugins install ${src}`);
          installed = true;
        } else {
          lines.push(
            `ℹ️  openclaw CLI install skipped: ${(linked.stderr || plain.stderr).trim().slice(0, 120)}`,
          );
        }
      }
    }
  }
  if (!installed) {
    cpSync(src, dest, { recursive: true });
    lines.push(`✅ Copied plugin → ${dest}`);
  }

  const cfg = loadConfig();
  const wallet = resolveWallet(cfg);
  const server = resolveServer(cfg);
  const frequency = cfg.frequency ?? 1;

  const extDest = join(paths.openclawPlugins, PLUGIN_ID);
  if (existsSync(extDest)) writeOpenclawPluginConfig(extDest);
  // Also write under home for config bridge
  writeOpenclawPluginConfig(paths.openclawHome);

  if (!wallet) {
    lines.push("⚠️  No wallet in ~/.latent-protocol/config.json — OpenClaw ads stay disabled until set.");
  } else {
    lines.push(setOpenclawConfig(wallet, server, frequency));
  }

  return lines.join("\n");
}

export function uninstallOpenclaw(): string {
  const detected = detectAgents();
  if (!detected.openclaw) return "ℹ️  OpenClaw not detected; nothing to remove.";

  const lines: string[] = [];
  if (which("openclaw")) {
    const dis = run("openclaw", ["plugins", "disable", PLUGIN_ID]);
    if (dis.ok) lines.push(`✅ openclaw plugins disable ${PLUGIN_ID}`);
  }

  const dest = join(detected.paths.openclawPlugins, PLUGIN_ID);
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
    lines.push(`✅ Removed ${dest}`);
  } else {
    lines.push("ℹ️  No copied OpenClaw extension dir found.");
  }
  return lines.join("\n") || "ℹ️  OpenClaw: nothing to uninstall.";
}

export function openclawStatus(): string {
  const d = detectAgents();
  if (!d.openclaw) return "OpenClaw: not detected";

  const dest = join(d.paths.openclawPlugins, PLUGIN_ID);
  const hasExt = existsSync(join(dest, "openclaw.plugin.json"));
  const home = process.env.HOME || homedir();
  const sidecar = join(d.paths.openclawHome, "latent-protocol.config.json");
  let walletHint = "";
  try {
    if (existsSync(sidecar)) {
      const j = JSON.parse(readFileSync(sidecar, "utf8")) as { wallet?: string };
      if (j.wallet) walletHint = ` wallet=${j.wallet.slice(0, 10)}…`;
    }
  } catch {
    // ignore
  }

  if (hasExt) return `OpenClaw: extension present (${dest})${walletHint}`;
  if (d.openclawBin) return `OpenClaw: CLI present, extension not confirmed under ${d.paths.openclawPlugins}`;
  return `OpenClaw: home at ${d.paths.openclawHome} (home=${home})`;
}
