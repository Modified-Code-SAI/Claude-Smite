# Baked collapses

A lane Tower that breaks into blocks and falls into a pile, and a Phoenix whose
bird bursts into feathers that drift down and burn away (rising, the same run
backward), simulated with Blender's rigid bodies and played back in the game by
`src/scene/structures/collapse.ts`.

The game loads `public/models/collapse/{tower,phoenix}.bin` at startup. A
missing file leaves that structure sinking into its rubble as before.

## Making them again

Only when a Tower's or Phoenix's model changes (the pieces are cut from the
model as the game builds it):

```sh
npx vite                                   # dev server, in another terminal
node tools/collapse/dump.cjs               # -> tools/collapse/out/parts.json
blender -b -P tools/collapse/bake.py -- tower   --look /tmp/collapse-look
blender -b -P tools/collapse/bake.py -- phoenix --look /tmp/collapse-look
```

Each bake takes about a minute. `--look DIR` renders ten frames of the fall in
Cycles for a quick check. `DEBUG=1` prints the force fields and a few pieces'
positions for the first frames. Ubuntu's Blender 4.0 package is enough.

## How it works

- `dump.ts` (opened by `dump.cjs`) builds the models with merging turned off
  and exports every part in the structure's own space, labeled with its
  material.
- `bake.py` joins the Tower's keep with its bands, pilasters, frieze and studs
  and cuts it into 26 Voronoi cells (each cell intersected with the stone, so
  the outside keeps the game's faces and the breaks get new ones in the same
  stone). The crown slab, columns, entablature and roof break the same way;
  banners fall on their own. The Phoenix's bird comes apart into its head,
  body and every feather.
- Each piece gets a rigid proxy: its convex hull, shrunk a little, so blocks
  whose hulls overlap where trim sticks out don't burst apart on the first
  frame. A short burst inside the keep and a shove at the crown bring the Tower
  down; a flare and a gust tear the bird apart. Blender's fields push rigid
  bodies weakly (strength 100 gives a 1 kg body about 6.6 m/s²).
- The file (gzip) holds the rest geometry (positions, normals where the game's
  survive, uvs, piece index, one index range per material) and a float
  texture: row 0 the pieces' pivots, then for each frame a row of position and
  scale and a row of turns. Feathers' scale runs to 0 as they burn.
- In the game one mesh per structure draws every piece, a draw per material.
  The vertex shader blends the two frames around the current time. The pieces'
  materials come from a second material library that reads the rest pose
  (`SurfaceSpace` in `src/scene/Materials.ts`), so stone, cracks and grime stay
  on a block as it tumbles while its lighting turns with it. The previous
  frame feeds the velocity buffer, so TRAA doesn't smear falling blocks. The
  meshes are drawn while loading, so a collapse builds no shader mid-match.
