/**
 * Codex turn hooks:
 *   - official Codex event names only (UserPromptSubmit / Stop, never TurnStart)
 *   - a LOCAL `node <bundle>` command, never `npx` (the command runs every turn)
 *   - hooks.json edits are parse-guarded, backed up, and migrate legacy npx
 *   - the staged bundle actually runs
 *
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/codex-hooks.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readSettings } = await import("../dist/surfaces/json-settings.js");

/** Fresh sandbox: $HOME + CODEX_HOME under a tmp dir. Returns the codex
 *  surface module (paths resolve lazily via env, so a fresh import per test
 *  keeps them isolated). */
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

function runNode(script, args, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.end(input);
  });
}

function startAdServer() {
  const impressions = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/ad/request") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ad_id: "ad-1", title: "T", body: "codex sponsor body", cta_text: "Go", cta_url: "https://example.com/x", earn_amount: 0.005, impression_token: "tok-1" }));
        return;
      }
      if (req.url === "/ad/impression") impressions.push(raw ? JSON.parse(raw) : {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, impressions, port: server.address().port })));
}

test("install writes official events as local node commands, never npx", async () => {
  const { home, mod } = await sandbox();
  for (const a of mod.CODEX_AGENTS) {
    const msg = mod.installCodexAgent(a);
    assert.match(msg, new RegExp(a.name));
    const raw = readFileSync(hooksFile(home, a.homeRel), "utf8");
    assert.ok(!/\bnpx\b/.test(raw), `${a.id}: npx in hooks.json`);
    const cfg = readSettings(hooksFile(home, a.homeRel)).data;

    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
      const cmd = cfg.hooks[ev][0].hooks[0].command;
      assert.match(cmd, /codex-hook\.mjs" \S+ --agent codex$/, `${a.id}: ${ev} command`);
      assert.ok(cmd.includes(`--agent ${a.id}`));
    }
    assert.equal(cfg.hooks.TurnStart, undefined, "TurnStart is not a real Codex event");
    assert.equal(cfg.hooks.TurnEnd, undefined);
    assert.ok(existsSync(join(home, ".latent-protocol", "bin", "codex-hook.mjs")), "hook not staged");
  }
});

test("install: parse-guard, backup, idempotent, legacy npx migration", async () => {
  const { home, mod } = await sandbox();
  const a = mod.CODEX_AGENTS[0];
  const p = hooksFile(home, a.homeRel);

  // unparseable → untouched
  writeFileSync(p, "{ broken");
  assert.match(mod.installCodexAgent(a), /not valid JSON/);
  assert.equal(readFileSync(p, "utf8"), "{ broken");
  assert.ok(!existsSync(p + ".latent-protocol.bak"));

  // legacy npx entry + a user's own hook → migrate ours, keep theirs
  writeFileSync(
    p,
    JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "npx --yes latent-protocol hook turn-end --agent codex", timeout: 10 }] },
          { hooks: [{ type: "command", command: "echo user-hook" }] },
        ],
      },
    }),
  );
  mod.installCodexAgent(a);
  mod.installCodexAgent(a); // idempotent
  const raw = readFileSync(p, "utf8");
  assert.ok(!/\bnpx\b/.test(raw), "legacy npx not migrated");
  const stop = readSettings(p).data.hooks.Stop;
  assert.equal(stop.length, 2, "expected user hook + one migrated ours");
  assert.ok(stop.some((e) => e.hooks[0].command === "echo user-hook"), "user hook dropped");
  assert.ok(existsSync(p + ".latent-protocol.bak"));
});

test("uninstall restores from the pristine backup", async () => {
  const { home, mod } = await sandbox();
  const a = mod.CODEX_AGENTS[0];
  const p = hooksFile(home, a.homeRel);
  const pristine = '{\n  "hooks": {\n    "Stop": [ { "hooks": [ { "type": "command", "command": "mine" } ] } ]\n  }\n}\n';
  writeFileSync(p, pristine);

  mod.installCodexAgent(a);
  assert.ok(readFileSync(p, "utf8").includes("codex-hook.mjs"));

  mod.uninstallCodexAgent(a);
  assert.equal(readFileSync(p, "utf8"), pristine, "not byte-exact");
  assert.ok(!existsSync(p + ".latent-protocol.bak"));
});

test("staged hook: cleaned up once the sole Codex-family agent uninstalls", async () => {
  const { home, mod } = await sandbox();
  const codex = mod.CODEX_AGENTS[0];
  mod.installCodexAgent(codex);
  const staged = join(home, ".latent-protocol", "bin", "codex-hook.mjs");
  assert.ok(existsSync(staged));

  mod.uninstallCodexAgent(codex);
  assert.ok(!existsSync(staged), "staged hook not cleaned after last agent");
});

test("the staged codex-hook bundle runs and surfaces a sponsor line", async () => {
  const { server, port } = await startAdServer();
  try {
    const { home, mod } = await sandbox();
    mkdirSync(join(home, ".latent-protocol"), { recursive: true });
    writeFileSync(
      join(home, ".latent-protocol", "config.json"),
      JSON.stringify({ wallet: "0xabc", enabled: true, server: `http://127.0.0.1:${port}`, frequency: 1 }),
    );
    mod.installCodexAgent(mod.CODEX_AGENTS[0]);
    const staged = join(home, ".latent-protocol", "bin", "codex-hook.mjs");

    const r = await runNode(staged, ["turn-start", "--agent", "codex"],
      JSON.stringify({ prompt: "write a python etl job" }));
    assert.equal(r.code, 0, r.err);
    // Codex gets the sponsor line through the hook's additionalContext.
    assert.match(r.out, /additionalContext/);
    assert.match(r.out, /codex sponsor body/);
  } finally {
    server.close();
  }
});
