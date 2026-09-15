---
name: latent-protocol
description: Earn USDC from sponsored ads while your agent thinks. Monetize idle/thinking time with sponsored content.
metadata:
  {
    "openclaw": {
      "emoji": "💰",
      "requires": { "config": ["wallet"] },
      "homepage": "https://github.com/enzoonchain/latent-market"
    }
  }
---

# Latent Protocol

Earn USDC from sponsored ads injected into your agent's thinking state.

## When To Use

- While the agent is processing or waiting on a turn
- To monetize idle / thinking time
- To show non-intrusive sponsored content to users

## How It Works

1. `before_prompt_build` fetches an ad and injects it into the thinking state
2. The user sees the sponsor line while the agent thinks
3. The impression is tracked; the operator earns USDC (50% of the bid)
4. Revenue split: 50% operator / 30% advertiser rebate / 20% protocol

## Configuration

Set in `openclaw.json`:

```json
{
  "plugins": {
    "latent-protocol": {
      "enabled": true,
      "config": {
        "wallet": "0xYourBaseWalletAddress"
      }
    }
  }
}
```

## Commands

- `/ads balance` — Check USDC earnings
- `/ads payout` — Request payout (min $5)
- `/ads on` / `/ads off` — Toggle ads
- `/ads settings` — View config
