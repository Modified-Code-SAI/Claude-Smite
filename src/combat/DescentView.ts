import * as THREE from 'three/webgpu';
import type { Side } from '../game/combatant';
import { exitSpot, obstaclesOf, underworldField } from '../map/UnderworldLayout';
import type { CameraShot } from '../player/ThirdPersonCamera';
import { DESCENT, DEPTHS, SOULS, type Descent } from '../sim/Descent';
import { RELIC, type RelicId, type RelicProc } from '../sim/Relics';
import type { SimEvent, Unit } from '../sim/Unit';
import type { World } from '../scene/World';
import { DEPTH_COLORS, gateOpen } from '../scene/underworld/palettes';
import type { UnderworldMap } from '../scene/underworld/UnderworldMap';
import { ArcView } from './Arcs';
import { fallDistance, fallOrbit, fallShot, introDistance, introShot, introSpot, BOSS_FALL, type IntroSubject } from './bossIntro';
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
/** Each relic's light when it goes off. */
const RELIC_FX: Record<RelicId, GodPalette> = {
  knell: { cloth: 0, trim: 0, glow: 0xff5a1a, vfx: 0xff6a20, core: 0xffc878 },
  chain: { cloth: 0, trim: 0, glow: 0x3aa8ff, vfx: 0x4ab4ff, core: 0xe8f8ff },
  echo: { cloth: 0, trim: 0, glow: 0xffc23a, vfx: 0xffc84a, core: 0xfff4c8 },
  aegis: { cloth: 0, trim: 0, glow: 0xc8d4f0, vfx: 0xd8e2ff, core: 0xffffff },
  harvest: { cloth: 0, trim: 0, glow: 0x5aff8a, vfx: 0x6aff96, core: 0xe0ffe8 },
  spite: { cloth: 0, trim: 0, glow: 0xff3020, vfx: 0xff4030, core: 0xffb090 },
  lantern: { cloth: 0, trim: 0, glow: 0x8fe8ff, vfx: 0x8fe8ff, core: 0xffffff },
};
/** How long a Chain of Souls bolt crackles, and a Death Knell's ring takes to spread. */
const LEAP_LIFE = 0.28;
const KNELL_LIFE = 0.5;
/** A boss calling up its adds: how long its ring of soul fire takes to run out across the floor, and how far. */
const CALL_LIFE = 1.1;
const CALL_REACH = 16;

export interface DescentViewOptions {
  /** The player's team: in a shared descent the rivals' fallen get no ring (only their own team can raise them). */
  team?: Side;
  /** The local player: souls reaching them cue a sound, and soul fire landing near them shakes the camera. */
  me?: Unit;
  shake?: (amount: number) => void;
  /**
   * A moment with its own sound: `soul`, a soul reached the player (`k`
   * counts up a run of them, 0, 1, 2, ..., for a rising chime); `emerge`, the
   * dead climbing out of the floor (`k` 0 to 1 for how big); `bossCall`, a
   * boss calling up its adds (`k` counts its calls this fight, 1, 2, ...).
   */
  cue?: (name: DescentCue, at: { x: number; y: number; z: number }, k: number) => void;
  /** Takes the camera for a boss's entrance (null hands it back); see bossIntro. */
  cameraShot?: (shot: CameraShot | null) => void;
  /** A unit's height as drawn, for framing a boss. */
  heightOf?: (u: Unit) => number | null;
}

export type DescentCue = 'soul' | 'emerge' | 'boss' | 'bossCall' | 'bossFall' | `relic.${RelicId}`;

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
  /** A boss's entrance or fall on camera: the boss, how long it has run, where the camera stands (and drifts). */
  private intro: { fall: boolean; boss: Unit; t: number; subject: IntroSubject; spot: { x: number; z: number }; orbit: number; shot: CameraShot } | null = null;
  /** The last boss whose fall was shown. */
  private fell: Unit | null = null;
  /** The boss whose calls are being shown, the calls already shown, and the ring of the newest running out from where it stood. */
  private callBoss: Unit | null = null;
  private callsSeen = 0;
  private readonly callRing: GroundDecal;
  private readonly callAt = { x: 0, z: 0, age: -1 };
  /** The newest soul fire already marked (the Ossuary King's rain sends a bolt into each new one). */
  private lastErupt = 0;
  private clock = 0;
  /** The run of souls reaching the player: its length and when the last landed. */
  private streak = { k: 0, at: -1 };
  /** Relics going off: the newest proc already shown, Chain of Souls bolts still crackling, and Death Knell rings spreading. */
  private lastProc = 0;
  private readonly chainArc = new ArcView();
  private readonly leaps: { a: THREE.Vector3; mid: THREE.Vector3; b: THREE.Vector3; age: number }[] = [];
  private readonly knellRings: GroundDecal[] = [];
  private readonly knells: { x: number; z: number; age: number }[] = [];

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
    for (let i = 0; i < 4; i++) {
      const d = new GroundDecal(groundAt);
      d.setStyle('telegraph');
      d.setColors(RELIC_FX.knell.vfx, RELIC_FX.knell.core);
      d.mesh.visible = false;
      this.knellRings.push(d);
      world.vfx.add(d.mesh);
    }
    this.callRing = new GroundDecal(groundAt);
    this.callRing.setStyle('telegraph');
    this.callRing.mesh.visible = false;
    world.vfx.add(this.callRing.mesh);
    this.chainArc.setColors(RELIC_FX.chain.vfx, RELIC_FX.chain.core);
    this.chainArc.group.visible = false;
    world.vfx.add(this.chainArc.group);
  }

  frame(dt: number, time: number): void {
    const r = this.run;
    if (!r.chamber) return;
    if (r.chamber !== this.shownChamber) {
      // the team has moved on: souls still flying in the last chamber would streak across the world
      this.shownChamber = r.chamber;
      this.wisps.swarm.clear();
      this.raised.clear();
      this.callAt.age = -1;
      this.callRing.mesh.visible = false;
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
    this.rain(r);
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
    // before the adds it calls are marked risen, so its souls can find them
    const boss = r.boss;
    if (boss !== this.callBoss || r.calls < this.callsSeen) {
      this.callBoss = boss;
      this.callsSeen = r.calls;
    } else if (boss?.alive && r.calls > this.callsSeen) {
      this.callsSeen = r.calls;
      this.call(boss);
    }
    this.callFrame(dt);
    for (const m of r.monsters) {
      if (this.risen.has(m)) continue;
      this.risen.add(m);
      if (m.alive) this.emerge(m);
    }
    if (boss && !boss.alive && r.fall > 0 && this.fell !== boss) {
      this.fell = boss;
      this.startFall(boss);
    }
    this.introFrame(dt);
    this.streams();
    this.gate(dt, door);
    this.relicFx(dt);
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

  /**
   * The Ossuary King's Soul Rain: a bolt of amber souls arcs from the fire in
   * its ribs into each circle of soul fire it calls down, so the rain reads as
   * its doing.
   */
  private rain(r: Descent): void {
    const k = r.boss;
    for (const e of r.eruptions) {
      if (e.id <= this.lastErupt) continue;
      this.lastErupt = e.id;
      if (!k?.alive || !k.tag.endsWith(':ossuaryKing') || Math.hypot(k.x - e.x, k.z - e.z) > 45) continue;
      const spot = { x: e.x, z: e.z, body: { y: this.groundAt(e.x, e.z) }, alive: true };
      const f = k.forward;
      for (let i = 0; i < 3; i++) this.wisps.swarm.send(k.x + f.x * 0.4, k.body.y + 3.5, k.z + f.z * 0.4, spot, KEEPER_GLOW, 0.5 - i * 0.08, 3.2);
    }
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
    if (boss && this.run.intro > 0) this.startIntro(m, gy);
  }

  /**
   * A boss calling up its adds as it weakens (DESCENT.bossAdds): a column of
   * the depth's fire bursts out of it, a ring of soul fire runs out across the
   * floor, and souls pour from it into each of its servants as they claw up,
   * so the adds read as its doing.
   */
  private call(boss: Unit): void {
    const gy = this.groundAt(boss.x, boss.z);
    const height = this.opts.heightOf?.(boss) ?? 4;
    this.vfx.pillar(this.burst, boss.x, boss.z, 0.45, 2.2);
    this.vfx.burst(this.burst, boss.x, gy + height * 0.4, boss.z, 2.2);
    // paler than the depth's fire, so it reads over the glowing runes on the floor
    this.callRing.setColors(this.burst.core, 0xffffff);
    this.callAt.x = boss.x;
    this.callAt.z = boss.z;
    this.callAt.age = 0;
    for (const m of this.run.monsters) {
      if (m === boss || !m.alive || this.risen.has(m)) continue;
      for (let i = 0; i < 3; i++) this.wisps.swarm.send(boss.x, gy + height * 0.6, boss.z, m, this.soul, 0.55, 1.2);
    }
    const me = this.opts.me;
    const near = me ? Math.hypot(me.x - boss.x, me.z - boss.z) : 99;
    if (near < 40) this.opts.shake?.(0.3 * (1 - near / 40));
    this.opts.cue?.('bossCall', { x: boss.x, y: gy, z: boss.z }, this.run.calls);
  }

  /** The call's ring of soul fire running out across the floor, thinning as it goes. */
  private callFrame(dt: number): void {
    const c = this.callAt;
    if (c.age < 0) return;
    const t = (c.age += dt) / CALL_LIFE;
    const d = this.callRing;
    if (t >= 1) {
      c.age = -1;
      d.mesh.visible = false;
      return;
    }
    d.mesh.visible = true;
    d.values.fill = 1;
    d.values.opacity = (1 - t) * 0.95;
    d.place({ type: 'ring', radius: 1 + (CALL_REACH - 1) * Math.sqrt(t), width: 0.5 + 0.9 * (1 - t) }, c.x, c.z, 0, 0.1);
  }

  /** A boss rising while its chamber holds still: the camera turns to it (see bossIntro). */
  private startIntro(boss: Unit, ground: number): void {
    this.opts.cue?.('boss', { x: boss.x, y: ground, z: boss.z }, 1);
    // in step with the sim's own clock (a guest may see the boss rise a moment late)
    this.frameBoss(boss, ground, false, DESCENT.bossIntro - this.run.intro);
  }

  /** A boss gone down: the camera stands back and watches it fall (see BOSS_FALL). */
  private startFall(boss: Unit): void {
    const ground = this.groundAt(boss.x, boss.z);
    this.opts.cue?.('bossFall', { x: boss.x, y: ground, z: boss.z }, 1);
    this.opts.shake?.(0.35);
    this.frameBoss(boss, ground, true, DESCENT.bossFall - this.run.fall);
  }

  private frameBoss(boss: Unit, ground: number, fall: boolean, t: number): void {
    if (!this.opts.cameraShot) return;
    const height = this.opts.heightOf?.(boss) ?? 4;
    const subject = { x: boss.x, z: boss.z, ground, height };
    const me = this.opts.me;
    const toward = me ? { x: me.x, z: me.z } : exitSpot(this.run.layout);
    const obstacles = obstaclesOf(this.run.layout);
    const room = (x: number, z: number) => {
      let r = underworldField(x, z);
      for (const [ox, oz, or] of obstacles) r = Math.min(r, Math.hypot(x - ox, z - oz) - or);
      return r;
    };
    const spot = fall ? introSpot(subject, toward, room, fallDistance(height), BOSS_FALL.side) : introSpot(subject, toward, room, introDistance(height));
    const orbit = fall ? fallOrbit(subject, spot, room) : 0;
    this.intro = { fall, boss, t, subject, spot, orbit, shot: this.intro?.shot ?? { pos: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: 0 }, weight: 0 } };
  }

  /** Runs a boss's entrance or fall shot, handing the camera back as it ends (or if the run moves on first). */
  private introFrame(dt: number): void {
    const it = this.intro;
    const set = this.opts.cameraShot;
    if (!it || !set) return;
    it.t += dt;
    const shot = it.fall ? fallShot(it.t, DESCENT.bossFall, it.subject, it.spot, it.orbit, it.shot) : introShot(it.t, DESCENT.bossIntro, it.subject, it.spot, it.shot);
    const phase = this.run.phase;
    const over = shot.weight <= 0.001 || (it.fall ? phase === 'lost' : phase !== 'fight');
    set(over ? null : shot);
    document.body.classList.toggle('descent-cine', !over && shot.weight > 0.4);
    if (over) this.intro = null;
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

  /**
   * Relics going off: Death Knell's soul fire bursting out of the slain in a
   * spreading ring, Chain of Souls' bolts crackling from monster to monster,
   * Grave Harvest's green souls flying into the gods it heals, and a flare
   * on a god as Echoing Rite, Bone Aegis or Spite takes hold. Each has its
   * own sound for the player it is about (and for anyone near a burst).
   */
  private relicFx(dt: number): void {
    for (const p of this.run.relics.procs) {
      if (p.id <= this.lastProc) continue;
      this.lastProc = p.id;
      this.proc(p);
    }
    // Chain of Souls: bolts re-jagged every frame as they fade, so they crackle
    for (let i = this.leaps.length - 1; i >= 0; i--) if ((this.leaps[i]!.age += dt) >= LEAP_LIFE) this.leaps.splice(i, 1);
    this.chainArc.group.visible = this.leaps.length > 0;
    if (this.leaps.length) {
      this.chainArc.clear();
      let fade = 0;
      for (const l of this.leaps) {
        const k = 1 - l.age / LEAP_LIFE;
        fade = Math.max(fade, k);
        // up over the bodies and down into the next one, so it reads as a leap (a low heat keeps it soul-blue, not white)
        this.chainArc.bolt(l.a, l.mid, 0.22 + 0.2 * k, 0.14, 0.25 + 0.25 * k, 3);
        this.chainArc.bolt(l.mid, l.b, 0.22 + 0.2 * k, 0.14, 0.25 + 0.25 * k, 3);
      }
      this.chainArc.values.fade = fade;
    }
    // Death Knell: a ring of fire running out to the burst's reach
    for (let i = this.knells.length - 1; i >= 0; i--) if ((this.knells[i]!.age += dt) >= KNELL_LIFE) this.knells.splice(i, 1);
    this.knellRings.forEach((d, i) => {
      const k = this.knells[i];
      d.mesh.visible = !!k;
      if (!k) return;
      const t = k.age / KNELL_LIFE;
      d.values.fill = 1;
      d.values.opacity = (1 - t) * 0.9;
      d.place({ type: 'ring', radius: 0.6 + (RELIC.knell.radius - 0.6) * Math.sqrt(t), width: 0.35 + 0.5 * (1 - t) }, k.x, k.z, 0, 0.1);
    });
  }

  /** How high a monster's back stands at (x, z): the nearest monster's, or a thornback's when none is close. */
  private backOf(x: number, z: number): number {
    let best: Unit | null = null;
    let bd = 2.5;
    for (const m of this.run.monsters) {
      const d = Math.hypot(m.x - x, m.z - z);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    return best ? Math.min(3.2, 0.9 + best.radius * 0.7) : 1.6;
  }

  private proc(p: RelicProc): void {
    const fx = RELIC_FX[p.k];
    const me = this.opts.me;
    const god = p.god === undefined ? null : (this.run.gods[p.god] ?? null);
    const mine = !!god && god === me;
    const gy = this.groundAt(p.x, p.z);
    const cue = (at: { x: number; y: number; z: number }, k = 0) => this.opts.cue?.(`relic.${p.k}`, at, k);
    switch (p.k) {
      case 'knell': {
        this.vfx.burst(fx, p.x, gy + 0.5, p.z, 1.5);
        this.wisps.swarm.release(p.x, gy + 0.8, p.z, 5, null, fx.core, 0.5, 0.5);
        if (this.knells.length >= this.knellRings.length) this.knells.shift();
        this.knells.push({ x: p.x, z: p.z, age: 0 });
        const near = me ? Math.hypot(me.x - p.x, me.z - p.z) : 99;
        if (near < 12) this.opts.shake?.(0.12 * (1 - near / 12));
        cue({ x: p.x, y: gy + 0.5, z: p.z });
        return;
      }
      case 'chain': {
        if (p.tx === undefined || p.tz === undefined) return;
        // from the top of one monster to the top of the next (the nearest ones to each end)
        const a = new THREE.Vector3(p.x, gy + this.backOf(p.x, p.z), p.z);
        const b = new THREE.Vector3(p.tx, this.groundAt(p.tx, p.tz) + this.backOf(p.tx, p.tz), p.tz);
        const mid = a.clone().lerp(b, 0.5);
        mid.y = Math.max(a.y, b.y) + 0.5 + a.distanceTo(b) * 0.12;
        if (this.leaps.length >= 8) this.leaps.shift();
        this.leaps.push({ a, mid, b, age: 0 });
        this.vfx.burst(fx, a.x, a.y, a.z, 0.4);
        this.vfx.burst(fx, b.x, b.y, b.z, 0.65);
        cue({ x: b.x, y: b.y, z: b.z });
        return;
      }
      case 'harvest': {
        if (!god) return;
        for (let i = 0; i < 3; i++) this.wisps.swarm.send(p.x, gy + 1 + i * 0.2, p.z, god, fx.vfx, 0.34, 1.3);
        if (mine) cue({ x: god.x, y: god.body.y + 1.2, z: god.z });
        return;
      }
      case 'echo':
      case 'aegis':
      case 'spite': {
        if (!god) return;
        const y = god.body.y + (p.k === 'echo' ? 2.2 : 1.2);
        this.vfx.burst(fx, god.x, y, god.z, p.k === 'spite' ? 1.4 : 0.7);
        if (p.k === 'echo') this.wisps.swarm.release(god.x, y, god.z, 4, null, fx.core, 0.28, 0.35);
        // (no pillar for Spite: a column of light over a god is how its fall looks)
        if (p.k === 'spite') this.wisps.swarm.release(god.x, god.body.y + 0.4, god.z, 6, null, fx.vfx, 0.4, 0.5);
        if (mine) cue({ x: god.x, y, z: god.z });
        return;
      }
      default:
        return;
    }
  }

  /** Shows every decal and the souls for the loading frames that prepare shaders; returns the undo. */
  prime(): () => void {
    const all = [...this.eruptions, ...this.revives, this.door, ...this.knellRings];
    for (const d of all) d.mesh.visible = true;
    const wisps = this.wisps.prime();
    // a bolt of Chain of Souls, so its shader is ready before the first leap
    this.chainArc.group.visible = true;
    this.chainArc.bolt(new THREE.Vector3(0, 1, 0), new THREE.Vector3(2, 1, 0), 0.1);
    return () => {
      for (const d of all) d.mesh.visible = false;
      wisps();
      this.chainArc.clear();
      this.chainArc.group.visible = false;
    };
  }
}
