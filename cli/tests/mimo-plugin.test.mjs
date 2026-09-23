/**
 * MiMo Code plugin surface.
 *
 * Covers two things:
 *   1. cli/src/surfaces/mimo.ts — install/uninstall/status lifecycle for the
 *      staged plugin file (dist/surfaces/mimo.js, sandboxed via MIMO_HOME).
 *   2. cli/templates/mimo-plugin/latent-protocol.ts — the standalone plugin
 *      itself, actually executed (transpiled on the fly with esbuild, same
 *      as the CLI's own build step) against a fake ad server, so the
 *      sanitisation / safe-URL / footer / impression logic is verified, not
 *      just grepped for.
 *
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/mimo-plugin.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, "..", "templates", "mimo-plugin", "latent-protocol.ts");

function startAdServer(adOverrides = {}) {
  const impressions = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/ad/request") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ad_id: "ad-1",
            title: "T",
            body: "Sponsored\x1b[31m body\x1b[0m with [brackets]",
            cta_text: "Go now",
            cta_url: "https://example.com/x",
            earn_amount: 0.0025,
            impression_token: "tok-1",
            ...adOverrides,
          }),
        );
        return;
      }
      if (req.url === "/ad/impression") impressions.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () => r({ server, impressions, port: server.address().port })),
  );
}

/** Transpile the standalone template (no bundling — it only imports node
 *  builtins) and dynamic-import the result, exactly as MiMo would run it. */
async function loadPlugin() {
  const out = join(mkdtempSync(join(tmpdir(), "latent-mimo-plugin-")), "plugin.mjs");
  await esbuild.build({
    entryPoints: [TEMPLATE],
    outfile: out,
    bundle: false,
    format: "esm",
    platform: "node",
    target: "node18",
  });
  const mod = await import(`${out}?${Math.random()}`);
  return mod.default;
}

test("plugin: sanitises ad copy, gates unsafe URLs, bills one impression", async () => {
  const { server, impressions, port } = await startAdServer();
  const home = mkdtempSync(join(tmpdir(), "latent-mimo-home-"));
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = home;
    delete process.env.ADS_WALLET;
    delete process.env.ADS_SERVER;
    delete process.env.ADS_ENABLED;
    mkdirSync(join(home, ".latent-protocol"), { recursive: true });
    writeFileSync(
      join(home, ".latent-protocol", "config.json"),
      JSON.stringify({
        wallet: "0xabc",
        enabled: true,
        server: `http://127.0.0.1:${port}`,
        frequency: 1,
      }),
    );

    const plugin = await loadPlugin();
    const hooks = await plugin();
    const output = { text: "the response" };
    await hooks["experimental.text.complete"](undefined, output);

    assert.match(output.text, /\n\n> .* · _Sponsored: \+\$[^ ]+ USDC_$/, "no footer appended");
    // ESC sequence stripped, control-free, brackets swapped to fullwidth.
    assert.ok(!output.text.includes("\x1b"), "raw ESC byte leaked into output");
    assert.match(output.text, /Sponsored body with ［brackets］/);
    // Safe https CTA renders as a markdown link.
    assert.match(output.text, /\[Go now →\]\(https:\/\/example\.com\/x\)/);
    assert.match(output.text, /_Sponsored: \+\$0\.0025 USDC_/);

    assert.equal(impressions.length, 1, "expected exactly one impression report");
    assert.equal(impressions[0].ad_id, "ad-1");
    assert.equal(impressions[0].user_wallet, "0xabc");
    assert.equal(impressions[0].token, "tok-1");
  } finally {
    process.env.HOME = prevHome;
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("plugin: refuses to render an unsafe (non-https) CTA as a link", async () => {
  const { server, port } = await startAdServer({ cta_url: "javascript:alert(1)" });
  const home = mkdtempSync(join(tmpdir(), "latent-mimo-home-"));
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = home;
    mkdirSync(join(home, ".latent-protocol"), { recursive: true });
    writeFileSync(
      join(home, ".latent-protocol", "config.json"),
      JSON.stringify({ wallet: "0xabc", enabled: true, server: `http://127.0.0.1:${port}`, frequency: 1 }),
    );

    const plugin = await loadPlugin();
    const hooks = await plugin();
    const output = { text: "" };
    await hooks["experimental.text.complete"](undefined, output);

    assert.ok(!output.text.includes("javascript:"), "unsafe scheme leaked into the footer");
    assert.match(output.text, /Go now →(?!\()/, "expected a plain, non-linked CTA");
  } finally {
    process.env.HOME = prevHome;
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("plugin: no wallet configured → silent no-op, no network call", async () => {
  const { server, impressions } = await startAdServer();
  const home = mkdtempSync(join(tmpdir(), "latent-mimo-home-"));
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = home;
    delete process.env.ADS_WALLET;
    mkdirSync(join(home, ".latent-protocol"), { recursive: true });
    writeFileSync(join(home, ".latent-protocol", "config.json"), JSON.stringify({ enabled: true }));

    const plugin = await loadPlugin();
    const hooks = await plugin();
    const output = { text: "unchanged" };
    await hooks["experimental.text.complete"](undefined, output);

    assert.equal(output.text, "unchanged");
    assert.equal(impressions.length, 0);
  } finally {
    process.env.HOME = prevHome;
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("surface: install, status, and uninstall lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "latent-mimo-surface-"));
  const prevMimoHome = process.env.MIMO_HOME;
  try {
    process.env.MIMO_HOME = join(root, "mimocode");
    const mod = await import(`../dist/surfaces/mimo.js?${Math.random()}`);

    assert.equal(mod.mimoPluginPath(), join(root, "mimocode", "plugins", "latent-protocol.ts"));
    assert.match(mod.installMimo(), /MiMo plugin/);

    const pluginPath = mod.mimoPluginPath();
    assert.ok(existsSync(pluginPath), "plugin was not staged");
    const source = readFileSync(pluginPath, "utf8");
    assert.match(source, /experimental\.text\.complete/);
    assert.match(source, /\/ad\/impression/);
    assert.doesNotMatch(source, /\/ad\/click/, "click billing must stay out until S6 ships a click_token");
    assert.match(mod.mimoStatus(), /patched/);

    assert.match(mod.uninstallMimo(), /removed/);
    assert.ok(!existsSync(pluginPath), "plugin was not removed");
  } finally {
    if (prevMimoHome === undefined) delete process.env.MIMO_HOME;
    else process.env.MIMO_HOME = prevMimoHome;
    rmSync(root, { recursive: true, force: true });
  }
});
