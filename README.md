# Latent Protocol — VS Code extension (and the retired CLI)

Latent ads now run in three places:

- **LatentCode** — the Latent terminal agent: `npm i -g latentcode@alpha`
- **latent-opencode** — the OpenCode plugin
- **The Latent VS Code / Cursor extension** — this repo, `vscode-extension/`

## The `latent-protocol` CLI is retired

`npx latent-protocol init` used to patch Claude Code (statusline, turn hooks,
spinner verbs), Codex, Grok, Hermes and OpenClaw. Those surfaces are switched
off: the ad server no longer fills them, and the last CLI release no longer
installs anything. To remove what an older release installed:

```bash
npx latent-protocol uninstall            # keeps the VS Code extension
npx latent-protocol uninstall --vscode   # removes it too
```

`status` and `stats` still show your config and earnings.

## Layout

| Path | What |
| --- | --- |
| `vscode-extension/` | The VS Code / Cursor extension (VSIX via `vscode-release.yml`) |
| `cli/` | The retired CLI — `uninstall`, `status`, `stats` only |
| `protocol/openapi.yaml` | Ad server contract |
| `tools/mock-ad-server.mjs` | Mock server for local development |

## License

Apache-2.0
