"""Fractures a lane Tower and scatters a Phoenix's bird with Blender's rigid
bodies, and bakes the fall for src/scene/structures/collapse.ts.

    blender -b -P tools/collapse/bake.py -- tower|phoenix [--parts FILE] [--out DIR] [--look DIR]

Reads the structure's parts as the game builds them (tools/collapse/dump.ts
writes them to tools/collapse/out/parts.json), breaks the tower's keep, crown
and roof into Voronoi cells (each cell intersected with the stone, so the
outside keeps the game's faces and the breaks get new ones), leaves the bird's
feathers whole, and drops everything onto the plinth or pedestal with Bullet.
Writes public/models/collapse/<name>.bin (gzip): the pieces' rest geometry in
the structure's own space, and each piece's pivot, position, turn and scale
for every frame. `--look DIR` also renders a few frames of the fall in Cycles
for checking. Needs only the Ubuntu Blender 4.0 package.
"""
import gzip
import json
import math
import os
import random
import struct
import sys

import faulthandler
faulthandler.enable()

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FPS = 30

# The game is Y-up (three.js), Blender Z-up.
def to_b(p):
    return Vector((p[0], -p[2], p[1]))


def to_t(v):
    return (v[0], v[2], -v[1])


def args():
    a = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opts = dict(name=None, parts=os.path.join(ROOT, 'tools', 'collapse', 'out', 'parts.json'),
                out=os.path.join(ROOT, 'public', 'models', 'collapse'), look=None)
    i = 0
    while i < len(a):
        if a[i] in ('--parts', '--out', '--look'):
            opts[a[i][2:]] = a[i + 1]
            i += 1
        else:
            opts['name'] = a[i]
        i += 1
    return opts


def reset():
    # (read_factory_settings crashes Blender 4.0 when called from a script)
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights, bpy.data.worlds, bpy.data.images):
        for item in list(coll):
            coll.remove(item)
    scene = bpy.context.scene
    if scene.rigidbody_world:
        bpy.ops.rigidbody.world_remove()
    scene.render.fps = FPS
    scene.frame_set(1)
    return scene


# --- building the parts -------------------------------------------------------

materials = {}
# rounded game position -> the game's normals there
game_normals = {}


def key(p):
    return (round(float(p[0]), 3), round(float(p[1]), 3), round(float(p[2]), 3))


def material(name):
    """A stand-in material per game material; only its name (and a color for --look) matters."""
    if name not in materials:
        m = bpy.data.materials.new(name)
        colors = dict(towerStone=(0.75, 0.72, 0.66), agedMarble=(0.8, 0.77, 0.7), trim=(0.85, 0.6, 0.2), bronze=(0.45, 0.28, 0.15),
                      runes=(0.3, 0.6, 1.0), banner=(0.15, 0.3, 0.8), crystal=(0.4, 0.8, 1.0), bird=(0.95, 0.6, 0.15))
        m.diffuse_color = (*colors.get(name, (0.6, 0.6, 0.6)), 1)
        materials[name] = m
    return materials[name]


def part_object(part, coll):
    pos = np.array(part['pos'], dtype=np.float64).reshape(-1, 3)
    nrm = np.array(part['nrm'], dtype=np.float64).reshape(-1, 3)
    idx = np.array(part['idx'] if part['idx'] else range(len(pos))).reshape(-1, 3)
    me = bpy.data.meshes.new(part['name'])
    me.from_pydata([to_b(p) for p in pos], [], idx.tolist())
    if part['uv']:
        uv = np.array(part['uv']).reshape(-1, 2)
        layer = me.uv_layers.new(name='uv')
        for loop in me.loops:
            layer.data[loop.index].uv = uv[loop.vertex_index]
    me.materials.append(material(part['mat']))
    me.use_auto_smooth = True
    me.auto_smooth_angle = math.radians(40)
    for f in me.polygons:
        f.use_smooth = True
    # the game's own normals, matched back to the corners that survive the fracture (see `export`)
    for p, n in zip(pos, nrm):
        game_normals.setdefault(key(p), []).append(n)
    ob = bpy.data.objects.new(part['name'], me)
    coll.objects.link(ob)
    weld(ob)
    return ob


def weld(ob):
    """Joins the triangles three.js keeps apart (flat shading, UV seams) into a closed solid."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bm.to_mesh(ob.data)
    bm.free()


def join(obs, name):
    """Joins objects into the first, which is renamed and returned."""
    base = obs[0]
    if len(obs) > 1:
        with bpy.context.temp_override(active_object=base, selected_editable_objects=obs, selected_objects=obs):
            bpy.ops.object.join()
    base.name = name
    return base


def lathe_object(name, profile, coll, segments=48):
    """A solid of revolution about Blender's Z from (radius, height) points (the game's lathe)."""
    bm = bmesh.new()
    rings = []
    for r, h in profile:
        ring = [bm.verts.new((r * math.cos(2 * math.pi * i / segments), r * math.sin(2 * math.pi * i / segments), h)) for i in range(segments)]
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for i in range(segments):
            j = (i + 1) % segments
            bm.faces.new((a[i], a[j], b[j], b[i]))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    return ob


# --- breaking ----------------------------------------------------------------

def cells(points, lo, hi):
    """Convex Voronoi cells of `points` clipped to the box lo..hi, as lists of vertices."""
    from mathutils.geometry import points_in_planes
    out = []
    for i, p in enumerate(points):
        planes = [
            Vector((1, 0, 0, -hi[0])), Vector((-1, 0, 0, lo[0])),
            Vector((0, 1, 0, -hi[1])), Vector((0, -1, 0, lo[1])),
            Vector((0, 0, 1, -hi[2])), Vector((0, 0, -1, lo[2])),
        ]
        for j, q in enumerate(points):
            if i == j:
                continue
            n = (q - p).normalized()
            mid = (p + q) / 2
            planes.append(Vector((n.x, n.y, n.z, -n.dot(mid))))
        verts, used = points_in_planes(planes)
        out.append(verts)
    return out


def fracture(ob, points, coll, inner):
    """Splits `ob` into one piece per Voronoi cell of `points`; the broken faces get material `inner`."""
    bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb))) - Vector((0.5, 0.5, 0.5))
    hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb))) + Vector((0.5, 0.5, 0.5))
    pieces = []
    for k, verts in enumerate(cells(points, lo, hi)):
        if len(verts) < 4:
            continue
        bm = bmesh.new()
        for v in verts:
            bm.verts.new(v)
        bmesh.ops.convex_hull(bm, input=bm.verts)
        cme = bpy.data.meshes.new('cell')
        bm.to_mesh(cme)
        bm.free()
        cme.materials.append(material(inner))
        cell = bpy.data.objects.new('cell', cme)
        coll.objects.link(cell)
        piece = ob.copy()
        piece.data = ob.data.copy()
        piece.name = f'{ob.name}.{k}'
        coll.objects.link(piece)
        mod = piece.modifiers.new('cut', 'BOOLEAN')
        mod.operation = 'INTERSECT'
        mod.solver = 'EXACT'
        mod.object = cell
        mod.use_self = True
        mod.use_hole_tolerant = True
        mod.material_mode = 'TRANSFER'
        with bpy.context.temp_override(object=piece, active_object=piece):
            bpy.ops.object.modifier_apply(modifier='cut')
        bpy.data.objects.remove(cell)
        bpy.data.meshes.remove(cme)
        if len(piece.data.polygons) < 4 or volume(piece) < 1e-3:
            bpy.data.objects.remove(piece)
            continue
        pieces.append(piece)
    bpy.data.objects.remove(ob)
    return pieces


def volume(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    v = abs(bm.calc_volume())
    bm.free()
    return v


def centroid(ob):
    """Center of the piece's volume (its vertices' mean when it has none)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    total, c = 0.0, Vector()
    for f in bm.faces:
        a, b, d = (v.co for v in f.verts)
        w = a.dot(b.cross(d)) / 6
        total += w
        c += w * (a + b + d) / 4
    if abs(total) > 1e-6:
        c /= total
    else:
        c = sum((v.co for v in bm.verts), Vector()) / max(1, len(bm.verts))
    bm.free()
    return ob.matrix_world @ c


def attach(small, pieces):
    """Joins each of `small` into the piece whose center is nearest its own."""
    for s in small:
        c = centroid(s)
        best = min(pieces, key=lambda p: (centroid(p) - c).length)
        i = pieces.index(best)
        pieces[i] = join([best, s], best.name)


# --- the structures ----------------------------------------------------------

def keep_points(rand, n, y0, y1, w0, w1):
    """Cell seeds through the tapered keep, a little denser near the base where it breaks."""
    pts = []
    for i in range(n):
        t = (i + rand.random()) / n
        t = t ** 1.25
        h = y0 + (y1 - y0) * t
        half = (w0 + (w1 - w0) * t) / 2
        pts.append(to_b((rand.uniform(-half, half) * 0.9, h, rand.uniform(-half, half) * 0.9)))
    return pts


def tower(parts, coll, rand):
    obs = [part_object(p, coll) for p in parts]
    by = lambda *ids: [obs[i] for i in ids]
    # keep, bands, pilasters, frieze and studs break together, like the masonry they are
    keep = join(by(0, 1, 2, 3, 4, 5, 6, 7, *range(8, 28)), 'keep')
    pieces = fracture(keep, keep_points(rand, 26, 1.0, 6.3, 3.6, 2.9), coll, 'towerStone')
    slab = fracture(obs[36], [to_b((x * 1.2 + rand.uniform(-0.3, 0.3), 6.62, z * 1.2 + rand.uniform(-0.3, 0.3))) for x, z in ((-1, -1), (1, -1), (-1, 1), (1, 1))], coll, 'agedMarble')
    pieces += slab
    # each column snaps once, somewhere along its shaft
    for shaft in (37, 39, 41, 43):
        c = centroid(obs[shaft])
        x, z = c.x, -c.y
        cut = rand.uniform(7.6, 8.6)
        pieces += fracture(obs[shaft], [to_b((x + rand.uniform(-0.2, 0.2), cut - 0.6, z)), to_b((x + rand.uniform(-0.2, 0.2), cut + 0.6, z + rand.uniform(-0.2, 0.2)))], coll, 'agedMarble')
    ent = join(by(45, 46), 'entablature')
    top = fracture(ent, [to_b((rand.uniform(-1.8, 1.8), 9.7, rand.uniform(-1.8, 1.8))) for _ in range(5)], coll, 'agedMarble')
    # the capitals are sunk into the entablature, so they go down with it (on the column they would start inside it)
    attach(by(38, 40, 42, 44), top)
    pieces += top
    roof = fracture(obs[47], [to_b((math.cos(a) * 1.3, 10.5, math.sin(a) * 1.3)) for a in (0.3, 2.4, 4.4)], coll, 'bronze')
    roof.sort(key=lambda p: -centroid(p).z)
    roof[0] = join([roof[0], obs[48], obs[49]], roof[0].name)
    pieces += roof
    # each banner comes down on its own with its rod: hung from a block, its hull would cut into the blocks below
    banners = [join(by(b, r), f'banner-{b}') for b, r in ((28, 29), (30, 31), (32, 33), (34, 35))]
    pieces += banners
    crystal = obs[50]
    pieces.append(crystal)
    for p in pieces:
        body(p, 'crystal' if p is crystal else 'cloth' if p in banners else 'stone', coll)
    # what stays standing: the plinth, and the ground around it
    box(coll, 'plinth-low', (0, 0.25, 0), (5.6, 0.5, 5.6))
    box(coll, 'plinth-high', (0, 0.71, 0), (4.7, 0.42, 4.7))
    ground(coll)
    # the blow that brings it down: a burst inside the lower keep, pushing out and a little forward
    kick(coll, 'burst', (0.2, 2.2, 0.5), 'FORCE', 1200, frames=(1, 3), distance=3.6)
    kick(coll, 'shove', (0, 8.5, -3.0), 'WIND', 500, frames=(3, 14), distance=6.0, aim=(0.25, -0.1, 1.0), power=0)
    return pieces


def phoenix(parts, coll, rand):
    obs = [part_object(p, coll) for p in parts]
    pieces = [join([obs[i] for i in (1, 2, 3, 4, 5, 6, 7)], 'head'), join([obs[0], obs[8]], 'body')]
    pieces += [obs[i] for i in range(9, 46)]
    for i, p in enumerate(pieces):
        body(p, 'core' if i < 2 else 'feather', coll)
    # feathers that start inside one another must not collide (they would burst apart), so they get different layers
    layers(pieces)
    # the pedestal, its drum and the brazier bowl the bird falls into
    for name, r, h in (('step-1', 3.7, 0.35), ('step-2', 3.2, 0.7), ('step-3', 2.7, 1.05), ('drum', 1.45, 2.6)):
        bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=(0, 0, h / 2), vertices=48)
        ob = bpy.context.object
        ob.name = name
        move(ob, coll)
        passive(ob, 'CONVEX_HULL')
    bowl = lathe_object('bowl', [(0.001, 2.55), (0.7, 2.6), (1.5, 2.85), (1.95, 3.25), (2.0, 3.35), (1.85, 3.3), (1.4, 3.0), (0.001, 2.95)], coll)
    passive(bowl, 'MESH')
    ground(coll)
    # the flare that bursts it: feathers thrown out and up, the body knocked back into the bowl
    kick(coll, 'flare', (0, 5.3, 0.3), 'FORCE', 2000, frames=(1, 3), distance=7.0)
    # and the hot air tears the wings' fans apart, each feather its own way
    gust = kick(coll, 'gust', (0, 6.0, 0), 'TURBULENCE', 260, frames=(2, 40), distance=9.0, power=0)
    gust.field.size = 0.8
    gust.field.noise = 0.5
    return pieces


def move(ob, coll):
    for c in ob.users_collection:
        c.objects.unlink(ob)
    coll.objects.link(ob)


def body(ob, kind, coll):
    """Gives `ob` (origin moved to its center of volume) a rigid proxy: its convex hull, shrunk a
    little, so neighbors whose hulls overlap where bands and pilasters stick out don't burst apart."""
    c = centroid(ob)
    ob.data.transform(Matrix.Translation(-(ob.matrix_world.inverted() @ c)))
    ob.matrix_world = Matrix.Translation(c) @ ob.matrix_world
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    hull = bmesh.ops.convex_hull(bm, input=bm.verts)
    for g in hull['geom_interior'] + hull['geom_unused']:
        if isinstance(g, bmesh.types.BMVert) and g.is_valid:
            bm.verts.remove(g)
    shrink = 0.97 if kind in ('feather', 'core', 'crystal', 'cloth') else 0.86
    for v in bm.verts:
        v.co *= shrink
    me = bpy.data.meshes.new(ob.name + '.proxy')
    bm.to_mesh(me)
    bm.free()
    proxy = bpy.data.objects.new(ob.name + '.proxy', me)
    coll.objects.link(proxy)
    proxy.matrix_world = ob.matrix_world.copy()
    proxy.display_type = 'WIRE'
    proxy.hide_render = True
    with bpy.context.temp_override(object=proxy, active_object=proxy, selected_objects=[proxy]):
        bpy.ops.rigidbody.object_add(type='ACTIVE')
    rb = proxy.rigid_body
    rb.collision_shape = 'CONVEX_HULL'
    rb.collision_margin = 0.01
    v = max(volume(ob), 1e-3)
    if kind == 'cloth':
        rb.mass = 0.8
        rb.friction = 0.9
        rb.restitution = 0.0
        rb.linear_damping = 0.5
        rb.angular_damping = 0.7
    elif kind == 'feather':
        rb.mass = 0.3
        rb.friction = 0.9
        rb.restitution = 0.05
        # air holds a feather up: it drifts and turns rather than drops
        rb.linear_damping = 0.75
        rb.angular_damping = 0.6
    elif kind == 'core':
        rb.mass = 6.0
        rb.friction = 0.8
        rb.restitution = 0.1
        rb.linear_damping = 0.2
        rb.angular_damping = 0.4
    else:
        # (relative masses are all that matter; the forces are scaled to these)
        rb.mass = max(0.6, v * 2.4)
        rb.friction = 0.75
        rb.restitution = 0.12
        rb.linear_damping = 0.04
        rb.angular_damping = 0.12
    ob['kind'] = kind
    ob['proxy'] = proxy.name
    return proxy


def layers(pieces):
    """Collision layers so pieces that overlap at rest never collide (greedy coloring of their bounds)."""
    def bounds(ob):
        pts = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
        return [min(p[i] for p in pts) for i in range(3)], [max(p[i] for p in pts) for i in range(3)]
    bb = [bounds(p) for p in pieces]
    def overlap(a, b):
        return all(a[0][i] < b[1][i] and b[0][i] < a[1][i] for i in range(3))
    color = []
    for i, p in enumerate(pieces):
        taken = {color[j] for j in range(i) if overlap(bb[i], bb[j])}
        c = next(k for k in range(20) if k not in taken)
        color.append(c)
        bpy.data.objects[p['proxy']].rigid_body.collision_collections = [k == c for k in range(20)]


def passive(ob, shape):
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
        bpy.ops.rigidbody.object_add(type='PASSIVE')
    ob.rigid_body.collision_shape = shape
    ob.rigid_body.friction = 0.9
    ob.rigid_body.restitution = 0.1
    ob.rigid_body.collision_collections = [True] * 20
    ob['kind'] = 'ground'


def box(coll, name, center, size):
    bpy.ops.mesh.primitive_cube_add(size=1, location=to_b(center))
    ob = bpy.context.object
    ob.name = name
    ob.scale = (size[0], size[2], size[1])
    move(ob, coll)
    passive(ob, 'BOX')


def ground(coll):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, -0.5))
    ob = bpy.context.object
    ob.name = 'ground'
    ob.scale = (60, 60, 1)
    move(ob, coll)
    passive(ob, 'BOX')


def kick(coll, name, at, kind, strength, frames, distance, aim=None, power=1.0):
    """A force field (game coordinates) that pushes for `frames` and then stops. (Blender's fields
    push rigid bodies weakly: a strength of 100 gives a 1 kg body about 6.6 m/s2.)"""
    strength *= float(os.environ.get('KICK', '1'))
    bpy.ops.object.effector_add(type=kind, location=to_b(at))
    ob = bpy.context.object
    ob.name = name
    move(ob, coll)
    if aim:
        ob.rotation_mode = 'QUATERNION'
        ob.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(to_b(aim).normalized())
    ob.field.use_max_distance = True
    ob.field.distance_max = distance
    ob.field.falloff_type = 'SPHERE'
    ob.field.falloff_power = power
    # no harder than at a meter, however close a piece is
    ob.field.use_min_distance = True
    ob.field.distance_min = 1.0
    f0, f1 = frames
    for f, s in ((f0 - 1, 0), (f0, strength), (f1, strength), (f1 + 1, 0)):
        ob.field.strength = s
        ob.keyframe_insert('field.strength', frame=max(0, f))
    for fc in ob.animation_data.action.fcurves:
        for k in fc.keyframe_points:
            k.interpolation = 'CONSTANT'
    return ob
    ob['kind'] = 'field'


# --- the bake -----------------------------------------------------------------

SETTINGS = {
    'tower': dict(build=tower, frames=96, seed=7),
    'phoenix': dict(build=phoenix, frames=72, seed=3),
}


def simulate(scene, pieces, frames, look_dir=None, name=''):
    if not scene.rigidbody_world:
        bpy.ops.rigidbody.world_add()
    w = scene.rigidbody_world
    w.substeps_per_frame = 10
    w.solver_iterations = 30
    w.point_cache.frame_start = 1
    w.point_cache.frame_end = frames
    w.effector_weights.all = 1.0
    scene.frame_start = 1
    scene.frame_end = frames
    track = []
    proxies = [bpy.data.objects[p['proxy']] for p in pieces]
    shots = (1, 4, 8, 12, 18, 26, 36, 50, 70, frames)
    for f in range(1, frames + 1):
        scene.frame_set(f)
        row = []
        for p, x in zip(pieces, proxies):
            loc, rot, _ = x.matrix_world.decompose()
            row.append((loc.copy(), rot.copy()))
            p.matrix_world = x.matrix_world
        track.append(row)
        if os.environ.get('DEBUG') and f <= 6:
            fields = [(o.name, round(o.field.strength, 1)) for o in scene.objects if o.field and o.field.type != 'NONE']
            print('  debug', f, fields, [tuple(round(c, 2) for c in to_t(r[0])) for r in row[2:5]], flush=True)
        if look_dir and f in shots:
            scene.render.filepath = os.path.join(look_dir, f'{name}_{f:03d}.png')
            bpy.ops.render.render(write_still=True)
        if f % 10 == 0:
            speed = max((a[0] - b[0]).length for a, b in zip(row, track[-2])) * FPS
            print(f'  frame {f}/{frames}  fastest piece {speed:.1f} m/s', flush=True)
    return track


def burn_scales(pieces, track, rand):
    """A Phoenix's feathers burn away after they land (the body last); the tower's stones stay."""
    n = len(track)
    out = np.ones((n, len(pieces)), np.float32)
    for j, p in enumerate(pieces):
        kind = p['kind']
        if kind == 'feather':
            start = rand.uniform(0.95, 1.5)
            length = rand.uniform(0.45, 0.7)
        elif kind == 'core':
            start, length = 1.55, 0.6
        else:
            continue
        for f in range(n):
            t = np.clip(((f / FPS) - start) / length, 0, 1)
            out[f, j] = 1 - t * t * (3 - 2 * t)
    return out


def export(pieces, rest, track, scales, path):
    """Writes the rest geometry (game space), each piece's pivot, and its motion per frame."""
    names = []
    tris = {}  # material name -> list of (positions, normals, uvs, piece) per corner
    matched = corners = 0
    for j, p in enumerate(pieces):
        me = p.data
        me.calc_normals_split()
        uv = me.uv_layers.active.data if me.uv_layers.active else None
        mw = rest[j]
        nw = mw.to_3x3().inverted().transposed()
        me.calc_loop_triangles()
        for tri in me.loop_triangles:
            mat = me.materials[tri.material_index].name if me.materials else 'stone'
            if mat not in tris:
                tris[mat] = []
                names.append(mat)
            for li in tri.loops:
                loop = me.loops[li]
                pos = to_t(mw @ me.vertices[loop.vertex_index].co)
                nrm = to_t((nw @ loop.normal).normalized())
                # where the corner was the game's, it keeps the game's normal; broken faces keep Blender's
                best, dot = None, 0.6
                for n in game_normals.get(key(pos), ()):
                    d = n[0] * nrm[0] + n[1] * nrm[1] + n[2] * nrm[2]
                    if d > dot:
                        best, dot = n, d
                if best is not None:
                    nrm = (float(best[0]), float(best[1]), float(best[2]))
                    matched += 1
                corners += 1
                t = uv[li].uv if uv else (0.0, 0.0)
                tris[mat].append((pos, nrm, (t[0], t[1]), j))
    # one vertex per distinct corner
    verts, index, groups = [], [], []
    seen = {}
    for mat in names:
        start = len(index)
        for pos, nrm, uv, j in tris[mat]:
            corner = (round(pos[0], 5), round(pos[1], 5), round(pos[2], 5), round(nrm[0], 3), round(nrm[1], 3), round(nrm[2], 3), round(uv[0], 4), round(uv[1], 4), j)
            k = seen.get(corner)
            if k is None:
                k = seen[corner] = len(verts)
                verts.append((pos, nrm, uv, j))
            index.append(k)
        groups.append((mat, start, len(index) - start))
    P, F, V = len(pieces), len(track), len(verts)
    motion = np.zeros((1 + 2 * F, P, 4), np.float32)
    for j, p in enumerate(pieces):
        c = rest[j].to_translation()
        motion[0, j, :3] = to_t(c)
        for f in range(F):
            loc, rot = track[f][j]
            motion[1 + 2 * f, j] = (*to_t(loc), scales[f, j])
            # a turn about Blender's axis is the same turn about that axis in the game's space
            ax = to_t((rot.x, rot.y, rot.z))
            motion[2 + 2 * f, j] = (ax[0], ax[1], ax[2], rot.w)
    # keep each piece's turns on one side of the sphere, so blending neighbours never flips it
    for j in range(P):
        for f in range(1, F):
            a, b = motion[2 * f, j], motion[2 + 2 * f, j]
            if np.dot(a, b) < 0:
                motion[2 + 2 * f, j] = -b
    head = b'CLPS' + struct.pack('<7I', 1, P, F, FPS, V, len(index), len(groups))
    for mat, start, count in groups:
        head += mat.encode()[:24].ljust(24, b'\0') + struct.pack('<2I', start, count)
    pos = np.array([v[0] for v in verts], np.float32)
    nrm = np.array([v[1] for v in verts], np.float32)
    uvs = np.array([v[2] for v in verts], np.float32)
    piece = np.array([v[3] for v in verts], np.float32)
    body = b''.join(a.tobytes() for a in (pos, nrm, uvs, piece, np.array(index, np.uint32), motion))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as fh:
        fh.write(gzip.compress(head + body, 9, mtime=0))
    print(f'  {matched}/{corners} corners kept the game\'s normal')
    print(f'WROTE {path}: {P} pieces, {F} frames, {V} vertices, {len(index) // 3} triangles, groups {[(g[0], g[2] // 3) for g in groups]}, {os.path.getsize(path) / 1024:.0f} KB')


def look_setup(scene, out_dir):
    """A three-quarter view and a sun, so `simulate` can render a few frames of the fall for checking."""
    os.makedirs(out_dir, exist_ok=True)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    cam.location = (17, -19, 10)
    target = Vector((0, 0, 4.5))
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 38
    scene.camera = cam
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    scene.collection.objects.link(sun)
    sun.data.energy = 4
    sun.rotation_euler = (math.radians(40), 0, math.radians(-35))
    world = bpy.data.worlds.new('w')
    world.color = (0.5, 0.55, 0.65)
    scene.world = world
    for m in materials.values():
        m.use_nodes = True
        m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = m.diffuse_color
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 8
    scene.cycles.use_denoising = False
    scene.render.resolution_x, scene.render.resolution_y = 480, 360


def main():
    o = args()
    s = SETTINGS[o['name']]
    rand = random.Random(s['seed'])
    scene = reset()
    coll = scene.collection
    parts = json.load(open(o['parts']))[o['name']]
    pieces = s['build'](parts, coll, rand)
    rest = [p.matrix_world.copy() for p in pieces]
    print(f'{len(pieces)} pieces', flush=True)
    if o['look']:
        look_setup(scene, o['look'])
    track = simulate(scene, pieces, s['frames'], o['look'], o['name'])
    scales = burn_scales(pieces, track, rand)
    export(pieces, rest, track, scales, os.path.join(o['out'], f'{o["name"]}.bin'))


main()
