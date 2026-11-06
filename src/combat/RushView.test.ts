import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { Rush } from '../sim/Rush';
import type { Unit } from '../sim/Unit';
import { HELD, RushView } from './RushView';

const flat = () => 0;

/** Just the parts of a Rush match the relic's view reads, the relic loose at (3, 1, 0). */
function match(): Rush {
  return {
    relic: { phase: 'loose', holder: null, thrower: null, x: 3, z: 0, h: 1, tx: 0, tz: 0 },
    beats: { fumble: 0, steal: 0, catch: 0, kickoff: 0, shrug: 0, juke: 0 },
    lastBeat: null,
    lastGoal: null,
    lastJuke: null,
    overtime: false,
    winner: null,
    phase: 'play',
    team: () => [],
  } as unknown as Rush;
}

describe('the relic in play', () => {
  it("sits in its carrier's off hand: it glides in on a catch, then stays right in the hand as they run", () => {
    const view = new RushView(flat, new THREE.MeshBasicMaterial(), 'order');
    const me = { team: 'order' } as Unit;
    const carrier = { team: 'chaos', alive: true } as unknown as Unit;
    const rush = match();
    const hand = new THREE.Vector3(0, 2.8, 0);
    const handOf = (_u: Unit, out: THREE.Vector3) => out.copy(hand);
    const headOf = (_u: Unit, out: THREE.Vector3) => out.set(hand.x, 3.4, hand.z);
    const frame = () => view.frame(rush, me, headOf, 1 / 60, 0, handOf);
    frame();
    expect(view.relicAt!.x).toBeCloseTo(3, 6);
    // caught: it doesn't jump the three meters into the hand
    rush.relic.phase = 'held';
    rush.relic.holder = carrier;
    frame();
    expect(view.relicAt!.x).toBeGreaterThan(1.5);
    // the carrier sprints off: once it's in the hand it keeps up exactly, no trailing behind
    for (let i = 0; i < 40; i++) {
      hand.x += 7 / 60;
      frame();
    }
    expect(view.relicAt!.distanceTo(hand.clone().setY(hand.y + HELD.lift))).toBeLessThan(0.01);
    // and with no hand to hold it (a model not on show), up over the head as before
    const none = () => null;
    view.frame(rush, me, headOf, 1, 0, none);
    expect(view.relicAt!.y).toBeCloseTo(3.4 + 0.55, 1);
  });
});
