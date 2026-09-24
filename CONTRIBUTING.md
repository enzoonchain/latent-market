# Contributing to Latent Protocol

The adapters are the point of this repository. Every AI agent exposes idle
time differently, and no single team can keep up with all of them — so a new
adapter, or a fix to an existing one, is the most valuable thing you can send.

## Ground rules for adapters

These are not style preferences. An adapter that breaks them either damages
the host agent or corrupts the earnings ledger, and will not be merged.

1. **Fail open, always.** Every network call, file read, and parse must be
   wrapped so that any failure results in rendering nothing. An ad server
   outage, a malformed response, an expired token — none of these may slow,
   block, or break the host agent. Time-box every request (2s is the norm here).

2. **Never send the user's prompt.** Classify locally and send a category slug
   in `context`. Raw prompt text must not leave the machine. See
   [`cli/src/classify.ts`](cli/src/classify.ts).

3. **Bill only what was displayed.** `POST /ad/impression` goes out once, after
   the sponsored line is actually on screen — never on fetch, never on a timer,
   never speculatively. If two surfaces of the same agent can be live at once,
   exactly one of them owns the impression.

4. **One agent, one identifier.** Every surface of an agent sends the same
   `agent` value, lowercase with hyphens (`claude-code`, not `claude_code`).
   Mismatched identifiers silently split reporting and targeting in half.

5. **Reversible, marked, and never destructive.** An installer that edits a
   user's config must merge into it, not overwrite it: preserve unrelated keys,
   back up anything it replaces, tag its own entries so uninstall removes
   exactly those, and leave the file valid if it dies halfway.

6. **Treat `cta_url` as untrusted.** Render it as a link; never auto-open,
   prefetch, or execute it. Reject anything that is not `https://` or that
   contains control characters before writing it to a terminal.

## Adding a new adapter

1. Read [`protocol/openapi.yaml`](protocol/openapi.yaml). It is the only
   server surface you may depend on.
2. Start the mock ad server — you do not need a real one, or credentials:
   ```bash
   node tools/mock-ad-server.mjs --no-fill=3 --latency=500 --fail=0.2
   export ADS_SERVER=http://127.0.0.1:8899
   ```
3. Model your work on the closest existing surface:
   - config/hook file patching → [`cli/src/surfaces/claude-code.ts`](cli/src/surfaces/claude-code.ts)
   - a plugin the host loads → [`openclaw-plugin/`](openclaw-plugin/)
   - a Python response wrapper → [`latent_protocol/adapters/telegram.py`](latent_protocol/adapters/telegram.py)
4. Prove the failure paths, not just the happy one. Your adapter must be
   provably silent when the server returns 204, 403, 500, or nothing at all.
   Run with `--fail=0.2 --latency=500` and confirm the host agent is unaffected.
5. Watch the mock's log. More than one `impression billed` per displayed ad is
   a bug in your adapter.

## Before you open a pull request

```bash
pip install -e ".[dev]" && pytest -q
npm ci --prefix cli && npm run typecheck --prefix cli && npm run build --prefix cli
node --test cli/tests/*.test.mjs
```

If you changed anything under `openclaw-plugin/`, re-sync the copy that ships
inside the npm package, or CI will fail:

```bash
bash scripts/sync-openclaw-template.sh
```

## Signing off your work

This project uses the [Developer Certificate of Origin](https://developercertificate.org/).
It is a statement that you wrote the contribution, or otherwise have the right
to submit it under the project's license. Add a sign-off line to each commit:

```bash
git commit -s -m "Add adapter for <agent>"
```

Contributions are accepted under [Apache-2.0](LICENSE), the same license the
project ships under.

## Reporting a security issue

Do not open a public issue for anything that could be used to fabricate
impressions, drain a campaign budget, or reach another user's earnings. Report
it privately to the maintainers first.
