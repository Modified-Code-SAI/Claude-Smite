"""Speaks the gods' heated lines (kills, streaks, ultimates, deaths, taunts) with
feeling, in each god's own voice, into public/voices/<god>/<kind>-<n>.mp3.

    pip install chatterbox-tts "setuptools<81" soundfile scipy
    node tools/voices/lines.mjs > /tmp/lines.json
    python tools/voices/speak.py kokoro-v1.0.onnx voices-v1.0.bin /tmp/lines.json --refs /tmp/refs
    python tools/voices/shout.py /tmp/lines.json /tmp/refs [god,god/kind-n...]

Kokoro (speak.py) reads every line evenly. Chatterbox (Resemble AI, MIT) can
shout, gloat and gasp, and it clones a voice from a short sample, so each god's
clean Kokoro voice is the sample and the take gets the god's usual treatment
afterwards (speak.treat): the god still sounds like itself, only angrier.

Chatterbox samples its takes, so each line gets several and the script keeps
the best: Whisper must hear every word of the line, the voice must match the
god's sample, and a take that runs long (a stray breath or babble) loses. A
line with no take that passes keeps its Kokoro reading. shouts.json records
which take won and why, so a rerun can be compared.
"""
import json, os, re, subprocess, sys, tempfile
import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import speak  # noqa: E402  (treatment, trim, level and the cast)

RATE = speak.RATE
here = os.path.dirname(os.path.abspath(__file__))

# how hard each kind of line is pushed: Chatterbox's exaggeration (0.5 is a plain read)
HEAT = {
    'start': 0.6, 'kill': 0.75, 'streak': 0.85, 'ult': 1.0, 'death': 0.7, 'respawn': 0.6, 'taunt': 0.65,
    # the Jötunn
    'brazier': 0.6, 'kneel': 0.85, 'shrine': 0.6, 'stand': 1.0, 'win': 0.8,
}
# the Jötunn's death is a slow fade, not a scream
HEAT_BY_GOD = {('jotunn', 'death'): 0.55, ('jotunn', 'start'): 0.65}
TAKES = 3
# lower guidance with more exaggeration keeps the pace from rushing
CFG = 0.35
# below this the take sounds like someone else (cosine similarity of voice embeddings)
MIN_MATCH = 0.75


NUMBERS = 'zero one two three four five six seven eight nine ten eleven twelve'.split()
# names Whisper cannot spell: each matches any one heard word
NAMES = {"r'lyeh"}


def words(text):
    text = text.lower().replace('’', "'")
    # Whisper writes "Round 2", the line says "Round two"
    return [NUMBERS[int(w)] if w.isdigit() and int(w) < len(NUMBERS) else w for w in re.findall(r"[a-z0-9']+", text)]


def wer(ref, hyp):
    r, h = words(ref), words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1] and r[i - 1] not in NAMES))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))


def main():
    import librosa
    import torch
    from chatterbox.tts import ChatterboxTTS
    from transformers import pipeline

    lines = json.load(open(sys.argv[1]))
    refs = sys.argv[2]
    # gods, or single lines as god/kind-n
    only = set(sys.argv[3].split(',')) if len(sys.argv) > 3 else None
    torch.set_num_threads(os.cpu_count() or 4)
    tts = ChatterboxTTS.from_pretrained(device='cpu')
    asr = pipeline('automatic-speech-recognition', model='openai/whisper-small.en', device='cpu')
    report_path = os.path.join(here, 'shouts.json')
    report = json.load(open(report_path)) if os.path.exists(report_path) else {}

    def embed(x):
        return tts.ve.embeds_from_wavs([librosa.resample(x.astype(np.float32), orig_sr=RATE, target_sr=16000)], sample_rate=16000).mean(0)

    for god, kinds in lines.items():
        if only and god not in only and not any(o.startswith(f'{god}/') for o in only):
            continue
        c = speak.CAST[god]
        ref_path = os.path.join(refs, f'{god}.wav')
        tts.prepare_conditionals(ref_path)
        ref, _ = librosa.load(ref_path, sr=RATE)
        me = embed(ref)
        rng = np.random.default_rng(sum(map(ord, god)) + 1)
        folder = os.path.join(speak.out_root, god)
        for kind, texts in kinds.items():
            heat = HEAT_BY_GOD.get((god, kind), HEAT.get(kind))
            if heat is None:
                continue
            for n, text in enumerate(texts):
                key = f'{god}/{kind}-{n + 1}'
                if only and god not in only and key not in only:
                    continue
                takes = []
                for t in range(TAKES):
                    torch.manual_seed(1000 * n + t + sum(map(ord, key)))
                    x = tts.generate(text, exaggeration=heat, cfg_weight=CFG).squeeze(0).numpy().astype(np.float64)
                    assert tts.sr == RATE, tts.sr
                    x = speak.trim(x)
                    heard = asr({'raw': x.astype(np.float32), 'sampling_rate': RATE})['text'].strip()
                    e = embed(x)
                    m = me @ e / (np.linalg.norm(me) * np.linalg.norm(e) + 1e-9)
                    takes.append(dict(x=x, heard=heard, wer=round(wer(text, heard), 3), match=round(float(m), 3), dur=round(len(x) / RATE, 2)))
                median = float(np.median([k['dur'] for k in takes]))
                for k in takes:
                    k['score'] = k['match'] - k['wer'] - 0.5 * max(0.0, k['dur'] / median - 1.2)
                ok = [k for k in takes if k['wer'] == 0 and k['match'] >= MIN_MATCH]
                summary = [{f: k[f] for f in ('heard', 'wer', 'match', 'dur')} for k in takes]
                if not ok:
                    report[key] = dict(text=text, kept='kokoro', takes=summary)
                    print(key, 'kept Kokoro:', summary, flush=True)
                    continue
                best = max(ok, key=lambda k: k['score'])
                pick = next(i for i, k in enumerate(takes) if k is best)
                y = speak.level(speak.trim(speak.treat(best['x'], c, rng)))
                path = os.path.join(folder, f'{kind}-{n + 1}.mp3')
                with tempfile.NamedTemporaryFile(suffix='.wav') as wav:
                    sf.write(wav.name, y.astype(np.float32), RATE)
                    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav.name, '-ac', '1', '-ar', str(RATE), '-b:a', '48k', path], check=True)
                report[key] = dict(text=text, kept='chatterbox', heat=heat, take=pick, match=best['match'], dur=round(len(y) / RATE, 2), takes=summary)
                print(key, f"take {pick} match {best['match']}", text, flush=True)
                json.dump(report, open(report_path, 'w'), indent=1, sort_keys=True)
        json.dump(report, open(report_path, 'w'), indent=1, sort_keys=True)
    kept = sum(1 for r in report.values() if r['kept'] == 'chatterbox')
    print(f'{kept} of {len(report)} heated lines now Chatterbox')


if __name__ == '__main__':
    main()
