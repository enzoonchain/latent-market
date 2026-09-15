/**
 * Grok Build surface: patch `[ui.status_line]` in config.toml, never npx,
 * never clobber a user-owned row, restore from backup.
 *
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/grok-surface.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE_STATUSLINE = new URL("../dist/claude/statusline.mjs", import.meta.url);
if (!existsSync(BUNDLE_STATUSLINE)) {
  console.error("dist/claude/statusline.mjs missing — run `npm --prefix cli run build` first");
  process.exit(1);
}

async function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "latent-grok-"));
  process.env.HOME = home;
  delete process.env.GROK_HOME;
  delete process.env.ADS_SERVER;
  mkdirSync(join(home, ".latent-protocol"), { recursive: true });
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(
    join(home, ".grok", "config.toml"),
    [
      "[cli]",
      'installer = "internal"',
      "",
      "[ui]",
      "yolo = false",
      "permission_mode = \"always-approve\"",
      "",
      "[privacy]",
      'privacy_banner_acked = "2026-09-15T17:56:40Z"',
      "",
    ].join("\n"),
  );
  writeFileSync(join(home, ".grok", "version.json"), '{"version":"1.0.30"}\n');
  const mod = await import(`../dist/surfaces/grok.js?${Date.now()}`);
  return { home, mod };
}

const cfgOf = (home) => readFileSync(join(home, ".grok", "config.toml"), "utf8");

test("install writes a command row, never npx, preserves sibling tables", async () => {
  const { home, mod } = await freshHome();
  const msg = mod.installGrok();
  assert.match(msg, /Grok Build status line/);
  const raw = cfgOf(home);
  assert.ok(!/\bnpx\b/.test(raw), `config.toml contains npx:\n${raw}`);
  assert.match(raw, /\[ui\.status_line\]/);
  assert.match(raw, /type = "command"/);
  assert.match(raw, /LATENT_AGENT=grok/);
  assert.match(raw, /refresh_interval = 10/);
  const binSL = join(home, ".latent-protocol", "bin", "statusline.mjs");
  assert.ok(existsSync(binSL), "statusline.mjs not staged");
  assert.ok(raw.includes(binSL), "command does not point at staged bundle");
  assert.match(raw, /\[cli\]/);
  assert.match(raw, /yolo = false/);
  assert.match(raw, /permission_mode = "always-approve"/);
  assert.match(raw, /\[privacy\]/);
});

test("install is idempotent and does not duplicate the table", async () => {
  const { home, mod } = await freshHome();
  mod.installGrok();
  mod.installGrok();
  const raw = cfgOf(home);
  const n = raw.split("[ui.status_line]").length - 1;
  assert.equal(n, 1, `expected one table, found ${n}:\n${raw}`);
});

test("install refuses to overwrite a user-owned status line", async () => {
  const { home, mod } = await freshHome();
  const p = join(home, ".grok", "config.toml");
  writeFileSync(
    p,
    readFileSync(p, "utf8") +
      "\n[ui.status_line]\ntype = \"builtin\"\nitems = [\"cwd\", \"model\"]\n",
  );
  const before = readFileSync(p, "utf8");
  const msg = mod.installGrok();
  assert.match(msg, /already has \[ui.status_line\]/);
  assert.equal(readFileSync(p, "utf8"), before);
});

test("uninstall restores the pristine backup", async () => {
  const { home, mod } = await freshHome();
  const before = cfgOf(home);
  mod.installGrok();
  assert.notEqual(cfgOf(home), before);
  const msg = mod.uninstallGrok();
  assert.match(msg, /Restored/);
  assert.equal(cfgOf(home), before);
});

test("uninstall without backup strips only our table", async () => {
  const { home, mod } = await freshHome();
  mod.installGrok();
  const bak = join(home, ".grok", "config.toml.latent-protocol.bak");
  assert.ok(existsSync(bak));
  // Simulate a consumed / missing backup: uninstall should still strip our table.
  const { rmSync } = await import("node:fs");
  rmSync(bak);
  const msg = mod.uninstallGrok();
  assert.match(msg, /Removed Latent/);
  const raw = cfgOf(home);
  assert.ok(!raw.includes("[ui.status_line]"), raw);
  assert.match(raw, /\[ui\]/);
  assert.match(raw, /yolo = false/);
});

test("skip when Grok is not detected", async () => {
  const home = mkdtempSync(join(tmpdir(), "latent-nogrok-"));
  process.env.HOME = home;
  delete process.env.GROK_HOME;
  const mod = await import(`../dist/surfaces/grok.js?${Date.now()}`);
  assert.equal(mod.grokDetected(), false);
  assert.match(mod.installGrok(), /not detected/);
});

test("toml upsert / remove preserve surrounding text", async () => {
  const { upsertTable, removeTable, parseTableValues, findTable } = await import(
    `../dist/surfaces/toml-table.js?${Date.now()}`
  );
  const src = "# keep me\n[ui]\nyolo = true\n\n[privacy]\nx = 1\n";
  const next = upsertTable(src, "ui.status_line", {
    type: "command",
    command: 'node "/tmp/s.mjs"',
    refresh_interval: 10,
  });
  assert.match(next, /# keep me/);
  assert.match(next, /\[ui\]\nyolo = true/);
  assert.match(next, /\[privacy\]/);
  const vals = parseTableValues(findTable(next, "ui.status_line").body);
  assert.equal(vals.type, "command");
  assert.equal(vals.command, 'node "/tmp/s.mjs"');
  const gone = removeTable(next, "ui.status_line");
  assert.ok(!gone.includes("[ui.status_line]"));
  assert.match(gone, /# keep me/);
  assert.match(gone, /\[privacy\]/);
});
