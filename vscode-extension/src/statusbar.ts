/**
 * Live earnings status bar — persistent USDC balance + tier indicator.
 *
 * Replaces the simple sponsor-line rotation with a two-item status bar:
 *  - Left item: current sponsor line (rotating)
 *  - Right item: live earnings balance (polls the server every 60s)
 *
 * Never shows a made-up number: a failed poll keeps the last real balance
 * (or "—" before the first one), and a balance the server keeps private
 * (401, no local signing key) shows as "private", not "$0.00".
 */
import * as vscode from "vscode";
import { fetchEarnings } from "./earnings.js";

const EARNINGS_POLL_MS = 20_000;

export interface EarningsData {
  balance: number;
  tier?: string;
}

export class EarningsStatusBar {
  private item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBalance: number | null = null;

  constructor(
    private readonly serverUrl: string,
    private wallet: string,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 900);
    this.item.command = "latent.openPanel";
  }

  private policyAccepted = false;
  private pausedReason: string | undefined;
  private pauseDetail = "";
  private stale = false;

  /** Earnings item is the entry point: policy, wallet, then the live balance. */
  setAccess(policyAccepted: boolean, wallet: string): void {
    this.policyAccepted = policyAccepted;
    this.wallet = wallet;
    void this.poll();
  }

  /** Kill switch or incident backoff. The balance poll stays, the label says paused. */
  setPaused(reason?: string, detail?: string): void {
    this.pausedReason = reason;
    this.pauseDetail = detail || "";
    void this.poll();
  }

  /** The workbench overlay in this window is older than the script on disk. */
  setStale(stale: boolean): void {
    this.stale = stale;
    void this.poll();
  }

  start(): void {
    this.item.text = "Latent —";
    this.item.tooltip = "Latent Protocol — earnings";
    this.item.show();
    void this.poll();
    this.timer = setInterval(() => void this.poll(), EARNINGS_POLL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.item.hide();
    this.item.dispose();
  }

  get balance(): number | null {
    return this.lastBalance;
  }

  private async poll(): Promise<void> {
    if (!this.policyAccepted) {
      this.item.text = "$(sparkle) Latent: accept terms";
      this.item.tooltip = "Open Latent to accept the Terms and start earning";
      return;
    }
    if (!this.wallet) {
      this.item.text = "$(gear) Latent: set up";
      this.item.tooltip = "Run `npx latent-protocol init` to set up earnings";
      return;
    }
    if (this.pausedReason) {
      this.item.text = "$(debug-pause) Latent paused";
      this.item.tooltip =
        this.pausedReason === "killswitch"
          ? this.pauseDetail
            ? `Latent is paused: ${this.pauseDetail}`
            : "Latent is paused by the kill switch"
          : "Latent is paused after repeated server errors";
      return;
    }
    if (this.stale) {
      this.item.text = "$(warning) Latent: reload to update";
      this.item.tooltip =
        "The composer line is still the previous script. Impressions credit your local wallet, but docking updates after you reload the window.";
      return;
    }
    const e = await fetchEarnings(this.serverUrl, this.wallet);
    if (e.kind === "ok") {
      this.lastBalance = e.balance;
      this.item.text = `$(menu) Latent Menu · $${e.balance.toFixed(2)}`;
      this.item.tooltip = `Unpaid balance $${e.balance.toFixed(2)} · earned $${e.totalEarned.toFixed(2)} USDC`;
    } else if (e.kind === "auth") {
      this.item.text = "$(menu) Latent Menu";
      this.item.tooltip = "Your balance is on the Latent dashboard. Open the menu to manage the wallet.";
    } else {
      this.item.text = this.lastBalance === null ? "$(cloud-offline) Latent offline" : `$(cloud-offline) Latent $${this.lastBalance.toFixed(2)}`;
      this.item.tooltip = "Latent Protocol — earnings (server unreachable)";
    }
  }
}
