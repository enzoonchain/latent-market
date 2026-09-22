import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { detectAgents, findHermesWebuiStatic } from "../detect.js";
import { deviceId, loadConfig, resolveServer, resolveWallet, saveConfig } from "../config.js";
import { isValidAddress } from "../wallet.js";
import { templatePath } from "../pkg.js";
import {
  ensureWebuiCspConnectExtra,
  patchWebuiCspSource,
  patchWebuiCtlShCsp,
  patchWebuiIndex,
  patchWebuiLatentProxy,
  unpatchWebuiIndex,
} from "./hermes-webui-patch.js";

const PLUGIN_NAME = "agent-ads";
function templateDir(): string {
  return templatePath("hermes-plugin");
}

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    env: process.env,
  });
  return {
    ok: res.status === 0,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

/** Replaces exactly one occurrence of `token` — throws instead of silently
 * substituting the wrong spot (e.g. a stray mention in a comment) the way a
 * bare `String.replace` would. */
function templateOnce(source: string, token: string, value: string): string {
  const count = source.split(token).length - 1;
  if (count !== 1) {
    throw new Error(`expected exactly one ${token} placeholder, found ${count}`);
  }
  return source.replace(token, () => value);
}

/** Templates __SERVER__/__WALLET__/__DEVICE_ID__ into the desktop/plugin.js template with
 * JSON.stringify (never naive string interpolation), matching the same
 * safety discipline hermes-webui-patch.ts uses for its injected JS. Written
 * beside plugin.yaml/__init__.py so the Hermes Desktop app's plugin SDK
 * loader picks it up from the same ~/.hermes/plugins/agent-ads/ folder
 * ("one package, both SDKs" — see docs/PLUGIN.md). */
export function writeDesktopPlugin(
  dest: string,
  opts: { server: string; wallet: string; deviceId?: string },
): string {
  const src = join(templateDir(), "desktop", "plugin.js");
  if (!existsSync(src)) {
    return "ℹ️  No desktop/plugin.js template found — skipped.";
  }
  const wallet = isValidAddress(opts.wallet) ? opts.wallet : "";
  const server = opts.server.replace(/\/+$/, "");
  const raw = readFileSync(src, "utf8");
  const device = /^[0-9a-f]{8,64}$/i.test(opts.deviceId ?? "") ? opts.deviceId! : "";
  const rendered = templateOnce(
    templateOnce(
      templateOnce(raw, "__SERVER__", JSON.stringify(server)),
      "__WALLET__",
      JSON.stringify(wallet),
    ),
    "__DEVICE_ID__",
    JSON.stringify(device),
  );
  const destDir = join(dest, "desktop");
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, "plugin.js"), rendered);
  return wallet
    ? `✅ Hermes Desktop plugin written → ${join(destDir, "plugin.js")} (sponsored status-bar line)`
    : `ℹ️  Hermes Desktop plugin written, but no wallet configured yet — chip stays hidden until \`/ads setup\`.`;
}

function writeFlatPlugin(
  pluginsDir: string,
  desktop: { server: string; wallet: string; deviceId?: string },
): string {
  const dest = join(pluginsDir, PLUGIN_NAME);
  mkdirSync(dest, { recursive: true });
  const src = templateDir();
  copyFileSync(join(src, "plugin.yaml"), join(dest, "plugin.yaml"));
  copyFileSync(join(src, "__init__.py"), join(dest, "__init__.py"));
  const desktopResult = writeDesktopPlugin(dest, desktop);
  return (
    `✅ Hermes plugin written → ${dest} (standalone — no pip package needed)\n` +
    `   ${desktopResult}`
  );
}

function patchConfigEnabled(): string {
  const { paths } = detectAgents();
  const configPath = join(paths.hermesHome, "config.yaml");
  try {
    let raw = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    if (raw.includes(`- ${PLUGIN_NAME}`) || raw.includes(`- "${PLUGIN_NAME}"`)) {
      return "ℹ️  agent-ads already listed in plugins.enabled";
    }
    if (/plugins:\s*\n(?:[ \t]+.+\n)*?[ \t]+enabled:\s*\n/.test(raw)) {
      raw = raw.replace(
        /(plugins:\s*\n(?:[ \t]+.+\n)*?[ \t]+enabled:\s*\n)/,
        `$1    - ${PLUGIN_NAME}\n`,
      );
      writeFileSync(configPath, raw);
      return `✅ Added agent-ads to ${configPath} plugins.enabled`;
    }
    const block =
      (raw.endsWith("\n") || raw.length === 0 ? "" : "\n") +
      "plugins:\n  enabled:\n" +
      `    - ${PLUGIN_NAME}\n`;
    writeFileSync(configPath, raw + block);
    return `✅ Wrote plugins.enabled to ${configPath}`;
  } catch (err) {
    return `⚠️  Could not enable plugin automatically: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function enableHermesPlugin(): string {
  const which = run("hermes", ["--help"]);
  if (which.ok) {
    const enable = run("hermes", ["plugins", "enable", PLUGIN_NAME]);
    if (enable.ok) return "✅ hermes plugins enable agent-ads";
  }
  // Fallback when hermes CLI missing or enable failed
  return patchConfigEnabled();
}

/** Patch nesquena/hermes-webui index.html (separate from CLI plugin — WebUI
 * runs its own agent loop and does not load hermes_agent.plugins).
 * Primary path is Node-native write — does not depend on Hermes venv pip. */
function patchHermesWebui(): string {
  const detected = detectAgents();
  const cfg = loadConfig();
  const wallet = resolveWallet(cfg);
  const server = resolveServer(cfg);
  const frequency = cfg.frequency ?? 1;

  const staticDirs = [
    detected.hermesWebuiStatic,
    findHermesWebuiStatic(),
    cfg.hermes_webui_static,
    process.env.HERMES_WEBUI_STATIC,
    process.env.HERMES_WEBUI_ROOT
      ? join(process.env.HERMES_WEBUI_ROOT, "static")
      : "",
  ].filter((p, i, arr): p is string => Boolean(p) && arr.indexOf(p) === i);

  const errors: string[] = [];

  for (const dir of staticDirs) {
    if (!existsSync(join(dir, "index.html"))) {
      errors.push(`${dir}: no index.html`);
      continue;
    }
    const res = patchWebuiIndex({
      staticDir: dir,
      server,
      wallet,
      frequency,
    });
    if (res.ok) {
      try {
        saveConfig({ hermes_webui_static: dir });
      } catch {
        // ignore
      }
      const proxy = patchWebuiLatentProxy({ staticDir: dir, server });
      // CSP widen kept as belt-and-suspenders; proxy is the reliable path.
      ensureWebuiCspConnectExtra({
        staticDir: dir,
        server,
        hermesHome: detectAgents().paths.hermesHome,
      });
      patchWebuiCspSource({ staticDir: dir, server });
      patchWebuiCtlShCsp({ staticDir: dir, server });
      const proxyLine = proxy.ok
        ? `   Same-origin proxy: ${proxy.proxyPath}\n` +
          `   server.py: ${proxy.serverPath}\n` +
          `   -> ${proxy.origin}\n` +
          proxy.notes.map((n) => `   • ${n}`).join("\n")
        : `   ⚠️  Proxy patch failed: ${proxy.error}`;
      return (
        `✅ Hermes WebUI patched (node → ${dir})\n` +
        `   Patched: ${res.indexPath}\n` +
        `${proxyLine}\n` +
        "   REQUIRED next steps:\n" +
        "   1) Restart WebUI:  cd ~/hermes-webui && ./ctl.sh restart\n" +
        "   2) Verify proxy locally:\n" +
        `      curl -sS -X POST http://127.0.0.1:PORT/api/latent/ad/request -H 'Content-Type: application/json' -d '{"user_wallet":"0x0","agent":"hermes","context":"test"}'\n` +
        "   3) Hard-refresh: Ctrl+Shift+R\n" +
        "   4) Console: version 7; Network POST /api/latent/ad/request -> 200 + Sponsored footer"
      );
    }
    errors.push(`${dir}: ${res.error}`);
  }

  if (staticDirs.length === 0) {
    return (
      "ℹ️  Hermes WebUI not patched (static/ not found after deep scan).\n" +
      "   Set once and re-init:\n" +
      "   HERMES_WEBUI_ROOT=/path/to/hermes-webui npx latent-protocol init --yes"
    );
  }

  return (
    `⚠️  Hermes WebUI found but patch failed.\n` +
    errors.map((e) => `   • ${e}`).join("\n") +
    "\n   Check file permissions on index.html, then retry init."
  );
}

export function installHermes(): string {
  const detected = detectAgents();
  if (!detected.hermes && !detected.hermesWebui) {
    return "ℹ️  Hermes / Hermes WebUI not detected — skipped.";
  }

  const lines: string[] = [];
  if (detected.hermes) {
    mkdirSync(detected.paths.hermesPlugins, { recursive: true });
    const cfg = loadConfig();
    lines.push(
      writeFlatPlugin(detected.paths.hermesPlugins, {
        server: resolveServer(cfg),
        wallet: resolveWallet(cfg),
        deviceId: deviceId(),
      }),
    );
    lines.push(enableHermesPlugin());
    lines.push("   Restart Hermes / `hermes gateway restart` to load the plugin.");
  } else {
    lines.push(
      "ℹ️  Hermes home not found — installing WebUI DOM patch only (CLI plugin skipped).",
    );
  }
  lines.push(patchHermesWebui());
  return lines.join("\n");
}

function removeFromConfigEnabled(): string {
  const { paths } = detectAgents();
  const configPath = join(paths.hermesHome, "config.yaml");
  if (!existsSync(configPath)) return "ℹ️  No Hermes config.yaml to edit.";
  try {
    const raw = readFileSync(configPath, "utf8");
    const next = raw
      .split("\n")
      .filter((line) => !line.match(new RegExp(`^\\s*-\\s*["']?${PLUGIN_NAME}["']?\\s*$`)))
      .join("\n");
    if (next === raw) return "ℹ️  agent-ads not present in config.yaml";
    writeFileSync(configPath, next);
    return `✅ Removed agent-ads from ${configPath}`;
  } catch (err) {
    return `⚠️  Could not edit config.yaml: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function unpatchHermesWebui(): string {
  const staticDir =
    detectAgents().hermesWebuiStatic ||
    findHermesWebuiStatic() ||
    loadConfig().hermes_webui_static;
  if (!staticDir) {
    return "ℹ️  Hermes WebUI patch not removed (static/ not found).";
  }
  const res = unpatchWebuiIndex(staticDir);
  if (res.ok) return `✅ Hermes WebUI: ${res.message}`;
  return `⚠️  Hermes WebUI unpatch failed: ${res.error}`;
}

export function uninstallHermes(): string {
  const { paths, hermes } = detectAgents();
  if (!hermes) return "ℹ️  Hermes not detected; nothing to remove.";

  const dest = join(paths.hermesPlugins, PLUGIN_NAME);
  const lines: string[] = [];
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
    lines.push(`✅ Removed ${dest}`);
  } else {
    lines.push("ℹ️  No flat agent-ads plugin dir found.");
  }

  const disable = run("hermes", ["plugins", "disable", PLUGIN_NAME]);
  if (disable.ok) {
    lines.push("✅ hermes plugins disable agent-ads");
  } else {
    lines.push(removeFromConfigEnabled());
  }
  lines.push(unpatchHermesWebui());
  return lines.join("\n");
}

function webuiPatchStatus(): string {
  const staticDir = findHermesWebuiStatic();
  if (!staticDir) {
    return "Hermes WebUI: not found (set HERMES_WEBUI_ROOT to enable patch)";
  }
  const index = join(staticDir, "index.html");
  try {
    const html = readFileSync(index, "utf8");
    if (html.includes("latent-protocol-webui-patch")) {
      return `Hermes WebUI: patched (${index})`;
    }
    return `Hermes WebUI: found, not patched (${staticDir})`;
  } catch {
    return `Hermes WebUI: found, unreadable (${staticDir})`;
  }
}

export function hermesStatus(): string {
  const { hermes, paths } = detectAgents();
  if (!hermes) return "Hermes: not detected";
  const dest = join(paths.hermesPlugins, PLUGIN_NAME);
  const flat = existsSync(join(dest, "plugin.yaml"));
  const configPath = join(paths.hermesHome, "config.yaml");
  let enabled = false;
  try {
    const raw = readFileSync(configPath, "utf8");
    enabled = raw.includes(PLUGIN_NAME);
  } catch {
    enabled = false;
  }
  let cli: string;
  if (flat && enabled) cli = `Hermes: patched (plugin dir + enabled as ${PLUGIN_NAME})`;
  else if (flat) cli = "Hermes: plugin dir present, not confirmed enabled";
  else if (enabled) cli = "Hermes: enabled in config (entry-point / external install)";
  else cli = "Hermes: detected, not patched";
  return `${cli}\n  ${webuiPatchStatus()}`;
}
