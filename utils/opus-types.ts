/**
 * Shared shape of the offline engine's status.
 *
 * This lives apart from `opus-runtime.ts` on purpose. Importing even a *type*
 * from that module makes the bundler keep its side-effectful
 * `@huggingface/transformers` import, which drags the whole library — and the
 * inlined WASM runtime — into the background service worker: a 58 MB worker
 * that never runs a model. Nothing here imports anything, so nothing follows
 * it into a bundle.
 */

export type ModelState = 'idle' | 'loading' | 'ready' | 'error';

export interface OpusStatus {
  state: ModelState;
  /** 0-100 while downloading and initialising. */
  progress: number;
  device: 'webgpu' | 'wasm' | null;
  error: string | null;
  modelId: string;
  /** Rough download size, for the popup to warn with before it starts. */
  approxMb: number;
}
