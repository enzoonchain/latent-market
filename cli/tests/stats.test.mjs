/**
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/stats.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { formatStats, parsePeriod } from "../dist/stats.js";

const period = { earned: 0.004, earned_impressions: 0.003, earned_clicks: 0.001, earned_boost: 0,
  impressions: 3, clicks: 1, ctr_bps: 3333, avg_per_impression: 0.001 };
const stats = {
  wallet: "0xab",
  today: { ...period, daily_cap: 100, cap_used_24h: 3 },
  all: { ...period, earned: 0.016, balance: 0.004, paid_out: 0.012, payout_pending: 0.004,
    active_days: 2, first_earned_at: "2026-09-24T10:00:00+00:00" },
  holder: null,
  account: null,
};

test("parsePeriod accepts the switch spellings", () => {
  assert.equal(parsePeriod("today"), "today");
  assert.equal(parsePeriod("daily"), "today");
  assert.equal(parsePeriod("all"), "all");
  assert.equal(parsePeriod("total"), "all");
  assert.equal(parsePeriod("week"), null);
  assert.equal(parsePeriod(undefined), null);
});

test("today shows the day's earnings and the rolling cap", () => {
  const out = formatStats(stats, "today").join("\n");
  assert.match(out, /today \(UTC\)/);
  assert.match(out, /stats --all/);
  assert.match(out, /Earned: +\$0\.0040/);
  assert.match(out, /CTR 33\.3%/);
  assert.match(out, /3 \/ 100 impressions in the last 24h/);
  assert.doesNotMatch(out, /boost/); // no boost earned → not listed
  assert.doesNotMatch(out, /Holder/);
});

test("all time shows balance, payouts and active days", () => {
  const out = formatStats(stats, "all").join("\n");
  assert.match(out, /all time/);
  assert.match(out, /stats --today/);
  assert.match(out, /Balance: +\$0\.0040 +· +Paid out \$0\.0120 +· +Payout pending \$0\.0040/);
  assert.match(out, /Active days: +2 since 2026-09-24/);
});

test("holder lines follow the period", () => {
  const holder = { last_close_day: 4, last_close_credit: 0.1375, last_close_blocks: 2.5,
    cumulative_credit: 0.6121, blocks_allocated: 9.75, kept_blocks: 0 };
  const s = { ...stats, holder };
  assert.match(formatStats(s, "today").join("\n"), /\$0\.1375 credit, 2\.50 blocks on block day 4/);
  const all = formatStats(s, "all").join("\n");
  assert.match(all, /\$0\.6121 credit · 9\.75 blocks allocated/);
  assert.doesNotMatch(all, /kept/);
});
