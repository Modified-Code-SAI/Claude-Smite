"""Speaks the gods' and the Jötunn's lines (src/audio/godLines.ts) into public/voices/<god>/<kind>-<n>.mp3.

    pip install kokoro-onnx soundfile scipy
    # model files from https://github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0)
    node tools/voices/lines.mjs > /tmp/lines.json
    python tools/voices/speak.py kokoro-v1.0.onnx voices-v1.0.bin /tmp/lines.json [god,god...]
    # clean, untreated takes of each voice for shout.py to clone: writes <dir>/<god>.wav
    python tools/voices/speak.py kokoro-v1.0.onnx voices-v1.0.bin /tmp/lines.json --refs <dir>

Kokoro is an Apache-2.0 open model, so the lines are free to ship. Each god
has a voice of its own: a Kokoro voice (or a blend of two), a pitch drop,
and a little treatment (a hall for Zeus, grit for Thor, breath for Odin, a
sly double for Loki, a tomb for Anubis), all done here so the game only
plays small files.
"""
import json, os, subprocess, sys, tempfile
import numpy as np
import soundfile as sf
from scipy.signal import butter, fftconvolve, resample_poly, sosfilt
from fractions import Fraction

RATE = 24000
here = os.path.dirname(os.path.abspath(__file__))
out_root = os.path.join(here, '..', '..', 'public', 'voices')

# voice: a Kokoro voice, or {voice: weight} to blend; semitones: pitch drop (and throat size) by resampling
CAST = {
    'zeus': dict(voice='am_michael', lang='en-us', speed=0.94, semitones=-2.0, room=(1.6, 0.16), grit=0.0, breath=0.0, double=0.0),
    'thor': dict(voice='am_fenrir', lang='en-us', speed=1.04, semitones=-1.5, room=(0.5, 0.08), grit=0.35, breath=0.0, double=0.0),
    'odin': dict(voice='bm_fable', lang='en-gb', speed=0.96, semitones=-3.0, room=(0.7, 0.1), grit=0.0, breath=0.05, double=0.0),
    'loki': dict(voice='am_puck', lang='en-us', speed=1.04, semitones=0.0, room=(0.35, 0.05), grit=0.0, breath=0.0, double=0.14),
    'anubis': dict(voice={'am_onyx': 0.55, 'am_fenrir': 0.45}, lang='en-us', speed=0.88, semitones=-4.0, room=(0.9, 0.15), grit=0.1, breath=0.07, double=0.2),
    # Thanatos: soft and close, a little slow, with a faint ghostly double
    'thanatos': dict(voice={'bm_george': 0.5, 'am_echo': 0.5}, lang='en-gb', speed=0.9, semitones=-1.5, room=(1.4, 0.14), grit=0.0, breath=0.05, double=0.08),
    # Kukulkan: a priest-king's measured voice in a stone temple, with a serpent's breath under it
    'kukulkan': dict(voice={'am_liam': 0.45, 'am_onyx': 0.55}, lang='en-us', speed=0.88, semitones=-2.5, room=(1.8, 0.18), grit=0.0, breath=0.12, double=0.1),
    # Cthulhu: slow and enormous, a drowned cathedral of a room, a second voice under the first
    'cthulhu': dict(voice={'bm_lewis': 0.5, 'am_onyx': 0.5}, lang='en-gb', speed=0.84, semitones=-4.5, room=(2.0, 0.2), grit=0.12, breath=0.1, double=0.35),
    # the Jötunn: far deeper than any god (the drop slows it too), hollow, in a hall of ice
    'jotunn': dict(voice={'am_onyx': 0.65, 'am_fenrir': 0.35}, lang='en-us', speed=1.0, semitones=-5.5, room=(2.2, 0.2), grit=0.18, breath=0.04, double=0.3),
}


def style(k, voice):
    if isinstance(voice, str):
        return voice
    return sum(k.get_voice_style(v) * w for v, w in voice.items())


def pitch(x, semitones):
    """Lower (or raise) pitch and formants together by resampling: a bigger throat, a slower delivery."""
    if not semitones:
        return x
    f = Fraction(2 ** (-semitones / 12)).limit_denominator(200)
    return resample_poly(x, f.numerator, f.denominator)


def lowshelf(x, hz, db):
    sos = butter(2, hz / (RATE / 2), 'low', output='sos')
    return x + (10 ** (db / 20) - 1) * sosfilt(sos, x)


def band(x, lo, hi):
    return sosfilt(butter(2, [lo / (RATE / 2), hi / (RATE / 2)], 'band', output='sos'), x)


def envelope(x, ms=12):
    n = max(1, int(RATE * ms / 1000))
    return np.convolve(np.abs(x), np.ones(n) / n, 'same')


def room(x, seconds, wet, rng):
    """A plain synthetic room: decaying, darkening noise."""
    n = int(RATE * seconds)
    t = np.arange(n) / RATE
    ir = rng.standard_normal(n) * np.exp(-6.9 * t / seconds)
    ir = sosfilt(butter(1, 3500 / (RATE / 2), 'low', output='sos'), ir)
    ir[: int(RATE * 0.012)] *= np.linspace(0, 1, int(RATE * 0.012))
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
    tail = np.concatenate([x, np.zeros(n)])
    return tail + wet * fftconvolve(tail, ir)[: len(tail)]


def treat(x, c, rng):
    x = pitch(x, c['semitones'])
    if c['double']:
        # a second voice a hair lower and later: a sly, or hollow, double
        d = pitch(x, -0.35)[: len(x)]
        d = np.concatenate([np.zeros(int(RATE * 0.018)), d])[: len(x)]
        x = x + c['double'] * d
    if c['grit']:
        drive = 3.0
        x = (1 - c['grit']) * x + c['grit'] * np.tanh(drive * x / (np.max(np.abs(x)) + 1e-9)) * np.max(np.abs(x)) / np.tanh(drive)
    if c['breath']:
        # breath that rides the voice: noise in the upper band, following its loudness
        noise = band(rng.standard_normal(len(x)), 1800, 6500)
        x = x + c['breath'] * noise * envelope(x) / (np.std(noise) + 1e-9) * 2.0
    # weight in the low end (the game leans on bass), presence where the consonants are, and nothing rumbling below the voice
    x = lowshelf(x, 200, 1.5)
    x = x + 0.5 * band(x, 2200, 6000)
    x = sosfilt(butter(2, 70 / (RATE / 2), 'high', output='sos'), x)
    x = room(x, c['room'][0], c['room'][1], rng)
    return x


def trim(x, floor_db=-48):
    """Cut leading and trailing silence, keeping a short lead and a fade."""
    env = envelope(x, 6)
    above = np.where(env > np.max(env) * 10 ** (floor_db / 20))[0]
    if not len(above):
        return x
    a = max(0, above[0] - int(RATE * 0.02))
    b = min(len(x), above[-1] + int(RATE * 0.05))
    y = x[a:b].copy()
    fi, fo = int(RATE * 0.005), int(RATE * 0.04)
    y[:fi] *= np.linspace(0, 1, fi)
    y[-fo:] *= np.linspace(1, 0, fo)
    return y


def level(x, target_db=-17.0, peak_db=-1.0):
    """Even loudness from line to line (active-speech RMS), and a peak ceiling."""
    env = envelope(x, 30)
    active = x[env > np.max(env) * 0.1]
    rms = np.sqrt(np.mean(active ** 2)) if len(active) else 1e-6
    y = x * (10 ** (target_db / 20) / (rms + 1e-9))
    peak = np.max(np.abs(y))
    ceil = 10 ** (peak_db / 20)
    if peak > ceil:
        # a soft knee instead of a hard clip
        y = np.tanh(y / ceil) * ceil
    return y


def references(k, lines, out_dir):
    """Each voice untreated (no pitch drop, room or grit), about ten seconds of its
    calmer lines: the sample shout.py clones, before the same treatment."""
    os.makedirs(out_dir, exist_ok=True)
    for god, kinds in lines.items():
        c = CAST[god]
        texts = [*kinds.get('select', []), *kinds.get('start', []), *kinds.get('omw', []), *kinds.get('respawn', [])]
        parts, total = [], 0.0
        for text in texts:
            samples, rate = k.create(text, voice=style(k, c['voice']), speed=c['speed'], lang=c['lang'])
            x = trim(np.asarray(samples, dtype=np.float64))
            parts += [x, np.zeros(int(RATE * 0.35))]
            total += len(x) / RATE
            if total > 10:
                break
        y = level(np.concatenate(parts))
        sf.write(os.path.join(out_dir, f'{god}.wav'), y.astype(np.float32), RATE)
        print(god, f'{total:.1f} s reference')


def main():
    from kokoro_onnx import Kokoro
    k = Kokoro(sys.argv[1], sys.argv[2])
    lines = json.load(open(sys.argv[3]))
    if len(sys.argv) > 5 and sys.argv[4] == '--refs':
        references(k, lines, sys.argv[5])
        return
    only = set(sys.argv[4].split(',')) if len(sys.argv) > 4 else None
    report = {}
    for god, kinds in lines.items():
        if only and god not in only:
            continue
        c = CAST[god]
        rng = np.random.default_rng(sum(map(ord, god)))
        folder = os.path.join(out_root, god)
        os.makedirs(folder, exist_ok=True)
        for kind, texts in kinds.items():
            for n, text in enumerate(texts):
                samples, rate = k.create(text, voice=style(k, c['voice']), speed=c['speed'], lang=c['lang'])
                assert rate == RATE, rate
                y = level(trim(treat(np.asarray(samples, dtype=np.float64), c, rng)))
                path = os.path.join(folder, f'{kind}-{n + 1}.mp3')
                with tempfile.NamedTemporaryFile(suffix='.wav') as wav:
                    sf.write(wav.name, y.astype(np.float32), RATE)
                    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav.name, '-ac', '1', '-ar', str(RATE), '-b:a', '48k', path], check=True)
                report[f'{god}/{kind}-{n + 1}'] = round(len(y) / RATE, 2)
                print(god, kind, n + 1, report[f'{god}/{kind}-{n + 1}'], 's', text)
    print(f'{len(report)} lines, {sum(report.values()):.1f} s')


if __name__ == '__main__':
    main()
