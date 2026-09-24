/** Policy acceptance stored in extension globalState. A version bump re-locks earning. */

export const POLICY_VERSION = "2026-09-24";
export const POLICY_KEY = "latent.policy";

export interface PolicyRecord {
  version: string;
  acceptedAt: number;
}

export function readPolicy(raw: unknown): PolicyRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Partial<PolicyRecord>;
  if (rec.version === POLICY_VERSION && typeof rec.acceptedAt === "number" && rec.acceptedAt > 0) {
    return { version: rec.version, acceptedAt: rec.acceptedAt };
  }
  return undefined;
}

export function isPolicyAccepted(raw: unknown): boolean {
  return readPolicy(raw) !== undefined;
}
