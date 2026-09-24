/**
 * Latent Protocol VS Code / Cursor extension.
 *
 * Surfaces:
 *  - Status bar earnings (always) opens the management panel.
 *  - The activity-bar Latent view is that same panel.
 *  - Claude Code and Codex webview injection after Terms are accepted.
 *  - Cursor composer overlay stays opt-in (`latent.cursorOverlay`).
 */
import * as vscode from "vscode";
import { loadConfig } from "./config.js";
import { classifyWorkspace, type Category } from "./classify.js";
import { Loopback } from "./loopback.js";
import { BLOCK_BUILD, buildBlock, MARK_START } from "./block.js";
import { buildCursorBlock, CURSOR_BUILD } from "./cursor-block.js";
import { fileIncludes, fileStamp, findAgentBundles, isPatched, patch, releaseExtensionHost, restore } from "./patcher.js";
import { refreshKillswitch, shouldServe } from "./health.js";
import { isSafeHttpUrl, sanitizeText } from "./urlsafe.js";
import { MIN_VIEW_MS, ViewabilityTracker, type MetricEvent } from "./metrics.js";
import { EarningsStatusBar } from "./statusbar.js";
import { fetchEarnings } from "./earnings.js";
import { checkBundleConflict, runAllChecks } from "./conflict.js";
import { installClaudeCliHook, removeClaudeCliHook, statuslineRuntimePath } from "./claude-cli.js";
import { findWorkbenchHtml, isWorkbenchPatched, patchWorkbench, restoreWorkbench, syncWorkbenchChecksum, workbenchChecksumMatches, WB_BLOCK_FILE } from "./workbench.js";
import { POLICY_KEY, POLICY_VERSION, isPolicyAccepted } from "./policy.js";
import { bindSidebar, openManagementPanel, postPanelState, unbindSidebar, type AgentKind, type PanelMessage, type PanelState } from "./panel.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

let loopback: Loopback | null = null;
let statusItem: vscode.StatusBarItem | null = null;
let copyItem: vscode.StatusBarItem | null = null;
/** https CTA for the status-bar sponsor. Empty when the current ad has no safe link. */
let sponsorHttps = "";
let sponsorAdId = "";
let earningsBar: EarningsStatusBar | null = null;
let rotateTimer: ReturnType<typeof setInterval> | null = null;
let statusFocusSub: vscode.Disposable | null = null;

/** On screen = the editor window is focused (a minimized/background window
 * shows nothing to anyone). Pauses/resumes a tracker's view-time clock. */
function trackWindowFocus(tracker: ViewabilityTracker): vscode.Disposable {
  return vscode.window.onDidChangeWindowState((s) => (s.focused ? tracker.viewable() : tracker.hidden()));
}
let reassertTimer: ReturnType<typeof setInterval> | null = null;
const userRestored = new Set<AgentKind>();
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

function policiesOk(context: vscode.ExtensionContext): boolean {
  return isPolicyAccepted(context.globalState.get(POLICY_KEY));
}

function agentRows(): PanelState["agents"] {
  const found = findAgentBundles();
  return (["claude-code", "codex"] as const).map((agent) => {
    const bundle = found.find((b) => b.agent === agent);
    if (!bundle) return { agent, installed: false, patched: false, conflict: false };
    let text = "";
    try {
      text = readFileSync(bundle.bundlePath, "utf8");
    } catch {
      text = "";
    }
    return {
      agent,
      installed: true,
      patched: text.includes(MARK_START),
      conflict: text ? checkBundleConflict(text).hasConflict : false,
    };
  });
}

async function collectPanelState(context: vscode.ExtensionContext): Promise<PanelState> {
  const cfg = loadConfig();
  const accepted = policiesOk(context);
  let balanceText = "Latent — accept terms";
  const figures: PanelState["figures"] = {
    balance: "—",
    totalEarned: "—",
    paidOut: "—",
    impressions: "—",
    clicks: "—",
    personal: false,
  };
  if (accepted && !cfg.wallet) balanceText = "Latent — set up";
  if (accepted && cfg.wallet) {
    const e = await fetchEarnings(cfg.server, cfg.wallet);
    if (e.kind === "ok") {
      const paidOut = Math.max(0, e.totalEarned - e.balance);
      balanceText = `$${e.balance.toFixed(2)}`;
      figures.personal = true;
      figures.balance = balanceText;
      figures.totalEarned = `$${e.totalEarned.toFixed(2)}`;
      figures.paidOut = `$${paidOut.toFixed(2)}`;
      figures.impressions = e.impressions.toLocaleString("en-US");
      figures.clicks = e.clicks.toLocaleString("en-US");
    } else if (e.kind === "auth") {
      balanceText = "Latent Menu";
    } else balanceText = "Latent —";
  }
  const cli = runAllChecks().find((c) => c.target === "claude-cli");
  const health = shouldServe();
  const events = loopback?.recentEvents().slice(-5).map((ev) => ev.event).join(", ") || "none";
  const agents = agentRows();
  return {
    policyAccepted: accepted,
    policyVersion: POLICY_VERSION,
    enabled: cfg.enabled,
    wallet: cfg.wallet,
    balanceText,
    agents,
    cliRuntime: existsSync(statuslineRuntimePath()),
    cliInstalled: !!cli && cli.message.includes("Latent owns"),
    sponsorSurface: sponsorSurface(),
    figures,
    diagnose: [
      `policy: ${accepted ? POLICY_VERSION : "not accepted"}`,
      `serve: ${health.ok ? "ok" : health.reason || "paused"}`,
      `loopback: ${loopback ? "up" : "off"}`,
      `events: ${events}`,
      ...agents.map((a) => `${a.agent}: ${a.installed ? (a.patched ? "patched" : "installed") : "missing"}`),
    ].join("\n"),
  };
}

async function pushPanel(context: vscode.ExtensionContext): Promise<void> {
  const state = await collectPanelState(context);
  earningsBar?.setAccess(state.policyAccepted, state.wallet);
  postPanelState(state);
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
  if (!loopback || !ad.adId || displayedMs < MIN_VIEW_MS) return;
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
  constructor(private readonly context: vscode.ExtensionContext) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    bindSidebar(view.webview, this.context.extensionUri, (msg) => void onPanelMessage(this.context, msg));
    view.onDidDispose(() => unbindSidebar(view.webview));
    void pushPanel(this.context);
  }
}

/** Credit the click on the loopback, then open the advertiser https URL itself. */
function openSponsorLink(): void {
  const url = sponsorHttps;
  if (!isSafeHttpUrl(url)) return;
  if (loopback && sponsorAdId) {
    fetch(`${loopback.baseUrl}/click`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adId: sponsorAdId, surface: "statusbar" }),
    }).catch(() => undefined);
  }
  void vscode.env.openExternal(vscode.Uri.parse(url));
}

async function copySponsorLink(): Promise<void> {
  if (!isSafeHttpUrl(sponsorHttps)) return;
  await vscode.env.clipboard.writeText(sponsorHttps);
  void vscode.window.setStatusBarMessage("Latent: link copied", 2500);
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
      sponsorHttps = isSafeHttpUrl(current.url) ? current.url : "";
      sponsorAdId = current.adId;
      const label = sanitizeText(current.text, 42);
      statusItem!.text = sponsorHttps ? `$(link) ${label} · Open` : `${label} · Sponsored`;
      statusItem!.command = sponsorHttps ? "latent.openSponsor" : undefined;
      statusItem!.tooltip = sponsorHttps ? "Open the sponsored link" : "Latent Protocol — sponsored";
      statusItem!.show();
      if (copyItem) {
        if (sponsorHttps) {
          copyItem.text = "$(copy)";
          copyItem.tooltip = "Copy the sponsored link";
          copyItem.command = "latent.copySponsor";
          copyItem.show();
        } else {
          copyItem.hide();
        }
      }
      tracker.impressionRendered(current.adId);
      if (vscode.window.state.focused) tracker.viewable();
    } else {
      sponsorHttps = "";
      sponsorAdId = "";
      statusItem!.text = "Latent";
      statusItem!.command = undefined;
      statusItem!.tooltip = "Latent Protocol";
      statusItem!.show();
      copyItem?.hide();
    }
  };
  await tick();
  rotateTimer = setInterval(tick, Math.max(3000, cfg.rotateSeconds * 1000));
}

async function applyBundlePatch(
  context: vscode.ExtensionContext,
  announce: boolean,
  only?: AgentKind,
): Promise<void> {
  if (!policiesOk(context)) {
    if (announce) void vscode.window.showWarningMessage("Latent: accept the Terms in the Latent panel before injecting.");
    return;
  }
  if (only) userRestored.delete(only);
  else userRestored.clear();
  const cfg = loadConfig();
  let bundles = findAgentBundles();
  if (only) bundles = bundles.filter((b) => b.agent === only);
  if (!bundles.length) {
    if (announce) void vscode.window.showInformationMessage("Latent: no Claude Code / Codex extension bundle found to patch.");
    return;
  }
  let ok = 0;
  for (const b of bundles) {
    if (!loopback) continue;
    let foreign = false;
    try {
      foreign = checkBundleConflict(readFileSync(b.bundlePath, "utf8")).hasConflict;
    } catch {
      foreign = false;
    }
    if (foreign) {
      if (!announce) continue;
      const pick = await vscode.window.showWarningMessage(
        `Another tool has patched the ${b.agent} bundle. Replace that patch with Latent? A backup is kept.`,
        { modal: true },
        "Replace",
      );
      if (pick !== "Replace") continue;
    }
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
}

const BUILD_ACK = "latent.cursorBuildAck";
const toldBundle = new Set<string>();
let toldOverlayReload = false;
let overlayAhead = false;

function stopReassert(): void {
  if (reassertTimer) {
    clearInterval(reassertTimer);
    reassertTimer = null;
  }
}

const bundleQuiet = new Map<string, string>();
const releasedHosts = new Set<string>();

function reassertSurfaces(context: vscode.ExtensionContext): void {
  const cur = loadConfig();
  if (!cur.enabled || !policiesOk(context) || !loopback) return;
  if (cur.patchAgentBundles) {
    for (const b of findAgentBundles()) {
      if (!releasedHosts.has(b.extDir)) {
        releasedHosts.add(b.extDir);
        releaseExtensionHost(b.extDir);
      }
      if (userRestored.has(b.agent)) continue;
      const stamp = fileStamp(b.bundlePath);
      const key = stamp ? `${stamp.mtimeMs}:${stamp.size}` : "";
      if (key && bundleQuiet.get(b.bundlePath) === key) continue;
      if (isPatched(b.bundlePath) && fileIncludes(b.bundlePath, `LATENT_BUILD = "${BLOCK_BUILD}"`)) {
        if (key) bundleQuiet.set(b.bundlePath, key);
        continue;
      }
      try {
        if (checkBundleConflict(readFileSync(b.bundlePath, "utf8")).hasConflict) continue;
      } catch {
        continue;
      }
      const res = patch(b, buildBlock(loopback.baseUrl, cur.rotateSeconds, category));
      if (res === "patched" && !toldBundle.has(b.agent)) {
        toldBundle.add(b.agent);
        void vscode.window.showInformationMessage(
          `Latent: the ${b.agent} update removed the sponsor line. It is back — reload the window to show it.`,
        );
      }
    }
  }
  if (sponsorSurface() === "overlay" && isCursor()) {
    const html = findWorkbenchHtml(vscode.env.appRoot);
    if (html) {
      const tagged = isWorkbenchPatched(html);
      const fileOk = existsSync(join(dirname(html), WB_BLOCK_FILE));
      if (!tagged || !fileOk) syncCursorOverlay(false);
      else if (!workbenchChecksumMatches(html)) syncWorkbenchChecksum(html);
      const seen = loopback.helloBuild();
      if (seen === CURSOR_BUILD) {
        overlayAhead = false;
        void context.globalState.update(BUILD_ACK, CURSOR_BUILD);
        earningsBar?.setStale(false);
      } else {
        const ack = context.globalState.get<string>(BUILD_ACK);
        earningsBar?.setStale(
          overlayAhead || Boolean(seen && seen !== CURSOR_BUILD) || Boolean(ack && ack !== CURSOR_BUILD),
        );
      }
    }
  } else {
    earningsBar?.setStale(false);
  }
}

function startReassert(context: vscode.ExtensionContext): void {
  if (reassertTimer) return;
  reassertTimer = setInterval(() => reassertSurfaces(context), 60_000);
  context.subscriptions.push({ dispose: () => stopReassert() });
}

function restoreAll(announce: boolean, only?: AgentKind): void {
  let n = 0;
  for (const b of findAgentBundles()) {
    if (only && b.agent !== only) continue;
    if (restore(b)) {
      n++;
      userRestored.add(b.agent);
      toldBundle.delete(b.agent);
    }
  }
  if (announce) void vscode.window.showInformationMessage(`Latent: restored ${n} agent bundle(s).`);
}

let killswitchTimer: ReturnType<typeof setInterval> | null = null;

function isCursor(): boolean {
  return /cursor/i.test(vscode.env.appName);
}

type SponsorSurface = "statusbar" | "overlay";

/** The sponsor line is the floating composer line. The status bar is the menu and the balance. */
function sponsorSurface(): SponsorSurface {
  return "overlay";
}

/**
 * Keep the Cursor workbench overlay in sync with `latent.cursorOverlay`:
 * patch when on (idempotent — also re-applies after a Cursor update wiped it),
 * restore when off. Workbench changes only take effect after a window reload.
 */
function syncCursorOverlay(announce: boolean): void {
  if (!isCursor()) {
    if (announce && sponsorSurface() === "overlay") {
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
  if (sponsorSurface() === "overlay" && cfg.enabled && loopback) {
    const blockPath = join(dirname(html), WB_BLOCK_FILE);
    let previous = "";
    try {
      if (existsSync(blockPath)) previous = readFileSync(blockPath, "utf8");
    } catch {
      previous = "";
    }
    const res = patchWorkbench(html, buildCursorBlock(loopback.baseUrl, cfg.rotateSeconds, category));
    const buildLiteral = `var BUILD = ${JSON.stringify(CURSOR_BUILD)}`;
    if (res === "error") {
      void vscode.window.showWarningMessage("Latent: could not patch the Cursor workbench (permissions?).");
    } else if (!wasPatched) {
      void vscode.window.showInformationMessage("Latent: Cursor overlay installed — reload the window to show it.");
    } else if (previous && !previous.includes(buildLiteral)) {
      overlayAhead = true;
      earningsBar?.setStale(true);
      if (!toldOverlayReload) {
        toldOverlayReload = true;
        void vscode.window.showInformationMessage(
          "Latent: the composer line was updated — reload the window to dock it.",
        );
      }
    }
  } else if (wasPatched && sponsorSurface() !== "overlay") {
    restoreWorkbench(html);
    if (announce) void vscode.window.showInformationMessage("Latent: Cursor overlay removed — reload the window to apply.");
  }
}

async function startDisplay(context: vscode.ExtensionContext): Promise<void> {
  const cfg = loadConfig();
  if (!earningsBar) {
    earningsBar = new EarningsStatusBar(cfg.server, cfg.wallet);
    earningsBar.start();
  }
  earningsBar.setAccess(policiesOk(context), cfg.wallet);
  if (!cfg.enabled || !policiesOk(context)) return;
  category = classifyWorkspace(workspaceRoot());

  const syncPaused = () => {
    const decision = shouldServe();
    earningsBar?.setPaused(decision.ok ? undefined : decision.reason, decision.detail);
  };
  void refreshKillswitch(cfg.server).then(syncPaused);
  if (!killswitchTimer) {
    killswitchTimer = setInterval(() => {
      void refreshKillswitch(loadConfig().server).then(syncPaused);
    }, 5 * 60_000);
    context.subscriptions.push({ dispose: () => killswitchTimer && clearInterval(killswitchTimer) });
  }

  loopback = new Loopback("vscode", () => category, () => policiesOk(context));
  await loopback.start();

  earningsBar?.setAccess(true, cfg.wallet);

  if (cfg.patchAgentBundles) await applyBundlePatch(context, false);
  syncCursorOverlay(false);
  startReassert(context);
  reassertSurfaces(context);
}

function stopDisplay(): void {
  if (rotateTimer) clearInterval(rotateTimer);
  rotateTimer = null;
  statusFocusSub?.dispose();
  statusFocusSub = null;
  sponsorHttps = "";
  sponsorAdId = "";
  statusItem?.dispose();
  statusItem = null;
  copyItem?.dispose();
  copyItem = null;
  loopback?.stop();
  loopback = null;
  stopReassert();
}

async function onPanelMessage(context: vscode.ExtensionContext, msg: PanelMessage): Promise<void> {
  if (msg.type === "accept") {
    await context.globalState.update(POLICY_KEY, { version: POLICY_VERSION, acceptedAt: Date.now() });
    const cfg = vscode.workspace.getConfiguration("latent");
    await cfg.update("enabled", true, true);
    await cfg.update("patchAgentBundles", true, true);
    stopDisplay();
    await startDisplay(context);
    await applyBundlePatch(context, true);
    if (agentRows().some((a) => a.patched)) {
      void vscode.window.showInformationMessage(
        "Latent: reload the window to show sponsor lines inside Claude Code and Codex.",
      );
    }
  } else if (msg.type === "setEnabled") {
    await vscode.workspace.getConfiguration("latent").update("enabled", msg.enabled, true);
    stopDisplay();
    await startDisplay(context);
  } else if (msg.type === "inject") {
    if (!loopback) await startDisplay(context);
    await applyBundlePatch(context, true, msg.agent);
    void vscode.window.showInformationMessage("Latent: reload the window to apply the injection.");
  } else if (msg.type === "restore") {
    restoreAll(false, msg.agent);
  } else if (msg.type === "cli") {
    await vscode.commands.executeCommand(msg.install ? "latent.installCliHook" : "latent.removeCliHook");
  } else if (msg.type === "openDashboard") {
    void vscode.env.openExternal(vscode.Uri.parse("https://latentprotocol.xyz/dashboard"));
  } else if (msg.type === "reload") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
    return;
  } else if (msg.type === "surface") {
    /* The floating line is the only sponsor surface. */
  }
  await pushPanel(context);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("latentSponsor", new SponsorViewProvider(context)),
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
    vscode.commands.registerCommand("latent.openSponsor", () => openSponsorLink()),
    vscode.commands.registerCommand("latent.copySponsor", () => void copySponsorLink()),
    vscode.commands.registerCommand("latent.openPanel", () => {
      openManagementPanel(context.extensionUri, (msg) => void onPanelMessage(context, msg));
      void pushPanel(context);
    }),
    vscode.commands.registerCommand("latent.diagnose", async () => {
      const state = await collectPanelState(context);
      void vscode.window.showInformationMessage(state.diagnose);
    }),
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

  if (!policiesOk(context)) restoreAll(false);
  await startDisplay(context);
  if (!policiesOk(context)) {
    openManagementPanel(context.extensionUri, (msg) => void onPanelMessage(context, msg));
    void pushPanel(context);
  }
}

export function deactivate(): void {
  // Runs on every window close/reload — only stop this window's timers and
  // loopback. Patches stay (other windows use them); real cleanup is the
  // `vscode:uninstall` script (dist/uninstall.js).
  stopDisplay();
  earningsBar?.stop();
  earningsBar = null;
}
