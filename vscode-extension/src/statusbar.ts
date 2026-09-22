/**
 * Live earnings status bar — persistent USDC balance + tier indicator.
 *
 * Replaces the simple sponsor-line rotation with a two-item status bar:
 *  - Left item: current sponsor line (rotating)
 *  - Right item: live earnings balance (polls the server every 60s)
 *
 * The earnings poller degrades to "$0.00" on failure — never a bare label.
 */
import * as vscode from "vscode";

const EARNINGS_POLL_MS = 60_000;

export interface EarningsData {
  balance: number;
  tier?: string;
}

export class EarningsStatusBar {
  private item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBalance = 0;

  constructor(
    private readonly serverUrl: string,
    private readonly wallet: string,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 900);
    this.item.command = "latent.showEarnings";
  }

  start(): void {
    this.item.text = "💰 $0.00";
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

  get balance(): number {
    return this.lastBalance;
  }

  private async poll(): Promise<void> {
    if (!this.wallet) {
      this.item.text = "💰 no wallet";
      this.item.tooltip = "Run `npx latent-protocol init` to set up earnings";
      return;
    }
    try {
      const r = await fetch(`${this.serverUrl}/earnings/${this.wallet}`, {
        signal: AbortSignal.timeout(5000),
      });
      const j = (await r.json()) as { balance?: number; tier?: string };
      this.lastBalance = Number(j.balance ?? 0);
      const tier = j.tier ? ` [${j.tier}]` : "";
      this.item.text = `💰 $${this.lastBalance.toFixed(2)}${tier}`;
      this.item.tooltip = `Latent Protocol — $${this.lastBalance.toFixed(4)} USDC earned`;
      this.item.color = undefined;
    } catch {
      this.item.text = `💰 $${this.lastBalance.toFixed(2)}`;
      this.item.tooltip = "Latent Protocol — earnings (server unreachable)";
    }
  }
}
