import { describe, expect, it } from 'vitest';
import { loki, thor, zeus } from '../game/gods';
import { jotunn } from '../game/gods/jotunn';
import { dummyUnit, godUnit } from '../sim/factory';
import { Sim } from '../sim/Sim';
import type { SimEvent } from '../sim/Unit';
import { DamageLog, killerHtml, RECAP_WINDOW, recapHtml } from './deathRecap';

const at = { x: 0, z: 0, yaw: 0 };

describe('death recap', () => {
  it('sums each source, hardest first, and marks the killing blow', () => {
    const t = godUnit(thor, 'chaos', at);
    const l = godUnit(loki, 'chaos', at);
    const log = new DamageLog();
    const blade = loki.skills[0]!;
    log.record(t, undefined, false, 120);
    log.time += 1;
    log.record(t, undefined, false, 130);
    log.record(t, thor.skills[0]!.id, true, 300);
    log.time += 2;
    log.record(l, blade.id, true, 200);
    const r = log.recap();
    expect(r.rows.map((x) => [x.label, x.who, Math.round(x.amount), x.hits])).toEqual([
      [thor.skills[0]!.name, 'Thor', 300, 1],
      ['Basic attack', 'Thor', 250, 2],
      [blade.name, 'Loki', 200, 1],
    ]);
    expect(r.rows.map((x) => x.killing)).toEqual([false, false, true]);
    expect(r.total).toBe(750);
    expect(r.span).toBe(3);
  });

  it('counts only the last few seconds, and keeps the killing blow when it is the smallest', () => {
    const z = godUnit(zeus, 'chaos', at);
    const log = new DamageLog();
    log.record(z, zeus.skills[1]!.id, true, 999);
    log.time += RECAP_WINDOW + 1;
    for (const [i, s] of zeus.skills.entries()) log.record(z, s.id, true, 500 - i * 10);
    log.record(z, undefined, true, 5);
    const r = log.recap(null, 3);
    expect(r.rows).toHaveLength(3);
    expect(r.rows.at(-1)!.label).toBe(zeus.passive.name);
    expect(r.rows.at(-1)!.killing).toBe(true);
    // one hitter: the line under "Slain" names it, so the rows leave it out
    expect(r.rows.map((x) => x.who)).toEqual(['', '', '']);
    expect(r.total).toBe(zeus.skills.reduce((sum, _s, i) => sum + 500 - i * 10, 5));
    log.clear();
    expect(log.recap().rows).toEqual([]);
    expect(recapHtml(log.recap())).toBe('');
  });

  it('counts monsters of one kind as one hitter', () => {
    // two of a kind (training dummies stand in for a mode's monsters)
    const a = dummyUnit(thor, 'chaos', at);
    const b = dummyUnit(thor, 'chaos', at);
    const log = new DamageLog();
    log.record(a, undefined, false, 100);
    log.record(b, undefined, false, 150);
    const r = log.recap();
    expect(r.rows.map((x) => [x.label, x.who, x.amount, x.hits, x.kind])).toEqual([['Training Dummy', '', 250, 2, 'monster']]);
  });

  it('names the giant the way the mode asks, its basic a club swing, and the ground as hazards', () => {
    const giant = godUnit(jotunn, 'chaos', at);
    const log = new DamageLog();
    log.record(null, undefined, true, 50);
    log.record(giant, undefined, false, 400);
    log.record(giant, 'jotunn.slam', true, 900);
    const name = (u: unknown) => (u === giant ? 'the Jötunn (<Thor>)' : null);
    const r = log.recap(name);
    expect(r.rows.map((x) => [x.label, x.who])).toEqual([
      ['Glacial Slam', 'the Jötunn (<Thor>)'],
      ['Club swing', 'the Jötunn (<Thor>)'],
      ['Hazards', ''],
    ]);
    const html = recapHtml(r);
    expect(html).toContain('Killing blow');
    expect(html).toContain('&#60;Thor&#62;');
    expect(html).not.toContain('<Thor>');
    expect(killerHtml(giant, name)).toBe('by <b>the Jötunn (&#60;Thor&#62;)</b>');
    expect(killerHtml(null, name)).toBe('');
  });

  it('a skill that lands tells which skill it was; a basic attack does not', () => {
    const sim = new Sim({ groundAt: () => 0, resolve: (x, z) => ({ x, z }) }, { order: { x: 0, z: 200, radius: 10 }, chaos: { x: 0, z: -200, radius: 10 } }, () => 0.5);
    const a = sim.add(godUnit(thor, 'order', at));
    const b = sim.add(godUnit(loki, 'chaos', { x: 1, z: 0, yaw: 0 }));
    const seen: SimEvent[] = [];
    sim.listeners.push((e) => seen.push(e));
    const cast = a.combatant.resolve(0);
    sim.hit(a, cast, b);
    const hit = seen.find((e) => e.type === 'damage');
    expect(hit && hit.type === 'damage' && hit.skill).toBe(cast.skill.id);
  });
});
