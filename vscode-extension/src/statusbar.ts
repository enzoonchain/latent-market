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

const EARNINGS_POLL_MS = 60_000;

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
    private readonly wallet: string,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 900);
    this.item.command = "latent.showEarnings";
  }

  start(): void {
    this.item.text = "💰 —";
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
    if (!this.wallet) {
      this.item.text = "💰 no wallet";
      this.item.tooltip = "Run `npx latent-protocol init` to set up earnings";
      return;
    }
    const e = await fetchEarnings(this.serverUrl, this.wallet);
    if (e.kind === "ok") {
      this.lastBalance = e.balance;
      const tier = e.tier ? ` [${e.tier}]` : "";
      this.item.text = `💰 $${e.balance.toFixed(2)}${tier}`;
      this.item.tooltip = `Latent Protocol — $${e.balance.toFixed(4)} USDC earned`;
    } else if (e.kind === "auth") {
      this.item.text = "💰 private";
      this.item.tooltip = "Latent Protocol — balance is only shown to the wallet owner; sign in on the Latent dashboard to view it";
    } else {
      this.item.text = this.lastBalance === null ? "💰 —" : `💰 $${this.lastBalance.toFixed(2)}`;
      this.item.tooltip = "Latent Protocol — earnings (server unreachable)";
    }
  }
}
