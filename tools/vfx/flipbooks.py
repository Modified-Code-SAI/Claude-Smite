"""Simulates the game's smoke, fire, dust and explosion and renders each in
Blender's Cycles into a flipbook sprite sheet for src/render/flipbook.ts.

    blender -b -P tools/vfx/flipbooks.py -- [sheet ...] [--preview] [--out DIR] [--work DIR]

Sheets: fire (a looping brazier flame), smoke (a rising puff), dust (a
ground-hugging ring burst) and blast (a fireball that rolls into smoke). With
no names it makes all four. Each gas is simulated by tools/vfx/gas.py (our own
stable-fluids solver: Blender 4.0's Mantaflow aborts under Python 3.12), then
each frame is handed to Cycles as a slice-atlas image sampled by a box mesh's
volume shader (OpenVDB volume objects crash Cycles in the Ubuntu build). The
emission, lit volume and alpha passes are packed into one 8x8 atlas, written
to public/fx/<sheet>.webp:

    R = the smoke as lit by a sun above and to the left (sqrt-encoded)
    G = opacity
    B = flame heat (sqrt-encoded)

The game tints the smoke and colors the flame per effect, so one sheet serves
every team color. `--preview` renders a quick low-resolution pass to check
timing and framing; tools/vfx/preview.py composites a sheet for a look.
Environment: SKIP_SIM=1 reuses the last simulation in --work, PACK_ONLY=1
repacks the last rendered frames, COARSE=1 doubles the voxel size, and
SUPERSAMPLE=2 renders at twice the size and averages down. Sims take 2 to 5
minutes each; renders 4 to 10. Needs Blender 4.0 with scipy (apt
python3-scipy) and PIL (apt python3-pil); there is no denoiser in that build,
so the packer blurs each frame very slightly instead.
"""
import math
import os
import sys
import time

import faulthandler
faulthandler.enable()

import bpy
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

# Every sheet is COLS x ROWS frames of `frame` pixels (width, height).
COLS = 8
ROWS = 8
FRAMES = COLS * ROWS

# Per sheet: the domain box in meters and its voxel size, the camera (an
# orthographic view of `ortho` meters across, looking at `look`, raised by
# `elevation` degrees), the source and the gas (see gas.py for both).
SHEETS = {
    # A brazier flame that loops: the frames after it has settled, with the
    # last `blend` frames crossfaded into the first so the loop has no seam.
    'fire': dict(
        frame=(128, 256), domain=(2.2, 2.2, 4.0), voxel=0.034, ortho=4.0, look=(1.1, 1.1, 2.0), elevation=0,
        settle=40, blend=16, loop=True,
        source=dict(shape='sphere', at=(1.1, 1.1, 0.22), size=(0.38, 0.38, 0.16), fuel=1.0, heat=0.6, velocity=(0, 0, 1.6), swirl=0.9, churn=1.2, churn_speed=26),
        gas=dict(beta=5.5, alpha=0.05, vorticity=2.5, burn=1.7, flame_heat=3.0, flame_smoke=0.05, flame_gain=2.0, dissolve=1.6, cool=2.2),
        shade=dict(density=6.0, flame=20.0),
    ),
    # A billowing puff that rises and thins out.
    'smoke': dict(
        frame=(256, 256), domain=(6.0, 6.0, 6.0), voxel=0.0625, ortho=6.0, look=(3.0, 3.0, 3.0), elevation=0,
        settle=0, loop=False,
        source=dict(shape='sphere', at=(3.0, 3.0, 1.6), size=(1.0, 1.0, 0.9), density=1.0, heat=0.5, velocity=(0, 0, 1.6), normal=4.0, until=6, swirl=1.6, churn=1.5),
        gas=dict(beta=0.9, alpha=0.05, vorticity=3.0, dissolve=0.3, cool=2.0),
        shade=dict(density=9.0, flame=0.0),
    ),
    # Dust thrown out low along the ground, as when stone hits the earth;
    # filmed from above like the game's camera.
    'dust': dict(
        frame=(256, 128), domain=(9.0, 9.0, 3.0), voxel=0.0625, ortho=9.0, look=(4.5, 4.5, 0.8), elevation=28,
        settle=0, loop=False,
        source=dict(shape='disc', at=(4.5, 4.5, 0.35), size=(1.5, 1.5, 0.4), density=1.0, heat=0.2, velocity=(0, 0, 1.3), normal=5.0, flat=True, until=6, swirl=2.0, churn=1.6),
        gas=dict(beta=0.4, alpha=0.0, vorticity=3.5, dissolve=0.4, cool=1.0),
        shade=dict(density=7.0, flame=0.0),
    ),
    # A fireball that burns out into a rolling cloud of smoke.
    'blast': dict(
        frame=(256, 256), domain=(6.4, 6.4, 6.4), voxel=0.0571, ortho=6.4, look=(3.2, 3.2, 3.2), elevation=0,
        settle=0, loop=False,
        source=dict(shape='sphere', at=(3.2, 3.2, 2.2), size=(0.7, 0.7, 0.7), fuel=1.6, density=0.8, heat=1.2, velocity=(0, 0, 1.0), normal=6.0, until=3, swirl=2.5, churn=1.5),
        # the fuel burns from its edges inward and the hot gas glows as it cools, so the fireball has a hot heart and darker folds
        gas=dict(beta=1.2, alpha=0.05, vorticity=6.0, burn=4.0, reaction=0.85, fuel_ref=1.6, flame_rate=0.6, glow=1.0, ignite=0.6, sharp_heat=True,
                 flame_heat=2.0, flame_smoke=1.6, expand=2.2, dissolve=0.15, cool=2.2),
        shade=dict(density=8.0, flame=24.0),
    ),
}

SUBSTEPS = 2
# Frames render at this multiple of their size and are averaged down (2 halves the noise, at 4x the time).
SUPERSAMPLE = int(os.environ.get('SUPERSAMPLE', '1'))


def args():
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = os.path.join(ROOT, 'public', 'fx')
    work = os.path.join(ROOT, 'tools', 'vfx', 'out')
    names = []
    preview = False
    i = 0
    while i < len(a):
        if a[i] == '--preview':
            preview = True
        elif a[i] == '--out':
            out = a[i + 1]
            i += 1
        elif a[i] == '--work':
            work = a[i + 1]
            i += 1
        else:
            names.append(a[i])
        i += 1
    return names or list(SHEETS), preview, out, work


def reset():
    # (read_factory_settings would be simpler, but crashes Blender 4.0 when called from a script)
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.volumes, bpy.data.materials, bpy.data.textures, bpy.data.cameras, bpy.data.lights, bpy.data.worlds, bpy.data.images):
        for item in list(coll):
            coll.remove(item)
    scene = bpy.context.scene
    scene.render.fps = 30
    scene.frame_set(1)
    return scene


def simulate(s, sim_dir, preview):
    """Runs the gas and saves each rendered frame's density and flame (float16 .npz)."""
    sys.path.insert(0, os.path.dirname(__file__))
    from gas import Gas

    h = voxel(s, preview)
    shape = tuple(int(round(d / h)) for d in s['domain'])
    gas = Gas(shape, h)
    src = dict(s['source'])
    src['at_cell'] = [c / h - 0.5 for c in src['at']]
    mask = gas.mask(src['shape'], src['at'], src['size'])
    dt = 1 / 30 / SUBSTEPS
    os.makedirs(sim_dir, exist_ok=True)
    t0 = time.time()
    print(f'  grid {shape} = {np.prod(shape) / 1e6:.2f}M cells', flush=True)
    for f in range(1, last_frame(s)):
        for _ in range(SUBSTEPS):
            if f <= src.get('until', 10 ** 9):
                gas.emit(mask, src, dt)
            gas.step(dt, s['gas'])
        if f >= first_frame(s):
            np.savez_compressed(os.path.join(sim_dir, f'{f:04d}.npz'), density=gas.density.astype(np.float16), flame=gas.flame.astype(np.float16))
        if f % 10 == 0:
            speed = np.sqrt((gas.u ** 2).sum(axis=0)).max()
            print(f'  frame {f}/{last_frame(s) - 1}  {time.time() - t0:.0f}s  density {gas.density.max():.2f} flame {gas.flame.max():.2f} speed {speed:.1f}', flush=True)


def voxel(s, preview):
    return s['voxel'] * (2 if os.environ.get('COARSE') else 1)


def atlas_layout(shape):
    """Slices of the grid along z laid out as tiles: (columns, rows)."""
    nz = shape[2]
    cols = int(math.ceil(math.sqrt(nz)))
    return cols, int(math.ceil(nz / cols))


def to_atlas(fields, shape):
    """Packs [x, y, z] grids into one RGBA float image of z slices (Blender pixel order: rows bottom up)."""
    nx, ny, nz = shape
    cols, rows = atlas_layout(shape)
    img = np.zeros((rows * ny, cols * nx, 4), np.float32)
    for c, f in enumerate(fields):
        for k in range(nz):
            r, q = divmod(k, cols)
            # tile pixel (x, y) holds cell (x, y, k)
            img[r * ny:(r + 1) * ny, q * nx:(q + 1) * nx, c] = f[:, :, k].T
    img[..., 3] = 1
    return img


def make_volume(scene, s, preview):
    """A box the size of the domain whose volume shader reads the gas from a slice atlas.

    (Cycles in the Ubuntu 4.0 build crashes rendering OpenVDB volumes, so the
    grid reaches it as an image instead.)"""
    h = voxel(s, preview)
    shape = tuple(int(round(d / h)) for d in s['domain'])
    cols, rows = atlas_layout(shape)
    nx, ny, nz = shape
    img = bpy.data.images.new('gas', cols * nx, rows * ny, alpha=True, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    sx, sy, sz = s['domain']
    mesh = bpy.data.meshes.new('box')
    verts = [(x, y, z) for x in (0, sx) for y in (0, sy) for z in (0, sz)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    mesh.from_pydata(verts, [], faces)
    ob = bpy.data.objects.new('gas', mesh)
    scene.collection.objects.link(ob)
    volume_material(ob, s['shade'], img, shape, cols, rows)
    return img, shape


def volume_material(ob, shade, img, shape, cols, rows):
    mat = bpy.data.materials.new('gas')
    mat.use_nodes = True
    mat.cycles.homogeneous_volume = False
    mat.cycles.volume_interpolation = 'LINEAR'
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    N = nt.nodes.new
    L = nt.links.new
    nx, ny, nz = shape

    def math(op, a, b=None, c=None):
        m = N('ShaderNodeMath')
        m.operation = op
        for i, v in enumerate((a, b, c)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                m.inputs[i].default_value = v
            else:
                L(v, m.inputs[i])
        return m.outputs[0]

    tc = N('ShaderNodeTexCoord')
    sep = N('ShaderNodeSeparateXYZ')
    L(tc.outputs['Generated'], sep.inputs[0])
    gx, gy, gz = sep.outputs
    zf = math('SUBTRACT', math('MULTIPLY', gz, nz), 0.5)
    z0 = math('MAXIMUM', math('FLOOR', zf), 0)
    z1 = math('MINIMUM', math('ADD', z0, 1), nz - 1)
    t = math('MAXIMUM', math('MINIMUM', math('SUBTRACT', zf, math('FLOOR', zf)), 1), 0)

    def tap(z):
        col = math('FLOORED_MODULO', z, cols)
        row = math('FLOOR', math('DIVIDE', z, cols))
        # half a texel in from each tile edge, so linear filtering never reads the next tile
        fx = math('ADD', math('MULTIPLY', gx, (nx - 1) / nx), 0.5 / nx)
        fy = math('ADD', math('MULTIPLY', gy, (ny - 1) / ny), 0.5 / ny)
        u = math('DIVIDE', math('ADD', col, fx), cols)
        v = math('DIVIDE', math('ADD', row, fy), rows)
        comb = N('ShaderNodeCombineXYZ')
        L(u, comb.inputs[0])
        L(v, comb.inputs[1])
        tex = N('ShaderNodeTexImage')
        tex.image = img
        tex.interpolation = 'Linear'
        tex.extension = 'CLIP'
        L(comb.outputs[0], tex.inputs['Vector'])
        sepc = N('ShaderNodeSeparateColor')
        L(tex.outputs['Color'], sepc.inputs[0])
        return sepc.outputs[0], sepc.outputs[1]

    d0, f0 = tap(z0)
    d1, f1 = tap(z1)
    dens = math('ADD', math('MULTIPLY', d0, math('SUBTRACT', 1, t)), math('MULTIPLY', d1, t))
    flame = math('ADD', math('MULTIPLY', f0, math('SUBTRACT', 1, t)), math('MULTIPLY', f1, t))
    out = N('ShaderNodeOutputMaterial')
    vol = N('ShaderNodeVolumePrincipled')
    vol.inputs['Color'].default_value = (0.8, 0.8, 0.8, 1)
    vol.inputs['Density Attribute'].default_value = ''
    vol.inputs['Anisotropy'].default_value = 0.3
    vol.inputs['Blackbody Intensity'].default_value = 0
    vol.inputs['Emission Color'].default_value = (1, 1, 1, 1)
    # the flame is a little dense itself, so it hides what burns behind it
    L(math('MULTIPLY', math('MULTIPLY_ADD', flame, 0.35, dens), shade['density']), vol.inputs['Density'])
    if shade['flame'] > 0:
        L(math('MULTIPLY', flame, shade['flame']), vol.inputs['Emission Strength'])
    L(vol.outputs['Volume'], out.inputs['Volume'])
    ob.data.materials.append(mat)


def first_frame(s):
    return 1 + s['settle']


def rendered(s):
    return FRAMES + (s['blend'] if s.get('loop') else 0)


def last_frame(s):
    return first_frame(s) + rendered(s)


def make_camera(scene, s, preview):
    cam = bpy.data.cameras.new('cam')
    cam.type = 'ORTHO'
    cam.ortho_scale = s['ortho']
    ob = bpy.data.objects.new('cam', cam)
    scene.collection.objects.link(ob)
    e = math.radians(s['elevation'])
    look = s['look']
    dist = 20
    ob.location = (look[0], look[1] - dist * math.cos(e), look[2] + dist * math.sin(e))
    ob.rotation_euler = (math.pi / 2 - e, 0, 0)
    cam.clip_end = 100
    scene.camera = ob
    w, h = s['frame']
    k = SUPERSAMPLE
    scene.render.resolution_x = w * k
    scene.render.resolution_y = h * k
    scene.render.resolution_percentage = 50 if preview else 100


def make_light(scene):
    # sun from above, a little to the left and in front, like a late-morning sky
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 4.0
    sun.angle = math.radians(8)
    ob = bpy.data.objects.new('sun', sun)
    ob.rotation_euler = (math.radians(32), 0, math.radians(-40))
    scene.collection.objects.link(ob)
    world = bpy.data.worlds.new('sky')
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.55, 0.62, 0.72, 1)
    bg.inputs['Strength'].default_value = 0.55
    scene.world = world


def setup_render(scene, s, preview, frames_dir):
    scene.render.engine = 'CYCLES'
    c = scene.cycles
    c.device = 'CPU'
    c.samples = 16 if preview else 64
    c.use_adaptive_sampling = True
    c.adaptive_threshold = 0.03
    c.use_denoising = False
    c.max_bounces = 4
    c.volume_bounces = 1
    c.transparent_max_bounces = 4
    c.volume_step_rate = 2.0 if preview else 1.0
    c.volume_max_steps = 256
    scene.render.film_transparent = True
    scene.view_settings.view_transform = 'Standard'
    vl = scene.view_layers[0]
    vl.use_pass_emit = True
    vl.cycles.use_pass_volume_direct = True
    vl.cycles.use_pass_volume_indirect = True
    scene.use_nodes = True
    nt = scene.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    rl = nt.nodes.new('CompositorNodeRLayers')
    fo = nt.nodes.new('CompositorNodeOutputFile')
    fo.base_path = frames_dir
    fo.format.file_format = 'OPEN_EXR'
    fo.format.color_depth = '32'
    fo.file_slots.clear()
    for name in ('emit', 'lit', 'alpha'):
        fo.file_slots.new(f'{name}_')
    add = nt.nodes.new('CompositorNodeMixRGB')
    add.blend_type = 'ADD'
    nt.links.new(rl.outputs['VolumeDir'], add.inputs[1])
    nt.links.new(rl.outputs['VolumeInd'], add.inputs[2])
    nt.links.new(rl.outputs['Emit'], fo.inputs['emit_'])
    nt.links.new(add.outputs[0], fo.inputs['lit_'])
    nt.links.new(rl.outputs['Alpha'], fo.inputs['alpha_'])
    comp = nt.nodes.new('CompositorNodeComposite')
    nt.links.new(rl.outputs['Image'], comp.inputs['Image'])
    scene.render.filepath = os.path.join(frames_dir, 'combined_')
    scene.render.image_settings.file_format = 'PNG'


def read_exr(path):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    # Blender's pixels run bottom row first
    return px.reshape(h, w, 4)[::-1]


def shrink(a, k):
    if k == 1:
        return a
    h, w = a.shape[:2]
    return a.reshape(h // k, k, w // k, k, *a.shape[2:]).mean(axis=(1, 3))


def edge_window(h, w, px=4):
    """Fades each frame's border to zero so neighbours never bleed in at low mip levels."""
    def ramp(n):
        t = np.minimum(np.arange(n), np.arange(n)[::-1]).astype(np.float32)
        x = np.clip((t - 1) / px, 0, 1)
        return x * x * (3 - 2 * x)
    return ramp(h)[:, None] * ramp(w)[None, :]


def pack(s, frames_dir, out_path, preview):
    first = first_frame(s)
    n = rendered(s)
    w, h = s['frame']
    k = SUPERSAMPLE
    lit, alpha, emit = [], [], []
    for i in range(n):
        f = first + i
        lit.append(shrink(read_exr(os.path.join(frames_dir, f'lit_{f:04d}.exr'))[..., :3].mean(axis=2), k))
        alpha.append(shrink(read_exr(os.path.join(frames_dir, f'alpha_{f:04d}.exr'))[..., 0], k))
        emit.append(shrink(read_exr(os.path.join(frames_dir, f'emit_{f:04d}.exr'))[..., :3].mean(axis=2), k))
    lit, alpha, emit = np.array(lit), np.array(alpha), np.array(emit)
    # no denoiser in this Blender build: a slight blur within each frame takes the grain out of soft gas
    from scipy import ndimage
    # (flame is sampled through the gas and comes out grainier, so it gets a little more)
    for arr, sigma in ((lit, 0.7), (alpha, 0.7), (emit, 1.0)):
        arr[:] = ndimage.gaussian_filter(arr, (0, sigma, sigma))
    if preview:
        h, w = lit.shape[1:3]
    if s.get('loop'):
        # crossfade the tail into the head: frame 0 continues from the last frame
        b = s['blend']
        for arr in (lit, alpha, emit):
            for i in range(b):
                t = i / b
                arr[i] = arr[FRAMES + i] * (1 - t) + arr[i] * t
        lit, alpha, emit = lit[:FRAMES], alpha[:FRAMES], emit[:FRAMES]
    # the lit pass carries premultiplied light; divide by opacity for the smoke's own shade
    shade = np.where(alpha > 1e-3, lit / np.maximum(alpha, 1e-3), 0)
    shade = shade / max(1e-6, np.percentile(shade[alpha > 0.05], 99.5) if np.any(alpha > 0.05) else 1)
    heat = emit / max(1e-6, np.percentile(emit, 99.9) if emit.max() > 0 else 1)
    win = edge_window(h, w)
    sheet = np.zeros((ROWS * h, COLS * w, 3), dtype=np.float32)
    for i in range(FRAMES):
        r, c = divmod(i, COLS)
        y, x = r * h, c * w
        sheet[y:y + h, x:x + w, 0] = np.sqrt(np.clip(shade[i], 0, 1))
        sheet[y:y + h, x:x + w, 1] = np.clip(alpha[i], 0, 1) * win
        sheet[y:y + h, x:x + w, 2] = np.sqrt(np.clip(heat[i], 0, 1)) * win
    write_sheet(sheet, out_path)
    stats = dict(maxAlpha=float(alpha.max()), meanAlpha=float(alpha.mean()), maxHeat=float(heat.max()))
    print('PACKED', out_path, sheet.shape, stats)


def write_sheet(sheet, path):
    from PIL import Image

    os.makedirs(os.path.dirname(path), exist_ok=True)
    # lossless: the three channels are separate data, which lossy WebP's chroma subsampling would smear together
    Image.fromarray((np.clip(sheet, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB').save(path, lossless=True, method=6, quality=100)


def main():
    names, preview, out, work = args()
    for name in names:
        s = SHEETS[name]
        t0 = time.time()
        frames_dir = os.path.join(work, name, 'frames')
        if os.environ.get('PACK_ONLY'):
            pack(s, frames_dir, os.path.join(out, f'{name}{"-preview" if preview else ""}.webp'), preview)
            continue
        scene = reset()
        sim_dir = os.path.join(work, name, 'sim')
        os.makedirs(frames_dir, exist_ok=True)
        if not os.environ.get('SKIP_SIM'):
            simulate(s, sim_dir, preview)
        t1 = time.time()
        print(f'SIMULATED {name} in {t1 - t0:.0f}s', flush=True)
        img, shape = make_volume(scene, s, preview)
        make_camera(scene, s, preview)
        make_light(scene)
        setup_render(scene, s, preview, frames_dir)
        for f in range(first_frame(s), first_frame(s) + rendered(s)):
            z = np.load(os.path.join(sim_dir, f'{f:04d}.npz'))
            img.pixels.foreach_set(to_atlas([z['density'].astype(np.float32), z['flame'].astype(np.float32)], shape).ravel())
            img.update()
            scene.frame_set(f)
            bpy.ops.render.render(write_still=False)
            if f % 10 == 0:
                print(f'  rendered {f}  {time.time() - t1:.0f}s', flush=True)
        t2 = time.time()
        print(f'RENDERED {name} in {t2 - t1:.0f}s', flush=True)
        pack(s, frames_dir, os.path.join(out, f'{name}{"-preview" if preview else ""}.webp'), preview)


main()
