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

test("the bundled CLI runs", () => {
  const out = execFileSync(process.execPath, [dist("index.js"), "help"], { encoding: "utf8" });
  assert.match(out, /latent-protocol/);
  assert.match(out, /init/);
});

test("the bundled CLI binds --wallet without hitting the network", () => {
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

  const out = execFileSync(
    process.execPath,
    [dist("index.js"), "init", "--yes", "--wallet", "0x7331003C29a8Db67E141dD39964B205598b60bcf"],
    { encoding: "utf8", env: { ...process.env, HOME: home } },
  );
  assert.doesNotMatch(out, /runtime bundle missing/, out);

  for (const f of ["statusline.mjs", "hook.mjs"]) {
    assert.ok(existsSync(join(home, ".latent-protocol", "bin", f)), `${f} not staged`);
  }
  const settings = readFileSync(join(home, ".claude", "settings.json"), "utf8");
  assert.ok(!/\bnpx\b/.test(settings), "npx in settings.json");
  assert.match(settings, /hook\.mjs\\" turn-start --agent claude-code/);
});

test("`init` on closed stdin fails loudly instead of exiting 0 with no wallet", () => {
  const home = mkdtempSync(join(tmpdir(), "latent-eof-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), "{}");

  let status = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, [dist("index.js"), "init"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
      input: "",
    });
  } catch (err) {
    status = err.status;
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }

  assert.notEqual(status, 0, `expected a non-zero exit, got ${status}:\n${output}`);
  assert.match(output, /stdin closed before answering/);
  assert.equal(existsSync(join(home, ".latent-protocol", "config.json")), false);
});

test("the bundled CLI rejects the removed --generate flag instead of minting a key", () => {
  const home = mkdtempSync(join(tmpdir(), "latent-bundle-"));
  const res = spawnSync(process.execPath, [dist("index.js"), "init", "--generate", "--yes"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--generate was removed/);
  assert.doesNotMatch(res.stdout + res.stderr, /Private key/i);
});

test("piped answers all reach init — none dropped between prompts", () => {
  // Regression: rl.question() dropped a line that arrived before its prompt,
  // so `printf 'y\n3\n0x…\n' | init` answered the first question and hung.
  const home = mkdtempSync(join(tmpdir(), "latent-pipe-"));
  mkdirSync(join(home, ".latent-protocol"), { recursive: true });
  writeFileSync(
    join(home, ".latent-protocol", "config.json"),
    JSON.stringify({ wallet: "0x1111111111111111111111111111111111111111" }),
  );
  const wallet = "0x7331003C29a8Db67E141dD39964B205598b60bcf";
  const res = spawnSync(
    process.execPath,
    [dist("index.js"), "prelaunch", "--skip-register"],
    {
      encoding: "utf8",
      input: `y\n3\n${wallet}\n`,
      env: { ...process.env, HOME: home, LATENT_NO_BROWSER: "1" },
      timeout: 20000,
    },
  );
  assert.equal(res.status, 0, res.stderr);
  const cfg = JSON.parse(readFileSync(join(home, ".latent-protocol", "config.json"), "utf8"));
  assert.equal(cfg.wallet, wallet);
});
