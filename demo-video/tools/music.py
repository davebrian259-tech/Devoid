# A quiet ambient bed for under the narration: slow warm chords, soft attack, a little air, a
# long tail. Synthesised here (no samples, nothing licensed).  python music.py SECONDS out.wav
import sys, numpy as np, soundfile as sf
SR = 48000; dur = float(sys.argv[1]); out = sys.argv[2]
n = int(SR * dur); t = np.arange(n) / SR
rng = np.random.default_rng(7)
def hz(m): return 440 * 2 ** ((m - 69) / 12)
# Fmaj9 - Am9 - Cmaj9 - G6/9 (MIDI), 8 s each
CHORDS = [[41, 53, 57, 60, 64, 67], [45, 52, 55, 60, 64, 71], [48, 52, 55, 59, 62, 64], [43, 50, 55, 57, 62, 64]]
BAR = 8.0
mix = np.zeros(n)
for k in range(int(dur // BAR) + 2):
    start = k * BAR - 1.0; chord = CHORDS[k % 4]
    i0, i1 = max(0, int(start * SR)), min(n, int((start + BAR + 3.0) * SR))
    if i0 >= i1: continue
    tt = t[i0:i1] - start
    env = np.minimum(1, tt / 2.2) * np.clip((BAR + 3.0 - tt) / 3.0, 0, 1)  # slow swell, long release
    for j, m in enumerate(chord):
        f = hz(m); amp = (0.55 if j == 0 else 0.32) / (1 + 0.15 * j)
        for det in (-0.004, 0.004):  # two voices, a few cents apart
            ph = rng.uniform(0, 2 * np.pi)
            mix[i0:i1] += amp * env * (np.sin(2 * np.pi * f * (1 + det) * tt + ph) + 0.18 * np.sin(4 * np.pi * f * (1 + det) * tt + ph))
# soften: one-pole low-pass around 2.4 kHz
a = np.exp(-2 * np.pi * 2400 / SR); y = np.empty_like(mix); acc = 0.0
for i in range(n): acc = (1 - a) * mix[i] + a * acc; y[i] = acc
# air: a little filtered noise, very low
noise = np.convolve(rng.standard_normal(n), np.ones(40) / 40, mode='same') * 0.004
y = y + noise
# room: convolution with a 3 s decaying noise tail
ir_t = np.arange(int(3.0 * SR)) / SR; ir = rng.standard_normal(ir_t.size) * np.exp(-ir_t / 0.9); ir /= np.sqrt((ir ** 2).sum())
wet = np.fft.irfft(np.fft.rfft(y, 2 * n) * np.fft.rfft(ir, 2 * n))[:n]
y = 0.7 * y + 0.3 * wet
y *= np.minimum(1, t / 3.0) * np.clip((dur - t) / 4.0, 0, 1)  # fade in and out
y /= np.abs(y).max() / 0.5
sf.write(out, np.stack([y, y], 1).astype(np.float32), SR)
print(out, dur, 's')
