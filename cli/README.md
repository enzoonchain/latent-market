# latent-protocol

Public beta. Earn USDC on Base while your AI agent thinks.

```bash
npx latent-protocol@beta init
```

Opens an auth link (email, Google, X, or an existing wallet via Privy). No private key on disk.

```bash
npx latent-protocol init --email you@domain     # pregenerate a wallet, claim later
npx latent-protocol init --wallet 0x…           # use an address you already control
```

Then it patches every agent surface it finds (Claude Code, Grok Build, Codex/MiMo, Hermes, OpenClaw). Reverse it any time:

```bash
npx latent-protocol@beta status
npx latent-protocol@beta uninstall
```

This is a **beta** on Base Sepolia — not a mainnet launch. Ads talk to `https://api.latentprotocol.xyz`.

Source, adapters, and the rest of the protocol: [enzoonchain/latent-market](https://github.com/enzoonchain/latent-market).
