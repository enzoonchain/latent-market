#!/usr/bin/env node
import { formatHolding, getHoldingStatus } from "./holding.js";
import { formatStats, getWalletStats, parsePeriod, type StatsPeriod } from "./stats.js";
import {
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
import { getBalance } from "./api.js";
import { healthSummary, resetHealth } from "./killswitch.js";
import {
  claudeCodeStatus,
  uninstallClaudeCode,
} from "./surfaces/claude-code.js";
import { grokStatus, uninstallGrok } from "./surfaces/grok.js";
import { hermesStatus, uninstallHermes } from "./surfaces/hermes.js";
import {
  openclawStatus,
  uninstallOpenclaw,
} from "./surfaces/openclaw.js";
import { codexFamilyStatus, uninstallCodexFamily } from "./surfaces/codex.js";
import { mimoStatus, uninstallMimo } from "./surfaces/mimo.js";
import {
  uninstallVscode,
  vscodeStatus,
} from "./surfaces/vscode.js";

const RETIRED = `latent-protocol is retired — ads in the terminal agents it patched
(Claude Code, Codex, Grok, Hermes, OpenClaw) are switched off.

Earn with LatentCode instead:  npm i -g latentcode@alpha
  or the OpenCode plugin (latent-opencode), or the Latent VS Code extension.

Remove what this CLI installed:  npx latent-protocol uninstall`;

function printRetired(): void {
  console.log(RETIRED);
}

function printHelp(): void {
  console.log(`${RETIRED}

Commands still available:
  npx latent-protocol uninstall   Revert every patch this CLI made
                                  (--vscode also removes the VS Code extension)
  npx latent-protocol status      Show config and earnings
  npx latent-protocol stats       Your earnings stats (--today / --all)
`);
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
  let statsBlock: string[] = [];
  if (wallet) {
    const stats = await getWalletStats(wallet, server);
    const bal = stats ? stats.all.balance : await getBalance(wallet, server);
    console.log(`  Balance: $${bal.toFixed(4)} USDC`);
    const holding = stats?.account ?? (await getHoldingStatus(wallet, server));
    if (holding) for (const line of formatHolding(holding)) console.log(line);
    if (stats) statsBlock = formatStats(stats, statsPeriod(cfg.stats_period));
  }
  if (statsBlock.length) {
    console.log();
    for (const line of statsBlock) console.log(line);
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

function statsPeriod(saved: unknown): StatsPeriod {
  return parsePeriod(saved) ?? "all";
}

async function cmdStats(args: string[]): Promise<void> {
  let cfg = loadConfig();
  let chosen: StatsPeriod | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--today" || a === "--day" || a === "--daily") chosen = "today";
    else if (a === "--all" || a === "--total") chosen = "all";
    else if (a === "--period" && args[i + 1]) chosen = parsePeriod(args[++i]);
    else if (a.startsWith("--period=")) chosen = parsePeriod(a.slice("--period=".length));
  }
  // The switch sticks: `status` prints the same period next time.
  if (chosen && chosen !== cfg.stats_period) cfg = saveConfig({ stats_period: chosen });
  const wallet = resolveWallet(cfg);
  if (!wallet) {
    console.log("No wallet set — run `npx latent-protocol init` first.");
    process.exitCode = 1;
    return;
  }
  const stats = await getWalletStats(wallet, resolveServer(cfg));
  if (!stats) {
    console.log("Stats are not available from this server yet.");
    process.exitCode = 1;
    return;
  }
  for (const line of formatStats(stats, chosen ?? statsPeriod(cfg.stats_period))) console.log(line);
  if (stats.account) {
    console.log();
    for (const line of formatHolding(stats.account)) console.log(line);
  }
}

async function cmdUninstall(args: string[]): Promise<void> {
  console.log(uninstallClaudeCode());
  console.log(uninstallGrok());
  console.log(uninstallHermes());
  console.log(uninstallOpenclaw());
  console.log(uninstallCodexFamily());
  console.log(uninstallMimo());
  // The VS Code extension is still a Latent product: keep it unless asked.
  if (args.includes("--vscode")) console.log(await uninstallVscode());
  resetHealth();
}

async function main(): Promise<void> {
  const [, , cmd = "help", ...args] = process.argv;
  switch (cmd) {
    case "init":
    case "prelaunch":
    case "activate":
      printRetired();
      break;
    case "status":
      await cmdStatus();
      break;
    case "stats":
      await cmdStats(args);
      break;
    case "uninstall":
      await cmdUninstall(args);
      break;
    case "statusline":
      // Retired: a statusLine that still points at npx prints nothing.
      if (args.includes("--uninstall") || args[0] === "uninstall") console.log(uninstallClaudeCode());
      break;
    case "hook":
      // Retired: installed hooks become no-ops until `uninstall` removes them.
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
