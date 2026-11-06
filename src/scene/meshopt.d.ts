// three ships meshoptimizer's simplifier without types; the part scene/lod.ts uses.
declare module 'three/addons/libs/meshopt_simplifier.module.js' {
  type Flag = 'LockBorder' | 'Sparse' | 'ErrorAbsolute' | 'Prune' | 'Regularize' | 'Permissive' | 'RegularizeLight';
  export const MeshoptSimplifier: {
    ready: Promise<void>;
    supported: boolean;
    /** Returns [indices, error]. */
    simplify(indices: Uint32Array, positions: Float32Array, stride: number, targetIndexCount: number, targetError: number, flags?: Flag[]): [Uint32Array, number];
    simplifyWithAttributes(
      indices: Uint32Array, positions: Float32Array, positionStride: number,
      attributes: Float32Array, attributeStride: number, attributeWeights: number[],
      vertexLock: Uint8Array | null, targetIndexCount: number, targetError: number, flags?: Flag[],
    ): [Uint32Array, number];
  };
}
