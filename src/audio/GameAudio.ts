/**
 * Connects the match to the sound: listens to simulation events (casts,
 * hits, deaths, recalls), follows projectiles, lingering areas and
 * footsteps every frame, drives the music's intensity, the ambience and the
 * herald. It only reads game state; gameplay code never calls into it.
 */

import * as THREE from 'three/webgpu';
import type { CombatGame } from '../combat/CombatGame';
import { slotForCode, ULTIMATE_SLOT } from '../game/loadout';
import { ConquestLayout as L, nearestOnPolyline } from '../map/ConquestLayout';
import { isStructure, type Projectile, type SimEvent, type Unit, type Zone } from '../sim/Unit';
import type { Announcer } from './Announcer';
import { GodVoice } from './GodVoice';
import type { LineKind } from './godLines';
import type { AudioEngine, LoopHandle } from './AudioEngine';
import { skillPart, skillSound } from './bank';
import type { Music, SongName } from './music';
import { hypot } from '../core/math';
import { DUEL } from '../sim/Duel';
import { RUSH } from '../sim/Rush';
import { DESCENT, DEPTHS, type Descent } from '../sim/Descent';
import { relicById } from '../sim/Relics';
import { BOSS_CALL_LINE } from '../ui/bossNames';
import { JOTUNN, lastStand, type PartId } from '../sim/Jotunn';

/** A match's music only ever moves forward: dawn, then battle, then the siege. */
const PHASES: SongName[] = ['dawn', 'battle', 'siege'];


type Surface = 'stone' | 'grass' | 'dirt' | 'coins' | 'ash';

interface Tracked {
  loop: LoopHandle;
  seen: boolean;
}

/** How loud each relic's sound plays (the bursts carry, a god's own relics stay close). */
const RELIC_GAIN: Record<string, number> = { 'relic.knell': 0.75, 'relic.chain': 0.45, 'relic.echo': 0.5, 'relic.aegis': 0.45, 'relic.harvest': 0.35, 'relic.spite': 0.7 };

/** Which god basic-hit sound each god makes. */
const GOD_HIT: Record<string, string> = { zeus: 'hit.zap', thor: 'hit.blunt', odin: 'hit.blade', loki: 'hit.blade', anubis: 'hit.sand', jotunn: 'hit.jotunn' };
const GOD_TRAVEL: Record<string, string> = { zeus: 'travel.zeus', anubis: 'travel.anubis' };
const BOSSES = ['Treasure Wyrm', 'Molten Colossus', 'Ossuary King'];

export class GameAudio {
  private readonly projectiles = new Map<Projectile, Tracked>();
  private readonly zones = new Map<Zone, Tracked>();
  private readonly recalls = new Map<Unit, LoopHandle>();
  private readonly strides = new Map<Unit, { x: number; z: number; acc: number; foot: number; air: boolean }>();
  private readonly windups = new Map<Unit, boolean>();
  private readonly leaps = new Map<Unit, string>();
  private readonly seenBoss = new Set<Unit>();
  private readonly seenFlash = new Set<number>();
  /** Idle breathing beds for nearby camps and bosses that are not fighting. */
  private readonly idle = new Map<Unit, LoopHandle>();
  private readonly marches = new Map<string, LoopHandle>();
  /** God kills since each god's last death, for shutdown calls. */
  private readonly streaks = new Map<Unit, number>();
  private ambience: LoopHandle[] = [];
  /** The Jötunn's winter, heard: started once its snow first falls. */
  private blizzard: LoopHandle | null = null;
  private blizzardIn = 0;
  private heartbeat: LoopHandle | null = null;
  private heat = 0;
  /** The least the music's battle layer plays at, whatever the fighting nearby (a mode's climax holds it up). */
  private moodFloor = 0;
  private muffle = 0;
  /** Gain for other units' sounds: drops as the mix fills up, so your own fight stays clear. */
  private crowd = 1;
  private birdIn = 4;
  private crowIn = 30;
  private lastWave = 0;
  private firstBlood = false;
  private streak = 0;
  private multi = { count: 0, until: 0 };
  private titanWarnAt = -999;
  private phase = 0;
  private ended = false;
  private time = 0;
  /** The gods' spoken lines, fetched for each god in the match. */
  private readonly lines: GodVoice;
  private linesCheck = 0;
  private saidStart = false;
  /** When the last teammate said they were coming (one answer per call is plenty). */
  private omwAt = -999;

  constructor(
    private readonly engine: AudioEngine,
    private readonly music: Music,
    private readonly herald: Announcer,
    private readonly game: CombatGame,
    private readonly camera: THREE.Camera,
    private readonly conquest: boolean,
    /** Whether the player is off the ground on a jump of their own (the sim does not see those). */
    private readonly jumping: () => boolean = () => false,
  ) {
    this.lines = new GodVoice(engine, import.meta.env.BASE_URL);
    game.sim.listeners.push((e) => this.onEvent(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
    engine.onUnlock(() => this.startAmbience());
    this.music.play(this.conquest ? 'dawn' : game.descent ? 'abyss' : game.jotunn ? 'frost' : 'battle');
    // the giant's footfalls come from its model, so each lands with the foot; souls reaching you rise in pitch along a run
    // pings are the team's voice: flat, heard anywhere on the map, your own softer
    game.onPing = (sound, mine) => {
      if (!this.engine.ready) return;
      if (sound === 'wheel') this.engine.play('ping.wheel', { bus: 'ui', gain: 0.45 }, 2);
      else if (sound === 'tick') this.engine.play('ping.tick', { bus: 'ui', gain: 0.5 }, 1, 0.03);
      else this.engine.play(`ping.${sound}`, { bus: 'ui', gain: mine ? 0.55 : 0.85, vary: 0.02 }, 3, 0.08);
    };
    game.onCue = (name, at, k) => {
      if (!this.engine.ready) return;
      if (name === 'step') this.engine.play('step.giant', { at, gain: 0.45 + 0.55 * k, vary: 0.05, ref: 26 }, 3);
      else if (name === 'soul') this.engine.play('soul.absorb', { gain: 0.32, rate: 1 + Math.min(k, 10) * 0.055, vary: 0.03 }, 1, 0.05);
      // the dead clawing up out of the floor: one rumble for a wave rising together, a boss louder and lower
      else if (name === 'emerge') this.engine.play('monster.emerge', { at, gain: 0.5 + k * 0.6, rate: 1.15 - k * 0.35, vary: 0.06, ref: 12 + k * 20 }, 2, 0.12);
      // a boss's entrance (the camera turns to it): the whole chamber hears it, not just whoever is near
      else if (name === 'boss') this.engine.play('boss.intro', { bus: 'ui', gain: 0.75 }, 3);
      else if (name === 'bossFall') this.engine.play('boss.fall', { bus: 'ui', gain: 0.75 }, 3);
      // a boss calling up its adds: its roar carries across the chamber, and the herald names what it calls
      else if (name === 'bossCall') this.bossCall(at, k);
      // a relic going off: bursts and leaps where they happen (a pack's chain of bursts thinned out), a god's own relics at that god
      else if (name.startsWith('relic.')) this.engine.play(name, { at, gain: RELIC_GAIN[name] ?? 0.5, vary: 0.05, ref: 14 }, 2, name === 'relic.knell' ? 0.09 : name === 'relic.chain' ? 0.06 : 0.12);
    };
  }

  private get me(): Unit {
    return this.game.player;
  }

  // -------------------------------------------------------------------------
  // Events

  private onEvent(e: SimEvent): void {
    if (!this.engine.ready) return;
    const me = this.me;
    switch (e.type) {
      case 'cast':
        this.onCast(e.unit, e.cast.skill.id, e.cast.targeting.type, e.x, e.z, e.cast.slot);
        break;
      case 'basic':
        this.onBasic(e.unit);
        break;
      case 'impact':
        this.onImpact(e.owner, e.x, e.z, e.big);
        break;
      case 'damage': {
        if (e.amount <= 0) break;
        const near = e.target === me || e.source === me;
        if (near) this.heat = Math.min(1.5, this.heat + 0.12 + (e.target === me ? 0.1 : 0));
        else if (e.target.kind === 'god' && this.dist(e.target) < 30) this.heat = Math.min(1.5, this.heat + 0.05);
        if (e.target.kind === 'god' && e.target.alive && e.amount >= e.target.combatant.stats.maxHealth * 0.07) this.voice(e.target, 'hurt', 0.75, 3, 0.9);
        if (!e.ability && e.source) this.onBasicHit(e.source, e.target, e.crit);
        // the Jötunn's weak points crack under every blow
        else if (e.ability && e.target.kind === 'weakpoint') this.at('jotunn.crack', e.target, { gain: e.source === me ? 0.75 : 0.5, vary: 0.08, ref: 10 }, 2, 0.08, e.source === me);
        else if (e.ability && e.target === me) this.engine.play('hit.flesh', { gain: 0.45, vary: 0.1 }, 2, 0.15);
        // your skill landing on an enemy god or boss: a thwack that cuts through the fight, harder for bigger chunks
        else if (e.ability && e.source === me && e.target.team !== me.team && (e.target.kind === 'god' || e.target.kind === 'monster')) {
          const chunk = Math.min(1, e.amount / Math.max(1, e.target.combatant.stats.maxHealth) / 0.15);
          if (e.target.kind === 'god' || chunk > 0.3) this.engine.play('hit.confirm', { gain: 0.5 + 0.4 * chunk, vary: 0.06 }, 4, 0.07);
        }
        if (e.target.kind === 'titan' && e.target.team === me.team && this.time - this.titanWarnAt > 40) {
          this.titanWarnAt = this.time;
          this.herald.say('Our Titan is under attack!', 'bad', 3);
        }
        break;
      }
      case 'heal':
        if (e.target === me && e.amount > 25) this.engine.play('heal', { gain: 0.5 }, 2, 1.2);
        break;
      case 'death':
        this.onDeath(e.unit, e.killer);
        break;
      case 'respawn':
        if (e.unit === me) {
          this.engine.play('god.respawn', { gain: 0.8 }, 4);
          if (!this.game.rush) this.speak(me, 'respawn', { delay: 0.5 });
        }
        else if (e.unit.kind === 'phoenix') this.at('phoenix.rise', e.unit, { gain: 1, ref: 14 }, 4);
        break;
      case 'levelUp':
        if (e.unit !== me) break;
        if (e.level === 5) {
          this.engine.play('god.ultready', { gain: 0.8 }, 4);
          this.herald.say('Your ultimate has awakened.', 'good', 1);
        } else this.engine.play('god.levelup', { gain: 0.7 }, 4);
        break;
      case 'heal':
        // a Gravekeeper's lantern flaring as it pours souls into a monster
        if (e.source?.tag.endsWith(':gravekeeper') && this.dist(e.source) < 45) this.at('keeper.mend', e.source, { gain: 0.6, vary: 0.05 }, 2, 0.2);
        break;
      case 'reward':
        if (e.unit === me && e.favor > 0) this.engine.play('favor', { gain: 0.35, vary: 0.05 }, 2, 0.08);
        break;
      case 'teleport':
        if (e.quiet || (this.dist(e.unit) >= 50 && hypot(e.fromX - this.engine.listenerPos.x, e.fromZ - this.engine.listenerPos.z) >= 50)) break;
        if (e.unit.tag.endsWith(':shade')) {
          // a Shade's blink: a hiss as it folds away, a whispered gasp where it lands
          this.engine.play('shade.vanish', { at: { x: e.fromX, z: e.fromZ }, gain: 0.55, vary: 0.05 }, 2);
          this.at('shade.appear', e.unit, { gain: 0.5, delay: 0.08, vary: 0.05 }, 2);
          break;
        }
        this.engine.play('teleport', { at: { x: e.fromX, z: e.fromZ }, gain: 0.6 }, 2);
        this.at('teleport', e.unit, { gain: 0.5, delay: 0.05 }, 2);
        break;
      case 'recall':
        this.onRecall(e.unit, e.state);
        break;
      case 'taunt':
        // a taunt is on purpose, so it cuts in over whatever the god was saying
        this.speak(e.unit, 'taunt', { variant: e.line, cut: true });
        break;
      case 'ping':
        // a teammate's "on my way" in their own voice (the first to answer a call)
        if (e.kind === 'omw' && e.unit.team === me.team && (e.unit === me || this.time - this.omwAt > 3)) {
          if (this.speak(e.unit, 'omw', { flat: true, delay: 0.15 }) && e.unit !== me) this.omwAt = this.time;
        }
        break;
    }
  }

  private onCast(u: Unit, id: string, targeting: string, x: number, z: number, slot: number): void {
    const ss = skillSound(id);
    const mine = u === this.me;
    const ult = slot === ULTIMATE_SLOT;
    const gain = (mine ? 1 : 0.85) * (ult ? 1.15 : 1);
    this.at(skillPart(id, 'cast'), u, { gain, ref: ult ? 12 : 8, vary: 0.02, wet: ult ? 0.2 : 0.05 }, mine ? 6 : 4);
    if (ult && !this.speak(u, 'ult')) this.voice(u, 'cry', 0.9, 5);
    if (ult && mine) {
      this.engine.duckMusic(0.6, 1.4);
      this.engine.play('ult.surge', { gain: 0.8 }, 6);
    } else if (ult && u.team !== this.me.team && u.stealth <= 0 && this.dist(u) < 35) this.engine.play('ult.warn', { gain: 0.75 * (1 - this.dist(u) / 50) }, 5, 1);
    else if (Math.random() < 0.5) this.voice(u, 'effort', 0.6, 3, 0.6);
    if (!ss.impact) return;
    if (targeting === 'leap') {
      this.leaps.set(u, id);
      return;
    }
    if (targeting === 'projectile') return;
    // instant areas, cones, lines and self bursts land where they were aimed
    const where = targeting === 'self' || targeting === 'dash' ? { x: u.x, z: u.z } : { x, z };
    this.engine.play(skillPart(id, 'impact'), { at: where, gain: gain * 0.9, delay: ss.impactDelay ?? 0.05, ref: 8, vary: 0.04 }, 4);
  }

  private onBasic(u: Unit): void {
    const mine = u === this.me;
    let name: string;
    let gain = mine ? 0.85 : 0.7;
    let gap = 0;
    let ref = 6;
    switch (u.kind) {
      case 'god':
      case 'dummy':
        name = `basic.${u.combatant.god.id}`;
        if (Math.random() < 0.18) this.voice(u, 'effort', 0.4, 2, 1.5);
        break;
      case 'minion':
        name = `basic.minion.${u.tag.split(':').pop()}`;
        gain = 0.42;
        gap = 0.04;
        break;
      case 'tower':
      case 'phoenix':
        name = 'tower.shot';
        gain = 1;
        ref = 12;
        break;
      case 'titan':
        name = 'titan.slam';
        gain = 1.2;
        ref = 20;
        break;
      case 'monster':
        name = u.name === 'Treasure Wyrm' ? 'basic.wyrm' : u.name === 'Molten Colossus' ? 'basic.colossus' : u.name === 'Ossuary King' ? 'basic.king' : u.tag.endsWith('warden') ? 'basic.warden' : u.tag.endsWith('thornSpitter') ? 'basic.spitter' : u.tag.endsWith(':shade') ? 'basic.shade' : u.tag.endsWith(':gravekeeper') ? 'basic.keeper' : 'basic.monster';
        ref = u.radius > 2 ? 16 : 7;
        gain = u.radius > 2 ? 1.1 : 0.7;
        break;
      default:
        name = 'basic.minion.melee';
        gain = 0.5;
    }
    if (!this.engine.has(name)) name = 'basic.minion.melee';
    this.at(name, u, { gain, vary: 0.06, ref }, mine ? 5 : 2, gap);
  }

  private onBasicHit(src: Unit, target: Unit, crit: boolean): void {
    let name: string;
    let gain = src === this.me ? 1 : target === this.me ? 0.85 : 0.55;
    let gap = 0;
    if (isStructure(target)) name = 'hit.structure';
    else if (target.kind === 'weakpoint') {
      // four gods chip at it at once: theirs thin out, yours always crack
      name = 'jotunn.crack';
      gap = src === this.me ? 0 : 0.06;
    }
    else if (src.kind === 'tower' || src.kind === 'phoenix') name = 'tower.hit';
    else if (src.kind === 'god' || src.kind === 'dummy') name = GOD_HIT[src.combatant.god.id] ?? 'hit.flesh';
    else if (src.kind === 'minion') {
      const t = src.tag.split(':').pop();
      name = t === 'brute' ? 'hit.blunt' : t === 'archer' ? 'hit.flesh' : 'hit.blade';
      gain *= 0.6;
      gap = 0.05;
    } else if (src.kind === 'monster') name = src.radius > 2 ? 'hit.blunt' : src.tag.endsWith('thornSpitter') ? 'hit.acid' : src.tag.endsWith(':shade') ? 'hit.shade' : src.tag.endsWith(':gravekeeper') ? 'hit.keeper' : 'hit.monster';
    else name = 'hit.flesh';
    const mine = src === this.me || target === this.me;
    this.at(name, target, { gain, vary: 0.08 }, src === this.me ? 4 : 2, gap, mine);
    if (crit) this.at('hit.crit', target, { gain: 0.6 }, 3, 0, mine);
  }

  private onImpact(owner: Unit, x: number, z: number, big: boolean): void {
    // the sim emits impacts while the projectile or zone still exists, so find which one this is
    for (const p of this.game.sim.projectiles) {
      if (p.owner !== owner || Math.abs(p.x - x) > 0.01 || Math.abs(p.z - z) > 0.01) continue;
      if (p.cast) this.engine.play(skillPart(p.cast.skill.id, 'impact'), { at: { x, z }, gain: owner === this.me ? 1.1 : 0.9, vary: 0.05, ref: 8 }, owner === this.me ? 5 : 3, 0.03);
      else if (p.shot && this.game.sim.units.some((u) => isStructure(u) && u.shielded() && hypot(u.x - x, u.z - z) < u.radius + 1)) {
        this.engine.play('hit.structure', { at: { x, z }, gain: 0.4, vary: 0.1 }, 1, 0.08);
      }
      return;
    }
    for (const zn of this.game.sim.zones) {
      if (zn.owner !== owner || Math.abs(zn.x - x) > 0.01 || Math.abs(zn.z - z) > 0.01) continue;
      const name = skillPart(zn.cast.skill.id, 'tick');
      if (this.engine.has(name)) this.engine.play(name, { at: { x, z }, gain: 0.75, vary: 0.08, ref: 8 }, 3);
      return;
    }
    const leap = this.leaps.get(owner);
    if (leap && big) {
      this.leaps.delete(owner);
      this.engine.play(skillPart(leap, 'impact'), { at: { x, z }, gain: 1.1, ref: 12 }, 5);
    }
  }

  private onDeath(u: Unit, killer: Unit | null): void {
    const me = this.me;
    switch (u.kind) {
      case 'weakpoint':
        this.at('jotunn.shatter', u, { gain: 1.1, ref: 18 }, 5);
        break;
      case 'god':
        if (u === this.game.jotunn?.giant) {
          this.at('jotunn.fall', u, { gain: 1.3, ref: 40 }, 7);
          break;
        }
        this.at(this.game.rush ? 'god.daze' : 'god.death', u, { gain: u === me ? 1 : 0.8, ref: 10 }, 5);
        // your own god has last words (nobody dies in Relic Rush, they are only dazed)
        const lastWords = u === me && !this.game.rush ? this.speak(u, 'death') : 0;
        if (!lastWords) this.voice(u, 'death', 0.85, 5);
        const streak = this.endStreak(u, killer);
        if (killer === me && u !== me) {
          this.streak++;
          this.multi.count = this.time < this.multi.until ? this.multi.count + 1 : 1;
          this.multi.until = this.time + 10;
          // each kill in a run rings a step higher; multi-kills and shutdowns add a thunderclap and a chorus
          const step = Math.min(4, this.multi.count - 1 + Math.max(0, this.streak - 2) * 0.5);
          this.engine.play('kill.confirm', { gain: 0.8, rate: 2 ** ((step * 2) / 12) }, 5);
          if (this.multi.count >= 2 || streak >= 3 || this.streak >= 3) this.engine.play('kill.big', { gain: 0.6 + 0.1 * Math.min(3, this.multi.count) }, 5);
        }
        // the killer has a word over the body, after the fallen's own; a run of kills earns a streak call
        let gloat = 0;
        if (killer?.kind === 'god' && killer !== u && killer.alive && !this.game.rush) {
          const run = killer === me ? Math.max(this.streak, this.multi.count >= 2 ? 3 : 0) : (this.streaks.get(killer) ?? 0);
          gloat = this.speak(killer, run >= 3 ? 'streak' : 'kill', { delay: lastWords ? lastWords + 0.15 : 0.3 });
        }
        // the herald waits for the gods to finish, and leaves out what they just said
        if (lastWords || (gloat && (killer === me || u === me))) this.herald.hold(Math.max(lastWords, gloat) + 0.1);
        if (this.conquest) this.announceDeath(u, killer, streak, gloat > 0 && killer === me);
        if (u === me) {
          this.streak = 0;
          // in Relic Rush nobody dies: they are dazed for a moment
          if (!lastWords) this.herald.say(this.game.rush ? 'You are dazed!' : 'You have fallen.', 'bad', 2);
        }
        break;
      case 'minion':
        this.at('minion.death', u, { gain: 0.5, vary: 0.08 }, 1, 0.06);
        break;
      case 'monster':
        if (BOSSES.includes(u.name)) {
          this.at(u.name === 'Treasure Wyrm' ? 'wyrm.roar' : 'colossus.roar', u, { gain: 1.2, ref: 22, rate: 0.75 }, 6);
          this.at('structure.collapse', u, { gain: 0.6, ref: 20, delay: 0.6 }, 5);
          if (killer && killer.team !== 'neutral') {
            const ours = killer.team === me.team;
            const what = u.name === 'Treasure Wyrm' ? "the Wyrm's hoard" : "the Colossus's fury";
            this.herald.say(ours ? `Our team claims ${what}.` : `The enemy claims ${what}.`, ours ? 'good' : 'bad', 3);
          }
        } else this.at('monster.death', u, { gain: 0.8, vary: 0.08, ref: u.radius > 1 ? 9 : 6 }, 3);
        break;
      case 'tower':
      case 'phoenix':
      case 'titan': {
        this.at(u.kind === 'phoenix' ? 'phoenix.collapse' : 'structure.collapse', u, { gain: 1.3, ref: 25 }, 6);
        if (u.kind === 'titan') break;
        const ours = u.team === me.team;
        const lines = u.kind === 'tower' ? ['Our tower has crumbled.', 'An enemy tower crumbles!'] : ['Our Phoenix burns out.', 'The enemy Phoenix is extinguished!'];
        this.herald.say(ours ? lines[0]! : lines[1]!, ours ? 'bad' : 'good', 2);
        break;
      }
      default:
        break;
    }
  }

  /** Any death ends a god's streak, whoever (or whatever) landed the blow. Returns the streak it ended. */
  private endStreak(victim: Unit, killer: Unit | null): number {
    const streak = this.streaks.get(victim) ?? 0;
    this.streaks.set(victim, 0);
    if (killer?.kind === 'god' && killer !== victim) this.streaks.set(killer, (this.streaks.get(killer) ?? 0) + 1);
    return streak;
  }

  /**
   * The herald on a god's death. Team wipes and fallen allies describe the
   * victim's side, so they are called whoever landed the blow; first blood,
   * shutdowns and the player's streaks need a god to have earned the kill.
   */
  private announceDeath(victim: Unit, by: Unit | null, victimStreak: number, gloated = false): void {
    const me = this.me;
    const killer = by?.kind === 'god' ? by : null;
    const first = !!killer && !this.firstBlood;
    if (killer) this.firstBlood = true;
    if (first && killer) {
      this.herald.say(killer === me ? 'You drew first blood!' : 'First blood is spilled!', killer.team === me.team ? 'good' : 'bad', 4);
      return;
    }
    // a whole team down at once outranks everything else
    const team = this.game.sim.units.filter((u) => u.kind === 'god' && u.team === victim.team);
    if (team.length >= 2 && team.every((u) => !u.alive)) {
      this.herald.say(victim.team === me.team ? 'Our team has been wiped out.' : 'The enemy team is wiped out!', victim.team === me.team ? 'bad' : 'epic', 5);
      return;
    }
    if (killer && victimStreak >= 3 && killer.team === me.team) {
      this.herald.say(killer === me ? 'Shutdown! You ended their rampage.' : 'Shutdown! Their rampage is over.', 'good', 3);
      return;
    }
    if (victim !== me && victim.team === me.team) {
      this.herald.say('An ally has fallen.', 'bad', 1);
      return;
    }
    if (killer !== me || victim === me) return;
    const multi = ['', '', 'Two gods fall!', 'Three gods fall!', 'Four gods fall!', 'Ascendant! Five gods fall!'];
    if (this.multi.count >= 2) this.herald.say(multi[Math.min(5, this.multi.count)]!, 'epic', 4);
    else if (this.streak === 3) this.herald.say('You are on a rampage!', 'epic', 3);
    else if (this.streak === 5) this.herald.say('Unstoppable! None can stand against you!', 'epic', 3);
    else if (!gloated) this.herald.say('Enemy god slain.', 'good', 1);
  }

  private onRecall(u: Unit, state: 'start' | 'cancel' | 'done'): void {
    const old = this.recalls.get(u);
    if (state === 'start') {
      if (old || (u !== this.me && this.dist(u) > 40)) return;
      const l = this.engine.loop('recall.loop', { at: { x: u.x, z: u.z }, gain: u === this.me ? 0.7 : 0.45 });
      if (l) this.recalls.set(u, l);
      return;
    }
    old?.stop(0.25);
    this.recalls.delete(u);
    if (state === 'done') this.at('recall.done', u, { gain: 0.8 }, 3);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.repeat || !this.engine.ready) return;
    const slot = slotForCode(e.code);
    if (slot < 0 || !this.me.alive) return;
    if (this.me.combatant.canCast(slot)) this.engine.play('ui.deny', { bus: 'ui', gain: 0.6 }, 3, 0.15);
  }

  // -------------------------------------------------------------------------
  // Per frame

  frame(dt: number): void {
    this.time += dt;
    if (!this.engine.ready) return;
    const me = this.me;
    const fwd = this.camera.getWorldDirection(tmpDir);
    // the ears sit on the god (third-person games sound wrong with ears at the camera)
    this.engine.setListener(me.x, me.body.y + 1.7, me.z, fwd.x, fwd.z);

    const target = 1 / Math.sqrt(Math.max(1, this.engine.busy / 16));
    this.crowd += (target - this.crowd) * Math.min(1, dt * 8);
    this.followLines(dt);
    this.followProjectiles();
    this.followZones();
    for (const [u, l] of this.recalls) {
      if (!u.alive || u.recall <= 0) {
        l.stop(0.2);
        this.recalls.delete(u);
      } else l.setPosition(u.x, u.body.y + 1, u.z);
    }
    this.footsteps();
    this.watchMonsters();
    this.idleBeds();
    this.marching();
    this.watchMatch();
    this.watchModes();
    this.watchDuel();
    this.watchRush();
    this.watchDescent();
    this.watchJotunn();
    this.winterWind(dt);
    this.updateMood(dt);
    // while dead, the world is heard as if from far away
    this.muffle += ((me.alive ? 0 : 1) - this.muffle) * Math.min(1, dt * (me.alive ? 6 : 2.5));
    this.engine.setMuffle(this.muffle);
    this.ambientLife(dt);
  }

  private followProjectiles(): void {
    for (const t of this.projectiles.values()) t.seen = false;
    for (const p of this.game.sim.projectiles) {
      const t = this.projectiles.get(p);
      if (t) {
        t.seen = true;
        t.loop.setPosition(p.x, p.owner.body.y + 1.5, p.z);
        continue;
      }
      if (this.projectiles.size >= 16 || !this.engine.audible(p.x, p.z, 60)) continue;
      const name = this.travelFor(p);
      if (!name || !this.engine.has(name)) continue;
      const gain = p.cast ? 0.75 : p.owner.kind === 'minion' ? 0.25 : 0.5;
      const loop = this.engine.loop(name, { at: { x: p.x, y: 1.5, z: p.z }, gain, rate: 0.97 + Math.random() * 0.06, ref: 6 });
      if (loop) this.projectiles.set(p, { loop, seen: true });
    }
    for (const [p, t] of this.projectiles) {
      if (t.seen) continue;
      t.loop.stop(0.08);
      this.projectiles.delete(p);
    }
  }

  private travelFor(p: Projectile): string | null {
    if (p.cast) return skillPart(p.cast.skill.id, 'travel');
    const o = p.owner;
    if (o.kind === 'tower' || o.kind === 'phoenix') return 'travel.tower';
    if (o.kind === 'minion') return 'travel.arrow';
    if (o.kind === 'god' || o.kind === 'dummy') return GOD_TRAVEL[o.combatant.god.id] ?? null;
    return null;
  }

  private followZones(): void {
    for (const t of this.zones.values()) t.seen = false;
    for (const zn of this.game.sim.zones) {
      const t = this.zones.get(zn);
      if (t) {
        t.seen = true;
        t.loop.setPosition(zn.x, 1, zn.z);
        if (zn.ticks <= 0) t.loop.setGain(0, 0.15);
        continue;
      }
      const name = skillPart(zn.cast.skill.id, 'zone');
      if (!this.engine.has(name) || !this.engine.audible(zn.x, zn.z, 70)) continue;
      const loop = this.engine.loop(name, { at: { x: zn.x, y: 1, z: zn.z }, gain: 0.7, ref: 8 });
      if (loop) this.zones.set(zn, { loop, seen: true });
    }
    for (const [z, t] of this.zones) {
      if (t.seen) continue;
      t.loop.stop(0.4);
      this.zones.delete(z);
    }
  }

  private footsteps(): void {
    const lx = this.engine.listenerPos.x;
    const lz = this.engine.listenerPos.z;
    for (const u of this.game.sim.units) {
      // (the Jötunn's steps come from its model, its weak points ride on it)
      if (isStructure(u) || u.kind === 'dummy' || u.kind === 'weakpoint' || u === this.game.jotunn?.giant) continue;
      const d = hypot(u.x - lx, u.z - lz);
      const range = u.kind === 'minion' ? 22 : u.radius > 2 ? 60 : 38;
      let s = this.strides.get(u);
      if (!s) {
        s = { x: u.x, z: u.z, acc: 0, foot: 0, air: false };
        this.strides.set(u, s);
      }
      const moved = hypot(u.x - s.x, u.z - s.z);
      s.x = u.x;
      s.z = u.z;
      // coming down from a leap, a jump or a knock-up
      const air = (!!u.forced && u.forced.arc > 0) || (u === this.me && this.jumping());
      const hidden = u.stealth > 0 && u.team !== this.me.team;
      if (s.air && !air && u.alive && !hidden && d < range && u.kind !== 'minion') {
        const big = u.radius > 2;
        this.engine.play('land', { at: { x: u.x, y: u.body.y, z: u.z }, gain: (u === this.me ? 0.75 : 0.55) * (u === this.me ? 1 : this.crowd), vary: 0.06, ref: big ? 12 : 6, rate: big ? 0.7 : 1 }, u === this.me ? 4 : 2);
      }
      s.air = air;
      // leaps, blinks and recalls are not walking
      if (!u.alive || u.forced || moved > 3 || d > range || hidden) {
        s.acc = 0;
        continue;
      }
      s.acc += moved;
      const stride = u.kind === 'minion' ? 1.4 : u.radius > 2 ? 4.2 : u.kind === 'monster' ? 1.8 : 2.3;
      if (s.acc < stride) continue;
      s.acc -= stride;
      s.foot ^= 1;
      const heavy = u.radius > 2 || u.tag.endsWith('warden') || u.tag.endsWith('brute');
      const name = heavy ? 'step.heavy' : u.kind === 'minion' ? 'step.minion' : `step.${this.surface(u.x, u.z)}`;
      const mine = u === this.me;
      const gain = (mine ? 0.55 : u.kind === 'minion' ? 0.22 : heavy ? (u.radius > 2 ? 0.9 : 0.5) : 0.4) * (mine ? 1 : this.crowd);
      this.engine.play(name, { at: { x: u.x, y: u.body.y + 0.1, z: u.z }, gain, vary: 0.07, ref: heavy ? 10 : 4, rate: heavy && u.radius > 2 ? 0.8 : 1 }, mine ? 3 : 0, u.kind === 'minion' ? 0.05 : 0);
    }
    if (this.strides.size > 400) for (const u of this.strides.keys()) if (!this.game.sim.units.includes(u)) this.strides.delete(u);
  }

  private surface(x: number, z: number): Surface {
    if (!this.conquest) return 'stone';
    for (const c of L.camps) {
      if (c.team !== null || hypot(x - c.at[0], z - c.at[1]) > L.radii.boss) continue;
      return c.kind === 'treasureWyrm' ? 'coins' : 'ash';
    }
    for (const p of L.plazas) if (hypot(x - p.at[0], z - p.at[1]) < p.radius) return 'stone';
    for (const lane of L.lanes) if (nearestOnPolyline(lane.points, x, z).distance < lane.width * 0.55) return 'stone';
    for (const path of L.paths) if (nearestOnPolyline(path.points, x, z).distance < path.width * 0.6) return 'dirt';
    return 'grass';
  }

  private watchMonsters(): void {
    const sim = this.game.sim;
    for (const u of sim.units) {
      if (u.kind !== 'monster' && u.kind !== 'titan') continue;
      if (!u.alive) {
        this.windups.delete(u);
        continue;
      }
      // a boss arriving
      if (BOSSES.includes(u.name) && !this.seenBoss.has(u)) {
        this.seenBoss.add(u);
        this.at(u.name === 'Treasure Wyrm' ? 'wyrm.roar' : u.name === 'Ossuary King' ? 'king.roar' : 'colossus.roar', u, { gain: 1, ref: 25 }, 5);
        if (this.conquest) this.herald.say(u.name === 'Treasure Wyrm' ? 'The Treasure Wyrm has awoken.' : 'The Molten Colossus rises from the deep.', 'epic', 2);
      }
      const brain = u.brain as { specialProgress?: number } | null;
      const winding = u.windup > 0 || (brain?.specialProgress ?? 0) > 0;
      const was = this.windups.get(u) ?? false;
      if (winding && !was) {
        const special = (brain?.specialProgress ?? 0) > 0;
        if (u.kind === 'titan') this.at('titan.windup', u, { gain: 1, ref: 18 }, 4);
        else if (special) this.at(u.name === 'Treasure Wyrm' ? 'wyrm.roar' : 'boss.windup', u, { gain: 1, ref: 18, rate: u.name === 'Treasure Wyrm' ? 1.15 : 1 }, 4);
        else if (u.radius > 2 || u.tag.endsWith('warden')) this.at('monster.aggro', u, { gain: 0.7, rate: u.radius > 2 ? 0.6 : 0.8, ref: 10 }, 3, 1.2);
      }
      this.windups.set(u, winding);
    }
    // a boss's area attack lands as a flash on the ground
    for (const f of sim.flashes) {
      if (this.seenFlash.has(f.id)) continue;
      this.seenFlash.add(f.id);
      const o = f.owner;
      if (o.kind === 'monster' && BOSSES.includes(o.name) && f.shape.type === 'circle') {
        this.engine.play(o.name === 'Treasure Wyrm' ? 'wyrm.sweep' : o.name === 'Ossuary King' ? 'king.toll' : 'colossus.stomp', { at: { x: f.shape.x, z: f.shape.z }, gain: 1.2, ref: 18 }, 6);
      }
    }
    if (this.seenFlash.size > 500) this.seenFlash.clear();
  }

  /**
   * Camps and bosses that are not fighting breathe and grumble where they
   * wait: the nearest few, one bed per camp.
   */
  private idleBeds(): void {
    const near: [Unit, number][] = [];
    for (const u of this.game.sim.units) {
      if (u.kind !== 'monster' || !u.alive) continue;
      const boss = BOSSES.includes(u.name);
      const d = this.dist(u);
      if (d > (boss ? 55 : 32)) continue;
      if ((u.brain as { target?: Unit | null } | null)?.target) continue;
      near.push([u, d]);
    }
    near.sort((a, b) => b[0].radius - a[0].radius || a[1] - b[1]);
    const want = new Set<Unit>();
    for (const [u] of near) {
      if (want.size >= 4) break;
      // the biggest beast speaks for its camp
      if ([...want].some((w) => hypot(w.x - u.x, w.z - u.z) < 9)) continue;
      want.add(u);
    }
    for (const [u, l] of this.idle) {
      if (want.has(u)) l.setPosition(u.x, u.body.y + 1, u.z);
      else {
        l.stop(0.8);
        this.idle.delete(u);
      }
    }
    for (const u of want) {
      if (this.idle.has(u)) continue;
      const boss = BOSSES.includes(u.name);
      const name = u.name === 'Treasure Wyrm' ? 'idle.wyrm' : u.name === 'Molten Colossus' ? 'idle.lava' : 'idle.beasts';
      const l = this.engine.loop(name, { at: { x: u.x, y: u.body.y + 1, z: u.z }, bus: 'ambience', gain: boss ? 0.9 : 0.6, ref: boss ? 12 : 5, variant: u.id, rate: boss ? 1 : u.radius > 1.2 ? 0.85 : 1.1 });
      if (l) this.idle.set(u, l);
    }
  }

  /** A passing minion wave tramps along as one column, louder the bigger it is. */
  private marching(): void {
    const groups = new Map<string, { x: number; z: number; n: number }>();
    for (const u of this.game.sim.units) {
      if (u.kind !== 'minion' || !u.alive || hypot(u.vx, u.vz) < 0.5 || this.dist(u) > 30) continue;
      const g = groups.get(u.team) ?? { x: 0, z: 0, n: 0 };
      g.x += u.x;
      g.z += u.z;
      g.n++;
      groups.set(u.team, g);
    }
    for (const [team, l] of this.marches) {
      const g = groups.get(team);
      if (!g || g.n < 3) {
        l.stop(1);
        this.marches.delete(team);
        continue;
      }
      l.setPosition(g.x / g.n, 0.5, g.z / g.n);
      l.setGain(Math.min(0.6, 0.12 * Math.sqrt(g.n)) * this.crowd, 0.3);
    }
    for (const [team, g] of groups) {
      if (g.n < 3 || this.marches.has(team)) continue;
      const l = this.engine.loop('march', { at: { x: g.x / g.n, y: 0.5, z: g.z / g.n }, gain: Math.min(0.6, 0.12 * Math.sqrt(g.n)), ref: 6, rate: team === this.me.team ? 1 : 0.94 });
      if (l) this.marches.set(team, l);
    }
  }

  /** Last seen state of Temple Siege and Temple Clash, so the herald calls each change once. */
  private modeSeen = { wave: 0, phase: '', danger: false, blessed: false, winner: '', round: 0, ring: false, taken: '', spoils: 0, relic: false, gilded: false };

  /** The herald calls the beats of Temple Siege (waves, bosses, the temple in danger) and Temple Clash (the blessing, the result). */
  private watchModes(): void {
    const seen = this.modeSeen;
    const siege = this.game.siege;
    if (siege) {
      if (siege.wave !== seen.wave && siege.phase === 'fight') {
        seen.wave = siege.wave;
        if (siege.wave % 5 === 0) this.herald.say('A great beast marches on the temple!', 'epic', 4);
        else if (siege.champion) this.herald.say('A champion leads the horde! Bring it down!', 'epic', 3);
        else this.herald.say(`Wave ${siege.wave} approaches.`, 'neutral', 2);
      }
      if (siege.phase !== seen.phase) {
        if (siege.phase === 'break' && seen.phase === 'fight') this.herald.say('The wave is broken. Choose a boon.', 'good', 3);
        if (siege.phase === 'fallen') this.herald.say('The temple has fallen.', 'bad', 5);
        seen.phase = siege.phase;
      }
      if (siege.spoils > seen.spoils + 1) this.herald.say('The champion has fallen! Its strength is yours.', 'good', 3);
      seen.spoils = siege.spoils;
      const gilded = siege.gilded !== null;
      if (gilded && !seen.gilded) this.herald.say('A Gilded Thornback! Catch it before it escapes!', 'epic', 2);
      if (!gilded && seen.gilded) {
        const caught = siege.gildedFate === 'caught';
        this.herald.say(caught ? 'The golden beast falls! Another boon awaits.' : 'The Gilded Thornback got away.', caught ? 'good' : 'bad', caught ? 3 : 1);
      }
      seen.gilded = gilded;
      const danger = siege.corruption >= 70;
      if (danger && !seen.danger && siege.phase !== 'fallen') this.herald.say('The temple is falling! Clear the plaza!', 'bad', 4);
      // calm again well below the line, so a hovering bar doesn't repeat the warning
      seen.danger = danger || (seen.danger && siege.corruption > 55);
    }
    const clash = this.game.clash;
    if (clash) {
      const blessed = clash.blessing > 0;
      if (blessed && !seen.blessed && !clash.winner) this.herald.say("The temple's blessing is upon the plaza! Points count double!", 'epic', 3);
      seen.blessed = blessed;
      const up = clash.relic !== null;
      if (up && !seen.relic && !clash.winner) this.herald.say('The Sun Relic has risen! Seize it!', 'epic', 2);
      if (!up && seen.relic && clash.lastClaim && !clash.winner) {
        const ours = clash.lastClaim === this.me.team;
        this.herald.say(ours ? 'Your team claims the Sun Relic!' : 'The enemy has claimed the Sun Relic!', ours ? 'good' : 'bad', 3);
      }
      seen.relic = up;
      if (clash.winner && !seen.winner) {
        seen.winner = clash.winner;
        const won = clash.winner === this.me.team;
        this.herald.say(won ? 'Victory! The temple is yours.' : 'Defeat. The temple is lost.', won ? 'epic' : 'bad', 5);
      }
    }
  }

  /** Temple Duel: the herald calls each round, the closing ring, who took the round, and the end. */
  private watchDuel(): void {
    const d = this.game.duel;
    if (!d) return;
    const seen = this.modeSeen;
    const mine = this.me.team;
    if (d.phase === 'fight' && seen.round !== d.round) {
      seen.round = d.round;
      seen.ring = false;
      const last = d.wins.order === DUEL.rounds - 1 && d.wins.chaos === DUEL.rounds - 1;
      this.herald.say(last ? 'Final round. Fight!' : `Round ${d.round}. Fight!`, 'epic', 3);
      this.engine.play('wave.horn', { gain: 0.7 }, 4);
    }
    if (d.phase === 'fight' && d.ringIn <= 0 && !seen.ring) {
      seen.ring = true;
      this.herald.say('The ring of fire closes in!', 'bad', 2);
    }
    const taken = d.phase === 'pause' ? `${d.round}:${d.lastRound ?? 'draw'}` : '';
    if (taken && taken !== seen.taken) {
      seen.taken = taken;
      this.herald.say(d.lastRound === null ? 'They fall together. Again!' : d.lastRound === mine ? 'You take the round.' : 'The round is lost.', d.lastRound === mine ? 'good' : 'bad', 3);
    }
    if (d.winner && !seen.winner) {
      seen.winner = d.winner;
      const won = d.winner === mine;
      this.herald.say(won ? 'Victory! You are the champion of the temple.' : 'Defeat. Your rival stands victorious.', won ? 'epic' : 'bad', 5);
    }
  }

  /** Last seen Relic Rush state, so each beat is called once. */
  /** Gods whose current call for the pass has been heard. */
  private readonly rushCalls = new Set<Unit>();
  private rushSeen = { phase: '', goals: 0, fumble: 0, steal: 0, catch: 0, shrug: 0, save: 0, juke: 0, dodge: 0, flying: false, overtime: false, minute: false, winner: '', tick: 0 };

  /** Relic Rush: the horn at each kickoff, goals, steals and fumbles, the golden relic and the result. */
  private watchRush(): void {
    const r = this.game.rush;
    if (!r) return;
    const seen = this.rushSeen;
    const mine = this.me.team;
    const relic = r.relic;
    const at = { x: relic.x, z: relic.z };
    let roared = false;
    this.humRelic(r);
    this.crowdBeds();
    if (r.phase !== seen.phase) {
      if (r.phase === 'play' && seen.phase === 'kickoff') {
        this.engine.play('wave.horn', { gain: 0.6 }, 4);
        if (r.overtime && !seen.overtime) this.herald.say('Golden relic! The next goal wins!', 'epic', 4);
        else if (seen.goals === 0 && r.goalCount === 0 && r.clock > 290) this.herald.say('The Sun Relic is in play! Rush!', 'epic', 3);
      }
      seen.phase = r.phase;
    }
    seen.overtime = r.overtime;
    // the kickoff counts down out loud: a bell on 3, 2 and 1, then the horn
    const tick = r.phase === 'kickoff' ? Math.ceil(r.timer) : 0;
    if (tick !== seen.tick && tick >= 1 && tick <= 3) this.engine.play('ui.point', { gain: 0.5, rate: 0.75 + (3 - tick) * 0.06 }, 2);
    seen.tick = tick;
    if (r.goalCount !== seen.goals) {
      seen.goals = r.goalCount;
      const g = r.lastGoal;
      if (g) {
        // the gate's gong: bright for our goal, lower and heavier for theirs
        const gate = RUSH.gates[g.team === 'order' ? 'chaos' : 'order'];
        const ours = g.team === mine;
        this.engine.play('relic.goal', { at: { x: gate.x, z: gate.z }, ref: 40, gain: ours ? 1 : 0.8, rate: ours ? 1 : 0.84 }, 6);
        // and the scorers' end of the crowd is on its feet
        this.crowdRoar(g.team, ours);
        roared = true;
      }
      if (g && !r.winner) {
        const ours = g.team === mine;
        const line = g.scorer === this.me ? (g.kind === 'shot' ? 'What a shot! You score!' : 'You score!') : ours ? (g.kind === 'shot' ? 'A shot from range! Goal!' : 'Goal! Your team scores.') : 'The enemy scores.';
        this.herald.say(line, ours ? 'epic' : 'bad', 4);
        // one goal from the win: said once the goal call is done
        const point = r.matchPoint;
        if (point === 'both') this.herald.say('Four apiece! The next goal wins it!', 'epic', 3);
        else if (point && g.team === point) this.herald.say(point === mine ? 'Match point! One more goal wins it.' : 'Match point for the enemy! Hold them off.', point === mine ? 'good' : 'bad', 3);
      }
    }
    if (r.beats.fumble !== seen.fumble) {
      seen.fumble = r.beats.fumble;
      this.engine.play('relic.fumble', { at, ref: 10 }, 3);
      const b = r.lastBeat;
      if (b?.kind === 'fumble' && b.by === this.me) this.herald.say('You knocked it loose!', 'good', 2);
      else if (b?.kind === 'fumble' && b.unit === this.me) this.herald.say('The relic is knocked from your hands!', 'bad', 2);
    }
    if (r.beats.steal !== seen.steal) {
      seen.steal = r.beats.steal;
      this.engine.play('relic.catch', { at, ref: 10, rate: 0.9 }, 3);
      const b = r.lastBeat;
      // a throw snatched out of the air in front of a gate: the whole crowd gasps
      const home = b ? RUSH.gates[b.unit.team as 'order' | 'chaos'] : null;
      if (seen.flying && home && Math.hypot(relic.x - home.x, relic.z - home.z) < RUSH.keeper.depth + 4) this.engine.play('crowd.ooh', { gain: 0.75, vary: 0.05 }, 3);
      if (b?.kind === 'steal') this.herald.say(b.unit.team === mine ? 'Stolen! The relic is ours.' : 'The enemy has the relic!', b.unit.team === mine ? 'good' : 'bad', 1);
    }
    if (r.beats.save !== seen.save) {
      seen.save = r.beats.save;
      // a shot caught on its way in: the catch, and the whole ground gasps
      this.engine.play('relic.catch', { at, ref: 10, rate: 0.82 }, 3);
      this.engine.play('crowd.ooh', { gain: 0.95, vary: 0.05 }, 4);
      const b = r.lastBeat;
      if (b?.kind === 'save') {
        const ours = b.unit.team === mine;
        const line = b.unit === this.me ? 'What a save!' : ours ? `Saved! ${b.unit.name} keeps it out.` : b.by === this.me ? `Saved! ${b.unit.name} stops your shot.` : `Saved by ${b.unit.name}!`;
        this.herald.say(line, ours ? 'good' : 'bad', 2);
      }
    }
    if (r.beats.juke !== seen.juke) {
      seen.juke = r.beats.juke;
      const j = r.lastJuke;
      if (j) this.engine.play('relic.juke', { at: { x: j.x, z: j.z }, ref: 8, gain: j === this.me ? 0.75 : 1 }, 2);
    }
    if (r.beats.dodge !== seen.dodge) {
      seen.dodge = r.beats.dodge;
      // a tackle juked: the ground gasps, and the herald calls it if you were in it
      this.engine.play('crowd.ooh', { gain: 0.6, vary: 0.06, rate: 1.06 }, 3);
      const b = r.lastBeat;
      if (b?.kind === 'dodge') {
        const line = b.unit === this.me ? (b.by ? `Juked! You slip past ${b.by.name}.` : 'Juked! You slip the tackle.') : b.by === this.me ? `${b.unit.name} jukes your tackle!` : null;
        if (line) this.herald.say(line, b.unit === this.me ? 'good' : 'bad', 2);
      }
    }
    if (r.beats.catch !== seen.catch) {
      seen.catch = r.beats.catch;
      this.engine.play('relic.catch', { at, ref: 10 }, 3);
    }
    // a teammate's call for the pass (and your own, softer, so you know it went out)
    for (const g of r.team(mine as 'order' | 'chaos')) {
      const calling = r.calledAgo(g) !== null;
      if (calling && !this.rushCalls.has(g)) this.engine.play('relic.call', { at: { x: g.x, z: g.z }, ref: 12, gain: g === this.me ? 0.5 : 0.9 }, 3);
      if (calling) this.rushCalls.add(g);
      else this.rushCalls.delete(g);
    }
    if (r.beats.shrug !== seen.shrug) {
      seen.shrug = r.beats.shrug;
      this.engine.play('relic.shrug', { at, ref: 10 }, 3);
      const b = r.lastBeat;
      if (b?.kind === 'shrug' && b.unit === this.me) this.herald.say('Captain! You shrug it off and keep the relic.', 'good', 2);
    }
    const flying = relic.phase === 'flying' && !!relic.thrower;
    if (flying && !seen.flying) this.engine.play('relic.throw', { at, ref: 10 }, 3);
    seen.flying = flying;
    const minute = !r.overtime && r.phase === 'play' && r.clock <= 60;
    if (minute && !seen.minute) this.herald.say('One minute remains!', 'neutral', 2);
    seen.minute = seen.minute || minute;
    if (r.winner && !seen.winner) {
      seen.winner = r.winner;
      const won = r.winner === mine;
      // (unless the winning goal already set the crowd off)
      if (!roared) this.crowdRoar(r.winner as 'order' | 'chaos', won);
      this.herald.say(won ? 'Victory! The Sun Relic is yours.' : 'Defeat. The enemy takes the Sun Relic.', won ? 'epic' : 'bad', 5);
    }
  }

  /** Each end of Relic Rush's crowd: its murmur, and its cheering faded in over it as the play heats up. */
  private readonly crowdEnds = {
    order: { murmur: null as LoopHandle | null, cheer: null as LoopHandle | null, heat: -1 },
    chaos: { murmur: null as LoopHandle | null, cheer: null as LoopHandle | null, heat: -1 },
  };

  /**
   * The crowd is heard from where it sits: a bed behind each gate, swelling
   * with its own end's excitement (a carrier closing in, a goal, the win) and
   * rising in pitch as it gets to its feet, then settling back to chatter.
   */
  private crowdBeds(): void {
    for (const side of ['order', 'chaos'] as const) {
      const end = this.crowdEnds[side];
      const at = { x: 0, y: 3, z: (side === 'order' ? 1 : -1) * (RUSH.pitchRadius + 4) };
      const tone = side === 'order' ? 1 : 0.95;
      if (!end.murmur?.alive) {
        end.murmur = this.engine.loop('amb.crowd', { bus: 'ambience', at, ref: 30, gain: 0, rate: tone });
        end.heat = -1;
      }
      if (!end.cheer?.alive) {
        end.cheer = this.engine.loop('amb.cheer', { bus: 'ambience', at, ref: 30, gain: 0, rate: tone });
        end.heat = -1;
      }
      // steps of 1/40 so the ramps aren't re-aimed every frame
      const heat = Math.round(this.game.crowdHeat(side) * 40) / 40;
      if (heat === end.heat) continue;
      end.heat = heat;
      const up = Math.min(1, Math.max(0, (heat - 0.15) / 0.5));
      end.murmur?.setGain(0.42 * (0.85 + 0.5 * heat) * (1 - 0.45 * up), 0.3);
      end.murmur?.setRate(tone * (1 + 0.05 * heat));
      end.cheer?.setGain(0.5 * up * up * (3 - 2 * up), 0.3);
      end.cheer?.setRate(tone * (1 + 0.04 * heat));
    }
  }

  private relicHum: LoopHandle | null = null;
  private humSet = { gain: -1, rate: -1 };

  /**
   * The Sun Relic sings wherever it is, so you can hear it loose behind you:
   * softer in your own hands, a touch higher while it flies or in overtime,
   * and silent once it's scored or the match is over.
   */
  private humRelic(r: NonNullable<CombatGame['rush']>): void {
    const relic = r.relic;
    if (!this.relicHum?.alive) {
      this.relicHum = this.engine.loop('relic.hum', { at: { x: relic.x, y: 1, z: relic.z }, ref: 7, gain: 0 });
      this.humSet.gain = this.humSet.rate = -1;
      if (!this.relicHum) return;
    }
    const hum = this.relicHum;
    const y = (relic.holder ?? this.me).body.y + relic.h + (relic.holder ? 0 : 0.6);
    hum.setPosition(relic.x, y, relic.z);
    const gone = relic.phase === 'gone' || !!r.winner;
    const gain = gone ? 0 : relic.holder === this.me ? 0.3 : 0.65;
    if (gain !== this.humSet.gain) hum.setGain(gain, gone ? 0.12 : 0.35);
    const rate = relic.phase === 'flying' ? 1.12 : r.overtime ? 1.06 : 1;
    if (rate !== this.humSet.rate) hum.setRate(rate);
    this.humSet.gain = gain;
    this.humSet.rate = rate;
  }

  /** One end of Relic Rush's crowd roaring: from behind the gate its team defends (Order's is at +z). */
  private crowdRoar(team: 'order' | 'chaos', ours: boolean): void {
    const z = (team === 'order' ? 1 : -1) * (RUSH.pitchRadius + 4);
    this.engine.play('crowd.roar', { at: { x: 0, y: 2, z }, ref: 45, gain: ours ? 0.95 : 0.7, vary: 0.04 }, 5);
  }

  private watchMatch(): void {
    const m = this.game.match;
    if (!m) return;
    if (m.wave !== this.lastWave) {
      if (m.wave === 1) this.herald.say('Minions are on the march!', 'neutral', 2);
      this.lastWave = m.wave;
      const base = L.bases.find((b) => b.team === this.me.team)!;
      this.engine.play('wave.horn', { at: { x: base.titan[0], z: base.titan[1] }, gain: m.wave === 1 ? 1 : 0.6, ref: 30 }, 4);
    }
    if (this.conquest && !m.winner) {
      const want = PHASES.indexOf(this.songFor(m));
      if (want > this.phase) {
        this.phase = want;
        this.music.play(PHASES[want]!);
      }
    }
    if (m.winner && !this.ended) {
      this.ended = true;
      const won = m.winner === this.me.team;
      setTimeout(() => {
        this.music.sting(won ? 'victory' : 'defeat');
        this.herald.say(won ? 'Victory! The enemy Titan has fallen.' : 'Defeat. Our Titan has fallen.', won ? 'epic' : 'bad', 9);
      }, 1800);
    }
  }

  /**
   * Which theme the match has reached: the calm dawn until the first blood
   * or the third minute, the battle theme after, and the siege once a Titan
   * stands exposed or the war passes fifteen minutes.
   */
  private songFor(m: NonNullable<CombatGame['match']>): SongName {
    if (m.time > 15 * 60 || Object.values(m.titans).some((t) => t.alive && !t.shielded())) return 'siege';
    if (this.firstBlood || m.time > 180) return 'battle';
    return 'dawn';
  }

  private updateMood(dt: number): void {
    this.heat = Math.max(0, this.heat - dt * 0.18);
    const me = this.me;
    const c = me.combatant;
    const low = me.alive ? 1 - c.health / c.stats.maxHealth : 0;
    if (!this.ended) this.music.setIntensity(Math.min(1, Math.max(this.moodFloor, this.heat + (low > 0.6 ? 0.3 : 0))), dt);
    const pulse = me.alive && low > 0.72;
    if (pulse && !this.heartbeat) this.heartbeat = this.engine.loop('heartbeat', { gain: 0, bus: 'sfx' });
    if (this.heartbeat) {
      if (!pulse) {
        this.heartbeat.stop(0.6);
        this.heartbeat = null;
      } else {
        this.heartbeat.setGain(0.25 + (low - 0.72) * 2, 0.3);
        this.heartbeat.setRate(1 + (low - 0.72) * 1.4);
      }
    }
  }

  /**
   * Start the ambience beds. The bank may still be rendering when audio
   * unlocks, so beds whose sound is not ready yet are retried each second.
   */
  private startAmbience(): void {
    const specs: [string, Parameters<AudioEngine['loop']>[1]][] = [];
    const add = (name: string, o: Parameters<AudioEngine['loop']>[1]) => specs.push([name, o]);
    if (this.game.descent) {
      // the underworld: a cavern's breath and a deep moan of air through the rock, nothing living
      add('amb.cave', { bus: 'ambience', gain: 0.8 });
      add('amb.wind', { bus: 'ambience', gain: 0.22, pan: -0.4, rate: 0.55 });
      add('amb.wind', { bus: 'ambience', gain: 0.18, pan: 0.4, rate: 0.5 });
      this.ambiencePending = specs;
      this.retryAmbience();
      return;
    }
    add('amb.wind', { bus: 'ambience', gain: 0.55, pan: -0.5 });
    add('amb.wind', { bus: 'ambience', gain: 0.45, pan: 0.5, rate: 0.93 });
    add('amb.leaves', { bus: 'ambience', gain: 0.35, pan: 0.2 });
    // (no insects in the Jötunn's winter)
    if (!this.game.jotunn) add('amb.jungle', { bus: 'ambience', gain: this.conquest ? 0.18 : 0.08, pan: -0.2 });
    for (const b of Object.values(this.game.sim.bases)) {
      add('amb.fountain', { bus: 'ambience', at: { x: b.x, y: 1, z: b.z }, gain: 0.8, ref: 7 });
      add('amb.fire', { bus: 'ambience', at: { x: b.x + 6, y: 2, z: b.z }, gain: 0.5, ref: 4 });
      add('amb.fire', { bus: 'ambience', at: { x: b.x - 6, y: 2, z: b.z }, gain: 0.5, ref: 4, rate: 1.1 });
    }
    this.ambiencePending = specs;
    this.retryAmbience();
  }

  private ambiencePending: [string, Parameters<AudioEngine['loop']>[1]][] = [];
  private ambienceRetryIn = 0;

  private retryAmbience(): void {
    this.ambiencePending = this.ambiencePending.filter(([name, o]) => {
      const l = this.engine.loop(name, o);
      if (l) this.ambience.push(l);
      return !l;
    });
  }

  private ambientLife(dt: number): void {
    if (this.ambiencePending.length && (this.ambienceRetryIn -= dt) <= 0) {
      this.ambienceRetryIn = 1;
      this.retryAmbience();
    }
    const l = this.engine.listenerPos;
    if (this.game.descent) {
      this.underworldLife(dt);
      return;
    }
    this.birdIn -= dt;
    if (this.birdIn <= 0) {
      this.birdIn = 2.5 + Math.random() * 7;
      // quieter when the fighting is loud, and gone once it really snows
      if (this.heat < 0.6 && this.game.winter < 0.3) {
        const a = Math.random() * Math.PI * 2;
        const r = 14 + Math.random() * 30;
        this.engine.play('amb.bird', { bus: 'ambience', at: { x: l.x + Math.cos(a) * r, y: 8 + Math.random() * 8, z: l.z + Math.sin(a) * r }, gain: 0.6, vary: 0.12, ref: 10 }, 0);
      }
    }
    this.crowIn -= dt;
    if (this.crowIn <= 0) {
      this.crowIn = 25 + Math.random() * 40;
      const a = Math.random() * Math.PI * 2;
      this.engine.play('amb.crow', { bus: 'ambience', at: { x: l.x + Math.cos(a) * 45, y: 15, z: l.z + Math.sin(a) * 45 }, gain: 0.7, ref: 18 }, 0);
    }
  }

  /** The underworld's life: drips in the dark, a far groan of rock, the moan of souls, and the lava pit's bubbling. */
  private underworldLife(dt: number): void {
    const l = this.engine.listenerPos;
    const around = (r0: number, r1: number, y: number) => {
      const a = Math.random() * Math.PI * 2;
      const r = r0 + Math.random() * (r1 - r0);
      return { x: l.x + Math.cos(a) * r, y, z: l.z + Math.sin(a) * r };
    };
    this.birdIn -= dt;
    if (this.birdIn <= 0) {
      this.birdIn = 2 + Math.random() * 6;
      if (this.heat < 0.7) this.engine.play('amb.drip', { bus: 'ambience', at: around(8, 26, 6 + Math.random() * 6), gain: 0.55, vary: 0.15, ref: 8 }, 0);
    }
    this.crowIn -= dt;
    if (this.crowIn <= 0) {
      this.crowIn = 18 + Math.random() * 30;
      this.engine.play(Math.random() < 0.55 ? 'amb.groan' : 'amb.souls', { bus: 'ambience', at: around(30, 45, 10), gain: 0.65, vary: 0.08, ref: 20 }, 0);
    }
    // the lava pit bubbles where there is one; the loop drifts far off where there isn't
    const run = this.game.descent!;
    const c = run.layout;
    if (!this.lava || !this.lava.alive) this.lava = this.engine.loop('amb.fire', { bus: 'ambience', gain: 0.9, rate: 0.45, at: { x: c.x, y: -1, z: c.z }, ref: 9 });
    if (this.lava) {
      if (c.pit) this.lava.setPosition(c.x, -1, c.z);
      else this.lava.setPosition(c.x, -400, c.z);
    }
  }

  private lava: LoopHandle | null = null;

  /** Last seen Underworld Descent state, so each beat is called once. */
  private descentSeen = { chamber: 0, phase: '', depth: -1, curses: 0, obols: -1, downed: 0, erupting: false, song: 'abyss' as SongName, lead: 0, routed: 0, routs: 0, relics: 0 };

  /** Underworld Descent: each chamber's arrival, the clear, the open gate, curses, revives, the obol and the end. */
  private watchDescent(): void {
    const r = this.game.descent;
    if (!r || !r.chamber) return;
    const seen = this.descentSeen;
    const plan = r.current;
    if (seen.obols < 0) seen.obols = r.obols;
    if (r.phase === 'enter' && seen.chamber !== r.chamber) {
      seen.chamber = r.chamber;
      const depth = DEPTHS[r.depth]!.name;
      if (r.depth !== seen.depth) {
        seen.depth = r.depth;
        this.herald.say(r.chamber === 1 ? (r.versus ? `Welcome to ${depth}. Two teams descend; the underworld pays in souls.` : `Welcome to ${depth}. Descend, and do not look back.`) : `You enter ${depth}.`, 'epic', 3);
        this.engine.play('wave.horn', { gain: 0.5, rate: 0.75 }, 3);
      } else if (plan.kind === 'boss') this.herald.say(r.chamber === DESCENT.chambers ? 'The lord of the underworld awaits. End this.' : `The master of ${depth} awaits.`, 'epic', 4);
      else if (plan.kind === 'trap') this.herald.say('Soul fire burns beneath this chamber. Watch the ground.', 'neutral', 2);
      else if (plan.kind === 'champion') this.herald.say('A champion of the dead stands in your way.', 'neutral', 2);
      else if (plan.kind === 'treasure') this.herald.say('Gold glints in the dark. Catch the thief!', 'neutral', 2);
      else if (plan.kind === 'elite') this.herald.say('Elite guardians bar the way.', 'neutral', 2);
    }
    if (r.phase !== seen.phase) {
      if (r.phase === 'reward' && seen.phase === 'fight') {
        if (plan.kind === 'boss' && r.versus && r.bossBy) this.herald.say(r.bossBy === this.me.team ? 'Your team slew the master! Its souls are yours.' : 'The rivals slew the master.', r.bossBy === this.me.team ? 'epic' : 'bad', 4);
        else if (plan.kind === 'boss') this.herald.say('The master has fallen! The way down is yours.', 'epic', 4);
        else this.herald.say('The chamber is cleared. Choose your reward.', 'good', 3);
      }
      if (r.phase === 'draft' && r.drafts.has(this.me)) this.herald.say('A forgotten rite. Learn a new power.', 'good', 2);
      if (r.phase === 'exit') this.engine.play('god.respawn', { gain: 0.5, rate: 0.7 }, 2);
      // the ground gives way beneath the team as it goes down
      if (r.phase === 'descend') this.engine.play('amb.groan', { gain: 0.9 }, 3);
      if (r.over) this.music.sting(r.phase === 'won' && (!r.versus || r.winner === this.me.team) ? 'victory' : 'defeat');
      if (r.phase === 'won' && r.versus) this.herald.say(r.winner === 'draw' ? 'A dead heat. The underworld keeps you both.' : r.winner === this.me.team ? 'Victory! Your team rules the underworld.' : 'The rivals rule the underworld.', r.winner === this.me.team ? 'epic' : 'bad', 9);
      else if (r.phase === 'won') this.herald.say('You rise again! The underworld could not hold you.', 'epic', 9);
      if (r.phase === 'lost') this.herald.say('Your team is lost in the dark.', 'bad', 9);
      seen.phase = r.phase;
    }
    // the bosses get the darkest theme; the rest of the descent its own
    const song: SongName = r.current.kind === 'boss' && r.phase === 'fight' ? 'siege' : 'abyss';
    if (song !== seen.song && !r.over) {
      seen.song = song;
      this.music.play(song);
    }
    // a relic found: a bell, and the herald names it
    const relics = r.relics.ofSide(r.sideOf(this.me));
    if (relics.length > seen.relics) {
      this.engine.play('relic.found', { bus: 'ui', gain: 0.6 }, 3);
      this.herald.say(`A relic of the underworld: ${relicById(relics[relics.length - 1]!)?.name ?? 'a relic'}.`, 'epic', 3);
    }
    seen.relics = relics.length;
    if (r.curses.length > seen.curses) this.herald.say(`A curse takes hold: ${r.curses[r.curses.length - 1]!.name}.`, 'bad', 2);
    seen.curses = r.curses.length;
    if (r.obols < seen.obols) this.herald.say("Charon's obol is spent. Death lets you go, this once.", 'epic', 5);
    seen.obols = r.obols;
    const down = [...r.downed.keys()].filter((g) => g.team === this.me.team).length;
    if (down < seen.downed && r.phase !== 'lost' && !r.downed.has(this.me)) this.herald.say('Your ally rises!', 'good', 1);
    seen.downed = down;
    if (r.versus) this.watchSouls(r);
    if (r.erupting && !seen.erupting) this.herald.say('Soul fire rises!', 'bad', 1);
    seen.erupting = r.erupting;
  }

  /** A shared descent: the lead changing hands, and routs on either side. */
  private watchSouls(r: Descent): void {
    const seen = this.descentSeen;
    const mine = r.sideOf(this.me);
    const foe = mine === 'order' ? 'chaos' : 'order';
    const gap = Math.floor(r.souls[mine]) - Math.floor(r.souls[foe]);
    const lead = gap > 0 ? 1 : gap < 0 ? -1 : 0;
    if (lead && lead !== seen.lead && !r.over && r.souls[mine] + r.souls[foe] >= 12) this.herald.say(lead > 0 ? 'Your team takes the lead!' : 'The rivals take the lead.', lead > 0 ? 'good' : 'bad', 2);
    if (lead) seen.lead = lead;
    if (r.routs[mine] > seen.routed) this.herald.say('Your team is routed! You rise at the gate.', 'bad', 3);
    if (r.routs[foe] > seen.routs) this.herald.say('The rivals are routed!', 'good', 3);
    seen.routed = r.routs[mine];
    seen.routs = r.routs[foe];
  }

  // -------------------------------------------------------------------------

  /** Last seen Jötunn state, so each beat is called once. */
  private jotunnSeen = { round: 0, phase: '', tick: 0, kneeling: false, claims: 0, fury: false, stand: false, song: 'frost' as SongName, braziers: [] as boolean[], parts: new Map<PartId, boolean>(), flashes: new Set<number>(), done: false };

  /** The Jötunn: the giant's bellow and the round's call, the horn, smashed braziers, the kneel, shrines, regrowth and the result. */
  private watchJotunn(): void {
    const j = this.game.jotunn;
    if (!j || !j.round) return;
    const seen = this.jotunnSeen;
    const g = j.giant;
    const giantMe = this.me === g;
    const who = j.giantPlayer.name;
    if (j.round !== seen.round) {
      seen.round = j.round;
      seen.fury = false;
      seen.stand = false;
      seen.claims = j.claims;
      seen.braziers = j.braziers.map((b) => b.alive);
      for (const [id, p] of j.parts) seen.parts.set(id, p.alive);
      const last = j.round === j.rounds && j.rounds > 1 ? 'Final round. ' : '';
      this.herald.say(giantMe ? `${last}You are the Jötunn. Smash the braziers!` : `${last}${who} is the Jötunn. Guard the braziers!`, 'epic', 4);
      // (it swells into the roar the giant throws back its head for, on camera)
      this.at('jotunn.roar', g, { gain: 1.2, ref: 45, delay: 0.3 }, 6, 0, true);
    }
    if (j.phase !== seen.phase) {
      if (j.phase === 'fight' && seen.phase === 'countdown') this.engine.play('jotunn.horn', { gain: 0.8 }, 5);
      if (j.phase === 'over') {
        const giantWon = j.lastRound === 'giant';
        const won = giantMe === giantWon;
        const line = giantWon ? (giantMe ? 'The braziers are smashed! The round is yours.' : 'The braziers are smashed. The round is lost.') : giantMe ? 'You have fallen. The round is lost.' : 'The Jötunn has fallen! The round is yours.';
        this.herald.say(line, won ? 'good' : 'bad', 5);
        // the giant's win: it roars over the smashed temple
        if (giantWon) this.at('jotunn.roar', g, { gain: 1.2, ref: 45, delay: 0.35 }, 6, 0, true);
      }
      if (j.phase === 'done' && !seen.done) {
        seen.done = true;
        const champs = j.champions;
        const won = champs.some((p) => p.god === this.game.ownGod);
        this.music.sting(won ? 'victory' : 'defeat');
        this.herald.say(won ? (champs.length > 1 ? 'A shared victory! The frost is broken.' : 'Victory! You are the champion of the temple.') : 'Defeat. Another claims the temple.', won ? 'epic' : 'bad', 9);
      }
      seen.phase = j.phase;
    }
    // the countdown out loud: a cold bell on 3, 2 and 1
    const tick = j.phase === 'countdown' ? Math.ceil(j.timer) : 0;
    if (tick !== seen.tick && tick >= 1 && tick <= 3) this.engine.play('ui.point', { gain: 0.5, rate: 0.7 + (3 - tick) * 0.06 }, 2);
    seen.tick = tick;
    // The last stand: one brazier from the giant's win, or its Might nearly
    // spent. The war song quickens to a charge and holds its drums up for the
    // rest of the round; a new round starts on the stride again.
    if (!seen.stand && lastStand(j)) {
      seen.stand = true;
      // (one brazier short has the brazier's own call)
      if (j.braziersLeft > JOTUNN.braziers.length - JOTUNN.braziersToWin + 1) this.herald.say(giantMe ? 'Your Might is failing! Smash the braziers while you stand.' : 'The Jötunn falters! Bring it down!', giantMe ? 'bad' : 'epic', 3);
    }
    if (j.phase === 'fight' || j.phase === 'countdown') {
      const song: SongName = seen.stand ? 'frostStand' : 'frost';
      if (song !== seen.song) {
        seen.song = song;
        this.music.play(song);
      }
    }
    this.moodFloor = seen.stand && j.phase === 'fight' ? 0.75 : 0;
    if (j.phase !== 'fight') return;
    j.braziers.forEach((b, i) => {
      if (seen.braziers[i] && !b.alive) {
        this.engine.play('jotunn.brazier', { at: { x: b.x, y: b.body.y + 1, z: b.z }, gain: 1.2, ref: 30 }, 6);
        const smashed = JOTUNN.braziers.length - j.braziersLeft;
        const need = JOTUNN.braziersToWin - smashed;
        if (need > 0) this.herald.say(giantMe ? `A brazier is smashed! ${need} more.` : `A brazier is smashed! ${need === 1 ? 'Only one more and the temple falls.' : 'Hold the rest!'}`, giantMe ? 'good' : 'bad', 3);
      }
      seen.braziers[i] = b.alive;
    });
    for (const [id, p] of j.parts) {
      const was = seen.parts.get(id);
      // a part that grows back (the kneel's knees come back together, with the stand)
      if (was === false && p.alive && id !== 'crown') this.at('jotunn.regrow', p, { gain: 0.8, ref: 14 }, 2, 0, giantMe);
      if (was && !p.alive && id === 'rune') this.herald.say(giantMe ? 'Your back rune shatters! You are silenced.' : 'The back rune shatters! The giant is silenced.', giantMe ? 'bad' : 'good', 2);
      seen.parts.set(id, p.alive);
    }
    const kneeling = j.kneeling > 0;
    if (kneeling && !seen.kneeling) {
      this.at('jotunn.kneel', g, { gain: 1.3, ref: 40 }, 6, 0, true);
      this.herald.say(giantMe ? 'You are on your knees! Guard your crown.' : `The Jötunn kneels! Strike the crown!`, giantMe ? 'bad' : 'epic', 4);
    }
    seen.kneeling = kneeling;
    if (j.claims > seen.claims) {
      const s = j.shrines.reduce((a, b) => (b.dormant > a.dormant ? b : a));
      this.engine.play('jotunn.claim', { at: { x: s.def.x, z: s.def.z }, gain: 1, ref: 30 }, 5);
      const ult = this.game.player.combatant.god.skills.find((k) => k.id === s.def.ult)?.name ?? 'a new power';
      this.herald.say(giantMe ? `The ${s.def.name} is yours: ${ult}!` : `The Jötunn claims the ${s.def.name}!`, giantMe ? 'good' : 'bad', 3);
    }
    seen.claims = j.claims;
    if (j.fury > 0 && !seen.fury) {
      seen.fury = true;
      this.herald.say(giantMe ? 'Your fury grows. Every blow hits harder.' : "The Jötunn's fury grows!", giantMe ? 'good' : 'bad', 2);
    }
    // the giant rearing back for a blow: a strain and a breath drawn in, so gods hear it coming
    for (const f of this.game.sim.flashes) {
      if (f.owner !== g || !f.warn || seen.flashes.has(f.id)) continue;
      seen.flashes.add(f.id);
      this.at('jotunn.windup', g, { gain: f.act === 'basic' ? 0.55 : 0.95, vary: 0.05, ref: 24 }, 4, 0, true);
    }
    if (seen.flashes.size > 200) seen.flashes.clear();
  }

  /**
   * The giant's winter as a sound: a blizzard's howl that swells with the
   * snow, from a whisper under the breeze in a first flurry to a gale that
   * drowns it when the giant wins, and climbs in pitch as it builds.
   */
  private winterWind(dt: number): void {
    if (!this.game.jotunn) return;
    const a = this.game.winter;
    if (!this.blizzard?.alive) {
      // (the bank may still be baking it: try again each second)
      if (a < 0.01 || (this.blizzardIn -= dt) > 0) return;
      this.blizzardIn = 1;
      this.blizzard = this.engine.loop('jotunn.blizzard', { bus: 'ambience', gain: 0 });
      if (!this.blizzard) return;
    }
    this.blizzard.setGain(0.85 * a ** 1.5, 0.5);
    this.blizzard.setRate(0.92 + 0.16 * a);
  }

  /** Fetch the lines of every god in the match (a few times a second is plenty), and open the match with a word from yours. */
  private followLines(dt: number): void {
    this.linesCheck -= dt;
    if (this.linesCheck <= 0) {
      this.linesCheck = 2;
      this.lines.load(this.game.ownGod.combatant.god.id);
      for (const u of this.game.sim.units) if (u.kind === 'god') this.lines.load(u.combatant.god.id);
    }
    // a moment after the fight opens (or after the first click lets sound play), once
    if (!this.saidStart && this.time > 1.5 && this.me.alive) {
      if (this.speak(this.me, 'start') || this.time > 10) this.saidStart = true;
    }
  }

  /**
   * A god's spoken line (godLines.ts): flat for your own god and for team
   * calls, from the god otherwise (and only near enough to hear). A hidden
   * enemy says nothing. Returns how long until it ends, or 0.
   */
  private speak(u: Unit, kind: LineKind, o: { delay?: number; variant?: number; flat?: boolean; cut?: boolean } = {}): number {
    if (u.kind !== 'god' || (u.stealth > 0 && u.team !== this.me.team)) return 0;
    const own = u === this.me;
    if (!own && !o.flat && this.dist(u) > 32) return 0;
    const at = own || o.flat ? undefined : { x: u.x, y: u.body.y + 1.6, z: u.z };
    const gain = own ? 0.95 : o.flat ? 0.7 : 0.9 * this.crowd;
    return this.lines.say(u, u.combatant.god.id, kind, { own, at, gain, delay: o.delay, variant: o.variant, cut: o.cut });
  }

  private dist(u: Unit): number {
    return hypot(u.x - this.engine.listenerPos.x, u.z - this.engine.listenerPos.z);
  }

  /** A god's own voice (voices.ts): an effort, pain, a battle cry or a death cry. */
  private voice(u: Unit, kind: 'effort' | 'hurt' | 'cry' | 'death', gain: number, priority: number, gap = 0): void {
    if (u.kind !== 'god' && u.kind !== 'dummy') return;
    // a stealthed enemy stays silent
    if (u.stealth > 0 && u.team !== this.me.team) return;
    const name = `voice.${u.combatant.god.id}.${kind}`;
    if (this.engine.has(name)) this.at(name, u, { gain: u === this.me ? gain : gain * 0.85, vary: 0.04, ref: 7, wet: 0.05 }, priority, gap);
  }

  /** A Descent boss calling up its adds (its `n`th call this fight): it roars, a little lower than its entrance, and the herald names what rises. */
  private bossCall(at: { x: number; y: number; z: number }, n: number): void {
    const boss = this.game.descent?.boss;
    if (!boss) return;
    const roar = boss.name === 'Treasure Wyrm' ? 'wyrm.roar' : boss.name === 'Ossuary King' ? 'king.roar' : 'colossus.roar';
    this.engine.play(roar, { at: { x: at.x, y: at.y + 2, z: at.z }, gain: 1.15, rate: 0.88, ref: 30 }, 5);
    const key = (boss.brain as { bossKey?: string | null } | null)?.bossKey;
    const line = key ? BOSS_CALL_LINE[key]?.[Math.min(n, 2) - 1] : undefined;
    if (line) this.herald.say(line, 'epic', 3);
  }

  /**
   * Play a sound at a unit. `own` marks the player's own sounds (made by or
   * aimed at them), which stay at full level when a crowded fight ducks the
   * rest; so do the big moments (priority 5 and up: deaths, collapses, bosses).
   */
  private at(name: string, u: Unit, o: Parameters<AudioEngine['play']>[1] = {}, priority = 1, gap = 0, own = u === this.me): void {
    const gain = (o.gain ?? 1) * (own || priority >= 5 ? 1 : this.crowd);
    this.engine.play(name, { ...o, gain, at: { x: u.x, y: u.body.y + 1.2, z: u.z } }, priority, gap);
  }
}

const tmpDir = new THREE.Vector3();
