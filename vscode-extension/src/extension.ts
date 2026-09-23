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
import { buildCursorBlock } from "./cursor-block.js";
import { findAgentBundles, patch, restore, isPatched } from "./patcher.js";
import { refreshKillswitch } from "./health.js";
import { isSafeHttpUrl, sanitizeText } from "./urlsafe.js";
import { cardHtml } from "./card.js";
import { ViewabilityTracker, type MetricEvent } from "./metrics.js";
import { EarningsStatusBar } from "./statusbar.js";
import { fetchEarnings } from "./earnings.js";
import { runAllChecks } from "./conflict.js";
import { installClaudeCliHook, removeClaudeCliHook } from "./claude-cli.js";
import { findWorkbenchHtml, isWorkbenchPatched, patchWorkbench, restoreWorkbench } from "./workbench.js";

let loopback: Loopback | null = null;
let statusItem: vscode.StatusBarItem | null = null;
let earningsBar: EarningsStatusBar | null = null;
let rotateTimer: ReturnType<typeof setInterval> | null = null;
let statusFocusSub: vscode.Disposable | null = null;

/** On screen = the editor window is focused (a minimized/background window
 * shows nothing to anyone). Pauses/resumes a tracker's view-time clock. */
function trackWindowFocus(tracker: ViewabilityTracker): vscode.Disposable {
  return vscode.window.onDidChangeWindowState((s) => (s.focused ? tracker.viewable() : tracker.hidden()));
}
let reassertTimer: ReturnType<typeof setInterval> | null = null;
let category: Category = "general";

interface LoopAd {
  text: string;
  url: string;
  adId: string;
  token: string;
  /** Loopback /click 302-chain URL (billing + redirect). Never a raw secret. */
  clickHref?: string;
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

async function reportImpression(ad: LoopAd, displayedMs: number, surface: string): Promise<void> {
  if (!loopback || !ad.adId) return;
  try {
    await fetch(`${loopback.baseUrl}/impression`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adId: ad.adId, token: ad.token, displayedMs, surface }),
    });
  } catch {
    /* best-effort */
  }
}

class SponsorViewProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: false, localResourceRoots: [] };
    // Per-surface tracker: the card and the status bar run concurrently and
    // must not share one viewability state.
    const tracker = new ViewabilityTracker(emitMetric);
    let current: LoopAd | null = null;
    const flush = () => {
      if (current) {
        // Honest cumulative view time (not wall clock) — the server's
        // view-time gate decides the credit.
        void reportImpression(current, tracker.totalVisibleMs(), "card");
        tracker.stop();
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
      if (ad) {
        tracker.impressionRendered(ad.adId);
        if (vscode.window.state.focused) tracker.viewable();
      }
    };
    const focusSub = trackWindowFocus(tracker);
    void render();
    const iv = setInterval(render, Math.max(3000, loadConfig().rotateSeconds * 1000));
    view.onDidChangeVisibility(() => {
      if (!view.visible) flush();
    });
    view.onDidDispose(() => {
      clearInterval(iv);
      focusSub.dispose();
      flush();
    });
  }
}

async function startStatusRotation(): Promise<void> {
  if (!statusItem) return;
  const tracker = new ViewabilityTracker(emitMetric);
  let current: LoopAd | null = null;
  const cfg = loadConfig();
  statusFocusSub?.dispose();
  statusFocusSub = trackWindowFocus(tracker);
  const tick = async () => {
    if (current) {
      await reportImpression(current, tracker.totalVisibleMs(), "statusbar");
      tracker.stop();
    }
    current = await fetchAd();
    if (current) {
      statusItem!.text = `${sanitizeText(current.text, 46)} · Sponsored`;
      statusItem!.tooltip = isSafeHttpUrl(current.url)
        ? current.url
        : "Latent Protocol — sponsored";
      statusItem!.show();
      tracker.impressionRendered(current.adId);
      if (vscode.window.state.focused) tracker.viewable();
    } else {
      statusItem!.text = "Latent";
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

function isCursor(): boolean {
  return /cursor/i.test(vscode.env.appName);
}

function cursorOverlayEnabled(): boolean {
  return vscode.workspace.getConfiguration("latent").get<boolean>("cursorOverlay", false);
}

/**
 * Keep the Cursor workbench overlay in sync with `latent.cursorOverlay`:
 * patch when on (idempotent — also re-applies after a Cursor update wiped it),
 * restore when off. Workbench changes only take effect after a window reload.
 */
function syncCursorOverlay(announce: boolean): void {
  if (!isCursor()) {
    if (announce && cursorOverlayEnabled()) {
      void vscode.window.showInformationMessage("Latent: the composer overlay is Cursor-only.");
    }
    return;
  }
  const html = findWorkbenchHtml(vscode.env.appRoot);
  if (!html) {
    if (announce) void vscode.window.showWarningMessage("Latent: Cursor workbench.html not found — overlay unavailable.");
    return;
  }
  const wasPatched = isWorkbenchPatched(html);
  const cfg = loadConfig();
  if (cursorOverlayEnabled() && cfg.enabled && loopback) {
    const res = patchWorkbench(html, buildCursorBlock(loopback.baseUrl, cfg.rotateSeconds, category));
    if (res === "error") {
      void vscode.window.showWarningMessage("Latent: could not patch the Cursor workbench (permissions?).");
    } else if (!wasPatched) {
      void vscode.window.showInformationMessage("Latent: Cursor overlay installed — reload the window to show it.");
    }
  } else if (wasPatched && !cursorOverlayEnabled()) {
    restoreWorkbench(html);
    if (announce) void vscode.window.showInformationMessage("Latent: Cursor overlay removed — reload the window to apply.");
  }
}

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
  syncCursorOverlay(false);
}

function stopDisplay(): void {
  if (rotateTimer) clearInterval(rotateTimer);
  rotateTimer = null;
  statusFocusSub?.dispose();
  statusFocusSub = null;
  statusItem?.hide();
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
      const e = await fetchEarnings(cfg.server, cfg.wallet);
      if (e.kind === "ok") {
        void vscode.window.showInformationMessage(`Latent balance: $${e.balance.toFixed(4)} USDC`);
      } else if (e.kind === "auth") {
        void vscode.window.showInformationMessage(
          "Latent: your balance is private — the server only shows it to the wallet owner. Sign in on the Latent dashboard to view it.",
        );
      } else {
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
      let result = installClaudeCliHook();
      if (result === "conflict") {
        const owner = runAllChecks().find((c) => c.target === "claude-cli" && c.hasConflict);
        const pick = await vscode.window.showWarningMessage(
          owner?.message ?? "Claude Code already has a statusLine. Replace it with Latent? (It is restored when you remove the Latent hook.)",
          { modal: true },
          "Replace",
        );
        if (pick !== "Replace") return;
        result = installClaudeCliHook(true);
      }
      const msgs = {
        "installed": "Latent: Claude CLI hook installed.",
        "already-installed": "Latent: Claude CLI hook already active.",
        "conflict": "Latent: Claude Code statusLine left unchanged.",
        "needs-cli": "Latent: run `npx latent-protocol init` first — it installs the status-line runtime this hook uses.",
        "error": "Latent: could not update ~/.claude/settings.json (unparseable or unwritable — left untouched).",
      };
      void vscode.window.showInformationMessage(msgs[result]);
    }),
    vscode.commands.registerCommand("latent.removeCliHook", () => {
      const result = removeClaudeCliHook();
      const msgs = {
        "removed": "Latent: Claude CLI hook removed.",
        "not-installed": "Latent: no extension-installed Claude CLI hook to remove (a CLI-installed one is removed with `latent uninstall`).",
        "error": "Latent: failed to remove Claude CLI hook.",
      };
      void vscode.window.showInformationMessage(msgs[result]);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("latent.cursorOverlay")) syncCursorOverlay(true);
    }),
  );

  await startDisplay(context);
}

export function deactivate(): void {
  // Runs on every window close/reload — only stop this window's timers and
  // loopback. Patches stay (other windows use them); real cleanup is the
  // `vscode:uninstall` script (dist/uninstall.js).
  stopDisplay();
}
