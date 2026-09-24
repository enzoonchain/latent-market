/**
 * Codex — removal only. Older releases wrote turn hooks into
 * ~/.codex/hooks.json whose UserPromptSubmit returned the ad as model context;
 * we no longer ship that. These tests pin the cleanup:
 *   - `init` never writes Codex hooks, and strips ones an older release left
 *   - uninstall keeps the user's own hooks and restores the pristine backup
 *   - the hook runtime ignores `--agent codex`: no output, no ad request
 *
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/codex-hooks.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { readSettings } = await import("../dist/surfaces/json-settings.js");
const dist = (...p) => join(dirname(fileURLToPath(import.meta.url)), "..", "dist", ...p);

/** Fresh sandbox: $HOME + CODEX_HOME under a tmp dir. */
async function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "latent-codex-"));
  process.env.HOME = home;
  const mod = await import(`../dist/surfaces/codex.js?${Math.random()}`);
  for (const a of mod.CODEX_AGENTS) {
    process.env[a.homeEnv] = join(home, a.homeRel);
    mkdirSync(process.env[a.homeEnv], { recursive: true });
  }
  return { home, mod };
}

const hooksFile = (home, rel) => join(home, rel, "hooks.json");

/** What an older release wrote: our four events, staged local bundle. */
function legacyHooks(home, extra = {}) {
  const cmd = (ev) => `node "${join(home, ".latent-protocol", "bin", "codex-hook.mjs")}" ${ev} --agent codex`;
  const group = (ev) => ({ hooks: [{ type: "command", command: cmd(ev), timeout: 10 }] });
  return {
    hooks: {
      SessionStart: [group("session-start")],
      UserPromptSubmit: [group("turn-start")],
      Stop: [group("turn-end"), ...(extra.Stop ?? [])],
      SessionEnd: [group("session-end")],
    },
  };
}

test("uninstall strips our hooks (incl. legacy npx) and keeps the user's", async () => {
  const { home, mod } = await sandbox();
  const a = mod.CODEX_AGENTS[0];
  const p = hooksFile(home, a.homeRel);
  const user = { hooks: [{ type: "command", command: "echo user-hook" }] };
  const legacy = legacyHooks(home, { Stop: [user] });
  legacy.hooks.Stop.push({
    hooks: [{ type: "command", command: "npx --yes latent-protocol hook turn-end --agent codex" }],
  });
  writeFileSync(p, JSON.stringify(legacy, null, 2));
  assert.equal(mod.codexLegacyInstalled(), true);

  assert.match(mod.uninstallCodexAgent(a), /removed Latent turn hooks/);
  const raw = readFileSync(p, "utf8");
  assert.ok(!raw.includes("latent"), raw);
  assert.deepEqual(readSettings(p).data.hooks, { Stop: [user] });
  assert.equal(mod.codexLegacyInstalled(), false);
});

test("uninstall restores from the pristine backup and removes the staged runtime", async () => {
  const { home, mod } = await sandbox();
  const a = mod.CODEX_AGENTS[0];
  const p = hooksFile(home, a.homeRel);
  const pristine = '{\n  "hooks": {\n    "Stop": [ { "hooks": [ { "type": "command", "command": "mine" } ] } ]\n  }\n}\n';
  writeFileSync(p + ".latent-protocol.bak", pristine);
  writeFileSync(p, JSON.stringify(legacyHooks(home)));
  const staged = join(home, ".latent-protocol", "bin", "codex-hook.mjs");
  mkdirSync(dirname(staged), { recursive: true });
  writeFileSync(staged, "// old runtime");

  mod.uninstallCodexAgent(a);
  assert.equal(readFileSync(p, "utf8"), pristine, "not byte-exact");
  assert.ok(!existsSync(p + ".latent-protocol.bak"));
  assert.ok(!existsSync(staged), "staged runtime not removed");
});

test("uninstall leaves an unparseable hooks.json alone", async () => {
  const { home, mod } = await sandbox();
  const p = hooksFile(home, mod.CODEX_AGENTS[0].homeRel);
  writeFileSync(p, "{ broken");
  assert.match(mod.uninstallCodexAgent(mod.CODEX_AGENTS[0]), /not valid JSON/);
  assert.equal(readFileSync(p, "utf8"), "{ broken");
});

test("`init` writes no Codex hooks and strips an older release's", () => {
  const home = mkdtempSync(join(tmpdir(), "latent-codex-init-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  const p = join(home, ".codex", "hooks.json");
  writeFileSync(p, JSON.stringify(legacyHooks(home)));

  const env = { ...process.env, HOME: home };
  delete env.CODEX_HOME;
  execFileSync(
    process.execPath,
    [dist("index.js"), "init", "--yes", "--wallet", "0x7331003C29a8Db67E141dD39964B205598b60bcf"],
    { encoding: "utf8", env },
  );
  assert.ok(!readFileSync(p, "utf8").includes("latent"), "legacy Codex hooks survived init");
  assert.ok(!existsSync(join(home, ".latent-protocol", "bin", "codex-hook.mjs")));
});

test("the hook runtime ignores --agent codex: no output, no ad request", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ad_id: "ad-1", body: "codex sponsor body", impression_token: "t" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const home = mkdtempSync(join(tmpdir(), "latent-codex-run-"));
    mkdirSync(join(home, ".latent-protocol", "bin"), { recursive: true });
    writeFileSync(
      join(home, ".latent-protocol", "config.json"),
      JSON.stringify({ wallet: "0xabc", enabled: true, server: `http://127.0.0.1:${server.address().port}` }),
    );
    // An older install's hooks.json still points at a staged copy of the runtime.
    const staged = join(home, ".latent-protocol", "bin", "codex-hook.mjs");
    copyFileSync(dist("claude", "hook.mjs"), staged);

    for (const ev of ["session-start", "turn-start", "turn-end", "session-end"]) {
      const r = await new Promise((resolve) => {
        const child = spawn(process.execPath, [staged, ev, "--agent", "codex"], {
          env: { ...process.env, HOME: home },
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("close", (code) => resolve({ code, out }));
        child.stdin.end(JSON.stringify({ prompt: "write a python etl job" }));
      });
      assert.equal(r.code, 0);
      assert.equal(r.out, "", `${ev} wrote to stdout: ${r.out}`);
    }
    assert.equal(requests, 0, "the runtime talked to the ad server for Codex");
  } finally {
    server.close();
  }
});
