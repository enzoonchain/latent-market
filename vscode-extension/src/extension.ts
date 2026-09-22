/**
 * Latent Protocol VS Code / Cursor extension.
 *
 * Three display paths:
 *  - Non-invasive (default): a status-bar sponsor line + a sidebar "ad card" +
 *    live earnings balance, all fed by the local loopback.
 *  - Cursor overlay (opt-in): ad block in the Cursor agent composer area.
 *  - Advanced (opt-in): runtime-patch the Claude Code / Codex webview bundle so
 *    the sponsor line renders inside the agent's own spinner (reversible).
 */
import * as vscode from "vscode";
import { loadConfig } from "./config.js";
import { classifyWorkspace, type Category } from "./classify.js";
import { Loopback } from "./loopback.js";
import { buildBlock } from "./block.js";
import { buildCursorBlock, CURSOR_MARK_START, CURSOR_MARK_END } from "./cursor-block.js";
import { findAgentBundles, patch, restore, isPatched } from "./patcher.js";
import { refreshKillswitch } from "./health.js";
import { isSafeHttpUrl, sanitizeText } from "./urlsafe.js";
import { cardHtml } from "./card.js";
import { ViewabilityTracker, type MetricEvent } from "./metrics.js";
import { EarningsStatusBar } from "./statusbar.js";
import { runAllChecks } from "./conflict.js";
import { installClaudeCliHook, removeClaudeCliHook, isLatentHookInstalled } from "./claude-cli.js";
import { uninstallCleanup } from "./uninstall.js";

let loopback: Loopback | null = null;
let statusItem: vscode.StatusBarItem | null = null;
let earningsBar: EarningsStatusBar | null = null;
let rotateTimer: ReturnType<typeof setInterval> | null = null;
let reassertTimer: ReturnType<typeof setInterval> | null = null;
let category: Category = "general";
let viewTracker: ViewabilityTracker | null = null;

interface LoopAd {
  text: string;
  url: string;
  adId: string;
  token: string;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function emitMetric(event: MetricEvent, adId: string, extra?: Record<string, unknown>): void {
  if (!loopback) return;
  fetch(`${loopback.baseUrl}/metric`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, adId, ...extra }),
  }).catch(() => undefined);
}

async function fetchAd(): Promise<LoopAd | null> {
  if (!loopback) return null;
  try {
    const r = await fetch(`${loopback.baseUrl}/ad?cat=${encodeURIComponent(category)}`);
    const j = (await r.json()) as { ad?: LoopAd | null };
    return j.ad ?? null;
  } catch {
    return null;
  }
}

async function reportImpression(ad: LoopAd, displayedMs: number): Promise<void> {
  if (!loopback || !ad.adId) return;
  try {
    await fetch(`${loopback.baseUrl}/impression`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adId: ad.adId, token: ad.token, displayedMs }),
    });
  } catch {
    /* best-effort */
  }
}

class SponsorViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: false, localResourceRoots: [] };
    let current: LoopAd | null = null;
    let shownAt = 0;
    const flush = () => {
      if (current) {
        void reportImpression(current, Date.now() - shownAt);
        viewTracker?.stop();
      }
      current = null;
    };
    const render = async () => {
      flush();
      if (!view.visible) return;
      const ad = await fetchAd();
      const cfg = loadConfig();
      view.webview.html = cardHtml(ad, cfg.wallet, view.webview.cspSource);
      current = ad;
      shownAt = Date.now();
      if (ad && viewTracker) {
        viewTracker.impressionRendered(ad.adId);
        viewTracker.viewable();
      }
    };
    void render();
    const iv = setInterval(render, Math.max(3000, loadConfig().rotateSeconds * 1000));
    view.onDidChangeVisibility(() => {
      if (!view.visible) flush();
    });
    view.onDidDispose(() => {
      clearInterval(iv);
      flush();
    });
  }
}

async function startStatusRotation(): Promise<void> {
  if (!statusItem) return;
  let current: LoopAd | null = null;
  let shownAt = 0;
  const cfg = loadConfig();
  const tick = async () => {
    if (current) {
      await reportImpression(current, Date.now() - shownAt);
      viewTracker?.stop();
    }
    current = await fetchAd();
    if (current) {
      shownAt = Date.now();
      statusItem!.text = `💡 Sponsored: ${sanitizeText(current.text, 48)}`.slice(0, 60);
      statusItem!.tooltip = isSafeHttpUrl(current.url)
        ? current.url
        : "Latent Protocol — sponsored";
      statusItem!.show();
      if (viewTracker) {
        viewTracker.impressionRendered(current.adId);
        viewTracker.viewable();
      }
    } else {
      statusItem!.text = "💡 Latent";
      statusItem!.show();
    }
  };
  await tick();
  rotateTimer = setInterval(tick, Math.max(3000, cfg.rotateSeconds * 1000));
}

async function applyBundlePatch(context: vscode.ExtensionContext, announce: boolean): Promise<void> {
  const cfg = loadConfig();
  const bundles = findAgentBundles();
  if (!bundles.length) {
    if (announce) void vscode.window.showInformationMessage("Latent: no Claude Code / Codex extension bundle found to patch.");
    return;
  }
  let ok = 0;
  for (const b of bundles) {
    if (!loopback) continue;
    const block = buildBlock(loopback.baseUrl, cfg.rotateSeconds, category);
    const res = patch(b, block);
    if (res === "patched") ok++;
  }
  if (announce) {
    const msg =
      ok > 0
        ? `Latent: patched ${ok} agent bundle(s). Reload the agent window (Developer: Reload Window) to apply.`
        : "Latent: no compatible bundle patched.";
    void vscode.window.showInformationMessage(msg);
  }
  if (!reassertTimer) {
    reassertTimer = setInterval(() => {
      const cur = loadConfig();
      if (!cur.patchAgentBundles || !loopback) return;
      for (const b of findAgentBundles()) {
        if (!isPatched(b.bundlePath)) patch(b, buildBlock(loopback.baseUrl, cur.rotateSeconds, category));
      }
    }, 60_000);
    context.subscriptions.push({ dispose: () => reassertTimer && clearInterval(reassertTimer) });
  }
}

function restoreAll(announce: boolean): void {
  let n = 0;
  for (const b of findAgentBundles()) if (restore(b)) n++;
  if (reassertTimer) {
    clearInterval(reassertTimer);
    reassertTimer = null;
  }
  if (announce) void vscode.window.showInformationMessage(`Latent: restored ${n} agent bundle(s).`);
}

let killswitchTimer: ReturnType<typeof setInterval> | null = null;

async function startDisplay(context: vscode.ExtensionContext): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.enabled) return;
  category = classifyWorkspace(workspaceRoot());

  void refreshKillswitch(cfg.server);
  if (!killswitchTimer) {
    killswitchTimer = setInterval(() => void refreshKillswitch(loadConfig().server), 5 * 60_000);
    context.subscriptions.push({ dispose: () => killswitchTimer && clearInterval(killswitchTimer) });
  }

  loopback = new Loopback("vscode", () => category);
  await loopback.start();

  // Viewability tracker — all events forwarded through the loopback
  viewTracker = new ViewabilityTracker(emitMetric);

  // Sponsor line (rotating)
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusItem);
  await startStatusRotation();

  // Live earnings balance (persistent)
  if (!earningsBar) {
    earningsBar = new EarningsStatusBar(cfg.server, cfg.wallet);
    earningsBar.start();
  }

  if (cfg.patchAgentBundles) await applyBundlePatch(context, false);
}

function stopDisplay(): void {
  if (rotateTimer) clearInterval(rotateTimer);
  rotateTimer = null;
  statusItem?.hide();
  viewTracker?.stop();
  viewTracker = null;
  earningsBar?.stop();
  earningsBar = null;
  loopback?.stop();
  loopback = null;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("latentSponsor", new SponsorViewProvider()),
    vscode.commands.registerCommand("latent.enable", async () => {
      await vscode.workspace.getConfiguration("latent").update("enabled", true, true);
      stopDisplay();
      await startDisplay(context);
      void vscode.window.showInformationMessage("Latent: sponsored spinner enabled.");
    }),
    vscode.commands.registerCommand("latent.disable", async () => {
      await vscode.workspace.getConfiguration("latent").update("enabled", false, true);
      stopDisplay();
      void vscode.window.showInformationMessage("Latent: sponsored spinner disabled.");
    }),
    vscode.commands.registerCommand("latent.patchAgentBundles", async () => {
      await vscode.workspace.getConfiguration("latent").update("patchAgentBundles", true, true);
      if (!loopback) await startDisplay(context);
      await applyBundlePatch(context, true);
    }),
    vscode.commands.registerCommand("latent.restore", () => restoreAll(true)),
    vscode.commands.registerCommand("latent.showEarnings", async () => {
      const cfg = loadConfig();
      if (!cfg.wallet) return void vscode.window.showWarningMessage("Latent: no wallet set (run `npx latent-protocol init`).");
      try {
        const r = await fetch(`${cfg.server}/earnings/${cfg.wallet}`);
        const j = (await r.json()) as { balance?: number };
        void vscode.window.showInformationMessage(`Latent balance: $${Number(j.balance ?? 0).toFixed(4)} USDC`);
      } catch {
        void vscode.window.showErrorMessage("Latent: could not reach the ad server.");
      }
    }),
    vscode.commands.registerCommand("latent.checkConflicts", () => {
      const checks = runAllChecks();
      const conflicts = checks.filter((c) => c.hasConflict);
      if (conflicts.length === 0) {
        void vscode.window.showInformationMessage("Latent: no hook conflicts detected.");
      } else {
        const msgs = conflicts.map((c) => c.message).join("\n");
        void vscode.window.showWarningMessage(`Latent: ${conflicts.length} conflict(s):\n${msgs}`);
      }
    }),
    vscode.commands.registerCommand("latent.installCliHook", async () => {
      const result = installClaudeCliHook();
      const msgs = {
        "installed": "Latent: Claude CLI hook installed.",
        "already-installed": "Latent: Claude CLI hook already active.",
        "error": "Latent: failed to install Claude CLI hook.",
      };
      void vscode.window.showInformationMessage(msgs[result]);
    }),
    vscode.commands.registerCommand("latent.removeCliHook", () => {
      const result = removeClaudeCliHook();
      const msgs = {
        "removed": "Latent: Claude CLI hook removed.",
        "not-installed": "Latent: no Claude CLI hook to remove.",
        "error": "Latent: failed to remove Claude CLI hook.",
      };
      void vscode.window.showInformationMessage(msgs[result]);
    }),
  );

  await startDisplay(context);
}

export function deactivate(): void {
  stopDisplay();
  uninstallCleanup();
}
