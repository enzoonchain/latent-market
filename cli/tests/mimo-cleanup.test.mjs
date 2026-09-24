/**
 * MiMo Code — removal only. Older releases installed a plugin that appended
 * the ad to the model's response; `init` must never install it and must
 * remove a copy left behind, without touching a plugin that is not ours.
 *
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/mimo-cleanup.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = (...p) => join(dirname(fileURLToPath(import.meta.url)), "..", "dist", ...p);
const WALLET = "0x7331003C29a8Db67E141dD39964B205598b60bcf";

function init(home) {
  const env = { ...process.env, HOME: home };
  delete env.MIMO_HOME;
  return execFileSync(process.execPath, [dist("index.js"), "init", "--yes", "--wallet", WALLET], {
    encoding: "utf8",
    env,
  });
}

test("init removes an older release's MiMo plugin and installs nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "latent-mimo-"));
  const plugins = join(home, ".config", "mimocode", "plugins");
  mkdirSync(plugins, { recursive: true });
  const ours = join(plugins, "latent-protocol.ts");
  writeFileSync(ours, "// LATENT_PROTOCOL_MIMO_PLUGIN\nexport default async () => ({});\n");

  init(home);
  assert.ok(!existsSync(ours), "legacy MiMo plugin survived init");
  init(home);
  assert.ok(!existsSync(ours), "init re-installed the MiMo plugin");
});

test("a same-named plugin without our marker is left alone", () => {
  const home = mkdtempSync(join(tmpdir(), "latent-mimo-foreign-"));
  const plugins = join(home, ".config", "mimocode", "plugins");
  mkdirSync(plugins, { recursive: true });
  const foreign = join(plugins, "latent-protocol.ts");
  writeFileSync(foreign, "export default async () => ({});\n");

  init(home);
  assert.equal(readFileSync(foreign, "utf8"), "export default async () => ({});\n");
});
