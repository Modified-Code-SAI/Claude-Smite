import { exitSpot } from '../map/UnderworldLayout';
import { DESCENT, DEPTHS, type Descent } from '../sim/Descent';
import type { World } from '../scene/World';
import { DEPTH_COLORS, gateOpen } from '../scene/underworld/palettes';
import type { UnderworldMap } from '../scene/underworld/UnderworldMap';
import { GroundDecal } from './GroundDecal';
import type { GodPalette } from './palette';
import type { CombatVfx } from './Vfx';

const ERUPTIONS = 10;

/**
 * What Underworld Descent shows in the world: the chamber the team is in (and
 * the depth's colors), the exit gate's veil opening once a chamber is cleared,
 * a glowing ring on the gate's threshold, the soul fire's warning circles and
 * bursts, and a ring under every downed god that fills as an ally raises them.
 * Every ring is a pooled ground decal sharing one material.
 */
export class DescentView {
  private readonly map: UnderworldMap | null;
  private readonly eruptions: GroundDecal[] = [];
  private readonly revives: GroundDecal[] = [];
  private readonly door: GroundDecal;
  private shownLayout = -1;
  private shownDepth = -1;
  private open = 0;
  private burst: GodPalette = { cloth: 0, trim: 0, glow: 0, vfx: 0xff5a14, core: 0xffd08a };

  constructor(
    private readonly run: Descent,
    private readonly world: World,
    private readonly vfx: CombatVfx,
    groundAt: (x: number, z: number) => number,
  ) {
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
      for (const d of this.eruptions) d.setColors(c.glow, c.fire.high);
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
      this.door.place({ type: 'ring', radius: DESCENT.exitRadius, width: 0.5 }, door.x, door.z, 0, 0.1);
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
    for (const e of r.landed.splice(0)) this.vfx.burst(this.burst, e.x, 0.4, e.z, 1.3);

    // a ring under each downed god that fills as it is raised
    let k = 0;
    for (const [g, p] of r.downed) {
      const d = this.revives[k++];
      if (!d) break;
      d.mesh.visible = true;
      d.values.fill = p;
      d.values.opacity = 0.55 + Math.sin(time * 5) * 0.15 + p * 0.3;
      d.place({ type: 'circle', radius: DESCENT.revive.range }, g.x, g.z, 0, 0.08);
    }
    for (; k < this.revives.length; k++) this.revives[k]!.mesh.visible = false;
  }

  /** Shows every decal for the loading frames that prepare shaders; returns the undo. */
  prime(): () => void {
    const all = [...this.eruptions, ...this.revives, this.door];
    for (const d of all) d.mesh.visible = true;
    return () => {
      for (const d of all) d.mesh.visible = false;
    };
  }
}
