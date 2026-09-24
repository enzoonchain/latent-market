"""Synthesises the launch film soundtrack -> out/audio.wav (30 s, 48 kHz stereo).

Cue times mirror the timeline constants `T` in index.html.
"""
import os
import wave

import numpy as np

SR = 48000
DUR = 30.0
N = int(SR * DUR)
rng = np.random.default_rng(3)
L = np.zeros(N)
R = np.zeros(N)


def add(sig, t, gain=1.0, pan=0.0):
    i = int(t * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * np.sqrt((1 - pan) / 2) * 1.414
    R[i:i + len(sig)] += sig * np.sqrt((1 + pan) / 2) * 1.414


def env(n, a, d):
    t = np.arange(n) / SR
    return np.minimum(1, t / max(a, 1e-4)) * np.exp(-t / d)


def lowpass(x, cutoff):
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):  # one-pole, fine for short sounds
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


def key():
    n = int(.045 * SR)
    click = rng.standard_normal(n) * env(n, .0005, .006)
    body = np.sin(2 * np.pi * rng.uniform(1800, 2600) * np.arange(n) / SR) * env(n, .0005, .004) * .3
    return lowpass(click, 5000) * .6 + body


def tick():
    n = int(.06 * SR)
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * 3200 * t) * env(n, .0003, .008) * .5


def chime(f0, dur=3.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = sum(a * np.sin(2 * np.pi * f0 * m * t) * np.exp(-t / (dur * d))
            for m, a, d in [(1, 1, .35), (2.01, .45, .2), (3.0, .22, .12), (4.2, .12, .08)])
    return s * np.minimum(1, t / .004)


def blip(f, dur=.25):
    n = int(dur * SR)
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * f * t) * env(n, .002, dur / 4)


def whoosh(dur, rise=True):
    n = int(dur * SR)
    x = rng.standard_normal(n)
    lo = lowpass(x, 700) - lowpass(x, 120)
    hi = lowpass(x, 3500) - lowpass(x, 700)
    t = np.linspace(0, 1, n)
    shape = np.sin(np.pi * (t ** (0.6 if rise else 1.6)))
    return (lo * .8 + hi * .25 * t) * shape


def midi(m):
    return 440 * 2 ** ((m - 69) / 12)


def pad(notes, start, dur, gain):
    n = int(dur * SR)
    t = np.arange(n) / SR
    s = np.zeros(n)
    for m in notes:
        f = midi(m)
        for det in (-.12, .0, .13):
            ff = f * 2 ** (det / 12)
            s += np.sin(2 * np.pi * ff * t + rng.uniform(0, 6)) + .18 * np.sin(2 * np.pi * 2 * ff * t)
    a = np.minimum(1, t / 1.2) * np.minimum(1, (dur - t) / 1.2)
    s = s * a * (1 + .08 * np.sin(2 * np.pi * .3 * t)) / (len(notes) * 3)
    add(s, start, gain, -.25)
    add(np.roll(s, 700), start, gain, .25)


def pluck(m, t0, gain=.12, pan=0.0):
    n = int(1.2 * SR)
    t = np.arange(n) / SR
    f = midi(m)
    s = (np.sin(2 * np.pi * f * t) + .3 * np.sin(2 * np.pi * 2 * f * t)) * env(n, .003, .28)
    add(s, t0, gain, pan)


# --- Act 1: keystrokes + thinking ---
prompt = 'refactor the auth module and add tests'
for i, _ in enumerate(prompt):
    add(key(), .45 + i / 32 + rng.uniform(-.006, .006), .35, rng.uniform(-.2, .2))
add(key(), 1.70, .6)  # enter
for s in range(1, 14):  # timer ticks while the agent thinks
    add(tick(), 1.75 + (s - 1) * (4.2 - 1.75) / 13, .10 + .02 * s)
n = int((4.2 - 1.6) * SR)
t = np.arange(n) / SR
drone = (np.sin(2 * np.pi * 55 * t) + .5 * np.sin(2 * np.pi * 110.4 * t)) * (t / t[-1]) ** 2
add(drone, 1.6, .12)

# --- Act 2: the turn ---
add(chime(midi(86)), 4.25, .22, -.1)
add(chime(midi(93)), 4.33, .12, .2)
add(blip(midi(93)), 5.0, .12, .4)
add(blip(midi(98)), 5.08, .10, .4)
add(blip(midi(93)), 6.3, .08, .4)

# --- Act 3: reveal ---
add(whoosh(1.8), 7.2, .5)
pad([50, 57, 62, 66, 69, 73], 7.6, 4.8, .5)          # D maj9
add(chime(midi(74), 4.0), 10.55, .18)
add(chime(midi(81), 4.0), 10.62, .1, .3)

# --- Act 4 / 5: product ---
add(whoosh(.9), 11.8, .35)
pad([47, 54, 59, 62, 66, 69], 12.2, 3.4, .42)        # Bm9
pad([43, 50, 55, 59, 62, 66, 69], 15.4, 3.3, .42)    # Gmaj9
pad([45, 52, 57, 61, 64, 71], 18.4, 3.2, .42)        # A add9
pad([50, 57, 62, 66, 69, 73], 21.4, 3.3, .42)        # D maj9
arp = [74, 78, 81, 85, 81, 78]
beat = 60 / 100 / 2
t0 = 12.2
i = 0
while t0 < 24.2:
    pluck(arp[i % len(arp)] - (5 if 15.4 <= t0 < 18.4 else 0), t0, .06, (-.4, .4)[i % 2])
    t0 += beat
    i += 1
cmd = 'npx latent-protocol@beta init'
for j, _ in enumerate(cmd):
    add(key(), 12.75 + j / 26, .3, .2)
add(key(), 13.95, .5)
for j in range(6):
    add(blip(midi(88 + (j % 3) * 2), .15), 14.15 + j * .2, .07, .3)
for j in range(6):
    add(blip(midi(81 + j * 2), .2), 15.65 + j * .17, .06, -.3)
for j, _ in enumerate('Nimbus CI — ship 3× faster'):
    add(key(), 18.95 + j / 34, .22, .2)
for j, _ in enumerate('Zero-config pipelines for agent-built code.'):
    add(key(), 19.75 + j / 46, .18, .2)
add(key(), 21.3, .7)
add(chime(midi(90), 2.0), 21.4, .14)
for j in range(10):
    add(blip(midi(86 + (j * 5) % 12), .2), 21.8 + j * .22, .04, rng.uniform(-.6, .6))

# --- Act 6: close ---
add(whoosh(1.6), 23.9, .5)
pad([38, 50, 57, 62, 66, 69, 76], 24.4, 5.6, .55)    # D maj9 wide
add(chime(midi(86), 4.0), 27.1, .2)
add(chime(midi(93), 4.0), 27.18, .12, .3)
sub = np.sin(2 * np.pi * 36.7 * np.arange(int(5 * SR)) / SR) * env(int(5 * SR), .4, 2.5)
add(sub, 24.4, .18)

# master: fade in/out, soft clip, normalise
fade = np.ones(N)
fade[-int(.6 * SR):] = np.linspace(1, 0, int(.6 * SR))
mix = np.stack([L, R], 1) * fade[:, None]
mix = np.tanh(mix * 1.4) / np.tanh(1.4)
mix = mix / np.max(np.abs(mix)) * .89
os.makedirs(os.path.join(os.path.dirname(__file__), 'out'), exist_ok=True)
with wave.open(os.path.join(os.path.dirname(__file__), 'out', 'audio.wav'), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype('<i2').tobytes())
print('wrote out/audio.wav')
