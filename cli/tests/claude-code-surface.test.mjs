/**
 * The Claude Code surface must never put an `npx` invocation in settings.json.
 *
 * The status line re-runs its command every few seconds and the turn hooks run
 * on every prompt. When that command was `npx … latent-protocol …`, each
 * invocation re-resolved (and on a cold/corrupt cache, re-cloned and rebuilt)
 * the package — the concurrent runs thrashed the npm cache, hit the 10s hook
 * timeout, and left half-installed trees ("sh: latent: command not found").
 *
 * `init` now stages self-contained bundles into ~/.latent-protocol/bin/ and
 * points settings.json at `node "<bundle>"`. This test pins that down:
 *   - no `npx` anywhere in the written settings
 *   - the bundles are staged and are what the commands point at
 *   - install is idempotent and migrates the old `npx` commands
 *   - the staged bundles actually fetch an ad and render/bill one impression
 *
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/claude-code-surface.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
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
const BUNDLE_HOOK = new URL("../dist/claude/hook.mjs", import.meta.url);

if (!existsSync(BUNDLE_STATUSLINE) || !existsSync(BUNDLE_HOOK)) {
  console.error("dist/claude/*.mjs missing — run `npm --prefix cli run build` first");
  process.exit(1);
}

/** Spawn a node script, feed it `input` on stdin, collect stdio. Async so the
 *  in-process ad server keeps accepting connections while it runs. */
function runNode(script, args, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
        res.end(
          JSON.stringify({
            ad_id: "ad-1",
            title: "T",
            body: "sponsored body",
            cta_text: "Go",
            cta_url: "https://example.com/x",
            earn_amount: 0.005,
            impression_token: "tok-1",
          }),
        );
        return;
      }
      if (req.url === "/ad/impression") impressions.push(raw ? JSON.parse(raw) : {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, impressions, port: server.address().port }),
    );
  });
}

/** Fresh $HOME with a config pointing at `port`; returns the surface module. */
async function freshHome(port) {
  const home = mkdtempSync(join(tmpdir(), "latent-cc-"));
  process.env.HOME = home;
  delete process.env.ADS_SERVER;
  delete process.env.ADS_WALLET;
  delete process.env.ADS_ENABLED;
  mkdirSync(join(home, ".latent-protocol"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".latent-protocol", "config.json"),
    JSON.stringify({
      wallet: "0x1111111111111111111111111111111111111111",
      enabled: true,
      server: `http://127.0.0.1:${port}`,
      frequency: 1,
    }),
  );
  // Bust the ESM cache so each test gets the module fresh (paths resolve lazily
  // via homedir(), so this is mostly belt-and-braces).
  const mod = await import(`../dist/surfaces/claude-code.js?${Date.now()}`);
  return { home, mod };
}

const { readSettings } = await import("../dist/surfaces/json-settings.js");
const settingsOf = (home) =>
  readSettings(join(home, ".claude", "settings.json")).data;
const settingsRaw = (home) =>
  readFileSync(join(home, ".claude", "settings.json"), "utf8");

test("install writes node invocations, never npx", async () => {
  const { server, port } = await startAdServer();
  try {
    const { home, mod } = await freshHome(port);
    mod.installClaudeCode();

    const raw = settingsRaw(home);
    assert.ok(!/\bnpx\b/.test(raw), `settings.json contains npx:\n${raw}`);

    const s = settingsOf(home);
    const binSL = join(home, ".latent-protocol", "bin", "statusline.mjs");
    const binHook = join(home, ".latent-protocol", "bin", "hook.mjs");
    assert.ok(existsSync(binSL), "statusline.mjs not staged");
    assert.ok(existsSync(binHook), "hook.mjs not staged");
    assert.equal(s.statusLine.command, `node "${binSL}"`);
    assert.equal(s.statusLine.refreshInterval, 10);

    for (const [event, name] of [
      ["SessionStart", "session-start"],
      ["UserPromptSubmit", "turn-start"],
      ["Stop", "turn-end"],
      ["SessionEnd", "session-end"],
    ]) {
      assert.equal(
        s.hooks[event][0].hooks[0].command,
        `node "${binHook}" ${name} --agent claude-code`,
        `${event} hook command`,
      );
    }
  } finally {
    server.close();
  }
});

test("install refuses to overwrite an unparseable settings.json", async () => {
  const { server, port } = await startAdServer();
  try {
    const { home, mod } = await freshHome(port);
    const broken = '{\n  "model": "opus"\n  "theme": BROKEN\n';
    const p = join(home, ".claude", "settings.json");
    writeFileSync(p, broken);

    const msg = mod.installClaudeCode();
    assert.match(msg, /not valid JSON/);
    assert.equal(readFileSync(p, "utf8"), broken, "clobbered a broken settings.json");
    assert.ok(!existsSync(p + ".latent-protocol.bak"), "backed up a file we refused to touch");
  } finally {
    server.close();
  }
});

test("install preserves comments and sibling keys in settings.json", async () => {
  const { server, port } = await startAdServer();
  try {
    const { home, mod } = await freshHome(port);
    const src = '{\n  // my model choice\n  "model": "opus",\n  "env": { "FOO": "bar" }\n}\n';
    writeFileSync(join(home, ".claude", "settings.json"), src);
    mod.installClaudeCode();
    const raw = settingsRaw(home);
    assert.ok(raw.includes("// my model choice"), "comment dropped");
    assert.ok(raw.includes('"FOO": "bar"'), "sibling key mangled");
    const s = settingsOf(home);
    assert.equal(s.model, "opus");
    assert.ok(s.statusLine && s.hooks, "patch not applied");
  } finally {
    server.close();
  }
});

test("install is idempotent and migrates legacy npx commands", async () => {
  const { server, port } = await startAdServer();
  try {
    const { home, mod } = await freshHome(port);
    // Seed the state a broken older install would leave behind.
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify(
        {
          statusLine: {
            type: "command",
            command: "npx --yes github:enzoonchain/latent-protocol statusline",
            refreshInterval: 10,
          },
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "npx --yes github:enzoonchain/latent-protocol hook turn-end --agent claude-code",
                    timeout: 10,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    mod.installClaudeCode();
    mod.installClaudeCode(); // twice — must not duplicate

    const raw = settingsRaw(home);
    assert.ok(!/\bnpx\b/.test(raw), "legacy npx not migrated");
    const s = settingsOf(home);
    assert.equal(s.hooks.Stop.length, 1, "hook entry duplicated");
    assert.equal(s.hooks.UserPromptSubmit.length, 1);
    assert.match(s.hooks.Stop[0].hooks[0].command, /hook\.mjs" turn-end --agent claude-code$/);
  } finally {
    server.close();
  }
});

test("uninstall reverts to the pristine pre-install settings byte-exact", async () => {
  const { server, port } = await startAdServer();
  try {
    const { home, mod } = await freshHome(port);
    const pristine = '{\n  // my settings\n  "model": "opus",\n  "theme": "dark"\n}\n';
    writeFileSync(join(home, ".claude", "settings.json"), pristine);

    mod.installClaudeCode();
    const patched = settingsRaw(home);
    assert.ok(patched.includes("statusline.mjs"), "install did not patch");
    assert.ok(existsSync(join(home, ".claude", "settings.json.latent-protocol.bak")), "no backup written");

    mod.uninstallClaudeCode();
    assert.equal(settingsRaw(home), pristine, "uninstall did not restore byte-exact");
    assert.ok(
      !existsSync(join(home, ".claude", "settings.json.latent-protocol.bak")),
      "backup not consumed",
    );
  } finally {
    server.close();
  }
});

test("uninstall deletes settings.json when install created it", async () => {
  const { server, port } = await startAdServer();
  try {
    const { home, mod } = await freshHome(port);
    // freshHome does not create settings.json.
    assert.ok(!existsSync(join(home, ".claude", "settings.json")));
    mod.installClaudeCode();
    assert.ok(existsSync(join(home, ".claude", "settings.json")));
    mod.uninstallClaudeCode();
    assert.ok(
      !existsSync(join(home, ".claude", "settings.json")),
      "settings.json survived uninstall though install created it",
    );
  } finally {
    server.close();
  }
});

test("staged bundles fetch an ad and bill exactly one impression", async () => {
  const { server, impressions, port } = await startAdServer();
  try {
    const { home, mod } = await freshHome(port);
    mod.installClaudeCode();
    const binHook = join(home, ".latent-protocol", "bin", "hook.mjs");
    const binSL = join(home, ".latent-protocol", "bin", "statusline.mjs");
    const session = JSON.stringify({ session_id: "sess-A" });

    const hook = await runNode(
      binHook,
      ["turn-start", "--agent", "claude-code"],
      JSON.stringify({ session_id: "sess-A", prompt: "fix a failing rust build" }),
    );
    assert.equal(hook.code, 0, `hook exited ${hook.code}: ${hook.err}`);
    assert.ok(
      existsSync(join(home, ".latent-protocol", "statusline_cache.json")),
      "hook did not prefetch into the status line cache",
    );

    // Billing is deferred until real on-screen dwell time accrues (see
    // statusline.ts): the first invocation only starts the dwell clock —
    // the turn hook's prefetch above never counts as "shown" on its own.
    const a = await runNode(binSL, [], session);
    assert.equal(impressions.length, 0, "billed before any real dwell time accrued");

    // Simulate real elapsed time (> MIN_DISPLAY_MS_BEFORE_BILL) without a
    // real sleep, mirroring cli/tests/impression-ownership.test.mjs.
    const cachePath = join(home, ".latent-protocol", "statusline_cache.json");
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    cached.shown_at_ms -= 4000;
    writeFileSync(cachePath, JSON.stringify(cached));

    const b = await runNode(binSL, [], session);
    assert.ok(a.out.includes("sponsored body"), `status line did not render: ${JSON.stringify(a.out)}`);
    assert.equal(a.out, b.out, "status line changed ad mid-rotation");
    assert.equal(
      impressions.length,
      1,
      `one displayed ad must bill once, got ${impressions.length}`,
    );
    assert.ok(impressions[0].displayed_ms >= 4000, "billed without real dwell time");
  } finally {
    server.close();
  }
});

const configOf = (home) =>
  JSON.parse(readFileSync(join(home, ".latent-protocol", "config.json"), "utf8"));

test("install seeds spinnerVerbs + records support; false removes/skips it", async () => {
  const { server, port } = await startAdServer();
  try {
    const { home, mod } = await freshHome(port);
    mod.installClaudeCode({ spinnerVerbs: true });
    let s = settingsOf(home);
    assert.equal(s.spinnerVerbs.mode, "replace");
    assert.match(s.spinnerVerbs.verbs[0], /^✦ /);
    assert.equal(configOf(home).spinner_verbs, true);

    // Re-run with support=false: our seeded entry is evicted, config flips.
    mod.installClaudeCode({ spinnerVerbs: false });
    s = settingsOf(home);
    assert.equal("spinnerVerbs" in s, false, "stale spinnerVerbs not evicted");
    assert.equal(configOf(home).spinner_verbs, false);
  } finally {
    server.close();
  }
});

test("install never overwrites a user-set spinnerVerbs", async () => {
  const { server, port } = await startAdServer();
  try {
    const { home, mod } = await freshHome(port);
    writeFileSync(
      join(home, ".claude", "settings.json"),
      '{\n  "spinnerVerbs": { "mode": "append", "verbs": ["Mine"] }\n}\n',
    );
    mod.installClaudeCode({ spinnerVerbs: true });
    const s = settingsOf(home);
    assert.deepEqual(s.spinnerVerbs.verbs, ["Mine"]);
    assert.equal(configOf(home).spinner_verbs, false, "must not drive the hook onto a user value");
  } finally {
    server.close();
  }
});

test("turn-start hook syncs spinnerVerbs with the live ad when enabled", async () => {
  const { server, port } = await startAdServer();
  try {
    const { home, mod } = await freshHome(port);
    mod.installClaudeCode({ spinnerVerbs: true });
    const settingsPath = join(home, ".claude", "settings.json");
    const binHook = join(home, ".latent-protocol", "bin", "hook.mjs");

    await runNode(binHook, ["turn-start", "--agent", "claude-code"],
      JSON.stringify({ session_id: "s1", prompt: "build a react ui" }));

    const s = readSettings(settingsPath).data;
    assert.match(s.spinnerVerbs.verbs[0], /sponsored body/i);
    // statusLine + hooks still intact, still no npx.
    assert.ok(!/\bnpx\b/.test(readFileSync(settingsPath, "utf8")));
    assert.ok(s.statusLine && s.hooks.Stop);
  } finally {
    server.close();
  }
});

test("hook leaves spinnerVerbs alone when config.spinner_verbs is not true", async () => {
  const { server, port } = await startAdServer();
  try {
    const { home, mod } = await freshHome(port);
    mod.installClaudeCode({ spinnerVerbs: false });
    const binHook = join(home, ".latent-protocol", "bin", "hook.mjs");
    await runNode(binHook, ["turn-start", "--agent", "claude-code"],
      JSON.stringify({ session_id: "s1", prompt: "build a react ui" }));
    const s = settingsOf(home);
    assert.equal("spinnerVerbs" in s, false, "hook wrote spinnerVerbs though support=false");
  } finally {
    server.close();
  }
});
