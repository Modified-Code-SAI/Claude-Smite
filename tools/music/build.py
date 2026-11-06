"""Builds the orchestra the music plays: public/music/*.ogg and samples.json.

The score in src/audio/music.ts is written for a small orchestra (strings,
choir, horns, basses, harp, spiccato strings, celesta, drums, cymbals).
This script cuts one recorded sample every few semitones for each of them from
two free libraries, measures each sample's real pitch, gives every sustained
sample a seamless crossfaded loop, evens out the levels, and encodes Opus.
src/audio/orchestra.ts loads the result and the sequencer plays it at pitch;
until it has loaded, the synthesized instruments play instead.

Sources, pinned (fetched into tools/music/src/, git-ignored):
- VSCO 2 Community Edition, Versilian Studios: CC0 1.0
  https://github.com/sgossner/VSCO-2-CE
- Versilian Community Sample Library: CC0 1.0
  https://github.com/sgossner/VCSL
- Sonatina Symphonic Orchestra, Mattias Westlund: CC Sampling Plus 1.0
  https://github.com/peastman/sso (choir, section horns, section basses)

Usage:
    python3 tools/music/build.py --fetch   # sparse-clone just the files used (~800 MB)
    python3 tools/music/build.py           # writes public/music/
Requires numpy and ffmpeg (with libopus).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')
OUT = os.path.join(HERE, '..', '..', 'public', 'music')
RATE = 44100

REPOS = {
    'vsco': ('https://github.com/sgossner/VSCO-2-CE.git', '440300901dfe9275fd84e0b7763af1f8443ae62e', [
        'Strings/Violin Section/susVib/', 'Strings/Viola Section/susvib/', 'Strings/Cello Section/susvib/',
        'Strings/Violin Section/Spic/', 'Strings/Viola Section/spic/', 'Strings/Cello Section/spic/',
        'Strings/Harp/', 'Percussion/cymbal-crash1*', 'Percussion/susCymb1-cresc*',
        'VSCO 1 Percussion/drums/bass/', 'VSCO 1 Percussion/drums/tenor/', "VSCO 1 Percussion/varWood/Camo's Shaker/",
        'LICENSE',
    ]),
    'vcsl': ('https://github.com/sgossner/VCSL.git', 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e', [
        'Membranophones/Struck Membranophones/Frame Drum/', 'LICENSE',
    ]),
    'sso': ('https://github.com/peastman/sso.git', '32bbdb169aef636b8216029a2e056424ba7c2abb', [
        'Sonatina Symphonic Orchestra/Samples-looped/Chorus/',
        'Sonatina Symphonic Orchestra/Samples/Basses/basses-sus-*',
        'Sonatina Symphonic Orchestra/Samples/Horns/horns-sus-mp-*',
        'Sonatina Symphonic Orchestra/Samples/Celeste/celeste-*-soft.flac',
        'LICENSE', 'README.md',
    ]),
}

SSO = 'sso/Sonatina Symphonic Orchestra'

# Each sample set: where its files are, how it is cut, and the notes the score
# needs (MIDI, with a little room either side for transposition).
#   kind 'sustain': looped, held by the sequencer's envelope
#   kind 'decay':   plucked or struck, plays out
#   kind 'hit':     unpitched, a few round-robin variants
SETS: dict[str, dict] = {
    'strings': {
        'kind': 'sustain', 'range': (36, 84), 'gap': 3,
        # celli low, violas in the middle, violins on top: each note from the section that sounds best there
        'files': [('vsco/Strings/Cello Section/susvib/susvib_*_v1_1.wav', (36, 52), 'yamaha'),
                  ('vsco/Strings/Viola Section/susvib/ViolaEns_susvib_*_v1_1.wav', (53, 62), 'yamaha'),
                  ('vsco/Strings/Violin Section/susVib/VlnEns_susVib_*_v1.wav', (63, 90), 'yamaha')],
        'loop': (1.4, 4.6), 'keep': 5.0,
    },
    'choir': {
        'kind': 'sustain', 'range': (45, 84), 'gap': 2,
        'files': [(f'{SSO}/Samples-looped/Chorus/chorus-male-*.wav', (40, 64), 'std'),
                  (f'{SSO}/Samples-looped/Chorus/chorus-female-*.wav', (65, 90), 'std')],
        'loop': (1.4, 4.4), 'keep': 4.8,
    },
    'horns': {
        'kind': 'sustain', 'range': (38, 76), 'gap': 3,
        'files': [(f'{SSO}/Samples/Horns/horns-sus-mp-*-PB-loop.wav', (30, 90), 'std')],
        'loop': (1.0, 3.3), 'keep': 3.6,
    },
    'basses': {
        'kind': 'sustain', 'range': (26, 46), 'gap': 3,
        'files': [(f'{SSO}/Samples/Basses/basses-sus-*.wav', (20, 50), 'std')],
        'loop': (1.2, 3.8), 'keep': 4.2,
    },
    'harp': {
        'kind': 'decay', 'range': (45, 90), 'gap': 2, 'keep': 3.2,
        'files': [('vsco/Strings/Harp/KSHarp_*.wav', (30, 100), 'std')],
    },
    'spiccato': {
        'kind': 'decay', 'range': (38, 76), 'gap': 3, 'keep': 0.7,
        'files': [('vsco/Strings/Cello Section/spic/spic_*_v2_RR1.wav', (36, 52), 'yamaha'),
                  ('vsco/Strings/Viola Section/spic/Violas_spic_*_v2_rr1.wav', (53, 62), 'yamaha'),
                  ('vsco/Strings/Violin Section/Spic/VlnEns_Spic_*_v2_rr1.wav', (63, 90), 'yamaha')],
    },
    # a celesta rather than a glockenspiel: sampled every major third over the
    # whole range the score's bells reach (VSCO's glock has only Cs and Gs)
    'celeste': {
        'kind': 'decay', 'range': (60, 100), 'gap': 4, 'keep': 2.6,
        'files': [(f'{SSO}/Samples/Celeste/celeste-*-soft.flac', (55, 110), 'std')],
    },
    'drum': {'kind': 'hit', 'keep': 1.1, 'files': ['vsco/VSCO 1 Percussion/drums/bass/bdrum_muted_ff_1.wav', 'vsco/VSCO 1 Percussion/drums/bass/bdrum_muted_fff_1.wav', 'vsco/VSCO 1 Percussion/drums/bass/bdrum_muted_fff_2.wav']},
    'tenor': {'kind': 'hit', 'keep': 0.6, 'files': ['vsco/VSCO 1 Percussion/drums/tenor/tenor_lower/tenor_ff_1.wav', 'vsco/VSCO 1 Percussion/drums/tenor/tenor_lower/tenor_ff_2.wav', 'vsco/VSCO 1 Percussion/drums/tenor/tenor_lower/tenor_fff_1.wav']},
    'hand': {'kind': 'hit', 'keep': 0.45, 'files': ['vcsl/Membranophones/Struck Membranophones/Frame Drum/HDrumL_Hit_v3_rr1_Sum.wav', 'vcsl/Membranophones/Struck Membranophones/Frame Drum/HDrumL_Hit_v3_rr2_Sum.wav']},
    'shaker': {'kind': 'hit', 'keep': 0.3, 'files': [f"vsco/VSCO 1 Percussion/varWood/Camo's Shaker/shake{i}.wav" for i in (1, 2, 3, 4)]},
    'crash': {'kind': 'hit', 'keep': 3.0, 'files': ['vsco/Percussion/cymbal-crash1_ff_rr1.wav', 'vsco/Percussion/cymbal-crash1_ff_rr2.wav']},
    # a suspended-cymbal crescendo, cut so it peaks exactly 1.8 s in (the score times it to land on the downbeat)
    'swell': {'kind': 'swell', 'peak_at': 1.8, 'keep': 2.6, 'files': ['vsco/Percussion/susCymb1-cresc-Short_v1.wav']},
}

# The score's instrument names (INST in src/audio/music.ts) and the set each plays.
MAP = {
    'mus.pad.lo': 'strings', 'mus.pad.hi': 'strings',
    'mus.choir': 'choir', 'mus.choir.hi': 'choir',
    'mus.horn': 'horns', 'mus.horn.lo': 'horns',
    'mus.bass': 'basses',
    'mus.harp': 'harp', 'mus.harp.hi': 'harp',
    'mus.stac': 'spiccato', 'mus.stac.hi': 'spiccato',
    'mus.bell': 'celeste',
    'mus.taiko': 'drum', 'mus.taiko.hi': 'tenor', 'mus.frame': 'hand',
    'mus.shaker': 'shaker', 'mus.swell': 'swell', 'mus.crash': 'crash',
}

PEAK = 0.7  # the level the synthesized instruments are normalized to (src/audio/music.ts)

# K-weighted loudness of each synthesized instrument the score was mixed with
# (renderRecipe(INSTRUMENTS[name], 1)[0] measured by loudness() over the same
# window level_window() uses). The manifest's gains bring each recorded set to
# these, so swapping in the orchestra keeps the mix's balance.
# Matched one by one, the recorded instruments still play a little quieter in
# the mix (natural dynamics and attacks); measured on the battle theme in the
# browser, K-weighted, against the synthesized score.
MIX_TRIM = 10 ** (2.0 / 20)

SYNTH_LKFS = {
    'mus.pad.lo': -15.1, 'mus.pad.hi': -16.1, 'mus.choir': -15.0, 'mus.choir.hi': -9.7,
    'mus.horn': -13.9, 'mus.horn.lo': -15.1, 'mus.bass': -9.7,
    'mus.harp': -16.7, 'mus.harp.hi': -16.6, 'mus.stac': -14.8, 'mus.stac.hi': -15.6,
    'mus.bell': -14.9, 'mus.taiko': -11.7, 'mus.taiko.hi': -15.6, 'mus.frame': -19.6,
    'mus.shaker': -24.8, 'mus.swell': -19.6, 'mus.crash': -14.0,
}
XFADE = 0.3  # seconds of crossfade baked into each loop
LOOP_TAIL = int(0.08 * RATE)  # samples of the loop's continuation kept past its end


CREDITS = '''# Music samples

The score's orchestra (`public/music/`) is cut from three free sample libraries.
The samples are trimmed, tuned, looped, level-matched and re-encoded by
`tools/music/build.py`; nothing else is changed.

- **Strings (sustained and spiccato), harp, bass drum, tenor drum, shaker, crash and
  suspended cymbals:** Versilian Studios Chamber Orchestra 2 Community Edition
  (VSCO 2 CE) by Versilian Studios, CC0 1.0. https://github.com/sgossner/VSCO-2-CE
- **Frame drum:** Versilian Community Sample Library (VCSL) by Versilian Studios,
  CC0 1.0. https://github.com/sgossner/VCSL
- **Choir, horns, double basses and celesta:** Sonatina Symphonic Orchestra by
  Mattias Westlund, continued at https://github.com/peastman/sso, licensed under
  Creative Commons Sampling Plus 1.0
  (https://creativecommons.org/licenses/sampling+/1.0/).
'''


# ---------------------------------------------------------------------------
# Fetching


def fetch() -> None:
    os.makedirs(SRC, exist_ok=True)
    for name, (url, commit, paths) in REPOS.items():
        d = os.path.join(SRC, name)
        if not os.path.isdir(os.path.join(d, '.git')):
            subprocess.run(['git', 'clone', '-q', '--filter=blob:none', '--no-checkout', url, d], check=True)
        subprocess.run(['git', '-C', d, 'sparse-checkout', 'init', '--no-cone'], check=True)
        subprocess.run(['git', '-C', d, 'sparse-checkout', 'set', '--no-cone', *paths], check=True)
        subprocess.run(['git', '-C', d, 'checkout', '-q', commit], check=True)
        print(f'{name}: {commit[:10]}')


# ---------------------------------------------------------------------------
# Audio helpers


def load(path: str) -> np.ndarray:
    """Any audio file as float32 stereo at 44.1 kHz, shape (n, 2)."""
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(RATE), '-'], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()


def encode(x: np.ndarray, path: str, kbps: int) -> None:
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(RATE), '-ac', '2', '-i', '-',
                    '-c:a', 'libopus', '-b:a', f'{kbps}k', '-vbr', 'on', '-application', 'audio', path],
                   input=np.ascontiguousarray(x, dtype=np.float32).tobytes(), check=True)


def envelope(x: np.ndarray, win: float = 0.01) -> np.ndarray:
    m = np.abs(x).max(axis=1)
    n = max(1, int(win * RATE))
    k = len(m) // n
    return m[: k * n].reshape(k, n).max(axis=1)


def onset(x: np.ndarray) -> int:
    """First sample where the sound reaches -36 dB of its peak, less 5 ms."""
    m = np.abs(x).max(axis=1)
    i = int(np.argmax(m > m.max() * 10 ** (-36 / 20)))
    return max(0, i - int(0.005 * RATE))


def measure_pitch(x: np.ndarray, lo: float = 25.0, hi: float = 2500.0) -> float | None:
    """Fundamental (MIDI, fractional) of a steady stretch, by the YIN difference function."""
    mono = x.mean(axis=1).astype(np.float64)
    n = 4096
    start = min(len(mono) - n * 2, int(0.25 * RATE))
    if start < 0:
        return None
    best: list[float] = []
    for s in range(start, min(len(mono) - 2 * n, start + int(1.0 * RATE)), n // 2):
        f = mono[s: s + 2 * n]
        tmax = int(RATE / lo)
        tmin = int(RATE / hi)
        tmax = min(tmax, n - 1)
        # difference function via FFT autocorrelation
        w = f[:n]
        energy = np.cumsum(np.concatenate([[0.0], f ** 2]))
        ac = np.fft.irfft(np.fft.rfft(f, 4 * n) * np.conj(np.fft.rfft(w, 4 * n)))[: tmax + 1]
        taus = np.arange(tmax + 1)
        d = energy[n] - energy[0] + (energy[taus + n] - energy[taus]) - 2 * ac
        d[0] = 0
        cmnd = d * taus / np.maximum(np.cumsum(d), 1e-12)
        cmnd[0] = 1
        cand = np.where(cmnd[tmin:] < 0.15)[0]
        if len(cand) == 0:
            continue
        t = cand[0] + tmin
        while t + 1 < len(cmnd) and cmnd[t + 1] < cmnd[t]:
            t += 1
        # parabolic interpolation
        if 1 <= t < len(cmnd) - 1:
            a, b, c = cmnd[t - 1], cmnd[t], cmnd[t + 1]
            t = t + 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else t
        best.append(69 + 12 * np.log2(RATE / t / 440))
    if not best:
        return None
    return float(np.median(best))


NOTE = {'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11}


def name_pitch(path: str, convention: str) -> int | None:
    """The MIDI note in a file name. Libraries disagree on which C is middle C:
    'std' reads C4 as 60, 'yamaha' reads C3 as 60."""
    m = re.search(r'(?:^|[_\-])([A-Ga-g])(#|b)?(-?\d)(?=[_\-.])', os.path.basename(path))
    if not m:
        return None
    pc = NOTE[m.group(1).lower()] + (1 if m.group(2) == '#' else -1 if m.group(2) == 'b' else 0)
    return 12 * (int(m.group(3)) + (1 if convention == 'std' else 2)) + pc


def pitch_of(path: str, x: np.ndarray, convention: str) -> float | None:
    """The file name's note, fine-tuned by the measured pitch (folded into +-half a
    semitone, since the detector can lock an octave off). 'measure' trusts the detector."""
    meas = measure_pitch(x[onset(x):])
    if convention == 'measure':
        return meas
    named = name_pitch(path, convention)
    if named is None:
        return None
    if meas is None:
        return float(named)
    cents = ((meas - named + 6) % 12) - 6
    if abs(cents) > 0.6:
        print(f'  warning: {os.path.basename(path)} measures {meas:.2f}, name says {named}; using the name')
        cents = 0.0
    return named + cents


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-12)


def _biquad_gain(b: tuple, a: tuple, w: np.ndarray) -> np.ndarray:
    z = np.exp(-1j * w)
    return np.abs((b[0] + b[1] * z + b[2] * z * z) / (a[0] + a[1] * z + a[2] * z * z))


def _k_weight(n: int) -> np.ndarray:
    """|H| of the ITU-R BS.1770 K-weighting filter at the rfft bins of an n-sample frame."""
    w = np.linspace(0, np.pi, n // 2 + 1)
    # stage 1: the head's high shelf
    A = 10 ** (3.999843853973347 / 40)
    w0 = 2 * np.pi * 1681.974450955533 / RATE
    al = np.sin(w0) / (2 * 0.7071752369554196)
    c = np.cos(w0)
    shelf = _biquad_gain(
        (A * ((A + 1) + (A - 1) * c + 2 * np.sqrt(A) * al), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - 2 * np.sqrt(A) * al)),
        ((A + 1) - (A - 1) * c + 2 * np.sqrt(A) * al, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - 2 * np.sqrt(A) * al), w)
    # stage 2: the RLB high-pass
    w0 = 2 * np.pi * 38.13547087602444 / RATE
    al = np.sin(w0) / (2 * 0.5003270373238773)
    c = np.cos(w0)
    hp = _biquad_gain(((1 + c) / 2, -(1 + c), (1 + c) / 2), (1 + al, -2 * c, 1 - al), w)
    return shelf * hp


def loudness(x: np.ndarray) -> float:
    """K-weighted level in dB (LKFS without gating), averaged over the channels,
    so a mono sound and the same sound on both channels measure alike."""
    x = x.reshape(len(x), -1).astype(np.float64)
    n = len(x)
    spec = np.fft.rfft(x, axis=0) * _k_weight(n)[:, None]
    # Parseval: mean square of the filtered signal from its spectrum
    power = (np.abs(spec) ** 2).sum(axis=0)
    power -= 0.5 * np.abs(spec[0]) ** 2 + (0.5 * np.abs(spec[-1]) ** 2 if n % 2 == 0 else 0)
    ms = 2 * power / (n * n)
    return float(10 * np.log10(ms.mean() + 1e-20) - 0.691)


def level_window(y: np.ndarray, kind: str, loop: tuple[float, float] | None) -> np.ndarray:
    """The part of a sample its loudness is judged on: the loop of a sustain, the
    whole of a swell, and the first 0.4 s of anything struck or plucked."""
    if kind == 'sustain' and loop:
        return y[int(loop[0] * RATE): int(loop[1] * RATE)]
    if kind == 'swell':
        return y
    return y[: int(0.4 * RATE)]


def fade(x: np.ndarray, fin: float, fout: float) -> np.ndarray:
    y = x.copy()
    a = int(fin * RATE)
    b = int(fout * RATE)
    if a:
        y[:a] *= np.linspace(0, 1, a)[:, None]
    if b:
        y[-b:] *= (np.linspace(1, 0, b) ** 2)[:, None]
    return y


def bake_loop(x: np.ndarray, start: float, end: float) -> tuple[np.ndarray, float, float]:
    """Crossfade the loop's tail into the audio just before `start`, so the jump
    at `end` is seamless, then carry on past `end` with what follows `start`:
    the seam sits mid-stream, clear of the codec's end-of-file padding."""
    s = int(start * RATE)
    e = int(end * RATE)
    xf = int(XFADE * RATE)
    s = max(s, xf + 1)
    e = min(e, len(x))
    t = np.linspace(0, 1, xf)[:, None]
    a = np.cos(t * np.pi / 2)  # equal power
    b = np.sin(t * np.pi / 2)
    y = x[:e].copy()
    y[e - xf: e] = y[e - xf: e] * a + x[s - xf: s] * b
    tail = fade(x[s: s + LOOP_TAIL], 0, LOOP_TAIL / RATE)
    return np.concatenate([y, tail]), s / RATE, e / RATE


# ---------------------------------------------------------------------------
# Building


def pitched_set(name: str, spec: dict) -> tuple[list[dict], list[tuple[str, np.ndarray]], float]:
    """Measure every candidate file, keep one every `gap` semitones over the range."""
    lo, hi = spec['range']
    found: list[tuple[float, str, np.ndarray]] = []
    for pattern, (plo, phi), convention in spec['files']:
        for f in sorted(glob.glob(os.path.join(SRC, pattern))):
            x = load(f)
            p = pitch_of(f, x, convention)
            if p is None or not (plo <= round(p) <= phi) or not (lo - 4 <= p <= hi + 4):
                continue
            found.append((p, f, x))
    found.sort(key=lambda t: t[0])
    zones: list[tuple[float, str, np.ndarray]] = []
    for p, f, x in found:
        if zones and p - zones[-1][0] < spec['gap'] - 0.5:
            continue
        zones.append((p, f, x))
    if not zones:
        sys.exit(f'{name}: no samples found (run with --fetch)')
    out_zones = []
    clips = []
    # cut, loop and even out the levels
    cut = []
    for p, f, x in zones:
        x = x[onset(x):]
        if spec['kind'] == 'sustain':
            keep = min(spec['keep'], len(x) / RATE - 0.05)
            ls, le = spec['loop']
            le = min(le, keep)
            ls = min(ls, le - XFADE - 0.6)
            y, ls2, le2 = bake_loop(x, ls, le)
            y = fade(y, 0.004, 0)
            body = y[int(ls2 * RATE): int(le2 * RATE)]
            cut.append((p, f, y, (ls2, le2), rms(body)))
        else:
            y = fade(x[: int(spec['keep'] * RATE)], 0.002, min(0.25, spec['keep'] * 0.4))
            cut.append((p, f, y, None, float(np.abs(y).max())))
    # each zone to the set's median level (RMS of the loop for sustains, peak for plucked), then the set to PEAK
    target = float(np.median([c[4] for c in cut]))
    scaled = [(p, f, y * (target / lvl), lp) for p, f, y, lp, lvl in cut]
    top = max(float(np.abs(y).max()) for _, _, y, _ in scaled)
    levels = []
    for i, (p, f, y, lp) in enumerate(scaled):
        y = y * (PEAK / top)
        levels.append(loudness(level_window(y, spec['kind'], lp)))
        file = f'{name}-{i:02d}.ogg'
        clips.append((file, y))
        z: dict = {'ref': round(p, 2), 'files': [file]}
        if lp:
            z['loop'] = [round(lp[0], 4), round(lp[1], 4)]
        z['from'] = os.path.relpath(f, SRC)
        out_zones.append(z)
    return out_zones, clips, float(np.median(levels))


def hit_set(name: str, spec: dict) -> tuple[list[dict], list[tuple[str, np.ndarray]], float]:
    clips = []
    ys = []
    for f in spec['files']:
        x = load(os.path.join(SRC, f))
        if spec['kind'] == 'swell':
            env = envelope(x)
            peak = int(np.argmax(env)) * int(0.01 * RATE)
            start = max(0, peak - int(spec['peak_at'] * RATE))
            y = x[start: start + int(spec['keep'] * RATE)]
            y = fade(y, 0.3, 0.6)
        else:
            x = x[onset(x):]
            y = fade(x[: int(spec['keep'] * RATE)], 0.001, min(0.3, spec['keep'] * 0.5))
        ys.append(y)
    top = max(float(np.abs(y).max()) for y in ys)
    files = []
    levels = []
    for i, y in enumerate(ys):
        file = f'{name}-{i:02d}.ogg'
        y = y * (PEAK / top)
        levels.append(loudness(level_window(y, spec['kind'], None)))
        clips.append((file, y))
        files.append(file)
    return [{'ref': None, 'files': files, 'from': [f for f in spec['files']]}], clips, float(np.median(levels))


def build(kbps: int) -> None:
    os.makedirs(OUT, exist_ok=True)
    for old in glob.glob(os.path.join(OUT, '*.ogg')):
        os.remove(old)
    sets = {}
    level = {}
    total = 0
    for name, spec in SETS.items():
        zones, clips, level[name] = (pitched_set if spec['kind'] in ('sustain', 'decay') else hit_set)(name, spec)
        for file, y in clips:
            path = os.path.join(OUT, file)
            encode(y, path, kbps if spec['kind'] == 'sustain' else min(kbps, 96))
            total += os.path.getsize(path)
        sets[name] = {'kind': spec['kind'], 'zones': zones}
        refs = ', '.join(f"{z['ref']}" for z in zones if z['ref'] is not None)
        print(f'{name:9s} {len(clips):2d} files  {level[name]:6.1f} LKFS  {refs}')
    # each score instrument at the loudness of the synthesized one it replaces, so the mix keeps its balance
    gain = {}
    for inst, name in MAP.items():
        gain[inst] = round(float(np.clip(10 ** ((SYNTH_LKFS[inst] - level[name]) / 20), 0.25, 4.5)) * MIX_TRIM, 3)
    print('gains: ' + ', '.join(f'{k[4:]} {v}' for k, v in gain.items()))
    manifest = {
        '$comment': 'Built by tools/music/build.py. Zones: ref = the sample\'s measured MIDI pitch, loop = seconds.',
        'version': 1,
        'map': MAP,
        'gain': gain,
        'sets': sets,
    }
    with open(os.path.join(OUT, 'samples.json'), 'w') as fh:
        json.dump(manifest, fh, indent=1)
        fh.write('\n')
    with open(os.path.join(OUT, 'CREDITS.md'), 'w') as fh:
        fh.write(CREDITS)
    print(f'{total / 1e6:.2f} MB in public/music/')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--fetch', action='store_true', help='sparse-clone the source libraries first')
    ap.add_argument('--kbps', type=int, default=80, help='Opus bit rate for sustained instruments')
    a = ap.parse_args()
    if a.fetch:
        fetch()
    build(a.kbps)
