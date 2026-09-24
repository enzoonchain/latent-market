# Latent launch film (30 s)

Coded motion piece: every frame is rendered from `index.html` by a
deterministic `render(t)` function, so edits are just HTML/CSS/JS.

| Time | Beat |
|------|------|
| 0–4s | Terminal on black: prompt typed, agent "thinking", *Your agent is thinking. / And you're… waiting.* |
| 4–7s | Idle status line turns into a sponsored line, `+0.0025 USDC` lands. *What if the wait was worth something?* |
| 7–10.5s | Pull back through the curtains into the sky: *AGENTS DESERVE A BIGGER STAGE.* + LATENT lockup, monument rises |
| 10.5–14s | *One command. Every agent.* — `npx latent-protocol init` detects every agent |
| 14–18.5s | *Your agent works. You get paid.* — 50% payout in USDC or compute (Opus 5.5, GPT‑6 Astra, Gemini, Grok), live community payouts feed |
| 18.5–24s | Advertisers over the sky: *Reach builders mid-task.* — ad preview cards, live impressions, context matching |
| 24–30s | *REAL AGENTS. REAL ATTENTION.* → end card with install command and latentmarket.xyz |

Advertisers (Nimbus CI, Vaultline, Orbit DB, Relay Pay), user handles and all figures are fictional and illustrative.

## Preview

Open `index.html` in a browser (loops live). `index.html?t=12.5` freezes on a time.

## Render

Needs Node + Playwright (Chromium), Python 3 with numpy, and ffmpeg.

```bash
python3 audio.py                        # -> out/audio.wav
node render.cjs --stills 2,9.5,27       # -> out/still-*.png for review
FFMPEG=ffmpeg node render.cjs           # -> out/latent-launch.mp4 (1080p30, H.264 + AAC)
```

Timeline constants live in `T` inside `index.html`; sound cues in `audio.py` mirror them.
