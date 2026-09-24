# Latent launch film (30 s)

Coded motion piece: every frame is rendered from `index.html` by a
deterministic `render(t)` function, so edits are just HTML/CSS/JS.

| Time | Beat |
|------|------|
| 0–4s | Terminal on black: prompt typed, agent "thinking", *Your agent is thinking. / And you're… waiting.* |
| 4–7.5s | Idle status line turns into a sponsored line, `+0.0025 USDC` lands. *What if the wait was worth something?* |
| 7.5–12s | Pull back through the curtains into the sky: *AGENTS DESERVE A BIGGER STAGE.* → LATENT lockup, monument rises |
| 12–18s | Developers: `npx latent-protocol@beta init`, detected agents, the line on every surface, **50%** revenue share |
| 18–24s | Advertisers: write one line, tags, launch; globe lights up, live stats, **$10** minimum campaign |
| 24–30s | *REAL AGENTS. REAL ATTENTION.* → end card with install command and latentmarket.xyz |

Ads shown are for a fictional brand (Nimbus CI).

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
