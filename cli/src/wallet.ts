import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig, resolveServer, saveConfig } from "./config.js";
import {
  fetchAuthConfig,
  pollDeviceToken,
  pregenerateEmail,
  resolveSession,
  startDeviceAuth,
  type FetchLike,
} from "./privy.js";

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

export function isValidAddress(address: string): boolean {
  return EVM_RE.test(address);
}

export function generateWallet(): { address: string; privateKey: string } {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { address: account.address, privateKey };
}

export interface WalletOpts {
  yes?: boolean;
  /** @deprecated raw keygen — cash-out requires importing the printed key. */
  generate?: boolean;
  wallet?: string;
  email?: string;
  server?: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  question?: (prompt: string) => Promise<string>;
  log?: (line: string) => void;
}

function persist(
  address: string,
  extra: { privy_user_id?: string; auth?: string } = {},
): string {
  saveConfig({
    wallet: address,
    ...(extra.privy_user_id ? { privy_user_id: extra.privy_user_id } : {}),
    ...(extra.auth ? { auth: extra.auth } : {}),
  });
  return address;
}

const EOF_HINT =
  "stdin closed before answering. Re-run with --wallet 0x…, --email you@domain, " +
  "or --yes to keep the wallet already on file.";

/**
 * One readline for the whole prompt sequence.
 *
 * A fresh interface per question ends the stream when it closes, so the second
 * question of a piped run ([3] then the address) never saw its answer. And on
 * EOF — a script, a CI job, anything with no one at the keyboard — readline's
 * promise simply never settles, so `init` printed the menu and exited 0 with
 * no wallet and no error, which reads as success to whatever ran it.
 */
function createAsker(): { ask: (prompt: string) => Promise<string>; close: () => void } {
  let rl: ReturnType<typeof createInterface> | undefined;
  let ended = false;

  return {
    async ask(prompt: string): Promise<string> {
      if (ended) throw new Error(EOF_HINT);
      if (!rl) {
        rl = createInterface({ input, output });
        rl.once("close", () => {
          ended = true;
        });
      }
      const answer = await Promise.race([
        rl.question(prompt),
        new Promise<string>((_, reject) => {
          rl!.once("close", () => reject(new Error(EOF_HINT)));
        }),
      ]);
      return answer.trim();
    },
    close() {
      rl?.close();
    },
  };
}

async function viaAuthLink(opts: WalletOpts, log: (s: string) => void): Promise<string> {
  const server = opts.server || resolveServer(loadConfig());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cfg = await fetchAuthConfig(server, fetchImpl);
  const start = await startDeviceAuth(cfg.privy_app_id, fetchImpl);
  log("");
  log("Open this link and sign in (email, Google, X, or an existing wallet):");
  log(`  ${start.verification_uri_complete}`);
  log(`  Code: ${start.user_code}`);
  log("Waiting for approval…");
  const tokens = await pollDeviceToken(cfg.privy_app_id, start.device_code, {
    intervalSec: start.interval,
    expiresInSec: start.expires_in,
    fetchImpl,
    sleep: opts.sleep,
    now: opts.now,
  });
  const earner = await resolveSession(server, tokens.access_token, fetchImpl);
  log(`\n✅ Wallet: ${earner.wallet}`);
  log("   Cash out on the dashboard with the same login. Latent never sees your key.");
  return persist(earner.wallet, { privy_user_id: earner.privy_user_id, auth: "privy" });
}

async function viaEmail(opts: WalletOpts, email: string, log: (s: string) => void): Promise<string> {
  const server = opts.server || resolveServer(loadConfig());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const earner = await pregenerateEmail(server, email, fetchImpl);
  log(`\n✅ Wallet ready for ${email}: ${earner.wallet}`);
  log("   Ads can credit this address now.");
  log(
    `   Claim it (email OTP, then optional Google / X) at ${earner.claim_url || "https://www.latentprotocol.xyz/authorize"}`,
  );
  return persist(earner.wallet, { privy_user_id: earner.privy_user_id, auth: "privy" });
}

export async function ensureWallet(opts: WalletOpts = {}): Promise<string> {
  const asker = opts.question ? undefined : createAsker();
  try {
    return await bindWallet(opts, opts.question ?? asker!.ask);
  } finally {
    asker?.close();
  }
}

async function bindWallet(
  opts: WalletOpts,
  ask: (prompt: string) => Promise<string>,
): Promise<string> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const existing = loadConfig().wallet;

  if (opts.wallet) {
    if (!isValidAddress(opts.wallet)) {
      throw new Error(`Invalid wallet address: ${opts.wallet}`);
    }
    return persist(opts.wallet, { auth: "address" });
  }

  if (opts.email) {
    return viaEmail(opts, opts.email, log);
  }

  if (opts.generate) {
    const { address, privateKey } = generateWallet();
    log("\n⚠️  --generate is a last-resort key you must import to cash out.");
    log("   Prefer `init` (auth link) or `--email` / `--wallet`.");
    log(`   Address:     ${address}`);
    log(`   Private key: ${privateKey}`);
    log("   Latent only stores the address.");
    return persist(address, { auth: "generated" });
  }

  if (existing && opts.yes) {
    return existing;
  }

  if (opts.yes && !existing) {
    throw new Error(
      "No wallet on file. Re-run with --wallet 0x…, --email you@domain, or interactively (auth link).",
    );
  }

  if (existing) {
    const answer = (await ask(`Current wallet: ${existing}\nChange it? [y/N]: `)).toLowerCase();
    if (answer !== "y") return existing;
  }

  log("\nHow do you want to get paid?");
  log("  [1] Open an auth link — email, Google, X, or existing wallet  (recommended)");
  log("  [2] Email me a wallet now (pregenerate — claim later in the browser)");
  log("  [3] I already have a 0x address");
  const choice = (await ask("\nChoice [1/2/3]: ")) || "1";

  if (choice === "2") {
    const email = await ask("Email: ");
    if (!email.includes("@")) throw new Error("invalid email");
    return viaEmail(opts, email, log);
  }

  if (choice === "3") {
    while (true) {
      const address = await ask("\nEVM address (0x…): ");
      if (isValidAddress(address)) {
        log("\n✅ Wallet saved — cash out from the dashboard with this same wallet.");
        return persist(address, { auth: "address" });
      }
      log("❌ Invalid address. Must be 0x followed by 40 hex characters.");
    }
  }

  return viaAuthLink(opts, log);
}
