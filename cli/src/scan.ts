import { detectAgents } from "./detect.js";
import { getTopBid } from "./api.js";
import { applyCaps, missedUsdEstimate, DEFAULT_TOP_BID } from "./calc.js";
import { scanHermes } from "./scanners/hermes.js";
import { scanCodexFamily } from "./scanners/codex.js";
import { scanOpenclaw } from "./scanners/openclaw.js";
import { scanClaudeCode } from "./scanners/claude-code.js";
import { scanVscode } from "./scanners/vscode.js";
import {
  DEFAULT_SCAN_DAYS,
  SCAN_VERSION,
  type AgentScanResult,
  type ScanReport,
} from "./scanners/types.js";

export function scanPrelaunchAgents(days = DEFAULT_SCAN_DAYS): AgentScanResult[] {
  const detected = detectAgents();
  const agents: AgentScanResult[] = [];

  agents.push(scanClaudeCode(days));
  if (detected.hermes || detected.hermesWebui) {
    agents.push(scanHermes(days, detected.paths.hermesHome));
  }
  agents.push(...scanCodexFamily(days));
  agents.push(scanOpenclaw(days));
  agents.push(scanVscode(days));

  return agents;
}

export async function buildScanReport(days = DEFAULT_SCAN_DAYS, server?: string): Promise<ScanReport> {
  const agents = scanPrelaunchAgents(days);
  const detectedAgents = agents.filter((a) => a.detected);
  const rawSlots = detectedAgents.reduce((sum, a) => sum + a.billableSlots, 0);
  const sessionCount = detectedAgents.reduce((sum, a) => sum + a.sessions, 0);
  const totalBillableSlots = applyCaps(rawSlots, sessionCount, days);
  const topBid = (await getTopBid(server)) ?? DEFAULT_TOP_BID;

  return {
    scanVersion: SCAN_VERSION,
    daysScanned: days,
    agents,
    totalBillableSlots,
    topBid,
    missedUsdEstimate: missedUsdEstimate(totalBillableSlots, topBid),
  };
}

export function formatScanReport(report: ScanReport): string {
  const lines: string[] = [
    "🔍 Agent scan (local only — prompts never leave your machine)\n",
  ];
  for (const a of report.agents) {
    const mark = a.detected ? "✓" : "–";
    lines.push(`  ${mark} ${a.label.padEnd(22)} ${a.detail}`);
  }
  lines.push("");
  if (report.totalBillableSlots > 0) {
    lines.push(`💸 Estimated missed earnings: $${report.missedUsdEstimate.toFixed(2)} USDC`);
    lines.push(
      `   ${report.totalBillableSlots} billable slots × $${report.topBid.toFixed(4)} bid × 50% user share`,
    );
    lines.push(`   (last ${report.daysScanned} days, caps applied)`);
  } else {
    lines.push("ℹ️  No billable agent activity found in the scan window.");
    lines.push("   Install Hermes, Codex, MiMo, or OpenClaw and use them for a few days, then re-run.");
  }
  return lines.join("\n");
}
