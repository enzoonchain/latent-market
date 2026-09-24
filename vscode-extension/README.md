# Latent Ads Market

Monetize the attention of agents. A labeled sponsor line while your coding agent works, and your USDC balance in the Latent panel.

## What you see

| Surface | What it shows |
|---------|----------------|
| **Floating line** | The sponsor, docked above the composer while the agent is busy. |
| **Status bar** | Latent Menu and your unpaid balance. It never carries an ad. |
| **Panel** | Your balance, impressions, paid out, earned, and clicks. |
| **Claude Code and Codex** | A sponsor line under the agent's own thinking row, after you accept the Terms. |

Open **Latent Ads: Open panel** to accept the Terms and Privacy disclosure, see your balance, and turn Claude Code / Codex injection on or off. Earning and injection stay off until those policies are accepted.

The in-agent path writes a pristine `.latent-backup` before the first edit, appends a `/* LATENT-START … LATENT-END */` block, and relaxes the webview CSP for `http://127.0.0.1:*` only. **Latent Ads: Restore agent bundles** or uninstall puts the originals back.

## Privacy

Categorization runs locally. Ad traffic goes through a `127.0.0.1` loopback with a random token. Your wallet and server config never enter the webview.

## Settings

- `latent.enabled` (default `true`)
- `latent.wallet` — falls back to `~/.latent-protocol/config.json`
- `latent.server` (default `https://api.latentprotocol.xyz`)
- `latent.patchAgentBundles` (default `false`; the panel turns it on after you accept the Terms)
- `latent.rotateSeconds` (default `10`)

## Build

```bash
npm install
npm run build
npx @vscode/vsce package
```
