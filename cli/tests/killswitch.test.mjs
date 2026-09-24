/**
 * The killswitch (remote off-switch) and incident guard (local circuit
 * breaker). Both fail-safe, both cached in ~/.latent-protocol/health.json.
 *
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/killswitch.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ks = await import("../dist/killswitch.js");
const { requestAd } = await import("../dist/api.js");

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "latent-ks-"));
  process.env.HOME = home;
  delete process.env.ADS_SERVER;
  mkdirSync(join(home, ".latent-protocol"), { recursive: true });
  return join(home, ".latent-protocol", "health.json");
}
const readHealth = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {});

/** Start an HTTP server; resolve {port, close} with a close that also drops
 *  keep-alive sockets so `node --test` exits promptly. */
function serve(handler) {
  const server = createServer(handler);
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({
        port: server.address().port,
        close: () => {
          server.closeAllConnections?.();
          server.close();
        },
      }),
    ),
  );
}

test("shouldServe: open by default", () => {
  freshHome();
  assert.equal(ks.shouldServe().ok, true);
});

test("incident guard trips after GUARD_TRIP_AFTER failures, resets on success", () => {
  const f = freshHome();
  const now = Date.now();
  for (let i = 0; i < ks.GUARD_TRIP_AFTER - 1; i++) ks.recordServerResult(false, now);
  assert.equal(ks.shouldServe(now).ok, true, "tripped too early");

  ks.recordServerResult(false, now);
  const d = ks.shouldServe(now + 1);
  assert.equal(d.ok, false);
  assert.equal(d.reason, "incident-backoff");
  assert.equal(readHealth(f).guardOpenUntil, now + ks.GUARD_COOLDOWN_MS);

  assert.equal(ks.shouldServe(now + ks.GUARD_COOLDOWN_MS - 1).ok, false);
  assert.equal(ks.shouldServe(now + ks.GUARD_COOLDOWN_MS + 1).ok, true);

  ks.recordServerResult(true, now + ks.GUARD_COOLDOWN_MS + 2);
  assert.equal(readHealth(f).consecutiveFailures, 0);
  assert.equal(readHealth(f).guardOpenUntil, undefined);
});

test("refreshKillswitch: 404 endpoint => not killed", async () => {
  const f = freshHome();
  const s = await serve((_r, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  try {
    await ks.refreshKillswitch(`http://127.0.0.1:${s.port}`);
    assert.equal(readHealth(f).killed, false);
    assert.equal(ks.shouldServe().ok, true);
  } finally {
    s.close();
  }
});

test("fail-safe: a 5xx killswitch check pauses serving (unreachable kind)", async () => {
  const f = freshHome();
  const s = await serve((_r, res) => {
    res.writeHead(503);
    res.end("nope");
  });
  try {
    await ks.refreshKillswitch(`http://127.0.0.1:${s.port}`);
    const h = readHealth(f);
    assert.equal(h.killed, true);
    assert.equal(h.killKind, "unreachable");
    assert.equal(ks.shouldServe().ok, false);
    // shorter grace than an explicit kill — self-heals after TTL + soft grace
    assert.equal(
      ks.shouldServe(h.killCheckedAt + ks.KILL_TTL_MS + ks.KILL_SOFT_GRACE_MS - 1).ok,
      false,
    );
    assert.equal(
      ks.shouldServe(h.killCheckedAt + ks.KILL_TTL_MS + ks.KILL_SOFT_GRACE_MS + 1).ok,
      true,
    );
  } finally {
    s.close();
  }
});

test("fail-safe: an unreachable server pauses serving, then a good check clears it", async () => {
  const f = freshHome();
  // No server listening at this port → connection refused.
  await ks.refreshKillswitch("http://127.0.0.1:9");
  assert.equal(readHealth(f).killed, true);
  assert.equal(readHealth(f).killKind, "unreachable");
  assert.equal(ks.shouldServe().ok, false);

  const s = await serve((_r, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ killed: false }));
  });
  try {
    // force past the TTL so the next check runs
    const h = readHealth(f);
    writeFileSync(f, JSON.stringify({ ...h, killCheckedAt: h.killCheckedAt - ks.KILL_TTL_MS - 1 }));
    await ks.refreshKillswitch(`http://127.0.0.1:${s.port}`);
    assert.equal(readHealth(f).killed, false);
    assert.equal(ks.shouldServe().ok, true);
  } finally {
    s.close();
  }
});

test("killed:true pauses every surface; requestAd never reaches the ad server", async () => {
  const f = freshHome();
  const now = Date.now();
  // Simulate a completed kill check "just now".
  writeFileSync(f, JSON.stringify({ killCheckedAt: now, killed: true, killReason: "maintenance" }));

  const d = ks.shouldServe(now + 1000);
  assert.equal(d.ok, false);
  assert.equal(d.reason, "killswitch");
  assert.match(ks.healthSummary(now + 1000), /killswitch: maintenance/);

  let hit = false;
  const ad = await serve((_r, res) => {
    hit = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  try {
    const result = await requestAd({
      wallet: "0x1",
      context: "general",
      agent: "claude-code",
      surface: "status_line",
      server: `http://127.0.0.1:${ad.port}`,
    });
    assert.equal(result, null);
    assert.equal(hit, false, "requestAd hit the ad server while killed");
  } finally {
    ad.close();
  }

  // Cached kill outlives its freshness window, then self-heals.
  assert.equal(ks.shouldServe(now + ks.KILL_TTL_MS + ks.KILL_STALE_GRACE_MS - 1).ok, false);
  assert.equal(ks.shouldServe(now + ks.KILL_TTL_MS + ks.KILL_STALE_GRACE_MS + 1).ok, true);
});

test("refreshKillswitch is rate-limited to once per TTL", async () => {
  freshHome();
  let calls = 0;
  const s = await serve((_r, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ killed: false }));
  });
  const base = `http://127.0.0.1:${s.port}`;
  const t0 = Date.now();
  try {
    await ks.refreshKillswitch(base, t0);
    await ks.refreshKillswitch(base, t0 + ks.KILL_TTL_MS - 1); // within TTL — skipped
    assert.equal(calls, 1);
    await ks.refreshKillswitch(base, t0 + ks.KILL_TTL_MS + 1); // past TTL — refetch
    assert.equal(calls, 2);
  } finally {
    s.close();
  }
});

test("requestAd circuit breaker: a run of 5xx trips it, a 204 no-fill does not", async () => {
  freshHome();
  let mode = "500";
  const s = await serve((_r, res) => {
    if (mode === "500") {
      res.writeHead(500);
      res.end("boom");
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  const base = `http://127.0.0.1:${s.port}`;
  const call = () =>
    requestAd({ wallet: "0x1", context: "general", agent: "claude-code", surface: "status_line", server: base });
  try {
    for (let i = 0; i < ks.GUARD_TRIP_AFTER; i++) await call();
    assert.equal(ks.shouldServe().ok, false, "5xx run did not trip the guard");

    ks.recordServerResult(true); // reopen
    mode = "204";
    for (let i = 0; i < ks.GUARD_TRIP_AFTER + 2; i++) await call();
    assert.equal(ks.shouldServe().ok, true, "204 no-fill wrongly tripped the guard");
  } finally {
    s.close();
  }
});
