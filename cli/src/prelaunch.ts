import { detectAgents } from "./detect.js";
import { configFile, canonicalizeServer, loadConfig, resolveServer, resolveWallet, saveConfig } from "./config.js";
import { ensureWallet, type WalletOpts } from "./wallet.js";
import { registerPrelaunch } from "./api.js";
import { buildScanReport, formatScanReport } from "./scan.js";
import { DEFAULT_SCAN_DAYS } from "./scanners/types.js";
import { installHermes } from "./surfaces/hermes.js";
import { installOpenclaw } from "./surfaces/openclaw.js";
import {
  CODEX_AGENTS,
  codexDetected,
  installCodexFamily,
} from "./surfaces/codex.js";
import { installClaudeCode } from "./surfaces/claude-code.js";
import { installGrok } from "./surfaces/grok.js";
import { formatDetectionTable, formatSurfaceMatrix } from "./detect.js";

export interface PrelaunchOpts extends WalletOpts {
  days?: number;
  skipRegister?: boolean;
}

export async function runPrelaunch(opts: PrelaunchOpts = {}): Promise<void> {
  const days = opts.days ?? DEFAULT_SCAN_DAYS;
  const server = canonicalizeServer(opts.server || resolveServer(loadConfig()));

  console.log("🚀 Latent Protocol — pre-launch signup\n");
  console.log("   Ads stay OFF until public launch. We only save your wallet + usage counts.\n");

  const detected = detectAgents();
  console.log(formatDetectionTable(detected));
  console.log();

  const wallet = await ensureWallet({
    yes: opts.yes,
    generate: opts.generate,
    wallet: opts.wallet,
    email: opts.email,
    server,
  });

  saveConfig({
    wallet,
    enabled: false,
    mode: "prelaunch",
    server,
  });

  console.log(`\n💳 Wallet: ${wallet}`);
  console.log(`   Config: ${configFile()}`);
  console.log(`   Server: ${server}`);
  console.log(`   Ads:    disabled (pre-launch)\n`);

  console.log("Scanning local agent logs…\n");
  const report = await buildScanReport(days, server);
  console.log(formatScanReport(report));
  console.log();

  if (!opts.skipRegister) {
    const agentIds = report.agents.filter((a) => a.detected).map((a) => a.agent);
    const reg = await registerPrelaunch({
      wallet,
      agents: agentIds,
      metrics: {
        scan_version: report.scanVersion,
        days_scanned: report.daysScanned,
        billable_slots: report.totalBillableSlots,
        missed_usd_estimate: report.missedUsdEstimate,
        top_bid: report.topBid,
        per_agent: report.agents
          .filter((a) => a.detected)
          .map((a) => ({
            agent: a.agent,
            sessions: a.sessions,
            user_turns: a.userTurns,
            thinking_states: a.thinkingStates,
            billable_slots: a.billableSlots,
          })),
      },
      server,
    });
    if (reg.ok) {
      saveConfig({ prelaunch_registered_at: new Date().toISOString() });
      console.log("✅ Pre-launch registration saved on server.");
    } else {
      console.log(`⚠️  Could not register on server (${reg.error ?? "unknown"}).`);
      console.log("   Your wallet is saved locally — re-run prelaunch when online.");
    }
  }

  console.log("\n🎉 Pre-launch setup complete.");
  console.log("   At launch: npx latent-protocol activate");
}

export async function runActivate(): Promise<void> {
  const cfg = loadConfig();
  const wallet = resolveWallet(cfg);
  if (!wallet) {
    console.error("No wallet found. Run: npx latent-protocol prelaunch --wallet 0x…  or  --email you@domain");
    process.exitCode = 1;
    return;
  }

  console.log("⚡ Activating Latent Protocol (enabling ads + patching surfaces)…\n");
  saveConfig({ enabled: true, mode: "live", frequency: 1 });

  const detected = detectAgents();
  const codexAgents = CODEX_AGENTS.filter(codexDetected);
  const lines: string[] = [];

  if (detected.claudeCode) lines.push(installClaudeCode());
  if (detected.grok) lines.push(installGrok());
  if (detected.hermes || detected.hermesWebui) lines.push(installHermes());
  if (detected.openclaw) lines.push(installOpenclaw());
  if (codexAgents.length > 0) lines.push(installCodexFamily());

  if (!lines.length) {
    console.log("No supported agents detected to patch.");
  } else {
    for (const line of lines) console.log(line + "\n");
  }

  console.log(`💳 Wallet: ${wallet}`);
  console.log(`   Ads:    enabled`);
  console.log(formatSurfaceMatrix(detectAgents()));
  console.log("\n🎉 Live. Earn USDC while your agent thinks.");
}
