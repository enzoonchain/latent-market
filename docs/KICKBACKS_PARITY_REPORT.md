# Kickbacks.ai Parity Report — Latent Market Extension Strategy

**Dátum:** 2026-09-22  
**Verzió:** 1.0  
**Scope:** Kickbacks.ai (v3.1.7) vs Latent Protocol (latent-market + latent-server) összevetés, és roadmap a saját Kickbacks-szerű extension felépítésére a Latent backenden.

---

## Executive Summary

A Latent Protocol **már ~40%-ban rendelkezik** a Kickbacks.ai extension alapvető építőelemeivel: loopback privacy boundary, opcionális webview bundle patch, status bar + sidebar placement, local classify, wallet-alapú USDC payout, és killswitch. A Kickbacks.ai production-ready, mélyen invazív (compiled bundle surgery), account/Stripe-alapú, és teljes viewability billing funnellel rendelkezik.

**Ajánlás:** Ne másoljuk 1:1 a Kickbacks modellt. Építsünk **Kickbacks-szintű UX-et** (in-UI placement, viewability billing, earnings status bar) a **Latent differenciátorokon** (open source, wallet/USDC, privacy-first, multi-agent CLI, self-hostable backend).

**Becsült effort:** 7–8 hét, 4 fázisban (Extension MVP → In-UI placement → Server upgrade → Distribution).

---

## 1. Kontextus

### 1.1 Cél

A Latent Market VS Code/Cursor extensionjét Kickbacks.ai-szintű termékre fejleszteni, **a saját `latent-server` backendre** építve — nem Kickbacks infrastruktúrára.

### 1.2 Vizsgált komponensek

| Repo / Artifact | Path | Szerep |
|---|---|---|
| **Kickbacks.ai extension** | `~/.cursor/extensions/kickbacksai.kickbacks-ai-3.1.7/` | Benchmark (closed, production) |
| **latent-market** | `latent/latent-market/` | Aktív client SDK + vscode-extension |
| **latent-server** | `latent/latent-server/` | FastAPI ad server, earnings, x402 |
| **agent-kickbacks** | `latent/agent-kickbacks/` | Legacy fork (ugyanaz a vscode-extension shape) |

### 1.3 Lokális állapot (2026-09-22)

Mindkét extension **egyszerre fut** a gépen:

- **Kickbacks.ai:** aktív, tier1, serve v2 enabled, debug log friss
- **Latent Protocol:** config + health.json aktív, de `hook-state.json` → `ad: null`
- **Hook conflict:** Kickbacks felülírta a Latent Claude CLI statusline hookját  
  (`~/.kickbacks/cli-prev-statusline.json` → Latent `statusline.mjs` command)

---

## 2. Összehasonlító elemzés

### 2.1 Alapmodell

| Dimenzió | Kickbacks.ai | Latent Protocol |
|---|---|---|
| **Licenc** | Closed / proprietary | Apache-2.0, self-hostable |
| **Payout** | Account + Stripe (fiat) | USDC on Base, wallet cím |
| **Install** | VS Code/Cursor Marketplace | `npx latent-protocol init` + extension |
| **Backend** | GCP Cloud Run | `api.latentprotocol.xyz` / saját FastAPI |
| **Revenue split** | Opaque | 50% user / 30% operator / 20% protocol |
| **Stage** | v3.1.7 production | v0.1.4-beta, Base Sepolia |

### 2.2 Ad placement — invazivitás

| Surface | Kickbacks | Latent |
|---|---|---|
| **Claude Code webview** | Bundle patch (default ON) — ~3500 sor injektált JS | Bundle patch (opt-in OFF) — marker-delimited block |
| **Codex IDE webview** | Bundle patch | Bundle patch (opt-in) |
| **Claude CLI** | `settings.json` statusLine + spinnerVerbs | CLI `init` → `statusline.mjs` (extension nem patch-el) |
| **Cursor** | workbench.html patch (opt-in, default OFF) | Nincs workbench patch |
| **VS Code status bar** | Live earnings + tier tag | Sponsored text, earnings csak command |
| **További agentek** | — | Grok, MiMo, Hermes, OpenClaw, Telegram, MCP |

**Kulcs különbség:** Kickbacks a **compiled bundle-be ír** → natív spinner placement, de törékeny extension update-ekre. Latent **külső scripteket** futtat config patch-en keresztül → kevésbé invazív, kevésbé natív UI.

### 2.3 Billing / viewability

**Kickbacks funnel:**
```
impression_rendered → impression_viewable → view_tick (10s) → view_threshold_met (≥10s) → credit
```
- Session token binding
- Focus tracking
- Fraud status polling
- Supplier mirror (Gravity, Velocity)

**Latent funnel:**
```
POST /ad/request → megjelenítés → POST /ad/impression (displayed_ms, HMAC token)
```
- `MIN_VIEW_MS = 3000` server-side floor
- `event_uuid` idempotency (client küldi, server részben támogatja)
- Killswitch + incident circuit breaker
- Nincs granular view_tick / threshold event

### 2.4 Privacy

| | Kickbacks | Latent |
|---|---|---|
| **Private tier** | Pseudonim, nincs prompt egress | Mindig local classify → category slug only |
| **Boosted tier** | Prompt, reply, repo metadata → magasabb bid | Nincs |
| **Consent** | Earn-tier panel + checkbox | Wallet + config |

### 2.5 Security

| Layer | Kickbacks | Latent |
|---|---|---|
| **Auth** | OAuth + refresh token (`~/.kickbacks/auth.json`) | Wallet + EIP-191 (earnings/payout) |
| **Loopback** | Token-gated `127.0.0.1` proxy | Token-gated `127.0.0.1` proxy ✅ |
| **Billing integrity** | Session tokens, multi-stage metrics | HMAC impression/click tokens |
| **Fail-safe** | Kill switch | Kill switch + unreachable = pause ✅ |
| **Prompt injection** | Scrub pipeline (Boosted) | Fence for Codex `additionalContext` ✅ |

### 2.6 API összehasonlítás

**Kickbacks backend** (`kickbacks-backend-gmdaqm2c7q-uw.a.run.app`):
- `POST /v2/serve`, `/v2/serve/next`
- `POST /v1/metrics` (billing events)
- `GET /v1/earnings`
- `GET /v1/killswitch`
- `POST /v1/fleet/heartbeat`
- OAuth auth flow

**Latent backend** (`api.latentprotocol.xyz`):
- `POST /ad/request`, `/ad/impression`, `/ad/click`
- `GET /earnings/{wallet}` (EIP-191 signed)
- `GET /killswitch`
- `POST /campaign/*`, x402 funding
- OpenAPI contract + mock server

---

## 3. Gap Analysis

### 3.1 Extension (client) — hiányzó funkciók

| # | Feature | Prioritás | Effort |
|---|---|---|---|
| E1 | Viewability funnel client (`metrics.ts`) | P0 | M |
| E2 | Earnings status bar (live balance) | P0 | S |
| E3 | Claude CLI hook extensionből (`claude-cli.ts`) | P0 | M |
| E4 | Hook conflict detection (Kickbacks/other) | P0 | S |
| E5 | Wallet setup wizard (első indítás) | P1 | M |
| E6 | Portfolio / ad queue rotation | P1 | M |
| E7 | Bundle patch default ON + consent screen | P1 | M |
| E8 | CSP relax automatikus | P1 | S |
| E9 | Update watcher + fossil remint | P1 | L |
| E10 | Cursor workbench overlay (opt-in) | P2 | L |
| E11 | Auto-update VSIX pipeline | P2 | M |
| E12 | `activationEvents: "*"` (always-on) | P2 | S |

### 3.2 Server (latent-server) — hiányzó funkciók

| # | Feature | Prioritás | Effort |
|---|---|---|---|
| S1 | Viewability events endpoint (`/v1/metrics`) | P0 | M |
| S2 | `MIN_VIEW_MS` → 10000 (Kickbacks parity) | P0 | S |
| S3 | Session token binding | P1 | M |
| S4 | Serve v2 / portfolio queue | P1 | L |
| S5 | `event_uuid` dedup enforcement | P1 | S |
| S6 | Click token requirement (SECURITY_HARDENING S6) | P1 | M |
| S7 | Fraud heuristics (dwell, velocity) | P2 | L |
| S8 | Proxy headers fix (rate limit) | P1 | S |

### 3.3 Amit már megvan (ne építsd újra)

| Komponens | Fájl |
|---|---|
| Loopback privacy boundary | `vscode-extension/src/loopback.ts` |
| Bundle patcher (reversible) | `vscode-extension/src/patcher.ts` |
| Injected webview block | `vscode-extension/src/block.ts` |
| Status bar + sidebar card | `vscode-extension/src/extension.ts`, `card.ts` |
| Local classify | `vscode-extension/src/classify.ts` |
| Ad copy sanitization | `vscode-extension/src/urlsafe.ts`, `cli/src/sanitize.ts` |
| Killswitch (fail-safe) | `vscode-extension/src/health.ts`, `cli/src/killswitch.ts` |
| Ad request/impression API | `latent-server/server/routes/ads.py` |
| Wallet earnings + payout | `latent-server/server/routes/earnings.py`, `payouts.py` |
| Multi-agent CLI surfaces | `cli/src/surfaces/*` |
| OpenAPI + mock server | `protocol/openapi.yaml`, `tools/mock-ad-server.mjs` |

---

## 4. Ajánlott architektúra (target state)

```
┌─────────────────────────────────────────────────────────────┐
│  Latent Extension v1 (latent-market/vscode-extension)       │
├─────────────────────────────────────────────────────────────┤
│  extension.ts    — lifecycle, activation, commands          │
│  loopback.ts     — 127.0.0.1 proxy (ad, impression, click)  │
│  metrics.ts      — viewability funnel (NEW)                 │
│  statusbar.ts    — earnings display (NEW)                     │
│  claude-cli.ts   — settings.json patch (NEW)                │
│  portfolio.ts    — ad queue rotation (NEW)                  │
│  conflict.ts     — hook ownership detection (NEW)           │
│  patcher.ts      — bundle + CSP patch                         │
│  block.ts        — injected webview UI                        │
└──────────────┬──────────────────────────────────────────────┘
               │
    ┌──────────┼──────────┬──────────────┐
    ▼          ▼          ▼              ▼
 Claude     Codex     Cursor        Claude CLI
 webview    webview   workbench     statusline
 (patch)    (patch)   (opt-in)      (settings.json)
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│  latent-server (FastAPI)                                    │
│  POST /ad/request  →  impression_token                      │
│  POST /ad/impression  ←  displayed_ms ≥ MIN_VIEW_MS         │
│  POST /v1/metrics  ←  view_tick, threshold (NEW)            │
│  GET  /earnings/{wallet}  ←  EIP-191 signed                 │
│  GET  /killswitch                                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Implementációs roadmap

### Phase 1 — Extension MVP (2–3 hét)

**Cél:** Marketplace-ready extension, saját Latent backenden, Kickbacks UX-hez közel.

| Task | Deliverable |
|---|---|
| `metrics.ts` | Viewability funnel: 10s tick → threshold → impression |
| `statusbar.ts` | Live USDC balance a status barban |
| `claude-cli.ts` | Extension patch-eli `~/.claude/settings.json` statusLine-t |
| `conflict.ts` | Warning ha Kickbacks/más extension foglalja a hookot |
| Wallet wizard | Első indítás: wallet beállítás vagy `npx latent-protocol init` link |
| Refactor `extension.ts` | Moduláris lifecycle |

**Exit criteria:**
- Extension induláskor aktiválódik, status bar mutat earnings-t
- Claude CLI statusline Latent scriptet futtat (conflict-free vagy warning)
- Viewability: ≥10s visible → 1 billed impression
- Kickbacks coexistence: explicit conflict UI

### Phase 2 — In-UI Placement (2 hét)

**Cél:** Natív spinner placement Kickbacks-szinten.

| Task | Deliverable |
|---|---|
| Consent screen | Első indítás: bundle patch ajánlás |
| Default patch ON | `patchAgentBundles: true` consent után |
| CSP auto-relax | `connect-src http://127.0.0.1:*` |
| Fossil remint | Backup hiányában pristine recovery |
| Update watcher | Extension update → auto reassert |
| Richer block UI | Pill/banner formátum (nem csak text replace) |

**Exit criteria:**
- Claude Code spinnerben natív sponsor line (opt-in, de ajánlott)
- Patch survive-ol extension update-et (reassert <60s)

### Phase 3 — Server Upgrade (2 hét)

**Cél:** Backend támogassa a viewability billinget és portfolio-t.

| Task | Deliverable |
|---|---|
| `POST /v1/metrics` | Unified metrics endpoint (vagy impression-only threshold) |
| `MIN_VIEW_MS = 10000` | Kickbacks parity dwell floor |
| Session binding | Impression token + session_id |
| `POST /v2/serve` | Portfolio queue, idle ads |
| `event_uuid` dedup | Server-side idempotency |
| Click token (S6) | Forgeable click fix |

**Exit criteria:**
- Billing csak ≥10s view után
- Portfolio rotation server-side
- Click attribution token-gated

### Phase 4 — Distribution (1 hét)

| Task | Deliverable |
|---|---|
| VSIX build pipeline | GitHub Actions → artifact |
| Auto-update manifest | GCS vagy Open VSX |
| Marketplace listing | Cursor + VS Code |
| Uninstall hook | `vscode:uninstall` → restore patches |
| README + screenshots | Marketplace assets |

---

## 6. Mit NE másoljunk Kickbacks-ből

| Kickbacks feature | Latent döntés | Indok |
|---|---|---|
| OAuth / Stripe payout | Marad wallet + USDC | Crypto-native differenciátor |
| Boosted tier (prompt egress) | Nincs | Privacy-first positioning |
| Aggressive default patching | Consent + opt-in (ajánlott ON) | Editor stability, trust |
| Closed supplier network | House ads → később third-party | Egyszerűbb MVP |
| Fleet heartbeat telemetry | Minimális health ping | Privacy, complexity |
| `debug.log` default-on | Opt-in debug | Noise reduction |

---

## 7. Kockázatok

| Kockázat | Súlyosság | Mitigáció |
|---|---|---|
| Extension update törékenység | Magas | Backup + reassert + fossil remint |
| Hook conflict (Kickbacks/Latent) | Magas | `conflict.ts` + egy extension policy |
| Billing fraud (self-reported dwell) | Közepes | Server `MIN_VIEW_MS`, session tokens, rate limits |
| Editor stability (injected JS) | Magas | Prime directive: never throw; guarded paths |
| Rate limit false positives (proxy IP) | Közepes | `--proxy-headers` fix (SECURITY_HARDENING S1) |
| Marketplace review rejection | Közepes | Consent screen, reversible patches, clear labeling |

---

## 8. Versenyképességi pozíció

### Latent erősségek (megtartandó)

1. **Open source + self-hostable** — nincs vendor lock-in
2. **Crypto-native payout** — USDC, x402, transparent split
3. **Multi-agent coverage** — 8+ surface vs Kickbacks 4
4. **Privacy default** — category slug only, nincs prompt egress
5. **Developer-friendly** — OpenAPI, mock server, nincs account signup

### Kickbacks erősségek (követendő)

1. **In-UI native placement** — spinner/pill/banner az agent panelben
2. **Viewability billing funnel** — multi-stage, fraud-resistant
3. **Production maturity** — auto-update, fleet ops, supplier network
4. **Fiat payout** — alacsonyabb friction non-crypto usereknek
5. **Marketplace distribution** — one-click install

### Positioning statement

> **Latent Protocol** = open, crypto-native, privacy-first coding agent monetization.  
> **Kickbacks.ai** = closed, fiat-native, deep UI integration ad network.  
>  
> Cél: Kickbacks UX + Latent values.

---

## 9. Következő lépések

### Azonnali (ez a hét)

1. [ ] Döntés: Kickbacks uninstall vagy coexistence policy
2. [ ] Phase 1 kickoff: `metrics.ts` + `statusbar.ts` + `claude-cli.ts`
3. [ ] Server: `MIN_VIEW_MS` 3000 → 10000 érték felülvizsgálat

### Rövid táv (2–4 hét)

4. [ ] Phase 1 MVP merge + internal dogfood
5. [ ] Conflict detection + consent screen
6. [ ] Proxy headers fix (latent-server S1)

### Közép táv (1–2 hónap)

7. [ ] Phase 2 in-UI placement
8. [ ] Phase 3 server metrics/portfolio
9. [ ] Phase 4 marketplace publish

---

## 10. Függelék

### A. Fájlreferenciák

| Artifact | Path |
|---|---|
| Latent vscode-extension | `latent-market/vscode-extension/src/` |
| Latent CLI API client | `latent-market/cli/src/api.ts` |
| Latent ad routes | `latent-server/server/routes/ads.py` |
| Security backlog | `latent-market/docs/SECURITY_HARDENING.md` |
| Ad placement strategy | `latent-market/docs/AD_PLACEMENT_STRATEGY.md` |
| Kickbacks extension | `~/.cursor/extensions/kickbacksai.kickbacks-ai-3.1.7/` |
| Kickbacks state | `~/.kickbacks/` |
| Latent state | `~/.latent-protocol/` |

### B. Lokális config snapshot (2026-09-22)

**Kickbacks** (`~/.kickbacks/config.json`):
- `serveV2Enabled: true`
- `earnTier: tier1`
- `cursorOverlayEnabled: false`
- `debugMode: true`

**Latent** (`~/.latent-protocol/config.json`):
- `wallet: 0x7331...0bcf`
- `server: https://api.latentprotocol.xyz`
- `spinner_verbs: true`

### C. Kapcsolódó dokumentumok

- [SECURITY_HARDENING.md](./SECURITY_HARDENING.md) — server + client security backlog
- [AD_PLACEMENT_STRATEGY.md](./AD_PLACEMENT_STRATEGY.md) — platform-specific placement guide
- [protocol/openapi.yaml](../protocol/openapi.yaml) — HTTP contract

---

*Report generated from codebase analysis and live system inspection on 2026-09-22.*
