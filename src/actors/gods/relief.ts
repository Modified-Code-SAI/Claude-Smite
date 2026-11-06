import { abs, cross, dFdx, dFdy, dot, faceDirection, float, length, normalView, positionView, sign, smoothstep } from '../../render/tsl';

/**
 * Fine surface relief for the gods: each part gives a height in meters (pores,
 * weave, hammered metal, engraving, scales, strands of hair) and this turns it
 * into a bumped normal from screen-space derivatives (Mikkelsen, "Bump Mapping
 * Unparametrized Surfaces on the GPU"). Unlike three's bumpMap it keeps the
 * real pixel footprint, so a bump is as deep at 10 m as at 1 m, and every
 * height comes from procedural fields, so no textures are needed.
 */
export function reliefNormal(height: any): any {
  const { det, grad } = surfaceGradient(height);
  return abs(det).mul(normalView).sub(grad).normalize();
}

/**
 * The direction a value rises along the surface, in view space, scaled by
 * |det| (the pixel's footprint area): for hair, its root-to-tip value gives the
 * way each lock runs, without storing a tangent per vertex.
 */
export function surfaceGradient(value: any): { det: any; grad: any } {
  const dpdx = dFdx(positionView);
  const dpdy = dFdy(positionView);
  const n = normalView;
  const r1 = cross(dpdy, n);
  const r2 = cross(n, dpdx);
  const det = dot(dpdx, r1).mul(faceDirection);
  const h = float(value);
  return { det, grad: sign(det).mul(dFdx(h).mul(r1).add(dFdy(h).mul(r2))) };
}

/** A pixel's footprint on the surface, in meters. */
const footprint = (): any => length(dFdx(positionView)).add(length(dFdy(positionView)));

/**
 * How much of a relief with features `size` meters across a pixel can show:
 * 1 up close, 0 once a pixel spans the feature, so fine detail fades out with
 * distance instead of sparkling.
 */
export function reliefFade(size: number): any {
  return float(1).sub(smoothstep(size * 0.15, size * 0.6, footprint()));
}
