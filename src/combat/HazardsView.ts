import type * as THREE from 'three/webgpu';
import { DEPTHS, type Descent } from '../sim/Descent';
import { Hazards, HAZARDS } from '../sim/DescentHazards';
import type { Unit } from '../sim/Unit';
import { clearHazardLook, darkReach, floodReach, gapLook, slagLook, ventLook } from '../scene/underworld/hazardLook';
import { DEPTH_COLORS } from '../scene/underworld/palettes';
import { GroundDecal } from './GroundDecal';
import type { GodPalette } from './palette';
import type { CombatVfx } from './Vfx';

/** Magma: a vent's blast and a glob of slag in flight. */
const MAGMA: GodPalette = { cloth: 0, trim: 0, glow: 0xff5a14, vfx: 0xff6a1a, core: 0xffd890 };
const SLAG_SMOKE = 0x4a3c34;
const BLAST_SMOKE = 0x5a4a40;
/** Black glass and bone dust going down into the void. */
const RUBBLE: GodPalette = { cloth: 0, trim: 0, glow: 0x3c8a66, vfx: 0x2c5a48, core: 0xb8ffd8 };
const RUBBLE_DUST = 0x3a4440;
/** The Abyss's creeping dark, smoking up along its edge. */
const DARK_WISP = 0x040706;

export type HazardCue = 'ventWarn' | 'vent' | 'slag' | 'tide' | 'crumble' | 'dark';

export interface HazardsViewOptions {
  me?: Unit;
  shake?: (amount: number) => void;
  cue?: (name: HazardCue, at: { x: number; y: number; z: number }, k: number) => void;
}

/** A glob in the air, for the projectile trail to follow (it reads x, z and body.y). */
interface Glob {
  x: number;
  z: number;
  body: { y: number };
  alive: boolean;
  landed: boolean;
}

/**
 * What the player sees of the current chamber's dangers (src/sim/
 * DescentHazards.ts): the ground's part goes through hazardLook's uniforms
 * (the vents' glow, the slag, the flood, the dark, the cracking and falling
 * brink); on top of it a warning circle filling under whatever is about to
 * go off, the blasts, the globs arcing out of the lava, the brink going down
 * into the void, and a cue for each.
 */
export class HazardsView {
  private readonly warnings: GroundDecal[] = [];
  private chamber = -1;
  private readonly ventWas: number[] = [];
  private readonly flash: number[] = [];
  private readonly globs = new Map<number, Glob>();
  private readonly gapWas = new Map<number, number>();
  private floodWas = 0;
  private darkWas = 0;
  private wispLeft = 0;

  constructor(
    group: THREE.Object3D,
    private readonly vfx: CombatVfx,
    private readonly groundAt: (x: number, z: number) => number,
    private readonly opts: HazardsViewOptions = {},
  ) {
    for (let i = 0; i < 12; i++) {
      const d = new GroundDecal(groundAt);
      d.setStyle('telegraph');
      d.mesh.visible = false;
      this.warnings.push(d);
      group.add(d.mesh);
    }
  }

  update(dt: number, run: Descent): void {
    const h = run.hazards;
    if (run.chamber !== this.chamber) {
      this.chamber = run.chamber;
      clearHazardLook();
      this.ventWas.length = 0;
      this.flash.length = 0;
      this.globs.clear();
      this.gapWas.clear();
      this.floodWas = 0;
      this.darkWas = 0;
      this.wispLeft = 0;
      const c = DEPTH_COLORS[DEPTHS[run.depth]!.palette];
      for (const d of this.warnings) d.setColors(c.glow, c.fire.high);
    }
    let w = 0;
    w = this.vents(dt, h, w);
    w = this.slag(h, w);
    w = this.gaps(h, w);
    for (; w < this.warnings.length; w++) this.warnings[w]!.mesh.visible = false;
    // the flood and the dark are the ground's alone
    const flood = h.floodReach;
    floodReach.value = flood;
    if (flood > 0.05 && this.floodWas <= 0.05) this.roomCue('tide', run);
    this.floodWas = flood;
    darkReach.value = h.dark;
    if (h.dark > 0.05 && this.darkWas <= 0.05) this.roomCue('dark', run);
    this.darkWas = h.dark;
    if (h.dark > 0.3 && (this.wispLeft -= dt) <= 0) {
      this.wispLeft = 0.4;
      this.wisp(run, h.dark);
    }
  }

  /** A black wisp curling up off the dark's edge, somewhere near the player. */
  private wisp(run: Descent, reach: number): void {
    const c = run.layout;
    const me = this.opts.me;
    const ox = (me?.x ?? c.x) - c.x;
    const oz = (me?.z ?? c.z) - c.z;
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 3 + Math.random() * 13;
      const lx = ox + Math.cos(a) * r;
      const lz = oz + Math.sin(a) * r;
      if (Math.abs(c.brink(lx, lz) - reach) > 0.7 || c.sd(lx, lz) < 0.3) continue;
      const x = c.x + lx;
      const z = c.z + lz;
      const size = 1.5 + Math.random() * 1.2;
      this.vfx.billow('smoke', x, this.groundAt(x, z) + size * 0.3, z, size, { tint: DARK_WISP, duration: 2.6, rise: 0.5, opacity: 0.8, bright: 0.4 });
      return;
    }
  }

  private warn(w: number, x: number, z: number, r: number, fill: number): number {
    const d = this.warnings[w];
    if (!d) return w;
    d.mesh.visible = true;
    d.values.fill = fill;
    d.values.opacity = 0.55 + fill * 0.35;
    d.place({ type: 'circle', radius: r }, x, z, 0, 0.09);
    return w + 1;
  }

  /** The forge's vents: glowing as a blast builds (a circle filling round each), then the blast. */
  private vents(dt: number, h: Hazards, w: number): number {
    const V = HAZARDS.vent;
    h.vents.forEach((v, i) => {
      const was = this.ventWas[i];
      const heat = h.heat(v);
      if (was !== undefined && v.t > was + 0.5) this.blast(v.x, v.z, i);
      else if (was !== undefined && was > V.warn && v.t <= V.warn) this.cue('ventWarn', v.x, v.z, 0);
      this.ventWas[i] = v.t;
      const flash = (this.flash[i] ?? 0) * Math.exp(-dt * 3.5);
      this.flash[i] = flash;
      ventLook[i]?.value.set(v.x, v.z, heat, flash);
      if (heat > 0) w = this.warn(w, v.x, v.z, V.radius, heat);
    });
    return w;
  }

  private blast(x: number, z: number, i: number): void {
    this.flash[i] = 1;
    const gy = this.groundAt(x, z);
    this.vfx.pillar(MAGMA, x, z, 0.9, 1.15, 1.3);
    this.vfx.burst(MAGMA, x, gy + 0.4, z, 1.4);
    this.vfx.billow('blast', x, gy + 1.1, z, 3.4, { tint: BLAST_SMOKE, duration: 1.3, rise: 1.2, flame: [0xff5a14, 0xffd890] });
    this.vfx.billow('smoke', x, gy + 2.2, z, 3.6, { tint: BLAST_SMOKE, duration: 2.8, rise: 2.4, delay: 0.55, opacity: 0.7 });
    this.vfx.billow('dust', x, gy + 0.3, z, 2.2, { tint: SLAG_SMOKE, duration: 1.2, rise: 0.3 });
    this.near(x, z, 0.3, 11);
    this.cue('vent', x, z, 1);
  }

  /** Globs of slag arcing out of the lava (a circle filling where each will land), then the puddles they leave. */
  private slag(h: Hazards, w: number): number {
    const S = HAZARDS.slag;
    const live = new Set<number>();
    let k = 0;
    for (const s of h.slag) {
      live.add(s.id);
      let glob = this.globs.get(s.id);
      if (!glob) {
        glob = { x: s.fx, z: s.fz, body: { y: -0.5 }, alive: true, landed: s.fly <= 0 };
        this.globs.set(s.id, glob);
        if (!glob.landed) this.vfx.comet(MAGMA, glob as unknown as Unit, s.fly + 0.05, 0.75, true);
      }
      if (s.fly > 0) {
        const p = 1 - s.fly / S.flight;
        glob.x = s.fx + (s.x - s.fx) * p;
        glob.z = s.fz + (s.z - s.fz) * p;
        glob.body.y = -0.6 + (this.groundAt(s.x, s.z) + 0.6) * p + Math.sin(Math.PI * p) * 4.5 - 1.2;
        w = this.warn(w, s.x, s.z, S.radius, p);
        continue;
      }
      if (!glob.landed) {
        glob.landed = true;
        glob.alive = false;
        const gy = this.groundAt(s.x, s.z);
        this.vfx.burst(MAGMA, s.x, gy + 0.25, s.z, 0.9);
        this.vfx.billow('smoke', s.x, gy + 0.8, s.z, 2.2, { tint: SLAG_SMOKE, duration: 2.2, rise: 1.4 });
        this.near(s.x, s.z, 0.12, 7);
        this.cue('slag', s.x, s.z, 0);
      }
      const slot = slagLook[k++];
      if (!slot) continue;
      // spreading as it lands, shrinking away in its last moments
      const age = S.life - s.left;
      const r = S.radius * Math.min(1, 0.4 + age * 5) * Math.min(1, s.left / 0.6);
      slot.value.set(s.x, s.z, r, Math.min(1, s.left / (S.life * 0.85)));
    }
    for (; k < slagLook.length; k++) slagLook[k]!.value.set(1e4, 1e4, 0, 0);
    for (const id of this.globs.keys()) if (!live.has(id)) this.globs.delete(id);
    return w;
  }

  /** The Abyss's brink: cracking (a circle filling over it), giving way into the void, rising back. */
  private gaps(h: Hazards, w: number): number {
    const C = HAZARDS.crumble;
    let k = 0;
    const live = new Set<number>();
    for (const g of h.gaps) {
      live.add(g.id);
      const was = this.gapWas.get(g.id) ?? g.t;
      this.gapWas.set(g.id, g.t);
      if (was < C.warn && g.t >= C.warn) this.fall(g.x, g.z, g.r);
      else if (was < C.warn + C.down && g.t >= C.warn + C.down) this.mend(g.x, g.z);
      if (g.t < C.warn) w = this.warn(w, g.x, g.z, g.r, g.t / C.warn);
      const slot = gapLook[k++];
      if (slot) slot.value.set(g.x, g.z, g.r, g.t < C.warn ? g.t / C.warn : 1 + Hazards.drop(g));
    }
    for (; k < gapLook.length; k++) gapLook[k]!.value.set(1e4, 1e4, 0, 0);
    for (const id of this.gapWas.keys()) if (!live.has(id)) this.gapWas.delete(id);
    return w;
  }

  private fall(x: number, z: number, r: number): void {
    const gy = this.groundAt(x, z);
    this.vfx.billow('dust', x, gy + 0.3, z, r * 2.4, { tint: RUBBLE_DUST, duration: 1.8, rise: 0.4 });
    this.vfx.burst(RUBBLE, x, gy - 0.4, z, 1.2);
    this.near(x, z, 0.35, 10);
    this.cue('crumble', x, z, 1);
  }

  private mend(x: number, z: number): void {
    const gy = this.groundAt(x, z);
    this.vfx.burst(RUBBLE, x, gy - 1, z, 0.8);
  }

  private near(x: number, z: number, amount: number, reach: number): void {
    const me = this.opts.me;
    if (!me || !this.opts.shake) return;
    const d = Math.hypot(me.x - x, me.z - z);
    if (d < reach) this.opts.shake(amount * (1 - d / reach));
  }

  private cue(name: HazardCue, x: number, z: number, k: number): void {
    this.opts.cue?.(name, { x, y: this.groundAt(x, z) + 0.5, z }, k);
  }

  /** A cue the whole chamber hears (the water rising, the dark coming), from the player. */
  private roomCue(name: HazardCue, run: Descent): void {
    const me = this.opts.me;
    const c = run.layout;
    this.cue(name, me?.x ?? c.x, me?.z ?? c.z, 0);
  }
}
