# Effect flipbooks

`public/fx/{fire,smoke,dust,blast}.webp` (lossless): 8x8-frame sprite sheets of gas
simulated by `gas.py` and rendered in Cycles by `flipbooks.py`. The game plays
them through `src/render/flipbook.ts`: the braziers' flames loop the fire
sheet, and `src/scene/Billows.ts` plays smoke, dust and blasts once (a Tower's
and a Phoenix's death).

Each sheet packs R = smoke lit by a sun above and to the left (sqrt-encoded),
G = opacity, B = flame heat (sqrt-encoded), so the game tints the smoke and
colors the flame per team.

```sh
blender -b -P tools/vfx/flipbooks.py -- fire --preview --out /tmp/fx   # quick look
blender -b -P tools/vfx/flipbooks.py -- fire smoke dust blast            # the real sheets
python3 tools/vfx/preview.py public/fx/blast.webp /tmp/blast.png --frames 0,8,16,32,63
```

`--work DIR` keeps the simulation and frames (default `tools/vfx/out`);
`SKIP_SIM=1` renders the last simulation again and `PACK_ONLY=1` repacks the
last frames. A sheet takes 5 to 15 minutes on four cores.

Why not Blender's own smoke: in the Ubuntu 4.0 package Mantaflow aborts on its
first step under Python 3.12 and Cycles crashes on any OpenVDB volume. So
`gas.py` is a small stable-fluids solver (BFECC advection, vorticity
confinement, an exact DST pressure solve, burning fuel, and expansion where it
burns so a blast bursts outward). The blast uses its second burn model
(`reaction`, `flame_rate`, `glow`): thick fuel is short of air and burns from
its edges inward, and the flame is what burns now plus the glow of gas still
hot from it, so the fireball has hot rolls and darker folds rather than one
flat color, and each frame reaches Cycles as a
slice-atlas image read by a box's volume shader. That build also has no
denoiser, so the packer blurs each frame very slightly.
