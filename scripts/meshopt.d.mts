import type { Document } from '@gltf-transform/core';
import type { Plugin } from 'vite';

export function compressGlb(bytes: Uint8Array): Promise<Uint8Array>;
export function readGlb(bytes: Uint8Array): Promise<Document>;
export function meshoptModels(): Plugin;
