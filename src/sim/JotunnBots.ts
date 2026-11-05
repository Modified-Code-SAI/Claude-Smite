import { hypot } from '../core/math';
import { ULTIMATE_SLOT } from '../game/loadout';
import { GodBot } from './Bot';
import { PARTS, type Jotunn, type JotunnBrains, type PartId } from './Jotunn';
import type { Sim } from './Sim';
import { WORLD_SCALE, type Brain, type Flash, type Point, type Unit } from './Unit';

const STOMP = 0;
const BOULDER = 1;
const SLAM = 2;

/** How fast the giant bot turns, radians a second: slow enough that the gods can get behind it. */
const TURN = 1.75;
/** It only strikes at what is within this angle of where it faces. */
const STRIKE_CONE = 0.9;

/**
 * The giant when no one plays it: claims the shrine on its way in, then
 * walks to the nearest brazier and clubs it, stamping and slamming at the
 * gods around its feet, hurling boulders at the ones further off, and using
 * its ultimate where it catches several. It turns slowly, so a god behind it
 * is safe from all but the stomp and the roar.
 */
export class GiantBot implements Brain {
  private facing: number;
  private decide = 0;
  /** Shrines it has given up on (gods kept it from them), until when. */
  private readonly skip = new Map<string, number>();
  private held = 0;
  /** How far ahead a slam can land. */
  private readonly slamReach: number;

  constructor(
    private readonly sim: Sim,
    private readonly mode: Jotunn,
  ) {
    this.facing = mode.giant.body.yaw;
    const slam = mode.giant.combatant.god.skills.find((k) => k.id === 'jotunn.slam')!.targeting;
    this.slamReach = ('range' in slam ? slam.range : 0) * WORLD_SCALE;
  }

  update(dt: number): void {
    const { sim, mode } = this;
    const g = mode.giant;
    g.move = null;
    if (!g.alive || mode.phase !== 'fight') return;
    const c = g.combatant;
    const locks = c.cc.locks();
    const gods = mode.gods.filter((u) => u.targetable);

    // a shrine the gods keep holding isn't worth standing in
    const inShrine = mode.shrineAt(g);
    this.held = inShrine?.contested ? this.held + dt : 0;
    if (inShrine && this.held > 3) this.skip.set(inShrine.def.id, sim.time + 25);
    const goal = this.goal();
    const brazier = goal.brazier;
    const reach = c.god.basicAttack.range * WORLD_SCALE;
    let want = goal.at;
    if (brazier && hypot(brazier.x - g.x, brazier.z - g.z) <= reach + brazier.radius - 0.4) want = { x: g.x, z: g.z };
    const dx = want.x - g.x;
    const dz = want.z - g.z;
    const d = hypot(dx, dz);
    if (d > 0.6 && !locks.move && g.windup <= 0) g.move = { x: dx / d, z: dz / d };

    // face whatever it means to hit, or where it walks
    const focus = brazier && !g.move ? brazier : this.nearest(gods, 12) ?? (g.move ? { x: g.x + g.move.x, z: g.z + g.move.z } : null);
    if (focus && g.windup <= 0) this.turnToward(focus, dt);
    g.body.yaw = this.facing;
    const f = { x: -Math.sin(this.facing), z: -Math.cos(this.facing) };
    g.aim.x = g.x + f.x * 6;
    g.aim.z = g.z + f.z * 6;

    this.decide -= dt;
    if (this.decide > 0 || g.windup > 0) return;
    this.decide = 0.25;
    if (locks.cast && locks.attack) return;

    const near = gods.filter((u) => hypot(u.x - g.x, u.z - g.z) <= 6.3 + u.radius);
    const inFront = (u: Unit, range: number) => this.ahead(u) && hypot(u.x - g.x, u.z - g.z) <= range;
    const cast = (slot: number, at: Point) => {
      if (c.canCast(slot) !== null) return false;
      g.aim.x = at.x;
      g.aim.z = at.z;
      return sim.cast(g, slot) === null;
    };

    if (!locks.cast) {
      if (this.ult(gods)) return;
      if ((near.length >= 2 || near.some((u) => hypot(u.x - g.x, u.z - g.z) < 4)) && cast(STOMP, { x: g.x, z: g.z })) return;
      const slamAt = gods.find((u) => inFront(u, this.slamReach + 3));
      if (slamAt && cast(SLAM, lead(slamAt, 0.85))) return;
      const far = gods.filter((u) => this.ahead(u) && hypot(u.x - g.x, u.z - g.z) > 9 && hypot(u.x - g.x, u.z - g.z) < 31);
      if (far.length && this.sim.rng() < 0.6 && cast(BOULDER, lead(far[0]!, 0.9))) return;
    }
    if (locks.attack) return;
    if (brazier && hypot(brazier.x - g.x, brazier.z - g.z) <= reach + brazier.radius && this.ahead(brazier, 0.5)) {
      g.aim.x = brazier.x;
      g.aim.z = brazier.z;
      sim.basic(g);
      return;
    }
    const swat = gods.find((u) => inFront(u, reach + u.radius));
    if (swat) {
      g.aim.x = swat.x;
      g.aim.z = swat.z;
      sim.basic(g);
    }
  }

  /** The ultimate, used where it catches at least two gods. */
  private ult(gods: Unit[]): boolean {
    const { sim, mode } = this;
    const g = mode.giant;
    const c = g.combatant;
    if (c.canCast(ULTIMATE_SLOT) !== null) return false;
    const id = c.loadout[ULTIMATE_SLOT];
    const dist = (u: Point) => hypot(u.x - g.x, u.z - g.z);
    let at: Point | null = null;
    if (id === 'jotunn.roar') {
      if (gods.filter((u) => dist(u) <= 12).length >= 2) at = { x: g.x, z: g.z };
    } else if (id === 'jotunn.frost-breath') {
      const hit = gods.filter((u) => dist(u) <= 17 && this.ahead(u, 0.6));
      if (hit.length >= 2) at = centroid(hit);
    } else if (id === 'jotunn.avalanche') {
      const hit = gods.filter((u) => dist(u) <= 34 && this.ahead(u, 0.25));
      if (hit.length >= 2) at = centroid(hit);
    } else {
      for (const u of gods) {
        if (dist(u) > 28 || !this.ahead(u)) continue;
        if (gods.filter((o) => hypot(o.x - u.x, o.z - u.z) <= 7).length >= 2) at = { x: u.x, z: u.z };
      }
    }
    if (!at) return false;
    g.aim.x = at.x;
    g.aim.z = at.z;
    return sim.cast(g, ULTIMATE_SLOT) === null;
  }

  /** Where to go: a shrine on the way, else the nearest standing brazier (from outside the colonnade). */
  private goal(): { at: Point; brazier: Unit | null } {
    const { mode } = this;
    const g = mode.giant;
    for (const s of mode.shrines) {
      if (s.dormant > 0 || (this.skip.get(s.def.id) ?? 0) > this.sim.time) continue;
      const d = hypot(s.def.x - g.x, s.def.z - g.z);
      if ((mode.claims === 0 && d < 45) || d < 16) return { at: { x: s.def.x, z: s.def.z }, brazier: null };
    }
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const b of mode.braziers) {
      if (!b.alive) continue;
      const d = hypot(b.x - g.x, b.z - g.z);
      if (d < bestD) {
        best = b;
        bestD = d;
      }
    }
    if (!best) return { at: { x: g.x, z: g.z }, brazier: null };
    // the brazier sits between two columns: stand in that gap, just outside the ring
    const a = Math.atan2(best.z, best.x);
    const stand = { x: Math.cos(a) * 16.5, z: Math.sin(a) * 16.5 };
    const r = hypot(g.x, g.z);
    if (r > 18) {
      // walk around the colonnade, not through it
      const ga = Math.atan2(g.z, g.x);
      let da = a - ga;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      if (Math.abs(da) > 0.45) {
        const step = Math.sign(da) * Math.min(Math.abs(da), 0.5);
        const ring = Math.max(22, Math.min(r, 26));
        return { at: { x: Math.cos(ga + step) * ring, z: Math.sin(ga + step) * ring }, brazier: best };
      }
    }
    return { at: stand, brazier: best };
  }

  private turnToward(p: Point, dt: number): void {
    const g = this.mode.giant;
    const want = Math.atan2(-(p.x - g.x), -(p.z - g.z));
    let d = want - this.facing;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const step = TURN * dt;
    this.facing += Math.abs(d) <= step ? d : Math.sign(d) * step;
  }

  /** Whether a point is within the giant's striking angle (radians either side of its facing). */
  private ahead(p: Point, cone = STRIKE_CONE): boolean {
    const g = this.mode.giant;
    const want = Math.atan2(-(p.x - g.x), -(p.z - g.z));
    let d = want - this.facing;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) <= cone;
  }

  private nearest(units: Unit[], within: number): Unit | null {
    const g = this.mode.giant;
    let best: Unit | null = null;
    let bestD = within;
    for (const u of units) {
      const d = hypot(u.x - g.x, u.z - g.z);
      if (d < bestD) {
        best = u;
        bestD = d;
      }
    }
    return best;
  }
}

/**
 * A god against the giant. Goes for whatever weak point is open (the crown
 * when it kneels, a planted wrist), else the knees, weaker first so both go
 * together, with one god on the back rune. Steps out of the ground the giant
 * is about to strike, holds the shrine the giant is claiming, and otherwise
 * fights like any god bot.
 */
export class WardenBot implements Brain {
  private readonly inner: GodBot;
  private readonly anchor = { x: 0, z: 0 };
  /** This bot's place in the team, which decides who takes the rune. */
  private readonly index: number;
  /** Warnings it has looked at, and whether it noticed them. */
  private readonly seen = new Map<number, boolean>();

  constructor(
    private readonly sim: Sim,
    private readonly mode: Jotunn,
    private readonly u: Unit,
    /** Seconds before it reacts to a warning. */
    private readonly reaction = 0.35,
    /** Chance it notices a given warning at all. */
    private readonly notice = 0.8,
    aggression = 0.6,
  ) {
    this.index = mode.players.findIndex((p) => p.god === u);
    this.inner = new GodBot(sim, u, {
      anchor: this.anchor,
      leash: 400,
      aggro: 400,
      aggression,
      choose: () => this.target(),
      castOn: (t) => t.kind === 'weakpoint' || t === mode.giant,
    });
  }

  update(dt: number): void {
    const { u, mode } = this;
    if (mode.phase !== 'fight') {
      u.move = null;
      return;
    }
    if (!u.alive || u.forced) {
      this.inner.update(dt);
      return;
    }
    const away = this.dodge();
    if (away) {
      u.move = away;
      u.body.yaw = Math.atan2(-away.x, -away.z);
      return;
    }
    const g = mode.giant;
    this.anchor.x = g.x;
    this.anchor.z = g.z;
    this.inner.update(dt);
  }

  /** The way out of a warning it stands in, once it has noticed it. */
  private dodge(): Point | null {
    const { u, sim, mode } = this;
    for (const f of sim.flashes) {
      if (!f.warn || f.owner !== mode.giant || f.age < this.reaction) continue;
      // like a player, it sometimes misses one (decided once per warning)
      let seen = this.seen.get(f.id);
      if (seen === undefined) this.seen.set(f.id, (seen = sim.rng() < this.notice));
      if (!seen) continue;
      const out = escape(f, u, u.radius + 0.8);
      if (out) return out;
    }
    if (this.seen.size > 32) this.seen.clear();
    return null;
  }

  private target(): Unit | null {
    const { mode, u } = this;
    const g = mode.giant;
    if (!g.alive) return null;
    // hold a shrine the giant is taking, if this is the god closest to it
    const claimed = mode.shrines.find((s) => s.progress > 0 && s.dormant <= 0);
    if (claimed) {
      const closest = mode.gods.filter((o) => o.alive).sort((a, b) => hypot(a.x - claimed.def.x, a.z - claimed.def.z) - hypot(b.x - claimed.def.x, b.z - claimed.def.z))[0];
      if (closest === u) {
        this.anchor.x = claimed.def.x;
        this.anchor.z = claimed.def.z;
        return null;
      }
    }
    const open = (id: PartId) => {
      const p = mode.parts.get(id)!;
      return p.alive && p.targetable ? p : null;
    };
    const crown = open('crown');
    if (crown) return crown;
    const wrist = open('wristL') ?? open('wristR');
    if (wrist && hypot(wrist.x - u.x, wrist.z - u.z) < 25) return wrist;
    const kneeL = open('kneeL');
    const kneeR = open('kneeR');
    // one god (the fourth) works on the back rune while the rest take the knees
    const rune = open('rune');
    if (rune && (this.index % 4 === 3 || (!kneeL && !kneeR))) return rune;
    if (kneeL && kneeR) {
      const l = kneeL.combatant.health / PARTS.kneeL.health;
      const r = kneeR.combatant.health / PARTS.kneeR.health;
      // close to even, take the nearer
      if (Math.abs(l - r) < 0.15) return hypot(kneeL.x - u.x, kneeL.z - u.z) < hypot(kneeR.x - u.x, kneeR.z - u.z) ? kneeL : kneeR;
      return l < r ? kneeL : kneeR;
    }
    return kneeL ?? kneeR ?? rune ?? g;
  }
}

/** Bots for both sides; `reaction` is how quickly gods notice a warning (difficulty). */
export function jotunnBots(sim: Sim, opts: { reaction?: number; notice?: number; aggression?: number } = {}): JotunnBrains {
  return {
    giant: (mode) => new GiantBot(sim, mode),
    god: (mode, u) => new WardenBot(sim, mode, u, opts.reaction, opts.notice, opts.aggression),
  };
}

function lead(u: Unit, t: number): Point {
  return { x: u.x + u.vx * t, z: u.z + u.vz * t };
}

function centroid(us: Unit[]): Point {
  let x = 0;
  let z = 0;
  for (const u of us) {
    x += u.x;
    z += u.z;
  }
  return { x: x / us.length, z: z / us.length };
}

/**
 * If `u` stands within `margin` of a warning's shape, the direction that
 * gets it out fastest; null when it is clear.
 */
export function escape(f: Flash, u: Point, margin: number): Point | null {
  const s = f.shape;
  if (s.type === 'circle') {
    const dx = u.x - s.x;
    const dz = u.z - s.z;
    const d = hypot(dx, dz);
    if (d > s.radius + margin) return null;
    if (d < 0.05) return { x: 1, z: 0 };
    return { x: dx / d, z: dz / d };
  }
  const fx = -Math.sin(s.yaw);
  const fz = -Math.cos(s.yaw);
  const px = u.x - s.x;
  const pz = u.z - s.z;
  const along = px * fx + pz * fz;
  const side = px * -fz + pz * fx;
  const sideDir = (sign: number) => ({ x: -fz * sign, z: fx * sign });
  if (s.type === 'line') {
    if (along < -margin || along > s.length + margin || Math.abs(side) > s.width / 2 + margin) return null;
    return sideDir(side >= 0 ? 1 : -1);
  }
  const d = hypot(px, pz);
  if (d > s.range + margin) return null;
  const half = (s.angle * Math.PI) / 360;
  const ang = Math.atan2(side, along);
  // standing behind the apex, or wide of the cone, is safe
  if (d > margin && Math.abs(ang) > half + Math.atan2(margin, Math.max(d, 0.1))) return null;
  // near the far edge, back away; otherwise go out the nearer side
  if (s.range - d < 2) return { x: px / (d || 1), z: pz / (d || 1) };
  return sideDir(ang >= 0 ? 1 : -1);
}


