# Hero portraits

Full-length renders of each god for the god pick screen, made in Blender's
Cycles from the game's own models: `public/hero/<god>.webp`, 1200x1800 with a
transparent background.

The frame is fixed so every portrait lines up: the god stands in a heroic idle
turned about 24 degrees, the top of the head (crown, ears and crests count)
5% from the top, the feet 94% down, and weapons and wings inside the middle
80% of the width. A soft contact shadow under the feet and the glow around
anything that burns (lightning, eyes, runes, torches) are part of the alpha,
so they show over whatever the page puts behind.

## Making them again

After a god's model, palette or idle changes:

```sh
npx vite                                   # dev server, in another terminal
node tools/hero/dump.cjs [zeus,thor,...]   # -> tools/hero/out/<god>.json
blender -b --factory-startup -P tools/hero/render.py -- <god>
```

Then cut the god's card picture (head and shoulders, 320x400, for the god strip,
the team slots and the lobby seats) from the new render:

```sh
python3 tools/hero/faces.py <god>          # -> public/hero/face/<god>.webp
```

Check it on a contact sheet; a god whose face sits off-centre gets a `NUDGE`.

The dump takes a few seconds per god; a render about six minutes on four CPU
cores. `--preview` renders a 40% size PNG in about 20 seconds to check the
look (`tools/hero/out/<god>-preview.png`), `--crop x0,y0,x1,y1` renders one
region at full size, and `--blend file.blend` saves the scene to open in
Blender. `--samples`, `--key`, `--fill`, `--rim`, `--spec`, `--env` and
`--exposure` tune the light without editing the script. The render prints how
much of the width the god uses; keep it at 80% or under.

Needs Playwright (for the dump), Blender 4.2 or newer (Ubuntu's 4.0 lacks the
denoiser the script asks for) and Pillow in the system Python (the WebP).

## How it works

- `dump.ts` (opened by `dump.cjs`) builds the god with `GodModel` exactly as
  the game does, but with merging off (`mergeSwitch`), so every piece keeps
  its forge name. It plays the idle for three seconds so capes settle, layers
  a little extra chest and chin (`HERO`), then skins every piece on the CPU
  and saves positions, normals, uvs, the vertex data the materials read
  (`color`, `_edge`, `_side`, `_ao`), which vertices follow the head, and the
  palette.
- `render.py` rebuilds each material from `src/actors/gods/materials.ts` as a
  Cycles node tree from the same palette and vertex data (skin with
  subsurface scattering, engraved and trimmed metal, embroidered cloth,
  stitched leather, hair, scales, ice), then adds what a path tracer gives on
  top: real occlusion (the baked one is kept at half strength), bump detail,
  and a studio rig. The key and fill light only diffusely; metal takes its
  highlights from narrow softboxes in a dark studio environment, so gold reads
  as gold rather than one flat yellow. One rim light is tinted with the god's
  glow colour.
- Wings that spread wider than the frame are folded down and back about their
  root, by piece name (`FOLD`: Thanatos and Kukulkan fold theirs to rest,
  Cthulhu sweeps his back), and a god can take a little less turn or its own
  exposure (`SHOT`).
- The camera looks level from below the chest (a hero angle with straight
  verticals); its lens and shift are solved so the head and feet land exactly
  on the spec. A bloom on the emission pass raises the alpha where the glow
  leaves the silhouette.
- Cycles' shadow catcher darkens the whole floor in view, so `webp.py` keeps
  only a soft contact shadow round the feet and fades anything see-through out
  before the picture's edge.
- Blender's Python has no Pillow, so `webp.py` grades the PNG (a fifth more
  saturation than AgX leaves, for the game's saturated look) and packs it with
  the system Python (lossy colour, exact alpha). Re-grading needs no render:
  `python3 tools/hero/webp.py tools/hero/out/<god>.png public/hero/<god>.webp`.

Blender gotcha: Cycles reads a mesh attribute named `color` as black, so the
vertex data is stored as `vdata`.
