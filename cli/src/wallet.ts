import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
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

export interface WalletOpts {
  yes?: boolean;
  wallet?: string;
  email?: string;
  server?: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  question?: (prompt: string) => Promise<string>;
  log?: (line: string) => void;
  /** Opens the auth link; returns whether it did. Defaults to the system browser. */
  openUrl?: (url: string) => boolean;
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
 * question of a piped run never saw its answer. `rl.question()` has the same
 * problem one level down: a piped stdin delivers every line at once, and a line
 * that arrives while no question is pending is dropped — `printf 'y\n1\n' |
 * init` answered "Change it?" and then hung on the menu. So lines are queued
 * as they arrive and each prompt takes the next one.
 *
 * On EOF — a script, a CI job, anything with no one at the keyboard — a pending
 * prompt rejects instead of hanging, so `init` never exits 0 with no wallet.
 */
function createAsker(): { ask: (prompt: string) => Promise<string>; close: () => void } {
  let rl: ReturnType<typeof createInterface> | undefined;
  let ended = false;
  const lines: string[] = [];
  let waiter: { resolve: (line: string) => void; reject: (err: Error) => void } | undefined;

  function start() {
    rl = createInterface({ input, output });
    rl.on("line", (line) => {
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w.resolve(line);
      } else {
        lines.push(line);
      }
    });
    rl.once("close", () => {
      ended = true;
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w.reject(new Error(EOF_HINT));
      }
    });
  }

  return {
    async ask(prompt: string): Promise<string> {
      if (!rl) start();
      output.write(prompt);
      const queued = lines.shift();
      if (queued !== undefined) return queued.trim();
      if (ended) throw new Error(EOF_HINT);
      const answer = await new Promise<string>((resolve, reject) => {
        waiter = { resolve, reject };
      });
      return answer.trim();
    },
    close() {
      rl?.close();
    },
  };
}

/**
 * Best-effort: open the auth link in the default browser so nobody has to
 * copy-paste it. The link is always printed too — this only saves a step.
 * Skipped where no local browser can be the one the user is looking at
 * (CI, SSH, a Linux box with no display) or when LATENT_NO_BROWSER is set.
 */
export function openInBrowser(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: typeof spawn = spawn,
): boolean {
  if (env.LATENT_NO_BROWSER || env.CI || env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (!/^https:\/\//.test(url)) return false;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    // `start`'s first quoted arg is the window title; the URL goes second.
    cmd = "cmd";
    args = ["/c", "start", "", url.replace(/&/g, "^&")];
  } else {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawnImpl(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
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
  if ((opts.openUrl ?? openInBrowser)(start.verification_uri_complete)) {
    log("(Opened it in your browser.)");
  }
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
