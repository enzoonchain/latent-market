/**
 * Viewability funnel — fraud-resistant impression billing.
 *
 * Funnel:
 *   impression_rendered → view_tick (2.5s cadence) → view_threshold_met (10s) → credit
 *
 * All events go through the loopback (never directly to the ad server).
 * The loopback forwards them as structured metrics alongside the impression.
 */

/** Minimum cumulative view time (ms) before an impression is billable. */
export const MIN_VIEW_MS = 10_000;

/** How often we emit `view_tick` while the ad is visible. */
export const TICK_INTERVAL_MS = 2_500;

export type MetricEvent =
  | "impression_rendered"
  | "impression_viewable"
  | "view_tick"
  | "view_threshold_met"
  | "error_impression";

export interface ViewabilityState {
  adId: string;
  renderedAt: number;
  cumulativeVisibleMs: number;
  lastTickAt: number;
  thresholdMet: boolean;
  viewableSince: number;
}

export class ViewabilityTracker {
  private state: ViewabilityState | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private emitFn: (event: MetricEvent, adId: string, extra?: Record<string, unknown>) => void;

  constructor(
    emitFn: (event: MetricEvent, adId: string, extra?: Record<string, unknown>) => void,
    private readonly tickMs: number = TICK_INTERVAL_MS,
    private readonly thresholdMs: number = MIN_VIEW_MS,
  ) {
    this.emitFn = emitFn;
  }

  /** Start tracking a new ad impression. */
  impressionRendered(adId: string): void {
    this.stop();
    const now = Date.now();
    this.state = {
      adId,
      renderedAt: now,
      cumulativeVisibleMs: 0,
      lastTickAt: now,
      thresholdMet: false,
      viewableSince: 0,
    };
    this.emitFn("impression_rendered", adId);
  }

  /** The ad became visible on screen. */
  viewable(): void {
    if (!this.state || this.state.viewableSince) return;
    this.state.viewableSince = Date.now();
    this.emitFn("impression_viewable", this.state.adId);
    this.startTicks();
  }

  /** The ad went off-screen. Accumulate elapsed view time. */
  hidden(): void {
    if (!this.state || !this.state.viewableSince) return;
    const now = Date.now();
    this.state.cumulativeVisibleMs += now - this.state.viewableSince;
    this.state.viewableSince = 0;
    this.stopTicks();
    this.checkThreshold();
  }

  /** Stop tracking (ad rotated away / dismissed). */
  stop(): void {
    if (this.state) {
      this.hidden(); // accumulate any remaining view time
      if (!this.state.thresholdMet) {
        this.emitFn("error_impression", this.state.adId, {
          cumulative_ms: this.state.cumulativeVisibleMs,
        });
      }
    }
    this.stopTicks();
    this.state = null;
  }

  /** Current cumulative visible time including active segment. */
  totalVisibleMs(): number {
    if (!this.state) return 0;
    let total = this.state.cumulativeVisibleMs;
    if (this.state.viewableSince) total += Date.now() - this.state.viewableSince;
    return total;
  }

  isThresholdMet(): boolean {
    return this.state?.thresholdMet ?? false;
  }

  currentAdId(): string {
    return this.state?.adId ?? "";
  }

  private startTicks(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      if (!this.state || !this.state.viewableSince) return;
      this.state.lastTickAt = Date.now();
      this.emitFn("view_tick", this.state.adId, {
        cumulative_ms: this.totalVisibleMs(),
      });
      this.checkThreshold();
    }, this.tickMs);
  }

  private stopTicks(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private checkThreshold(): void {
    if (!this.state || this.state.thresholdMet) return;
    if (this.totalVisibleMs() >= this.thresholdMs) {
      this.state.thresholdMet = true;
      this.emitFn("view_threshold_met", this.state.adId, {
        cumulative_ms: this.totalVisibleMs(),
      });
    }
  }
}
