/**
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/privy.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  fetchAuthConfig,
  pollDeviceToken,
  pregenerateEmail,
  resolveSession,
  startDeviceAuth,
} from "../dist/privy.js";

function jsonRes(status, json) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

test("fetchAuthConfig requires a public app id and never mentions a secret", async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /\/auth\/config$/);
    return jsonRes(200, {
      privy_app_id: "clid_public",
      authorize_url: "https://www.latentprotocol.xyz/authorize",
      configured: true,
    });
  };
  const cfg = await fetchAuthConfig("https://api.latentprotocol.xyz/", fetchImpl);
  assert.equal(cfg.privy_app_id, "clid_public");
  assert.match(cfg.authorize_url, /\/authorize$/);
});

test("fetchAuthConfig fails closed when Privy is unset", async () => {
  const fetchImpl = async () => jsonRes(200, { privy_app_id: "", configured: false });
  await assert.rejects(
    () => fetchAuthConfig("https://api.example", fetchImpl),
    /not configured/,
  );
});

test("startDeviceAuth surfaces the dashboard toggle when 403", async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, "https://auth.privy.io/api/oauth/v2/device_authorization");
    assert.equal(init.headers["privy-app-id"], "clid");
    return jsonRes(403, { error: "device_auth_not_enabled" });
  };
  await assert.rejects(() => startDeviceAuth("clid", fetchImpl), /CLI\/agent access is off/);
});

test("pollDeviceToken waits through pending, slows down, then returns the token", async () => {
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.grant_type, "device_code");
    assert.equal(body.device_code, "devcode");
    calls.push(1);
    if (calls.length === 1) return jsonRes(400, { error: "authorization_pending" });
    if (calls.length === 2) return jsonRes(400, { error: "slow_down" });
    return jsonRes(200, { access_token: "tok_live", refresh_token: "ref" });
  };
  let t = 0;
  const tokens = await pollDeviceToken("clid", "devcode", {
    intervalSec: 1,
    expiresInSec: 30,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => {
      t += 1;
      return t * 1000;
    },
  });
  assert.equal(tokens.access_token, "tok_live");
  assert.ok(sleeps.includes(1000));
  assert.ok(sleeps.includes(6000), `intervals ${sleeps}`);
});

test("pollDeviceToken maps expired and denied", async () => {
  await assert.rejects(
    () =>
      pollDeviceToken("clid", "x", {
        intervalSec: 0,
        expiresInSec: 10,
        fetchImpl: async () => jsonRes(400, { error: "expired_token" }),
        sleep: async () => {},
        now: (() => {
          let n = 0;
          return () => (n += 1000);
        })(),
      }),
    /expired/,
  );
  await assert.rejects(
    () =>
      pollDeviceToken("clid", "x", {
        intervalSec: 0,
        expiresInSec: 10,
        fetchImpl: async () => jsonRes(400, { error: "access_denied" }),
        sleep: async () => {},
        now: (() => {
          let n = 0;
          return () => (n += 1000);
        })(),
      }),
    /denied/,
  );
});

test("pregenerateEmail posts the email and returns the wallet", async () => {
  const fetchImpl = async (url, init) => {
    assert.match(url, /\/auth\/pregenerate$/);
    assert.equal(JSON.parse(init.body).email, "ada@example.com");
    return jsonRes(200, {
      wallet: "0x6666666666666666666666666666666666666666",
      privy_user_id: "did:privy:ada",
      claim_url: "https://www.latentprotocol.xyz/authorize",
    });
  };
  const out = await pregenerateEmail("https://api.example", "ada@example.com", fetchImpl);
  assert.equal(out.wallet, "0x6666666666666666666666666666666666666666");
  assert.equal(out.privy_user_id, "did:privy:ada");
});

test("resolveSession posts the access token", async () => {
  const fetchImpl = async (url, init) => {
    assert.match(url, /\/auth\/session$/);
    assert.equal(JSON.parse(init.body).access_token, "tok");
    return jsonRes(200, {
      wallet: "0x7777777777777777777777777777777777777777",
      privy_user_id: "did:privy:tok",
    });
  };
  const out = await resolveSession("https://api.example", "tok", fetchImpl);
  assert.equal(out.privy_user_id, "did:privy:tok");
});
