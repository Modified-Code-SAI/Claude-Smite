/**
 * Compresses the shipped god models (dist/models/**.glb) with meshoptimizer
 * (EXT_meshopt_compression) when the game is built, about halving what a
 * player downloads. The vertex data is kept exactly as it is (no quantizing,
 * no lossy filters), so the models in public/ stay the plain build output of
 * tools/gods/build.py and the game decodes byte-identical geometry.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

async function io() {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
}

/** One GLB, compressed losslessly. */
export async function compressGlb(bytes) {
  const glb = await io();
  const doc = await glb.readBinary(bytes);
  if (doc.getRoot().listExtensionsUsed().some((e) => e.extensionName === EXTMeshoptCompression.EXTENSION_NAME)) return bytes;
  // QUANTIZE with no quantize() step only packs the existing data; FILTER would round it
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  return glb.writeBinary(doc);
}

/** Reads a GLB, compressed or not, for tests. */
export async function readGlb(bytes) {
  return (await io()).readBinary(bytes);
}

function glbs(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? glbs(p) : f.endsWith('.glb') ? [p] : [];
  });
}

/** Vite plugin: compresses every GLB in the build output. */
export function meshoptModels() {
  let outDir = 'dist';
  return {
    name: 'meshopt-models',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    async closeBundle() {
      let before = 0;
      let after = 0;
      for (const p of glbs(join(outDir, 'models'))) {
        const raw = readFileSync(p);
        const out = await compressGlb(new Uint8Array(raw));
        writeFileSync(p, out);
        before += raw.length;
        after += out.length;
      }
      if (before) console.log(`meshopt: models ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`);
    },
  };
}
