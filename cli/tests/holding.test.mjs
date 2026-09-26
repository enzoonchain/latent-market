/**
 * Run after `npm --prefix cli run build`:
 *   node --test cli/tests/holding.test.mjs
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { formatHolding, formatTokens } from "../dist/holding.js";

const T = "000000000000000000";
const base = {
  linked: true,
  tier: 1,
  twab_tokens: `60000${T}`,
  tier_thresholds: [`50000${T}`, `250000${T}`, `1000000${T}`],
  boost_bps: 1000,
  boost_daily_cap: 50,
  effective_scale_bps: 10000,
  effective_boost_bps: 1000,
};

test("token units are shown as whole tokens", () => {
  assert.equal(formatTokens(`1234567${T}`), "1,234,567");
  assert.equal(formatTokens("junk"), "0");
});

test("tier, next threshold and the boost", () => {
  const out = formatHolding(base).join("\n");
  assert.match(out, /Tier:\s+1 \(7-day average 60,000 LATENT\)/);
  assert.match(out, /next tier at 250,000 LATENT/);
  assert.match(out, /\+10% today on your first 50 impressions/);
});

test("budget scaling is spelled out", () => {
  const out = formatHolding({ ...base, effective_scale_bps: 5000, effective_boost_bps: 500 }).join("\n");
  assert.match(out, /\+5% today/);
  assert.match(out, /scaled to 50% by the day's budget/);
});

test("unlinked wallet and inactive boost", () => {
  assert.match(formatHolding({ ...base, linked: false }).join("\n"), /not linked/);
  assert.match(formatHolding({ ...base, boost_bps: 0 }).join("\n"), /not active yet/);
});
