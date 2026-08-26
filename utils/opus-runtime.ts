import { browser } from 'wxt/browser';
import {
  env,
  pipeline,
  InterruptableStoppingCriteria,
  type TranslationPipeline,
} from '@huggingface/transformers';
import type { ModelState, OpusStatus } from './opus-types';

export type { ModelState, OpusStatus };

/**
 * The offline engine: Helsinki-NLP's OPUS-MT Hebrew→English "tc-big" Marian
 * model, run in this browser through ONNX Runtime. Nothing leaves the machine.
 *
 * This module needs a DOM (WebGPU and the WASM backend are not available in an
 * MV3 service worker), so it is loaded by the offscreen document — see
 * `utils/opus.ts` for the background-side proxy.
 */

// Where the weights come from.
//
// They are not bundled: at ~365 MB the model alone would blow Firefox's 200 MB
// add-on limit and make every extension update a full re-download. So the
// files are hosted, fetched once on demand, and kept in the browser's cache.
//
const HF_REPO = 'wlwatkins/opus-mt-tc-big-he-en';

// Unused while SOURCE is 'huggingface'; kept because a GitHub release is the
// fallback if the Hugging Face repo ever goes away, and the flat-namespace
// handling it needs is not obvious to reconstruct.
const GITHUB_RELEASE_BASE = 'https://github.com/wlwatkins/Rosetta/releases/download/';
const GITHUB_RELEASE_TAG = 'model-he-en-v1';

// dtype is q8 and forceCpu is true for the tc-big sources, and neither is a
// performance knob:
//
//  * int8 is the only usable precision. The published q4 export of this pair is
//    an invalid graph (int4 tensors into MatMulInteger, which is defined for
//    int8/uint8 — ONNX Runtime refuses it at session creation), fp16 fails at
//    run time because transformers.js feeds it fp32 inputs, and fp32 is 1.2 GB.
//    No working int8 export is published, hence scripts/convert-opus-int8.py.
//  * int8 must run on the CPU backend. ONNX Runtime's WebGPU (JSEP) backend
//    dequantises int8 weights incorrectly, so the same model on the GPU returns
//    fluent-looking multilingual nonsense instead of a translation:
//    https://github.com/huggingface/transformers.js/issues/1512
const SOURCES = {
  // GitHub release assets. Releases take files up to 2 GB — unlike the repo
  // itself, which rejects anything over 100 MB — but they are a flat namespace
  // with no directories, so subfolder is '' and transformers.js asks for bare
  // filenames like "encoder_model_quantized.onnx".
  //
  // Selecting this also needs 'https://github.com/*' and
  // 'https://objects.githubusercontent.com/*' in host_permissions.
  github: {
    id: GITHUB_RELEASE_TAG,
    host: GITHUB_RELEASE_BASE,
    pathTemplate: '{model}/',
    subfolder: '',
    dtype: 'q8',
    forceCpu: true,
    approxMb: 365,
  },
  // The same files as a Hugging Face model repo. This is transformers.js's
  // native layout, so there is nothing to configure and no flattening.
  huggingface: {
    id: HF_REPO,
    host: 'https://huggingface.co/',
    pathTemplate: '{model}/resolve/{revision}/',
    subfolder: 'onnx',
    dtype: 'q8',
    forceCpu: true,
    approxMb: 365,
  },
  // Fallback that needs nothing published: Xenova's export of opus-mt-mul-en,
  // many languages into English. Two thirds smaller, and a general multilingual
  // model rather than a Hebrew specialist, so the English is visibly rougher.
  'mul-en': {
    id: 'Xenova/opus-mt-mul-en',
    host: 'https://huggingface.co/',
    pathTemplate: '{model}/resolve/{revision}/',
    subfolder: 'onnx',
    dtype: 'q8',
    forceCpu: true,
    approxMb: 112,
  },
} as const;

const SOURCE: keyof typeof SOURCES = 'huggingface';

function source() {
  return SOURCES[SOURCE];
}

// Marian was trained on single sentences and degrades badly on paragraphs, so
// anything longer than this is segmented before generation and rejoined after.
const SPLIT_OVER_CHARS = 220;

// How many sequences go through the model at once. Padding is to the longest
// member of the batch, so bigger is not better.
const SUB_BATCH = 8;

let translator: TranslationPipeline | null = null;
let loading: Promise<TranslationPipeline> | null = null;
let state: ModelState = 'idle';
let progress = 0;
let device: 'webgpu' | 'wasm' | null = null;
let error: string | null = null;
let stopping: InterruptableStoppingCriteria | null = null;
let cancelled = false;

export function status(): OpusStatus {
  return {
    state,
    progress,
    device,
    error,
    modelId: source().id,
    approxMb: source().approxMb,
  };
}

function configureEnv() {
  // Nothing model-shaped ships in the package, so don't look for it; the
  // weights come from `source()` and live in the browser's cache afterwards.
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = source().host;
  env.remotePathTemplate = source().pathTemplate;

  // Optional in the types because the WASM backend isn't present in every
  // build of onnxruntime; in a browser it always is.
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    // MV3 forbids running remote code, so the ONNX Runtime WASM binaries have
    // to be served from inside the extension rather than from a CDN. They are
    // copied into public/wasm by scripts/copy-ort-wasm.mjs at build time, and
    // the URL is built from the extension root because WXT types getURL()
    // against the files it already knows about.
    wasm.wasmPaths = new URL('wasm/', browser.runtime.getURL('/')).href;
    // Threads need SharedArrayBuffer, which needs cross-origin isolation. An
    // offscreen document isn't isolated by default, and asking for threads we
    // can't have makes the backend fail to start rather than fall back.
    const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
    wasm.numThreads = isolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  }
}

async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  // int8 weights are only safe on the CPU backend — see the note on SOURCES.
  if (source().forceCpu) return 'wasm';
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) return 'webgpu';
  } catch {
    // no WebGPU — CPU it is
  }
  return 'wasm';
}

/**
 * Download (first time) and initialise the model. Safe to call repeatedly: the
 * in-flight promise is shared, and a finished load returns immediately.
 */
export function load(onProgress?: (status: OpusStatus) => void): Promise<TranslationPipeline> {
  if (translator) return Promise.resolve(translator);
  if (loading) return loading;

  state = 'loading';
  progress = 0;
  error = null;

  loading = (async () => {
    configureEnv();
    device = await pickDevice();

    // progress_callback reports per file; the user cares about the total.
    const bytes = new Map<string, { loaded: number; total: number }>();
    const report = (file: string, loaded: number, total: number) => {
      bytes.set(file, { loaded, total });
      let done = 0;
      let all = 0;
      for (const b of bytes.values()) {
        done += b.loaded;
        all += b.total;
      }
      progress = all > 0 ? Math.min(99, Math.round((done / all) * 100)) : 0;
      onProgress?.(status());
    };

    try {
      // pipeline() is overloaded across every task, and resolving the
      // translation branch produces a union TypeScript declines to represent.
      // The task and the result type are both fixed here, so go around it.
      const createPipeline = pipeline as (
        task: string,
        model: string,
        options: Record<string, unknown>,
      ) => Promise<TranslationPipeline>;

      const pipe = await createPipeline('translation', source().id, {
        dtype: source().dtype,
        device,
        // '' for a flat host (GitHub releases have no directories); 'onnx' for
        // a hub-style repo. Controls where the model files are looked up.
        subfolder: source().subfolder,
        progress_callback: (p: any) => {
          if (p?.status === 'progress' && p.file) report(p.file, p.loaded ?? 0, p.total ?? 0);
        },
      });

      translator = pipe;
      state = 'ready';
      progress = 100;
      onProgress?.(status());
      return pipe;
    } catch (err) {
      state = 'error';
      error = err instanceof Error ? err.message : String(err);
      onProgress?.(status());
      throw err;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

/** Split a long string into sentences so Marian sees what it was trained on. */
function toSentences(text: string): string[] {
  if (text.length <= SPLIT_OVER_CHARS) return [text];
  try {
    const segmenter = new Intl.Segmenter('he', { granularity: 'sentence' });
    const parts = [...segmenter.segment(text)].map((s) => s.segment.trim()).filter(Boolean);
    return parts.length > 0 ? parts : [text];
  } catch {
    return [text];
  }
}

// Hebrew runs around two to three characters per SentencePiece token. The cap
// bounds how long one string can hold up its batch; it is the only guard here,
// deliberately (see the note on the generation options below).
function tokenBudget(texts: string[]): number {
  const longest = texts.reduce((n, t) => Math.max(n, t.length), 0);
  return Math.max(32, Math.min(512, Math.ceil(longest / 2) + 16));
}

export function cancel(): void {
  cancelled = true;
  stopping?.interrupt();
}

/**
 * Translate a batch of Hebrew strings. Order matches the input; a string the
 * model returns nothing for comes back unchanged, which the cache treats as a
 * failure and declines to store.
 */
export async function translate(texts: string[]): Promise<string[]> {
  const pipe = await load();
  cancelled = false;

  // Flatten to sentences, remembering which source string each belongs to.
  const pieces: string[] = [];
  const owner: number[] = [];
  texts.forEach((text, i) => {
    for (const sentence of toSentences(text)) {
      pieces.push(sentence);
      owner.push(i);
    }
  });

  const out: string[] = new Array(pieces.length).fill('');
  for (let i = 0; i < pieces.length; i += SUB_BATCH) {
    if (cancelled) throw new Error('Cancelled');
    const chunk = pieces.slice(i, i + SUB_BATCH);
    stopping = new InterruptableStoppingCriteria();
    // No no_repeat_ngram_size, and no repetition_penalty. Both look like
    // sensible anti-degeneracy guards and both corrupt the output here:
    //
    // In a batch, a short string finishes early and then keeps stepping while
    // the longest member runs to completion, re-emitting EOS each step.
    // no_repeat_ngram_size forbids repeating that EOS n-gram, so the model is
    // forced to emit real tokens instead — "Tourism" comes back as
    // "Tourism....!?:-)s,];". repetition_penalty suppresses EOS the same way.
    // Verified against this exact model: with both removed, every string
    // decodes cleanly; with either present, short strings grow tails.
    //
    // GenerationConfig doesn't declare stopping_criteria even though generate()
    // honours it, so the whole options object goes through untyped.
    const options = {
      max_new_tokens: tokenBudget(chunk),
      num_beams: 1,
      do_sample: false,
      stopping_criteria: stopping,
    } as any;
    const result: any = await pipe(chunk, options);
    stopping = null;
    if (cancelled) throw new Error('Cancelled');

    const rows = Array.isArray(result) ? result : [result];
    rows.forEach((row: any, j: number) => {
      out[i + j] = (row?.translation_text ?? '').trim();
    });
  }

  // Reassemble: sentences of one source string join back into one string.
  const joined: string[] = texts.map(() => '');
  out.forEach((piece, i) => {
    const idx = owner[i]!;
    joined[idx] = joined[idx] ? `${joined[idx]} ${piece}` : piece;
  });
  // An empty result means "no translation" — hand back the original so the
  // page keeps its text and the cache doesn't store a blank.
  return joined.map((t, i) => t || texts[i]!);
}

/** Free the memory and delete the downloaded weights from the browser cache. */
export async function remove(): Promise<void> {
  translator = null;
  loading = null;
  state = 'idle';
  progress = 0;
  device = null;
  error = null;
  try {
    await caches.delete('transformers-cache');
  } catch {
    // nothing cached, or storage unavailable
  }
}
