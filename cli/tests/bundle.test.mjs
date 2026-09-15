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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
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

test("the bundled CLI runs", () => {
  const out = execFileSync(process.execPath, [dist("index.js"), "help"], { encoding: "utf8" });
  assert.match(out, /latent-protocol/);
  assert.match(out, /init/);
});

test("the bundled CLI binds --wallet without hitting the network (viem still inlined for --generate)", () => {
  const home = mkdtempSync(join(tmpdir(), "latent-bundle-"));
  const wallet = "0x7331003C29a8Db67E141dD39964B205598b60bcf";
  const out = execFileSync(
    process.execPath,
    [dist("index.js"), "prelaunch", "--wallet", wallet, "--skip-register", "--yes"],
    { encoding: "utf8", env: { ...process.env, HOME: home } },
  );
  assert.match(out, /0x7331003C29a8Db67E141dD39964B205598b60bcf/, "no wallet address in prelaunch output");
});

test("the bundled CLI's `init` stages the runtime — asset paths survive bundling", () => {
  // Regression: `new URL("../claude/…", import.meta.url)` resolved from
  // dist/surfaces/x.js but pointed one level too high once x.js was inlined
  // into dist/index.js, so a real `npx …/init` reported "runtime bundle
  // missing" and patched nothing.
  const home = mkdtempSync(join(tmpdir(), "latent-init-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });

  const out = execFileSync(
    process.execPath,
    [dist("index.js"), "init", "--yes", "--wallet", "0x7331003C29a8Db67E141dD39964B205598b60bcf"],
    { encoding: "utf8", env: { ...process.env, HOME: home } },
  );
  assert.doesNotMatch(out, /runtime bundle missing/, out);

  for (const f of ["statusline.mjs", "hook.mjs", "codex-hook.mjs"]) {
    assert.ok(existsSync(join(home, ".latent-protocol", "bin", f)), `${f} not staged`);
  }
  const settings = readFileSync(join(home, ".claude", "settings.json"), "utf8");
  assert.ok(!/\bnpx\b/.test(settings), "npx in settings.json");
  assert.match(settings, /hook\.mjs\\" turn-start --agent claude-code/);
  const codex = readFileSync(join(home, ".codex", "hooks.json"), "utf8");
  assert.ok(!/\bnpx\b/.test(codex), "npx in codex hooks.json");
});
