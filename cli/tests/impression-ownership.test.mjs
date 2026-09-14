/**
 * One displayed ad must produce exactly one billed impression.
 *
 * Claude Code runs two of our surfaces at once — the status line and the turn
 * hooks — over a shared cache file. Both used to report impressions, so a
 * single turn charged the advertiser several times over and the ad the hook
 * billed for was often never the one on screen. This test pins the rule down:
 * the status line owns the impression, the hook prefetches and stays silent,
 * and both report the same agent identifier.
 *
 * Run after `npm --prefix cli run build`:
 *   node cli/tests/impression-ownership.test.mjs
 */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";

const WALLET = "0x1111111111111111111111111111111111111111";

/** Minimal ad server that records what the adapters send it. */
function startServer() {
  const requests = [];
  const impressions = [];
  let served = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/ad/request") {
        served++;
        requests.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ad_id: `ad-${served}`,
            title: "T",
            body: `body #${served}`,
            cta_text: "Learn more",
            cta_url: "https://example.com/x",
            earn_amount: 0.0025,
            impression_token: `tok-${served}`,
          }),
        );
        return;
      }
      if (req.url === "/ad/impression") impressions.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, requests, impressions, port: server.address().port }),
    );
  });
}

const home = mkdtempSync(join(tmpdir(), "latent-impression-"));
const { server, requests, impressions, port } = await startServer();

try {
  process.env.HOME = home;
  delete process.env.ADS_SERVER;
  delete process.env.ADS_WALLET;
  delete process.env.ADS_ENABLED;

  mkdirSync(join(home, ".latent-protocol"), { recursive: true });
  writeFileSync(
    join(home, ".latent-protocol", "config.json"),
    JSON.stringify({
      wallet: WALLET,
      enabled: true,
      server: `http://127.0.0.1:${port}`,
      frequency: 1,
    }),
  );

  const { runHook } = await import("../dist/hook.js");
  const { render } = await import("../dist/statusline.js");

  const session = { session_id: "sess-A" };
  const cachePath = join(home, ".latent-protocol", "statusline_cache.json");

  /** Rewind the cached ad's dwell-time baseline so the next render() sees
   *  enough elapsed time to bill, without a real sleep. */
  function ageShownAt(ms) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    cached.shown_at_ms -= ms;
    writeFileSync(cachePath, JSON.stringify(cached));
  }

  // ── Case A: the prefetched ad is what the user sees ──────────────────────
  //
  // The hook prefetches at turn-start, the status line renders that ad across
  // several refreshes inside the rotation window, then the turn ends. Three
  // refreshes of one ad are still one impression — billed once real dwell
  // time (not just repeated polls) has accrued, per the deferred-billing
  // design in statusline.ts.
  await runHook("turn-start", "claude-code", {
    ...session,
    prompt: "fix a failing rust build",
  });

  // First render establishes the dwell-time baseline (turn hook prefetched
  // it, but that alone never counts as "shown") — no bill yet.
  const first = await render(session);
  assert.equal(impressions.length, 0, "billed before any real dwell time accrued");

  // Simulate 4s of real on-screen time (> MIN_DISPLAY_MS_BEFORE_BILL).
  ageShownAt(4000);
  const second = await render(session);

  // A third poll, still within the rotation window, must not double-bill.
  const third = await render(session);

  await runHook("turn-end", "claude-code", session);

  assert.ok(first, "status line rendered nothing on the prefetched ad");
  assert.equal(first, second, "status line changed ad mid-rotation");
  assert.equal(second, third, "status line changed ad mid-rotation");

  assert.equal(
    impressions.length,
    1,
    `three refreshes of one ad must bill once, got ${impressions.length}: ` +
      JSON.stringify(impressions.map((i) => i.ad_id)),
  );
  assert.equal(impressions[0].ad_id, "ad-1", "billed an ad that was never displayed");
  assert.ok(impressions[0].displayed_ms >= 4000, "billed without real dwell time");
  assert.ok(first.includes("body #1"), "displayed an ad other than the billed one");

  // ── Case B: the prefetched ad goes stale before anything renders ─────────
  //
  // This is the case that used to leak money. The hook prefetches, the status
  // line does not run until the rotation window has passed, so it discards the
  // prefetch and fetches its own ad. Only that second ad ever reaches the
  // screen — but the hook still held the first one in its state and billed for
  // it at turn-end, charging the advertiser for an impression nobody saw.
  //
  // Under deferred billing this is doubly guarded: the stale prefetch never
  // got a shown_at_ms (nothing ever rendered it), so the flush-on-rotation
  // path in statusline.ts must skip it even though it's unbilled.
  impressions.length = 0;
  requests.length = 0;

  await runHook("turn-start", "claude-code", {
    ...session,
    prompt: "explain this postgres query plan",
  });

  // Age the cached prefetch past the rotation window instead of sleeping, so
  // the test stays deterministic and fast.
  const cached = JSON.parse(readFileSync(cachePath, "utf8"));
  cached.fetched_at -= 3600;
  writeFileSync(cachePath, JSON.stringify(cached));

  // First render after the prefetch went stale: discards it (never billed —
  // it was never shown), fetches its own ad-2, caches it un-billed.
  const displayed = await render(session);
  assert.equal(
    impressions.length,
    0,
    "billed the stale prefetch, or billed the new ad before any dwell time",
  );

  ageShownAt(4000);
  await render(session);
  await runHook("turn-end", "claude-code", session);

  assert.ok(displayed, "status line rendered nothing after the prefetch went stale");
  assert.equal(
    impressions.length,
    1,
    `only the displayed ad may be billed, got ${impressions.length}: ` +
      JSON.stringify(impressions.map((i) => i.ad_id)),
  );

  const billedId = impressions[0].ad_id;
  assert.ok(
    displayed.includes(`body #${billedId.split("-")[1]}`),
    `billed ${billedId}, which is not the ad on screen: ${JSON.stringify(displayed)}`,
  );

  // ── Both surfaces must report the same agent identifier ──────────────────
  const agents = new Set(requests.map((r) => r.agent));
  assert.deepEqual(
    [...agents],
    ["claude-code"],
    `surfaces disagree on the agent identifier: ${[...agents].join(", ")}`,
  );

  console.log("ok - only the displayed ad is billed, exactly once, under one agent identifier");
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
}
