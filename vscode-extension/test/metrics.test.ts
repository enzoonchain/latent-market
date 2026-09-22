import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ViewabilityTracker, MIN_VIEW_MS, TICK_INTERVAL_MS, type MetricEvent } from "../src/metrics.js";

describe("ViewabilityTracker", () => {
  let events: Array<{ event: MetricEvent; adId: string; extra?: Record<string, unknown> }>;
  let tracker: ViewabilityTracker;

  beforeEach(() => {
    events = [];
    tracker = new ViewabilityTracker((event, adId, extra) => {
      events.push({ event, adId, extra });
    }, 100, 500); // fast ticks + low threshold for testing
  });

  afterEach(() => {
    tracker.stop();
    vi.useRealTimers();
  });

  it("emits impression_rendered on start", () => {
    tracker.impressionRendered("ad-1");
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("impression_rendered");
    expect(events[0].adId).toBe("ad-1");
  });

  it("emits impression_viewable when made visible", () => {
    tracker.impressionRendered("ad-1");
    tracker.viewable();
    expect(events.map((e) => e.event)).toEqual(["impression_rendered", "impression_viewable"]);
  });

  it("does not double-emit impression_viewable", () => {
    tracker.impressionRendered("ad-1");
    tracker.viewable();
    tracker.viewable();
    expect(events.filter((e) => e.event === "impression_viewable")).toHaveLength(1);
  });

  it("accumulates visible time on hidden", () => {
    tracker.impressionRendered("ad-1");
    tracker.viewable();
    // Simulate 200ms visible
    setTimeout(() => {
      tracker.hidden();
      expect(tracker.totalVisibleMs()).toBeGreaterThanOrEqual(200);
    }, 200);
  });

  it("emits view_threshold_met when threshold reached", () => {
    vi.useFakeTimers();
    tracker.impressionRendered("ad-1");
    tracker.viewable();
    // Advance past threshold (500ms in test config)
    vi.advanceTimersByTime(600);
    expect(events.some((e) => e.event === "view_threshold_met")).toBe(true);
  });

  it("emits error_impression when stopped before threshold", () => {
    tracker.impressionRendered("ad-1");
    tracker.viewable();
    tracker.stop();
    expect(events.some((e) => e.event === "error_impression")).toBe(true);
  });

  it("does not emit error_impression after threshold met", () => {
    vi.useFakeTimers();
    tracker.impressionRendered("ad-1");
    tracker.viewable();
    vi.advanceTimersByTime(600); // threshold met
    tracker.stop();
    expect(events.some((e) => e.event === "error_impression")).toBe(false);
  });

  it("tracks cumulative time across show/hide cycles", () => {
    vi.useFakeTimers();
    tracker.impressionRendered("ad-1");
    tracker.viewable();
    vi.advanceTimersByTime(200);
    tracker.hidden();
    vi.advanceTimersByTime(100); // hidden period — not counted
    tracker.viewable();
    vi.advanceTimersByTime(200);
    expect(tracker.totalVisibleMs()).toBe(400);
  });

  it("emits view_tick events at the configured interval", () => {
    vi.useFakeTimers();
    tracker.impressionRendered("ad-1");
    tracker.viewable();
    vi.advanceTimersByTime(350); // 3 ticks at 100ms interval
    const ticks = events.filter((e) => e.event === "view_tick");
    expect(ticks.length).toBeGreaterThanOrEqual(3);
  });

  it("reports correct adId", () => {
    tracker.impressionRendered("ad-42");
    expect(tracker.currentAdId()).toBe("ad-42");
  });

  it("isThresholdMet starts false and becomes true", () => {
    vi.useFakeTimers();
    tracker.impressionRendered("ad-1");
    tracker.viewable();
    expect(tracker.isThresholdMet()).toBe(false);
    vi.advanceTimersByTime(600);
    expect(tracker.isThresholdMet()).toBe(true);
  });
});

describe("constants", () => {
  it("MIN_VIEW_MS is 10 seconds", () => {
    expect(MIN_VIEW_MS).toBe(10_000);
  });
  it("TICK_INTERVAL_MS is 2.5 seconds", () => {
    expect(TICK_INTERVAL_MS).toBe(2_500);
  });
});
