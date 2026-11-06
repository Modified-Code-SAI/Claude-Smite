import * as THREE from 'three/webgpu';

/** A world point as the screen shows it: on the spot, or pinned to the screen's edge (with the way to it) when out of view. */
export interface ScreenSpot {
  /** Screen pixels. */
  x: number;
  y: number;
  edge: boolean;
  /** Where the edge arrow points, radians (0 = right, clockwise). */
  angle: number;
}

/** Where markers out of view are pinned: how far out from the middle (screen halves) sideways, up and down. */
const EDGE_X = 0.92;
const EDGE_TOP = 0.8;
/** (the lower edge stays clear of the skill bar) */
const EDGE_BOTTOM = 0.55;

const v = new THREE.Vector3();
const fwd = new THREE.Vector3();

/**
 * Screen pixels for a world point, pinned to the screen's edge when out of
 * view: above or below the view along its line, and to the left or right
 * side when it is behind the camera.
 */
export function toScreen(at: THREE.Vector3, cam: THREE.Camera, w: number, h: number, out: ScreenSpot = { x: 0, y: 0, edge: false, angle: 0 }): ScreenSpot {
  cam.getWorldDirection(fwd);
  const behind = fwd.dot(v.copy(at).sub(cam.position)) < 0;
  const p = v.copy(at).project(cam);
  let ex: number;
  let ey: number;
  if (behind) {
    // the projection mirrors through the camera: flip it back to find the side
    ex = -p.x >= 0 ? EDGE_X : -EDGE_X;
    ey = Math.max(-0.35, Math.min(0.35, -p.y * 0.5));
  } else {
    if (Math.abs(p.x) < 0.92 && p.y < 0.86 && p.y > -0.9) {
      out.x = ((p.x + 1) / 2) * w;
      out.y = ((1 - p.y) / 2) * h;
      out.edge = false;
      out.angle = 0;
      return out;
    }
    // shrink toward the middle until it sits inside the edge box
    const k = Math.min(Math.abs(p.x) > EDGE_X ? EDGE_X / Math.abs(p.x) : 1, p.y > EDGE_TOP ? EDGE_TOP / p.y : p.y < -EDGE_BOTTOM ? EDGE_BOTTOM / -p.y : 1);
    ex = p.x * k;
    ey = p.y * k;
  }
  out.x = ((ex + 1) / 2) * w;
  out.y = ((1 - ey) / 2) * h;
  out.edge = true;
  out.angle = Math.atan2(out.y - h / 2, out.x - w / 2);
  return out;
}
