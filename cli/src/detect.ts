import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, saveConfig } from "./config.js";
import {
  codexFamilyDetectionRows,
  CODEX_AGENTS,
  codexDetected,
} from "./surfaces/codex.js";
import { grokDetected, grokHome } from "./surfaces/grok.js";
import { mimoConfigDir, mimoDetected } from "./surfaces/mimo.js";
import { detectVscode } from "./scanners/vscode.js";

export interface DetectedAgents {
  claudeCode: boolean;
  grok: boolean;
  grokBin: boolean;
  hermes: boolean;
  hermesBin: boolean;
  hermesWebui: boolean;
  hermesWebuiStatic: string | null;
  hermesWebuiPatched: boolean;
  openclaw: boolean;
  openclawBin: boolean;
  mimo: boolean;
  vscode: boolean;
  vscodeBin: boolean;
  vscodeEditor: "vscode" | "cursor" | null;
  paths: {
    claudeSettings: string;
    grokHome: string;
    grokConfig: string;
    hermesHome: string;
    hermesPlugins: string;
    openclawHome: string;
    openclawPlugins: string;
    mimoConfigDir: string;
    vscodeExtensionsDir: string;
    latentConfig: string;
  };
}

function which(bin: string): string | null {
  const res = spawnSync("bash", ["-lc", `command -v ${bin}`], {
    encoding: "utf8",
  });
  const out = (res.stdout || "").trim();
  return res.status === 0 && out ? out : null;
}

/** True if this looks like nesquena/hermes-webui static/, not a random index.html. */
export function looksLikeHermesWebuiStatic(staticDir: string): boolean {
  const index = join(staticDir, "index.html");
  if (!existsSync(index)) return false;
  try {
    const html = readFileSync(index, "utf8");
    if (
      html.includes("hermes-webui") ||
      html.includes("__HERMES_WEBUI_BUNDLE_VERSION__") ||
      html.includes("hermes-theme") ||
      html.includes("latent-protocol-webui-patch")
    ) {
      return true;
    }
  } catch {
    return false;
  }
  // Sibling signatures from the upstream repo layout
  return (
    existsSync(join(staticDir, "ui.js")) &&
    (existsSync(join(staticDir, "..", "server.py")) ||
      existsSync(join(staticDir, "..", "bootstrap.py")) ||
      existsSync(join(staticDir, "..", "ctl.sh")))
  );
}

function isPatched(staticDir: string | null): boolean {
  if (!staticDir) return false;
  try {
    return readFileSync(join(staticDir, "index.html"), "utf8").includes(
      "latent-protocol-webui-patch",
    );
  } catch {
    return false;
  }
}

function pushUnique(out: string[], dir: string | null | undefined): void {
  if (!dir) return;
  if (!out.includes(dir)) out.push(dir);
}

function procCwdsMentioningWebui(): string[] {
  const out: string[] = [];
  try {
    const res = spawnSync(
      "bash",
      [
        "-lc",
        // Match common launchers; print cwd of matching PIDs
        `for pid in $(pgrep -f 'hermes-webui|hermes_webui|bootstrap\\.py|ctl\\.sh' 2>/dev/null); do
           cwd=$(readlink -f /proc/$pid/cwd 2>/dev/null) || continue
           echo "$cwd"
         done`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    for (const line of (res.stdout || "").split("\n")) {
      const cwd = line.trim();
      if (!cwd) continue;
      pushUnique(out, join(cwd, "static"));
      // Sometimes cwd is already static/ or a parent
      if (cwd.endsWith("/static")) pushUnique(out, cwd);
    }
  } catch {
    // ignore
  }
  return out;
}

function findViaLocateOrFind(roots: string[]): string[] {
  const found: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      // Prefer path-named clones
      const named = spawnSync(
        "find",
        [
          root,
          "-maxdepth",
          "6",
          "-type",
          "f",
          "(",
          "-path",
          "*/hermes-webui/static/index.html",
          "-o",
          "-path",
          "*/hermes_webui/static/index.html",
          ")",
        ],
        { encoding: "utf8", timeout: 12000 },
      );
      for (const line of (named.stdout || "").split("\n")) {
        const f = line.trim();
        if (f) pushUnique(found, dirname(f));
      }
    } catch {
      // continue
    }
  }

  // Signature search: index.html that mentions hermes-webui (bounded)
  if (found.length === 0) {
    for (const root of roots) {
      if (!existsSync(root)) continue;
      try {
        const res = spawnSync(
          "bash",
          [
            "-lc",
            `find ${JSON.stringify(root)} -maxdepth 5 -type f -name index.html 2>/dev/null | head -80 | while read -r f; do
               if grep -qlE 'hermes-webui|__HERMES_WEBUI_BUNDLE_VERSION__|hermes-theme' "$f" 2>/dev/null; then
                 echo "$f"
               fi
             done`,
          ],
          { encoding: "utf8", timeout: 15000 },
        );
        for (const line of (res.stdout || "").split("\n")) {
          const f = line.trim();
          if (f) pushUnique(found, dirname(f));
        }
      } catch {
        // ignore
      }
      if (found.length) break;
    }
  }
  return found;
}

/** Shared candidate list for hermes-webui static/. */
export function hermesWebuiStaticCandidates(home = homedir()): string[] {
  const envStatic = process.env.HERMES_WEBUI_STATIC;
  const envRoot =
    process.env.HERMES_WEBUI_ROOT || process.env.HERMES_WEBUI_DIR || "";
  const hermesHome = process.env.HERMES_HOME || join(home, ".hermes");
  const cfg = loadConfig();

  const out: string[] = [];
  // Explicit env wins over cached path from a previous machine/run.
  pushUnique(out, envStatic);
  if (envRoot) pushUnique(out, join(envRoot, "static"));
  pushUnique(out, cfg.hermes_webui_static);

  // Running process cwd (pid files + live pgrep)
  for (const pidFile of [
    join(hermesHome, "webui.pid"),
    join(home, ".hermes", "webui.pid"),
    "/var/run/hermes-webui.pid",
    "/tmp/hermes-webui.pid",
  ]) {
    try {
      if (!existsSync(pidFile)) continue;
      const pid = readFileSync(pidFile, "utf8").trim().split(/\s+/)[0];
      if (!pid) continue;
      const cwd = spawnSync("readlink", ["-f", `/proc/${pid}/cwd`], {
        encoding: "utf8",
      });
      if (cwd.status === 0 && cwd.stdout.trim()) {
        pushUnique(out, join(cwd.stdout.trim(), "static"));
      }
    } catch {
      // ignore
    }
  }
  for (const d of procCwdsMentioningWebui()) pushUnique(out, d);

  const common = [
    join(home, "hermes-webui", "static"),
    join(home, "Hermes-WebUI", "static"),
    join(home, "src", "hermes-webui", "static"),
    join(home, "apps", "hermes-webui", "static"),
    join(home, "code", "hermes-webui", "static"),
    join(home, "git", "hermes-webui", "static"),
    join(home, "repos", "hermes-webui", "static"),
    join(home, "projects", "hermes-webui", "static"),
    join(home, "workspace", "hermes-webui", "static"),
    join(home, "dev", "hermes-webui", "static"),
    join(hermesHome, "hermes-webui", "static"),
    join(hermesHome, "webui", "static"),
    "/opt/hermes-webui/static",
    "/opt/hermes/webui/static",
    "/opt/hermes/hermes-webui/static",
    "/srv/hermes-webui/static",
    "/var/www/hermes-webui/static",
    "/usr/local/lib/hermes-webui/static",
    "/usr/local/share/hermes-webui/static",
    join(process.cwd(), "static"),
    join(process.cwd(), "hermes-webui", "static"),
  ];
  // Also check /root explicitly when home isn't /root (sudo cases)
  if (home !== "/root") {
    common.push(
      "/root/hermes-webui/static",
      "/root/src/hermes-webui/static",
      "/root/apps/hermes-webui/static",
      "/root/.hermes/hermes-webui/static",
    );
  }
  for (const c of common) pushUnique(out, c);

  // Shallow home + /root scan
  for (const base of [home, "/root", "/home", "/opt", "/srv"]) {
    try {
      if (!existsSync(base)) continue;
      const ents =
        base === "/home"
          ? readdirSync(base, { withFileTypes: true }).flatMap((ent) =>
              ent.isDirectory() ? [join(base, ent.name)] : [],
            )
          : [base];
      for (const dir of ents) {
        try {
          for (const ent of readdirSync(dir, { withFileTypes: true })) {
            if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
            pushUnique(out, join(dir, ent.name, "hermes-webui", "static"));
            if (ent.name.toLowerCase().includes("hermes-webui")) {
              pushUnique(out, join(dir, ent.name, "static"));
            }
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  return out;
}

/**
 * Locate hermes-webui static/. Searches env, config cache, processes, common
 * paths, then bounded filesystem finds. Persists the hit to config for next run.
 */
export function findHermesWebuiStatic(home = homedir()): string | null {
  const seen = new Set<string>();
  const tryDir = (dir: string | null | undefined): string | null => {
    if (!dir || seen.has(dir)) return null;
    seen.add(dir);
    if (looksLikeHermesWebuiStatic(dir)) return dir;
    return null;
  };

  for (const dir of hermesWebuiStaticCandidates(home)) {
    const hit = tryDir(dir);
    if (hit) {
      persistWebuiStatic(hit);
      return hit;
    }
  }

  // Aggressive find across typical roots
  const roots = Array.from(
    new Set([
      home,
      "/root",
      "/home",
      "/opt",
      "/srv",
      "/var/www",
      "/usr/local",
      process.cwd(),
    ]),
  );
  for (const dir of findViaLocateOrFind(roots)) {
    const hit = tryDir(dir);
    if (hit) {
      persistWebuiStatic(hit);
      return hit;
    }
  }

  return null;
}

function persistWebuiStatic(staticDir: string): void {
  try {
    const cfg = loadConfig();
    if (cfg.hermes_webui_static !== staticDir) {
      saveConfig({ hermes_webui_static: staticDir });
    }
  } catch {
    // non-fatal
  }
}

export function detectAgents(): DetectedAgents {
  const home = homedir();
  const claudeDir = join(home, ".claude");
  const hermesHome = process.env.HERMES_HOME || join(home, ".hermes");
  const openclawHome =
    process.env.OPENCLAW_HOME || join(home, ".openclaw");
  const hermesWebuiStatic = findHermesWebuiStatic(home);
  const hermesBin = Boolean(which("hermes"));
  const openclawBin = Boolean(which("openclaw"));
  const grokDir = grokHome(home);
  const grokBin = Boolean(which("grok"));
  const vs = detectVscode();

  return {
    claudeCode: existsSync(claudeDir),
    grok: grokDetected(home),
    grokBin,
    hermes: existsSync(hermesHome) || hermesBin,
    hermesBin,
    hermesWebui: Boolean(hermesWebuiStatic),
    hermesWebuiStatic,
    hermesWebuiPatched: isPatched(hermesWebuiStatic),
    openclaw: existsSync(openclawHome) || openclawBin,
    openclawBin,
    mimo: mimoDetected(),
    vscode: vs.editor !== null,
    vscodeBin: Boolean(vs.bin),
    vscodeEditor: vs.editor,
    paths: {
      claudeSettings: join(claudeDir, "settings.json"),
      grokHome: grokDir,
      grokConfig: join(grokDir, "config.toml"),
      hermesHome,
      hermesPlugins: join(hermesHome, "plugins"),
      openclawHome,
      openclawPlugins: join(openclawHome, "extensions"),
      mimoConfigDir: mimoConfigDir(),
      vscodeExtensionsDir: vs.extensionsDir ?? join(home, ".vscode", "extensions"),
      latentConfig: join(home, ".latent-protocol", "config.json"),
    },
  };
}

export function formatDetectionTable(d: DetectedAgents): string {
  const webuiStatus = d.hermesWebui
    ? d.hermesWebuiPatched
      ? "patched"
      : "detected"
    : "not found";
  const rows: [string, string, string][] = [
    [
      "Claude Code",
      d.claudeCode ? "detected" : "not found",
      d.paths.claudeSettings,
    ],
    [
      "Grok Build",
      d.grok ? (d.grokBin ? "detected+bin" : "detected") : "not found",
      d.paths.grokConfig,
    ],
    [
      "Hermes",
      d.hermes ? (d.hermesBin ? "detected+bin" : "detected") : "not found",
      d.paths.hermesHome,
    ],
    [
      "Hermes WebUI",
      webuiStatus,
      d.hermesWebuiStatic || "(set HERMES_WEBUI_ROOT)",
    ],
    [
      "OpenClaw",
      d.openclaw ? (d.openclawBin ? "detected+bin" : "detected") : "not found",
      d.paths.openclawHome,
    ],
    ...codexFamilyDetectionRows(),
    ["MiMo Code", d.mimo ? "detected" : "not found", d.paths.mimoConfigDir],
    [
      "Cursor / VS Code",
      d.vscode
        ? `detected (${d.vscodeEditor ?? "?"})${d.vscodeBin ? "+bin" : ""}`
        : "not found",
      d.paths.vscodeExtensionsDir,
    ],
  ];
  return rows
    .map(
      ([name, status, path]) =>
        `  ${name.padEnd(14)} ${status.padEnd(14)} ${path}`,
    )
    .join("\n");
}

export function formatSurfaceMatrix(d: DetectedAgents): string {
  const webui = !d.hermesWebui
    ? "skipped (static/ not found — set HERMES_WEBUI_ROOT)"
    : d.hermesWebuiPatched
      ? `patched ✅ (${d.hermesWebuiStatic})`
      : `found, NOT patched (${d.hermesWebuiStatic})`;

  const lines = [
    "Surface coverage after install:",
    `  • Hermes CLI / gateway (Telegram, Discord, …): ${d.hermes ? "plugin agent-ads" : "skipped"}`,
    `  • Hermes Desktop (\`hermes desktop\`):          ${d.hermes ? "same agent-ads plugin + status-bar chip" : "skipped"}`,
    `  • Hermes WebUI (browser / Tailscale):         ${webui}`,
    `  • Claude Code:                                ${d.claudeCode ? "statusLine" : "skipped"}`,
    `  • Grok Build:                                 ${d.grok ? "status line (config.toml)" : "skipped"}`,
    `  • OpenClaw (WA/TG/Slack/…):                   ${d.openclaw ? "plugin latent-protocol" : "skipped"}`,
    ...CODEX_AGENTS.filter(codexDetected).map(
      (a) => `  • ${a.name.padEnd(11)} (turn hooks hooks.json):          installed on init`,
    ),
    `  • MiMo Code (native plugin):                  ${d.mimo ? "installed on init" : "skipped"}`,
    `  • Cursor / VS Code:                           ${d.vscode ? `extension (${d.vscodeEditor ?? "vscode"})` : "skipped"}`,
    "  • Standalone Telegram bots:                   manual wrap (see docs/PLUGIN.md)",
  ];
  return lines.join("\n");
}
