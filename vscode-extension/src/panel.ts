/**
 * Latent management panel — the activity-bar view and the editor tab share
 * one document. Policy, earnings, and surface choice live here.
 */
import * as vscode from "vscode";

export type AgentKind = "claude-code" | "codex";

export interface AgentRow {
  agent: AgentKind;
  installed: boolean;
  patched: boolean;
  conflict: boolean;
}

export interface PanelState {
  policyAccepted: boolean;
  policyVersion: string;
  enabled: boolean;
  wallet: string;
  balanceText: string;
  agents: AgentRow[];
  cliInstalled: boolean;
  cliRuntime: boolean;
  diagnose: string;
  sponsorSurface: "statusbar" | "overlay";
  figures: {
    balance: string;
    totalEarned: string;
    paidOut: string;
    impressions: string;
    clicks: string;
    personal: boolean;
  };
}

export type PanelMessage =
  | { type: "accept" }
  | { type: "setEnabled"; enabled: boolean }
  | { type: "inject"; agent: AgentKind }
  | { type: "restore"; agent: AgentKind }
  | { type: "cli"; install: boolean }
  | { type: "refresh" }
  | { type: "reload" }
  | { type: "openDashboard" }
  | { type: "surface"; surface: "statusbar" | "overlay" };

let current: vscode.WebviewPanel | undefined;
let sidebar: vscode.Webview | undefined;

export function openManagementPanel(
  extensionUri: vscode.Uri,
  onMessage: (msg: PanelMessage) => void,
): vscode.WebviewPanel {
  if (current) {
    current.reveal();
    return current;
  }
  const panel = vscode.window.createWebviewPanel("latent.panel", "Latent", vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
  });
  panel.webview.html = panelHtml(panel.webview, extensionUri);
  panel.webview.onDidReceiveMessage((msg: PanelMessage) => onMessage(msg));
  panel.onDidDispose(() => {
    if (current === panel) current = undefined;
  });
  current = panel;
  return panel;
}

/** Activity-bar "Latent" view. Same document as the editor panel. */
export function bindSidebar(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  onMessage: (msg: PanelMessage) => void,
): void {
  sidebar = webview;
  webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
  };
  webview.html = panelHtml(webview, extensionUri);
  webview.onDidReceiveMessage((msg: PanelMessage) => onMessage(msg));
}

export function unbindSidebar(webview: vscode.Webview): void {
  if (sidebar === webview) sidebar = undefined;
}

export function postPanelState(state: PanelState): void {
  const payload = { type: "state", state };
  void current?.webview.postMessage(payload);
  void sidebar?.postMessage(payload);
}

function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const sky = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "sky.jpg"));
  const csp = webview.cspSource;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp}; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  :root {
    --blue: #3b7ff5;
    --blue-2: #6aa5ff;
    --green: #3cc36b;
    --ink: #0b1220;
    --ink-2: #3b4a63;
    --muted: #6b7a92;
    --line: rgba(255,255,255,.72);
  }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    padding: 22px 16px 32px;
    color: var(--ink);
    background:
      linear-gradient(180deg, rgba(232,242,255,.22), rgba(169,205,246,.08) 40%, rgba(169,205,246,.28)),
      url("${sky}") center top / cover no-repeat fixed,
      #a9cdf6;
    font-family: Inter, var(--vscode-font-family, system-ui, sans-serif);
    font-size: 13px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 560px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
  .mark {
    width: 40px; height: 28px; flex: none;
    display: grid; place-items: center;
    color: var(--ink);
  }
  .mark svg { width: 40px; height: 28px; }
  .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
  .stat {
    background: rgba(255,255,255,.62);
    border: 1px solid rgba(255,255,255,.8);
    border-radius: 14px;
    padding: 12px 12px 10px;
    min-width: 0;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.7);
  }
  .stat b { display: block; font-size: 16px; font-weight: 600; letter-spacing: -.02em; color: var(--ink); }
  .stat span { color: var(--muted); font-size: 12px; }
  .actions { display: flex; gap: 8px; margin-top: 10px; }
  .actions button { flex: 1; }
  .word { font-weight: 500; letter-spacing: .42em; font-size: 14px; padding-left: 2px; }
  .sub { margin: 2px 0 0; color: var(--ink-2); font-size: 13px; letter-spacing: 0; }
  .card {
    background: rgba(238, 245, 255, 0.46);
    -webkit-backdrop-filter: blur(18px) saturate(1.3);
    backdrop-filter: blur(18px) saturate(1.3);
    border: 1px solid rgba(255,255,255,.75);
    border-radius: 20px;
    box-shadow: 0 20px 60px -24px rgba(28, 64, 130, 0.35), inset 0 1px 0 rgba(255,255,255,.6);
    padding: 18px;
    margin: 0 0 12px;
  }
  h2 {
    margin: 0 0 10px;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -.02em;
    text-transform: none;
    color: var(--ink);
  }
  label.check { display: flex; gap: 10px; align-items: flex-start; margin: 0 0 10px; cursor: pointer; color: var(--ink-2); }
  label.check input { margin-top: 2px; accent-color: var(--blue); }
  button {
    font: inherit; cursor: pointer; border: 0;
    border-radius: 12px; padding: 10px 14px;
    transition: transform .16s ease, opacity .12s ease, box-shadow .16s ease;
  }
  button:hover { transform: translateY(-1px); }
  button:disabled { opacity: .45; cursor: default; transform: none; }
  button.busy { opacity: .7; pointer-events: none; }
  .primary {
    width: 100%;
    background: #0d1422; color: #fff; font-weight: 500;
  }
  .primary:not(:disabled):hover { box-shadow: 0 14px 30px -12px rgba(13,20,34,.6); }
  .ghost {
    background: #fff; color: var(--ink); font-weight: 500;
    box-shadow: 0 6px 18px -10px rgba(28,64,130,.35);
  }
  .hero { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .bal { font-size: 28px; font-weight: 600; letter-spacing: -.03em; }
  .wallet { margin: 6px 0 0; color: var(--muted); font-size: 12px; font-family: ui-monospace, "SF Mono", Menlo, monospace; word-break: break-all; }
  .switch {
    width: 40px; height: 24px; border-radius: 99px; padding: 0; flex: none;
    background: rgba(255,255,255,.7); position: relative;
    box-shadow: inset 0 0 0 1px rgba(180,200,235,.7);
  }
  .switch i {
    position: absolute; top: 3px; left: 3px; width: 18px; height: 18px;
    border-radius: 50%; background: #fff; display: block;
    box-shadow: 0 2px 6px rgba(28,64,130,.25);
    transition: transform .15s ease;
  }
  .switch.on { background: var(--green); box-shadow: none; }
  .switch.on i { transform: translateX(16px); }
  .seg { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; border-radius: 14px; background: rgba(255,255,255,.55); border: 1px solid rgba(255,255,255,.7); }
  .seg button { background: transparent; color: var(--ink-2); border-radius: 10px; }
  .seg button.on { background: #fff; color: var(--ink); box-shadow: 0 6px 18px -10px rgba(28,64,130,.4); }
  .row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; padding: 12px 0;
    border-top: 1px solid rgba(180,200,235,.45);
  }
  .row:first-of-type { border-top: 0; padding-top: 0; }
  .name { font-weight: 600; }
  .meta { color: var(--muted); font-size: 12px; }
  .right { display: flex; align-items: center; gap: 8px; flex: none; }
  .pill { font-size: 12px; color: var(--ink-2); background: rgba(255,255,255,.62); border-radius: 99px; padding: 4px 10px; }
  .pill.ok { color: #1d7a3a; }
  .locked { opacity: .45; pointer-events: none; }
  details { margin-top: 4px; color: var(--ink-2); }
  summary { cursor: pointer; color: var(--ink-2); font-size: 13px; }
  pre { white-space: pre-wrap; font-size: 11px; color: var(--ink-2); margin: 8px 0 0; }
  @media (max-width: 420px) {
    .hero { align-items: flex-start; flex-direction: column; }
    .right { flex-wrap: wrap; justify-content: flex-end; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="mark" aria-hidden="true"><svg viewBox="0 0 48 32"><path d="M4 30C10 22 13 12 14 2h7c-1 11-5 21-11 28H4Zm40 0c-6-7-10-17-11-28h-7c1 10 4 20 10 28h8Z" fill="currentColor"/></svg></div>
    <div>
      <div class="word">LATENT</div>
      <p class="sub">Earn USDC on Base while your agent thinks.</p>
    </div>
  </header>

  <section class="card" id="policy">
    <h2>Before you earn</h2>
    <label class="check"><input type="checkbox" id="terms" /> <span>I accept the Latent Terms and Privacy Policy. Only a workspace category leaves this machine.</span></label>
    <label class="check"><input type="checkbox" id="share" /> <span>A labeled sponsored line may appear while the agent works. Qualifying impressions credit USDC to my wallet.</span></label>
    <button class="primary" id="accept" type="button" disabled>Accept and enable</button>
  </section>

  <section class="card" id="earn">
    <div class="hero">
      <div>
        <h2 id="balanceLabel">Balance</h2>
        <div class="bal" id="balance">Latent —</div>
        <p class="wallet" id="wallet"></p>
      </div>
      <button class="switch" id="enabled" type="button" role="switch" aria-checked="false" aria-label="Earning"><i></i></button>
    </div>
    <div class="stats" id="stats"></div>
    <p class="meta" style="margin:10px 0 0">Sign-in, payouts, and campaigns are on the dashboard (Privy).</p>
    <div class="actions">
      <button class="ghost" id="dashboard" type="button">Manage wallet</button>
    </div>
  </section>

  <section class="card" id="agents">
    <h2>Agents</h2>
    <div class="row"><div><div class="name">Claude Code</div><div class="meta">In the agent spinner</div></div><div class="right" id="claude"></div></div>
    <div class="row"><div><div class="name">Codex</div><div class="meta">In the agent spinner</div></div><div class="right" id="codex"></div></div>
    <div class="row"><div><div class="name">Claude CLI</div><div class="meta">Terminal status line</div></div><div class="right" id="cli"></div></div>
  </section>

  <details>
    <summary>Diagnostics</summary>
    <pre id="diagnose"></pre>
    <div class="actions">
      <button class="ghost" id="refresh" type="button">Refresh</button>
      <button class="primary" id="reload" type="button" style="width:auto">Reload window</button>
    </div>
  </details>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }
  function agentSlot(row) {
    if (!row || !row.installed) return '<span class="pill">Not installed</span>';
    const pill = row.patched ? '<span class="pill ok">On</span>' : (row.conflict ? '<span class="pill">Conflict</span>' : '<span class="pill">Off</span>');
    const btn = row.patched
      ? '<button class="ghost" type="button" data-act="restore" data-agent="' + esc(row.agent) + '">Restore</button>'
      : '<button class="primary" type="button" data-act="inject" data-agent="' + esc(row.agent) + '" style="width:auto">Inject</button>';
    return pill + btn;
  }
  function render(s) {
    const locked = !s.policyAccepted;
    $("policy").style.display = locked ? "block" : "none";
    $("earn").classList.toggle("locked", locked);
    $("agents").classList.toggle("locked", locked);
    const f = s.figures || {};
    $("balanceLabel").textContent = "Your balance";
    $("balance").textContent = f.personal ? (f.balance || "—") : "—";
    $("wallet").textContent = s.wallet || "No wallet yet — npx latent-protocol init";
    const cells = [
      ["Total impressions", f.impressions],
      ["Total paid out", f.paidOut],
      ["Total earned", f.totalEarned],
      ["Clicks", f.clicks],
    ];
    const dash = $("dashboard");
    if (dash) dash.className = s.wallet ? "ghost" : "primary";
    $("stats").innerHTML = cells.map(([k, v]) => '<div class="stat"><b>' + esc(v || "—") + '</b><span>' + esc(k) + '</span></div>').join("");
    const on = !!s.enabled;
    $("enabled").classList.toggle("on", on);
    $("enabled").setAttribute("aria-checked", on ? "true" : "false");
    const claude = (s.agents || []).find((a) => a.agent === "claude-code");
    const codex = (s.agents || []).find((a) => a.agent === "codex");
    $("claude").innerHTML = agentSlot(claude);
    $("codex").innerHTML = agentSlot(codex);
    $("cli").innerHTML = !s.cliRuntime
      ? '<span class="pill">Needs init</span>'
      : (s.cliInstalled
        ? '<span class="pill ok">On</span><button class="ghost" type="button" data-act="cli-off">Remove</button>'
        : '<span class="pill">Off</span><button class="primary" type="button" data-act="cli-on" style="width:auto">Install</button>');
    $("diagnose").textContent = s.diagnose || "";
    document.querySelectorAll(".busy").forEach((n) => n.classList.remove("busy"));
  }
  function syncAccept() { $("accept").disabled = !($("terms").checked && $("share").checked); }
  $("terms").addEventListener("change", syncAccept);
  $("share").addEventListener("change", syncAccept);
  $("accept").addEventListener("click", () => { $("accept").classList.add("busy"); vscode.postMessage({ type: "accept" }); });
  $("enabled").addEventListener("click", () => {
    const next = $("enabled").getAttribute("aria-checked") !== "true";
    $("enabled").classList.toggle("on", next);
    $("enabled").setAttribute("aria-checked", next ? "true" : "false");
    vscode.postMessage({ type: "setEnabled", enabled: next });
  });
  $("dashboard").addEventListener("click", () => vscode.postMessage({ type: "openDashboard" }));
  $("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  $("reload").addEventListener("click", () => vscode.postMessage({ type: "reload" }));
  setInterval(() => vscode.postMessage({ type: "refresh" }), 20000);
  document.body.addEventListener("click", (e) => {
    const el = e.target instanceof Element ? e.target.closest("[data-act]") : null;
    if (!el || el.id === "accept" || el.id === "enabled" || el.id === "refresh") return;
    el.classList.add("busy");
    const act = el.getAttribute("data-act");
    if (act === "inject" || act === "restore") vscode.postMessage({ type: act, agent: el.getAttribute("data-agent") });
    else if (act === "cli-on") vscode.postMessage({ type: "cli", install: true });
    else if (act === "cli-off") vscode.postMessage({ type: "cli", install: false });
    else if (act === "surface") vscode.postMessage({ type: "surface", surface: el.getAttribute("data-surface") });
  });
  window.addEventListener("message", (e) => { if (e.data && e.data.type === "state") render(e.data.state); });
  vscode.postMessage({ type: "refresh" });
</script>
</body>
</html>`;
}
