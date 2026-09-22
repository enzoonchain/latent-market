/** Earnings read, kept free of the `vscode` import so it is unit-testable. */

export type EarningsResult =
  | { kind: "ok"; balance: number; tier?: string }
  /** 401/403: the server only shows a balance to a signed wallet-owner proof
   * (`GET /earnings/{wallet}` needs an EIP-191 signature). The extension holds
   * no wallet key — Privy wallets have none locally — so it cannot sign. */
  | { kind: "auth" }
  | { kind: "error" };

export async function fetchEarnings(serverUrl: string, wallet: string): Promise<EarningsResult> {
  try {
    const r = await fetch(`${serverUrl}/earnings/${wallet}`, { signal: AbortSignal.timeout(5000) });
    if (r.status === 401 || r.status === 403) return { kind: "auth" };
    if (!r.ok) return { kind: "error" };
    const j = (await r.json()) as { balance?: unknown; tier?: string };
    const balance = Number(j.balance);
    if (!Number.isFinite(balance)) return { kind: "error" };
    return { kind: "ok", balance, tier: j.tier };
  } catch {
    return { kind: "error" };
  }
}
