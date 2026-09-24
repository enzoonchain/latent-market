# Security hardening backlog

From a full review of the client surfaces and `enzoonchain/latent-server`
(2026-09), with reference to prior art in agent-ad clients. Ranked P0 → P3.
Items marked **✅ shipped** are done; the rest are the backlog, each with the
file to change.

> **Wallet auth decision:** no Lit / Vincent dependency. `LIT-Protocol/agent-wallet`
> is archived and the earnings wallet only *receives* USDC. Ownership proof for
> the sensitive endpoints is a plain EIP-191 signature (`ecrecover`). Revisit
> Vincent only if the agent ever needs to *spend* earnings.

---

## Shipped

| Item | Where | PR |
|---|---|---|
| ✅ No runtime `npx` (Claude Code) | `cli/src/surfaces/claude-code.ts` | latent-protocol #9 |
| ✅ Comment-safe, parse-guarded `settings.json` edits + backup/restore | `cli/src/surfaces/json-settings.ts` | #10 |
| ✅ `spinnerVerbs` surface, `claude --version` gated | `cli/src/surfaces/claude-spinner.ts` | #11 |
| ✅ Whole CLI bundled, `dependencies: {}`, npm publish workflow | `cli/scripts/bundle.mjs` | #13 |
| ✅ No runtime `npx` (Codex) | `cli/src/surfaces/codex.ts` | #14 |
| ✅ MiMo Code split into its own native-plugin surface (was wrongly grouped with Codex's `hooks.json`) | `cli/src/surfaces/mimo.ts` | (this PR) |
| ✅ Killswitch + local incident guard; extension esbuild bundle | `cli/src/killswitch.ts`, `vscode-extension/` | #15, #17 |
| ✅ Ad-copy sanitisation (ANSI/control/bidi) at every render sink | `cli/src/sanitize.ts` | #18 |
| ✅ VS Code sidebar-card XSS (`javascript:` href) + CSP + first vitest | `vscode-extension/src/card.ts`, `urlsafe.ts` | #19 |
| ✅ Killswitch fail-safe polarity (5xx/timeout ⇒ pause) | `cli/src/killswitch.ts`, `vscode-extension/src/health.ts` | #20 |
| ✅ Prompt-injection fence for `additionalContext`; status line classifies the prompt; `event_uuid` on impressions | `cli/src/hook.ts`, `cli/src/statusline.ts`, `cli/src/api.ts` | #21 |
| ✅ **Server: free budget minting** — `settle_payment_or_402` raises 501 when x402 off; `fund`/`buy` credit only on `settled` | `server/x402_payments.py`, `server/routes/campaigns.py` | latent-server #90 |
| ✅ **Server: signing-secret boot guard** — refuse prod without `IMPRESSION_SIGNING_SECRET`; `/health` flag | `server/security.py`, `server/main.py` | #90 |
| ✅ **Server: payout ownership proof** — EIP-191 signature, per-tx cap, rate limit | `server/payout_auth.py`, `server/routes/payouts.py` | #90 |

---

## P0 — remaining

_None open._ The four P0s (free budget mint, signing secret, unauthenticated
payout, no `user_wallet` verification on the money path) are covered by
latent-server #90 for the payout/budget path. `user_wallet` on `/ad/request`
+ `/ad/impression` stays unauthenticated **by design** — the HMAC
`impression_token` binds `(ad_id, user_wallet)` so you can't bill an impression
for an ad you weren't served; earnings inflation is bounded by the campaign
budget debit + the daily cap. Tightening it further is P1 (session auth).

---

## P1

### Server

| # | Issue | Fix |
|---|---|---|
| S1 | **Rate limiting sees the proxy IP.** `uvicorn` runs without `--proxy-headers`, so behind Railway's edge every request looks like a handful of proxy IPs → the 30/min per-IP cap throttles the *whole platform* and per-IP abuse control is meaningless. A likely cause of the constant 204s. | `Dockerfile` — `CMD uvicorn … --proxy-headers --forwarded-allow-ips='*'`; parse `X-Forwarded-For` in `server/routes/ads.py:_client_ip`. |
| S2 | **Open redirect / phishing.** `GET /ad/click` → `RedirectResponse(cta_url)`; `cta_url` is unvalidated at ad creation and `POST /campaign/{id}/ad` is unauthenticated. | `server/models.py` `AdCreate.cta_url` — validate `https://` scheme + block `javascript:`/`data:`; `server/routes/ads.py` — consider returning JSON instead of a 302. |
| S3 | **`/campaign/*` fully unauthenticated** — attach ads to anyone's campaign; `GET /campaign/` with no filter dumps every advertiser wallet + budget + ad copy. | `server/routes/campaigns.py` — advertiser session/API-key; `WHERE advertiser_wallet = :caller` on `{id}/ad`, `{id}/fund`, `{id}/buy`; restrict the unfiltered list. |
| S4 | **`/earnings/{wallet}[/history|/ads]` + `/payout/{wallet}` unauthenticated & enumerable**, leak prompt-derived `context`. | `server/routes/earnings.py`, `server/routes/payouts.py` — gate behind the same EIP-191 signature as `/payout/request` (`server/payout_auth.py`). |
| S5 | **Impression token replayable ~4–5×** — `IMPRESSION_REPLAY_WINDOW_SECONDS` (60s) < token TTL (300s). | `server/config.py` — set the dedup window ≥ TTL, or make tokens single-use via a `jti` set (Redis) in `server/security.py` + `server/tracker.py:log_impression`. Also honour the client's `event_uuid` (shipped in #21) for idempotent dedupe. |
| S6 | **`/ad/impression` + `/ad/click`: no rate limit, no kill-switch check; `/ad/click` has no token** and `CLICK_MULTIPLIER=50` — anyone who logged an impression can wait 2s and POST a click for 50× payout. | `server/routes/ads.py` — `check_rate_limit` + kill-switch gate on both; add `make_click_token`/`verify_click_token` (mirror the impression token) and require it on `/ad/click`. Pairs with client **C4** below. |
| S7 | **No fraud heuristics.** `safety.py` is a blocklist + a global kill bool. No per-IP impression velocity, wallet-age gating, impression:click ratio anomaly, wallet-cluster (shared IP) detection, dwell-time check. `displayed_ms` sent by the client is silently dropped. | new `server/fraud.py`; hold earnings above a threshold for review. |
| S8 | **`GET /killswitch` does not exist** (only `GET /ad/safety`, 200 even when false; toggle = env + redeploy). Client PR #20 tolerates 404. | new `server/routes/killswitch.py` → `{killed, scope, reason}` backed by a `kill_flags` DB row, toggled by `POST /admin/killswitch`; gate `/ad/impression` + `/ad/click` too. Then drop the client's 404 tolerance in `cli/src/killswitch.ts`. |
| S9 | `/health` `schema_error` raw leak (**fixed in #90** — now a generic message); `/ad/leaderboard` `limit` unclamped; `GET /campaign/{id}/status` is a public debug dump. | `server/routes/ads.py` clamp `limit`; gate `/campaign/{id}/status` behind admin/owner. |

### Client / front

| # | Issue | Fix |
|---|---|---|
| C1 | **Forgeable `/ad/click`** — OpenClaw footer + Python adapters build `GET /ad/click?ad=&w=`; no token. | `openclaw-plugin/src/lib/footer.ts`, `latent_protocol/tracker.py` — send the `click_token` from **S6**; add a client-side minimum-dwell floor (~15s of on-screen time) before a click is counted. |
| C2 | ~~Hermes WebUI CTA href — no scheme check.~~ **Fixed:** the WebUI surface is now a WebUI extension (`cli/templates/hermes-webui-extension/latent-ads.js`) that builds the DOM with `textContent`, links only `https://` or the signed `/ad/click` redirect, and sends the category slug only. The same change removes the server-source edits older releases made to WebUI checkouts (see `removeLegacyWebuiPatches` in `cli/src/surfaces/hermes-webui.ts`); init and uninstall both clean them up. | — |
| C3 | ~~OpenClaw model-context injection.~~ **Fixed:** the plugin no longer uses `before_prompt_build` or `session_start`; its only surface is a footer added in `reply_payload_sending` (outbound delivery, never the model transcript), billed on a successful `message_sent`. | — |
| C4 | ~~OpenClaw raw prompt leak.~~ **Fixed:** only the locally classified category slug is sent as `context` (`openclaw-plugin/src/lib/classify.ts`). | — |

---

## P2

### Server

- **CORS `*`** with wildcard methods/headers → pin to the landing origin(s). `server/main.py`.
- **Container runs as root**, `COPY . .` ships `.git` + `landing/` + `cli/`. `Dockerfile` + `.dockerignore` — multi-stage, `USER app`, copy only `server/` + `scripts/` + `pyproject.toml`.
- **No Alembic** — schema applied as raw multi-statement SQL at boot; a mid-file failure serves on an unverified schema. Adopt Alembic (already a dev dep); gate boot on a clean migration.
- **In-memory caches** (`safety._user_requests`, `matcher._inventory_cache`/`_daily_caps`/`_last_shown`) break on >1 replica → caps multiplied. Redis, or pin to 1 replica and document.
- **Payout tx** is legacy-type with hardcoded `gas`, a single public RPC (`mainnet.base.org`), no gas-tank pre-flight check, no shared nonce lock between the manual path and the sweep. `server/payout_engine.py` — EIP-1559, `eth_estimateGas`, RPC fallback list, ETH balance check, `asyncio.Lock`.
- **Retention** hard-deletes `ad_events` (the only fraud trail) at 90d; `impressions`/`earnings` grow unbounded. `server/retention.py` — archive instead; partition `impressions`.
- **`image_url`** — free-form advertiser string, no validation, stored as-is, returned verbatim; a naive adapter would fetch an attacker-chosen origin from every viewer. `server/models.py` `AdCreate` — require `https://` + a Latent-controlled CDN; proxy/host creative, never hot-link.
- **`MAX_IMPRESSIONS_PER_SESSION`** advertised (`/ad/safety`, `.env.example`) but never enforced — implement or drop the claim.
- **x402 `resource` arg unused** — payment requirements aren't bound to the route/campaign, so identical `amount`s produce identical challenges. `server/x402_payments.py:_build_requirements` — include `resource`.

### Client / front

- **No consent / opt-in anywhere.** `init` creates a wallet + patches every surface immediately; `enabled` defaults true. Add a first-run consent gate — CLI: `--accept-tos` or an interactive y/N in `cmdInit`; VS Code: a `showInformationMessage` (Agree / Privacy Policy) before `startDisplay`. Store the accepted ToS version, re-prompt on a bump, keep ads off until accepted. `cli/src/index.ts`, `vscode-extension/src/extension.ts`.
- **Loopback `Access-Control-Allow-Origin: *`** (`vscode-extension/src/loopback.ts:56`) → reflect the webview origin only; for the mutating `/impression` route require the token in a header (not just the path) + check `Origin`; rotate the token per activation.
- **CSP relaxation over-broad** — `vscode-extension/src/patcher.ts` adds `http://127.0.0.1:*` (all ports) to a signed third-party bundle, reasserted every 60s. Narrow to the exact known port, `connect-src` only; one-time consent explaining the third-party bundle is modified.
- **Extension `test/` not type-checked** — `tsconfig` `include` is `src/**` only; vitest transforms without checking. Add a test tsconfig or a `vitest --typecheck`.

---

## P3

- **Viewability model** — Latent bills on token validity, not on the ad actually being seen. Move to **cumulative visible time**: periodic on-screen heartbeats from the client, a "credited" event once a threshold (e.g. 5–15s) of visible time is reached, a stuck-session safety net, and the server authoritative on the credit. `cli/src/api.ts` — replace the single end-of-turn `displayed_ms` with heartbeats; the server reconstructs real dwell and ignores any report exceeding wall-clock since `/ad/request`.
- **Disclosure** — mostly OK (`Sponsored:` on 6/8 surfaces; #18 fixed the shimmer verb to `✦ Ad:`). Keep one standard token everywhere.
- **A minimal `/v1/*` auth layer** — the server has *no* session/consent layer. A SIWE session + `/v1/killswitch` + `/v1/consent` + `/v1/metrics` (with viewability) would enable an authenticated, consent-gated client model. Sketch, not committed.
- **Distribution integrity** — the server serves no client artifacts (CLI→npm, extension→marketplace, Python→PyPI); the surface is npm/marketplace **provenance**. The CLI publish workflow (#13) already attests provenance; do the same for the extension when it's published to Open VSX + the VS Code Marketplace.
- **Cross-platform CI** — Ubuntu only. Add `macos-latest` + `windows-latest` legs for `cli/tests/*` (the `node "C:\…"` quoting, `homedir` resolution, staged-bundle exec).
- **Install telemetry** — an opt-out anonymous beacon from `init` (`{cli_version, os, agents:[{name,version}], surfaces_patched, errors}`) so field half-installs are visible.

---

## Attacker-capability summary (pre-#90)

| Can an unauthenticated attacker… | Before | After #90 + #18–#21 |
|---|---|---|
| mint free campaign budget | **yes** | no (501 / admin-only grant) |
| forge impression tokens (secret unset) | **yes** | no (server refuses to boot) |
| trigger a payout for any wallet | **yes** (to that wallet) | no (EIP-191 signature) |
| drain the hot wallet in one tx | **yes** | capped ($500 default) |
| read any wallet's balance / prompt-context | **yes** | still yes — **S4** |
| farm earnings via request→impression loops | bounded by budget + 100/day | same; **S7** adds heuristics |
| 50× payout via a tokenless `/ad/click` | **yes** | still yes — **S6 / C1** |
| ANSI-inject the user's terminal via ad copy | **yes** | no (#18) |
| XSS the VS Code webview via `ad.url` | **yes** | no (#19) |
| prompt-inject the model via ad copy | **yes** | fenced (#21); OpenClaw still — **C3** |
