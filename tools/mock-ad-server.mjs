#!/usr/bin/env node
/**
 * Mock ad server — develop and test adapters without a real ad server.
 *
 *   node tools/mock-ad-server.mjs
 *   ADS_SERVER=http://127.0.0.1:8899 npx latent-protocol status
 *
 * Implements protocol/openapi.yaml closely enough to exercise every path an
 * adapter must handle, including the ones that are easy to forget:
 *
 *   --no-fill=N     every Nth /ad/request returns 204 (default 4)
 *   --latency=MS    delay every response (test your timeout + fail-open)
 *   --fail=RATE     fraction of requests answered with 500 (0..1)
 *   --port=N        listen port (default 8899)
 *
 * It also enforces the two server-side rules adapters get wrong most often:
 * impression tokens are verified (bad token → 403) and replayed impressions
 * inside the window are skipped rather than billed. Watch the request log —
 * if one displayed ad produces more than one `billed` line, the adapter is
 * double-counting.
 */
import { createServer } from "node:http";
import { createHmac, randomUUID } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const PORT = Number(args.port ?? 8899);
const NO_FILL_EVERY = Number(args["no-fill"] ?? 4);
const LATENCY_MS = Number(args.latency ?? 0);
const FAIL_RATE = Number(args.fail ?? 0);
const SECRET = "mock-ad-server-secret";
const REPLAY_WINDOW_MS = 60_000;

const CREATIVES = [
  { title: "Foundry", body: "Fast Solidity testing. Fuzzing built in.", cta_text: "Try Foundry", cta_url: "https://example.com/foundry", tags: ["web3-crypto"] },
  { title: "Vector DB", body: "Embeddings search that stays under 10ms at scale.", cta_text: "Read the docs", cta_url: "https://example.com/vectordb", tags: ["data-science"] },
  { title: "Ship Faster", body: "Preview environments for every pull request.", cta_text: "Start free", cta_url: "https://example.com/ci", tags: ["devops"] },
];

const BID = 0.005;
const USER_SHARE = 0.5;

let requestCount = 0;
const impressions = new Map(); // `${ad_id}:${wallet}` → timestamp
const earnings = new Map();    // wallet → { balance, impressions, clicks }

const token = (adId, wallet) =>
  createHmac("sha256", SECRET).update(`${adId}:${wallet}`).digest("hex").slice(0, 32);

function log(kind, detail) {
  const stamp = new Date().toISOString().slice(11, 23);
  console.log(`${stamp}  ${kind.padEnd(18)} ${detail}`);
}

function account(wallet) {
  if (!earnings.has(wallet)) earnings.set(wallet, { balance: 0, impressions: 0, clicks: 0 });
  return earnings.get(wallet);
}

function send(res, status, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const finish = () => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(payload);
  };
  LATENCY_MS > 0 ? setTimeout(finish, LATENCY_MS) : finish();
}

const routes = {
  "GET /health": (_body, _url, res) => send(res, 200, { status: "ok" }),

  "GET /ad/top-bid": (_body, _url, res) => send(res, 200, { top_bid: BID }),

  // Block system (read-only). MOCK_TIER=0..3 sets the tier `latent status` shows.
  "GET /accounts/status": (_body, url, res) => {
    const tier = Number(process.env.MOCK_TIER ?? 1);
    const T = "000000000000000000";
    send(res, 200, {
      wallet: (url.searchParams.get("wallet") ?? "").toLowerCase(),
      linked: tier > 0,
      tier,
      twab_tokens: `${[0, 60000, 300000, 1500000][tier] ?? 0}${T}`,
      tier_thresholds: [`50000${T}`, `250000${T}`, `1000000${T}`],
      boost_bps: [0, 1000, 2000, 5000][tier] ?? 0,
      boost_daily_cap: [0, 50, 100, 200][tier] ?? 0,
      effective_scale_bps: 10000,
      effective_boost_bps: [0, 1000, 2000, 5000][tier] ?? 0,
    });
  },

  "GET /spotlight": (_body, _url, res) => send(res, 200, { day: 0, entries: [] }),

  "GET /blocks/market": (_body, _url, res) =>
    send(res, 200, {
      day: 0,
      surfaces: {
        ambient: { mint_blocks: 80, sold_blocks: 12, available_blocks: 68, floor_per_block: 5000000 },
        premium: { mint_blocks: 20, sold_blocks: 3, available_blocks: 17, floor_per_block: 5000000 },
      },
    }),

  "POST /ad/request": (body, _url, res) => {
    requestCount++;
    if (NO_FILL_EVERY > 0 && requestCount % NO_FILL_EVERY === 0) {
      log("request no-fill", `#${requestCount} → 204 (adapter must render nothing)`);
      return send(res, 204);
    }
    const wallet = body.user_wallet ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      log("request rejected", `bad wallet: ${JSON.stringify(wallet).slice(0, 40)}`);
      return send(res, 422, { detail: "user_wallet must be a 0x EVM address" });
    }
    const wanted = String(body.context ?? "general");
    const creative =
      CREATIVES.find((c) => c.tags.includes(wanted)) ??
      CREATIVES[requestCount % CREATIVES.length];
    const adId = `mock-ad-${requestCount}`;
    log(
      "request filled",
      `${adId} agent=${body.agent ?? "?"} surface=${body.surface ?? "?"} context=${wanted}`,
    );
    return send(res, 200, {
      ad_id: adId,
      title: creative.title,
      body: creative.body,
      cta_text: creative.cta_text,
      cta_url: `${creative.cta_url}?ref=latent-protocol&ad=${adId}`,
      earn_amount: Number((BID * USER_SHARE).toFixed(6)),
      image_url: null,
      impression_token: token(adId, wallet),
    });
  },

  "POST /ad/impression": (body, _url, res) => {
    const { ad_id: adId, user_wallet: wallet } = body;
    if (!adId || !wallet) return send(res, 422, { detail: "ad_id and user_wallet are required" });

    if (body.token !== token(adId, wallet)) {
      log("impression 403", `${adId} — token does not verify (echo it back verbatim)`);
      return send(res, 403, { detail: "invalid impression token" });
    }

    const key = `${adId}:${wallet}`;
    const last = impressions.get(key);
    if (last && Date.now() - last < REPLAY_WINDOW_MS) {
      log("impression skipped", `${adId} — replay within ${REPLAY_WINDOW_MS / 1000}s, NOT billed`);
      return send(res, 200, { status: "skipped" });
    }

    impressions.set(key, Date.now());
    const acct = account(wallet);
    acct.balance = Number((acct.balance + BID * USER_SHARE).toFixed(6));
    acct.impressions++;
    log("impression billed", `${adId} → +$${(BID * USER_SHARE).toFixed(6)} (${wallet.slice(0, 10)}…)`);
    return send(res, 200, { status: "tracked" });
  },

  "POST /ad/click": (body, _url, res) => {
    const acct = account(body.user_wallet ?? "");
    acct.clicks++;
    log("click", `${body.ad_id}`);
    return send(res, 200, { status: "tracked" });
  },
};

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (FAIL_RATE > 0 && Math.random() < FAIL_RATE) {
      log("injected failure", `${req.method} ${req.url} → 500`);
      return send(res, 500, { detail: "injected failure" });
    }

    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    let body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { detail: "malformed JSON body" });
      }
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) return handler(body, url, res);

    const earningsMatch = url.pathname.match(/^\/earnings\/(0x[0-9a-fA-F]{40})$/);
    if (req.method === "GET" && earningsMatch) {
      const wallet = earningsMatch[1];
      const acct = account(wallet);
      return send(res, 200, {
        wallet_address: wallet,
        balance: acct.balance,
        total_earned: acct.balance,
        total_impressions: acct.impressions,
        total_clicks: acct.clicks,
      });
    }

    const payoutMatch = url.pathname.match(/^\/payout\/(0x[0-9a-fA-F]{40})$/);
    if (req.method === "GET" && payoutMatch) return send(res, 200, { payouts: [] });

    if (req.method === "POST" && url.pathname === "/payout/request") {
      const acct = account(body.wallet_address ?? "");
      const amount = acct.balance;
      acct.balance = 0;
      log("payout", `$${amount} → ${body.wallet_address}`);
      return send(res, 200, {
        payout_id: randomUUID(),
        amount,
        tx_hash: `0x${"0".repeat(64)}`,
        status: "mock",
      });
    }

    send(res, 404, { detail: "not found" });
  });
}).listen(PORT, () => {
  console.log(`Latent Protocol mock ad server → http://127.0.0.1:${PORT}`);
  console.log(`  no-fill every ${NO_FILL_EVERY} requests · latency ${LATENCY_MS}ms · fail rate ${FAIL_RATE}`);
  console.log(`  point your adapter at it:  export ADS_SERVER=http://127.0.0.1:${PORT}\n`);
});
