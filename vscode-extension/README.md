# Latent Protocol — VS Code / Cursor extension

Earn USDC while your coding agent thinks. Shows a **labeled** sponsor line in the
agent's spinner/status area, on the same 10-second rotation the CLI hooks use.

## Display paths

| Path | When | What it touches |
|------|------|-----------------|
| **Status bar earnings** | Always | Nothing outside this extension. Click opens the Latent panel. |
| **Status bar sponsor line + sidebar card** | After you accept the Terms | Nothing outside this extension |
| **Claude Code and Codex spinner** | After you accept the Terms | Injects a reversible block into each installed agent bundle |

Open **Latent: Open panel** to accept the Terms and Privacy disclosure, see your USDC balance, and turn Claude Code / Codex injection on or off. Earning and injection stay off until those policies are accepted. A policy version change asks again and removes injections until you accept.

The in-agent path writes a pristine `.latent-backup` before the first edit (or rebuilds that backup by stripping a leftover Latent block), appends a `/* LATENT-START … LATENT-END */` block, relaxes the webview CSP for `http://127.0.0.1:*` only, and re-asserts every 60s. **Latent: Restore agent bundles** or uninstall puts the originals back. If another tool already patched a bundle, Latent asks before replacing it.

## Privacy

Categorization runs locally over your workspace manifests; only a category slug
leaves the machine. All ad traffic goes through a `127.0.0.1` loopback with a
random token — your wallet/server config never enters the webview context.

## Settings

- `latent.enabled` (default `true`)
- `latent.wallet` — falls back to `~/.latent-protocol/config.json`
- `latent.server` (default `https://api.latentprotocol.xyz`)
- `latent.patchAgentBundles` (default `false`; the panel turns it on after you accept the Terms)
- `latent.rotateSeconds` (default `10`)

## Release

Tag a GitHub Release `vscode-v0.4.0` (must match `package.json`). [`.github/workflows/vscode-release.yml`](../.github/workflows/vscode-release.yml) attaches `latent-protocol-vscode.vsix`. Publisher is `latent-protocol`. Open VSX / VS Code Marketplace submission still needs a 128×128 `icon` in `package.json` before the listing can be published; until then `latent init` installs the GitHub VSIX.

## Build

```bash
npm install
npm run build      # → dist/extension.js
# package with: npx @vscode/vsce package
```
