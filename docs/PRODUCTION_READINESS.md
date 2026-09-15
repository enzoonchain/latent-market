# Production-readiness analysis — path to public beta

_Last updated: 2026-09-08. Owner: enzoonchain._

Goal for beta: **one entry point per platform loads the correct Latent adapter,
reliably, and is cleanly reversible** — with the network able to pause itself
and the team able to see field failures.

---

## 1. Where the adapters stand

Reliability after PRs #9–#15 (#9–#13 merged; #14, #15 in review).

| Surface | Runtime `npx`/`pip git`? | Non-destructive config edit | Backup + clean uninstall | Version/compat gate | Functional tests | Verdict |
|---|---|---|---|---|---|---|
| **Claude Code** — statusLine + turn hooks | **removed** (#9): local `node` bundle staged to `~/.latent-protocol/bin` | **yes** (#10): `jsonc-parser` minimal edit, refuses unparseable file | **yes** (#10): one-time `.latent-protocol.bak`, byte-exact restore | **yes** (#11): `spinnerVerbs` gated on `claude --version` ≥ 2.1.143 | strong — surface + staged-bundle run + billing accounting | **Beta-ready** |
| **Codex / MiMo** — `hooks.json` | **removed** (#14): shared local `node` bundle | **yes** (#14) | **yes** (#14), shared-bundle refcount | n/a | strong (#14) | **Beta-ready once #14 lands** |
| **VS Code / Cursor extension** — status bar + sidebar | n/a (compiled) | n/a | n/a | n/a | typecheck only; bundle check (#15) | **Medium** — no unit tests |
| **VS Code / Cursor extension** — in-agent spinner patch (opt-in) | n/a | patches minified 3rd-party bundle; pristine `.latent-backup`, marker-delimited, 60 s reassert | pristine backup restore | `VERB_ANCHORS` presence check | **none** | **Riskiest code, least tested** |
| **Hermes CLI plugin** | ⚠️ **`pip install git+…@main`** fallback | Python plugin edits config | partial | none | some | **Medium-risk** — same failure class as the old npx bug, on a quieter surface; `main` moves under installs |
| **Hermes WebUI** — `static/index.html` DOM patch | n/a | index.html patch + CSP | backup | none | `webui-patch.test` | **Medium** |
| **OpenClaw plugin** | copies vendored template | `openclaw.json` edit (not parse-guarded) | partial | none | `desktop-plugin.test` | **Medium** |
| **Telegram / generic CLI / MCP** (`latent_protocol/`) | Python import | n/a | n/a | none | `pytest` | **Early** — not part of the "every platform" install story yet |

### What this session fixed

- The two highest-traffic surfaces (Claude Code, Codex) **no longer re-resolve a
  package on every turn** — that npx-cache thrash was the actual cause of "no ads
  ever load" (10 s hook timeouts, `sh: latent: command not found`, empty installs).
- Config edits are **non-destructive**: a `settings.json` with a syntax error
  the user is mid-fix on is left alone, not overwritten with just our keys;
  comments survive.
- **Backup + byte-exact restore** across Claude Code and Codex.
- **Killswitch** mechanism (`GET /killswitch`; 404 ⇒ not killed) + a **local
  incident guard** (5 consecutive 5xx ⇒ 10-min server-contact backoff) — every
  surface honours both (#15).
- CLI **bundles to one dependency-free `dist/index.js`**; npm-publish workflow
  wired (#13).
- Extension **bundles to one `dist/extension.js`** (#15).

### Structural risks still open

1. **`latent-protocol` is not on npm.** `init` still installs from GitHub —
   one-time, but it runs `prepare` (a full build) on the user's machine and
   needs dev deps. Blocks every skill/plugin wrapper from being fast.
2. **Hermes plugin installs from `git@main`.** Unreleased `main` can break every
   Hermes install in the field with no version pin. Needs PyPI + a pinned range.
3. **The webview patcher has no functional tests.** It edits signed third-party
   extensions; `VERB_ANCHORS` / `findAgentBundles` / `relaxCsp` drift silently
   when Cursor or the Codex extension ship a new bundle.
4. **No marketplace presence.** The extension isn't on the VS Code Marketplace
   or Open VSX, so Cursor/VS Code users have no discovery path.
5. **No unified install surface** (the ask — see §3).
6. **Server-side gaps**: `/killswitch` returns 404; no `surface:"spinner"`
   impression path (spinnerVerbs + extension spinner render but don't bill);
   demo creatives only; fill rate is inconsistent (frequent 204s).
7. **No install telemetry.** When `init` half-patches a surface in the field,
   nobody finds out.
8. **CI is Ubuntu-only.** macOS/Windows path handling — notably the
   `node "C:\…\hook.mjs"` quoting and `homedir()` resolution — is unverified on
   the OSes most users are on.
9. **Host-schema assumptions are hard-coded** with no canary: Claude Code hook
   event names and payload shapes, Codex `hooks.json` schema, the CC webview
   spinner selectors. A host update can silently stop ads.

---

## 2. "Production-ready beta" — exit criteria

A checkbox is done when it is true **and** a CI job or a dashboard proves it.

- [ ] `latent-protocol` published to npm; `npx latent-protocol@latest init`
      completes in **< 5 s cold on macOS, Linux, and Windows**.
- [ ] Every **detected** surface: parse-guarded edit, one-command clean
      uninstall verified byte-exact, at least one functional test, **zero**
      runtime `npx` / `pip install git+`.
- [ ] Extension published to **Open VSX + VS Code Marketplace**; the webview
      patcher has an **anchor-drift check** that disables itself (and reports)
      rather than corrupting a bundle it no longer understands.
- [ ] **One documented install path per platform** (§3) — each verified in CI
      against a fixture of that host.
- [ ] `/killswitch` live server-side; a flip is observed to pause a real
      install within one TTL.
- [ ] `init` emits an **opt-out anonymous install beacon**
      (`{cli_version, os, agents:[{name,version}], surfaces_patched, errors}`)
      and there is a dashboard for it.
- [ ] **Install-matrix CI**: for each `(OS × host-fixture)` —
      `init → assert patched → run the staged runtime against the mock ad
      server → uninstall → assert the config is byte-identical to pristine`.
- [ ] 48-hour field soak on ≥ 25 installs with **< 2 % silent-failure rate**
      (measurable only once the beacon exists).

---

## 3. The unifying goal: one entry point per platform

"One skill, every platform" is not literally one artifact — hosts use
incompatible packaging. It **is** one behaviour: _detect the host, install the
right adapter, be reversible._ `latent-protocol init` already is that behaviour.
Beta needs the wrappers that expose it where each host looks for capabilities.

| Platform | Native mechanism | Wrapper to ship | Under the hood |
|---|---|---|---|
| **Claude Code** | Plugin (`.claude-plugin/`) + skill (`SKILL.md`) | **Claude Code plugin** with a `latent-protocol` skill and a `SessionStart` hook | skill runs `npx latent-protocol@latest init`; hook keeps the staged bundle current |
| **Claude.ai / Claude Desktop** | Skills, MCP connectors | **MCP server** `latent-protocol` (stdio) | tools: `install` `uninstall` `status` `earnings` `set_wallet` |
| **Cursor** | VS Code extensions, MCP | **Marketplace/Open-VSX extension** (already built) + the MCP server | extension is self-contained; MCP for headless |
| **Codex (CLI)** | `hooks.json`, MCP, `AGENTS.md` | `npx latent-protocol init` (now bundled) + optional MCP | #14 makes the hooks local-`node` |
| **Codex / ChatGPT (editor ext)** | webview | the VS Code/Cursor extension's opt-in spinner patch | needs the anchor-drift guard (§2) |
| **OpenClaw** | Plugins + skills | **existing skill** (`openclaw-plugin/skills/latent-protocol`) | point it at the published npm package |
| **Hermes** | pip plugin + WebUI patch | PyPI package `latent-protocol-hermes` | stop using `git@main` |
| **Anything with MCP** (Cline, Continue, Zed, Windsurf, …) | MCP | the **one MCP server** | this is the closest thing to "every platform" |

**The MCP server is the highest-leverage single deliverable** — it makes Latent
installable from any MCP-capable host with no per-host packaging.

---

## 4. Roadmap

### Phase 0 — land + publish (this week)

1. Merge **#14 → #15** into `main` (in order; do not merge them into each other).
2. Add repo secret `NPM_TOKEN`; bump `cli/package.json` to `0.1.4`; cut a
   `cli-v0.1.4` GitHub Release → the publish workflow ships it.
3. Update every `npx github:enzoonchain/latent-protocol …` in docs/skills to
   `npx latent-protocol@latest …`.

_Outcome: fast `init` everywhere; wrappers unblocked._

### Phase 1 — bring the rest of the adapters to the Claude-Code bar

4. **Hermes**: publish `latent-protocol-hermes` to PyPI, pin `>=x,<y`; drop the
   `git+…@main` fallback; parse-guard + backup its config edits.
5. **Extension patcher**: synthetic-webview fixture tests (mirror kickbacks'
   `test/fixtures/synthetic-thinking-shimmer.js`); **anchor-drift guard** — when
   no `VERB_ANCHOR` matches, do not patch, surface a notification, report;
   `restore({ keepCsp })` scoped restore.
6. **OpenClaw**: parse-guard `openclaw.json`; keep the template-sync CI gate.
7. **Cross-platform CI**: add `macos-latest` + `windows-latest` legs for
   `cli/tests/*` (path quoting, `homedir`, staged-bundle exec).

### Phase 2 — the unified install surface

8. **MCP server** `packages/mcp/` — stdio, wraps the CLI; publish to npm; list
   in the MCP registry. Tools: `install`, `uninstall`, `status`, `earnings`,
   `set_wallet`.
9. **Claude Code plugin** — `.claude-plugin/plugin.json` + the skill + a
   `SessionStart` self-update hook; submit to the plugin registry.
10. **Publish the extension** to Open VSX + VS Code Marketplace (release
    workflow, mirroring `publish.yml`).
11. **Install matrix CI** (the §2 job).
12. `docs/INSTALL.md`: the §3 table, one verified command per platform.

### Phase 3 — server + observability (backend track, parallel)

13. `/killswitch` endpoint (client ready).
14. `surface:"spinner"` impression path → unblocks spinnerVerbs + extension
    spinner billing.
15. **Install/health beacon** from `init` (opt-out) + dashboard.
16. Real ad inventory; publish a fill-rate SLO; replace `example.com` creatives.
17. Earnings → payout flow end-to-end on Base.

### Phase 4 — beta

18. Tick every §2 box; 48 h soak; open the beta.

---

## 5. Dependencies / sequencing

```
#13 (merged) ── npm publish workflow
      │
      ├── Phase 0.2 publish ──┬── Phase 2.8 MCP server
      │                       ├── Phase 2.9 CC plugin
      │                       └── Phase 1.4 Hermes → PyPI
      │
#14 ──┴── Codex local bundle ──── Phase 1.7 cross-platform CI
#15 ──── killswitch client ─────── Phase 3.13 /killswitch server
```

Backend items (13–17) do not block the client roadmap and can run in parallel;
only #13 (spinner billing) and #14 (killswitch) have a client counterpart
already shipped and waiting.
