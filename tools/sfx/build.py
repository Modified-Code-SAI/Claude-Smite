"""Builds the recorded layers that sit under the synthesized sounds (public/sfx/).

    apt install ffmpeg p7zip-full && pip install numpy scipy soundfile
    python tools/sfx/build.py <download cache dir>

Every sound in the game is synthesized (src/audio/sounds.ts). Synthesis gives
the weight and the variety, but footsteps, blades, punches, rubble, fire and
crowds have a grain that is hard to fake, so those sounds get a recording
mixed underneath: real footsteps, real steel, a real fire. All the sources are
CC0 packs on OpenGameArt (the list below, credited in public/sfx/CREDITS.md).

Each layer is a few short mono clips, one picked per variant. Long takes (a
sword fight, a fire) are cut here: one-shots at their hits, loops into a body
plus a short run-on that the game folds back over the start (src/audio/layers.ts).
The game sets the level against the synthesized sound when it mixes, so here
each clip is only cleaned, trimmed and peak-normalized.
"""
import glob, json, os, re, shutil, subprocess, sys, tempfile, urllib.request
import numpy as np
import soundfile as sf
from scipy.signal import butter, resample_poly, sosfiltfilt

RATE = 48000
here = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(here, '..', '..', 'public', 'sfx')
OGA = 'https://opengameart.org/sites/default/files/'

# pack: (file on OpenGameArt, page, author)
PACKS = {
    'footsteps': ('Fantozzi-footsteps.7z', 'fantozzis-footsteps-grasssand-stone', 'Fantozzi, published by qubodup'),
    'snow': ('corsica_s-walking_in_snow.7z', '42-snow-and-gravel-footsteps', 'Corsica_S, extracted by qubodup'),
    'armor': ('footsteps.zip', 'footsteps-leather-cloth-armor', 'HaelDB'),
    'weapons1': ('medieval_sfx_weapon_on_weapon_1_of_2.7z', 'medieval-sound-effects-weapon-impacts', 'MedicineStorm'),
    'weapons2': ('medieval_sfx_weapon_on_weapon_2_of_2.7z', 'medieval-sound-effects-weapon-impacts', 'MedicineStorm'),
    'clash': ('sword_clash_-_starninjas_0.zip', '20-sword-sound-effects-attacks-and-clashes', 'StarNinjas'),
    'punches': ('independent_nu_ljudbank-hits_and_punches.7z', '37-hitspunches', 'independent.nu, published by qubodup'),
    'impact': ('qubodupImpact.7z', 'impact', 'qubodup'),
    'rubble': ('sfx_breaking_and_falling.zip', '75-cc0-breaking-falling-hit-sfx', 'rubberduck'),
    'cavein': ('cave_in_-_starninjas_0.ogg', 'cave-in', 'StarNinjas'),
    'swishes': ('swishes.zip', 'swishes-sound-pack', 'artisticdude'),
    'rpg': ('rpg_sound_pack.zip', 'rpg-sound-pack', 'artisticdude'),
    'fire': ('fire.wav', 'fireplace-sound-loop', 'PagDev'),
    'crowd': ('crowd_shouting_0.ogg', 'crowd-shoutingspeaking-ambience', 'StarNinjas'),
    'applause': ('applause-clapping-church-crowd-immersive.wav', 'applause-in-a-large-hall-or-church', 'eXpl0it3r'),
}

# sound name (SOUNDS in src/audio/sounds.ts) -> where its layer comes from
#   files: globs inside packs; n: how many clips; cut: 'file' (each file is one clip) or 'hits' (cut a long take at its hits)
#   keep: longest clip in seconds; hp/lp: filters in Hz; mix: layer level against the synthesized sound in dB
#   loop: body length in seconds for a looping sound (a multiple of the synthesized loop's length); env: attack, hold, release
#   drive: soft saturation that tames a recording's sharpest transients
#   same: reuse an earlier sound's clips (no new files), only at this sound's mix
LAYERS = {
    # footsteps: Fantozzi's on stone and on grass and sand, gravel under snow for the dirt paths, leather and mail for minions
    'step.stone': dict(files=['footsteps/**/flac/*Stone*.flac'], n=6, keep=0.38, hp=90, mix=0),
    'step.grass': dict(files=['footsteps/**/flac/*Sand*.flac'], n=6, keep=0.4, hp=90, lp=7000, mix=-1),
    'step.dirt': dict(files=['snow/**/*gravel_0*.flac', 'snow/**/*gravel_1*.flac'], n=8, cut='hits', keep=0.38, hp=110, mix=-2),
    'step.minion': dict(files=['armor/**/step_lth*.ogg', 'armor/**/step_metal*.ogg'], n=8, keep=0.3, hp=120, mix=-4),
    # the Descent's floors are stone too: the same takes, under the ash, the water and the glass the synthesis adds
    'step.basalt': dict(same='step.stone', mix=-2),
    'step.wet': dict(same='step.stone', mix=-4),
    'step.glass': dict(same='step.stone', mix=-3),
    # steel on steel, a sword ringing off a sword or a shield
    'hit.blade': dict(files=['weapons*/*Blade on Blade.wav', 'clash/*.ogg'], n=10, cut='hits', keep=0.55, hp=160, mix=-2, drive=2),
    # a club, a haft or a fist landing
    'hit.blunt': dict(files=['punches/**/hit0[1-9]*.flac', 'punches/**/hit1[0-9]*.flac', 'weapons*/*Haft on Haft.wav', 'impact/**/*Wood.flac'], n=8, cut='hits', keep=0.6, hp=90, mix=-5, drive=2),
    'hit.flesh': dict(files=['punches/**/hit2[0-9]*.flac', 'punches/**/hit3[0-9]*.flac', 'impact/**/*Meat0*.flac'], n=8, cut='hits', keep=0.5, hp=110, mix=-3, drive=2),
    # stone and masonry taking a blow
    'hit.structure': dict(files=['rubble/*rock_hit*.ogg', 'rubble/bfh1_hit_*.ogg', 'impact/**/*Stone.flac'], n=8, cut='hits', keep=0.6, hp=80, mix=-1, drive=2),
    'structure.collapse': dict(files=['cavein/*.ogg'], n=1, keep=4.0, hp=60, mix=-2),
    # weapon swings
    'basic.odin': dict(files=['swishes/**/swish-*.wav', 'rpg/**/battle/swing*.wav'], n=6, keep=0.35, hp=150, mix=-3),
    'basic.loki': dict(files=['swishes/**/swish-*.wav'], n=6, keep=0.3, hp=200, mix=-3, skip=6),
    'basic.minion.melee': dict(files=['rpg/**/battle/swing*.wav', 'swishes/**/swish-*.wav'], n=6, keep=0.3, hp=150, mix=-4, skip=3),
    # beds: a real fire under the synthesized crackle, a real crowd under the synthesized one
    'amb.fire': dict(files=['fire/*.wav'], loop=9.6, hp=60, mix=3),
    'amb.crowd': dict(files=['crowd/*.ogg'], loop=17.2, hp=90, lp=5500, mix=1),
    'amb.cheer': dict(files=['applause/*.wav'], loop=9.2, hp=120, lp=7000, mix=0),
    'crowd.roar': dict(files=['crowd/*.ogg'], n=2, keep=4.2, hp=90, lp=5500, mix=-1, env=(0.22, 1.3, 2.4), offsets=(3.0, 14.0)),
}

CREDITS = """# Recorded sound layers

These clips sit under the game's synthesized sounds. All of them are CC0
(public domain) packs from OpenGameArt, cut, cleaned and re-encoded by
tools/sfx/build.py. Credit is not required, but here it is.

"""


def fetch(cache, pack):
    file = PACKS[pack][0]
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, file)
    if not os.path.exists(path):
        print('fetching', file, flush=True)
        urllib.request.urlretrieve(OGA + file, path)
    folder = os.path.join(cache, 'x', pack)
    if not os.path.isdir(folder):
        os.makedirs(folder)
        if file.endswith('.zip'):
            subprocess.run(['unzip', '-q', '-o', path, '-d', folder], check=True)
        elif file.endswith('.7z'):
            subprocess.run(['7z', 'x', '-y', '-bd', f'-o{folder}', path], check=True, stdout=subprocess.DEVNULL)
        else:
            shutil.copy(path, folder)
    return folder


def load(path):
    x, rate = sf.read(path, always_2d=True, dtype='float64')
    x = x.mean(axis=1)
    if rate != RATE:
        g = np.gcd(rate, RATE)
        x = resample_poly(x, RATE // g, rate // g)
    return x


def envelope(x, ms=5):
    n = max(1, int(RATE * ms / 1000))
    return np.convolve(np.abs(x), np.ones(n) / n, 'same')


def onsets(x, gap=0.3, rel=0.25):
    """The hits in a take: envelope peaks above `rel` of the loudest, at least `gap` apart, each traced back to where it starts."""
    env = envelope(x)
    top = env.max()
    peaks = []
    i = 0
    while i < len(env):
        if env[i] > top * rel:
            j = min(len(env), i + int(gap * RATE))
            p = i + int(np.argmax(env[i:j]))
            start = p
            while start > 0 and env[start] > env[p] * 0.08:
                start -= 1
            peaks.append((start, env[p]))
            i = j
        else:
            i += 1
    return peaks


def clean(x, spec):
    if spec.get('hp'):
        x = sosfiltfilt(butter(2, spec['hp'] / (RATE / 2), 'high', output='sos'), x)
    if spec.get('lp'):
        x = sosfiltfilt(butter(2, spec['lp'] / (RATE / 2), 'low', output='sos'), x)
    return x


def shape(x, keep, env=None, drive=0):
    """Trim to the onset (a 2 ms lead), cut to `keep` seconds with a fade, and normalize the peak."""
    e = envelope(x, 3)
    above = np.where(e > e.max() * 0.05)[0]
    a = max(0, above[0] - int(0.002 * RATE)) if len(above) else 0
    y = x[a:a + int(keep * RATE)].copy()
    # end where the sound has died away, if it does before `keep`
    e = envelope(y, 10)
    alive = np.where(e > e.max() * 10 ** (-42 / 20))[0]
    if len(alive):
        y = y[: min(len(y), alive[-1] + int(0.01 * RATE))]
    if env:
        att, hold, rel = env
        t = np.arange(len(y)) / RATE
        y *= np.clip(t / att, 0, 1) * np.where(t < att + hold, 1, np.clip(1 - (t - att - hold) / rel, 0, 1))
    if drive:
        # round off the sharpest transients, so the hit can sit as loud as the synthesized one without clipping
        y = np.tanh(drive * y / (np.abs(y).max() + 1e-9)) / np.tanh(drive)
    fi, fo = int(0.001 * RATE), min(len(y) // 3, int(0.03 * RATE))
    y[:fi] *= np.linspace(0, 1, fi)
    y[-fo:] *= np.linspace(1, 0, fo)
    return y / (np.abs(y).max() + 1e-9) * 0.89


def clips_for(spec, sources):
    keep = spec['keep']
    if 'offsets' in spec:
        x = load(sources[0])
        return [shape(clean(x[int(o * RATE):], spec), keep, spec.get('env')) for o in spec['offsets']]
    if spec.get('cut') == 'hits':
        # the strongest hit of each take first, then the next strongest, so the clips spread over every source
        per = []
        for f in sources:
            x = clean(load(f), spec)
            hits = onsets(x)
            # each hit runs until the next one starts
            ends = [s - int(0.005 * RATE) for s, _ in hits[1:]] + [len(x)]
            ranked = sorted(zip(hits, ends), key=lambda h: -h[0][1])
            per.append([x[s:e] for (s, _), e in ranked if e - s > int(0.08 * RATE)])
        out, k = [], 0
        while len(out) < spec['n'] and any(len(p) > k for p in per):
            out += [p[k] for p in per if len(p) > k]
            k += 1
        # even when a take holds several hits, spread the picks over the takes
        return [shape(x, keep, spec.get('env'), spec.get('drive', 0)) for x in out[: spec['n']]]
    xs = [clean(load(f), spec) for f in sources]
    return [shape(x, keep, spec.get('env')) for x in xs[: spec['n']]]


def loop_for(spec, source):
    """A body of `loop` seconds plus a 0.1 s run-on, cut where the take is steady (its middle)."""
    x = clean(load(source), spec)
    body = int(spec['loop'] * RATE)
    run = int(0.1 * RATE)
    if len(x) < body + run:
        raise SystemExit(f'{source} is shorter than the loop')
    a = (len(x) - body - run) // 2
    y = x[a:a + body + run]
    return y / (np.abs(y).max() + 1e-9) * 0.89


def opus(y, path, kbps):
    with tempfile.NamedTemporaryFile(suffix='.wav') as wav:
        sf.write(wav.name, y.astype(np.float32), RATE)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav.name, '-ac', '1', '-c:a', 'libopus', '-b:a', f'{kbps}k', path], check=True)


def main():
    cache = sys.argv[1]
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    manifest = {'version': 1, 'layers': {}}
    used = set()
    for name, spec in LAYERS.items():
        if 'same' in spec:
            # another sound's clips at this sound's own level
            manifest['layers'][name] = {'mix': spec['mix'], 'files': list(manifest['layers'][spec['same']]['files'])}
            continue
        sources = []
        for pattern in spec['files']:
            pack = pattern.split('/')[0]
            if pack.endswith('*'):
                packs = [p for p in PACKS if p.startswith(pack[:-1])]
            else:
                packs = [pack]
            for p in packs:
                root = fetch(cache, p)
                used.add(p)
                sources += sorted(glob.glob(os.path.join(root, pattern.split('/', 1)[1]), recursive=True), key=natural)
        sources = [s for s in sources if not os.path.basename(s).startswith('._')][spec.get('skip', 0):]
        if not sources:
            raise SystemExit(f'{name}: no files match {spec["files"]}')
        entry = {'mix': spec['mix']}
        slug = name.replace('.', '-')
        if 'loop' in spec:
            y = loop_for(spec, sources[0])
            file = f'{slug}.ogg'
            opus(y, os.path.join(OUT, file), 64)
            entry.update(files=[file], loop=spec['loop'])
        else:
            files = []
            for i, y in enumerate(clips_for(spec, sources)):
                file = f'{slug}-{i + 1}.ogg'
                opus(y, os.path.join(OUT, file), 96)
                files.append(file)
            entry['files'] = files
        manifest['layers'][name] = entry
        print(name, len(entry['files']), 'clips from', len(sources), 'files', flush=True)
    json.dump(manifest, open(os.path.join(OUT, 'layers.json'), 'w'), indent=1)
    lines = [CREDITS]
    for p in sorted(used, key=lambda p: PACKS[p][1]):
        file, page, author = PACKS[p]
        lines.append(f'- [{page}](https://opengameart.org/content/{page}) by {author}, CC0\n')
    open(os.path.join(OUT, 'CREDITS.md'), 'w').write(''.join(dict.fromkeys(lines)))
    size = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f'{len(manifest["layers"])} layers, {size / 1e3:.0f} kB')


def natural(s):
    return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', s)]


if __name__ == '__main__':
    main()
