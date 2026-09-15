/** Privy device-auth + Latent pregenerate client. No app secret on this machine. */

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface AuthConfig {
  privy_app_id: string;
  authorize_url: string;
  configured: boolean;
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface EarnerWallet {
  wallet: string;
  privy_user_id: string;
}

function trimServer(server: string): string {
  return server.replace(/\/+$/, "");
}

async function readJson(res: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return { detail: await res.text().catch(() => `HTTP ${res.status}`) };
  }
}

export async function fetchAuthConfig(
  server: string,
  fetchImpl: FetchLike = fetch,
): Promise<AuthConfig> {
  const res = await fetchImpl(`${trimServer(server)}/auth/config`);
  const body = (await readJson(res)) as Partial<AuthConfig> & { detail?: string };
  if (!res.ok) {
    throw new Error(
      typeof body.detail === "string" ? body.detail : `auth config HTTP ${res.status}`,
    );
  }
  if (!body.privy_app_id) {
    throw new Error(
      "Privy is not configured on the ad server (PRIVY_APP_ID). Pass --wallet 0x… instead.",
    );
  }
  return {
    privy_app_id: String(body.privy_app_id),
    authorize_url: String(body.authorize_url || "https://www.latentprotocol.xyz/authorize"),
    configured: Boolean(body.configured),
  };
}

export async function startDeviceAuth(
  appId: string,
  fetchImpl: FetchLike = fetch,
): Promise<DeviceStart> {
  const res = await fetchImpl("https://auth.privy.io/api/oauth/v2/device_authorization", {
    method: "POST",
    headers: { "Content-Type": "application/json", "privy-app-id": appId },
    body: "{}",
  });
  const body = (await readJson(res)) as Partial<DeviceStart> & { error?: string };
  if (!res.ok) {
    // Only Privy's own code means the dashboard toggle. A bare 403 is just as
    // likely a proxy, a network policy or a WAF between here and Privy, and
    // sending that user to flip a setting that is already on wastes their time.
    if (body.error === "device_auth_not_enabled") {
      throw new Error(
        "Privy CLI/agent access is off. Enable it in the Privy Dashboard (Authentication → Advanced) or use --email / --wallet.",
      );
    }
    if (res.status === 403) {
      throw new Error(
        "auth.privy.io refused the request (403). If you are behind a proxy or VPN, that is the likely cause; " +
          "otherwise check that CLI/agent access is on in the Privy Dashboard. Or use --email / --wallet.",
      );
    }
    throw new Error(`device_authorization HTTP ${res.status}`);
  }
  if (!body.device_code || !body.user_code) {
    throw new Error("device_authorization returned no codes");
  }
  return {
    device_code: String(body.device_code),
    user_code: String(body.user_code),
    verification_uri: String(body.verification_uri || ""),
    verification_uri_complete: String(
      body.verification_uri_complete ||
        `${body.verification_uri}?user_code=${body.user_code}`,
    ),
    expires_in: Number(body.expires_in || 600),
    interval: Math.max(1, Number(body.interval || 5)),
  };
}

export async function pollDeviceToken(
  appId: string,
  deviceCode: string,
  opts: {
    intervalSec: number;
    expiresInSec: number;
    fetchImpl?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<TokenSet> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.expiresInSec * 1000;
  let interval = opts.intervalSec;

  while (now() < deadline) {
    await sleep(interval * 1000);
    const res = await fetchImpl("https://auth.privy.io/api/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "privy-app-id": appId },
      body: JSON.stringify({ grant_type: "device_code", device_code: deviceCode }),
    });
    const body = (await readJson(res)) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (res.ok && body.access_token) {
      return {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_in: body.expires_in,
      };
    }
    const err = String(body.error || "");
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      interval += 5;
      continue;
    }
    if (err === "expired_token") throw new Error("Auth link expired — run init again.");
    if (err === "access_denied") throw new Error("Authorization denied in the browser.");
    if (!res.ok && !err) throw new Error(`token HTTP ${res.status}`);
    throw new Error(err || `token HTTP ${res.status}`);
  }
  throw new Error("Auth link timed out — run init again.");
}

export async function pregenerateEmail(
  server: string,
  email: string,
  fetchImpl: FetchLike = fetch,
): Promise<EarnerWallet & { claim_url?: string }> {
  const res = await fetchImpl(`${trimServer(server)}/auth/pregenerate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = (await readJson(res)) as {
    wallet?: string;
    privy_user_id?: string;
    claim_url?: string;
    detail?: string;
  };
  if (!res.ok) {
    throw new Error(typeof body.detail === "string" ? body.detail : `pregenerate HTTP ${res.status}`);
  }
  if (!body.wallet || !body.privy_user_id) {
    throw new Error("pregenerate returned no wallet");
  }
  return {
    wallet: body.wallet,
    privy_user_id: body.privy_user_id,
    claim_url: body.claim_url,
  };
}

export async function resolveSession(
  server: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<EarnerWallet> {
  const res = await fetchImpl(`${trimServer(server)}/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: accessToken }),
  });
  const body = (await readJson(res)) as {
    wallet?: string;
    privy_user_id?: string;
    detail?: string;
  };
  if (!res.ok) {
    throw new Error(typeof body.detail === "string" ? body.detail : `session HTTP ${res.status}`);
  }
  if (!body.wallet || !body.privy_user_id) {
    throw new Error("session returned no wallet");
  }
  return { wallet: body.wallet, privy_user_id: body.privy_user_id };
}
