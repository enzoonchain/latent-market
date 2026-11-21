/**
 * The published package ships bundled, dependency-free artifacts:
 *   dist/index.js           the CLI (`bin`)
 *   dist/claude/*.mjs        the runtime surfaces `init` stages
 *
 * A registry install runs these with no node_modules, so every import must be a
 * `node:` builtin. This test also runs the CLI to catch a broken bundle (e.g.
 * the double-shebang regression).
 *
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/bundle.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = (p) => fileURLToPath(new URL(`../dist/${p}`, import.meta.url));
const ARTIFACTS = ["index.js", "claude/statusline.mjs", "claude/hook.mjs"];

for (const rel of ARTIFACTS) {
  const path = dist(rel);
  if (!existsSync(path)) {
    console.error(`dist/${rel} missing — run \`npm --prefix cli run build\` first`);
    process.exit(1);
  }
}

test("artifacts import only node: builtins", () => {
  for (const rel of ARTIFACTS) {
    const src = readFileSync(dist(rel), "utf8");
    const imports = [...src.matchAll(/(?:^|\s)(?:import|export)[^;]*?from\s*"([^"]+)"/g)]
      .map((m) => m[1])
      .concat([...src.matchAll(/\brequire\("([^"]+)"\)/g)].map((m) => m[1]));
    const external = imports.filter((s) => !s.startsWith("node:"));
    assert.deepEqual(external, [], `dist/${rel} has unbundled imports: ${external}`);
  }
});

test("artifacts have exactly one shebang, on line 1", () => {
  for (const rel of ARTIFACTS) {
    const lines = readFileSync(dist(rel), "utf8").split("\n");
    assert.equal(lines[0], "#!/usr/bin/env node", `dist/${rel} line 1`);
    assert.ok(!lines.slice(1).some((l) => l.startsWith("#!")), `dist/${rel} has a second shebang`);
  }
});

test("the bundled CLI runs and says it is retired", () => {
  const out = execFileSync(process.execPath, [dist("index.js"), "help"], { encoding: "utf8" });
  assert.match(out, /latent-protocol is retired/);
  assert.match(out, /uninstall/);
});

test("init / prelaunch / activate patch nothing — they point at LatentCode", () => {
  const home = mkdtempSync(join(tmpdir(), "latent-bundle-"));
  for (const cmd of ["init", "prelaunch", "activate"]) {
    const r = spawnSync(process.execPath, [dist("index.js"), cmd, "--yes", "--wallet", "0x7331003C29a8Db67E141dD39964B205598b60bcf"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /retired/);
    assert.match(r.stdout, /latentcode/);
  }
  assert.ok(!existsSync(join(home, ".claude", "settings.json")), "init must not patch Claude Code");
  assert.ok(!existsSync(join(home, ".latent-protocol", "bin")), "init must not stage a runtime");
});

test("an installed hook / npx statusLine is a silent no-op", () => {
  const home = mkdtempSync(join(tmpdir(), "latent-bundle-"));
  for (const args of [["hook", "turn-start", "--agent", "claude-code"], ["statusline"]]) {
    const r = spawnSync(process.execPath, [dist("index.js"), ...args], {
      encoding: "utf8", input: "{}", env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
});
