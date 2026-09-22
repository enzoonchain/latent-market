import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { detectAgents, findHermesWebuiStatic } from "../detect.js";
import { deviceId, loadConfig, resolveServer, resolveWallet, saveConfig } from "../config.js";
import { isValidAddress } from "../wallet.js";
import { templatePath } from "../pkg.js";
import {
  apiOrigin,
  hasLegacyWebuiPatches,
  installWebuiExtension,
  removeCspConnectExtra,
  removeLegacyWebuiPatches,
  uninstallWebuiExtension,
  webuiExtensionInstalled,
} from "./hermes-webui.js";

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
 * safety discipline hermes-webui.ts uses for the WebUI extension. Written
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

function webuiStaticDirs(): string[] {
  const detected = detectAgents();
  const cfg = loadConfig();
  return [
    detected.hermesWebuiStatic,
    findHermesWebuiStatic(),
    cfg.hermes_webui_static,
    process.env.HERMES_WEBUI_STATIC,
    process.env.HERMES_WEBUI_ROOT ? join(process.env.HERMES_WEBUI_ROOT, "static") : "",
  ].filter((p, i, arr): p is string => Boolean(p) && arr.indexOf(p) === i);
}

/** Origins older releases may have written into CSP config / source. */
function latentOrigins(server: string): string[] {
  return [...new Set([apiOrigin(server), "https://api.latentprotocol.xyz"])];
}

/** Older releases also appended the CSP origin to ~/.hermes/.env (the agent's
 *  env, which the WebUI never reads for CSP). */
function cleanHermesHomeEnv(server: string): string | null {
  const envPath = join(detectAgents().paths.hermesHome, ".env");
  return removeCspConnectExtra(envPath, latentOrigins(server))
    ? `✅ Removed the stale Latent CSP entry from ${envPath}`
    : null;
}

function legacyCleanupLines(staticDir: string, server: string): string[] {
  const cleaned = removeLegacyWebuiPatches(staticDir, latentOrigins(server));
  if (cleaned.length === 0) return [];
  return [
    "🔒 Removed source edits made by an older latent-protocol release (auth/CSRF",
    "   exemptions and an unauthenticated proxy). Restart the WebUI to unload them:",
    ...cleaned.map((f) => `   • ${f}`),
  ];
}

/** nesquena/hermes-webui runs its own agent loop and does not load Hermes
 *  plugins, so it gets a WebUI extension (see hermes-webui.ts). */
function installHermesWebuiSurface(): string {
  const cfg = loadConfig();
  const wallet = resolveWallet(cfg);
  const server = resolveServer(cfg);
  const staticDirs = webuiStaticDirs();
  const lines: string[] = [];
  const homeEnv = cleanHermesHomeEnv(server);
  if (homeEnv) lines.push(homeEnv);

  const dir = staticDirs.find((d) => existsSync(join(d, "index.html")));
  if (!dir) {
    lines.push(
      "ℹ️  Hermes WebUI not found (static/ not found after deep scan).\n" +
        "   Set once and re-init:\n" +
        "   HERMES_WEBUI_ROOT=/path/to/hermes-webui npx latent-protocol init --yes",
    );
    return lines.join("\n");
  }
  try {
    saveConfig({ hermes_webui_static: dir });
  } catch {
    // ignore
  }
  lines.push(...legacyCleanupLines(dir, server));

  const res = installWebuiExtension({
    staticDir: dir,
    server,
    wallet,
    deviceId: deviceId(),
    frequency: cfg.frequency ?? 1,
  });
  if (!res.ok) {
    lines.push(`⚠️  Hermes WebUI: ${res.error}`);
    return lines.join("\n");
  }
  lines.push(
    `✅ Hermes WebUI extension installed → ${res.dir}`,
    `   CSP: ${res.csp}`,
    "   Restart the WebUI (./ctl.sh restart) so it reads .env, then reload the page.",
    "   Manage it under Settings → Extensions (Latent Protocol Ads).",
  );
  if (!wallet) lines.push("   ℹ️  No wallet configured yet — the extension stays idle until one is set.");
  return lines.join("\n");
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
  lines.push(installHermesWebuiSurface());
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

function uninstallHermesWebuiSurface(): string {
  const server = resolveServer(loadConfig());
  const lines: string[] = [];
  const homeEnv = cleanHermesHomeEnv(server);
  if (homeEnv) lines.push(homeEnv);
  const dirs = webuiStaticDirs().filter((d) => existsSync(join(d, "index.html")));
  for (const dir of dirs) {
    lines.push(...legacyCleanupLines(dir, server));
    lines.push(...uninstallWebuiExtension({ staticDir: dir, server }));
  }
  if (lines.length === 0) lines.push("ℹ️  Hermes WebUI: nothing to remove.");
  return lines.join("\n");
}

export function uninstallHermes(): string {
  const { paths, hermes } = detectAgents();
  // The WebUI cleanup must run even without a Hermes CLI home: it removes
  // auth/CSRF exemptions that older releases wrote into WebUI source.
  if (!hermes) return uninstallHermesWebuiSurface();

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
  lines.push(uninstallHermesWebuiSurface());
  return lines.join("\n");
}

function webuiStatus(): string {
  const dir = webuiStaticDirs().find((d) => existsSync(join(d, "index.html")));
  if (!dir) return "Hermes WebUI: not found (set HERMES_WEBUI_ROOT to enable)";
  if (hasLegacyWebuiPatches(dir)) {
    return `Hermes WebUI: ⚠️  old source patch present (${dir}) — re-run init or uninstall to remove it`;
  }
  return webuiExtensionInstalled(dir)
    ? `Hermes WebUI: extension installed (${dir})`
    : `Hermes WebUI: found, extension not installed (${dir})`;
}

export function hermesStatus(): string {
  const { hermes, paths } = detectAgents();
  if (!hermes) return `Hermes: not detected\n  ${webuiStatus()}`;
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
  return `${cli}\n  ${webuiStatus()}`;
}
