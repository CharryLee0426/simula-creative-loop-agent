"""Deterministic music synth with presets. Usage: python audio.py --job job.json
Presets (job.audio_preset): low_drums, warm_piano, upbeat_synth, none (ambience + SFX only), epic_strings, western.
The first four are the audio_style values found in creative_performance.csv, so every manifest maps 1:1 to a preset.
Cues follow job.timeline (cut_s = the action hit, endcard_s = resolve).
"""
import argparse, json, wave
import numpy as np

SR = 44100


class Synth:
    def __init__(self, dur, seed=5):
        self.dur, self.n = dur, int(SR * dur)
        self.t = np.arange(self.n) / SR
        self.out = np.zeros(self.n)
        self.rng = np.random.default_rng(seed)

    @staticmethod
    def hz(m):
        return 440 * 2 ** ((m - 69) / 12)

    def add(self, sig, t0):
        i = int(t0 * SR)
        j = min(self.n, i + len(sig))
        if j > i:
            self.out[i:j] += sig[: j - i]

    def strings(self, ms, t0, t1, amp, att=0.6, rel=0.5):
        L = int((t1 - t0 + rel) * SR); tt = np.arange(L) / SR
        env = np.minimum(1, tt / att) * np.where(tt > (t1 - t0), np.exp(-(tt - (t1 - t0)) / (rel / 3)), 1)
        s = np.zeros(L)
        for m in ms:
            f = self.hz(m)
            for det in (-0.12, 0, 0.11):
                ph = 2 * np.pi * np.cumsum(f * 2 ** (det / 12) * (1 + 0.004 * np.sin(2 * np.pi * 5.3 * tt + f))) / SR
                for k in range(1, 9):
                    s += np.sin(k * ph) / k ** 1.3
        self.add(amp * env * s / (len(ms) * 3), t0)

    def drone(self, ms, t0, t1, amp, trem=7.0):
        L = int((t1 - t0) * SR); tt = np.arange(L) / SR
        s = sum(sum(np.sin(2 * np.pi * self.hz(m) * k * tt) / k ** 1.4 for k in range(1, 7)) for m in ms) / len(ms)
        env = np.minimum(1, tt / 0.8) * np.minimum(1, (t1 - t0 - tt) / 0.4)
        self.add(amp * env * (0.75 + 0.25 * np.sin(2 * np.pi * trem * tt)) * s, t0)

    def pluck(self, m, t0, amp=0.3, dur=1.6, bright=0.5, decay=0.996):
        """Karplus-Strong, vectorized one period at a time."""
        N = int(SR / self.hz(m)); L = int(dur * SR)
        y = np.empty(L + N + 1)
        y[:N] = self.rng.uniform(-1, 1, N)
        pos = N
        while pos < L + N:
            e = min(pos + N - 1, L + N)  # N-1 so every source sample is already computed
            y[pos:e] = decay * (bright * y[pos - N:e - N] + (1 - bright) * y[pos - N + 1:e - N + 1])
            pos = e
        self.add(amp * y[:L], t0)

    def whistle(self, notes, amp=0.16):
        for m, s, d in notes:
            L = int(d * SR); tt = np.arange(L) / SR
            f = self.hz(m) * (1 + 0.012 * np.sin(2 * np.pi * 5.5 * tt) * np.minimum(1, tt / 0.25))
            g = int(0.06 * SR); f[:g] *= np.linspace(0.94, 1, g)
            ph = 2 * np.pi * np.cumsum(f) / SR
            env = np.minimum(1, tt / 0.05) * np.minimum(1, (d - tt) / 0.12)
            self.add(amp * env * (np.sin(ph) + 0.08 * np.sin(2 * ph) + 0.02 * self.rng.standard_normal(L)), s)

    def bell(self, t0, amp=0.25, f0=880):
        L = int(2.5 * SR); tt = np.arange(L) / SR
        self.add(amp * sum(a * np.sin(2 * np.pi * f0 * r * tt) * np.exp(-tt * d)
                           for r, a, d in ((1, 1, 1.5), (2.76, .5, 2.5), (5.4, .3, 4), (8.9, .2, 6))), t0)

    def hit(self, t0, amp=0.6, f=60, decay=4):
        L = int(1.2 * SR); tt = np.arange(L) / SR
        s = np.sin(2 * np.pi * f * tt * (1 + 0.6 * np.exp(-tt * 25))) * np.exp(-tt * decay)
        self.add(amp * (s + self.rng.standard_normal(L) * np.exp(-tt * 30) * 0.5), t0)

    def piano(self, m, t0, amp=0.25, dur=2.2):
        L = int(dur * SR); tt = np.arange(L) / SR
        f = self.hz(m)
        s = sum((0.9 ** k) * np.sin(2 * np.pi * f * k * (1 + 0.0004 * k * k) * tt) * np.exp(-tt * (1.6 + 0.9 * k))
                for k in range(1, 8))
        env = np.minimum(1, tt / 0.004)
        self.add(amp * env * s, t0)

    def noise(self, t0, dur, amp, color=0.98):
        L = int(dur * SR)
        w = self.rng.standard_normal(L)
        y = np.empty(L); acc = 0.0
        for i in range(L):  # brown-ish noise
            acc = color * acc + (1 - color) * w[i] * 8; y[i] = acc
        self.add(amp * y / (np.max(np.abs(y)) + 1e-9), t0)

    def whoosh(self, t_peak, amp=0.35, dur=0.9):
        L = int(dur * SR); tt = np.arange(L) / SR
        w = self.rng.standard_normal(L)
        env = np.exp(-((tt - dur * 0.7) / (dur * 0.25)) ** 2)
        y = np.convolve(w, np.ones(24) / 24, mode="same")
        self.add(amp * env * y * 2.5, t_peak - dur * 0.7)

    def saw(self, m, t0, dur, amp=0.12, harmonics=10, decay=6.0):
        L = int(dur * SR); tt = np.arange(L) / SR
        f = self.hz(m)
        s = sum(((-1) ** (k + 1)) * np.sin(2 * np.pi * f * k * tt) / k for k in range(1, harmonics + 1))
        env = np.minimum(1, tt / 0.005) * np.exp(-tt * decay)
        self.add(amp * env * s, t0)

    def hat(self, t0, amp=0.08):
        L = int(0.05 * SR); tt = np.arange(L) / SR
        w = self.rng.standard_normal(L)
        hp = np.diff(np.concatenate([[0.0], w]))
        self.add(amp * hp * np.exp(-tt * 90), t0)

    def master(self, path, lp=0.3, reverb=False, peak=0.85):
        x = self.out
        # one-pole lowpass in blocks via exponential smoothing (vectorized approx with cumulative trick)
        y = np.empty_like(x); acc = 0.0
        for s in range(0, len(x), 4096):
            blk = x[s:s + 4096]
            out = np.empty_like(blk)
            for i, v in enumerate(blk):
                acc += lp * (v - acc); out[i] = acc
            y[s:s + 4096] = out
        if reverb:
            r = y.copy()
            for dly, g in ((0.031, .35), (0.047, .28), (0.071, .22), (0.113, .16)):
                d = int(dly * SR); r[d:] += g * y[:-d]
            y = r
        y = y * np.minimum(1, (self.dur - self.t) / 0.4)
        y = y / (np.max(np.abs(y)) + 1e-9) * peak
        R = np.concatenate([np.zeros(280), y[:-280]])
        with wave.open(path, "wb") as w:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
            w.writeframes((np.stack([y, R], 1) * 32767).astype(np.int16).tobytes())


def epic_strings(S, C, E):
    hz = S.hz; M = (C + E) / 2; D = S.dur
    S.strings([38, 50, 57, 62], 0.0, C * 0.5, 0.35, att=1.0)
    S.strings([34, 46, 53, 62], C * 0.5, C - 0.05, 0.42, att=0.5)
    S.hit(C - 0.05, 0.4, 49, 3); S.hit(C, 0.5, 55, 3); S.bell(C, 0.05, 1320)
    S.strings([36, 48, 55, 64, 67], C, M, 0.62, att=0.08)
    S.strings([38, 50, 57, 65, 69], M, E, 0.7, att=0.15)
    S.hit(E, 0.35, 43, 3)
    S.strings([41, 53, 60, 65, 69, 72], E, D - 0.6, 0.72, att=0.2, rel=0.6)
    k = 0
    while C + k * 0.25 <= E:
        L = int(0.2 * SR); tt = np.arange(L) / SR
        S.add(0.12 * np.sign(np.sin(2 * np.pi * hz(50) * tt)) * np.exp(-tt * 18), C + k * 0.25); k += 1
    return dict(lp=0.25, reverb=False)


def western(S, C, E):
    D = S.dur
    S.drone([45, 52], 0.0, C, 0.22)
    for k, m in enumerate([45, 52, 57, 52]):
        S.pluck(m, 0.2 + k * C * 0.233, 0.28)
    w = C / 3.0
    S.whistle([(69, 0.5 * w, 0.9 * w), (76, 1.45 * w, 0.5 * w), (74, 1.95 * w, 0.35 * w), (72, 2.3 * w, 0.6 * w)])
    S.hit(C, 0.7); S.bell(C, 0.22, 659); S.bell(C + 0.02, 0.12, 990)
    S.drone([50, 57], C, E, 0.18)
    seq = [45, 52, 57] * 2 + [50, 57, 62] * 2 + [52, 59, 64] * 2
    for k, m in enumerate(seq):
        S.pluck(m, C + 0.15 + k * (E - C - 0.3) / len(seq), 0.22 if k % 3 == 0 else 0.14, dur=0.6, bright=0.6)
    span = E - C
    S.whistle([(76, C + 0.3 * span, 0.23 * span), (81, C + 0.55 * span, 0.15 * span),
               (79, C + 0.71 * span, 0.1 * span), (76, C + 0.82 * span, 0.16 * span)], 0.14)
    S.hit(E, 0.4)
    for k, m in enumerate([45, 52, 57, 61, 64, 69]):
        S.pluck(m, E + 0.03 * k, 0.24, dur=2.0)
    S.drone([45, 57, 61], E, D, 0.18)
    S.whistle([(69, E + 0.4, min(1.3, D - E - 0.5))], 0.12)
    S.bell(E + 1.0, 0.1, 880)
    return dict(lp=0.35, reverb=True)


def low_drums(S, C, E):
    """Taiko-style low drums over a D drone, building into the cut and resolving on the end card."""
    D = S.dur
    S.drone([38, 45], 0.0, D, 0.16, trem=3.0)
    beat = C / 4.0
    for k in range(4):
        S.hit(0.15 + k * beat, 0.45 + 0.08 * k, 52, 5)
        S.hit(0.15 + k * beat + beat * 0.5, 0.22, 64, 7)
    S.whoosh(C, 0.25)
    S.hit(C, 0.9, 45, 2.5); S.hit(C + 0.01, 0.4, 70, 6)
    span = E - C
    for k in range(8):
        S.hit(C + 0.2 + k * span / 8, 0.32 if k % 2 == 0 else 0.2, 58 if k % 2 == 0 else 72, 6)
    S.hit(E, 0.85, 41, 2.2)
    S.drone([38, 45, 50], E, D, 0.24, trem=5.0)
    S.bell(E + 0.05, 0.08, 587)
    return dict(lp=0.22, reverb=True)


def warm_piano(S, C, E):
    """Gentle C-major piano: arpeggios, a soft pad, a warm resolving chord on the end card."""
    D = S.dur
    prog = [[48, 55, 60, 64], [43, 50, 55, 59], [45, 52, 57, 60], [41, 48, 53, 57]]  # C G Am F
    step = C / 4.0
    for i, ch in enumerate(prog):
        t = 0.1 + i * step
        for j, m in enumerate(ch):
            S.piano(m + 12 * (j == 3), t + j * step / 4, 0.22, dur=2.0)
    S.strings([48, 55, 64], 0.0, C, 0.10, att=1.2)
    S.bell(C, 0.06, 1047)
    span = E - C
    for j, m in enumerate([60, 64, 67, 72, 67, 64, 60, 64]):
        S.piano(m, C + j * span / 8, 0.2, dur=1.2)
    S.strings([41, 53, 57, 60], C, E, 0.10, att=0.4)
    for j, m in enumerate([48, 55, 60, 64, 67, 72]):
        S.piano(m, E + 0.02 * j, 0.24, dur=max(1.0, D - E))
    S.strings([48, 55, 60, 64], E, D - 0.3, 0.14, att=0.3, rel=0.4)
    return dict(lp=0.3, reverb=True)


def upbeat_synth(S, C, E):
    """128 BPM four-on-the-floor with a saw arpeggio, a riser into the cut and a chord stab on the end card."""
    D = S.dur
    b = 60 / 128.0
    t = 0.0
    while t < D - 0.2:
        S.hit(t, 0.55, 50, 9)
        S.hat(t + b / 2, 0.10)
        t += b
    arp = [57, 60, 64, 69, 64, 60]
    k = 0; t = 0.0
    while t < C - 0.05:
        S.saw(arp[k % len(arp)], t, b / 2, 0.10, decay=9)
        t += b / 4; k += 1
    S.whoosh(C, 0.30, dur=1.2)
    for m in (57, 64, 69, 72):
        S.saw(m, C, 0.6, 0.12, decay=3)
    arp2 = [62, 65, 69, 74, 69, 65]
    k = 0; t = C + 0.1
    while t < E - 0.05:
        S.saw(arp2[k % len(arp2)], t, b / 2, 0.09, decay=9)
        t += b / 4; k += 1
    for m in (53, 60, 65, 69, 72):
        S.saw(m, E, max(0.8, D - E - 0.2), 0.10, decay=1.2)
    S.bell(E, 0.10, 880)
    return dict(lp=0.45, reverb=False)


def none(S, C, E):
    """No music: quiet room tone plus a whoosh on the cut and a soft chime on the end card (keeps an audio track)."""
    S.noise(0.0, S.dur, 0.05)
    S.whoosh(C, 0.22)
    S.bell(E, 0.10, 1175)
    return dict(lp=0.5, reverb=True, peak=0.35)


PRESETS = {"low_drums": low_drums, "warm_piano": warm_piano, "upbeat_synth": upbeat_synth, "none": none,
           "epic_strings": epic_strings, "western": western}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    a = ap.parse_args()
    job = json.load(open(a.job, encoding="utf-8"))
    S = Synth(float(job["format"]["duration_s"]))
    tl = job["timeline"]
    opts = PRESETS[job.get("audio_preset", "epic_strings")](S, tl["cut_s"], tl["endcard_s"])
    S.master(job["audio_out"], **opts)
    print("audio ->", job["audio_out"])


if __name__ == "__main__":
    main()
