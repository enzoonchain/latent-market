/**
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/wallet.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWallet, isValidAddress, openInBrowser } from "../dist/wallet.js";
import { loadConfig } from "../dist/config.js";

const ADDR = "0x7331003C29a8Db67E141dD39964B205598b60bcf";

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "latent-wallet-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  return fn(home).finally(() => {
    process.env.HOME = prev;
  });
}

test("isValidAddress", () => {
  assert.equal(isValidAddress(ADDR), true);
  assert.equal(isValidAddress("0xdead"), false);
  assert.equal(isValidAddress(""), false);
});

test("--wallet persists the address and never hits the network", async () => {
  await withHome(async (home) => {
    const fetchImpl = async () => {
      throw new Error("network should not be called");
    };
    const addr = await ensureWallet({ wallet: ADDR, fetchImpl, log: () => {} });
    assert.equal(addr, ADDR);
    const cfg = JSON.parse(readFileSync(join(home, ".latent-protocol", "config.json"), "utf8"));
    assert.equal(cfg.wallet, ADDR);
    assert.equal(cfg.auth, "address");
  });
});

test("--yes without a wallet fails instead of minting a key", async () => {
  await withHome(async () => {
    await assert.rejects(
      () => ensureWallet({ yes: true, log: () => {} }),
      /No wallet on file/,
    );
    assert.equal(loadConfig().wallet, undefined);
  });
});

test("--yes reuses an existing wallet", async () => {
  await withHome(async () => {
    await ensureWallet({ wallet: ADDR, log: () => {} });
    const addr = await ensureWallet({ yes: true, log: () => {} });
    assert.equal(addr, ADDR);
  });
});

test("--email pregenerates via the ad server", async () => {
  await withHome(async (home) => {
    const fetchImpl = async (url, init) => {
      assert.match(url, /\/auth\/pregenerate$/);
      assert.equal(JSON.parse(init.body).email, "ada@example.com");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          wallet: ADDR,
          privy_user_id: "did:privy:ada",
          claim_url: "https://www.latentprotocol.xyz/authorize",
        }),
        text: async () => "",
      };
    };
    const addr = await ensureWallet({
      email: "ada@example.com",
      server: "https://api.example",
      fetchImpl,
      log: () => {},
    });
    assert.equal(addr, ADDR);
    const cfg = JSON.parse(readFileSync(join(home, ".latent-protocol", "config.json"), "utf8"));
    assert.equal(cfg.privy_user_id, "did:privy:ada");
    assert.equal(cfg.auth, "privy");
  });
});

test("interactive [1] runs device auth then session resolve", async () => {
  await withHome(async (home) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(url);
      if (url.endsWith("/auth/config")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            privy_app_id: "clid",
            authorize_url: "https://www.latentprotocol.xyz/authorize",
            configured: true,
          }),
          text: async () => "",
        };
      }
      if (url.includes("device_authorization")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "dev",
            user_code: "WDJB-MJHT",
            verification_uri: "https://www.latentprotocol.xyz/authorize",
            verification_uri_complete:
              "https://www.latentprotocol.xyz/authorize?user_code=WDJB-MJHT",
            expires_in: 600,
            interval: 1,
          }),
          text: async () => "",
        };
      }
      if (url.includes("/token")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "tok" }),
          text: async () => "",
        };
      }
      if (url.endsWith("/auth/session")) {
        assert.equal(JSON.parse(init.body).access_token, "tok");
        return {
          ok: true,
          status: 200,
          json: async () => ({ wallet: ADDR, privy_user_id: "did:privy:tok" }),
          text: async () => "",
        };
      }
      throw new Error("unexpected " + url);
    };
    const logs = [];
    const addr = await ensureWallet({
      server: "https://api.example",
      fetchImpl,
      sleep: async () => {},
      now: (() => {
        let n = 0;
        return () => (n += 1000);
      })(),
      question: async () => "1",
      log: (l) => logs.push(l),
    });
    assert.equal(addr, ADDR);
    assert.ok(logs.some((l) => l.includes("WDJB-MJHT")));
    assert.ok(logs.some((l) => l.includes("authorize?user_code=WDJB-MJHT")));
    const cfg = JSON.parse(readFileSync(join(home, ".latent-protocol", "config.json"), "utf8"));
    assert.equal(cfg.auth, "privy");
  });
});

test("interactive [3] saves a pasted address", async () => {
  await withHome(async () => {
    const answers = ["3", ADDR];
    const addr = await ensureWallet({
      question: async () => answers.shift(),
      fetchImpl: async () => {
        throw new Error("network");
      },
      log: () => {},
    });
    assert.equal(addr, ADDR);
  });
});

test("a leftover generate option no longer mints a local key", async () => {
  await withHome(async () => {
    const logs = [];
    await assert.rejects(
      ensureWallet({ generate: true, yes: true, log: (l) => logs.push(l) }),
      /No wallet on file/,
    );
    assert.ok(!logs.some((l) => /Private key/i.test(l)));
  });
});

function fakeSpawn(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { on() {}, unref() {} };
  };
}

test("openInBrowser uses the platform opener, detached", () => {
  const url = "https://www.latentprotocol.xyz/authorize?user_code=AB-CD&x=1";
  const calls = [];
  assert.equal(openInBrowser(url, {}, "darwin", fakeSpawn(calls)), true);
  assert.equal(openInBrowser(url, { DISPLAY: ":0" }, "linux", fakeSpawn(calls)), true);
  assert.equal(openInBrowser(url, {}, "win32", fakeSpawn(calls)), true);
  assert.deepEqual(calls.map((c) => c.cmd), ["open", "xdg-open", "cmd"]);
  assert.deepEqual(calls[0].args, [url]);
  assert.deepEqual(calls[2].args, ["/c", "start", "", url.replace(/&/g, "^&")]);
  assert.ok(calls.every((c) => c.opts.detached && c.opts.stdio === "ignore"));
});

test("openInBrowser stays quiet where no local browser is watching", () => {
  const url = "https://www.latentprotocol.xyz/authorize?user_code=AB-CD";
  const calls = [];
  for (const env of [{ LATENT_NO_BROWSER: "1" }, { CI: "true" }, { SSH_CONNECTION: "1 2 3 4" }, { SSH_TTY: "/dev/ttys1" }]) {
    assert.equal(openInBrowser(url, env, "darwin", fakeSpawn(calls)), false);
  }
  assert.equal(openInBrowser(url, {}, "linux", fakeSpawn(calls)), false, "no DISPLAY");
  assert.equal(openInBrowser("file:///etc/passwd", {}, "darwin", fakeSpawn(calls)), false);
  assert.equal(calls.length, 0);
});

test("openInBrowser never throws when the opener is missing", () => {
  const boom = () => {
    throw new Error("ENOENT");
  };
  assert.equal(openInBrowser("https://x.example", {}, "darwin", boom), false);
});

test("auth link opens the verification URL and reports it", async () => {
  await withHome(async () => {
    const opened = [];
    const logs = [];
    const fetchImpl = async (url) => {
      if (url.endsWith("/auth/config")) {
        return { ok: true, status: 200, json: async () => ({ privy_app_id: "app", configured: true }), text: async () => "" };
      }
      if (url.endsWith("/device_authorization")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            device_code: "dc",
            user_code: "AB-CD",
            verification_uri_complete: "https://www.latentprotocol.xyz/authorize?user_code=AB-CD",
            expires_in: 60,
            interval: 1,
          }),
          text: async () => "",
        };
      }
      if (url.endsWith("/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "tok" }), text: async () => "" };
      }
      return { ok: true, status: 200, json: async () => ({ wallet: ADDR, privy_user_id: "did:privy:u" }), text: async () => "" };
    };
    const addr = await ensureWallet({
      server: "https://api.example",
      question: async () => "1",
      fetchImpl,
      sleep: async () => {},
      openUrl: (u) => (opened.push(u), true),
      log: (l) => logs.push(l),
    });
    assert.equal(addr, ADDR);
    assert.deepEqual(opened, ["https://www.latentprotocol.xyz/authorize?user_code=AB-CD"]);
    assert.ok(logs.some((l) => /Opened it in your browser/.test(l)));
    assert.ok(logs.some((l) => l.includes("user_code=AB-CD")), "link is still printed");
  });
});
