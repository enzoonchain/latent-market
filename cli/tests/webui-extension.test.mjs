/**
 * Hermes WebUI surface: installed as a WebUI extension (docs/EXTENSIONS.md in
 * nesquena/hermes-webui), plus removal of the source edits older releases made.
 *
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/webui-extension.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasLegacyWebuiPatches,
  installWebuiExtension,
  removeCspConnectExtra,
  removeLegacyWebuiPatches,
  renderExtensionScript,
  uninstallWebuiExtension,
  webuiExtensionInstalled,
} from "../dist/surfaces/hermes-webui.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/webui-legacy/", import.meta.url));
const SERVER = "https://api.latentprotocol.xyz";
const WALLET = "0x" + "ab".repeat(20);
const DEVICE = "6673308161234c62058f00390d3567ca";

function webuiTree() {
  const home = mkdtempSync(join(tmpdir(), "latent-webui-home-"));
  const root = join(home, "hermes-webui");
  cpSync(join(FIXTURES, "orig"), root, { recursive: true });
  return { home, root, staticDir: join(root, "static") };
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

test("installs into the managed extension dir and registers like a gallery install", () => {
  const { home, root, staticDir } = webuiTree();
  const stateDir = join(home, ".hermes", "webui");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "extension-install-manifest.json"),
    JSON.stringify({ version: 1, installed: { other: { version: "2", files: ["a.js"], installed_at: "x" } } }),
  );

  const res = installWebuiExtension({ staticDir, server: SERVER + "/", wallet: WALLET, deviceId: DEVICE, frequency: 2, home });
  assert.equal(res.ok, true, res.error);
  const dir = join(stateDir, "extensions", "latent-ads");
  assert.equal(res.dir, dir);

  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.id, "latent-ads");
  assert.deepEqual(manifest.scripts, ["latent-ads.js"]);
  assert.equal(manifest.permissions.network_external, true);

  const record = JSON.parse(readFileSync(join(stateDir, "extension-install-manifest.json"), "utf8"));
  assert.ok(record.installed.other, "other installs are preserved");
  assert.deepEqual(record.installed["latent-ads"].files, ["manifest.json", "latent-ads.js", "latent-ads.css"]);
  assert.equal(webuiExtensionInstalled(staticDir, home), true);

  // CSP through the documented knob in the WebUI's .env; other keys kept, 0600.
  const env = readFileSync(join(root, ".env"), "utf8");
  assert.match(env, /^FOO=bar$/m);
  assert.match(env, /^HERMES_WEBUI_CSP_CONNECT_EXTRA=https:\/\/api\.latentprotocol\.xyz$/m);
  assert.equal(statSync(join(root, ".env")).mode & 0o777, 0o600);

  // No WebUI source file was touched.
  for (const f of listFiles(join(FIXTURES, "orig"))) {
    if (f === ".env") continue;
    assert.equal(readFileSync(join(root, f), "utf8"), readFileSync(join(FIXTURES, "orig", f), "utf8"), f);
  }

  // Idempotent: re-install does not duplicate the CSP origin.
  installWebuiExtension({ staticDir, server: SERVER, wallet: WALLET, deviceId: DEVICE, home });
  const env2 = readFileSync(join(root, ".env"), "utf8");
  assert.equal(env2.split("https://api.latentprotocol.xyz").length - 1, 1);
});

test("honours HERMES_WEBUI_EXTENSION_DIR / HERMES_WEBUI_STATE_DIR from the WebUI .env", () => {
  const { home, root, staticDir } = webuiTree();
  const extDir = join(home, "my-ext");
  const state = join(home, "state");
  writeFileSync(join(root, ".env"), `HERMES_WEBUI_EXTENSION_DIR=${extDir}\nHERMES_WEBUI_STATE_DIR="${state}"\n`);
  const res = installWebuiExtension({ staticDir, server: SERVER, wallet: WALLET, home });
  assert.equal(res.ok, true);
  assert.ok(existsSync(join(extDir, "latent-ads", "latent-ads.js")));
  assert.ok(existsSync(join(state, "extension-install-manifest.json")));
});

test("rendered script: config JSON-encoded, injection rejected, ASCII-only, valid JS", () => {
  const js = renderExtensionScript({ server: SERVER + "/", wallet: WALLET, deviceId: DEVICE, frequency: 3 });
  assert.ok(js.includes(`var SERVER = ${JSON.stringify(SERVER)};`));
  assert.ok(js.includes(`var WALLET = ${JSON.stringify(WALLET)};`));
  assert.ok(js.includes(`var DEVICE_ID = ${JSON.stringify(DEVICE)};`));
  assert.ok(js.includes("var FREQUENCY = 3;"));
  assert.ok(!/__[A-Z_]+__/.test(js), "no placeholder left");
  assert.ok(/^[\x00-\x7f]*$/.test(js), "ASCII-only source");
  // Only the category slug is sent, never chat text; no legacy proxy paths.
  assert.ok(js.includes("context: 'coding'"));
  assert.ok(!js.includes("/api/latent") && !js.includes("/__latent__"));
  assert.ok(!js.includes("innerHTML"), "DOM is built with textContent");
  assert.ok(js.includes("credentials: 'omit'"));

  const evil = renderExtensionScript({ server: SERVER, wallet: '0x"; alert(1); //', deviceId: '"; alert(2); //', frequency: "1; alert(3)" });
  assert.ok(!evil.includes("alert("), "malformed config is dropped, never interpolated");
  assert.ok(evil.includes('var WALLET = "";'));

  const dir = mkdtempSync(join(tmpdir(), "latent-webui-js-"));
  writeFileSync(join(dir, "latent-ads.js"), js);
  execFileSync(process.execPath, ["--check", join(dir, "latent-ads.js")]);
});

test("uninstall removes the extension, its record and only our CSP origin", () => {
  const { home, root, staticDir } = webuiTree();
  writeFileSync(join(root, ".env"), "FOO=bar\nHERMES_WEBUI_CSP_CONNECT_EXTRA=https://mine.example\n");
  installWebuiExtension({ staticDir, server: SERVER, wallet: WALLET, home });
  const lines = uninstallWebuiExtension({ staticDir, server: SERVER, home });
  assert.ok(lines.length >= 3, lines.join("\n"));
  assert.equal(existsSync(join(home, ".hermes", "webui", "extensions", "latent-ads")), false);
  const record = JSON.parse(readFileSync(join(home, ".hermes", "webui", "extension-install-manifest.json"), "utf8"));
  assert.equal("latent-ads" in record.installed, false);
  assert.equal(readFileSync(join(root, ".env"), "utf8"), "FOO=bar\nHERMES_WEBUI_CSP_CONNECT_EXTRA=https://mine.example\n");
  assert.equal(webuiExtensionInstalled(staticDir, home), false);
});

test("removes every source edit an older release made, byte-exact", () => {
  // fixtures/webui-legacy/patched was produced by the previous release's
  // patcher run against fixtures/webui-legacy/orig (auth + CSRF exemptions,
  // check_auth shadow, pre-auth bypass, nuclear do_POST wrap, proxy module,
  // CSP source/ctl.sh/.env edits, index.html script).
  const home = mkdtempSync(join(tmpdir(), "latent-webui-legacy-"));
  const root = join(home, "hermes-webui");
  cpSync(join(FIXTURES, "patched"), root, { recursive: true });
  const staticDir = join(root, "static");
  assert.equal(hasLegacyWebuiPatches(staticDir), true);
  assert.match(readFileSync(join(root, "api", "auth.py"), "utf8"), /\/api\/latent\//);

  const cleaned = removeLegacyWebuiPatches(staticDir, [SERVER]);
  assert.ok(cleaned.length >= 7, cleaned.join("\n"));
  assert.equal(removeCspConnectExtra(join(root, ".env"), [SERVER]), true);

  assert.deepEqual(listFiles(root), listFiles(join(FIXTURES, "orig")), "proxy module deleted, nothing else added");
  for (const f of listFiles(join(FIXTURES, "orig"))) {
    assert.equal(readFileSync(join(root, f), "utf8"), readFileSync(join(FIXTURES, "orig", f), "utf8"), f);
  }
  assert.equal(hasLegacyWebuiPatches(staticDir), false);
  assert.deepEqual(removeLegacyWebuiPatches(staticDir, [SERVER]), [], "second run is a no-op");

  const homeEnv = join(home, "hermes-home.env");
  cpSync(join(FIXTURES, "hermes-home-patched", ".env"), homeEnv);
  assert.equal(removeCspConnectExtra(homeEnv, [SERVER]), true);
  // That file held nothing but our entry (the old release created it).
  assert.equal(existsSync(homeEnv), false);
});

test("cleanup never touches an unpatched WebUI", () => {
  const { staticDir } = webuiTree();
  assert.equal(hasLegacyWebuiPatches(staticDir), false);
  assert.deepEqual(removeLegacyWebuiPatches(staticDir, [SERVER]), []);
});
