#!/usr/bin/env node
import {
  canonicalizeServer,
  configFile,
  loadConfig,
  resolveServer,
  resolveWallet,
  saveConfig,
} from "./config.js";
import {
  detectAgents,
  formatDetectionTable,
  formatSurfaceMatrix,
} from "./detect.js";
import { ensureWallet } from "./wallet.js";
import { getBalance } from "./api.js";
import { healthSummary, resetHealth } from "./killswitch.js";
import { readSessionFromStdin, render } from "./statusline.js";
import {
  claudeCodeStatus,
  installClaudeCode,
  uninstallClaudeCode,
} from "./surfaces/claude-code.js";
import { grokStatus, installGrok, uninstallGrok } from "./surfaces/grok.js";
import { detectSpinnerVerbsSupport } from "./surfaces/claude-cli-version.js";
import { hermesStatus, installHermes, uninstallHermes } from "./surfaces/hermes.js";
import {
  installOpenclaw,
  openclawStatus,
  uninstallOpenclaw,
} from "./surfaces/openclaw.js";
import { codexFamilyStatus, codexLegacyInstalled, uninstallCodexFamily } from "./surfaces/codex.js";
import { mimoLegacyInstalled, mimoStatus, uninstallMimo } from "./surfaces/mimo.js";
import {
  installVscode,
  uninstallVscode,
  vscodeStatus,
} from "./surfaces/vscode.js";
import { runHook, type HookEvent } from "./hook.js";
import { runPrelaunch, runActivate } from "./prelaunch.js";
import { DEFAULT_SCAN_DAYS } from "./scanners/types.js";

function printHelp(): void {
  console.log(`latent-protocol — earn USDC while your agent thinks

Usage:
  npx latent-protocol init [--yes] [--wallet 0x…] [--email you@domain] [--no-browser] [--server URL]
  npx latent-protocol status
  npx latent-protocol uninstall
  npx latent-protocol statusline [--install|--uninstall]
  npx latent-protocol hook <event> --agent claude-code
  npx latent-protocol prelaunch [--yes] [--wallet 0x…] [--email you@domain] [--days 30]
  npx latent-protocol activate
  npx latent-protocol help

Commands:
  init         Detect agents, bind a Privy/existing wallet, patch every found surface
  prelaunch    Pre-launch signup: wallet + local scan + register (ads OFF)
  activate     Enable ads and patch surfaces (after public launch)
  status       Show config, balance, and patched surfaces
  uninstall    Revert Claude Code + Grok + Hermes + OpenClaw + VS Code patches (+ old Codex / MiMo installs)
  statusline   Claude Code / Grok status-line renderer (stdin → stdout)
  hook         Turn-lifecycle hook runtime (invoked by installed hooks)

Surfaces auto-installed when detected:
  • Hermes Desktop — agent-ads plugin, status-bar sponsored line
  • Hermes WebUI — extension latent-ads (Settings → Extensions), no source edits
  • Claude Code — statusLine + turn hooks (staged to ~/.latent-protocol/bin, run via node)
                  + spinnerVerbs thinking-shimmer line on CC >= 2.1.143
  • Grok Build — status line in ~/.grok/config.toml (same staged statusline.mjs)
  • OpenClaw — sponsored footer on the final reply (all channels)
  • Cursor / VS Code — extension auto-installed via the code/cursor CLI when detected
`);
}

function parseFlags(args: string[]): {
  yes: boolean;
  wallet?: string;
  email?: string;
  server?: string;
  rest: string[];
} {
  let yes = false;
  let wallet: string | undefined;
  let email: string | undefined;
  let server: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--generate") {
      // Removed: a raw local key is not claimable by Privy, and the only copy
      // of it was the line printed to the terminal.
      throw new Error(
        "--generate was removed. Use the auth link (plain `init`), --email you@domain, or --wallet 0x….",
      );
    }
    else if (a === "--wallet") {
      wallet = args[++i];
    } else if (a.startsWith("--wallet=")) {
      wallet = a.slice("--wallet=".length);
    } else if (a === "--email") {
      email = args[++i];
    } else if (a.startsWith("--email=")) {
      email = a.slice("--email=".length);
    } else if (a === "--no-browser") {
      // Read by openInBrowser(); an env var so prelaunch picks it up too.
      process.env.LATENT_NO_BROWSER = "1";
    } else if (a === "--server") {
      server = args[++i];
    } else if (a.startsWith("--server=")) {
      server = a.slice("--server=".length);
    } else {
      rest.push(a);
    }
  }
  return { yes, wallet, email, server, rest };
}

async function cmdInit(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  console.log("🔍 Detecting agents…\n");
  const detected = detectAgents();
  console.log(formatDetectionTable(detected));
  console.log();

  const anyAgent =
    detected.claudeCode ||
    detected.hermes ||
    detected.hermesWebui ||
    detected.openclaw ||
    detected.grok;

  if (!anyAgent) {
    console.log(
      "No Claude Code / Grok / Hermes / Hermes WebUI / OpenClaw install found.\n" +
        "Install an agent first, or pass --yes to still create a wallet/config.",
    );
    if (!flags.yes && !flags.wallet && !flags.email) {
      process.exitCode = 1;
      return;
    }
  }

  // Canonical first: a retired Railway hostname passed with --server has to be
  // migrated before the wallet call goes out, or `init` pregenerates against a
  // host that is gone. `prelaunch` already does it in this order.
  const server = flags.server
    ? canonicalizeServer(flags.server)
    : resolveServer(loadConfig());
  const wallet = await ensureWallet({
    yes: flags.yes,
    wallet: flags.wallet,
    email: flags.email,
    server,
  });
  // Persist canonical server + every-message ads (overrides older frequency: 5 configs).
  saveConfig({ server, frequency: 1 });
  console.log(`\n💳 Wallet: ${wallet}`);
  console.log(`   Config: ${configFile()}`);
  console.log(`   Server: ${server}`);
  console.log(`   Frequency: 1 (every message)\n`);

  // Only install surfaces that are actually present (or --yes for Claude/Hermes legacy).
  if (detected.claudeCode) {
    const spinnerVerbs = await detectSpinnerVerbsSupport();
    console.log(installClaudeCode({ spinnerVerbs }));
    console.log();
  }
  if (detected.grok) {
    console.log(installGrok());
    console.log();
  }
  if (detected.hermes || detected.hermesWebui) {
    console.log(installHermes());
    console.log();
  }
  if (detected.openclaw) {
    console.log(installOpenclaw());
    console.log();
  }
  // Codex and MiMo are no longer supported (their only surfaces rewrote the
  // LLM call or its output); strip what an older release installed.
  if (codexLegacyInstalled()) {
    console.log(uninstallCodexFamily());
    console.log();
  }
  if (mimoLegacyInstalled()) {
    console.log(uninstallMimo());
    console.log();
  }
  if (detected.vscode) {
    console.log(await installVscode());
    console.log();
  }

  // Re-detect after install for accurate matrix
  const after = detectAgents();
  console.log(formatSurfaceMatrix(after));
  console.log();
  console.log("🎉 Done. Earn USDC while your agent thinks.");
  console.log("   Cash out: https://www.latentprotocol.xyz/dashboard");
  console.log("   Check:    npx latent-protocol status");
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  const wallet = resolveWallet(cfg);
  const server = resolveServer(cfg);
  const detected = detectAgents();
  console.log("Latent Protocol status\n");
  console.log(`  Config:  ${configFile()}`);
  console.log(`  Wallet:  ${wallet || "(not set)"}`);
  if (cfg.auth) console.log(`  Auth:    ${cfg.auth}`);
  if (cfg.privy_user_id) console.log(`  Privy:   ${cfg.privy_user_id}`);
  console.log(`  Server:  ${server}`);
  console.log(`  Enabled: ${cfg.enabled === false ? "false" : "true"}`);
  console.log(`  Mode:    ${cfg.mode ?? "live"}`);
  if (cfg.prelaunch_registered_at) {
    console.log(`  Prelaunch registered: ${cfg.prelaunch_registered_at}`);
  }
  console.log(`  Frequency: ${cfg.frequency ?? 1}`);
  if (cfg.spinner_verbs !== undefined) {
    console.log(`  spinnerVerbs: ${cfg.spinner_verbs ? "on" : "off"}`);
  }
  const health = healthSummary();
  if (health) console.log(`  Health:  ${health}`);
  if (wallet) {
    const bal = await getBalance(wallet, server);
    console.log(`  Balance: $${bal.toFixed(4)} USDC`);
  }
  console.log();
  console.log("Surfaces:");
  console.log(`  ${claudeCodeStatus()}`);
  console.log(`  ${grokStatus()}`);
  console.log(`  ${hermesStatus()}`);
  console.log(`  ${openclawStatus()}`);
  for (const line of codexFamilyStatus()) console.log(`  ${line}`);
  console.log(`  ${mimoStatus()}`);
  console.log(`  ${vscodeStatus()}`);
  console.log();
  console.log("Detected:");
  console.log(formatDetectionTable(detected));
  console.log();
  console.log(formatSurfaceMatrix(detected));
}

async function cmdUninstall(): Promise<void> {
  console.log(uninstallClaudeCode());
  console.log(uninstallGrok());
  console.log(uninstallHermes());
  console.log(uninstallOpenclaw());
  console.log(uninstallCodexFamily());
  console.log(uninstallMimo());
  console.log(await uninstallVscode());
  resetHealth();
}

async function cmdStatusline(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "--install" || sub === "install") {
    console.log(installClaudeCode({ spinnerVerbs: await detectSpinnerVerbsSupport() }));
    return;
  }
  if (sub === "--uninstall" || sub === "uninstall") {
    console.log(uninstallClaudeCode());
    return;
  }

  try {
    const session = await readSessionFromStdin();
    const line = await render(session);
    if (line) process.stdout.write(line);
  } catch {
    // never break Claude Code's status line
  }
}

async function cmdHook(args: string[]): Promise<void> {
  const event = (args[0] || "") as HookEvent;
  const valid: HookEvent[] = ["session-start", "turn-start", "turn-end", "session-end"];
  if (!valid.includes(event)) {
    // Unknown event — stay silent, never disturb the host agent.
    return;
  }
  // No default: hooks.json entries from older releases pass `--agent codex`,
  // which runHook ignores.
  let agent = "";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--agent" && args[i + 1]) agent = args[++i]!;
    else if (args[i]!.startsWith("--agent=")) agent = args[i]!.slice("--agent=".length);
  }
  try {
    const payload = await readSessionFromStdin();
    const out = await runHook(event, agent, payload);
    if (out) process.stdout.write(out);
  } catch {
    // fail open
  }
}

async function cmdPrelaunch(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  let days = DEFAULT_SCAN_DAYS;
  for (let i = 0; i < flags.rest.length; i++) {
    if (flags.rest[i] === "--days" && flags.rest[i + 1]) {
      days = Math.max(1, parseInt(flags.rest[++i]!, 10) || DEFAULT_SCAN_DAYS);
    } else if (flags.rest[i]!.startsWith("--days=")) {
      days = Math.max(1, parseInt(flags.rest[i]!.slice("--days=".length), 10) || DEFAULT_SCAN_DAYS);
    }
  }
  const skipRegister = flags.rest.includes("--skip-register");
  await runPrelaunch({
    yes: flags.yes,
    wallet: flags.wallet,
    email: flags.email,
    server: flags.server,
    days,
    skipRegister,
  });
}

async function main(): Promise<void> {
  const [, , cmd = "help", ...args] = process.argv;
  switch (cmd) {
    case "init":
      await cmdInit(args);
      break;
    case "prelaunch":
      await cmdPrelaunch(args);
      break;
    case "activate":
      await runActivate();
      break;
    case "status":
      await cmdStatus();
      break;
    case "uninstall":
      await cmdUninstall();
      break;
    case "statusline":
      await cmdStatusline(args);
      break;
    case "hook":
      await cmdHook(args);
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
