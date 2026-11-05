import type { Side } from '../game/combatant';
import { exitSpot } from '../map/UnderworldLayout';
import { DESCENT, DEPTHS, SOULS, type Descent } from '../sim/Descent';
import type { SimEvent, Unit } from '../sim/Unit';
import type { World } from '../scene/World';
import { DEPTH_COLORS, gateOpen } from '../scene/underworld/palettes';
import type { UnderworldMap } from '../scene/underworld/UnderworldMap';
import { GroundDecal } from './GroundDecal';
import { KEEPER_CORE, KEEPER_GLOW } from './MonsterViews';
import type { GodPalette } from './palette';
import { SoulWisps } from './SoulWisps';
import type { CombatVfx } from './Vfx';

const ERUPTIONS = 10;
/** Souls that are nobody's in particular, pale and ghostly in each depth's light (cyan against the Ashen Depths' fire). */
const SOULS_OF: Record<keyof typeof DEPTH_COLORS, number> = { ember: 0xbfefff, soul: 0xe0f6ff, spirit: 0xd4ffb0 };
/** Souls in a shared descent: the player's team's in cold blue, the rivals' in crimson (the HUD's colors). */
const ALLY_SOUL = 0x5ab8ff;
const FOE_SOUL = 0xff4060;
/** The Gilded Thornback's burst of gold. */
/** A Gravekeeper's lantern flaring as it mends. */
const LANTERN: GodPalette = { cloth: 0, trim: 0, glow: KEEPER_GLOW, vfx: KEEPER_GLOW, core: KEEPER_CORE };
const GILDED: GodPalette = { cloth: 0, trim: 0, glow: 0xffc23a, vfx: 0xffb020, core: 0xfff0b0 };
/** Seconds between the souls a god raising an ally pours into them. */
const STREAM_EVERY = 0.09;

export interface DescentViewOptions {
  /** The player's team: in a shared descent the rivals' fallen get no ring (only their own team can raise them). */
  team?: Side;
  /** The local player: souls reaching them cue a sound, and soul fire landing near them shakes the camera. */
  me?: Unit;
  shake?: (amount: number) => void;
  /**
   * A moment with its own sound: `soul`, a soul reached the player (`k`
   * counts up a run of them, 0, 1, 2, ..., for a rising chime); `emerge`, the
   * dead climbing out of the floor (`k` 0 to 1 for how big).
   */
  cue?: (name: DescentCue, at: { x: number; y: number; z: number }, k: number) => void;
}

export type DescentCue = 'soul' | 'emerge';

/**
 * What Underworld Descent shows in the world: the chamber the team is in (and
 * the depth's colors), the exit gate's veil opening once a chamber is cleared,
 * a glowing ring on the gate's threshold, the soul fire's warning circles and
 * bursts, and a ring under every downed god of the player's team that fills
 * as an ally raises them. Souls fly: out of each slain monster into the god
 * who landed the blow, from a god raising an ally into the fallen one, back
 * into a god as it rises, and into the open gate's veil.
 * Every ring is a pooled ground decal sharing one material; every soul is a
 * copy of one instanced sprite.
 */
export class DescentView {
  private readonly map: UnderworldMap | null;
  private readonly eruptions: GroundDecal[] = [];
  private readonly revives: GroundDecal[] = [];
  private readonly door: GroundDecal;
  private shownLayout = -1;
  private shownChamber = -1;
  private phase = '';
  private shownDepth = -1;
  private open = 0;
  private burst: GodPalette = { cloth: 0, trim: 0, glow: 0, vfx: 0xff5a14, core: 0xffd08a };
  /** The depth's soul color, for souls that are nobody's in particular. */
  private soul = SOULS_OF.ember;
  readonly wisps = new SoulWisps(96);
  private readonly team: Side;
  /** How far each downed god had been raised last frame, and when it last took a soul from its helpers. */
  private readonly raised = new Map<Unit, { p: number; at: number }>();
  private sinkIn = 0;
  /** Monsters already seen climbing out of the floor. */
  private readonly risen = new WeakSet<Unit>();
  private clock = 0;
  /** The run of souls reaching the player: its length and when the last landed. */
  private streak = { k: 0, at: -1 };

  constructor(
    private readonly run: Descent,
    private readonly world: World,
    private readonly vfx: CombatVfx,
    private readonly groundAt: (x: number, z: number) => number,
    private readonly opts: DescentViewOptions = {},
  ) {
    this.team = opts.team ?? 'order';
    world.vfx.add(this.wisps.sprite);
    this.wisps.onAbsorb = (to) => {
      if (to !== opts.me) return;
      const chain = this.clock - this.streak.at < 0.6;
      this.streak.k = chain ? this.streak.k + 1 : 0;
      this.streak.at = this.clock;
      opts.cue?.('soul', { x: to.x, y: to.body.y + 1.2, z: to.z }, this.streak.k);
    };
    const content = world.content as Partial<UnderworldMap>;
    this.map = typeof content.show === 'function' ? (content as UnderworldMap) : null;
    for (let i = 0; i < ERUPTIONS; i++) {
      const d = new GroundDecal(groundAt);
      d.setStyle('telegraph');
      d.mesh.visible = false;
      this.eruptions.push(d);
      world.vfx.add(d.mesh);
    }
    for (let i = 0; i < 4; i++) {
      const d = new GroundDecal(groundAt);
      d.setStyle('telegraph');
      d.setColors(0x8fe8ff, 0xffffff);
      d.mesh.visible = false;
      this.revives.push(d);
      world.vfx.add(d.mesh);
    }
    this.door = new GroundDecal(groundAt);
    this.door.setStyle('zone');
    this.door.mesh.visible = false;
    world.vfx.add(this.door.mesh);
  }

  frame(dt: number, time: number): void {
    const r = this.run;
    if (!r.chamber) return;
    if (r.chamber !== this.shownChamber) {
      // the team has moved on: souls still flying in the last chamber would streak across the world
      this.shownChamber = r.chamber;
      this.wisps.swarm.clear();
      this.raised.clear();
    }
    if (r.current.layout !== this.shownLayout) {
      this.shownLayout = r.current.layout;
      this.map?.show(this.shownLayout);
    }
    if (r.depth !== this.shownDepth) {
      this.shownDepth = r.depth;
      const palette = DEPTHS[r.depth]!.palette;
      const c = DEPTH_COLORS[palette];
      if (this.map?.setPalette(palette)) this.world.recolorFires();
      this.world.environment.setDepth(c);
      this.burst = { cloth: 0, trim: 0, glow: c.glow, vfx: c.glow, core: c.fire.high };
      this.soul = SOULS_OF[palette];
      for (const d of this.eruptions) d.setColors(c.glow, c.fire.high);
    }
    this.clock += dt;
    if (r.phase !== this.phase) {
      // the floor gives way beneath the team as it goes down
      if (r.phase === 'descend') this.opts.shake?.(0.4);
      this.phase = r.phase;
    }

    // the exit's veil glows up once the way down is open
    const goal = r.phase === 'exit' || r.phase === 'descend' ? 1 : 0;
    this.open += (goal - this.open) * (1 - Math.exp(-dt * (goal ? 2.2 : 8)));
    gateOpen.value = this.open;
    const door = exitSpot(r.layout);
    this.door.mesh.visible = this.open > 0.02;
    if (this.door.mesh.visible) {
      const c = DEPTH_COLORS[DEPTHS[r.depth]!.palette];
      this.door.setColors(c.glow, 0xffffff);
      this.door.values.opacity = this.open * (0.75 + Math.sin(time * 4) * 0.25);
      // drawn a little in front of the threshold, so the ring never climbs the rock behind the veil
      this.door.place({ type: 'ring', radius: DESCENT.exitRadius - 0.4, width: 0.5 }, door.x, door.z + 1.2, 0, 0.1);
    }

    // soul fire: a circle that fills until it erupts
    r.eruptions.forEach((e, i) => {
      const d = this.eruptions[i];
      if (!d) return;
      d.mesh.visible = true;
      d.values.fill = 1 - e.left / DESCENT.eruption.warn;
      d.values.opacity = 0.65 + d.values.fill * 0.35;
      d.place({ type: 'circle', radius: e.r }, e.x, e.z, 0, 0.09);
    });
    for (let i = r.eruptions.length; i < this.eruptions.length; i++) this.eruptions[i]!.mesh.visible = false;
    // each landing: a column of soul fire bursting from the ground, spitting loose souls
    const me = this.opts.me;
    for (const e of r.landed.splice(0)) {
      this.vfx.pillar(this.burst, e.x, e.z, 0.3, 1.3);
      this.vfx.burst(this.burst, e.x, 0.4, e.z, 1.3);
      this.wisps.swarm.release(e.x, this.groundAt(e.x, e.z) + 0.6, e.z, 4, null, this.soul, 0.6, 0.15);
      if (me && this.opts.shake) {
        const d = Math.hypot(me.x - e.x, me.z - e.z);
        if (d < 10) this.opts.shake(0.22 * (1 - d / 10));
      }
    }
    for (const m of r.monsters) {
      if (this.risen.has(m)) continue;
      this.risen.add(m);
      if (m.alive) this.emerge(m);
    }
    this.streams();
    this.gate(dt, door);
    this.wisps.frame(dt);

    // a ring under each downed god that fills as it is raised
    let k = 0;
    for (const [g, p] of r.downed) {
      if (r.sideOf(g) !== this.team) continue;
      const d = this.revives[k++];
      if (!d) break;
      d.mesh.visible = true;
      d.values.fill = p;
      d.values.opacity = 0.55 + Math.sin(time * 5) * 0.15 + p * 0.3;
      d.place({ type: 'circle', radius: DESCENT.revive.range }, g.x, g.z, 0, 0.08);
    }
    for (; k < this.revives.length; k++) this.revives[k]!.mesh.visible = false;
  }

  /** Souls leave the slain: a monster's into the god who landed the blow (as many as it was worth), a downed god's to the rival who downed it or away; a god rising takes souls back in. */
  onEvent(e: SimEvent): void {
    const r = this.run;
    if (!r.chamber) return;
    if (e.type === 'heal' && e.source?.tag.endsWith(':gravekeeper') && e.target.alive) {
      // the Gravekeeper's lantern flares and a stream of amber souls pours into its patient
      const k = e.source;
      const f = k.forward;
      // (the lantern hangs ahead of it on its staff hand, the model's +x side)
      const x = k.x + f.x * 0.8 + f.z * 0.25;
      const z = k.z + f.z * 0.8 - f.x * 0.25;
      const y = k.body.y + 2.1;
      const to = e.target;
      for (let i = 0; i < 5; i++) this.wisps.swarm.send(x, y, z, to, KEEPER_GLOW, 0.42, Math.min(2.6, 0.6 + to.radius * 0.6));
      this.vfx.burst(LANTERN, x, y, z, 0.6);
      return;
    }
    if (e.type === 'respawn' && r.gods.includes(e.unit)) {
      const g = e.unit;
      const color = this.colorFor(g);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const x = g.x + Math.cos(a) * 2.6;
        const z = g.z + Math.sin(a) * 2.6;
        this.wisps.swarm.send(x, this.groundAt(x, z) + 0.3, z, g, color, 0.6, 1.1);
      }
      this.vfx.burst({ cloth: 0, trim: 0, glow: color, vfx: color, core: 0xffffff }, g.x, g.body.y + 1.1, g.z, 0.9);
      return;
    }
    if (e.type !== 'death') return;
    const u = e.unit;
    const isGod = u.kind === 'god' && r.gods.includes(u);
    if (!isGod && u.kind !== 'monster') return;
    const foe = (k: Unit | null | undefined) => (k && k.kind === 'god' && k.alive && k.team !== u.team ? k : null);
    const to = foe(e.killer) ?? foe(e.assists.find((a) => a.kind === 'god')) ?? null;
    const type = u.origin?.f === 'mode' ? (u.origin.data as { type?: keyof typeof SOULS } | undefined)?.type : undefined;
    const worth = isGod ? (r.versus ? DESCENT.versus.god : 0) : type ? SOULS[type] : 1;
    const y = u.body.y + Math.min(3.2, 0.9 + u.radius * 0.5);
    if (isGod && !(r.versus && to)) {
      // no rival to take them: a few souls slip away upward as the god goes down
      this.wisps.swarm.release(u.x, y, u.z, 3, null, this.colorFor(u), 0.6, 0.3);
      return;
    }
    this.wisps.swarm.release(u.x, y, u.z, Math.min(12, 1 + worth), to, to ? this.colorFor(to) : this.soul, worth >= 10 ? 1.1 : 0.85, worth >= 10 ? 0.6 : 0.28);
  }

  /**
   * The dead claw up out of the floor (the unit views raise the body): the
   * ground bursts in the depth's fire and loose souls gather into it. A boss
   * erupts in a column of fire that shakes the chamber; the Gilded Thornback
   * comes up in a flash of gold.
   */
  private emerge(m: Unit): void {
    const role = m.origin?.f === 'mode' ? (m.origin.data as { role?: string } | undefined)?.role : undefined;
    const boss = role === 'boss';
    const gy = this.groundAt(m.x, m.z);
    const palette = role === 'gilded' ? GILDED : this.burst;
    this.vfx.burst(palette, m.x, gy + 0.3, m.z, boss ? 2.6 : Math.min(1.8, 0.8 + m.radius * 0.35));
    if (boss) this.vfx.pillar(palette, m.x, m.z, 0.5, 2.4);
    const n = boss ? 10 : 4;
    const reach = 1.6 + m.radius;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
      const x = m.x + Math.cos(a) * reach;
      const z = m.z + Math.sin(a) * reach;
      this.wisps.swarm.send(x, this.groundAt(x, z) + 0.2, z, m, role === 'gilded' ? GILDED.core : this.soul, boss ? 0.8 : 0.5, boss ? 2.4 : 0.9);
    }
    const me = this.opts.me;
    const near = me ? Math.hypot(me.x - m.x, me.z - m.z) : 99;
    if (boss && near < 40) this.opts.shake?.(0.45 * (1 - near / 40));
    this.opts.cue?.('emerge', { x: m.x, y: gy, z: m.z }, boss ? 1 : Math.min(0.7, 0.3 + m.radius * 0.15));
  }

  /** A soul's color for a god: its team's in a shared descent, the depth's in co-op. */
  private colorFor(g: Unit): number {
    if (!this.run.versus) return this.soul;
    return this.run.sideOf(g) === this.team ? ALLY_SOUL : FOE_SOUL;
  }

  /** Each god raising a fallen ally pours a stream of souls into them while the raising goes on. */
  private streams(): void {
    const r = this.run;
    for (const g of this.raised.keys()) if (!r.downed.has(g)) this.raised.delete(g);
    for (const [g, p] of r.downed) {
      const seen = this.raised.get(g) ?? { p: 0, at: -1 };
      this.raised.set(g, seen);
      const rising = p > seen.p;
      seen.p = p;
      if (!rising || this.clock - seen.at < STREAM_EVERY) continue;
      seen.at = this.clock;
      const side = r.sideOf(g);
      const range = DESCENT.revive.range + 0.5;
      for (const h of r.gods) {
        if (h === g || !h.alive || r.sideOf(h) !== side || Math.hypot(h.x - g.x, h.z - g.z) > range) continue;
        this.wisps.swarm.send(h.x, h.body.y + 1.2, h.z, g, this.colorFor(g), 0.45, 0.45, true);
      }
    }
  }

  /** While the way down is open, loose souls drift across the chamber into the gate's veil. */
  private gate(dt: number, door: { x: number; z: number }): void {
    if (this.open < 0.3) return;
    this.sinkIn -= dt * this.open;
    while (this.sinkIn <= 0) {
      this.sinkIn += 0.16;
      const x = door.x + (Math.random() - 0.5) * 16;
      const z = door.z + 3 + Math.random() * 12;
      this.wisps.swarm.sink(x, this.groundAt(x, z) + 0.4 + Math.random() * 1.6, z, door.x + (Math.random() - 0.5) * 3, 1.4 + Math.random() * 3.6, door.z - 1, this.soul, 0.4 + Math.random() * 0.25);
    }
  }

  /** Shows every decal and the souls for the loading frames that prepare shaders; returns the undo. */
  prime(): () => void {
    const all = [...this.eruptions, ...this.revives, this.door];
    for (const d of all) d.mesh.visible = true;
    const wisps = this.wisps.prime();
    return () => {
      for (const d of all) d.mesh.visible = false;
      wisps();
    };
  }
}
