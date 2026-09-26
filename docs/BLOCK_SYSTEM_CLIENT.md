# LATENT Block System — kliens oldal

> A teljes terv és a végrehajtási lista a szerver repóban van:
> `enzoonchain/latent-server` → `docs/BLOCK_SYSTEM_EXECUTION_PLAN.md`.
> Ez a fájl azt rögzíti, mit jelent a Block System **ennek a repónak**.

## Alapelv: a kliens nem változik

A Block System elszámolási réteg a meglévő hirdetési modell fölött. A kliensek
(Claude Code / Grok status line, VS Code / Cursor extension, OpenClaw plugin,
Hermes, Python SDK) **ugyanazt küldik, mint ma**: `/ad/request`,
`/ad/impression`, `/ad/click` a `protocol/openapi.yaml` szerint. Nem nyúlunk az
LLM request/reply-hoz, és nem kerül be új hirdetési felület.

## Amitől a szerver függ: az `agent` és `surface` értékek

A szerver ebből a két mezőből képezi le a block felületet
(`latent-server/server/blocks/surfaces.py`). Ezek mostantól szerződésnek
számítanak — egy új vagy átnevezett érték a szerveren is változtatást igényel.

| Kliens | `agent` | `surface` | Block felület |
| --- | --- | --- | --- |
| Claude Code status line / hook | `claude-code` | `status_line` | ambient |
| Grok Build | (status line) | `status_line` | ambient |
| OpenClaw | `openclaw` | `response_footer` | ambient |
| Hermes (CLI, Desktop) | `hermes`, `hermes-desktop` | `response_footer`, `thinking_state` | ambient |
| Python SDK (MCP, CLI, Telegram) | `mcp`, `cli`, `telegram` | `response_footer` | ambient |
| VS Code / Cursor extension | `claude-code`, `codex` | `spinner`, `statusbar`, `cursor` | premium |
| Hermes WebUI | `hermes-webui` | `webui_thinking` | premium |

**Figyelem:** a VS Code / Cursor extension ugyanazzal az `agent` értékkel
(`claude-code`) számláz, mint a Claude Code CLI, ezért a szerver **a `surface`
alapján** dönt. Szabály: a CLI felületek soha nem küldhetnek `spinner`,
`statusbar` vagy `cursor` értéket, az IDE felületek soha nem küldhetnek
`status_line`-t. Ezt a C1 teszt rögzíti.

## Kliens-oldali végrehajtási tételek

| ID | Feladat | Hol | Függ | Állapot |
| --- | --- | --- | --- | --- |
| C1 | Teszt, amely rögzíti a fenti `surface` szabályt (CLI ↔ IDE értékek nem keveredhetnek) | `cli/tests/surface-contract.test.mjs` | — | ✅ |
| C2 | `latent status`: holding tier, aznapi tényleges szorzó, napi boost plafon | `cli/src/holding.ts`, `cli/src/index.ts` (`GET /accounts/status?wallet=`) | szerver tier endpoint (E7.5) ✅ | ✅ |
| C3 | `protocol/openapi.yaml`: új publikus végpontok (block statisztika, tier, Spotlight), amint a szerveren élnek | `protocol/` (`/accounts/status`, `/spotlight`, `/blocks/market`) | szerver E3/E8 ✅ | ✅ |
| C4 | Hálózat: Base Sepolia (teszt) → Robinhood Chain (4663), a kifizetés USDG-ben (DEC-1 ✅). Az EVM kulcs és a cím változatlan; a szerver dönti el a láncot és a tokent. A kliensben csak a megjelenített szöveg ("USDC on Base") és a README változik | `cli/src/`, README | DEC-1 ✅ | ⬜ |
| C5 | Mock szerver (`tools/`) bővítése az új végpontokkal, hogy a kliens hálózat nélkül fejleszthető maradjon | `tools/mock-ad-server.mjs` (`MOCK_TIER=0..3`) | C3 ✅ | ✅ |
