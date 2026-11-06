/**
 * Exports the parts of a Tower's upper keep and a Phoenix's bird, one mesh at
 * a time and labeled by material, for tools/collapse/bake.py to fracture.
 * Open /tools/collapse/dump.html on the Vite dev server; the result is left
 * in `window.__dump` (tools/collapse/README.md has the commands).
 */
import * as THREE from 'three/webgpu';
import { MaterialLibrary, TextureLibrary } from '../../src/scene/Materials';
import { mergeSwitch } from '../../src/scene/merge';
import { agedMarble, crackedStone, TEAM_STYLE, TeamMaterials } from '../../src/scene/structures/common';
import { PhoenixModel } from '../../src/scene/structures/PhoenixModel';
import { limestone, TowerModel } from '../../src/scene/structures/TowerModel';

interface Part {
  name: string;
  mat: string;
  pos: number[];
  nrm: number[];
  uv: number[] | null;
  idx: number[] | null;
}

async function main(): Promise<void> {
  const textures = new TextureLibrary(1);
  await textures.load();
  const lib = new MaterialLibrary(textures);
  const style = TEAM_STYLE.order;
  const tm = new TeamMaterials(lib, style);
  const labels = new Map<THREE.Material, string>([
    [lib.gold, 'gold'],
    [lib.bronze, 'bronze'],
    [lib.marble, 'marble'],
    [lib.sandstone, 'sandstone'],
    [agedMarble(lib), 'agedMarble'],
    [crackedStone(limestone(lib), style.glow), 'towerStone'],
    [crackedStone(agedMarble(lib), style.glow), 'phoenixStone'],
    [tm.trim, 'trim'],
    [tm.banner, 'banner'],
    [tm.crystal, 'crystal'],
    [tm.runes, 'runes'],
  ]);
  mergeSwitch.on = false;
  const tower = new TowerModel(lib, 'order', tm, 1);
  const phoenix = new PhoenixModel(lib, 'order', tm);
  mergeSwitch.on = true;
  const out = {
    tower: parts((tower as any).upper as THREE.Object3D, tower.root, labels, 'stone'),
    phoenix: parts((phoenix as any).bird as THREE.Object3D, phoenix.root, labels, 'bird'),
  };
  (window as any).__dump = JSON.stringify(out);
  document.getElementById('log')!.textContent = `tower ${out.tower.length} parts, phoenix ${out.phoenix.length} parts`;
}

function parts(group: THREE.Object3D, root: THREE.Object3D, labels: Map<THREE.Material, string>, other: string): Part[] {
  root.updateMatrixWorld(true);
  const list: Part[] = [];
  const nm = new THREE.Matrix3();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.name === 'shield') return;
    const g = m.geometry;
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    const t = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    nm.getNormalMatrix(m.matrixWorld);
    const v = new THREE.Vector3();
    const pos: number[] = [];
    const nrm: number[] = [];
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
      pos.push(+v.x.toFixed(5), +v.y.toFixed(5), +v.z.toFixed(5));
      v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      nrm.push(+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4));
    }
    const mat = labels.get(m.material as THREE.Material) ?? other;
    list.push({
      name: m.name || `${mat}-${list.length}`,
      mat,
      pos,
      nrm,
      uv: t ? Array.from(t.array as Float32Array, (x) => +x.toFixed(4)) : null,
      idx: g.index ? Array.from(g.index.array as ArrayLike<number>) : null,
    });
  });
  return list;
}

void main();
